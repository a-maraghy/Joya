/**
 * Command Center v3, phase 1, end to end against a fake claude and a fake
 * helper (tools/fake-claude.cjs, tools/fake-helper.cjs).
 *
 *     sudo node joya-ai/tools/test-features.cjs
 *
 * A real supervisor.js in a scratch directory with its own config, ledger,
 * sockets and Claude home: nothing of the live service is touched, no model is
 * called, no real service is stopped. Covers:
 *
 *   - missions: a two-step mission created over the socket (as JOYA AI's MCP
 *     server does), both steps delegated with the step tag, and the delegation
 *     lifecycle driving the steps to done and the mission to done;
 *   - watchers: a synthetic event through the fault-injection op and a real
 *     "failed" unit through the helper; the investigation turn, the proposal,
 *     Dismiss, Approve (the fix goes through the approval gate as a card), Ask
 *     more, de-duplication, the cooldown, and the on/off switch persisting
 *     across a restart;
 *   - standing orders: the seeded morning briefing, Run now (its card), a new
 *     order scheduled for the next minute running exactly once;
 *   - approval rules: built-ins listed and undeletable, add / test / edit /
 *     delete, and "Always allow this" from a card matching the next identical
 *     command with no card;
 *   - cost: per-turn deltas from the running total, across a restart;
 *   - the audit trail for every write.
 *
 * Needs root: the supervisor refuses to run as anyone else.
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-feat-"));
const home = path.join(tmp, "home");
const helperDir = path.join(tmp, "helper");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
fs.mkdirSync(helperDir, { recursive: true });
for (const f of ["fake-claude.cjs", "fake-helper.cjs"]) fs.chmodSync(path.join(__dirname, f), 0o755);
const odooLog = path.join(tmp, "odoo.log");
fs.writeFileSync(odooLog, "");
const cfgFile = path.join(tmp, "config.json");
const fakeGpt = path.join(tmp, "chatgpt_mcp.py");
fs.writeFileSync(fakeGpt, "# fake ask_chatgpt server\n");
const baseCfg = {
  chatgpt_mcp: fakeGpt,
  cli: path.join(__dirname, "fake-claude.cjs"),
  cli_version: "2.1.283",
  cwd: tmp,
  home,
  runtime_dir: "",
  state_dir: path.join(tmp, "state"),
  log_dir: path.join(tmp, "log"),
  run_dir: path.join(tmp, "run"),
  socket_group: "root",
  approval_timeout_s: 20,
  sessions_poll_s: 1,
  backoff_min_s: 1,
  backoff_max_s: 2,
  helper: path.join(__dirname, "fake-helper.cjs"),
  odoo_log: odooLog,
  watcher_poll_s: 1,
  watcher_cooldown_s: 3,
  watcher_max_investigations_per_hour: 50,
  watcher_inject: true,
  orders_tick_s: 1,
  cost_scan_s: 2,
};
fs.writeFileSync(cfgFile, JSON.stringify(baseCfg));
const SOCK = path.join(tmp, "run", "joya-ai.sock");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSupervisor() {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "supervisor.js")], {
    env: { ...process.env, JOYA_AI_CONFIG: cfgFile, HOME: home, FAKE_HELPER_DIR: helperDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  return child;
}
async function stopSupervisor(sup) {
  sup.kill("SIGTERM");
  return new Promise((r) => {
    sup.on("exit", r);
    setTimeout(() => r("timeout"), 25000);
  });
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

function subscribe() {
  const events = [];
  const waiters = [];
  const s = net.createConnection(SOCK);
  let buf = "";
  s.setEncoding("utf8");
  s.on("connect", () => s.write(JSON.stringify({ id: "sub", op: "events", actor: "tester" }) + "\n"));
  s.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.event) {
        events.push(m.event);
        for (const w of waiters.slice())
          if (w.pred(m.event)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(m.event);
          }
      }
    }
  });
  return {
    events,
    waitFor(pred, ms = 10000) {
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
    await sleep(200);
  }
  return null;
}
const ready = () => until(async () => (await call("status")).data.process.state === "ready", 15000);

(async () => {
  if (process.getuid() !== 0) {
    console.log("needs root (the supervisor refuses to run as anyone else)");
    process.exit(2);
  }
  let sup = startSupervisor();
  try {
    check("supervisor comes up", !!(await ready()), sup.logs);
    const argv0 = JSON.parse(fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n")[0]);
    const mcpAt = argv0.indexOf("--mcp-config");
    check("JOYA AI is started with its own MCP server", mcpAt !== -1 && /joya-ai-mcp/.test(argv0[mcpAt + 1]) && argv0.includes("mcp__joya-ai") && JSON.parse(argv0[mcpAt + 1]).mcpServers["joya-ai"], argv0.join(" "));
    const gptConf = mcpAt !== -1 ? JSON.parse(argv0[mcpAt + 1]).mcpServers.chatgpt : null;
    check("JOYA AI also gets ask_chatgpt (the ChatGPT broker's server), allowed", gptConf && gptConf.args.includes(fakeGpt) && gptConf.env.JOYA_CHATGPT_CALLER === "joya-ai" && argv0.includes("mcp__chatgpt") && argv0.includes("mcp__joya-ai"), argv0.join(" "));
    const sub = subscribe();

    /* ------------------------------------------------------ missions --- */
    await call("send", { text: "MISSION2" });
    const done = await sub.waitFor((e) => e.type === "mission" && e.mission.status === "done", 15000);
    check("a two-step mission ends done, driven by its delegations", !!done, JSON.stringify(sub.events.filter((e) => e.type === "mission").slice(-1)));
    if (done) {
      const m = done.mission;
      check("both steps are done and linked to their delegations", m.steps.length === 2 && m.steps.every((s) => s.status === "done" && s.delegation_id), JSON.stringify(m.steps));
      check("the steps carry the replies as results", m.steps[0].result && /step 1 done/.test(m.steps[0].result));
      check("the mission was created by JOYA AI (actor joya-ai)", m.created_by === "joya-ai");
      const states = sub.events.filter((e) => e.type === "mission").map((e) => e.mission.steps[0].status);
      check("step 1 walked planned -> delegated -> working -> done", ["delegated", "working", "done"].every((s) => states.includes(s)), states.join(","));
      const dl = await call("ledger", { table: "delegations" });
      check("delegations record their mission and step", dl.data.rows.filter((d) => d.mission_id === m.id && d.step_id).length === 2);
      const ms = await call("missions", { status: "all" });
      check("missions op lists it with metrics", ms.ok && ms.data.missions[0].metrics.steps_done === 2 && ms.data.missions[0].ref === "M-" + m.id);
      const one = await call("mission", { mission_id: "M-" + m.id });
      check("mission op reads one by its ref", one.ok && one.data.mission.id === m.id);
    }
    const badStep = await call("mission-step-update", { mission_id: "M-999", step: 1, status: "done" }, "joya-ai");
    check("a step of a mission that does not exist is refused", !badStep.ok && /no mission/.test(badStep.error));
    const badStatus = await call("mission-step-update", { mission_id: "M-1", step: 1, status: "exploded" }, "joya-ai");
    check("an unknown step status is refused by the protocol", !badStatus.ok);
    const created = await call("mission-create", { title: "Manual", goal: "g", steps: [{ title: "a", target: "joya-ai" }] }, "joya-ai");
    const upd = await call("mission-step-update", { mission_id: created.data.mission.ref, step: 1, status: "working" }, "joya-ai");
    check("a step JOYA AI sets by hand moves the mission to active", upd.ok && upd.data.mission.status === "active" && upd.data.mission.steps[0].status === "working");
    const req = await call("mission-request", { goal: "Check every session is healthy" }, "amaraghy");
    check("New mission queues a mission-request turn for JOYA AI", req.ok && req.data.turn.source === "mission-request");
    const echoed = await sub.waitFor((e) => e.type === "assistant" && /Mission request from amaraghy/.test(e.text || ""), 8000);
    check("the mission request reached JOYA AI with the goal", !!echoed && /Check every session is healthy/.test(echoed.text));

    /* ------------------------------------------------------ watchers --- */
    const w0 = await call("watchers");
    check("five watchers, all on by default", w0.ok && w0.data.watchers.length === 5 && w0.data.watchers.every((w) => w.enabled));
    const inj = await call("watcher-inject", { watcher: "service_failed", subject: "joya-e2e-fake", evidence: "synthetic evidence line" }, "tester");
    check("a synthetic event raises a decision card and an investigation", inj.ok && inj.data.created && inj.data.investigate, JSON.stringify(inj));
    const did = inj.data.decision.id;
    const proposed = await sub.waitFor((e) => e.type === "decision" && e.decision.id === did && e.decision.status === "proposed", 10000);
    check("JOYA AI's proposal arrives on the card with the fix command", !!proposed && /systemctl restart joya-e2e-fake/.test(proposed.decision.fix_command), JSON.stringify(proposed));
    const dup = await call("watcher-inject", { watcher: "service_failed", subject: "joya-e2e-fake" });
    check("the same event again only bumps the open card (de-duplicated)", dup.ok && !dup.data.created && dup.data.skipped === "duplicate" && dup.data.decision.count === 2);
    const ask = await call("decision-ask", { decision_id: did, text: "Why did it fail?" }, "amaraghy");
    check("Ask more queues a follow-up turn", ask.ok && ask.data.turn && ask.data.turn.source === "decision");
    const askSeen = await sub.waitFor((e) => e.type === "assistant" && /question from amaraghy/.test(e.text || ""), 8000);
    check("the follow-up reached JOYA AI", !!askSeen);
    await sub.waitFor((e) => e.type === "turn" && e.phase === "end" && e.turn.id === ask.data.turn.id, 8000);
    // Approve: the fix runs as a JOYA AI action, through the gate.
    const ap = await call("decision-approve", { decision_id: did }, "amaraghy");
    check("Approve queues the fix and marks the card running", ap.ok && ap.data.decision.status === "running" && ap.data.turn.source === "decision");
    const card = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && /restart joya-e2e-fake/.test(e.approval.summary), 10000);
    check("the fix still raises an approval card (no bypass of the gate)", !!card, JSON.stringify(sub.events.filter((e) => e.type === "approval").slice(-2)));
    check("the card is linked to its decision", card && card.approval.decision_id === did);
    if (card) await call("approve", { approval_id: card.approval.id }, "amaraghy");
    const fixed = await sub.waitFor((e) => e.type === "decision" && e.decision.id === did && e.decision.status === "done", 10000);
    check("after the gate approves, the fix is reported done on the card", !!fixed && /fix ran/.test(fixed.decision.result || ""));
    const cool = await call("watcher-inject", { watcher: "service_failed", subject: "joya-e2e-fake" });
    check("a closed card's subject stays quiet during the cooldown", cool.ok && !cool.data.created && cool.data.skipped === "cooldown");
    // Dismiss path
    const inj2 = await call("watcher-inject", { watcher: "disk", subject: "/" });
    const did2 = inj2.data.decision.id;
    await sub.waitFor((e) => e.type === "decision" && e.decision.id === did2 && e.decision.status === "proposed", 10000);
    const dis = await call("decision-dismiss", { decision_id: did2, note: "known" }, "amaraghy");
    check("Dismiss closes the card", dis.ok && dis.data.decision.status === "dismissed" && dis.data.decision.decided_by === "amaraghy");
    const dis2 = await call("decision-dismiss", { decision_id: did2 });
    check("a dismissed card cannot be dismissed again", !dis2.ok && /already dismissed/.test(dis2.error));
    const apDis = await call("decision-approve", { decision_id: did2 });
    check("a dismissed card cannot be approved", !apDis.ok);
    // A real observation through the helper: a unit reported failed.
    fs.writeFileSync(path.join(helperDir, "services.json"), JSON.stringify([{ unit: "nginx", active: "active" }, { unit: "joya-agent@e2e", active: "failed", kind: "agent", since: "now" }]));
    const real = await sub.waitFor((e) => e.type === "decision" && e.decision.watcher === "service_failed" && e.decision.subject === "joya-agent@e2e", 8000);
    check("a unit the helper reports failed raises a card by itself", !!real);
    const mach = await call("machine");
    check("the machine card lists the failed unit", mach.ok && mach.data.services.failed.some((f) => f.unit === "joya-agent@e2e"), JSON.stringify(mach.data && mach.data.services));
    fs.writeFileSync(path.join(helperDir, "services.json"), JSON.stringify([{ unit: "nginx", active: "active" }]));
    // Bans burst through pulse-feed
    const t = Date.now();
    fs.writeFileSync(path.join(helperDir, "events.json"), JSON.stringify(Array.from({ length: 22 }, (_, i) => ({ type: "ban", jail: "sshd", at: new Date(t - i * 1000).toISOString() }))));
    const bans = await sub.waitFor((e) => e.type === "decision" && e.decision.watcher === "ban_burst", 8000);
    check("more than 20 bans in 10 minutes raises a ban-burst card", !!bans);
    // Odoo errors from the trial log
    fs.appendFileSync(odooLog, Array.from({ length: 6 }, (_, i) => `2026-09-28 10:00:0${i},123 4242 ERROR gizaseeds_test odoo.http: boom ${i}`).join("\n") + "\n");
    const odooCard = await sub.waitFor((e) => e.type === "decision" && e.decision.watcher === "odoo_errors", 8000);
    check("five ERROR lines in the trial Odoo log raise a card with the lines as evidence", !!odooCard && /boom/.test(odooCard.decision.evidence || ""));
    // switch persists
    const off = await call("watcher-set", { key: "disk", enabled: false }, "amaraghy");
    check("a watcher can be switched off", off.ok && off.data.watcher.enabled === false);
    const offInj = await call("watcher-inject", { watcher: "disk", subject: "/var" });
    check("a switched-off watcher does not fire", offInj.ok && !offInj.data.created && offInj.data.skipped === "disabled");

    /* ---------------------------------------------------- rules --- */
    const r0 = await call("rules");
    const builtins = r0.data.rules.filter((r) => r.builtin);
    check("the built-in safety rules are listed", ["no-force-push", "no-client-repo-push", "ask-live-odoo", "classifier"].every((k) => builtins.some((b) => b.builtin_key === k)));
    const delB = await call("rule-delete", { rule_id: builtins[0].id });
    check("a built-in rule cannot be deleted", !delB.ok && /built-in/.test(delB.error));
    const edB = await call("rule-update", { rule_id: builtins[0].id, note: "x" });
    check("a built-in rule cannot be edited", !edB.ok && /built-in/.test(edB.error));
    const t1 = await call("rule-test", { command: "git push --force origin main" });
    check("Test a command: a force push is denied by the built-in", t1.ok && t1.data.decision === "deny" && t1.data.rule && t1.data.rule.builtin_key === "no-force-push");
    const t2 = await call("rule-test", { command: "curl -s https://test.gizaseeds.cloud/web/health" });
    check("Test a command: live Odoo always asks", t2.ok && t2.data.decision === "ask" && t2.data.source === "builtin");
    const t3 = await call("rule-test", { command: "ls -la /tmp" });
    check("Test a command: a harmless command runs", t3.ok && t3.data.decision === "none");
    const wide = await call("rule-create", { effect: "allow", tool: "Bash", pattern: "git push *" });
    check("an allow rule that would cover a built-in deny is refused", !wide.ok && /built-in/.test(wide.error));
    const mk = await call("rule-create", { effect: "deny", tool: "Bash", pattern: "rm -rf /srv/*", note: "never" }, "amaraghy");
    check("a deny rule can be added", mk.ok && mk.data.rule.effect === "deny" && mk.data.rule.created_by === "amaraghy");
    const t4 = await call("rule-test", { command: "cd /srv && rm -rf /srv/data" });
    check("the deny rule matches inside a compound command", t4.data.decision === "deny" && t4.data.rule.id === mk.data.rule.id);
    const ed = await call("rule-update", { rule_id: mk.data.rule.id, effect: "ask" });
    check("a rule can be edited", ed.ok && ed.data.rule.effect === "ask");
    const del = await call("rule-delete", { rule_id: mk.data.rule.id });
    check("a rule can be deleted", del.ok);

    // Always allow this, from a card, then matched with no card.
    const CMD = "rm /tmp/joya-e2e-always-allow-probe";
    await call("send", { text: "RUN " + CMD });
    const c1 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && e.approval.summary === CMD, 10000);
    check("the command raises a card first", !!c1);
    check("the card carries an exact rule suggestion", c1 && c1.approval.rule_suggestion && c1.approval.rule_suggestion.pattern === CMD);
    const sug = await call("rule-suggest", { approval_id: c1.approval.id });
    check("rule-suggest returns the narrow rule scoped to JOYA AI on this VPS", sug.ok && sug.data.rule.pattern === CMD && sug.data.rule.scope_session === "joya-ai" && sug.data.rule.scope_machine === "this");
    const wrong = await call("approve", { approval_id: c1.approval.id, rule_pattern: "rm /tmp/something-else", rule_tool: "Bash" });
    check("an always-allow rule that does not match this command is refused", !wrong.ok && /would not match/.test(wrong.error));
    const always = await call("approve", { approval_id: c1.approval.id, rule_pattern: sug.data.rule.pattern, rule_tool: "Bash" }, "amaraghy");
    check("Always allow this approves the card and saves the rule", always.ok && always.data.approval.status === "approved" && always.data.rule && always.data.rule.source_approval_id === c1.approval.id);
    await sub.waitFor((e) => e.type === "assistant" && e.text === "allowed", 8000);
    const before = sub.events.length;
    await call("send", { text: "RUN " + CMD });
    const auto = await sub.waitFor((e) => e.type === "approval" && e.approval.summary === CMD && e.approval.status === "approved" && /^rule:/.test(e.approval.decided_by || ""), 10000);
    check("the next identical command is allowed by the rule, with no card", !!auto && !sub.events.slice(before).some((e) => e.type === "approval" && e.approval.summary === CMD && e.approval.status === "pending"));
    const other = CMD + "-other";
    await call("send", { text: "RUN " + other });
    const c3 = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "pending" && e.approval.summary === other, 10000);
    check("a different command still asks", !!c3);
    if (c3) await call("deny", { approval_id: c3.approval.id }, "amaraghy");
    const rf = await call("rule-create", { effect: "deny", tool: "Bash", pattern: "rm /tmp/joya-e2e-denied-*" });
    await call("send", { text: "RUN rm /tmp/joya-e2e-denied-1" });
    const autoDeny = await sub.waitFor((e) => e.type === "approval" && e.approval.status === "denied" && /^rule:/.test(e.approval.decided_by || ""), 10000);
    check("a deny rule answers a can_use_tool with no card", !!autoDeny && rf.ok);

    /* ------------------------------------------------------ orders --- */
    const o0 = await call("orders");
    const brief = o0.data.orders.find((o) => o.seed_key === "morning-briefing");
    check("the Morning briefing is seeded: 07:30 Africa/Cairo daily, JOYA AI, Command Center", brief && brief.cron === "30 7 * * *" && brief.tz === "Africa/Cairo" && brief.target === "joya-ai" && brief.delivery.join() === "cc" && !brief.paused);
    check("its next run is in the future at 07:30 Cairo", brief && Date.parse(brief.next_run_at) > Date.now() && new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" }).format(new Date(brief.next_run_at)) === "07:30");
    check("the brief stays on this VPS and names no live server", brief && !/rpc\.py|gizaseeds\.cloud|live Odoo/i.test(brief.prompt) && /Stay on this VPS/.test(brief.prompt));
    check("Telegram delivery is reported unavailable, with a reason", o0.data.telegram && o0.data.telegram.available === false && o0.data.telegram.why);
    const run = await call("order-run", { order_id: brief.id }, "amaraghy");
    check("Run now starts a run", run.ok && run.data.run.status === "running" && run.data.run.manual === 1);
    const runDone = await sub.waitFor((e) => e.type === "order_run" && e.run.id === run.data.run.id && e.run.status === "ok", 10000);
    check("the briefing's result lands on the run (its card)", !!runDone && /Services/.test(runDone.run.result));
    const tr = await call("ledger", { table: "turns", limit: 50 });
    check("the briefing turn is a source=order turn carrying its order id", tr.data.rows.some((r) => r.source === "order" && r.order_id === brief.id));
    const noTg = await call("order-create", { name: "x", schedule: { kind: "daily", at: "08:00" }, target: "joya-ai", prompt: "p", delivery: ["telegram"] });
    check("Telegram-only delivery is refused", !noTg.ok && /Telegram/.test(noTg.error));
    const badT = await call("order-create", { name: "x", schedule: { kind: "daily", at: "08:00" }, target: "nobody-here", prompt: "p", delivery: ["cc"] });
    check("an order for a session that is not live is refused", !badT.ok && /no live session/.test(badT.error));
    const badC = await call("order-create", { name: "x", schedule: { kind: "cron", cron: "99 * * * *" }, target: "joya-ai", prompt: "p", delivery: ["cc"] });
    check("a bad cron is refused", !badC.ok);
    const every = await call("order-create", { name: "Every minute test", schedule: { kind: "cron", cron: "* * * * *" }, target: "joya-ai", prompt: "Say PONG-ORDER.", delivery: ["cc"] }, "amaraghy");
    check("an order scheduled for the next minute is created", every.ok && Date.parse(every.data.order.next_run_at) - Date.now() <= 61000, JSON.stringify(every));
    const oid = every.data.order.id;
    const ran = await sub.waitFor((e) => e.type === "order_run" && e.run.order_id === oid && e.run.status === "ok", 75000);
    check("it runs at its minute", !!ran && ran.run.manual === 0);
    await call("order-pause", { order_id: oid, paused: true }, "amaraghy");
    const runs = await call("order-runs", { order_id: oid });
    check("exactly once", runs.ok && runs.data.runs.length === 1, JSON.stringify(runs.data && runs.data.runs));
    const paused = await call("orders");
    check("a paused order has no next run", paused.data.orders.find((o) => o.id === oid).next_run_at === null);
    const ren = await call("order-update", { order_id: oid, name: "Renamed", schedule: { kind: "hours", every_h: 6, at: "00:15" } });
    check("an order can be edited", ren.ok && ren.data.order.name === "Renamed" && ren.data.order.cron === "15 */6 * * *");
    const del2 = await call("order-delete", { order_id: oid });
    check("an order can be deleted", del2.ok);

    /* -------------------------------------------------------- cost --- */
    const turnsNow = (await call("ledger", { table: "turns", limit: 500 })).data.rows.filter((r) => r.cost_usd != null);
    check("every result records a per-turn delta, not the running total", turnsNow.length > 3 && turnsNow.every((r) => Math.abs(r.cost_delta_usd - 0.01) < 1e-6), JSON.stringify(turnsNow.map((r) => [r.cost_usd, r.cost_delta_usd]).slice(0, 8)));
    const tokTurns = (await call("ledger", { table: "turns", limit: 500 })).data.rows.filter((r) => r.tokens_cum != null);
    check("every result records the turn's own tokens (the running usage's difference), not the running total",
      tokTurns.length > 3 && tokTurns.every((r) => r.tok_input === 1500 && r.tok_output === 200 && r.tok_cache_read === 5000 && r.tok_cache_write === 300), JSON.stringify(tokTurns.map((r) => [r.tokens_cum, r.tok_input]).slice(0, 4)));
    const stTok = await call("status");
    const ssTok = await call("sessions");
    check("status carries JOYA AI's tokens today, sessions carry theirs (from the transcripts, as the Usage sheet)",
      stTok.ok && "tokens_today" in stTok.data && ssTok.ok && ssTok.data.sessions.every((x) => !x.session_id || (x.tokens_today && typeof x.tokens_today.total === "number")), JSON.stringify(ssTok.data && ssTok.data.sessions.map((x) => [x.name, x.tokens_today])));
    const c0 = await call("cost");
    const expect = Math.round(turnsNow.length * 0.01 * 100) / 100;
    check("today's JOYA AI cost is the sum of the deltas", c0.ok && Math.abs(c0.data.today.joya_ai_usd - expect) < 0.011, `${c0.data && c0.data.today.joya_ai_usd} vs ${expect}`);
    check("cost has 14 days", c0.data.days.length === 14);
    /* ------------------------------------------------ plan usage --- */
    const u0 = await call("usage");
    const up = u0.ok && u0.data.plan && u0.data.plan.plan;
    check("usage: plan figures come from the CLI's get_usage, in /usage's order and labels",
      up && up.rows.map((r) => r.title).join("|") === "Current session|Current week (all models)|Current week (Fable)" && up.rows[0].utilization === 18 && up.rows[1].utilization === 39.6 && up.rows[1].resets_at === "2026-10-05T13:00:00.411Z",
      JSON.stringify(u0.data || u0.error));
    check("usage: the source is JOYA AI's own CLI", u0.ok && u0.data.plan.source === "joya-ai" && u0.data.plan.stale === false);
    check("usage: nothing outside the whitelisted windows is passed on", u0.ok && !JSON.stringify(u0.data).includes("MUST-NOT-LEAK") && !JSON.stringify(u0.data).includes("total_cost_usd"));
    check("usage: token counts come with it", u0.ok && u0.data.tokens && u0.data.tokens.days.length === 14 && u0.data.tokens.periods.today.totals.total >= 0);
    const u1 = await call("usage", { plan_only: true });
    check("usage: plan_only skips the token counts; a second ask within a minute is the cached answer", u1.ok && u1.data.tokens === null && u1.data.plan.fetched_at === u0.data.plan.fetched_at);
    const bud = await call("cost-budget", { daily_usd: 40, warn_pct: 80 }, "amaraghy");
    check("a daily budget can be set", bud.ok && bud.data.budget.daily_usd === 40);

    /* ------------------------------------------------- restart --- */
    sub.close();
    const code = await stopSupervisor(sup);
    check("SIGTERM stops it cleanly", code === 0, sup.logs.slice(-600));
    sup = startSupervisor();
    check("it comes back", !!(await ready()), sup.logs);
    const w1 = await call("watchers");
    check("the watcher switch survived the restart", w1.data.watchers.find((w) => w.key === "disk").enabled === false);
    const b1 = await call("cost");
    check("the budget survived the restart", b1.data.budget.daily_usd === 40);
    const r1 = await call("rules");
    check("the always-allow rule survived the restart", r1.data.rules.some((r) => r.pattern === CMD && r.effect === "allow"));
    const sub2 = subscribe();
    await call("send", { text: "after restart" });
    await sub2.waitFor((e) => e.type === "result" && e.turn && e.turn.text === "after restart", 8000);
    const last = (await call("ledger", { table: "turns", limit: 1 })).data.rows[0];
    check("after a restart the first turn's cost is its own (the new process's total), not a negative jump", Math.abs(last.cost_delta_usd - 0.01) < 1e-6 && last.cost_usd === 0.01, JSON.stringify(last));
    check("  and its tokens are its own too (a new process starts from zero)", last.tok_input === 1500 && last.tok_cache_read === 5000, JSON.stringify(last));
    const c1b = await call("cost");
    check("today's cost keeps counting across the restart", Math.abs(c1b.data.today.joya_ai_usd - (expect + 0.01)) < 0.011, `${c1b.data.today.joya_ai_usd}`);
    const o1 = await call("orders");
    check("the seeded briefing is not seeded twice", o1.data.orders.filter((o) => o.seed_key === "morning-briefing").length === 1);
    sub2.close();

    /* --------------------------------------------------- audit --- */
    const audit = await call("ledger", { table: "audit", limit: 500 });
    const ops = new Set(audit.data.rows.map((r) => r.op + ":" + r.actor));
    check(
      "every kind of write is audited with its actor",
      ["mission-create:joya-ai", "decision-propose:joya-ai", "decision-approve:amaraghy", "decision-dismiss:amaraghy", "watcher-set:amaraghy", "rule-create:amaraghy", "order-create:amaraghy", "order-run:amaraghy", "cost-budget:amaraghy", "approve:amaraghy"].every((o) => ops.has(o)),
      [...ops].join(" ")
    );
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    const code = await stopSupervisor(sup);
    check("stops cleanly at the end", code === 0, sup.logs.slice(-800));
    if (failures) console.log("\n--- supervisor log tail ---\n" + sup.logs.slice(-3000));
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      fs.unlinkSync("/tmp/joya-e2e-always-allow-probe");
    } catch (_) {
      /* never created: the fake does not run commands */
    }
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
