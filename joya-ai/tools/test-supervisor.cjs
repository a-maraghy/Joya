/**
 * The supervisor end to end, against a fake claude (tools/fake-claude.cjs).
 *
 *     sudo node joya-ai/tools/test-supervisor.cjs
 *
 * Runs a real supervisor.js in a scratch directory -- its own config, state,
 * socket and Claude home -- so nothing of the live service is touched and no
 * model is called. Checks the socket protocol over a real socket, a turn from
 * send to result, the approval flow (deny, approve, timeout, double answer),
 * the ledger's delegation states, the audit trail, restart-then-resume, the
 * single-instance lock, and the refusal to start while another process holds
 * the session id.
 *
 * Needs root: the supervisor refuses to run as anyone else.
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-test-"));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
const fake = path.join(__dirname, "fake-claude.cjs");
fs.chmodSync(fake, 0o755);
const cfgFile = path.join(tmp, "config.json");
fs.writeFileSync(
  cfgFile,
  JSON.stringify({
    // The live config still carries the old name until it is edited: the
    // supervisor must show the session as JOYA AI anyway.
    name: "JOYA AI",
    cli: fake,
    cli_version: "2.1.283",
    cwd: tmp,
    home,
    runtime_dir: "",
    state_dir: path.join(tmp, "state"),
    log_dir: path.join(tmp, "log"),
    run_dir: path.join(tmp, "run"),
    socket_group: "root",
    approval_timeout_s: 3,
    sessions_poll_s: 1,
    backoff_min_s: 1,
    backoff_max_s: 2,
    cost_scan_s: 1,
  })
);
const SOCK = path.join(tmp, "run", "joya-ai.sock");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSupervisor() {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "supervisor.js")], {
    env: { ...process.env, JOYA_AI_CONFIG: cfgFile, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  return child;
}

let n = 0;
function call(op, params = {}, actor = "tester") {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify({ id: "t" + ++n, op, actor, ...params }) + "\n"));
    s.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        s.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
  });
}
function raw(line) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(line + "\n"));
    s.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        s.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
  });
}

/** Subscribe to events; returns { events, waitFor(pred, ms), close() }. */
function subscribe(since = 0) {
  const events = [];
  const waiters = [];
  const s = net.createConnection(SOCK);
  let buf = "";
  s.setEncoding("utf8");
  s.on("connect", () => s.write(JSON.stringify({ id: "sub", op: "events", actor: "tester", since }) + "\n"));
  s.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.event) {
        events.push(m.event);
        for (const w of waiters.slice()) if (w.pred(m.event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m.event);
        }
      }
    }
  });
  return {
    events,
    waitFor(pred, ms = 8000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) {
            waiters.splice(i, 1);
            resolve(null);
          }
        }, ms);
      });
    },
    close: () => s.destroy(),
  };
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {
      /* not yet */
    }
    await sleep(150);
  }
  return null;
}

(async () => {
  if (process.getuid() !== 0) {
    console.log("needs root (the supervisor refuses to run as anyone else)");
    process.exit(2);
  }
  const sup = startSupervisor();
  try {
    const ready = await until(async () => {
      const r = await call("status");
      return r.ok && r.data.process.state === "ready" && r.data.remote_control.enabled ? r : null;
    });
    check("supervisor comes up and the process is ready", !!ready, sup.logs);
    if (!ready) throw new Error("not ready");
    check("the pinned CLI version is checked", ready.data.process.cli_version === "2.1.283");
    check("socket is 0660", (fs.statSync(SOCK).mode & 0o777) === 0o660);
    const argv0 = JSON.parse(fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n")[0]);
    const nAt = argv0.indexOf("-n");
    check("the session is named JOYA AI, though the config says JOYA AI", nAt !== -1 && argv0[nAt + 1] === "JOYA AI", argv0.join(" "));
    check("first start uses --session-id, not --resume", argv0.includes("--session-id") && !argv0.includes("--resume"));
    check("runs with --permission-prompt-tool stdio", argv0.join(" ").includes("--permission-prompt-tool stdio"));
    check("runs in auto mode with the configured model", argv0.join(" ").includes("--permission-mode auto") && argv0.join(" ").includes("--model claude-opus-5-5"));
    check("replays user messages (peer turns are visible)", argv0.includes("--replay-user-messages"));
    const rcu = await call("rc-url");
    check("remote control was switched on and its URL is served", rcu.ok && rcu.data.enabled && /session_FAKE/.test(rcu.data.url));

    // --- validation over the real socket
    const bad = await raw("not json");
    check("socket: refuses non-JSON", !bad.ok && /JSON/.test(bad.error));
    const noActor = await raw(JSON.stringify({ id: "x", op: "status" }));
    check("socket: refuses a request without an actor", !noActor.ok && /actor/.test(noActor.error));
    const extra = await raw(JSON.stringify({ id: "x", op: "send", actor: "a", text: "hi", shell: "rm -rf /" }));
    check("socket: refuses an unexpected field", !extra.ok && /unexpected/.test(extra.error));
    const unknown = await call("exec", {});
    check("socket: refuses an unknown op", !unknown.ok && /unknown op/.test(unknown.error));
    const ghost = await call("send", { text: "hi", target: "no-such-session" });
    check("socket: refuses a target that is not a live session", !ghost.ok && /no live session/.test(ghost.error));

    const sub = subscribe(0);

    // --- a plain turn
    const sent = await call("send", { text: "hello there" });
    check("send is accepted and queued", sent.ok && sent.data.turn.status === "queued" && sent.data.turn.actor === "tester");
    const echo = await sub.waitFor((e) => e.type === "assistant" && /^echo: hello there/.test(e.text));
    check("the reply streams back as an event", !!echo);
    // The first turn after the supervisor started carries, after the turn's own words, the note that it (re)started.
    check("the first turn after a start tells JOYA AI the supervisor (re)started, once, after the turn's own words", !!echo && /^echo: hello there\n\n\[System note from the supervisor, not the administrator: your supervisor \(joya-ai\) \(re\)started at /.test(echo.text) && /Check the journal/.test(echo.text), echo && echo.text.slice(0, 300));
    const ended = await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === sent.data.turn.id);
    check("the turn ends done", ended && ended.turn.status === "done", JSON.stringify(ended));

    // --- the rename: addressed by either of its names, it is a plain turn, not a delegation
    for (const nm of ["JOYA AI", "JOYA AI"]) {
      const self = await call("send", { text: "self " + nm, target: nm });
      check(`a send addressed to "${nm}" is accepted as a plain turn (no target)`, self.ok && self.data.turn.target === null, JSON.stringify(self));
      if (self.ok) await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === self.data.turn.id);
    }

    // --- the voice front desk: a send marked as coming from it, and its snapshot
    const desk = await call("send", { text: "how is the disk", via: "voice-desk" }, "amaraghy");
    check("a voice-desk send is queued with its own source", desk.ok && desk.data.turn.source === "voice-desk" && desk.data.turn.actor === "amaraghy", JSON.stringify(desk));
    const deskEcho = await sub.waitFor((e) => e.type === "assistant" && /^echo: how is the disk/.test(e.text));
    check("JOYA AI is told the reply will be read aloud", !!deskEcho && /voice front desk passed it on/.test(deskEcho.text), deskEcho && deskEcho.text);
    await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === desk.data.turn.id);
    const snap = await call("snapshot", { turns: [desk.data.turn.id, sent.data.turn.id] }, "amaraghy");
    check("snapshot answers", snap.ok && snap.data.machine && snap.data.services && snap.data.sessions && snap.data.approvals, JSON.stringify(snap).slice(0, 300));
    check("snapshot returns only the desk's own turns (not a dashboard turn)", snap.ok && snap.data.requests_to_joya_ai.length === 1 && snap.data.requests_to_joya_ai[0].id === desk.data.turn.id && snap.data.requests_to_joya_ai[0].answered === true);
    const other = await call("snapshot", { turns: [desk.data.turn.id] }, "someone-else");
    check("another panel user cannot read the desk's turns", other.ok && other.data.requests_to_joya_ai.length === 0);
    check("snapshot figures are in human units", snap.ok && typeof snap.data.machine.memory.used_percent === "number" && typeof snap.data.machine.disk.free_gb === "number");
    const ck = snap.data && snap.data.clock;
    check("the snapshot carries the time in UTC, the administrator's zone (Cairo) and the server's, with offsets", ck && / UTC$/.test(ck.utc) && ck.admin.zone === "Africa/Cairo" && /^UTC[+-]\d\d:\d\d$/.test(ck.admin.offset) && ck.server.zone && /^UTC[+-]\d\d:\d\d$/.test(ck.server.offset) && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ck.admin.time), JSON.stringify(ck));
    check("  and the supervisor's own last start", snap.ok && (snap.data.restarts || []).some((r) => r.component === "Joya-ai" || r.component === "joya-ai"), JSON.stringify(snap.data.restarts));
    // The dashboard (re)started: told to JOYA AI with its next turn, once, and kept for the snapshot.
    const dep = await call("deploy-event", { component: "dashboard", started_at: "2026-09-30T14:00:02.000Z", commit: "abc1234", deployed_at: "2026-09-30T13:59:40Z" }, "joya-dashboard");
    check("deploy-event is accepted from the dashboard", dep.ok, JSON.stringify(dep));
    const afterDep = await call("send", { text: "after the deploy" });
    const depEcho = await sub.waitFor((e) => e.type === "assistant" && /^echo: after the deploy/.test(e.text));
    check("  JOYA AI's next turn says the dashboard restarted, with the commit, and to check the journal", !!depEcho && /the Joya dashboard \(joya-dashboard\) \(re\)started at 2026-09-30T14:00:02\.000Z UTC, running commit abc1234 deployed at 2026-09-30T13:59:40Z/.test(depEcho.text), depEcho && depEcho.text);
    await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === afterDep.data.turn.id);
    const onceMore = await call("send", { text: "and once more" });
    const againEcho = await sub.waitFor((e) => e.type === "assistant" && /^echo: and once more/.test(e.text));
    check("  only once", !!againEcho && !/System note/.test(againEcho.text), againEcho && againEcho.text);
    await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === onceMore.data.turn.id);
    const snap2 = await call("snapshot", {}, "amaraghy");
    check("  and the snapshot lists it", snap2.ok && (snap2.data.restarts || []).some((r) => r.commit === "abc1234"), JSON.stringify(snap2.data && snap2.data.restarts));

    // --- approval: deny
    await call("send", { text: "DESTROY one" });
    const ap1 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending");
    check("a destructive call raises an approval card", ap1 && ap1.approval.tool === "Bash" && /rm \/tmp\/joya-fake-victim/.test(ap1.approval.summary), JSON.stringify(ap1));
    check("the card carries the gate's category", ap1 && ap1.approval.category === "delete");
    check("the card has an expiry", ap1 && Date.parse(ap1.approval.expires_at) > Date.now());
    const st1 = await call("status");
    check("status lists the pending approval", st1.data.approvals.some((a) => a.id === ap1.approval.id));
    const snapAp = await call("snapshot", {}, "amaraghy");
    check("the desk's snapshot counts the pending approval by title", snapAp.ok && snapAp.data.approvals.pending >= 1 && snapAp.data.approvals.titles.some((t) => /\(Bash\)$/.test(t)), JSON.stringify(snapAp.data && snapAp.data.approvals));
    check("and never carries its command", snapAp.ok && !JSON.stringify(snapAp.data).includes("joya-fake-victim"));
    check("status shows the step waiting", st1.data.current_turn && st1.data.current_turn.steps.some((s) => s.st === "wait"));
    const d1 = await call("deny", { approval_id: ap1.approval.id, note: "not today" }, "amaraghy");
    check("deny is accepted", d1.ok && d1.data.approval.status === "denied" && d1.data.approval.decided_by === "amaraghy");
    const denied = await sub.waitFor((e) => e.type === "assistant" && /^denied:/.test(e.text));
    check("the model is told who denied it and not to retry", denied && /Denied by amaraghy/.test(denied.text) && /not today/.test(denied.text) && /Do not retry/.test(denied.text), denied && denied.text);
    const again = await call("approve", { approval_id: ap1.approval.id });
    check("an answered approval cannot be answered again", !again.ok && /already denied/.test(again.error));

    // --- approval: approve
    await call("send", { text: "DESTROY two" });
    const ap2 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && e.approval.id !== ap1.approval.id);
    // Windows Hello for approvals (2026-10-08): the panel holds the card while Hello runs, and says how it was approved.
    const h2 = await call("approval-hold", { approval_id: ap2.approval.id, seconds: 30 }, "amaraghy");
    check("approval-hold moves the card's expiry later while Windows Hello runs", h2.ok && h2.data.held === true && Date.parse(h2.data.expires_at) > Date.parse(ap2.approval.expires_at), JSON.stringify(h2));
    const hHeld = await sub.waitFor((e) => e.type === "approval" && e.approval.id === ap2.approval.id && e.approval.expires_at === (h2.data && h2.data.expires_at));
    check("  the card's new expiry is published to the viewers", !!hHeld);
    const hBot = await call("approval-hold", { approval_id: ap2.approval.id, seconds: 30 }, "joya-ai");
    check("  only the administrator's panel may hold a card", !hBot.ok);
    const a2 = await call("approve", { approval_id: ap2.approval.id, verified: "hello", verified_with: "Laptop Windows Hello" }, "amaraghy");
    check("approve is accepted", a2.ok && a2.data.approval.status === "approved");
    check("  the approval records Windows Hello and the passkey", a2.ok && a2.data.approval.verified === "hello" && a2.data.approval.verified_with === "Laptop Windows Hello", JSON.stringify(a2.data && a2.data.approval));
    const badV = await call("approve", { approval_id: ap2.approval.id, verified: "face" }, "amaraghy");
    check("  an unknown verification method is refused by the protocol", !badV.ok && /verified/.test(badV.error));
    check("the model is allowed to proceed", !!(await sub.waitFor((e) => e.type === "assistant" && e.text === "allowed")));

    // --- approval: nobody answers
    await call("send", { text: "DESTROY three" });
    const ap3 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && e.approval.id > ap2.approval.id);
    const exp = await sub.waitFor((e) => e.type === "approval" && e.approval.id === ap3.approval.id && e.approval.status === "expired", 8000);
    check("an unanswered approval expires", !!exp);
    const timedOut = await sub.waitFor((e) => e.type === "assistant" && /denied by default/.test(e.text));
    check("an expired approval is a denial", !!timedOut);

    // --- a delegation through the ledger hooks
    await call("send", { text: "DELEGATE please" });
    const dSent = await sub.waitFor((e) => e.type === "delegation" && e.delegation.status === "sent");
    check("delegation recorded as sent with its msg_id", dSent && dSent.delegation.msg_id && dSent.delegation.target_name === "fake-target" && dSent.delegation.notify_idle === 1, JSON.stringify(dSent));
    const dAck = await sub.waitFor((e) => e.type === "delegation" && e.delegation.id === dSent.delegation.id && e.delegation.status === "ack");
    check("the reply moves it to ack with the reply text", dAck && /42 passed/.test(dAck.delegation.reply_text));
    const dDone = await sub.waitFor((e) => e.type === "delegation" && e.delegation.id === dSent.delegation.id && e.delegation.status === "done");
    check("it ends done", !!dDone);
    const inb = await call("ledger", { table: "inbound" });
    check("the reply is in the inbound ledger, linked to the delegation", inb.ok && inb.data.rows.some((r) => r.kind === "message" && r.delegation_id === dSent.delegation.id));
    const sess = await call("sessions");
    check("sessions merge the ledger", sess.ok && sess.data.sessions.some((s) => s.name === "fake-target" && s.last_delegation && s.last_delegation.id === dSent.delegation.id));

    // --- sub-agents: a Task/Agent tool run shows up under its parent session,
    // and drops off once it is no longer running (end_turn, or gone stale).
    const subDir = path.join(home, ".claude", "projects", "-fake", "fake-target-session", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "agent-test1.jsonl"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }) + "\n"
    );
    fs.writeFileSync(path.join(subDir, "agent-test1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Run the fake test suite", requestShape: "background" }));
    const withAgent = await until(async () => {
      const s = await call("sessions");
      const t = s.data.sessions.find((x) => x.session_id === "fake-target-session");
      return t && t.subagents && t.subagents.length ? t : null;
    }, 5000);
    check(
      "a running sub-agent appears under its parent session",
      !!withAgent && withAgent.subagents[0].id === "test1" && withAgent.subagents[0].description === "Run the fake test suite" && withAgent.subagents[0].status === "running",
      withAgent && JSON.stringify(withAgent.subagents)
    );
    fs.writeFileSync(
      path.join(subDir, "agent-test1.jsonl"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n"
    );
    const gone = await until(async () => {
      const s = await call("sessions");
      const t = s.data.sessions.find((x) => x.session_id === "fake-target-session");
      return t && (!t.subagents || !t.subagents.length) ? true : null;
    }, 5000);
    check("it drops off the session once it finishes (end_turn)", !!gone);

    // --- audit
    const audit = await call("ledger", { table: "audit", limit: 100 });
    const ops = audit.data.rows.map((r) => r.op + ":" + r.actor);
    check("sends are audited with the panel user", ops.includes("send:tester"));
    check("denials and approvals are audited with who answered", ops.includes("deny:amaraghy") && ops.includes("approve:amaraghy"));
    check("refused actions are audited too", audit.data.rows.some((r) => r.op === "approve" && r.ok === 0));
    check("read-only calls are not audited", !ops.some((o) => o.startsWith("status:")));
    const auditFile = fs.readFileSync(path.join(tmp, "log", "audit.log"), "utf8");
    check("the audit log file is written", /op=deny/.test(auditFile) && /actor=amaraghy/.test(auditFile));
    const turnsL = await call("ledger", { table: "turns" });
    check("turns ledger records source and actor", turnsL.data.rows.some((t) => t.source === "dashboard" && t.actor === "tester" && t.status === "done"));

    // --- restart resumes, only after the old process exits
    const rs = await call("restart", {}, "amaraghy");
    check("restart is accepted", rs.ok, rs.error);
    await until(async () => (await call("status")).data.process.state === "ready");
    const argvs = fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("the restarted process resumes the same session id", argvs.length >= 2 && argvs[argvs.length - 1].includes("--resume") && argvs[argvs.length - 1].includes(argv0[argv0.indexOf("--session-id") + 1]));

    // --- fresh start: a new conversation, never the old id
    const stateFile = path.join(tmp, "state", "state.json");
    const readSt = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const argvLines = () => fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const oldId = readSt().session_id;
    const selfRefused = await call("fresh", {}, "joya-ai");
    check("fresh: JOYA AI itself may not ask for one", !selfRefused.ok && /administrator/.test(selfRefused.error), selfRefused.error);
    await call("send", { text: "SLOW 1500" });
    await until(async () => (await call("status")).data.busy);
    const busyRefused = await call("fresh", {}, "amaraghy");
    check("fresh: refused while a turn is running", !busyRefused.ok && /not idle/.test(busyRefused.error), busyRefused.error);
    await sub.waitFor((e) => e.type === "assistant" && e.text === "slow done", 8000);
    await until(async () => !(await call("status")).data.busy);
    // Usage in the old transcript is JOYA AI's own: once retired it must not
    // turn up as another session's estimated spend. A control transcript must.
    const usageRec = (id) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 200000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    fs.appendFileSync(path.join(home, ".claude", "projects", "-fake", oldId + ".jsonl"), usageRec("msg_old_self") + "\n");
    const otherSid = "abcdabcd-1111-4222-8333-444455556666";
    fs.writeFileSync(path.join(home, ".claude", "projects", "-fake", otherSid + ".jsonl"), usageRec("msg_other") + "\n");
    const before = argvLines().length;
    const fr = await call("fresh", { reason: "context too large" }, "amaraghy");
    check("fresh is accepted and names both ids", fr.ok && fr.data.old_session_id === oldId && fr.data.new_session_id && fr.data.new_session_id !== oldId, JSON.stringify(fr));
    const frReady = await until(async () => {
      const r = await call("status");
      return r.data.process.state === "ready" && r.data.remote_control.enabled && r.data.init && r.data.init.session_id === fr.data.new_session_id ? r : null;
    });
    check("the fresh process comes up ready with Remote Control on", !!frReady);
    const after = argvLines().slice(before);
    const newId = fr.ok ? fr.data.new_session_id : "";
    check("the fresh start uses --session-id <new>", after.length >= 1 && after[0].includes("--session-id") && after[0][after[0].indexOf("--session-id") + 1] === newId, JSON.stringify(after));
    check("and never --resume, nor the old id", after.every((a) => !a.includes("--resume") && !a.includes(oldId)));
    check("it keeps model, effort, permission mode and MCP config", after[0] && after[0].join(" ").includes("--model claude-opus-5-5") && after[0].includes("--effort") && after[0].join(" ").includes("--permission-mode auto") && after[0].includes("--mcp-config"));
    const st = readSt();
    check("state holds the new id and the old one as previous", st.session_id === newId && st.previous_session_id === oldId);
    const h = (st.session_history || []).slice(-1)[0];
    check("the old id is in the session history with who, when and why", h && h.session_id === oldId && h.retired_by === "amaraghy" && h.reason === "context too large" && h.next_session_id === newId && Date.parse(h.retired_at) > 0, JSON.stringify(h));
    check("the old transcript stays on disk", fs.existsSync(path.join(home, ".claude", "projects", "-fake", oldId + ".jsonl")));
    check("status shows the new id and its init tools", frReady && frReady.data.session_id === newId && frReady.data.previous_session_id === oldId && frReady.data.init.mcp_tools.includes("mcp__joya-ai__status_snapshot"), JSON.stringify(frReady && frReady.data.init));
    const auditFr = (await call("ledger", { table: "audit", limit: 50 })).data.rows;
    check("fresh is audited with the panel user", auditFr.some((r) => r.op === "fresh" && r.actor === "amaraghy" && r.ok === 1));
    check("and the rotation records both ids", auditFr.some((r) => r.op === "session-rotate" && r.actor === "amaraghy" && String(r.detail).includes(oldId) && String(r.detail).includes(newId)), JSON.stringify(auditFr.filter((r) => r.op === "session-rotate")));
    check("a refused fresh is audited too", auditFr.some((r) => r.op === "fresh" && r.ok === 0));
    const costRep = await until(async () => {
      const c = await call("cost");
      return c.ok && c.data.sessions.some((x) => x.session_id === otherSid) ? c : null;
    }, 8000);
    check("the cost scanner still counts other sessions", !!costRep);
    check("but not JOYA AI's retired transcript", costRep && !costRep.data.sessions.some((x) => x.session_id === oldId), JSON.stringify(costRep && costRep.data.sessions));
    const postTurn = await call("send", { text: "hello after fresh" });
    const postEnd = await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === postTurn.data.turn.id);
    check("the new session answers a turn", postEnd && postEnd.turn.status === "done", JSON.stringify(postEnd));
    const postRow = (await call("ledger", { table: "turns", limit: 5 })).data.rows.find((r) => r.id === postTurn.data.turn.id);
    check("its cost starts from the new process's running total", postRow && postRow.cost_usd != null && Math.abs((postRow.cost_delta_usd || 0) - postRow.cost_usd) < 1e-9, JSON.stringify(postRow));
    const rs2 = await call("restart", {}, "amaraghy");
    await until(async () => (await call("status")).data.process.state === "ready");
    const last = argvLines().slice(-1)[0];
    check("a normal restart after it resumes the NEW id", rs2.ok && last.includes("--resume") && last[last.indexOf("--resume") + 1] === newId && !last.includes(oldId), JSON.stringify(last));
    // the one-shot flag file
    fs.writeFileSync(path.join(tmp, "state", "fresh-start"), "flag test\n");
    await call("restart", {}, "amaraghy");
    await until(async () => (await call("status")).data.process.state === "ready" && readSt().session_id !== newId);
    const st2 = readSt();
    const last2 = argvLines().slice(-1)[0];
    check("the flag file starts a fresh session once", st2.session_id !== newId && st2.previous_session_id === newId && last2.includes("--session-id") && last2.includes(st2.session_id) && !last2.includes("--resume"), JSON.stringify(last2));
    check("and is removed after use", !fs.existsSync(path.join(tmp, "state", "fresh-start")));
    check("the flag rotation is recorded", (st2.session_history || []).some((x) => x.session_id === newId && x.retired_by === "flag-file" && x.reason === "flag test"));
    check("history keeps both retired ids", (st2.session_history || []).map((x) => x.session_id).join(",") === [oldId, newId].join(","));

    // --- single instance
    const second = startSupervisor();
    const code = await new Promise((r) => second.on("exit", r));
    check("a second supervisor refuses to start", code !== 0 && /another supervisor/.test(second.logs), second.logs);

    // --- never resume a session someone else holds
    const sid = JSON.parse(fs.readFileSync(path.join(tmp, "state", "state.json"), "utf8")).session_id;
    const holder = spawn("sleep", ["60"]);
    fs.writeFileSync(path.join(home, ".claude", "sessions", holder.pid + ".json"), JSON.stringify({ pid: holder.pid, sessionId: sid }));
    await call("restart", {}, "amaraghy");
    const blocked = await until(async () => {
      const s = await call("status");
      return s.data.process.state === "blocked" ? s : null;
    }, 8000);
    check("will not start while another process holds the session id", !!blocked && /held by pid/.test(blocked.data.process.error), blocked && blocked.data.process.error);
    holder.kill();
    fs.unlinkSync(path.join(home, ".claude", "sessions", holder.pid + ".json"));
    const recovered = await until(async () => (await call("status")).data.process.state === "ready", 15000);
    check("and starts once the holder is gone", !!recovered);

    sub.close();
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    sup.kill("SIGTERM");
    const code = await new Promise((r) => {
      sup.on("exit", r);
      setTimeout(() => r("timeout"), 25000);
    });
    check("SIGTERM stops it cleanly", code === 0, "exit " + code + "\n" + sup.logs.slice(-800));
    check("and removes its socket", !fs.existsSync(SOCK));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
