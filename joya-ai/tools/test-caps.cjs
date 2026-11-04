#!/usr/bin/env node
"use strict";
/**
 * The Joya reorganisation's supervisor settings, end to end on a scratch
 * supervisor (the fake CLI, a fake systemctl that runs bin/joya-session itself,
 * a temp HOME and ledger; token usage from fake cost_daily rows). Nothing of
 * the live service is touched.
 *
 *     node joya-ai/tools/test-caps.cjs
 *
 * Covers: hire limits (read at hire time, bounds and bypass refused, the hired
 * permission mode), the approval timeout (effective value), the page map
 * (stored, re-applied on start), and token caps per session (build spec §6):
 * warn raised once, pause holds a queued turn, resume releases it, a hired
 * session gets budget-pause (and its gate denies), a "yours" session is never
 * paused, a new hire takes the default cap, the day turn clears the state.
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const H = require(path.join(ROOT, "lib", "hire.js"));
const C = require(path.join(ROOT, "lib", "caps.js"));
const schedule = require(path.join(ROOT, "lib", "schedule.js"));
const UiActions = require(path.join(ROOT, "lib", "ui-actions.js"));
// A fresh checkout does not keep the executable bit (git mode 100644); the supervisor spawns it directly.
fs.chmodSync(path.join(__dirname, "fake-claude.cjs"), 0o755);

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return console.log("ok   " + name); }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 600) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("lib/hire.js limits");
{
  check("defaults: 7 live, 3 an hour, the config's mode (auto)", JSON.stringify(H.defaultLimits({ permission_mode: "auto" })) === JSON.stringify({ max_live: 7, per_hour: 3, perm_mode: "auto" }));
  check("  a mode outside auto/default/plan falls back to default", H.defaultPermMode({ permission_mode: "bypassPermissions" }) === "default" && H.defaultPermMode({ hired_permission_mode: "plan", permission_mode: "auto" }) === "plan");
  check("checkLimits: in bounds accepted", JSON.stringify(H.checkLimits({ max_live: 12, per_hour: 0, perm_mode: "plan" })) === JSON.stringify({ max_live: 12, per_hour: 0, perm_mode: "plan" }));
  check("  out of bounds, fractions, bypass refused",
    !!H.checkLimits({ max_live: 13 }).error && !!H.checkLimits({ max_live: 0 }).error && !!H.checkLimits({ per_hour: 11 }).error && !!H.checkLimits({ per_hour: 1.5 }).error && /never allowed/.test(H.checkLimits({ perm_mode: "bypassPermissions" }).error) && !!H.checkLimits({ perm_mode: "acceptEdits" }).error);
  check("effectiveLimits: stored values over defaults; junk ignored", JSON.stringify(H.effectiveLimits({ max_live: 9, per_hour: 99, perm_mode: "bypassPermissions" }, {})) === JSON.stringify({ max_live: 9, per_hour: 3, perm_mode: "default" }));
  const fake = { exists: () => true, realpath: (p) => p };
  const hire = (lim, ctx) => H.checkHire({ name: "Test One", cwd: "/root/joya", purpose: "A purpose long enough." }, { live: [], hired: [], recent: 0, cwdOpts: fake, limits: lim, ...ctx });
  check("checkHire takes the limits it is given", /already 2 sessions/.test(hire({ max_live: 2, per_hour: 3 }, { live: [{ name: "A", session_id: "a" }, { name: "B", session_id: "b" }] }).error) && /at most 1 hires an hour/.test(hire({ max_live: 7, per_hour: 1 }, { recent: 1 }).error) && /switched off/.test(hire({ max_live: 7, per_hour: 0 }).error) && hire({ max_live: 7, per_hour: 3 }).ok);
}

console.log("\nlib/caps.js");
{
  const n = C.normalize({ default: { cap: 100, at: "pause" }, sessions: { "<self>": { cap: 5, at: "nope" }, "bad key!": { cap: 5 }, x: { cap: 0 } } });
  check("normalize: bad entries and keys dropped, unknown at = warn", n.default.at === "pause" && n.sessions["<self>"].at === "warn" && !n.sessions["bad key!"] && !n.sessions.x);
  check("stateOf: none / ok / near / warned / paused / resumed",
    C.stateOf(null, 5, 80, {}, true) === "none" && C.stateOf({ cap: 100, at: "pause" }, 10, 80, {}, true) === "ok" && C.stateOf({ cap: 100, at: "pause" }, 85, 80, {}, true) === "near" &&
      C.stateOf({ cap: 100, at: "warn" }, 100, 80, {}, true) === "warned" && C.stateOf({ cap: 100, at: "pause" }, 100, 80, {}, true) === "paused" &&
      C.stateOf({ cap: 100, at: "pause" }, 100, 80, { resumed_at: "x" }, true) === "resumed" && C.stateOf({ cap: 100, at: "pause" }, 100, 80, {}, false) === "warned");
  check("stateFor: another day's record is replaced", C.stateFor({ day: "2000-01-01", sessions: { a: { paused_at: "x" } } }, "2026-09-30").sessions.a === undefined);
}

/* ------------------------------------------------ end to end on a scratch supervisor -- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-caps-"));
const home = path.join(tmp, "home");
const sysd = path.join(tmp, "systemd");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
const cfgFile = path.join(tmp, "config.json");
const cfg = {
  cli: path.join(__dirname, "fake-claude.cjs"), cli_version: "2.1.283", cwd: tmp, home, runtime_dir: "", state_dir: path.join(tmp, "state"), log_dir: path.join(tmp, "log"), run_dir: path.join(tmp, "run"),
  socket_group: "root", approval_timeout_s: 20, retire_consent_s: 30, sessions_poll_s: 1, backoff_min_s: 1, backoff_max_s: 2, cost_scan_s: 1, remote_control: false, permission_mode: "auto",
  systemctl: path.join(__dirname, "fake-systemctl.cjs"),
};
fs.writeFileSync(cfgFile, JSON.stringify(cfg));
fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "# JOYA AI charter (test)\nBe careful.\n");
const SOCK = path.join(tmp, "run", "joya-ai.sock");
const OWN = "0a0b0c0d-0000-4000-8000-00000000000a"; // the administrator's own session
fs.writeFileSync(path.join(home, "fake-agents.json"), JSON.stringify([{ pid: 72001, sessionId: OWN, name: "Demo Own", cwd: "/tmp/demo", kind: "interactive", status: "idle", startedAt: Date.now() }]));
const today = schedule.dayOf(Date.now(), "Africa/Cairo");
let n = 0;
function call(op, params = {}, actor = "amaraghy") {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify({ id: "t" + ++n, op, actor, ...params }) + "\n"));
    s.on("data", (c) => { buf += c; const nl = buf.indexOf("\n"); if (nl !== -1) { s.destroy(); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
}
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; }
function startSup() {
  const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "supervisor.js")], { env: { ...process.env, JOYA_AI_CONFIG: cfgFile, HOME: home, FAKE_SYSTEMCTL_DIR: sysd, FAKE_AGENTS_REGISTER: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  c.logs = "";
  c.stdout.on("data", (d) => (c.logs += d));
  c.stderr.on("data", (d) => (c.logs += d));
  return c;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(cfg.state_dir, "ledger.db"), { timeout: 5000 });
}
function addTokens(sessionId, total) {
  const d = db();
  try {
    d.prepare("INSERT INTO cost_daily (session_id, day, model, input, output, cache_write, cache_read, usd) VALUES (?, ?, 'test-model', ?, ?, 0, ?, 0) ON CONFLICT(session_id, day, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read")
      .run(sessionId, today, Math.floor(total / 10), Math.floor(total / 10), total - 2 * Math.floor(total / 10));
  } finally {
    d.close();
  }
}
const capOf = async (key) => { const r = await call("token-caps"); return r.ok ? r.data.sessions.find((s) => s.key === key) : null; };
const capCards = async (key) => { const r = await call("decisions", { status: "all" }); return r.data.decisions.filter((d) => d.kind === "cap" && d.subject === key); };
const runnerLog = (slug) => { try { return fs.readFileSync(path.join(sysd, slug + ".log"), "utf8"); } catch (_) { return ""; } };
function gate(slug, tool) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "hooks", "gate.js"), "--cap-only"], { env: { ...process.env, JOYA_AI_CONFIG: cfgFile, JOYA_GATE_SESSION: "hired." + slug }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", () => resolve(out));
    c.stdin.end(JSON.stringify({ tool_name: tool || "Read", tool_input: { file_path: "/tmp/x" }, session_id: "x" }));
  });
}

(async () => {
  let sup = startSup();
  try {
    await until(async () => fs.existsSync(SOCK) && (await call("status").catch(() => null)), 15000);
    await until(async () => { const s = await call("status"); return s.ok && s.data.process.state === "ready"; }, 15000);

    console.log("\ncharter and status");
    const st0 = (await call("status")).data;
    check("status.process carries cwd and tz; paused_at_cap is false", st0.process.cwd === tmp && st0.process.tz === "Africa/Cairo" && st0.paused_at_cap === false);
    const ch = await call("charter");
    check("charter: the CLAUDE.md in JOYA AI's cwd, read-only", ch.ok && ch.data.path === path.join(tmp, "CLAUDE.md") && /Be careful/.test(ch.data.text) && ch.data.truncated === false, JSON.stringify(ch));

    console.log("\napproval timeout");
    const at0 = await call("approval-timeout");
    check("default: the config's (20 s)", at0.ok && at0.data.seconds === 20 && at0.data.default === 20 && at0.data.bounds[0] === 30 && at0.data.bounds[1] === 3600, JSON.stringify(at0));
    const atBad = await call("approval-timeout-set", { seconds: 10 });
    const atJoya = await call("approval-timeout-set", { seconds: 60 }, "joya-ai");
    check("  10 s refused (30..3600); JOYA AI may not change it", !atBad.ok && !atJoya.ok && /administrator/.test(atJoya.error));
    const at1 = await call("approval-timeout-set", { seconds: 45 });
    check("  set to 45 s by the administrator, recorded", at1.ok && at1.data.seconds === 45 && at1.data.updated_by === "amaraghy");
    await call("send", { text: "RUN rm -rf /tmp/joya-caps-probe" });
    const card = await until(async () => { const s = await call("status"); return s.ok && s.data.approvals.find((a) => /joya-caps-probe/.test(a.summary)); }, 8000);
    const secs = card ? (Date.parse(card.expires_at) - Date.parse(card.created_at || card.requested_at || new Date().toISOString())) / 1000 : 0;
    check("  a card now waits 45 s (expires_at), status says 45", card && secs > 40 && secs <= 46 && (await call("status")).data.approval_timeout_s === 45, JSON.stringify([card && card.expires_at, card && card.created_at, secs]));
    if (card) await call("deny", { approval_id: card.id });
    const at2 = await call("approval-timeout-set", { seconds: null });
    check("  null returns to the config's", at2.ok && at2.data.seconds === 20);

    console.log("\nhire limits");
    const hl0 = await call("hire-limits");
    check("hire-limits: 7 / 3 / auto, defaults, bounds, modes, the live count", hl0.ok && hl0.data.max_live === 7 && hl0.data.per_hour === 3 && hl0.data.perm_mode === "auto" && hl0.data.defaults.max_live === 7 && hl0.data.bounds.max_live[1] === 12 && hl0.data.modes.join() === "auto,default,plan" && hl0.data.live === 1 && hl0.data.hired === 0, JSON.stringify(hl0));
    const hlBad = await Promise.all([call("hire-limits-set", { max_live: 13 }), call("hire-limits-set", { per_hour: 11 }), call("hire-limits-set", { perm_mode: "bypassPermissions" }), call("hire-limits-set", { max_live: 5 }, "joya-ai")]);
    check("  refused: max_live 13, per_hour 11, bypassPermissions, and JOYA AI changing them", hlBad.every((r) => !r.ok) && /never allowed/.test(hlBad[2].error) && /administrator/.test(hlBad[3].error), JSON.stringify(hlBad.map((r) => r.error)));
    const hl1 = await call("hire-limits-set", { per_hour: 1, perm_mode: "plan" });
    check("  per_hour 1 and plan mode stored, by the administrator", hl1.ok && hl1.data.per_hour === 1 && hl1.data.perm_mode === "plan" && hl1.data.max_live === 7 && hl1.data.updated_by === "amaraghy", JSON.stringify(hl1));

    console.log("\ntoken caps: settings");
    const tc0 = await call("token-caps");
    check("token-caps lists JOYA AI (self) and your own session, no caps yet", tc0.ok && tc0.data.day === today && tc0.data.warn_pct === 80 && tc0.data.sessions[0].key === "<self>" && tc0.data.sessions[0].kind === "self" && tc0.data.sessions.some((s) => s.key === OWN && s.kind === "yours" && s.can_pause === false && s.state === "none"), JSON.stringify(tc0));
    const yoursPause = await call("token-caps-set", { key: OWN, cap: 1000, at: "pause" });
    check("  a pause cap on your own session is refused (warn only)", !yoursPause.ok && /only warn/.test(yoursPause.error), JSON.stringify(yoursPause));
    const joyaSets = await call("token-caps-set", { key: "<self>", cap: 1e9, at: "warn" }, "joya-ai");
    check("  JOYA AI cannot change caps", !joyaSets.ok);
    const def = await call("token-caps-set", { key: "default", cap: 1000, at: "pause" });
    const wp = await call("token-caps-set", { warn_pct: 90 });
    const bud = await call("cost");
    check("  the default cap set; warn_pct 90 written to the shared budget (cost-budget's)", def.ok && def.data.default.cap === 1000 && def.data.default.at === "pause" && wp.ok && wp.data.warn_pct === 90 && bud.data.budget.warn_pct === 90, JSON.stringify([def.data && def.data.default, bud.data && bud.data.budget]));

    console.log("\nhire at hire time");
    const h1 = await call("session-hire", { name: "Test Capped", cwd: "/root", purpose: "Count tokens for the cap test, then stay idle." }, "joya-ai");
    check("hire Test Capped", h1.ok, JSON.stringify(h1));
    const sid = h1.data.hired.session_id;
    const rec = JSON.parse(fs.readFileSync(path.join(cfg.state_dir, "sessions", "test-capped.json"), "utf8"));
    check("  its record carries the permission mode chosen in Settings (plan)", rec.permission_mode === "plan");
    await until(async () => fs.existsSync(path.join(home, "fake-argv.log")) && fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").includes("Test Capped"), 10000);
    const argv = fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((a) => a.includes("Test Capped"));
    const settingsArg = argv ? JSON.parse(argv[argv.indexOf("--settings") + 1]) : null;
    check("  its CLI runs --permission-mode plan, with the cap backstop hook on every tool", argv && argv[argv.indexOf("--permission-mode") + 1] === "plan" && settingsArg.hooks.PreToolUse.some((h) => h.matcher === "*" && /gate\.js --cap-only/.test(h.hooks[0].command)), JSON.stringify(argv));
    const h2 = await call("session-hire", { name: "Test Second", cwd: "/root", purpose: "One too many this hour." }, "joya-ai");
    check("  a second hire this hour is refused: the limit (1) is read at hire time", !h2.ok && /at most 1 hires an hour/.test(h2.error), JSON.stringify(h2));
    const capped = await until(() => capOf("test-capped"), 5000);
    check("  the new hire took the default cap (1,000, pause), kind hired, can_pause", capped && capped.cap === 1000 && capped.at === "pause" && capped.kind === "hired" && capped.can_pause === true, JSON.stringify(capped));

    console.log("\nwarn, once a day (your own session)");
    const w = await call("token-caps-set", { key: OWN, cap: 1000, at: "warn" });
    check("a warn cap on your own session", w.ok);
    addTokens(OWN, 950);
    const near = await until(async () => { const s = await capOf(OWN); return s && s.state === "near" ? s : null; }, 5000);
    check("  past the warn line (90%): near, quietly (no card)", near && near.today.total === 950 && (await capCards(OWN)).length === 0, JSON.stringify(near));
    addTokens(OWN, 500);
    const warned = await until(async () => { const c = await capCards(OWN); return c.length ? c : null; }, 6000);
    check("  past the cap: one card \"… passed its daily cap\", dismiss only", warned && warned.length === 1 && /Demo Own passed its daily cap$/.test(warned[0].title) && warned[0].actions.join() === "dismiss" && warned[0].status === "open", JSON.stringify(warned));
    addTokens(OWN, 500);
    await sleep(3000);
    const ownNow = await capOf(OWN);
    check("  raised once: still one card after more ticks; state warned, never paused", (await capCards(OWN)).length === 1 && ownNow.state === "warned" && ownNow.paused === false && ownNow.warned === true, JSON.stringify(ownNow));
    const dis = await call("decision-dismiss", { decision_id: warned[0].id });
    check("  the card is dismissed with the usual op", dis.ok && dis.data.decision.status === "dismissed");

    console.log("\na hired session paused at its cap");
    await sleep(1500); // let its runner link to the supervisor
    addTokens(sid, 2000);
    const pausedCard = await until(async () => { const c = await capCards("test-capped"); return c.find((d) => d.status === "open") || null; }, 6000);
    check("its card: \"Test Capped passed its daily cap — paused\", Resume or leave paused", pausedCard && pausedCard.title === "Test Capped passed its daily cap — paused" && pausedCard.actions.join() === "resume,dismiss" && pausedCard.cap_at === "pause", JSON.stringify(pausedCard));
    const tcp = await capOf("test-capped");
    check("  token-caps: state paused, paused true", tcp.state === "paused" && tcp.paused === true, JSON.stringify(tcp));
    const gotPause = await until(() => /budget-pause/.test(runnerLog("test-capped")), 6000);
    check("  its runner got budget-pause over its link", !!gotPause, runnerLog("test-capped").slice(-800));
    const g1 = await gate("test-capped");
    check("  the gate backstop denies its tool calls: daily token cap reached", /"permissionDecision":"deny"/.test(g1) && /daily token cap reached/.test(g1), g1);
    check("  another hired session's gate is not affected", (await gate("someone-else")) === "");
    const askCap = await call("decision-ask", { decision_id: pausedCard.id, text: "why?" });
    check("  a cap card takes no questions (no investigation turn)", !askCap.ok);
    const rsJoya = await call("budget-resume", { key: "test-capped" }, "joya-ai");
    check("  JOYA AI cannot resume it", !rsJoya.ok);
    const rs = await call("budget-resume", { decision_id: pausedCard.id });
    check("budget-resume (from the card): resumed for today", rs.ok && rs.data.resumed === "test-capped" && rs.data.was_paused === true && rs.data.session.state === "resumed" && rs.data.session.paused === false, JSON.stringify(rs));
    const gotResume = await until(() => /budget-resume/.test(runnerLog("test-capped")), 6000);
    check("  its runner got budget-resume; the gate lets it work again; the card is closed", !!gotResume && (await gate("test-capped")) === "" && (await capCards("test-capped")).every((d) => d.status === "done"));
    addTokens(sid, 1000);
    await sleep(2500);
    check("  not paused again the same day", (await capOf("test-capped")).paused === false && (await capCards("test-capped")).length === 1);

    console.log("\nJOYA AI paused at its cap");
    const selfNow = (await capOf("<self>")).today.total;
    const sc = await call("token-caps-set", { key: "<self>", cap: selfNow + 1, at: "pause" });
    check("a pause cap on JOYA AI just above today's use", sc.ok);
    const t1 = await call("send", { text: "first turn" });
    const t1done = await until(async () => { const r = await call("ledger", { table: "turns", limit: 20 }); const row = r.data.rows.find((x) => x.id === t1.data.turn.id); return row && row.status === "done" ? row : null; }, 8000);
    const selfPausedNow = await until(async () => { const s = await call("status"); return s.data.paused_at_cap ? s.data : null; }, 5000);
    check("  its turn ran and finished; then it is paused (status.paused_at_cap)", !!t1done && !!selfPausedNow);
    const selfCard = (await capCards("<self>"))[0];
    check("  its card reads \"… passed its daily cap — paused\"", selfCard && /passed its daily cap — paused$/.test(selfCard.title) && selfCard.actions.join() === "resume,dismiss", JSON.stringify(selfCard));
    const t2 = await call("send", { text: "second turn" });
    await sleep(2500);
    const q = (await call("status")).data;
    check("  a new turn is held in the queue (the administrator's own too)", q.queued.some((x) => x.id === t2.data.turn.id) && !q.busy, JSON.stringify(q.queued));
    const rs2 = await call("budget-resume", { key: "<self>" });
    const t2done = await until(async () => { const r = await call("ledger", { table: "turns", limit: 20 }); const row = r.data.rows.find((x) => x.id === t2.data.turn.id); return row && row.status === "done" ? row : null; }, 8000);
    check("budget-resume releases it: the held turn runs", rs2.ok && !!t2done && (await call("status")).data.paused_at_cap === false);

    console.log("\nthe day turns");
    await call("token-caps-set", { key: "test-capped", cap: null });
    {
      const d = db();
      try {
        const t = new Date().toISOString();
        d.prepare("UPDATE settings SET value = ? WHERE key = 'token_caps_state'").run(JSON.stringify({ day: "2000-01-01", sessions: { "<self>": { paused_at: t }, "test-capped": { paused_at: t }, [OWN]: { warned_at: t } }, held: [{ at: t, source: "peer", from: "Peer X", text: "held hello" }] }));
        d.prepare("INSERT INTO decisions (kind, subject, title, detail, status, count, first_seen, last_seen, created_at, updated_at, cap_at, cap_day) VALUES ('cap', 'test-capped', 'Test Capped passed its daily cap — paused', 'x', 'open', 1, ?, ?, ?, ?, 'pause', '2000-01-01')").run(t, t, t, t);
      } finally {
        d.close();
      }
    }
    const turned = await until(async () => { const r = await call("token-caps"); return r.ok && r.data.sessions.every((s) => !s.paused && !s.warned && !s.resumed) ? r.data : null; }, 6000);
    check("yesterday's record is cleared at the next check point (paused / warned / resumed)", !!turned && turned.day === today, JSON.stringify(turned && turned.sessions));
    const heldTurn = await until(async () => { const r = await call("ledger", { table: "turns", limit: 20 }); return r.data.rows.find((x) => x.source === "cap-held" && /held hello/.test(x.text)) || null; }, 6000);
    check("  JOYA AI's held message goes back in the queue", !!heldTurn, JSON.stringify(heldTurn));
    const resumed = await until(() => /budget-resume to "Test Capped" \(the day turned\)/.test(sup.logs), 6000);
    check("  the hired session paused yesterday gets budget-resume; yesterday's card is closed", !!resumed && (await capCards("test-capped")).every((d) => d.status !== "open"));
    const ownAgain = await until(async () => { const c = await capCards(OWN); return c.filter((d) => d.status === "open").length === 1 ? c : null; }, 6000);
    check("  a session still over its cap today gets today's card again (once)", !!ownAgain);

    console.log("\nthe page map");
    const pages = [
      { key: "cc", parent: null, kind: "page", label: "Command Center", url: "/joya-ai", perm: "joyaai.use" },
      { key: "settings.voice", parent: "cc", kind: "section", label: "Settings › Voice", url: "/joya-ai/settings/voice", perm: null },
    ];
    const bad = await Promise.all([
      call("ui-pages", { pages: [{ key: "Bad Key", kind: "page", label: "x", url: "/x" }] }),
      call("ui-pages", { pages: [{ key: "x", kind: "page", label: "x", url: "https://evil.example" }] }),
      call("ui-pages", { pages: [{ key: "x", kind: "page", label: "x", url: "//evil.example" }] }),
      call("ui-pages", { pages: [pages[0], pages[0]] }),
      call("ui-pages", { pages: Array.from({ length: 501 }, (_, i) => ({ key: "k" + i, kind: "page", label: "k", url: "/k" })) }),
      call("ui-pages", { pages }, "joya-ai"),
    ]);
    check("refused: a bad key, an absolute or protocol-relative url, a duplicate key, 501 entries, JOYA AI itself", bad.every((r) => !r.ok), JSON.stringify(bad.map((r) => r.error)));
    const up = await call("ui-pages", { pages });
    const hasSet = typeof UiActions.setPages === "function";
    check("stored (and applied when ui-actions has setPages)", up.ok && up.data.count === 2 && up.data.stored === true && up.data.applied === hasSet && up.data.updated_by === "amaraghy", JSON.stringify(up));
    const rd = await call("ui-pages");
    check("  read back as sent", rd.ok && JSON.stringify(rd.data.pages) === JSON.stringify(pages));
    const audits = (await call("ledger", { table: "audit", limit: 50 })).data.rows.filter((r) => r.op === "ui-pages" && r.ok);
    check("  the audit line counts the pages instead of copying them; a read is not audited", audits.length === 1 && /\(2 pages\)/.test(audits[0].detail), JSON.stringify(audits));

    console.log("\na supervisor restart");
    sup.kill("SIGTERM");
    await until(async () => !alive(sup.pid), 10000);
    sup = startSup();
    await until(async () => fs.existsSync(SOCK) && (await call("status").catch(() => null)), 15000);
    await sleep(500);
    check("the page map is re-applied on start", hasSet ? /2 entries re-applied/.test(sup.logs) : /2 entries stored, not applied/.test(sup.logs), sup.logs.slice(-1500));
    const hlR = await call("hire-limits");
    const tcR = await call("token-caps");
    check("  hire limits, caps and today's cap state survive it", hlR.data.per_hour === 1 && hlR.data.perm_mode === "plan" && tcR.data.default.cap === 1000 && tcR.data.sessions.find((s) => s.key === OWN).warned === true);
    const reset = await call("hire-limits-set", { per_hour: null, perm_mode: null });
    check("  null returns a hire limit to its default", reset.ok && reset.data.per_hour === 3 && reset.data.perm_mode === "auto");
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + sup.logs.slice(-2500));
  } finally {
    for (const f of fs.existsSync(sysd) ? fs.readdirSync(sysd) : []) {
      if (!f.endsWith(".pid")) continue;
      const pid = Number(fs.readFileSync(path.join(sysd, f), "utf8"));
      if (alive(pid)) try { process.kill(pid, "SIGTERM"); } catch (_) { /* gone */ }
    }
    await sleep(800);
    sup.kill("SIGTERM");
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
