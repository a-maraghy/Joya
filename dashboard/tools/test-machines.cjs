#!/usr/bin/env node
"use strict";
/**
 * Joya > Computers (lib/machines.js, lib/routes-machines.js): pairing, the
 * link, the control lease (expiry, extend, stop), the relay of the laptop's
 * questions to the supervisor (gate routing), the action log and its
 * retention. Part 1 drives the library with an in-memory database, a fake
 * supervisor and fake sockets; part 2 boots a scratch server (no helper, temp
 * data) with a fake supervisor socket and a real WebSocket from "the app".
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-machines.cjs
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");
const WebSocket = require("ws");
const M = require(path.join(ROOT, "lib", "machines.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

/** A fake WebSocket for the library: records what it is sent. */
function fakeWs() {
  const handlers = {};
  return {
    readyState: 1,
    sent: [],
    send(s) {
      this.sent.push(JSON.parse(s));
    },
    on(ev, fn) {
      handlers[ev] = fn;
    },
    emit(ev, ...a) {
      handlers[ev] && handlers[ev](...a);
    },
    close() {
      this.readyState = 3;
      this.emit("close");
    },
    ping() {},
    terminate() {
      this.close();
    },
    last(t) {
      return [...this.sent].reverse().find((m) => m.t === t);
    },
  };
}

async function part1() {
  console.log("lib/machines.js");
  let clock = Date.parse("2026-10-08T10:00:00Z");
  const calls = [];
  let askAnswer = { behavior: "allow", auto: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machines-shots-"));
  const mdb = new Database(":memory:");
  const lib = M.create({
    db: mdb,
    dir,
    now: () => clock,
    log: () => {},
    redact: (s) => s.replace(/sk-[A-Za-z0-9]{10,}/g, "[redacted]"),
    call: async (op, params, actor) => {
      calls.push({ op, params, actor });
      if (op === "machine-ask") return askAnswer;
      return { ok: true };
    },
    subscribe: null,
  });
  const callsOf = (op) => calls.filter((c) => c.op === op);

  // Codes
  check("codes: 8 Crockford characters; normalised from ABCD-EFGH, lower case, O->0, I/L->1", /^[0-9A-HJKMNP-TV-Z]{8}$/.test(M.newCode()) && M.normCode("abcd-efgh") === "ABCDEFGH" && M.normCode("O1LI 2345") === "01112345" && M.normCode("short") === null && M.normCode("ABCDEFGU") === null);
  const c1 = lib.issueCode(1, "amaraghy");
  check("issueCode: shown ABCD-EFGH, 10 minutes", /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c1.code) && c1.minutes === 10);
  const c2 = lib.issueCode(1, "amaraghy");
  check("  a new code withdraws the person's earlier one", lib.claim({ code: c1.code }).status === 404);
  const bad = lib.claim({ code: "abc-12" });
  check("claim: not a code -> 400; unknown -> 404", bad.status === 400 && lib.claim({ code: "ZZZZ-ZZZZ" }).status === 404);
  const ok = lib.claim({ code: c2.code.toLowerCase(), name: "Ahmed's Laptop!!", platform: "windows", app_version: "0.1.5" });
  check("claim: a good code -> machine id, cleaned name, an mmt_ token", ok.status === 200 && ok.machine_id === 1 && ok.name === "Ahmed's Laptop" && M.TOKEN_RE.test(ok.token), JSON.stringify(ok));
  check("  single use: the same code again -> 404", lib.claim({ code: c2.code }).status === 404);
  const c3 = lib.issueCode(2, "other");
  clock += 11 * 60 * 1000;
  check("  an expired code -> 410", lib.claim({ code: c3.code }).status === 410);
  const db2 = lib.list();
  check("only the token's hash is stored (no token in the row)", db2.length === 1 && !JSON.stringify(db2).includes(ok.token));

  // Authentication
  const auth = (t) => lib.authenticate({ headers: { authorization: t } });
  check("authenticate: Bearer <token> -> the machine; anything else -> null", auth("Bearer " + ok.token).id === 1 && auth(ok.token) === null && auth("Bearer mmt_" + "A".repeat(43)) === null && auth("") === null);

  // The link
  const ws = fakeWs();
  lib.connected(ws, auth("Bearer " + ok.token));
  check("connected: welcome, online", ws.last("welcome") && ws.last("welcome").machine_id === 1 && lib.list()[0].online === true);
  await lib.onMessage(1, { t: "hello", app_version: "0.1.5", platform: "windows", host: "AHMED-PC", user: "Ahmed", home: "C:\\Users\\Ahmed", claude: { path: "C:\\Users\\Ahmed\\.local\\bin\\claude.exe", version: "2.1.290", git_bash: false } });
  await lib.sync();
  const sync = callsOf("machines-sync").pop();
  check("hello: host, Claude Code; machines-sync carries online and home (actor machines)", lib.list()[0].claude.version === "2.1.290" && sync.actor === "machines" && sync.params.machines[0].online === true && sync.params.machines[0].home === "C:\\Users\\Ahmed", JSON.stringify(sync));

  // No lease: the laptop's questions are denied here, before the supervisor.
  await lib.onMessage(1, { t: "ask", rid: "q0", slug: "pc-ahmed", tool: "PowerShell", input: { command: "dir" } });
  check("ask without a lease: denied here, never relayed", ws.last("answer").rid === "q0" && ws.last("answer").behavior === "deny" && callsOf("machine-ask").length === 0);

  // A take-over (the supervisor's start event) starts a lease of N minutes.
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed", name: "Ahmed's Laptop control", purpose: "Make a budget sheet in Excel.", minutes: 15, first_prompt: "[From JOYA AI] ...", by: "joya-ai" });
  const st = ws.last("start");
  check("start event -> the app gets start with the lease (id, minutes, expires_at)", st && st.slug === "pc-ahmed" && st.lease.minutes === 15 && Date.parse(st.lease.expires_at) - clock === 15 * 60000 && st.first_prompt, JSON.stringify(st));
  check("  the panel shows the lease", lib.list()[0].lease && lib.list()[0].lease.slug === "pc-ahmed");
  await lib.onMessage(1, { t: "lease", lease_id: st.lease.id, state: "active", expires_at: st.lease.expires_at }); // the app took it
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-other", name: "x", purpose: "Another job on it.", minutes: 15 });
  check("  a second start while under control: failed to the supervisor", callsOf("machine-state").some((c) => c.params.slug === "pc-other" && c.params.state === "failed" && /already under control/.test(c.params.reason)));
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 9, slug: "pc-nine", name: "x", purpose: "A job on nothing.", minutes: 15 });
  check("  a start for an unknown computer: failed", callsOf("machine-state").some((c) => c.params.slug === "pc-nine" && c.params.state === "failed"));

  // Gate routing: questions go to the supervisor as machine.<id>; its answer comes back.
  await lib.onMessage(1, { t: "ask", rid: "q1", slug: "pc-ahmed", tool: "PowerShell", input: { command: "Get-ChildItem" }, origin: "cli", tool_use_id: "toolu_1" });
  const ask = callsOf("machine-ask").pop();
  check("ask under the lease: relayed as machine-ask, actor machine.1, input JSON, origin", ask && ask.actor === "machine.1" && ask.params.slug === "pc-ahmed" && JSON.parse(ask.params.input).command === "Get-ChildItem" && ask.params.origin === "cli" && ask.params.tool_use_id === "toolu_1");
  check("  the supervisor's allow reaches the app, marked auto (its rules let it run, no card)", ws.last("answer").rid === "q1" && ws.last("answer").behavior === "allow" && ws.last("answer").auto === true);
  // A browser step (0.1.11): the app's hint goes to the supervisor as JSON text; an allow after a card is not auto.
  askAnswer = { behavior: "allow" };
  await lib.onMessage(1, { t: "ask", rid: "qb", slug: "pc-ahmed", tool: "mcp__claude-in-chrome__computer", input: { action: "left_click", ref: "ref_12", tabId: 3 }, origin: "cli", hint: { targets: [{ ref: "ref_12", label: 'button "Send"' }], tab_urls: ["https://mail.google.com/"] } });
  const askB = callsOf("machine-ask").pop();
  check("  a browser question carries the app's hint (labels, tab addresses) as JSON; the user's approval reaches the app without auto",
    askB.params.tool === "mcp__claude-in-chrome__computer" && JSON.parse(askB.params.hint).targets[0].label === 'button "Send"' && ws.last("answer").rid === "qb" && ws.last("answer").behavior === "allow" && ws.last("answer").auto === undefined);
  askAnswer = { behavior: "allow", auto: true };
  askAnswer = { behavior: "deny", message: "Denied by the administrator." };
  await lib.onMessage(1, { t: "ask", rid: "q2", slug: "pc-ahmed", tool: "mcp__joya-hands__click", input: { summary: "Click Send", why: "Send" }, origin: "hands" });
  check("  a deny reaches the app with its message; hands origin kept", ws.last("answer").rid === "q2" && ws.last("answer").behavior === "deny" && /administrator/.test(ws.last("answer").message) && callsOf("machine-ask").pop().params.origin === "hands");
  await lib.onMessage(1, { t: "ask", rid: "q3", slug: "pc-wrong", tool: "PowerShell", input: {} });
  check("  a question for another slug: denied here", ws.last("answer").rid === "q3" && ws.last("answer").behavior === "deny");

  // Reports and actions
  await lib.onMessage(1, { t: "report", slug: "pc-ahmed", text: "Made Budget.xlsx." });
  check("report -> machine-report to the supervisor", callsOf("machine-report").pop().params.text === "Made Budget.xlsx.");
  const leaseId = st.lease.id;
  // The action log (0.1.11): time, kind, tool, target, who let it run, the result. Older apps send summary + decision.
  await lib.onMessage(1, { t: "action", lease_id: leaseId, slug: "pc-ahmed", at: new Date(clock).toISOString(), tool: "PowerShell", summary: "Get-ChildItem key sk-ABCDEFGHIJKLMNOP", decision: "auto", shot: JPEG.toString("base64") });
  await lib.onMessage(1, { t: "action", lease_id: leaseId, slug: "pc-ahmed", tool: "mcp__joya-hands__create_document", summary: "create docx C:\\x.docx", decision: "nonsense" });
  await lib.onMessage(1, { t: "action", lease_id: leaseId, slug: "pc-ahmed", tool: "Glob", summary: "Glob: *.md", decision: "error" });
  await lib.onMessage(1, { t: "action", lease_id: leaseId, slug: "pc-ahmed", tool: "mcp__claude-in-chrome__computer", target: 'Chrome: left click button "Send" — Sends the reply', summary: "x", decision: "approved", result: "ok", detail: "", kind: "browser" });
  await lib.onMessage(1, { t: "action", lease_id: leaseId, slug: "pc-ahmed", tool: "mcp__joya-hands__office_edit", target: "C:\\a\\R.docx -> C:\\a\\R (edited).docx", decision: "auto", result: "error", detail: "Office: There is no slide 9. sk-ABCDEFGHIJKLMNOP", kind: "hands" });
  await lib.onMessage(1, { t: "action", lease_id: leaseId, slug: "pc-ahmed", tool: "mcp__claude-in-chrome__form_input", target: "Chrome: fill a field", decision: "refused", result: "error", detail: "password field", kind: "weird" });
  const log = lib.actionLog(leaseId, 0);
  check("action log: every row kept in order, the target redacted, the decision checked", log.length === 6 && /\[redacted\]/.test(log[0].target) && log[1].decision === "auto" && log[0].kind === "cli" && log[1].kind === "hands", JSON.stringify(log));
  check("  an older app's \"error\" reads as ran-and-failed; a new app's result, approval, kind and detail are kept (detail redacted too)",
    log[2].result === "error" && log[2].decision === "auto" && log[3].approved === true && log[3].kind === "browser" && log[3].result === "ok" && /Sends the reply/.test(log[3].target) &&
      log[4].result === "error" && /no slide 9/.test(log[4].detail) && /\[redacted\]/.test(log[4].detail) && log[5].decision === "refused" && log[5].kind === "browser", JSON.stringify(log.slice(2)));
  check("  no screenshot is kept any more (screen capture is not part of laptop control)", !fs.readdirSync(dir).length && lib.actions(leaseId).length === 0);
  check("  ?after: only the newer rows (the live log)", lib.actionLog(leaseId, log[3].id).length === 2 && lib.lastActions(leaseId, 2).map((a) => a.id).join() === [log[4].id, log[5].id].join());
  check("  the lease lists its action count", lib.leases(1, 10).find((l) => String(l.id) === String(leaseId)).actions === 6);
  await lib.onMessage(1, { t: "action", lease_id: "999", slug: "pc-ahmed", tool: "x", target: "late", decision: "auto" });
  check("  a late entry for another lease is not put on this one", lib.actionLog(leaseId, 0).length === 6);

  // Extend: +15 min, never more than an hour from now; the app is told.
  const e1 = lib.extend(1, "amaraghy");
  check("extend: +15 minutes, told to the app", e1.ok && Date.parse(e1.expires_at) - clock === 30 * 60000 && ws.last("extend").expires_at === e1.expires_at);
  lib.extend(1, "amaraghy");
  lib.extend(1, "amaraghy");
  const e4 = lib.extend(1, "amaraghy");
  check("  capped at an hour from now", Date.parse(e4.expires_at) - clock === 60 * 60000, e4.expires_at);
  await lib.onMessage(1, { t: "lease", lease_id: leaseId, state: "extended", expires_at: new Date(clock + 5 * 3600 * 1000).toISOString() });
  check("  the app's own extension (the pill) is capped too", Date.parse(lib.list()[0].lease.expires_at) - clock === 60 * 60000);

  // Expiry: past the end (plus grace) the lease ends here, the app is told to stop, the supervisor told.
  clock += 61 * 60000;
  lib.sweep();
  check("lease expiry: ended (timeout), stop sent to the app, machine-state ended to the supervisor", lib.list()[0].lease === null && ws.last("stop").lease_id === leaseId && ws.last("stop").reason === "timeout" && callsOf("machine-state").some((c) => c.params.slug === "pc-ahmed" && c.params.state === "ended" && c.params.reason === "timeout"));
  check("  the ended lease keeps its log", lib.lease(leaseId).end_reason === "timeout" && lib.actionLog(leaseId, 0).length === 6);

  // The stop hotkey on the computer: the app reports the end; the supervisor is told.
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-2", name: "x", purpose: "Second job here.", minutes: 15 });
  const l2 = ws.last("start").lease.id;
  await lib.onMessage(1, { t: "lease", lease_id: l2, state: "ended", reason: "stop-hotkey" });
  check("stop hotkey (reported by the app): lease ended, supervisor told stop-hotkey", lib.lease(l2).end_reason === "stop-hotkey" && callsOf("machine-state").some((c) => c.params.slug === "pc-ahmed-2" && c.params.reason === "stop-hotkey"));

  // Stop from Joya: the app is told at once, the supervisor releases.
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-3", name: "x", purpose: "Third job here.", minutes: 15 });
  const l3 = ws.last("start").lease.id;
  const sc = await lib.stopControl(1, "amaraghy");
  check("stop from Joya: stop to the app, machine-release to the supervisor", sc.ok && ws.last("stop").lease_id === l3 && callsOf("machine-release").pop().actor === "amaraghy" && lib.lease(l3).ended_at);
  // The supervisor's own stop (JOYA AI released it)
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-4", name: "x", purpose: "Fourth job here.", minutes: 15 });
  const l4 = ws.last("start").lease.id;
  lib.onSupervisorEvent({ type: "machine", what: "tell", machine_id: 1, slug: "pc-ahmed-4", text: "[From JOYA AI] more" });
  check("tell event -> tell to the app", ws.last("tell").text === "[From JOYA AI] more");
  lib.onSupervisorEvent({ type: "machine", what: "stop", machine_id: 1, slug: "pc-ahmed-4", reason: "released by JOYA AI" });
  check("stop event -> stop to the app, lease ended", ws.last("stop").lease_id === l4 && lib.lease(l4).ended_at);

  // The runner failed to start (Claude Code missing): the lease ends.
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-5", name: "x", purpose: "Fifth job here.", minutes: 15 });
  const l5 = ws.last("start").lease.id;
  await lib.onMessage(1, { t: "session", slug: "pc-ahmed-5", state: "failed", detail: "Claude Code was not found" });
  check("session failed: lease ended with its reason, supervisor told failed with it", lib.lease(l5).end_reason === "failed: Claude Code was not found" && callsOf("machine-state").some((c) => c.params.slug === "pc-ahmed-5" && c.params.state === "failed" && c.params.reason === "Claude Code was not found"));

  // 2026-10-08: the 0.1.5 app read lease ids only as strings; a number made it drop the start unread.
  check("lease ids go to the app as strings (start, stop, extend)", typeof st.lease.id === "string" && typeof l5 === "string" && ws.sent.filter((m) => m.t === "stop" || m.t === "extend").every((m) => typeof m.lease_id === "string"));

  // The browser and the folders (0.1.11): the hello says the extension and Office; a browser step says it answered.
  await lib.onMessage(1, { t: "hello", app_version: "0.1.11", platform: "windows", host: "AHMED-PC", user: "Ahmed", home: "C:\\Users\\Ahmed", claude: { found: true, path: "C:\\c.exe", version: "2.1.290", git_bash: false }, chrome: { extension: true, browser: "Chrome", profile: "Default" }, office: ["Word", "Excel", "Calc"] });
  let pm = lib.list()[0];
  check("hello 0.1.11: Claude in Chrome set up (browser, profile), Office apps (only real ones)", pm.chrome && pm.chrome.extension === true && pm.chrome.browser === "Chrome" && pm.chrome.allowed === true && pm.chrome.last === null && JSON.stringify(pm.office) === '["Word","Excel"]', JSON.stringify(pm));
  await lib.onMessage(1, { t: "browser", slug: "pc-ahmed-5", connected: false, detail: "Browser extension is not connected", at: new Date(clock).toISOString() });
  pm = lib.list()[0];
  check("  a browser step's word: not connected, with why", pm.chrome.last && pm.chrome.last.connected === false && /not connected/.test(pm.chrome.last.detail));
  await lib.onMessage(1, { t: "hello", app_version: "0.1.11", platform: "windows", host: "AHMED-PC", user: "Ahmed", home: "C:\\Users\\Ahmed", claude: { found: true, path: "C:\\c.exe", version: "2.1.290", git_bash: false }, chrome: { extension: true, browser: "Chrome", profile: "Default" }, office: ["Word"] });
  check("  a new hello keeps what the last session saw", lib.list()[0].chrome.last.connected === false);
  check("folders: a plain local folder is added (normalised); drives, Windows, programs, app data, hidden, profiles and network paths are refused",
    lib.addFolder(1, "d:/work/projects/", "amaraghy").path === "D:\\work\\projects" && !!lib.addFolder(1, "D:\\", "a").error && !!lib.addFolder(1, "C:\\Windows\\System32", "a").error && !!lib.addFolder(1, "c:\\program files\\x", "a").error &&
      !!lib.addFolder(1, "C:\\Users\\Ahmed\\AppData\\Local\\x", "a").error && !!lib.addFolder(1, "C:\\Users\\Ahmed\\.ssh", "a").error && !!lib.addFolder(1, "C:\\Users\\Ahmed", "a").error && !!lib.addFolder(1, "\\\\nas\\share", "a").error && !!lib.addFolder(1, "relative\\x", "a").error);
  check("  the same folder twice is one; removing works", lib.addFolder(1, "D:\\Work\\Projects", "a").folders.length === 1 && lib.addFolder(1, "E:\\Scans", "a").folders.length === 2 && lib.removeFolder(1, "e:\\scans", "a").folders.length === 1 && !!lib.removeFolder(1, "F:\\nope", "a").error);
  check("  the browser can be switched off for a computer", lib.setBrowser(1, false, "amaraghy").ok && lib.list()[0].chrome.allowed === false);
  await lib.sync();
  const syncB = callsOf("machines-sync").pop().params.machines[0];
  check("  machines-sync carries chrome {extension, allowed, last.connected}, the folders and Office (the supervisor's gate and machine_list read them)",
    syncB.chrome && syncB.chrome.extension === true && syncB.chrome.allowed === false && syncB.chrome.last.connected === false && JSON.stringify(syncB.folders) === '["D:\\\\work\\\\projects"]' && JSON.stringify(syncB.office) === '["Word"]', JSON.stringify(syncB));
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-b", name: "x", purpose: "A browser job here.", minutes: 15 });
  const stB = ws.last("start");
  check("  start carries the folders and browser: false to the app", JSON.stringify(stB.folders) === '["D:\\\\work\\\\projects"]' && stB.browser === false, JSON.stringify(stB));
  await lib.onMessage(1, { t: "session", slug: "pc-ahmed-b", state: "exited" });
  lib.setBrowser(1, true, "amaraghy");
  lib.removeFolder(1, "D:\\work\\projects", "a");

  // Claude Code missing on the computer: shown, synced, and a take-over refused up front.
  await lib.onMessage(1, { t: "hello", app_version: "0.1.5", platform: "windows", host: "AHMED-PC", user: "Ahmed", home: "C:\\Users\\Ahmed", claude: { found: false, path: null, version: null, git_bash: false } });
  check("hello without Claude Code: the computer shows Claude Code not found", lib.list()[0].claude && lib.list()[0].claude.found === false && M.claudeMissing(lib.get(1)));
  await lib.sync();
  check("  machines-sync carries it (claude.found false)", callsOf("machines-sync").pop().params.machines[0].claude.found === false);
  const before = calls.length;
  const tk = await lib.takeOver(1, "Make a budget sheet in Excel.", 15, "amaraghy");
  check("  Take over from the page: refused at once with the reason, the supervisor never asked", tk.error && /Claude Code is not installed on "Ahmed's Laptop"/.test(tk.error) && /`claude`/.test(tk.error) && calls.length === before, JSON.stringify(tk));
  const startsBefore = ws.sent.filter((m) => m.t === "start").length;
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-nc", name: "x", purpose: "A job without Claude Code.", minutes: 15 });
  check("  a start event for it: failed to the supervisor with that reason, nothing sent to the app, no lease", ws.sent.filter((m) => m.t === "start").length === startsBefore && lib.list()[0].lease === null && callsOf("machine-state").some((c) => c.params.slug === "pc-ahmed-nc" && c.params.state === "failed" && /Claude Code is not installed/.test(c.params.reason)));
  await lib.onMessage(1, { t: "hello", app_version: "0.1.5", platform: "windows", host: "AHMED-PC", user: "Ahmed", home: "C:\\Users\\Ahmed", claude: { found: true, path: "C:\\c.exe", version: "2.1.291", git_bash: false } });
  check("  Look again found it (a new hello): not missing any more", !M.claudeMissing(lib.get(1)) && lib.list()[0].claude.version === "2.1.291");
  check("  an old app's hello (no found, a path) reads as found; unknown is never missing", M.claudeOf({ claude_json: JSON.stringify({ path: "C:\\c.exe" }) }).found === true && M.claudeOf({ claude_json: JSON.stringify({ path: null }) }).found === false && !M.claudeMissing({ claude_json: null }));

  // (The fake socket answers the sweep's ping, so the link stays up.)
  const aliveSweep = () => {
    ws.emit("pong");
    lib.sweep();
  };
  // The start timeout: no word from the app in 60 s -> ended, the app told to stop, the supervisor told FAILED.
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-to", name: "x", purpose: "A job the app never starts.", minutes: 15 });
  const lt = ws.last("start").lease.id;
  clock += 30 * 1000;
  aliveSweep();
  check("start timeout: still waiting at 30 s", !lib.lease(lt).ended_at);
  clock += 31 * 1000;
  aliveSweep();
  check("  at 61 s with no lease active / session starting from the app: ended (failed), stop to the app, machine-state failed with the reason",
    /^failed: the computer did not start the session/.test(lib.lease(lt).end_reason) && ws.last("stop").lease_id === lt && callsOf("machine-state").some((c) => c.params.slug === "pc-ahmed-to" && c.params.state === "failed" && c.params.reason === M.NO_START), lib.lease(lt).end_reason);
  check("  told once (a later sweep does nothing more)", (aliveSweep(), callsOf("machine-state").filter((c) => c.params.slug === "pc-ahmed-to").length === 1));
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-ok", name: "x", purpose: "A job the app starts.", minutes: 15 });
  const lo = ws.last("start").lease.id;
  await lib.onMessage(1, { t: "lease", lease_id: lo, state: "active", expires_at: new Date(clock + 15 * 60000).toISOString() });
  clock += 90 * 1000;
  aliveSweep();
  check("  an acknowledged start (lease active) is not timed out", !lib.lease(lo).ended_at);
  await lib.onMessage(1, { t: "lease", lease_id: lo, state: "ended", reason: "failed" });
  check("  the app's own lease end for a failed start is accepted (reason failed)", lib.lease(lo).end_reason === "failed");
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-ok2", name: "x", purpose: "A job the app starts.", minutes: 15 });
  const lo2 = ws.last("start").lease.id;
  await lib.onMessage(1, { t: "session", slug: "pc-ahmed-ok2", state: "starting" });
  clock += 90 * 1000;
  aliveSweep();
  check("  a start acknowledged by session starting is not timed out either", !lib.lease(lo2).ended_at);
  await lib.onMessage(1, { t: "session", slug: "pc-ahmed-ok2", state: "exited" });

  // Retention: 7 days, the screenshot deleted with its row.
  // Retention: the action log 90 days; an old app's screenshot rows (table machine_actions) 7 days, with their files.
  fs.mkdirSync(path.join(dir, "1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "1", "old.jpg"), JPEG);
  mdb.prepare("INSERT INTO machine_actions (machine_id, lease_id, at, tool, summary, decision, shot) VALUES (1, ?, ?, 'PowerShell', 'old', 'auto', ?)").run(Number(leaseId), new Date(clock).toISOString(), path.join("1", "old.jpg"));
  check("  an old screenshot row is still listed and served (inside the dir)", lib.actions(leaseId).length === 1 && lib.actions(leaseId)[0].shot === true && lib.shotFile(lib.actions(leaseId)[0].id).startsWith(dir));
  clock += 8 * 24 * 3600 * 1000;
  const n = lib.prune();
  check("retention: after 8 days the screenshot row and its file are gone, the action log is kept", n === 1 && lib.actions(leaseId).length === 0 && !fs.existsSync(path.join(dir, "1", "old.jpg")) && lib.actionLog(leaseId, 0).length === 6);
  clock += 83 * 24 * 3600 * 1000;
  const n90 = lib.prune();
  check("  after 91 days the action log goes too (90 days)", n90 === 6 && lib.actionLog(leaseId, 0).length === 0, n90);

  // Rename and revoke
  check("rename: cleaned, told to the app", lib.rename(1, "Office Laptop", "amaraghy").ok && ws.last("renamed").name === "Office Laptop" && !!lib.rename(1, "***", "x").error);
  lib.onSupervisorEvent({ type: "machine", what: "start", machine_id: 1, slug: "pc-ahmed-6", name: "x", purpose: "Sixth job here.", minutes: 15 });
  const l6 = ws.last("start").lease.id;
  const rv = lib.revoke(1, "amaraghy");
  check("revoke: lease ended (revoked), the app told revoked, the link closed, the token no longer works", rv.ok && lib.lease(l6).end_reason === "revoked" && ws.sent.some((m) => m.t === "revoked") && ws.readyState === 3 && auth("Bearer " + ok.token) === null && lib.list().length === 0);
  lib.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------- part 2: a scratch server --- */

async function part2() {
  console.log("\nscratch server: claim, link, pages");
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-sup-"));
  const SOCK = path.join(sockDir, "sup.sock");
  const seen = [];
  const viewers = [];
  const fake = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const req = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push(req);
        if (req.op === "events") {
          viewers.push(s);
          s.write(JSON.stringify({ id: req.id, ok: true, data: { subscribed: true } }) + "\n");
          continue;
        }
        const data = req.op === "machine-ask" ? { behavior: "allow", auto: true } : { ok: true };
        s.write(JSON.stringify({ id: req.id, ok: true, data }) + "\n");
      }
    });
    s.on("error", () => {});
  });
  await new Promise((r) => fake.listen(SOCK, r));
  const srv = await scratch.startScratch({ env: { JOYA_AI_SOCKET: SOCK } });
  try {
    await srv.makeUser("admin1", "administrator");
    const who = await srv.signIn("admin1");
    const page = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("GET /machines (administrator): the Computers page, no inline script", page.status === 200 && /Pair a computer/.test(page.body) && /machines\.js/.test(page.body) && !/<script>(?!<\/script>)/.test(page.body));
    const visible = page.body.replace(/<[^>]+>/g, " ").replace(/no\s+other screen, mouse or keyboard control/g, "");
    check("  says what JOYA AI can do there (files, PowerShell, Office edits, PDFs, your Chrome through Claude in Chrome) and plainly that it has no other screen / mouse / keyboard control",
      /no<\/b> other screen, mouse or keyboard control/.test(page.body) && /PowerShell/.test(page.body) && /edit existing ones/.test(page.body) && /PDFs/.test(page.body) && /Claude in Chrome extension/.test(page.body) && !/\b(screen|mouse|keyboard|screenshot)\b/i.test(visible.replace(/A glowing frame/g, "")), visible.match(/.{0,60}\b(screen|mouse|keyboard|screenshot)\b.{0,60}/i));
    check("  the safety card: approval (Windows Hello) before sending / submitting / buying / posting / deleting / writing over a file (signing in is not asked); a new copy by default; macros never run; the log kept 90 days",
      /Windows Hello/.test(page.body) && /posting, deleting/.test(page.body) && !/signing in/.test(page.body) && /writing over a file/.test(page.body) && /new copy next to the original/.test(page.body) && /macros never run/.test(page.body) && /kept 90 days/.test(page.body));
    const csrf = (/name="_csrf" value="([^"]+)"/.exec(page.body) || [])[1];
    const pr = await srv.req("POST", "/machines/pair", { cookie: who.cookie, body: new URLSearchParams({ _csrf: csrf }).toString() });
    const page2 = await srv.req("GET", "/machines", { cookie: who.cookie });
    const code = (/class="mc-code-value mono">([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(page2.body) || [])[1];
    check("POST /machines/pair (CSRF): a code on the page", pr.status === 303 && !!code, page2.body.slice(0, 200));
    const noCsrf = await srv.req("POST", "/machines/pair", { cookie: who.cookie, body: "x=1" });
    check("  without the CSRF token: refused", noCsrf.status === 403);
    const signedOut = await srv.req("GET", "/machines");
    check("  signed out: to the sign-in page", signedOut.status === 302 && /login/.test(signedOut.headers.location || ""));
    const cl = await srv.req("POST", "/machines/api/claim", { body: { code, name: "Test Laptop", platform: "windows", app_version: "0.1.5" } });
    const tok = cl.status === 200 && JSON.parse(cl.body);
    check("POST /machines/api/claim (no cookie): machine id + token, no-store", tok && tok.machine_id >= 1 && M.TOKEN_RE.test(tok.token) && /no-store/.test(cl.headers["cache-control"] || ""), cl.body);
    const again = await srv.req("POST", "/machines/api/claim", { body: { code } });
    check("  the code again: 404", again.status === 404);
    const wsUrl = `ws://127.0.0.1:${srv.port}/machines/api/link`;
    const refused = await new Promise((resolve) => {
      const w = new WebSocket(wsUrl, { headers: { Authorization: "Bearer mmt_" + "B".repeat(43) } });
      w.on("unexpected-response", (req, res) => resolve(res.statusCode));
      w.on("open", () => resolve("open"));
      w.on("error", () => resolve("error"));
    });
    check("WS link with a wrong token: 401", refused === 401, refused);
    const msgs = [];
    const app = new WebSocket(wsUrl, { headers: { Authorization: "Bearer " + tok.token } });
    app.on("message", (d) => msgs.push(JSON.parse(String(d)))); // before open: the welcome can come with the upgrade
    await new Promise((resolve, reject) => {
      app.on("open", resolve);
      app.on("error", reject);
    });
    app.send(JSON.stringify({ t: "hello", app_version: "0.1.5", platform: "windows", host: "TEST-PC", user: "T", home: "C:\\Users\\T", claude: { path: "C:\\c.exe", version: "2.1.290", git_bash: true } }));
    await sleep(600);
    const old = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("an older app (no chrome in its hello): Chrome \"unknown\" with the steps to set it up", /data-chrome-state="unknown"/.test(old.body) && /How to connect Chrome/.test(old.body) && /claude --chrome/.test(old.body));
    app.send(JSON.stringify({ t: "hello", app_version: "0.1.11", platform: "windows", host: "TEST-PC", user: "T", home: "C:\\Users\\T", claude: { path: "C:\\c.exe", version: "2.1.290", git_bash: true }, chrome: { extension: false }, office: ["Word", "Excel", "PowerPoint"] }));
    await sleep(400);
    const nos = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("Chrome not set up: \"Chrome not set up\", the steps open (install from claude.ai/chrome, same Claude account, claude --chrome, Look again); Office listed",
      /data-chrome-state="missing"/.test(nos.body) && /Chrome not set up/.test(nos.body) && /<details class="mc-steps" open>/.test(nos.body) && /claude\.ai\/chrome/.test(nos.body) && /same Claude account/.test(nos.body) && /Look again/.test(nos.body) && /Office: Word, Excel, PowerPoint/.test(nos.body));
    app.send(JSON.stringify({ t: "hello", app_version: "0.1.11", platform: "windows", host: "TEST-PC", user: "T", home: "C:\\Users\\T", claude: { path: "C:\\c.exe", version: "2.1.290", git_bash: true }, chrome: { extension: true, browser: "Chrome", profile: "Default" }, office: ["Word"] }));
    app.send(JSON.stringify({ t: "browser", slug: "x", connected: true, detail: "", at: new Date().toISOString() }));
    await sleep(400);
    const con = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("Chrome connected: \"Chrome connected\" in Chrome (Default), no steps, a switch-off button", /data-chrome-state="connected"/.test(con.body) && /Chrome connected/.test(con.body) && /in Chrome \(Default\)/.test(con.body) && !/class="mc-steps"/.test(con.body) && /Switch Chrome off/.test(con.body));
    const csrfC = (/name="_csrf" value="([^"]+)"/.exec(con.body) || [])[1];
    const off = await srv.req("POST", `/machines/${tok.machine_id}/browser`, { cookie: who.cookie, body: new URLSearchParams({ _csrf: csrfC, on: "0" }).toString() });
    const offPage = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("  switched off (CSRF form): \"Chrome off\", a button to allow it again; without CSRF refused", off.status === 303 && /data-chrome-state="off"/.test(offPage.body) && /Let JOYA AI use Chrome/.test(offPage.body) && (await srv.req("POST", `/machines/${tok.machine_id}/browser`, { cookie: who.cookie, body: "on=1" })).status === 403);
    await srv.req("POST", `/machines/${tok.machine_id}/browser`, { cookie: who.cookie, body: new URLSearchParams({ _csrf: csrfC, on: "1" }).toString() });
    const fa = await srv.req("POST", `/machines/${tok.machine_id}/folders`, { cookie: who.cookie, body: new URLSearchParams({ _csrf: csrfC, path: "D:\\Work" }).toString() });
    const fbad = await srv.req("POST", `/machines/${tok.machine_id}/folders`, { cookie: who.cookie, body: new URLSearchParams({ _csrf: csrfC, path: "C:\\Windows" }).toString() });
    const fPage = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("folders: one added on the page is listed (with a remove button); a Windows folder is refused with why", fa.status === 303 && /<span class="mono small">D:\\Work<\/span>/.test(fPage.body) && /folders\/remove/.test(fPage.body) && /Windows or programs folder/.test(decodeURIComponent((fbad.headers.location || "").replace(/\+/g, " "))));
    await sleep(300);
    const syncF = seen.filter((r) => r.op === "machines-sync").pop();
    check("  the supervisor's registry gets the folder and the browser state", syncF && syncF.machines.some((m) => m.id === tok.machine_id && JSON.stringify(m.folders) === '["D:\\\\Work"]' && m.chrome && m.chrome.extension === true && m.chrome.allowed === true), JSON.stringify(syncF));
    check("WS link with its token: welcome", msgs.some((m) => m.t === "welcome" && m.machine_id === tok.machine_id), JSON.stringify(msgs));
    const syncs = seen.filter((r) => r.op === "machines-sync");
    check("  the fake supervisor got machines-sync (actor machines) with it online and its home", syncs.length && syncs[syncs.length - 1].actor === "machines" && syncs[syncs.length - 1].machines.some((m) => m.id === tok.machine_id && m.online && m.home === "C:\\Users\\T"), JSON.stringify(syncs.slice(-1)));
    check("  the dashboard subscribed to the supervisor's events as machines", seen.some((r) => r.op === "events" && r.actor === "machines"));
    // The supervisor's start event reaches the app.
    for (const v of viewers) v.write(JSON.stringify({ event: { seq: 5, type: "machine", what: "start", machine_id: tok.machine_id, slug: "pc-test-laptop", name: "Test Laptop control", purpose: "Open the Downloads folder.", minutes: 15, first_prompt: "[From JOYA AI] Open the Downloads folder." } }) + "\n");
    await sleep(500);
    const start = msgs.find((m) => m.t === "start");
    check("a take-over event from the supervisor reaches the app as start with a lease (id a string)", start && start.slug === "pc-test-laptop" && start.lease && start.lease.minutes === 15 && typeof start.lease.id === "string", JSON.stringify(msgs));
    const listed = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("the Computers page shows Claude Code with its version", /data-claude="\d+" data-found="1">Claude Code 2\.1\.290</.test(listed.body));
    app.send(JSON.stringify({ t: "ask", rid: "r1", slug: "pc-test-laptop", tool: "PowerShell", input: { command: "dir" }, origin: "cli" }));
    await sleep(500);
    const askReq = seen.find((r) => r.op === "machine-ask");
    check("an ask from the app reaches the supervisor as machine.<id> and its answer comes back", askReq && askReq.actor === "machine." + tok.machine_id && msgs.some((m) => m.t === "answer" && m.rid === "r1" && m.behavior === "allow"), JSON.stringify(askReq));
    check("  start carries the added folders and browser: true", start && JSON.stringify(start.folders) === '["D:\\\\Work"]' && start.browser === true, JSON.stringify(start));
    const lid = start && start.lease.id;
    app.send(JSON.stringify({ t: "action", lease_id: lid, slug: "pc-test-laptop", tool: "PowerShell", summary: "dir", decision: "auto", shot: JPEG.toString("base64") }));
    app.send(JSON.stringify({ t: "action", lease_id: lid, slug: "pc-test-laptop", tool: "mcp__joya-hands__office_edit", summary: "x", target: "C:\\Users\\T\\Documents\\Budget.xlsx -> C:\\Users\\T\\Documents\\Budget (edited).xlsx", decision: "auto", result: "ok", detail: "saved (Excel): 4 cell(s) set", kind: "hands" }));
    app.send(JSON.stringify({ t: "action", lease_id: lid, slug: "pc-test-laptop", tool: "mcp__claude-in-chrome__computer", summary: "x", target: 'Chrome: left click button "<b>Send</b>" — Sends the reply', decision: "approved", result: "ok", detail: "", kind: "browser" }));
    await sleep(400);
    const lp = await srv.req("GET", `/machines/${tok.machine_id}/lease/${lid}`, { cookie: who.cookie });
    check("the control log page lists every action: time, kind, tool, target, result, who let it run; the target escaped; no screenshot",
      lp.status === 200 && (lp.body.match(/class="mc-log-row/g) || []).length === 3 && /office edit/.test(lp.body) && /Budget \(edited\)\.xlsx/.test(lp.body) && /you approved/.test(lp.body) && /by the rules/.test(lp.body) &&
        /&lt;b&gt;Send&lt;\/b&gt;/.test(lp.body) && !/<b>Send<\/b>/.test(lp.body) && !/\/machines\/shot\//.test(lp.body) && /data-live-log="\d+"/.test(lp.body) && /data-active="1"/.test(lp.body) && /id="mc-kind-icons"/.test(lp.body));
    const api = await srv.req("GET", `/machines/api/lease/${lid}`, { cookie: who.cookie });
    const apiJ = api.status === 200 && JSON.parse(api.body);
    const api2 = apiJ && (await srv.req("GET", `/machines/api/lease/${lid}?after=${apiJ.log[0].id}`, { cookie: who.cookie }));
    check("the live API: the whole log, then ?after=<id> only the newer rows (no-store)", apiJ && apiJ.log.length === 3 && apiJ.log[1].kind === "hands" && apiJ.log[2].approved === true && JSON.parse(api2.body).log.length === 2 && /no-store/.test(api.headers["cache-control"] || ""), api.body.slice(0, 300));
    check("  signed out: not served", (await srv.req("GET", `/machines/api/lease/${lid}`)).status !== 200);
    const live = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("the Computers page shows the take-over's live action log (its last actions)", /Live action log/.test(live.body) && (live.body.match(/class="mc-log-row/g) || []).length === 3 && /data-keep="8"/.test(live.body));
    app.send(JSON.stringify({ t: "lease", lease_id: start && start.lease.id, state: "ended", reason: "stop-hotkey" }));
    await sleep(400);
    check("the app's lease end reaches the supervisor (machine-state ended, stop-hotkey)", seen.some((r) => r.op === "machine-state" && r.state === "ended" && r.reason === "stop-hotkey"));
    app.send(JSON.stringify({ t: "hello", app_version: "0.1.5", platform: "windows", host: "TEST-PC", user: "T", home: "C:\\Users\\T", claude: { found: false, path: null, version: null, git_bash: false } }));
    await sleep(400);
    const nf = await srv.req("GET", "/machines", { cookie: who.cookie });
    check("Claude Code missing: the page says \"Claude Code: not found\", what to do, and offers no Take over", /Claude Code: not found/.test(nf.body) && /data-claude-missing=/.test(nf.body) && /Look again/.test(nf.body) && !new RegExp(`/machines/${tok.machine_id}/take-over`).test(nf.body));
    const syncNf = seen.filter((r) => r.op === "machines-sync").pop();
    check("  and the supervisor's registry is told (claude.found false)", syncNf && syncNf.machines.some((m) => m.id === tok.machine_id && m.claude && m.claude.found === false), JSON.stringify(syncNf));
    const csrf2 = (/name="_csrf" value="([^"]+)"/.exec(nf.body) || [])[1];
    const tko = await srv.req("POST", `/machines/${tok.machine_id}/take-over`, { cookie: who.cookie, body: new URLSearchParams({ _csrf: csrf2, purpose: "Open the Downloads folder.", minutes: "15" }).toString() });
    check("  a Take over posted anyway: refused, the supervisor never asked", tko.status === 303 && !seen.some((r) => r.op === "machine-take-over"));
    app.close();
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    srv.stop();
    fake.close();
  }
}

(async () => {
  await part1();
  await part2();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
