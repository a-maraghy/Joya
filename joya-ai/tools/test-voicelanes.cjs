#!/usr/bin/env node
/**
 * A live call's voice lanes (lib/voicelane.js, lib/voiceroute.js, supervisor.js "voice lanes"), end to
 * end against the fake claude (tools/fake-claude.cjs): a real supervisor in a scratch directory, no model.
 *
 *     sudo node joya-ai/tools/test-voicelanes.cjs
 *
 * Checks: voice-warm starts the call's quick and work lanes with the right CLI arguments (fresh session
 * ids, models, tools, the lane id in the MCP config); a quick question runs in the quick lane and an
 * ESCALATE goes on to a work lane under the same row; a machine question runs in a work lane; a follow-up
 * folds into a young request (one row, one answer, merged: true) but runs in parallel once the first has
 * acted; an agent named in the request is handed over with the routing note and its reply comes back as
 * the lane's own turn (source peer, follows the request); a lane's approval is a card answered on its
 * stdin; a lane's cost is a chain of its own; the snapshot gives the caller its call's rows; a screen
 * action from a lane's MCP belongs to that lane's turn.
 */
"use strict";
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
    remote_control: false,
    voice_lanes: true,
    voice_fold_s: 45,
    voice_lane_idle_s: 900,
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
  const turnsLog = () => {
    try {
      return fs.readFileSync(path.join(home, "fake-turns.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  };
  const argvs = () => fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const flagOf = (argv, name) => argv[argv.indexOf(name) + 1];
  try {
    const ready = await until(async () => {
      const r = await call("status");
      return r.ok && r.data.process.state === "ready" ? r : null;
    });
    check("supervisor comes up", !!ready, sup.logs);
    if (!ready) throw new Error("not ready");
    const sub = subscribe(0);
    const ended = (id, ms) => sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === id, ms || 8000);

    // --- warm: the call's lanes before its first request
    const warm = await call("voice-warm", { call: "lvtest1" }, "amaraghy");
    check("voice-warm starts a quick and a work lane for the call", warm.ok && warm.data.warmed && warm.data.lanes.map((l) => l.kind).sort().join(",") === "quick,work", JSON.stringify(warm));
    await until(async () => argvs().filter((a) => /joya-internal-voice-/.test(flagOf(a, "-n") || "")).length >= 2, 5000);
    const la = argvs().filter((a) => /joya-internal-voice-/.test(flagOf(a, "-n") || ""));
    const quickArgv = la.find((a) => /quick1$/.test(flagOf(a, "-n")));
    const workArgv = la.find((a) => /work1$/.test(flagOf(a, "-n")));
    check("  lanes are named joya-internal-voice-<call>-<kind><n> (hidden from the session list)", !!quickArgv && !!workArgv && flagOf(quickArgv, "-n") === "joya-internal-voice-lvtest1-quick1", JSON.stringify(la.map((a) => flagOf(a, "-n"))));
    check("  each is a NEW session (--session-id, never --resume), and not JOYA AI's own id", la.every((a) => a.includes("--session-id") && !a.includes("--resume")) && flagOf(quickArgv, "--session-id") !== flagOf(workArgv, "--session-id"));
    check("  the quick lane: haiku, web + weather + memory search only, its own short prompt", flagOf(quickArgv, "--model") === "claude-haiku-5-5" && flagOf(quickArgv, "--tools") === "WebSearch,WebFetch" && quickArgv.includes("--strict-mcp-config") && /ESCALATE/.test(flagOf(quickArgv, "--system-prompt")) && /JOYA_AI_MCP_SET":"quick"/.test(flagOf(quickArgv, "--mcp-config")), quickArgv && quickArgv.join(" ").slice(0, 600));
    check("  the work lane: sonnet at medium effort, JOYA AI's MCP naming its lane, the voice prompt appended, the approval prompt on stdio", flagOf(workArgv, "--model") === "claude-sonnet-5" && flagOf(workArgv, "--effort") === "medium" && /"JOYA_AI_LANE":"v[a-z0-9-]+"/.test(flagOf(workArgv, "--mcp-config")) && /LIVE VOICE CALL/.test(flagOf(workArgv, "--append-system-prompt")) && workArgv.join(" ").includes("--permission-prompt-tool stdio"), workArgv && workArgv.join(" ").slice(0, 600));
    const st0 = await call("status");
    check("  status lists them", st0.ok && st0.data.voice_lanes.length === 2 && st0.data.voice_lanes.every((l) => l.call === "lvtest1"));
    const sid0 = JSON.parse(fs.readFileSync(path.join(tmp, "state", "state.json"), "utf8"));
    check("  their session ids are remembered as JOYA AI's own (the cost scanner)", (sid0.lane_sessions || []).length >= 2);

    // --- quick
    const q = await call("send", { text: "what's the weather like today", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    check("a quick question is a voice-desk turn in lane quick", q.ok && q.data.turn.source === "voice-desk" && q.data.turn.lane === "quick" && q.data.turn.call_id === "lvtest1", JSON.stringify(q));
    const qr = await sub.waitFor((e) => e.type === "result" && e.turn && e.turn.id === q.data.turn.id);
    check("  it is answered there, its message dated for the quick model", !!qr && /^echo: \[Now: /.test(qr.turn.result_text) && /what's the weather like today/.test(qr.turn.result_text), qr && qr.turn.result_text);
    const qa = sub.events.find((e) => e.type === "assistant" && e.turn_id === q.data.turn.id);
    check("  the quick lane's text is shown once it is known not to be ESCALATE", !!qa);
    const qe = await ended(q.data.turn.id);
    check("  and the turn ends done", qe && qe.turn.status === "done");
    const main0 = turnsLog().filter((t) => t.n === "JOYA AI").length;
    check("  JOYA AI's main session never saw it", main0 === 0 || !turnsLog().some((t) => t.n === "JOYA AI" && /weather/.test(t.text)));

    // --- escalate
    const es = await call("send", { text: "what is SAYESCALATE photosynthesis", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    check("a quick question the quick lane hands on (ESCALATE) ...", es.ok && es.data.turn.lane === "quick", JSON.stringify(es));
    const er = await sub.waitFor((e) => e.type === "result" && e.turn && e.turn.id === es.data.turn.id, 8000);
    check("  ... is answered by a work lane, under the same row (no ESCALATE ever shown)", !!er && er.turn.lane === "work" && !/^ESCALATE/.test(er.turn.result_text) && !sub.events.some((e) => e.type === "assistant" && e.turn_id === es.data.turn.id && /ESCALATE$/.test(e.text)), er && JSON.stringify(er.turn));
    await ended(es.data.turn.id);

    // --- work + fold
    const w1 = await call("send", { text: "SLOW 3000 how much disk is used", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    check("a machine question runs in a work lane", w1.ok && w1.data.turn.lane === "work", JSON.stringify(w1));
    await sub.waitFor((e) => e.type === "turn" && e.phase === "start" && e.turn.id === w1.data.turn.id);
    await sleep(300);
    const f1 = await call("send", { text: "and the memory too", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    check("a follow-up while it is young and has done nothing is folded into it: same row, merged", f1.ok && f1.data.merged === true && f1.data.turn.id === w1.data.turn.id, JSON.stringify(f1));
    const fr = await sub.waitFor((e) => e.type === "result" && e.turn && e.turn.id === w1.data.turn.id, 12000);
    check("  and answered ONCE, asked as one request with both parts", !!fr && /how much disk is used/.test(fr.turn.result_text) && /Said next, before you had answered/.test(fr.turn.result_text) && /and the memory too/.test(fr.turn.result_text), fr && fr.turn.result_text);
    const results1 = sub.events.filter((e) => e.type === "result" && e.turn && e.turn.id === w1.data.turn.id);
    check("  (one result for the row: the stopped attempt wrote none)", results1.length === 1, results1.length);
    await ended(w1.data.turn.id, 10000);

    // --- parallel once the running one has acted
    const w2 = await call("send", { text: "DELEGATE QUIET SLOW then the backups", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    await sub.waitFor((e) => e.type === "tool" && e.turn_id === w2.data.turn.id && e.name === "SendMessage");
    const p2 = await call("send", { text: "how is the cpu load", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    check("a follow-up after the running request has acted (sent a message) is NOT folded: its own row", p2.ok && !p2.data.merged && p2.data.turn.id !== w2.data.turn.id, JSON.stringify(p2));
    const pr = await sub.waitFor((e) => e.type === "result" && e.turn && e.turn.id === p2.data.turn.id, 8000);
    const p2msg = turnsLog().find((t) => /how is the cpu load/.test(t.text));
    if (process.env.DEBUG_LANES) console.log(JSON.stringify(p2msg, null, 1));
    check("  it runs, in a lane told what this call asked before (a preface of the earlier requests and answers)", !!pr && /how is the cpu load/.test(pr.turn.result_text) && !!p2msg && /^\[Earlier in this voice call:\]/.test(p2msg.text) && /DELEGATE QUIET SLOW then the backups/.test(p2msg.text), JSON.stringify(p2msg).slice(0, 3000));
    const dl = await call("ledger", { table: "delegations", limit: 5 });
    const myDeleg = dl.ok && dl.data.rows.find((d) => d.turn_id === w2.data.turn.id);
    check("  the lane's SendMessage is recorded as a delegation of ITS request (the hook's session id -> the lane)", !!myDeleg, JSON.stringify(dl.data && dl.data.rows.slice(0, 2)));
    await ended(w2.data.turn.id);
    await ended(p2.data.turn.id);

    // --- agent routing and the reply coming back
    const ag = await call("send", { text: "ask fake-target to run the tests PEERTURN fake-target", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    check("a request addressing a live agent by name goes to lane agent, target set", ag.ok && ag.data.turn.lane === "agent" && ag.data.turn.target === "fake-target", JSON.stringify(ag));
    const agr = await sub.waitFor((e) => e.type === "result" && e.turn && e.turn.id === ag.data.turn.id, 8000);
    check("  the work lane is told to hand it straight to that session and relay the reply", !!agr && /Voice routing: the administrator is asking the agent "fake-target"/.test(agr.turn.result_text) && /SendMessage/.test(agr.turn.result_text), agr && agr.turn.result_text.slice(-500));
    const peer = await sub.waitFor((e) => e.type === "result" && e.turn && e.turn.follows === ag.data.turn.id, 8000);
    check("  the agent's reply comes back as the lane's own turn: source peer, same call, follows the request", !!peer && peer.turn.source === "peer" && peer.turn.call_id === "lvtest1" && /All 42 tests passed/.test(peer.turn.result_text), peer && JSON.stringify(peer.turn));
    const snap = await call("snapshot", { turns: [ag.data.turn.id, peer ? peer.turn.id : 0] }, "amaraghy");
    check("  the snapshot gives the caller both (its reply can be summarised and spoken)", snap.ok && snap.data.requests_to_joya_ai.length === 2 && snap.data.requests_to_joya_ai.every((r) => r.answered), JSON.stringify(snap.data && snap.data.requests_to_joya_ai));
    const snapOther = await call("snapshot", { turns: [peer ? peer.turn.id : 0] }, "someone-else");
    check("  and nobody else", snapOther.ok && snapOther.data.requests_to_joya_ai.length === 0);

    // --- a lane's approval
    const de = await call("send", { text: "DESTROY the victim file", via: "voice-desk", call: "lvtest1" }, "amaraghy");
    const ap = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && e.approval.turn_id === de.data.turn.id, 8000);
    check("a destructive call in a lane raises a card for that request", !!ap && ap.approval.tool === "Bash", JSON.stringify(ap));
    const ok = await call("approve", { approval_id: ap.approval.id, verified: "totp", verified_with: "test" }, "amaraghy");
    check("  approving it ...", ok.ok, JSON.stringify(ok));
    const dr = await sub.waitFor((e) => e.type === "result" && e.turn && e.turn.id === de.data.turn.id, 8000);
    check("  ... answers the lane's CLI (it reports allowed)", !!dr && dr.turn.result_text === "allowed", dr && dr.turn.result_text);
    await ended(de.data.turn.id);

    // --- cost chains
    const rows = (await call("ledger", { table: "turns", limit: 20 })).data.rows;
    const qrow = rows.find((r) => r.id === q.data.turn.id);
    check("a lane turn's cost is its own lane's difference, not the main session's total", qrow && Math.abs(qrow.cost_delta_usd - 0.01) < 1e-9 && /^lane:/.test(qrow.proc_start), JSON.stringify(qrow && { c: qrow.cost_usd, d: qrow.cost_delta_usd, p: qrow.proc_start }));

    // --- a screen action from a lane's MCP belongs to the lane's turn
    const noTurn = await raw(JSON.stringify({ id: "u1", op: "ui-action", actor: "joya-ai", lane: warm.data.lanes[0].id, action: "theme.set", args: { theme: "dark" } }));
    check("a lane's ui-action with no running request in that lane is refused (not taken as the main turn's)", !noTurn.ok && /no turn is running/.test(noTurn.error), JSON.stringify(noTurn));
    const badLane = await raw(JSON.stringify({ id: "u2", op: "status", actor: "tester", lane: "vx-1" }));
    check("only JOYA AI's own actor may name a lane", !badLane.ok && /lane/.test(badLane.error));

    // --- off: the main queue as before
    sub.close();
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    sup.kill("SIGTERM");
    const code = await new Promise((r) => {
      sup.on("exit", r);
      setTimeout(() => r("timeout"), 25000);
    });
    check("SIGTERM stops it cleanly (its lanes with it)", code === 0, "exit " + code + "\n" + sup.logs.slice(-1500));
    if (failures) console.log(sup.logs.slice(-3000));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
