/**
 * The turn queue through a real supervisor, against the fake CLI, plus JOYA
 * AI's MCP status_snapshot tool against that supervisor.
 *
 *     sudo node joya-ai/tools/test-queue.cjs
 *
 * Scratch directory, config, socket and Claude home: nothing of the live
 * service is touched and no model is called. Checks:
 *   - a watcher turn queued first, then a user turn: the user turn runs first,
 *     the watcher turn after it (not dropped);
 *   - the supervisor hands the CLI one turn at a time;
 *   - status lists the queue in the order it will run, with each turn's class;
 *   - a supervisor restart keeps the queue: unsent turns come back, in
 *     priority order, and run;
 *   - bin/joya-ai-mcp's status_snapshot returns the snapshot from this
 *     supervisor, with no command in it.
 */
"use strict";
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-queue-"));
const home = path.join(tmp, "home");
const helperDir = path.join(tmp, "helper");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
fs.mkdirSync(helperDir, { recursive: true });
for (const f of ["fake-claude.cjs", "fake-helper.cjs"]) fs.chmodSync(path.join(__dirname, f), 0o755);
const odooLog = path.join(tmp, "odoo.log");
fs.writeFileSync(odooLog, "");
const cfgFile = path.join(tmp, "config.json");
fs.writeFileSync(
  cfgFile,
  JSON.stringify({
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
    voice_lanes: false, // this test is about the main queue; a live call's lanes are tools/test-voicelanes.cjs
    sessions_poll_s: 1,
    backoff_min_s: 1,
    backoff_max_s: 2,
    helper: path.join(__dirname, "fake-helper.cjs"),
    odoo_log: odooLog,
    watcher_poll_s: 60,
    watcher_cooldown_s: 1,
    watcher_max_investigations_per_hour: 50,
    watcher_inject: true,
    orders_tick_s: 60,
    cost_scan_s: 60,
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
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 500) + ")" : ""));
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
function stopSupervisor(sup) {
  sup.kill("SIGTERM");
  return new Promise((r) => {
    sup.on("exit", r);
    setTimeout(() => r("timeout"), 40000);
  });
}

let n = 0;
function call(op, params = {}, actor = "tester") {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify({ id: "q" + ++n, op, actor, ...params }) + "\n"));
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
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {
      /* not yet */
    }
    await sleep(100);
  }
  return null;
}
/** Every turn start/end event, in order. */
function subscribe() {
  const events = [];
  const s = net.createConnection(SOCK);
  let buf = "";
  s.setEncoding("utf8");
  s.on("connect", () => s.write(JSON.stringify({ id: "sub", op: "events", actor: "tester", since: 0 }) + "\n"));
  s.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.event && m.event.type === "turn") events.push(m.event);
    }
  });
  s.on("error", () => {});
  return { events, close: () => s.destroy() };
}
const startOrder = (events, ids) => events.filter((e) => e.phase === "start" && ids.includes(e.turn.id)).map((e) => e.turn.id);
async function turnRow(id) {
  const r = await call("ledger", { table: "turns", limit: 200 });
  return r.ok ? r.data.rows.find((t) => t.id === id) : null;
}
async function waitReady() {
  return until(async () => {
    const r = await call("status");
    return r.ok && r.data.process.state === "ready" ? r : null;
  }, 15000);
}
async function injectWatcher(subject) {
  const inj = await call("watcher-inject", { watcher: "service_failed", subject });
  if (!inj.ok) throw new Error("inject: " + inj.error);
  const d = await call("decisions", { status: "all" });
  const dec = d.data.decisions.find((x) => x.id === inj.data.decision.id);
  return dec && dec.turn_id;
}

/** Talk to bin/joya-ai-mcp over stdio the way the CLI does. */
function mcpClient() {
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "joya-ai-mcp")], { env: { ...process.env, JOYA_AI_SOCKET: SOCK }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      w(m);
    }
  });
  let id = 0;
  return {
    req(method, params) {
      const my = ++id;
      return new Promise((resolve) => {
        waiting.set(my, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
        setTimeout(() => resolve(null), 10000);
      });
    },
    close: () => child.stdin.end(),
  };
}

(async () => {
  if (process.getuid() !== 0) {
    console.log("needs root (the supervisor refuses to run as anyone else)");
    process.exit(2);
  }
  let sup = startSupervisor();
  try {
    check("supervisor comes up", !!(await waitReady()), sup.logs);
    const sub = subscribe();
    await sleep(200);

    // --- 1. a watcher turn queued first, then a user turn: the user goes first
    const busy = await call("send", { text: "SLOW 1500" });
    check("a slow user turn is taken", busy.ok);
    await until(async () => (await call("status")).data.busy, 5000);
    const w1 = await injectWatcher("q-unit-1");
    check("a watcher investigation is queued", !!w1);
    const u1 = await call("send", { text: "what is the disk", via: "voice-desk" }, "amaraghy");
    check("a voice turn is queued after it", u1.ok);
    check("the voice turn is told only the running turn is ahead of it", u1.ok && u1.data.queued_behind === 1, JSON.stringify(u1.data));
    const st = await call("status");
    check(
      "status lists the queue in run order with each turn's class",
      st.ok && st.data.queued.length === 2 && st.data.queued[0].id === u1.data.turn.id && st.data.queued[0].priority === "user" && st.data.queued[1].id === w1 && st.data.queued[1].priority === "background",
      JSON.stringify(st.data.queued)
    );
    const argvLines = () => fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").trim().split("\n").length;
    const both = await until(async () => {
      const a = await turnRow(u1.data.turn.id);
      const b = await turnRow(w1);
      return a && b && a.status === "done" && b.status === "done" ? [a, b] : null;
    }, 20000);
    check("both turns finish (the background one is not dropped)", !!both);
    const order1 = startOrder(sub.events, [busy.data.turn.id, w1, u1.data.turn.id]);
    check("the user turn ran before the earlier watcher turn", order1.join(",") === [busy.data.turn.id, u1.data.turn.id, w1].join(","), JSON.stringify(order1));
    if (both) {
      check("the user turn was handed over only after the slow one ended", both[0].sent_at >= (await turnRow(busy.data.turn.id)).ended_at.slice(0, 19), JSON.stringify(both[0]));
      check("the watcher turn was handed over only after the user turn ended", both[1].sent_at >= both[0].ended_at.slice(0, 19));
    }
    check("one process throughout (no restart involved)", argvLines() === 1);

    // --- 2. background runs straight away when no user turn waits
    const w2 = await injectWatcher("q-unit-2");
    const w2done = await until(async () => {
      const r = await turnRow(w2);
      return r && r.status === "done" ? r : null;
    }, 10000);
    check("a background turn with nothing ahead runs at once", !!w2done);

    // --- 3. the queue survives a supervisor restart
    const slow = await call("send", { text: "SLOW 2500" });
    await until(async () => (await call("status")).data.busy, 5000);
    const w3 = await injectWatcher("q-unit-3");
    const u3 = await call("send", { text: "hello after restart" }, "amaraghy");
    check("before the restart: two turns wait in the supervisor", (await call("status")).data.queued.length === 2);
    sub.close();
    const code = await stopSupervisor(sup);
    check("the supervisor stops cleanly with turns queued", code === 0, "exit " + code + " " + sup.logs.slice(-600));
    sup = startSupervisor();
    check("it comes back up", !!(await waitReady()), sup.logs);
    const sub2 = subscribe();
    check("it says it re-queued them", /re-queued 2 turn/.test(sup.logs), sup.logs.slice(-800));
    const after = await until(async () => {
      const a = await turnRow(u3.data.turn.id);
      const b = await turnRow(w3);
      return a && b && a.status === "done" && b.status === "done" ? [a, b] : null;
    }, 20000);
    check("both queued turns run after the restart", !!after, JSON.stringify([await turnRow(u3.data.turn.id), await turnRow(w3)]));
    const order3 = startOrder(sub2.events, [w3, u3.data.turn.id]);
    check("the user turn still goes first after the restart", order3.join(",") === [u3.data.turn.id, w3].join(","), JSON.stringify(order3));
    const slowRow = await turnRow(slow.data.turn.id);
    check("the turn that was running at the restart finished before it (not replayed)", slowRow.status === "done", JSON.stringify(slowRow));
    sub2.close();

    // --- 3b. a live call's repeat, still queued, is folded into its turn (one turn, one answer)
    const sub3 = subscribe();
    const slow2 = await call("send", { text: "SLOW 2000" });
    await until(async () => (await call("status")).data.busy, 5000);
    const v1 = await call("send", { text: "restart the odoo service", via: "voice-desk", call: "lvcall1" }, "amaraghy");
    const v2 = await call("send", { text: "restart odoo please", via: "voice-desk", call: "lvcall1" }, "amaraghy");
    const v3 = await call("send", { text: "restart odoo please", via: "voice-desk", call: "lvcall2" }, "amaraghy");
    const d1 = await call("send", { text: "restart odoo please" }, "amaraghy");
    check("a repeat from the same call while the first waits: the same turn, marked merged", v1.ok && v2.ok && v2.data.merged === true && v2.data.turn.id === v1.data.turn.id, JSON.stringify(v2.data));
    check("  another call's, or a typed one, is its own turn", v3.ok && !v3.data.merged && v3.data.turn.id !== v1.data.turn.id && d1.ok && d1.data.turn.id !== v1.data.turn.id);
    const vrow = await turnRow(v1.data.turn.id);
    check("  the turn holds both, the repeat marked as said again", vrow && /^restart the odoo service\n\n\[Said again while this was waiting:\] restart odoo please/.test(vrow.text), vrow && vrow.text);
    check("  the queue has one turn for the two", (await call("status")).data.queued.filter((q) => q.id === v1.data.turn.id).length === 1 && (await call("status")).data.queued.length === 3);
    const merged = await until(async () => {
      const r = await turnRow(v1.data.turn.id);
      return r && r.status === "done" ? r : null;
    }, 20000);
    check("  and JOYA AI answers it once, with both in its words", !!merged && sub3.events.filter((e) => e.phase === "start" && e.turn.id === v1.data.turn.id).length === 1);
    const late = await call("send", { text: "restart odoo please", via: "voice-desk", call: "lvcall1" }, "amaraghy");
    check("  once it has been handed to JOYA AI, a repeat is a new turn", late.ok && !late.data.merged && late.data.turn.id !== v1.data.turn.id);
    await until(async () => {
      const r = await turnRow(late.data.turn.id);
      return r && r.status === "done";
    }, 20000);
    void slow2;
    sub3.close();

    // --- 4. JOYA AI's MCP server: status_snapshot against this supervisor
    const m = mcpClient();
    const init = await m.req("initialize", { protocolVersion: "2025-06-18" });
    check("MCP server initialises", init && init.result && init.result.serverInfo.name === "joya-ai");
    const list = await m.req("tools/list", {});
    check("MCP lists status_snapshot", list && list.result.tools.some((t) => t.name === "status_snapshot"));
    const snap = await m.req("tools/call", { name: "status_snapshot", arguments: {} });
    const text = snap && snap.result && snap.result.content[0].text;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      /* checked below */
    }
    check("status_snapshot returns this supervisor's snapshot", !!data && !snap.result.isError && data.machine && data.services && data.joya_ai && data.joya_ai.state === "ready", text);
    check("its decisions are titles only (the watcher decisions are there, no fix command)", !!data && data.decisions.open >= 1 && !/systemctl restart/.test(text), text && text.slice(0, 400));
    const bad = await m.req("tools/call", { name: "status_snapshot", arguments: { turns: [1] } });
    check("status_snapshot refuses arguments", bad && bad.result.isError);
    m.close();
    const audit = await call("ledger", { table: "audit", limit: 200 });
    check("a read-only snapshot is not audited as a change", audit.ok && !audit.data.rows.some((r) => r.op === "snapshot"));
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    const code = await stopSupervisor(sup);
    check("SIGTERM stops it cleanly", code === 0, "exit " + code + "\n" + sup.logs.slice(-800));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
