/**
 * UI control Phase 2 end to end at the supervisor: JOYA AI's ui-action op.
 *
 *     sudo node joya-ai/tools/test-ui-action.cjs
 *
 * A real supervisor.js in a scratch directory against a fake claude (no model,
 * nothing live touched). Checks: ui-action only from actor joya-ai, only while
 * a turn the administrator started from the Command Center (with a ui token)
 * runs, only allowlisted actions, within the rate limits; the "ui" event is
 * live-only (never replayed from the ring) and carries a tag of the token,
 * never the token; the answer (ui-ack) only from that same administrator and
 * once; no answer in 5 s is "no-screen"; the token never reaches the ledger,
 * the events or the audit; and it dies with its turn.
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-ui-test-"));
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
    const ua = (action, args, actor = "joya-ai") => call("ui-action", { action, ...(args ? { args } : {}) }, actor);

    const idle = await ua("sheet.open", { key: "missions" });
    check("no turn running: refused", !idle.ok && /no turn is running/.test(idle.error), JSON.stringify(idle));

    // A turn from the Command Center, with a ui token.
    const sent = await call("send", { text: "SLOW 9000", ut: UT }, "admin");
    check("send with a ui token is accepted", sent.ok, JSON.stringify(sent));
    const started = await sub.waitFor((e) => e.type === "turn" && e.turn && e.turn.phase !== "end" && e.turn.id === sent.data.turn.id && e.turn.status === "running", 8000) || (await until(async () => (await call("status")).data.busy));
    check("the turn runs", !!started);

    check("from actor admin (not JOYA AI's tool): refused", /JOYA AI's own tool/.test((await ua("sheet.open", { key: "missions" }, "admin")).error || ""));
    check("an action off the allowlist (decision.approve): refused", /no such screen action/.test((await ua("decision.approve")).error || ""));
    check("a bad argument (sheet.open key=odoo): refused", !(await ua("sheet.open", { key: "odoo" })).ok);

    // The real thing: emitted live, answered by the administrator.
    const pending = ua("sheet.open", { key: "missions" });
    const ev = await sub.waitFor((e) => e.type === "ui" && e.action === "sheet.open", 3000);
    check("a live \"ui\" event reaches the viewers", !!ev, JSON.stringify(sub.events.slice(-3)));
    check("  it carries a tag of the token, never the token", ev && ev.ut_tag === tagOf(UT) && !JSON.stringify(ev).includes(UT), JSON.stringify(ev));
    check("  for that administrator and turn, with a nonce and a toast", ev && ev.actor === "admin" && ev.turn_id === sent.data.turn.id && /^[0-9a-f]{24}$/.test(ev.nonce) && ev.toast === "Joya opened Missions");
    check("  and it is not in the ring (seq 0)", ev && ev.seq === 0);
    const wrong = await call("ui-ack", { nonce: ev.nonce, ok: true }, "someone-else");
    check("an answer from another user is refused", !wrong.ok && /not yours/.test(wrong.error));
    const acked = await call("ui-ack", { nonce: ev.nonce, ok: true }, "admin");
    check("the administrator's answer is taken", acked.ok);
    const res = await pending;
    check("  and the tool gets ok", res.ok && res.data.status === "ok" && res.data.done === "Joya opened Missions", JSON.stringify(res));
    const again = await call("ui-ack", { nonce: ev.nonce, ok: true }, "admin");
    check("  a second answer to the same nonce is refused (single use)", !again.ok);

    // A refusal from the page.
    const p2 = ua("core.set", { core: "D" });
    const ev2 = await sub.waitFor((e) => e.type === "ui" && e.action === "core.set", 3000);
    await call("ui-ack", { nonce: ev2.nonce, ok: false, why: "a live call is on" }, "admin");
    const r2 = await p2;
    check("a refusal comes back as refused, with why", r2.ok && r2.data.status === "refused" && r2.data.why === "a live call is on", JSON.stringify(r2));

    // A Tier-2 preference: the tab asks the administrator; JOYA AI is told nothing changed yet.
    const p3 = ua("theme.set", { theme: "dark" });
    const ev3 = await sub.waitFor((e) => e.type === "ui" && e.action === "theme.set", 3000);
    await call("ui-ack", { nonce: ev3.nonce, ok: true, pending: true }, "admin");
    const r3c = await p3;
    check("a Tier-2 preference answered pending: status confirm, never ok", r3c.ok && r3c.data.status === "confirm" && /never say it is done/.test(r3c.data.note), JSON.stringify(r3c));

    // Nobody answers.
    const t0 = Date.now();
    const r3 = await ua("reply.show");
    check("no answer in 5 s: no-screen (not ok)", r3.ok && r3.data.status === "no-screen" && Date.now() - t0 >= 4800 && Date.now() - t0 < 8000, JSON.stringify(r3));

    // Rate limit: 6 a turn (4 used).
    const quick = [];
    for (let i = 0; i < 4; i++) {
      const pr = ua("view", { name: "map" });
      const e = await sub.waitFor((x) => x.type === "ui" && x.action === "view" && !quick.includes(x.nonce), 2000);
      if (e) {
        quick.push(e.nonce);
        await call("ui-ack", { nonce: e.nonce, ok: true }, "admin");
      }
      quick.push(await pr);
    }
    const results = quick.filter((x) => typeof x === "object");
    check("at most 6 screen actions in a turn", results.slice(0, 2).every((x) => x.ok) && !results[2].ok && /one turn/.test(results[2].error), JSON.stringify(results.map((x) => x.ok || x.error)));

    // The ring and the ledger never hold it.
    const replay = subscribe(0);
    await sleep(600);
    check("a new viewer replaying the ring gets no ui event", !replay.events.some((e) => e.type === "ui"));
    replay.close();
    const turns = await call("ledger", { table: "turns", limit: 20 });
    check("the ledger's turn row does not hold the token", !JSON.stringify(turns.data).includes(UT));
    const audit = await call("ledger", { table: "audit", limit: 200 });
    const auditTxt = JSON.stringify(audit.data);
    check("the audit shows ui-action and ui-ack, and the send's token only as (set)", /ui-action/.test(auditTxt) && /ui-ack/.test(auditTxt) && !auditTxt.includes(UT) && /\(set\)/.test(auditTxt));
    const auditLog = fs.readFileSync(path.join(tmp, "log", "audit.log"), "utf8");
    check("  and the audit log file never has it either", !auditLog.includes(UT) && /op=ui-action/.test(auditLog));

    // The turn ends: its token dies with it.
    await call("interrupt", {}, "admin");
    await until(async () => !(await call("status")).data.busy, 15000);
    const after = await ua("sheet.open", { key: "missions" });
    check("after the turn: refused", !after.ok && /no turn is running|not started by the administrator/.test(after.error), JSON.stringify(after));

    // A turn with no token (a forged or older send, a watcher, an order): never.
    const noTok = await call("send", { text: "SLOW 4000" }, "admin");
    await until(async () => (await call("status")).data.busy, 8000);
    const r4 = await ua("sheet.open", { key: "missions" });
    check("a turn sent without a ui token: refused", !r4.ok && /not started by the administrator/.test(r4.error), JSON.stringify(r4));
    await call("interrupt", {}, "admin");
    await until(async () => !(await call("status")).data.busy, 15000);
    check("  (that send worked as ever)", noTok.ok);

    // A token on a send from a non-human actor is ignored.
    await call("send", { text: "SLOW 4000", ut: UT }, "watcher");
    await until(async () => (await call("status")).data.busy, 8000);
    const r5 = await ua("sheet.open", { key: "missions" });
    check("a token on a send by actor watcher: ignored, refused", !r5.ok, JSON.stringify(r5));
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
