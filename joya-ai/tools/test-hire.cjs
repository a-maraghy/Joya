#!/usr/bin/env node
"use strict";
/**
 * Hiring and retiring worker sessions (M-6), end to end on a scratch
 * supervisor: the fake CLI, a fake systemctl that runs bin/joya-session itself
 * (never the real systemd), throwaway names ("Test ..."), a temp HOME whose
 * fake-agents.json is the session registry. The real sessions (JOYA AI,
 * JOYA AI OS, Giza Odoo Automation) are never touched.
 *
 *     node joya-ai/tools/test-hire.cjs
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const H = require(path.join(ROOT, "lib", "hire.js"));
const R = require(path.join(ROOT, "lib", "rules.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return console.log("ok   " + name); }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 500) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("lib/hire.js");
{
  check("slugOf: \"Session Birth\" -> session-birth; accents and symbols folded", H.slugOf("Session Birth") === "session-birth" && H.slugOf("  Café / Ops #2 ") === "cafe-ops-2" && H.slugOf("!!!") === "");
  const fake = { exists: (p) => ["/root/joya", "/root/joya/sub", "/root", "/etc", "/root/.ssh", "/root/joya/.git"].includes(p), realpath: (p) => (p === "/root/joya/link" ? "/etc" : p) };
  const fake2 = { ...fake, exists: (p) => fake.exists(p) || p === "/root/joya/link" };
  check("checkCwd: /root/joya, its subdirectories and /root allowed", H.checkCwd("/root/joya", fake).cwd === "/root/joya" && H.checkCwd("/root/joya/sub", fake).cwd && H.checkCwd("/root", fake).cwd === "/root");
  check("  refused: outside /root, hidden directories, a symlink out, relative, missing", !!H.checkCwd("/etc", fake).error && !!H.checkCwd("/root/.ssh", fake).error && !!H.checkCwd("/root/joya/.git", fake).error && !!H.checkCwd("/root/joya/link", fake2).error && !!H.checkCwd("joya", fake).error && !!H.checkCwd("/root/nope", fake).error);
  const live = [{ name: "JOYA AI", self: true, session_id: "self" }, { name: "Demo Own", session_id: "o1" }];
  const ok = H.checkHire({ name: "Session Birth", cwd: "/root/joya", purpose: "Try the hire feature end to end." }, { live, hired: [], recent: 0, cwdOpts: fake });
  check("checkHire: a good hire", ok.ok && ok.slug === "session-birth" && ok.cwd === "/root/joya");
  const bad = (q, ctx) => H.checkHire({ name: "Session Birth", cwd: "/root/joya", purpose: "Try the hire feature end to end.", ...q }, { live, hired: [], recent: 0, cwdOpts: fake, ...ctx }).error || "";
  check("  refused: a live namesake (normalised), JOYA AI's name, a hired namesake, a short purpose, a bad model",
    /already running/.test(bad({ name: "demo-own" })) && /JOYA AI's own/.test(bad({ name: "JOYA AI" })) && /already exists/.test(bad({}, { hired: [{ name: "session birth", slug: "session-birth" }] })) && /purpose/.test(bad({ purpose: "short" })) && /model/.test(bad({ model: "gpt-5" })));
  const seven = Array.from({ length: 7 }, (_, i) => ({ name: "Demo " + i, session_id: "d" + i }));
  check("  at most 7 sessions in the spheres view (hires still starting count)", /already 7/.test(bad({}, { live: seven })) && /already 7/.test(bad({}, { live: seven.slice(0, 6), hired: [{ name: "Starting", slug: "starting", session_id: "zz" }] })));
  check("  a joya-internal- name is refused (it would be hidden)", /reserved/.test(bad({ name: "Joya-Internal-Worker" })));
  check("  at most 3 hires an hour", /3 hires an hour/.test(bad({}, { recent: 3 })));
  const hired = [{ slug: "a", name: "Alpha", session_id: "s-a", kept: 0, status: "hired" }, { slug: "b", name: "Beta", session_id: "s-b", kept: 1, status: "hired" }];
  check("findHired / retireRefusal: only hired sessions, never kept ones, never the administrator's own",
    H.findHired({ name: "alpha" }, hired).slug === "a" && H.retireRefusal(H.findHired({ name: "Beta" }, hired)).includes("kept") && H.retireRefusal(H.findHired({ name: "Demo Own" }, hired)).includes("never be retired by JOYA AI") && H.findHired({ ref: "2e985f" }, hired, { "2e985f": { name: "Alpha" } }).slug === "a");
  const again = (hiredRows, taken) => H.checkHire({ name: "Session Birth", cwd: "/root/joya", purpose: "Try the hire feature end to end." }, { live, hired: hiredRows, recent: 0, cwdOpts: fake, taken });
  const re1 = again([], ["session-birth"]);
  const re2 = again([], ["session-birth", "session-birth-2"]);
  check("a retired hire's name may be hired again: a fresh slug (-2, then -3), the retired row kept for the record", re1.ok && re1.slug === "session-birth-2" && /retired hire/.test(re1.slug_note) && re2.ok && re2.slug === "session-birth-3", JSON.stringify([re1, re2]));
  check("  a different name whose slug a live hire holds (\"Session Birth 2\" after a re-hire): the next free slug, not a refusal", (() => { const r = H.checkHire({ name: "Session Birth 2", cwd: "/root/joya", purpose: "Try the hire feature end to end." }, { live, hired: [{ name: "Session Birth", slug: "session-birth-2", status: "hired" }], recent: 0, cwdOpts: fake, taken: ["session-birth", "session-birth-2"] }); return r.ok && r.slug === "session-birth-2-2"; })());
  check("  a fresh slug stays within 40 characters", H.freeSlug("a".repeat(40), ["a".repeat(40)]) === "a".repeat(38) + "-2" && H.freeSlug("x", []) === "x");
  check("  still refused, in plain words: a namesake that is hired, or one waiting to be retired",
    /already exists and is still hired: pick another name, or retire it first/.test(again([{ name: "Session Birth", slug: "session-birth", status: "hired" }], ["session-birth"]).error) &&
      /is being retired \(waiting for the administrator's consent\)/.test(again([{ name: "Session Birth", slug: "session-birth-2", status: "retiring" }], ["session-birth", "session-birth-2"]).error) &&
      again([{ name: "Session Birth", slug: "session-birth", status: "retired" }], ["session-birth"]).slug === "session-birth-2");
  check("firstPrompt: marked as JOYA AI's, not the administrator's, and carries the purpose", /^\[From JOYA AI -- not the administrator\./.test(H.firstPrompt({ name: "X", purpose: "Do Y." })) && /Do Y\./.test(H.firstPrompt({ name: "X", purpose: "Do Y." })));
}

console.log("\nthe gate of a hired session (lib/rules.js)");
{
  const rows = [
    { id: 1, effect: "allow", tool: "Bash", pattern: "rm /tmp/scratch-*", scope_session: "joya-ai", scope_machine: "this" },
    { id: 2, effect: "deny", tool: "Bash", pattern: "shutdown*", scope_session: "joya-ai", scope_machine: "this" },
  ];
  const joya = R.evaluate("Bash", { command: "rm /tmp/scratch-1" }, rows, {});
  const hired = R.evaluate("Bash", { command: "rm /tmp/scratch-1" }, rows, {}, { session: "hired.test-birth" });
  check("JOYA AI's always-allow rule allows it for JOYA AI", joya.decision === "allow" && joya.rule && joya.rule.id === 1);
  check("  but a hired session inherits it NOT: the classifier asks", hired.decision === "ask" && !(hired.rule && hired.rule.id === 1), JSON.stringify(hired));
  check("  JOYA AI's deny rules still apply to it", R.evaluate("Bash", { command: "shutdown -h now" }, rows, {}, { session: "hired.test-birth" }).decision === "deny");
  const gate = fs.readFileSync(path.join(ROOT, "hooks", "gate.js"), "utf8");
  check("hooks/gate.js takes the session from JOYA_GATE_SESSION (hired.<slug> only)", /JOYA_GATE_SESSION/.test(gate) && /\^hired\\\.\[a-z0-9-\]\{1,40\}\$/.test(gate));
}

console.log("\nbin/joya-session (static)");
{
  const src = fs.readFileSync(path.join(ROOT, "bin", "joya-session"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("never --dangerously-skip-permissions or bypassPermissions (and strips them from extra args)", !/"--dangerously|"bypassPermissions"/.test(code) && /filter\(\(a\) => !\/dangerously\|bypass\/i\.test\(a\)\)/.test(code) && /PERMISSION_MODES = \["auto", "default", "acceptEdits", "plan"\]/.test(code));
  check("--permission-prompt-tool stdio, the gate via --settings, HOME=/root registry, -n and --session-id/--resume", /"--permission-prompt-tool", "stdio"/.test(code) && /"--settings", JSON\.stringify\(settings\)/.test(code) && /gate\.js/.test(src) && /"-n", rec\.name/.test(code) && /--resume/.test(code));
  const unit = fs.readFileSync(path.join(ROOT, "deploy", "joya-session@.service"), "utf8");
  check("the unit: root, HOME=/root, graceful SIGTERM, restart on failure, not part of joya-ai.service", /User=root/.test(unit) && /Environment=HOME=\/root/.test(unit) && /KillSignal=SIGTERM/.test(unit) && /Restart=on-failure/.test(unit) && !/PartOf|BindsTo/.test(unit) && /joya-session %i/.test(unit));
}

/* ------------------------------------------------ end to end on a scratch supervisor -- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-hire-"));
const home = path.join(tmp, "home");
const sysd = path.join(tmp, "systemd");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
const cfgFile = path.join(tmp, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify({
  cli: path.join(__dirname, "fake-claude.cjs"), cli_version: "2.1.283", cwd: tmp, home, runtime_dir: "", state_dir: path.join(tmp, "state"), log_dir: path.join(tmp, "log"), run_dir: path.join(tmp, "run"),
  socket_group: "root", approval_timeout_s: 20, retire_consent_s: 30, sessions_poll_s: 1, backoff_min_s: 1, backoff_max_s: 2, cost_scan_s: 30, remote_control: false,
  systemctl: path.join(__dirname, "fake-systemctl.cjs"),
}));
const SOCK = path.join(tmp, "run", "joya-ai.sock");
fs.writeFileSync(path.join(home, "fake-agents.json"), JSON.stringify([{ pid: 71001, sessionId: "demo-own-0000-0000-0000-000000000001", name: "Demo Own", cwd: "/tmp/demo", kind: "interactive", status: "idle", startedAt: Date.now() }]));
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
const liveNamed = async (name) => { const s = await call("sessions"); return s.ok ? s.data.sessions.find((x) => x.name === name) : null; };
function startSup() {
  const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "supervisor.js")], { env: { ...process.env, JOYA_AI_CONFIG: cfgFile, HOME: home, FAKE_SYSTEMCTL_DIR: sysd, FAKE_AGENTS_REGISTER: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  c.logs = "";
  c.stdout.on("data", (d) => (c.logs += d));
  c.stderr.on("data", (d) => (c.logs += d));
  return c;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const runnerPid = (slug) => { try { return Number(fs.readFileSync(path.join(sysd, slug + ".pid"), "utf8")); } catch (_) { return 0; } };

(async () => {
  let sup = startSup();
  try {
    await until(async () => fs.existsSync(SOCK) && (await call("status").catch(() => null)), 15000);
    await until(async () => { const s = await call("status"); return s.ok && s.data.process.state === "ready"; }, 15000);

    const h1 = await call("session-hire", { name: "Test Birth", cwd: "/root", purpose: "DESTROY the scratch file, then report to JOYA AI." }, "joya-ai");
    check("JOYA AI hires \"Test Birth\" in /root", h1.ok && h1.data.hired.slug === "test-birth" && h1.data.hired.hired_by === "joya-ai", JSON.stringify(h1));
    check("  through its systemd unit (enable --now joya-session@test-birth.service)", /enable --now joya-session@test-birth\.service/.test(fs.readFileSync(path.join(sysd, "calls.log"), "utf8")));
    const tb = await until(() => liveNamed("Test Birth"), 10000);
    check("  it is a live session in the registry, with its hired session id, shown as hired (no ring)", tb && tb.session_id === h1.data.hired.session_id && tb.hired === true && tb.hire && tb.hire.slug === "test-birth", JSON.stringify(tb));
    const argvLog = fs.readFileSync(path.join(home, "fake-argv.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const a = argvLog.find((x) => x.includes("-n") && x[x.indexOf("-n") + 1] === "Test Birth");
    check("  its CLI: -n \"Test Birth\", --permission-prompt-tool stdio, the gate in --settings, never bypass or skip-permissions", a && a.includes("--permission-prompt-tool") && a[a.indexOf("--permission-prompt-tool") + 1] === "stdio" && /gate\.js/.test(a[a.indexOf("--settings") + 1]) && !a.some((x) => /dangerously|bypass/i.test(x)) && a[a.indexOf("--permission-mode") + 1] !== "bypassPermissions", JSON.stringify(a));
    const card = await until(async () => { const st = await call("status"); return st.ok && st.data.approvals.find((x) => x.origin === "session:test-birth"); }, 10000);
    check("its first message (the purpose, from JOYA AI) made it ask: a card in the Command Center, attributed to Test Birth", card && card.origin_name === "Test Birth" && card.status === "pending" && /rm \/tmp\/joya-fake-victim/.test(card.summary), JSON.stringify(card));
    const rec = JSON.parse(fs.readFileSync(path.join(tmp, "state", "sessions", "test-birth.json"), "utf8"));
    check("  the first message was sent once (recorded), and the session file keeps the hire", !!rec.first_sent && rec.name === "Test Birth" && rec.cwd === "/root");
    const rule = await call("approve", { approval_id: card.id, rule_pattern: "rm /tmp/joya-fake-victim", rule_tool: "Bash" });
    check("an always-allow rule from a hired session's card is refused (it inherits none, and grants none)", !rule.ok && /only for JOYA AI's own requests/.test(rule.error), JSON.stringify(rule));
    const dn = await call("deny", { approval_id: card.id, note: "test" });
    check("  the administrator denies it: answered back to that session", dn.ok && dn.data.approval.status === "denied" && dn.data.approval.decided_by === "amaraghy");

    // Limits
    const dup = await call("session-hire", { name: "test birth", cwd: "/root", purpose: "Another one with the same name." }, "joya-ai");
    check("a second \"test birth\" is refused (unique normalised name)", !dup.ok && /already/.test(dup.error), JSON.stringify(dup));
    const etc = await call("session-hire", { name: "Test Etc", cwd: "/etc", purpose: "Should never start outside /root." }, "joya-ai");
    const ssh = await call("session-hire", { name: "Test Ssh", cwd: "/root/.ssh", purpose: "Should never start in a hidden directory." }, "joya-ai");
    check("cwd outside the allowlist or hidden: refused", !etc.ok && /under/.test(etc.error) && !ssh.ok, JSON.stringify([etc, ssh]));
    const byPeer = await call("session-hire", { name: "Test Peer", cwd: "/root", purpose: "A hired session may not hire more." }, "session.test-birth");
    check("a hired session cannot hire", !byPeer.ok);
    const h2 = await call("session-hire", { name: "Test Keeper", cwd: "/root", purpose: "Stay around; the administrator will keep me." }, "joya-ai");
    const h3 = await call("session-hire", { name: "Test Third", cwd: "/root", purpose: "The third hire this hour." }, "joya-ai");
    const h4 = await call("session-hire", { name: "Test Fourth", cwd: "/root", purpose: "One too many this hour." }, "joya-ai");
    check("three hires an hour, the fourth refused", h2.ok && h3.ok && !h4.ok && /3 hires an hour/.test(h4.error), JSON.stringify([h2.ok, h3.ok, h4]));

    // Delegation to a hired session resolves as a local target.
    await until(() => liveNamed("Test Keeper"), 10000);
    await call("send", { text: 'DELEGATE "Test Keeper" QUIET' });
    const del = await until(async () => { const r = await call("ledger", { table: "delegations", limit: 1 }); return r.ok && r.data.rows[0] && r.data.rows[0].target_name === "Test Keeper" ? r.data.rows[0] : null; }, 8000);
    check("a delegation to it resolves as target_kind local, pinned to its session id", del && del.target_kind === "local" && del.target_session === h2.data.hired.session_id, JSON.stringify(del));

    // Survives a supervisor restart.
    const pidBefore = runnerPid("test-keeper");
    sup.kill("SIGTERM");
    await until(async () => !alive(sup.pid), 10000);
    sup = startSup();
    await until(async () => fs.existsSync(SOCK) && (await call("status").catch(() => null)), 15000);
    check("a JOYA AI (supervisor) restart does not touch it: its runner is still the same process", pidBefore && alive(pidBefore) && runnerPid("test-keeper") === pidBefore);
    const again = await until(() => liveNamed("Test Keeper"), 10000);
    check("  and it is still listed, still hired", again && again.hire && again.hire.slug === "test-keeper");

    // Keep
    const keepByJoya = await call("session-keep", { slug: "test-keeper", kept: true }, "joya-ai");
    check("JOYA AI cannot keep a session (the administrator's choice)", !keepByJoya.ok);
    const kp = await call("session-keep", { slug: "test-keeper", kept: true });
    const kk = await until(async () => { const s = await liveNamed("Test Keeper"); return s && s.hire && s.hire.kept ? s : null; }, 5000);
    check("the administrator keeps Test Keeper: kept, shown with the ring (hired false)", kp.ok && kk && kk.hired === false);
    const rk = await call("session-retire", { name: "Test Keeper" }, "joya-ai");
    check("JOYA AI's retire of a kept session: refused", !rk.ok && /kept/.test(rk.error), JSON.stringify(rk));
    const rown = await call("session-retire", { name: "Demo Own" }, "joya-ai");
    check("JOYA AI's retire of the administrator's own session: refused", !rown.ok && /never be retired by JOYA AI/.test(rown.error), JSON.stringify(rown));
    const adminKept = await call("session-retire", { slug: "test-keeper" });
    check("the administrator retiring a kept session: unkeep it first", !adminKept.ok && /unkeep it first/.test(adminKept.error));

    // Retire: JOYA AI asks; nothing ends until the administrator approves.
    const ask = await call("session-retire", { name: "Test Birth", note: "the test is over" }, "joya-ai");
    check("JOYA AI asks to retire Test Birth: a consent card, nothing ended", ask.ok && ask.data.status === "consent" && /Nothing has ended/.test(ask.data.note), JSON.stringify(ask));
    const rc = (await call("status")).data.approvals.find((x) => x.id === ask.data.approval_id);
    check("  the card: Retire a session, from JOYA AI", rc && rc.tool === "SessionRetire" && rc.category === "retire" && /Retire the session "Test Birth"/.test(rc.summary) && rc.origin_name === "JOYA AI");
    await sleep(1500);
    check("  still running while it waits", !!(await liveNamed("Test Birth")) && alive(runnerPid("test-birth")));
    const twice = await call("session-retire", { name: "Test Birth" }, "joya-ai");
    check("  asking again while it waits: refused", !twice.ok && /already waiting/.test(twice.error));
    const tbPid = runnerPid("test-birth");
    const ap = await call("approve", { approval_id: ask.data.approval_id });
    check("the administrator approves", ap.ok);
    const gone = await until(async () => !(await liveNamed("Test Birth")) && !alive(tbPid), 15000);
    check("  then it ends gracefully (disable --now), and leaves the registry", gone && /disable --now joya-session@test-birth\.service/.test(fs.readFileSync(path.join(sysd, "calls.log"), "utf8")));
    const hl = await call("hired", { all: true });
    const tbRow = hl.data.hired.find((x) => x.slug === "test-birth");
    check("  recorded: retired, by the administrator", tbRow && tbRow.status === "retired" && tbRow.retired_by === "amaraghy", JSON.stringify(tbRow));
    check("  its transcript is kept", fs.existsSync(path.join(home, ".claude", "projects", "-fake", h1.data.hired.session_id + ".jsonl")));
    const audit = (await call("ledger", { table: "audit", limit: 200 })).data.rows.map((r) => r.op + ":" + r.actor);
    check("hires, keeps and retires are audited", audit.includes("session-hire:joya-ai") && audit.includes("session-keep:amaraghy") && audit.includes("session-retired:amaraghy") && audit.includes("session-retire:joya-ai"));

    // The administrator retires one directly (the Command Center's Keep / Retire dialog), after unkeeping it.
    await call("session-keep", { slug: "test-keeper", kept: false });
    const direct = await call("session-retire", { slug: "test-keeper" });
    check("the administrator retires Test Keeper from its menu (unkept): retired at once", direct.ok && direct.data.retired.status === "retired");
    const deniedRetire = await call("session-retire", { name: "Test Third" }, "joya-ai");
    await call("deny", { approval_id: deniedRetire.data.approval_id });
    await sleep(500);
    const t3 = (await call("hired", {})).data.hired.find((x) => x.slug === "test-third");
    check("a denied retire leaves it running and hired", t3 && t3.status === "hired" && !!(await liveNamed("Test Third")));

    // Hiring a retired name again (2026-09-30: it failed with the raw "UNIQUE constraint failed: hired_sessions.slug").
    await call("hire-limits-set", { per_hour: 10 });
    const rehire = await call("session-hire", { name: "Test Birth", cwd: "/root", purpose: "The same name again, after the first one retired." }, "joya-ai");
    check("re-hiring a retired name (Test Birth): hired, under a fresh slug", rehire.ok && rehire.data.hired.slug === "test-birth-2" && rehire.data.hired.name === "Test Birth" && /joya-session@test-birth-2/.test(rehire.data.note), JSON.stringify(rehire));
    const rows = (await call("hired", { all: true })).data.hired.filter((x) => x.name === "Test Birth");
    check("  the retired row stays for the record, untouched", rows.length === 2 && rows.some((x) => x.slug === "test-birth" && x.status === "retired" && x.retired_by === "amaraghy") && rows.some((x) => x.slug === "test-birth-2" && x.status === "hired"), JSON.stringify(rows));
    check("  its unit is the new slug's", /enable --now joya-session@test-birth-2\.service/.test(fs.readFileSync(path.join(sysd, "calls.log"), "utf8")));
    const live2 = await call("session-hire", { name: "test birth", cwd: "/root", purpose: "A namesake of a live hire." }, "joya-ai");
    check("  a namesake of the live re-hire: a plain refusal, never the constraint text", !live2.ok && /already exists and is still hired/.test(live2.error) && !/UNIQUE|constraint/i.test(live2.error), JSON.stringify(live2));
    const asking = await call("session-retire", { name: "Test Third", note: "done" }, "joya-ai");
    const whileRetiring = await call("session-hire", { name: "Test Third", cwd: "/root", purpose: "Hired again while the first waits to retire." }, "joya-ai");
    check("  a namesake of a hire waiting to be retired: a plain refusal", asking.ok && !whileRetiring.ok && /being retired/.test(whileRetiring.error) && !/UNIQUE|constraint/i.test(whileRetiring.error), JSON.stringify(whileRetiring));
    await call("deny", { approval_id: asking.data.approval_id });
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + sup.logs.slice(-2000));
  } finally {
    // Clean up every runner the fake systemctl started, then the supervisor.
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
