/**
 * The living canvas at the supervisor: JOYA AI's ui-widget op (its MCP ui_widget).
 *
 *     sudo node joya-ai/tools/test-ui-widget.cjs
 *
 * A real supervisor.js in a scratch directory against a fake claude (no model, nothing live touched).
 * Checks: ui-widget only from actor joya-ai, only while a turn the administrator started from the
 * Command Center (with a ui token) runs, only widgets the building blocks accept (refused at the
 * socket otherwise), at most 3 a turn; the "ui" event (action widget.show) is live-only and carries a
 * tag of the token, never the token, and the canonical widget; the tab's answer comes back as ok /
 * refused (with why); no answer is no-screen; a shown one is kept with its turn in the ledger (read back
 * re-validated, sent to every viewer as a turn event); the audit shows a summary of the widget, never the token.
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-widget-test-"));
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

const crypto = require("crypto");
const tagOf = (ut) => crypto.createHash("sha256").update(ut).digest("hex").slice(0, 16);
const UT = "UtUtUtUtUtUtUtUtUtUtUt01";

(async () => {
  if (process.getuid() !== 0) {
    console.log("needs root (the supervisor refuses to run as anyone else)");
    process.exit(2);
  }
  const sup = startSupervisor();
  try {
    const ready = await until(async () => {
      const r = await call("status");
      return r.ok && r.data.process.state === "ready" ? r : null;
    });
    check("supervisor comes up", !!ready, sup.logs);
    if (!ready) throw new Error("not ready");
    const sub = subscribe(0);
    const SPEND = { v: 1, kind: "chart", title: "Spend, last 14 days", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "days" }] };
    const uw = (widget, actor = "joya-ai") => call("ui-widget", { widget }, actor);

    const idle = await uw(SPEND);
    check("no turn running: refused", !idle.ok && /no turn is running/.test(idle.error), JSON.stringify(idle));

    const sent = await call("send", { text: "SLOW 12000", ut: UT }, "admin");
    check("send with a ui token is accepted", sent.ok, JSON.stringify(sent));
    await until(async () => (await call("status")).data.busy, 8000);

    check("from actor admin: refused (JOYA AI's own tool)", /JOYA AI's own tool/.test((await uw(SPEND, "admin")).error || ""));
    const bad = await uw({ v: 1, kind: "list", title: "<script>x</script>", blocks: [{ type: "list", items: [{ text: "x" }] }] });
    check("a widget with markup: refused at the socket, with the reason", !bad.ok && /markup/.test(bad.error), JSON.stringify(bad));
    const url = await uw({ v: 1, kind: "list", title: "x", blocks: [{ type: "list", items: [{ text: "go to https://evil.example" }] }] });
    check("a widget with a URL: refused", !url.ok && /URL/.test(url.error), JSON.stringify(url));
    check("an unknown field: refused", !(await uw(Object.assign({ html: "<b>" }, SPEND))).ok);

    const pending = uw(SPEND);
    const ev = await sub.waitFor((e) => e.type === "ui" && e.action === "widget.show", 3000);
    check("a live \"ui\" event widget.show reaches the viewers", !!ev, JSON.stringify(sub.events.slice(-3)));
    check("  with the canonical widget, a tag of the token (never the token), its turn and a toast", ev && ev.widget && ev.widget.size === "m" && ev.widget.blocks[0].style === "bar" && ev.ut_tag === tagOf(UT) && !JSON.stringify(ev).includes(UT) && ev.turn_id === sent.data.turn.id && /added a widget: Spend/.test(ev.toast), JSON.stringify(ev));
    check("  not in the ring (seq 0)", ev && ev.seq === 0);
    await call("ui-ack", { nonce: ev.nonce, ok: true }, "admin");
    const res = await pending;
    check("the tab's ok comes back: status ok, and a reminder to say it in words", res.ok && res.data.status === "ok" && res.data.shown === SPEND.title && /in words/.test(res.data.note), JSON.stringify(res));

    const tev = await sub.waitFor((e) => e.type === "turn" && e.phase === "widget", 3000);
    check("shown: kept with the reply -- a turn event (phase widget) carries it, checked, for every viewer", tev && tev.turn.id === sent.data.turn.id && tev.turn.widgets.length === 1 && tev.turn.widgets[0].widget.title === SPEND.title && tev.turn.widgets[0].key === "chart:usage.spend" && tev.turn.widgets[0].id === ev.nonce, JSON.stringify(tev && tev.turn.widgets));
    const lt = await call("ledger", { table: "turns", limit: 5 });
    const row = lt.ok && lt.data.rows.find((r) => r.id === sent.data.turn.id);
    check("  the ledger's turn row holds it (the conversation's own store): read back re-validated, as a list", row && Array.isArray(row.widgets) && row.widgets.length === 1 && row.widgets[0].widget.blocks[0].view === "days", JSON.stringify(row && row.widgets));
    const p2 = uw({ v: 1, kind: "table", title: "Disk", blocks: [{ type: "table", columns: [{ key: "d", label: "Dir" }], rows: [{ d: "/var" }] }] });
    const ev2 = await sub.waitFor((e) => e.type === "ui" && e.action === "widget.show" && e.nonce !== ev.nonce, 3000);
    await call("ui-ack", { nonce: ev2.nonce, ok: false, why: "the administrator keeps dismissing table widgets; answer in words" }, "admin");
    const r2 = await p2;
    check("a refusal (a kind always dismissed) comes back as refused, with why", r2.ok && r2.data.status === "refused" && /keeps dismissing/.test(r2.data.why) && /in words/.test(r2.data.note), JSON.stringify(r2));

    const row2 = (await call("ledger", { table: "turns", limit: 5 })).data.rows.find((r) => r.id === sent.data.turn.id);
    check("a refused widget is not kept with the reply", row2.widgets.length === 1, JSON.stringify(row2.widgets));
    const t0 = Date.now();
    const r3 = await uw(SPEND);
    check("no answer in 5 s: no-screen", r3.ok && r3.data.status === "no-screen" && Date.now() - t0 >= 4800, JSON.stringify(r3));
    const row3 = (await call("ledger", { table: "turns", limit: 5 })).data.rows.find((r) => r.id === sent.data.turn.id);
    check("nor one no screen answered", row3.widgets.length === 1);
    const r4 = await uw(SPEND);
    check("at most 3 widgets a turn", !r4.ok && /at most 3 widgets/.test(r4.error), JSON.stringify(r4));

    const replay = subscribe(0);
    await sleep(600);
    check("a new viewer replaying the ring gets no ui event", !replay.events.some((e) => e.type === "ui"));
    replay.close();
    const audit = await call("ledger", { table: "audit", limit: 200 });
    const auditTxt = JSON.stringify(audit.data);
    check("the audit shows ui-widget with a summary of the widget, never the token", /ui-widget/.test(auditTxt) && /widget chart .{1,6}Spend, last 14 days.{1,6}, 1 blocks/.test(auditTxt) && !auditTxt.includes(UT), auditTxt.slice(0, 400));

    await call("interrupt", {}, "admin");
    await until(async () => !(await call("status")).data.busy, 15000);
    const after = await uw(SPEND);
    check("after the turn: refused", !after.ok, JSON.stringify(after));
    const noTok = await call("send", { text: "SLOW 4000" }, "admin");
    await until(async () => (await call("status")).data.busy, 8000);
    const r5 = await uw(SPEND);
    check("a turn without a ui token: refused", noTok.ok && !r5.ok && /not started by the administrator/.test(r5.error), JSON.stringify(r5));
    await call("interrupt", {}, "admin");
    await until(async () => !(await call("status")).data.busy, 15000);
    sub.close();
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    sup.kill("SIGTERM");
    await new Promise((r) => {
      sup.on("exit", r);
      setTimeout(r, 25000);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
