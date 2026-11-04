#!/usr/bin/env node
"use strict";
/**
 * Proactive JOYA AI (functionality upgrade 2): the morning brief, the watchers, "while you were away".
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright \
 *       node dashboard/tools/test-proactive.cjs [--shots DIR]
 *
 * 1. pure (lib/proactive.js): plain words -> watchers, validation (no field that could act), the
 *    checks for every kind (once / every, quiet time, waiting episodes, once a day), the brief's
 *    facts and words, the grounding check (no number that is not in the facts);
 * 2. rows (lib/proactive-store.js): the cap of 50, pause / resume / delete, one person's rows only;
 * 3. the clock (lib/routes-proactive.js createEngine) over a fake supervisor and a fake clock: what
 *    the sessions did, watchers firing, the brief at 08:00 in the person's zone (once, a late one
 *    written up to 6 h late, never a backlog), the model's wording kept only when grounded, the
 *    catch-up after 30 min away (once, and not when nothing happened);
 * 4. the real server.js (a scratch copy) over a fake supervisor socket: the API, CSRF, another
 *    person's watchers out of reach, Settings ▸ Briefs & watchers, the clock firing a watcher;
 * 5. headless Chromium: the brief card, a watcher alert (Live feed + toast), "Set a watcher?" from
 *    the composer, the desktop app's glance card and its Windows toast (a mocked app bridge).
 *    --shots DIR writes the screenshots (mockups/proactive/).
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const net = require("net");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const P = require(path.join(ROOT, "lib", "proactive.js"));
const Store = require(path.join(ROOT, "lib", "proactive-store.js"));
const RP = require(path.join(ROOT, "lib", "routes-proactive.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const G = require(path.join(ROOT, "public", "joya-desktop-glance.js"));
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.10";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 900) : "")); }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const NAMES = ["[GSH] Planning Automation", "Joya Builder", "Customs docs"];
const H = 3600e3, M = 60e3;

(async () => {
  /* ================================================================ 1. pure */
  section("plain words -> a watcher (parse)");
  {
    const t = (s) => P.parse(s, NAMES);
    let r = t("tell me when the Planning engine session finishes");
    check("'tell me when the Planning engine session finishes': session_done, the live session it means, once", r.ok && r.value.kind === "session_done" && r.value.params.session === "[GSH] Planning Automation" && r.value.repeat === "once" && /Planning engine/.test(r.note), JSON.stringify(r));
    r = t("alert me if spend passes $50 today");
    check("'alert me if spend passes $50 today': spend_over usd 50, any session, once", r.ok && r.value.kind === "spend_over" && r.value.params.metric === "usd" && r.value.params.threshold === 50 && r.value.params.session === "*", JSON.stringify(r));
    r = t("watch for a session waiting on me more than 10 minutes");
    check("'watch for a session waiting on me more than 10 minutes': session_waiting, any session, 10 min", r.ok && r.value.kind === "session_waiting" && r.value.params.session === "*" && r.value.params.minutes === 10, JSON.stringify(r));
    r = t("alert me when something is waiting on me for over 2 hours");
    check("  hours are minutes: 2 h -> 120", r.ok && r.value.params.minutes === 120 && /2 h or more/.test(r.text), JSON.stringify(r));
    r = t("tell me whenever a session finishes");
    check("'whenever': every time", r.ok && r.value.kind === "session_done" && r.value.repeat === "every" && r.value.params.session === "*");
    r = t('notify me when Customs docs says "filed"');
    check("a reply containing words, the words in quotes", r.ok && r.value.kind === "reply_contains" && r.value.params.session === "Customs docs" && r.value.params.text === "filed", JSON.stringify(r));
    r = t("let me know if any session fails");
    check("failures, any session", r.ok && r.value.kind === "fails" && r.value.params.session === "*", JSON.stringify(r));
    r = t("ping me when customs ends");
    check("a session ending; a short name finds the live one", r.ok && r.value.kind === "session_ends" && r.value.params.session === "Customs docs", JSON.stringify(r));
    r = t("alert me if Joya Builder spends more than $20");
    check("one session's spend", r.ok && r.value.params.session === "Joya Builder" && r.value.params.threshold === 20, JSON.stringify(r));
    r = t("tell me if tokens pass 300M today");
    check("tokens: 300M", r.ok && r.value.params.metric === "tokens" && r.value.params.threshold === 3e8, JSON.stringify(r));
    r = t("remind me at 5:30pm to call the warehouse");
    check("a time of day: 17:30, every day, once, the reminder's words", r.ok && r.value.kind === "at_time" && r.value.params.time === "17:30" && r.value.params.days.length === 7 && r.value.repeat === "once" && r.value.params.text === "call the warehouse", JSON.stringify(r));
    r = t("every weekday at 9 remind me to check the queue");
    check("  weekdays at 9:00, every time", r.ok && r.value.params.time === "09:00" && r.value.params.days.join() === "1,2,3,4,5" && r.value.repeat === "every" && r.value.params.text === "check the queue", JSON.stringify(r));
    r = t("tell me when Odoo Migrator finishes");
    check("a name not running now: kept as said, with a note", r.ok && r.value.params.session === "Odoo Migrator" && /No session called/.test(r.note));
    check("not a watcher: a clear answer listing what can be watched", !t("tell me the weather").ok && /finishing, ending, failing/.test(t("tell me the weather").error));
    check("  spend without a line: asks for one", !t("alert me if spend gets high").ok && /\$50/.test(t("alert me if spend gets high").error));
    check("the composer's test: 'tell me…', 'alert me…', 'watch…', 'remind me…' look like watchers; a plain question does not", P.looksLikeWatcher("Tell me when X is done") && P.looksLikeWatcher("watch for a session waiting") && P.looksLikeWatcher("remind me at 9") && !P.looksLikeWatcher("what is the disk usage?") && !P.looksLikeWatcher("restart odoo"));
    const pub = fs.readFileSync(path.join(ROOT, "public", "joya-proactive.js"), "utf8");
    const re = new RegExp(/var TRIGGER = (\/.*\/i);/.exec(pub)[1].slice(1, -2), "i");
    check("  the page's copy of that test says the same", ["Tell me when X is done", "let me know if", "what is the disk usage?", "watch for x", "keep an eye on spend"].every((s) => re.test(s) === P.looksLikeWatcher(s)));
  }

  section("validation: structured, bounded, and nothing that could act");
  {
    const ok = P.validate({ kind: "session_done", params: { session: "Joya Builder" } });
    check("a minimal watcher is filled in: once, quiet time 10 min, no label", ok.ok && ok.value.repeat === "once" && ok.value.cooldown_min === 10 && ok.value.label === "");
    for (const [what, spec] of [
      ["an action field", { kind: "session_done", params: {}, action: "restart" }],
      ["a command in params", { kind: "session_done", params: { session: "x", command: "rm -rf /" } }],
      ["a url", { kind: "at_time", params: { time: "08:00", url: "https://example.com" } }],
      ["an unknown kind", { kind: "run_command", params: {} }],
      ["minutes 0", { kind: "session_waiting", params: { minutes: 0 } }],
      ["minutes 2000", { kind: "session_waiting", params: { minutes: 2000 } }],
      ["a negative line", { kind: "spend_over", params: { metric: "usd", threshold: -1 } }],
      ["metric euros", { kind: "spend_over", params: { metric: "eur", threshold: 5 } }],
      ["a token line of 10", { kind: "spend_over", params: { metric: "tokens", threshold: 10 } }],
      ["time 25:00", { kind: "at_time", params: { time: "25:00" } }],
      ["no days", { kind: "at_time", params: { time: "08:00", days: [] } }],
      ["day 7", { kind: "at_time", params: { time: "08:00", days: [7] } }],
      ["a one-letter search", { kind: "reply_contains", params: { text: "a" } }],
      ["a 200-char name", { kind: "session_done", params: { session: "x".repeat(200) } }],
      ["a control character", { kind: "session_done", params: { session: "a\u0007b" } }],
      ["repeat forever", { kind: "session_done", params: {}, repeat: "forever" }],
      ["an array", []],
    ]) check("  refused: " + what, !P.validate(spec).ok, JSON.stringify(P.validate(spec)));
    check("descriptions read as sentences", P.describe({ kind: "spend_over", params: { metric: "usd", threshold: 50, session: "*" }, repeat: "once" }) === "When today's spend passes $50.00 · once" && P.describe({ kind: "session_waiting", params: { session: "*", minutes: 90 }, repeat: "every" }) === "When any session waits on you 1 h 30 min or more · every time");
    check("names match by their words: 'planning' -> '[GSH] Planning Automation'; '*' anything; not a different name", P.sessionMatches("planning", "[GSH] Planning Automation") && P.sessionMatches("*", "x") && !P.sessionMatches("planning engine", "[GSH] Planning Automation") && P.sessionMatches("[GSH] Planning Automation", "[GSH] Planning Automation") && !P.sessionMatches("Joya", "Customs docs"));
  }

  section("the checks (evaluate)");
  {
    const now = Date.parse("2026-10-20T10:00:00Z");
    const busy = (name, since) => ({ name, session_id: "id-" + name, status: "busy", status_since: new Date(since).toISOString() });
    const idle = (name, since) => ({ name, session_id: "id-" + name, status: "idle", status_since: new Date(since).toISOString() });
    const waiting = (name, since, f) => ({ name, session_id: "id-" + name, status: "waiting", status_since: new Date(since).toISOString(), waiting_for: f || null });
    const tr = P.transitions([busy("Joya Builder", now - 2 * H), busy("Customs docs", now - H), idle("Old", now - H)], [idle("Joya Builder", now), waiting("Customs docs", now), idle("New", now)], now);
    const kinds = tr.map((x) => x.kind + ":" + x.name).sort().join(",");
    check("transitions: finished (with how long it worked), waiting, started, ended", kinds === "ended:Old,finished:Customs docs,finished:Joya Builder,started:New,waiting:Customs docs" && tr.find((x) => x.name === "Joya Builder").ms === 2 * H, kinds);
    check("  JOYA AI itself is never one of the sessions", P.transitions([{ self: true, name: "JOYA AI", status: "busy" }], [{ self: true, name: "JOYA AI", status: "idle" }], now).length === 0);
    const W = (kind, params, repeat) => ({ kind, params, repeat: repeat || "once", cooldown_min: 10, state: {} });
    let r = P.evaluate(W("session_done", { session: "Joya Builder" }), { now, transitions: tr });
    check("session_done fires once, says how long it worked; a once-watcher is done", r.fires.length === 1 && /Joya Builder finished after 2 h of work/.test(r.fires[0].text) && r.done, JSON.stringify(r));
    r = P.evaluate(W("session_done", { session: "*" }, "every"), { now, transitions: tr });
    check("  any session, every time: one alert per session that finished; not done", r.fires.length === 2 && !r.done);
    const r2 = P.evaluate(Object.assign(W("session_done", { session: "*" }, "every"), { state: r.state }), { now: now + 2 * M, transitions: tr });
    check("  inside the quiet time (10 min) the same session is not repeated", r2.fires.length === 0);
    check("  after it, it is", P.evaluate(Object.assign(W("session_done", { session: "*" }, "every"), { state: r.state }), { now: now + 11 * M, transitions: tr }).fires.length === 2);
    check("session_ends", P.evaluate(W("session_ends", { session: "old" }), { now, transitions: tr }).fires[0].text === "Old ended.");
    // waiting
    const sw = W("session_waiting", { session: "*", minutes: 10 }, "every");
    let st = P.evaluate(sw, { now, sessions: [waiting("Customs docs", now - 5 * M)] });
    check("waiting: not before the 10 minutes", st.fires.length === 0);
    st = P.evaluate(Object.assign(sw, { state: st.state }), { now: now + 6 * M, sessions: [waiting("Customs docs", now - 5 * M, "an answer about the invoices")] });
    check("  at 11 minutes: fires, with what it waits for", st.fires.length === 1 && /Customs docs has been waiting on you 11 min \(for an answer about the invoices\)/.test(st.fires[0].text), JSON.stringify(st.fires));
    const st2 = P.evaluate(Object.assign(sw, { state: st.state }), { now: now + 20 * M, sessions: [waiting("Customs docs", now - 5 * M)] });
    check("  the same wait is told once", st2.fires.length === 0);
    const st3 = P.evaluate(Object.assign(sw, { state: st2.state }), { now: now + 21 * M, sessions: [idle("Customs docs", now + 21 * M)] });
    const st4 = P.evaluate(Object.assign(sw, { state: st3.state }), { now: now + 45 * M, sessions: [waiting("Customs docs", now + 30 * M)] });
    check("  a new wait (after it moved on) counts again", st4.fires.length === 1);
    const ap = P.evaluate(W("session_waiting", { session: "*", minutes: 5 }), { now, sessions: [], approvals: [{ id: 9, status: "pending", origin: "session:planning", origin_name: "Planning engine", summary: "systemctl restart odoo", created_at: new Date(now - 7 * M).toISOString() }] });
    check("  an approval waiting counts as waiting on you", ap.fires.length === 1 && /Planning engine has waited 7 min for your approval: systemctl restart odoo/.test(ap.fires[0].text), JSON.stringify(ap));
    // spend
    const local = P.localNow(now, "Africa/Cairo");
    const sp = W("spend_over", { metric: "usd", threshold: 50, session: "*" }, "every");
    let s1 = P.evaluate(sp, { now, local, spend: { usd: 42, tokens: 1, by: {} } });
    check("spend: under the line, nothing", s1.fires.length === 0);
    s1 = P.evaluate(Object.assign(sp, { state: s1.state }), { now, local, spend: { usd: 51.2, tokens: 1, by: {} } });
    check("  over it: once, with the figure", s1.fires.length === 1 && s1.fires[0].text === "Today's spend passed $50.00: ≈ $51.20 so far.", JSON.stringify(s1));
    check("  not again the same day, even 'every time'", P.evaluate(Object.assign(sp, { state: s1.state }), { now: now + H, local, spend: { usd: 80, tokens: 1, by: {} } }).fires.length === 0);
    check("  the next day, again", P.evaluate(Object.assign(sp, { state: s1.state }), { now: now + 24 * H, local: P.localNow(now + 24 * H, "Africa/Cairo"), spend: { usd: 60, tokens: 1, by: {} } }).fires.length === 1);
    check("  one session's tokens", P.evaluate(W("spend_over", { metric: "tokens", threshold: 1e6, session: "builder" }), { now, local, spend: { usd: 0, tokens: 0, by: { "Joya Builder": { usd: 3, tokens: 2.5e6 } } } }).fires[0].text === "Joya Builder's spend passed 1.0M tokens: 2.5M tokens so far.");
    // replies, failures
    const rc = P.evaluate(W("reply_contains", { session: "*", text: "Done" }), { now, inbound: [{ id: 3, from_name: "Customs docs", text: "All done: filed 12 declarations." }, { id: 4, from_name: "X", text: "nothing" }] });
    check("a reply containing the words (any case)", rc.fires.length === 1 && /Customs docs wrote “Done”: All done/.test(rc.fires[0].text));
    const fl = P.evaluate(W("fails", { session: "*" }), { now, failures: [{ target_name: "Invoice audit", status: "failed", summary: "Check October invoices", note: "session ended" }] });
    check("a failed delegation", fl.fires.length === 1 && /Work sent to Invoice audit failed: Check October invoices — session ended/.test(fl.fires[0].text));
    // time of day
    const at = W("at_time", { time: "12:30", days: [0, 1, 2, 3, 4, 5, 6], text: "lunch" });
    const cairo = (iso) => ({ now: Date.parse(iso), local: P.localNow(Date.parse(iso), "Africa/Cairo") });
    check("a time of day: not before (12:29 Cairo)", P.evaluate(at, cairo("2026-10-20T09:29:00Z")).fires.length === 0);
    const a1 = P.evaluate(at, cairo("2026-10-20T09:30:30Z"));
    check("  at 12:30 Cairo: 'Reminder: lunch'", a1.fires.length === 1 && a1.fires[0].text === "Reminder: lunch" && a1.done);
    check("  missed by more than an hour: not told late (no backlog)", P.evaluate(at, cairo("2026-10-20T11:00:00Z")).fires.length === 0);
    check("  not on a day it was not asked for", P.evaluate(W("at_time", { time: "12:30", days: [1], text: "x" }), cairo("2026-10-20T09:31:00Z")).fires.length === 0); // a Tuesday
  }

  section("the brief: facts, words, grounding");
  const to = Date.parse("2026-10-20T06:00:00Z"), from = to - 22 * H;
  const iso = (ms) => new Date(ms).toISOString();
  const FIX = {
    kind: "brief", from, to,
    sessions: [
      { self: true, name: "JOYA AI", status: "idle", status_since: iso(to - H) },
      { name: "Joya Builder", session_id: "b1", status: "busy", status_since: iso(to - 4 * H), tokens_today: { total: 2e6 } },
      { name: "Customs docs", session_id: "b2", status: "waiting", status_since: iso(to - 40 * M), waiting_for: "the October rates" },
      { name: "Freight quotes", session_id: "b3", status: "idle", status_since: iso(to - 2 * H), open_delegations: 1 },
    ],
    status: { approvals: [{ id: 5, status: "pending", origin: "joya-ai", summary: "rm -rf /srv/old-builds", created_at: iso(to - 12 * M) }], counts: { decisions_open: 0 }, cost_today: { total_usd: 14.2 } },
    caps: { sessions: [{ key: "<self>", kind: "self", name: "JOYA AI", cap: 5e6, today: { total: 4.1e6 } }, { key: "b1", name: "Joya Builder", cap: null, today: { total: 2e6 } }] },
    events: [{ ts: iso(to - 10 * H), kind: "finished", session: "Freight quotes", session_key: "b3", detail: JSON.stringify({ ms: 90 * M }) }, { ts: iso(to - 30 * H), kind: "finished", session: "Ancient", session_key: "zz", detail: null }],
    inbound: [{ id: 1, kind: "idle", from_name: "Freight quotes", text: "Sent the three quotes for the Rotterdam lane.", received_at: iso(to - 10 * H) }],
    delegations: [{ id: 2, target_name: "Invoice audit", status: "failed", summary: "Check October invoices", note: "session ended", created_at: iso(to - 5 * H), failed_at: iso(to - 4 * H), updated_at: iso(to - 4 * H) }],
    turns: [],
    fires: [],
  };
  const facts = P.gather(FIX);
  const brief = P.compose(facts, { whenText: "8:00 yesterday" });
  const text = P.asText(brief, true);
  {
    check("facts: the window only (an older finish is left out)", !JSON.stringify(facts).includes("Ancient"));
    check("  needs you first: the approval with its age, the session waiting with what for", brief.lines[0].k === "Needs you" && /1 approval waiting \(the oldest 12 min\): JOYA AI — rm -rf \/srv\/old-builds/.test(brief.lines[0].text) && /Customs docs is waiting on you 40 min \(for the October rates\)/.test(brief.lines[0].text), brief.lines[0].text);
    check("  finished (in the session's own words), failed (with why)", brief.lines.some((l) => l.k === "Finished" && /Freight quotes: Sent the three quotes/.test(l.text)) && brief.lines.some((l) => l.k === "Failed" && /Invoice audit: Check October invoices — session ended/.test(l.text)), text);
    check("  what a session did: Joya Builder worked 4 h, still working", brief.lines.some((l) => l.k === "Joya Builder" && /worked 4 h/.test(l.text) && /still working/.test(l.text)), text);
    check("  spend against the tightest cap", brief.lines.some((l) => l.k === "Spend" && /≈ \$14\.20 today \(API estimate\), 6\.1M tokens · JOYA AI 4\.1M of 5\.0M tokens \(82%\)/.test(l.text) && l.tone === "warn"), text);
    check("  stale: working 4 h without a pause, waiting long, idle with an open task", brief.lines.some((l) => l.k === "Check" && /Joya Builder working 4 h without a pause/.test(l.text) && /Customs docs waiting on you 40 min/.test(l.text) && /Freight quotes idle 2 h with 1 open task/.test(l.text)), text);
    check("  the title names the window; at most eight lines", brief.title === "Morning brief · since 8:00 yesterday" && brief.lines.length <= 8);
    check("grounded: the template itself passes", P.grounded(P.asText(brief, false), brief).ok);
    const good = "Needs you: 1 approval waiting for 12 min (rm -rf /srv/old-builds), and Customs docs has waited 40 min for the October rates.\nFinished: Freight quotes sent the three quotes for the Rotterdam lane.\nFailed: Invoice audit could not check the October invoices — the session ended.\nSpend: about $14.20 today and 6.1M tokens; JOYA AI is at 82% of its 5.0M cap.";
    check("  a faithful rewording passes", P.grounded(good, brief).ok, P.grounded(good, brief).why);
    check("  an invented number is caught ($19.90)", !P.grounded(good.replace("$14.20", "$19.90"), brief).ok && /19\.90/.test(P.grounded(good.replace("$14.20", "$19.90"), brief).why));
    check("  a number in words is caught ('seven approvals')", !P.grounded(good.replace("1 approval", "seven approvals"), brief).ok);
    check("  dropping what needs you is caught", !P.grounded("Finished: Freight quotes.\nFailed: Invoice audit.", brief).ok);
    check("  dropping a failure is caught", !P.grounded("Needs you: 1 approval waiting.", brief).ok);
    check("  more lines than the facts' (a line split in two) is refused", !P.grounded(good + "\nAa: b\nCc: d\nEe: f\nGg: h\nIi: j\nKk: l\nMm: n\nOo: p", brief).ok);
    check("  markup is refused", !P.grounded("Needs you: **1 approval** waiting. Failed: x", brief).ok);
    const ml = P.linesFrom(good, brief);
    check("  a model's lines keep the labels' tones", ml[0].k === "Needs you" && ml[0].tone === "warn" && ml[2].tone === "err");
    const SID = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    const withSid = P.compose(P.gather(Object.assign({}, FIX, { sessions: FIX.sessions.map((x) => (x.name === "Joya Builder" ? Object.assign({}, x, { session_id: SID }) : x)), caps: null })), {});
    const mb = withSid.lines.find((l) => l.k === "Joya Builder");
    check("  a session's line carries its id (a UUID) for the story link; no id, no link", mb && mb.sid === SID && !withSid.lines.some((l) => l.k !== "Joya Builder" && l.sid), JSON.stringify(withSid.lines));
    const mls = P.linesFrom("Needs you: waiting.\nJoya Builder: worked 4 h, still working.", withSid);
    check("  a model's rewording keeps the session's link", mls[1] && mls[1].sid === SID && !mls[0].sid);
    const quiet = P.compose(P.gather({ kind: "brief", from, to, sessions: [], status: {}, caps: null }), {});
    check("a quiet night says so (and still shows spend)", quiet.lines[0].k === "Quiet" && /No sessions ran/.test(quiet.lines[0].text) && quiet.lines.some((l) => l.k === "Spend" && /no daily caps set/.test(l.text)));
    const cu = P.gather(Object.assign({}, FIX, { kind: "catchup", from: to - 2 * H, usdAtFrom: 10 }));
    const cuw = P.compose(cu, {});
    check("the catch-up: 'While you were away · 2 h', spend while away", cuw.title === "While you were away · 2 h" && cuw.lines.some((l) => l.k === "Spend" && /≈ \$4\.20 while away, ≈ \$14\.20 today/.test(l.text)), JSON.stringify(cuw));
    const empty = P.gather({ kind: "catchup", from: to - H, to, sessions: [{ name: "A", session_id: "a", status: "idle", status_since: iso(to - 5 * H) }], status: { cost_today: { total_usd: 3 } }, caps: null });
    check("  nothing happened while away: empty (no card)", empty.empty === true);
  }

  /* ================================================================ 2. rows */
  section("the rows (proactive-store.js)");
  let Database = null;
  try { Database = require("better-sqlite3"); } catch (e) { check("better-sqlite3 is there (set NODE_PATH)", false, e.message); }
  if (Database) {
    const mem = new Database(":memory:");
    const S = Store.create(mem);
    const v = P.validate({ kind: "session_done", params: { session: "x" } }).value;
    let n = 0;
    for (let i = 0; i < 55; i++) if (S.addWatcher(1, v)) n++;
    check("at most 50 watchers a person; the 51st is refused", n === 50 && S.watcherCount(1) === 50 && S.addWatcher(1, v) === null);
    check("  another person has their own 50", !!S.addWatcher(2, v) && S.watcherCount(2) === 1);
    const w = S.watchers(2)[0];
    check("another person's watcher cannot be paused or deleted", S.setPaused(1, w.id, true) === null && S.deleteWatcher(1, w.id) === false);
    S.saveCheck(w.id, { x: 1 }, 1, true, "fired");
    check("a once-watcher that fired is done, not armed", S.watcher(2, w.id).done && !S.armed().some((x) => x.id === w.id));
    const re = S.setPaused(2, w.id, false);
    check("  resuming it arms it again, from a clean state", !re.done && !re.paused && JSON.stringify(re.state) === "{}" && S.armed().some((x) => x.id === w.id));
    check("pause / delete", S.setPaused(2, w.id, true).paused && !S.armed().some((x) => x.id === w.id) && S.deleteWatcher(2, w.id) && S.watcherCount(2) === 0);
    const b1 = S.addInbox(1, "brief", "Morning brief", { lines: [] });
    const b2 = S.addInbox(1, "brief", "Morning brief", { lines: [] });
    S.supersede(1, "brief", b2.id);
    S.addInbox(1, "watch", "x", { text: "x" });
    S.addInbox(3, "watch", "secret", { text: "someone else's" });
    const inbox = S.inbox(1, 0);
    check("the inbox: the newest brief only (an older one superseded), the watcher alerts, nobody else's", inbox.filter((r) => r.kind === "brief").length === 1 && inbox.find((r) => r.kind === "brief").id === b2.id && inbox.some((r) => r.kind === "watch") && !inbox.some((r) => /someone/.test(JSON.stringify(r))) && b1.id < b2.id);
    check("  dismissing: only one's own", !S.dismiss(3, b2.id) && S.dismiss(1, b2.id) && !S.inbox(1, 0).some((r) => r.kind === "brief"));
    S.setPrefs(1, { brief_time: "07:15", tz: "Europe/London", brief_days: [1, 2] }, "alice");
    const pr = S.prefs(1, "Africa/Cairo");
    check("settings: kept and read back; a person without any gets the defaults (08:00, every day, JOYA AI's zone, on)", pr.brief_time === "07:15" && pr.tz === "Europe/London" && pr.brief_days.join() === "1,2" && S.prefs(9, "Africa/Cairo").brief_time === "08:00" && S.prefs(9, "Africa/Cairo").tz === "Africa/Cairo" && S.prefs(9, "x").brief_on && S.prefs(9).brief_days.length === 7);
    check("settings forms are checked: a bad time, no days, a made-up zone, away 5 min", !!RP.clean({ brief_time: "8am" }).error && !!RP.clean({ brief_days: [] }).error && !!RP.clean({ tz: "Mars/Olympus" }).error && !!RP.clean({ away_min: 5 }).error && RP.clean({ brief_days: ["1", "3"] }).p.brief_days.join() === "1,3");
  }

  /* ================================================================ 3. the clock */
  section("the clock (createEngine) over a fake supervisor and clock");
  if (Database) {
    let clock = Date.parse("2026-10-20T04:59:00Z"); // 07:59 in Cairo
    const sup = {
      status: { process: { tz: "Africa/Cairo" }, approvals: [], counts: {}, cost_today: { total_usd: 12, joya_ai_usd: 2 }, tokens_today: { total: 1e6 } },
      sessions: [{ self: true, name: "JOYA AI", status: "idle" }, { name: "Joya Builder", session_id: "b1", status: "busy", status_since: new Date(clock - 3 * H).toISOString() }],
      inbound: [{ id: 10, kind: "message", from_name: "Joya Builder", text: "old message", received_at: new Date(clock - H).toISOString() }],
      delegations: [],
      turns: [],
      caps: { sessions: [] },
      calls: [],
    };
    const fake = { call: async (op, p, actor) => { sup.calls.push([op, actor]); if (op === "status") return sup.status; if (op === "sessions") return { sessions: sup.sessions }; if (op === "token-caps") return sup.caps; if (op === "ledger") return { rows: sup[p.table] || [] }; throw new Error("op " + op); } };
    const mem = new Database(":memory:");
    const store = Store.create(mem, { now: () => clock });
    const users = [{ id: 1, username: "alice", role: { permissions: ["*"] } }, { id: 2, username: "viewer", role: { permissions: ["os.view"] } }];
    let writerCalls = 0, writerOut = null;
    const voiceOn = { on: true };
    const E = RP.createEngine({ store, joyaai: fake, db: { listUsers: () => users }, rbac, now: () => clock, log: () => {}, voice: { enabled: () => voiceOn.on, config: async () => ({ key: "k" }), record: () => {} }, writer: async () => { writerCalls++; if (writerOut instanceof Error) throw writerOut; return { text: writerOut, usage: null }; } });
    const w1 = store.addWatcher(1, P.parse("tell me when joya builder finishes", ["Joya Builder"]).value);
    store.addWatcher(1, P.parse('tell me when any session says "invoice"', []).value);
    store.addWatcher(2, P.parse("tell me when joya builder finishes", ["Joya Builder"]).value); // a person without JOYA AI
    await E.tick();
    check("every call is read-only and carries the actor 'proactive'", sup.calls.every(([op, a]) => ["status", "sessions", "token-caps", "ledger"].includes(op) && a === "proactive"));
    check("the first look: nothing fires, nothing old counts as new (the inbox is empty)", store.inbox(1, 0).length === 0);
    writerOut = new Error("offline");
    clock += 2 * M; // 08:01 Cairo
    sup.sessions[1] = { name: "Joya Builder", session_id: "b1", status: "idle", status_since: new Date(clock).toISOString() };
    sup.inbound.unshift({ id: 11, kind: "idle", from_name: "Joya Builder", text: "Built the invoice export.", received_at: new Date(clock).toISOString() });
    await E.tick();
    await sleep(30);
    const inb = store.inbox(1, 0);
    const watch = inb.filter((r) => r.kind === "watch");
    check("Joya Builder finished: its watcher fired ('finished after 3 h of work'), and the reply watcher saw 'invoice'", watch.length === 2 && watch.some((r) => /Joya Builder finished after 3 h 2 min of work/.test(r.body.text)) && watch.some((r) => /wrote “invoice”: Built the invoice export/.test(r.body.text)), JSON.stringify(watch.map((r) => r.body.text)));
    check("  the once-watcher is done; the person without JOYA AI got nothing", store.watcher(1, w1.id).done && store.inbox(2, 0).length === 0);
    check("  what happened is kept for the brief (a 'finished' event)", store.events(clock - H, clock).some((e) => e.kind === "finished" && e.session === "Joya Builder"));
    const brief = inb.find((r) => r.kind === "brief");
    check("08:01 in Cairo: the morning brief was written (template: the model did not answer), and says what finished", !!brief && brief.body.source === "template" && /did not answer/.test(brief.body.why) && JSON.stringify(brief.body.lines).includes("Built the invoice export"), JSON.stringify(brief && brief.body));
    check("  the person without JOYA AI gets no brief", !store.inbox(2, 0).some((r) => r.kind === "brief"));
    clock += 3 * M;
    await E.tick();
    await sleep(30);
    check("  once a day: no second brief", store.inbox(1, 0).filter((r) => r.kind === "brief").length === 1 && mem.prepare("SELECT count(*) n FROM proactive_inbox WHERE kind='brief'").get().n === 1);
    // The next day, the model: grounded words are used; invented ones are not.
    const day2 = () => { clock = Date.parse("2026-10-21T05:00:30Z"); };
    day2();
    writerOut = "Finished: Joya Builder built the invoice export.\nSpend: ≈ $12.00 today.";
    await E.tick();
    await sleep(30);
    let b2 = store.lastOf(1, "brief");
    check("the next day at 08:00: the model's words, grounded, are used (source model)", b2.body.source === "model" && b2.body.lines.some((l) => /≈ \$12\.00/.test(l.text)) && writerCalls >= 2, JSON.stringify(b2.body));
    store.setPrefs(1, { last_brief_day: null });
    writerOut = "Finished: Joya Builder built 4 exports.\nSpend: ≈ $12.00 today.";
    await E.writeBrief(users[0], store.prefs(1, "Africa/Cairo"), "asked");
    b2 = store.lastOf(1, "brief");
    check("  a number the facts do not hold (4 exports): the template instead, and why", b2.body.source === "template" && /number 4 is not in the facts/.test(b2.body.why), b2.body.why);
    voiceOn.on = false;
    const n0 = writerCalls;
    await E.writeBrief(users[0], store.prefs(1, "Africa/Cairo"), "asked");
    check("  voice off: no model call, the template", writerCalls === n0 && store.lastOf(1, "brief").body.why === "voice is off");
    check("  a newer brief replaces the one not yet dismissed (one card)", store.inbox(1, 0).filter((r) => r.kind === "brief").length === 1);
    // Due times: days, the person's zone, late but not too late.
    const due = (iso, pr) => E.briefDue(Object.assign({ brief_on: true, brief_time: "08:00", brief_days: P.ALL_DAYS, tz: "Africa/Cairo", last_brief_day: null }, pr), Date.parse(iso));
    check("due: 08:00 in the person's zone (London 08:00 = 07:00 UTC), not before", due("2026-10-20T07:00:00Z", { tz: "Europe/London" }) && !due("2026-10-20T06:59:00Z", { tz: "Europe/London" }));
    check("  a brief missed while the panel was down: up to 6 h late, not later", due("2026-10-20T10:30:00Z", {}) && !due("2026-10-20T11:30:00Z", {}));
    check("  not on a day left out; not when switched off; not twice a day", !due("2026-10-20T06:00:00Z", { brief_days: [1] }) && !due("2026-10-20T06:00:00Z", { brief_on: false }) && !due("2026-10-20T06:00:00Z", { last_brief_day: "2026-10-20" }));
    // While you were away.
    clock = Date.parse("2026-10-21T09:00:00Z");
    check("the first activity: nothing to catch up on", (await E.seen(users[0])) === null);
    clock += 10 * M;
    check("  back after 10 min: not away", (await E.seen(users[0])) === null);
    clock += 45 * M;
    check("  back after 45 min, nothing happened: no card", (await E.seen(users[0])) === null);
    clock += 50 * M;
    sup.sessions.push({ name: "Customs docs", session_id: "c1", status: "waiting", status_since: new Date(clock - 20 * M).toISOString(), waiting_for: "the rates" });
    sup.delegations.push({ id: 7, target_name: "Invoice audit", status: "failed", summary: "Check invoices", updated_at: new Date(clock - 5 * M).toISOString(), failed_at: new Date(clock - 5 * M).toISOString(), created_at: new Date(clock - 30 * M).toISOString() });
    const cu = await E.seen(users[0]);
    check("  back after 50 min with news: 'While you were away · 50 min', what failed and who waits", !!cu && cu.title === "While you were away · 50 min" && JSON.stringify(cu.body.lines).includes("Invoice audit") && JSON.stringify(cu.body.lines).includes("Customs docs is waiting on you"), JSON.stringify(cu));
    check("  shown once: the next activity is not 'away'", (await E.seen(users[0])) === null);
  }

  /* ================================================================ 4. the real server */
  const W = {
    seq: 1,
    sessions: [
      { self: true, name: "JOYA AI", pid: 100, session_id: "aaaaaaaa-0000-4000-8000-000000000000", status: "idle", status_since: new Date().toISOString() },
      { name: "Planning engine", pid: 201, session_id: "bbbbbbbb-0000-4000-8000-000000000001", status: "busy", status_since: new Date(Date.now() - 95 * M).toISOString(), where: "~/joya", tokens_today: { total: 2.1e6 }, cost_today_usd_est: 9.5 },
      { name: "Customs docs", pid: 202, session_id: "bbbbbbbb-0000-4000-8000-000000000002", status: "waiting", status_since: new Date(Date.now() - 25 * M).toISOString(), waiting_for: "the October rates", where: "~/customs" },
      { name: "Invoice audit", pid: 203, session_id: "bbbbbbbb-0000-4000-8000-000000000003", status: "idle", status_since: new Date(Date.now() - 3 * H).toISOString(), where: "~/audit", open_delegations: 1 },
    ],
    approvals: [],
    inbound: [{ id: 7, kind: "idle", from_name: "Freight quotes", text: "Sent the three quotes for the Rotterdam lane.", received_at: new Date(Date.now() - 5 * H).toISOString(), delegation_id: 3 }],
    delegations: [{ id: 3, target_name: "Invoice audit", target: "Invoice audit", status: "failed", summary: "Check the October invoices", note: "the session ended", created_at: new Date(Date.now() - 6 * H).toISOString(), failed_at: new Date(Date.now() - 4 * H).toISOString(), updated_at: new Date(Date.now() - 4 * H).toISOString() }],
    caps: { day: "2026-10-20", warn_pct: 80, held: 0, sessions: [{ key: "<self>", name: "JOYA AI", kind: "self", cap: 5e6, at: "pause", today: { total: 4.1e6 }, state: "near" }, { key: "x", name: "Planning engine", kind: "hired", cap: 8e6, today: { total: 2.1e6 }, state: "ok" }] },
  };
  const SOCK = path.join(scratch.DATA, "fake-joya-ai-proactive.sock");
  const streams = new Set();
  const server = net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.op === "events") { streams.add(c); c.on("close", () => streams.delete(c)); continue; }
        let data = {};
        if (m.op === "status") data = { name: "JOYA AI", seq: W.seq, process: { state: "ready", pid: 100, tz: "Africa/Cairo" }, session_id: W.sessions[0].session_id, approvals: W.approvals, tokens_today: { total: 4.1e6 }, cost_today: { total_usd: 14.2, joya_ai_usd: 3.1, budget_usd: null, warn_pct: 80 }, counts: { decisions_open: 0 } };
        else if (m.op === "sessions") data = { sessions: W.sessions };
        else if (m.op === "token-caps") data = W.caps;
        else if (m.op === "ledger") data = { rows: W[m.table] || [] };
        else if (m.op === "missions") data = { missions: [] };
        else if (m.op === "decisions") data = { decisions: [] };
        else if (m.op === "orders") data = { orders: [] };
        else if (m.op === "watchers") data = { watchers: [] };
        c.write(JSON.stringify({ id: m.id, ok: true, data }) + "\n");
      }
    });
    c.on("error", () => {});
  });
  await new Promise((r) => server.listen(SOCK, r));
  const PORT = 3720 + Math.floor(Math.random() * 60);
  const ORIGIN = `http://a.localhost:${PORT}`;
  let s, browser;
  const problems = [];
  try {
    s = await scratch.startScratch({ port: PORT, env: { JOYA_AI_SOCKET: SOCK, JOYA_PASSKEY_ORIGINS: ORIGIN, JOYA_PROACTIVE_TICK_MS: "700" } });
    await s.makeUser("alice", "administrator");
    await s.makeUser("bob", "joyauser", ["joyaai.use"]);
    await s.makeUser("vic", "viewer");
    const A = await s.signIn("alice"), B = await s.signIn("bob"), Vw = await s.signIn("vic");
    const page = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    const csrfA = s.csrfOf(page.body);
    const csrfB = s.csrfOf((await s.req("GET", "/joya-ai", { cookie: B.cookie })).body);
    const J = (r) => { try { return JSON.parse(r.body); } catch (_) { return {}; } };
    const post = (who, csrf, p, body) => s.req("POST", "/joya-ai/api/proactive" + p, { cookie: who.cookie, headers: { "X-CSRF-Token": csrf }, body: body || {} });

    section("the API on the real server");
    check("the Command Center loads the page's half (joya-proactive.js / .css)", /joya-proactive\.js/.test(page.body) && /joya-proactive\.css/.test(page.body));
    check("a viewer without JOYA AI: 403", (await s.req("GET", "/joya-ai/api/proactive", { cookie: Vw.cookie })).status === 403);
    check("a write without the CSRF token: 403", (await s.req("POST", "/joya-ai/api/proactive/watchers", { cookie: A.cookie, body: { text: "tell me when planning finishes" } })).status === 403);
    let r = await post(A, csrfA, "/parse", { text: "tell me when the planning session finishes" });
    check("parse: the words -> the watcher it would be, the live session found", J(r).ok && J(r).spec.params.session === "Planning engine" && J(r).text === "When Planning engine finishes · once", r.body);
    r = await post(A, csrfA, "/watchers", { text: "tell me when the planning session finishes" });
    const wid = J(r).watcher && J(r).watcher.id;
    check("add from words", r.status === 200 && J(r).watcher.kind === "session_done" && J(r).count === 1 && J(r).max === 50, r.body);
    r = await post(A, csrfA, "/watchers", { spec: { kind: "session_done", params: { session: "x" }, action: "rm -rf /" } });
    check("add a spec with an action: refused (400)", r.status === 400 && /only notify/.test(J(r).error), r.body);
    r = await post(B, csrfB, "/watchers/" + wid + "/pause", { paused: true });
    check("another person cannot pause or delete it (404)", r.status === 404 && (await post(B, csrfB, "/watchers/" + wid + "/delete")).status === 404);
    check("  nor see it", !(J(await s.req("GET", "/joya-ai/api/proactive", { cookie: B.cookie })).watchers || []).length);
    r = await post(A, csrfA, "/watchers/" + wid + "/pause", { paused: true });
    check("pause it / resume it", J(r).watcher.paused === true && J(await post(A, csrfA, "/watchers/" + wid + "/pause", { paused: false })).watcher.paused === false);
    for (let i = 0; i < 49; i++) await post(B, csrfB, "/watchers", { spec: { kind: "session_ends", params: { session: "s" + i } } });
    const r50 = await post(B, csrfB, "/watchers", { spec: { kind: "session_ends", params: { session: "last" } } });
    const r51 = await post(B, csrfB, "/watchers", { spec: { kind: "session_ends", params: { session: "over" } } });
    check("the 50th is taken, the 51st refused (409, 'the most there can be')", r50.status === 200 && J(r50).count === 50 && r51.status === 409 && /50 watchers/.test(J(r51).error), r51.body);
    r = await post(A, csrfA, "/prefs", { brief_time: "07:30", brief_days: [0, 1, 2, 3, 4], tz: "Europe/London", read_aloud: true });
    check("settings saved and read back", J(r).prefs && J(r).prefs.brief_time === "07:30" && J(r).prefs.tz === "Europe/London" && J(r).prefs.read_aloud === true && J(r).prefs.brief_days.join() === "0,1,2,3,4", r.body);
    check("  a bad zone refused", (await post(A, csrfA, "/prefs", { tz: "Nowhere/City" })).status === 400);
    r = await post(A, csrfA, "/brief-now", {});
    check("brief now: written from the fake supervisor's data", r.status === 200 && J(r).item.kind === "brief" && /Needs you/.test(JSON.stringify(J(r).item.body.lines)) && /Invoice audit/.test(JSON.stringify(J(r).item.body.lines)), r.body.slice(0, 600));
    check("  at most one a minute (429)", (await post(A, csrfA, "/brief-now", {})).status === 429);
    const bid = J(r).item.id;
    check("dismiss: one's own only", (await post(B, csrfB, "/inbox/" + bid + "/dismiss")).status === 404 && (await post(A, csrfA, "/inbox/" + bid + "/dismiss")).status === 200 && !J(await s.req("GET", "/joya-ai/api/proactive", { cookie: A.cookie })).inbox.some((x) => x.id === bid));

    section("Settings ▸ Briefs & watchers");
    const sp = await s.req("GET", "/joya-ai/settings/proactive", { cookie: B.cookie });
    check("a person with JOYA AI (not an admin) opens it: their brief, the catch-up, their watchers (50 of 50)", sp.status === 200 && /Morning brief/.test(sp.body) && /While you were away/.test(sp.body) && /50 of 50/.test(sp.body) && /When s0 ends/.test(sp.body), sp.status);
    check("  the add box is disabled at 50", /placeholder="Tell me when…"[^>]*disabled/.test(sp.body));
    check("  a viewer cannot", (await s.req("GET", "/joya-ai/settings/proactive", { cookie: Vw.cookie })).status !== 200);
    const sa = await s.req("GET", "/joya-ai/settings/proactive", { cookie: A.cookie });
    const fcsrf = (/name="_csrf" value="([^"]+)"/.exec(sa.body) || [])[1];
    const form = (who, p, kv) => s.req("POST", "/joya-ai/settings/proactive/" + p, { cookie: who.cookie, headers: { Accept: "application/json", "X-Requested-With": "fetch" }, body: new URLSearchParams(Object.assign({ _csrf: fcsrf }, kv)).toString() });
    r = await form(A, "watch", { text: "alert me if spend passes $10 today" });
    check("the add box takes plain words", J(r).ok && /Watching: When today(&#39;|')s spend passes \$10\.00/.test(J(r).flash) && J(r).reload, r.body);
    r = await form(A, "days", { days: "1" });
    check("the days form", J(r).ok && /Mon/.test(J(r).flash), r.body);
    r = await form(A, "time", { time: "9am" });
    check("  a bad time: refused with a note", !J(r).ok && /HH:MM/.test(J(r).flash));
    check("the section is listed in Settings for both", /href="\/joya-ai\/settings\/proactive"/.test(sp.body) && /href="\/joya-ai\/settings\/proactive"/.test(sa.body));

    section("the clock on the real server: a watcher fires");
    // The spend watcher ($10, Alice): today's spend is $14.20, so the next look fires it.
    let fired = null;
    for (let i = 0; i < 30 && !fired; i++) {
      await sleep(300);
      fired = (J(await s.req("GET", "/joya-ai/api/proactive/inbox?after=0", { cookie: A.cookie })).items || []).find((x) => x.kind === "watch");
    }
    check("the spend watcher fired: 'Today's spend passed $10.00: ≈ $14.20 so far.'", fired && fired.body.text === "Today's spend passed $10.00: ≈ $14.20 so far.", JSON.stringify(fired));
    W.sessions[1] = Object.assign({}, W.sessions[1], { status: "idle", status_since: new Date().toISOString() });
    let done = null;
    for (let i = 0; i < 30 && !done; i++) {
      await sleep(300);
      done = (J(await s.req("GET", "/joya-ai/api/proactive/inbox?after=0", { cookie: A.cookie })).items || []).find((x) => x.kind === "watch" && /Planning engine finished/.test(x.body.text));
    }
    check("Planning engine went idle: 'Planning engine finished after 1 h 3x min of work.'", done && /Planning engine finished after 1 h \d+ min of work\./.test(done.body.text), JSON.stringify(done));
    W.sessions[1] = Object.assign({}, W.sessions[1], { status: "busy", status_since: new Date(Date.now() - 95 * M).toISOString() });

    /* ================================================================ 5. the browser */
    const PW = process.env.PLAYWRIGHT || "playwright";
    let chromium = null;
    try { ({ chromium } = require(PW)); } catch (e) { check("playwright is there (set PLAYWRIGHT)", false, e.message); }
    if (chromium) {
      browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
      const sqlite = require("better-sqlite3");
      const db = new sqlite(path.join(s.data, "joya.db"));
      const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
      const put = (kind, title, body, agoMs) => db.prepare("INSERT INTO proactive_inbox (user_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?)").run(aliceId, kind, title, JSON.stringify(body), new Date(Date.now() - (agoMs || 0)).toISOString()).lastInsertRowid;
      async function open(w, h, q, o) {
        o = o || {};
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: o.theme || "dark", userAgent: o.desk ? APP_UA : undefined, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
        const pg = await ctx.newPage();
        await pg.addInitScript((a) => {
          try { localStorage.setItem("joya-theme", a.theme); } catch (e) { /* storage */ }
          window.__csp = [];
          document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
          if (!a.desk) return;
          window.__calls = [];
          const L = (window.__listeners = {});
          window.__TAURI__ = {
            core: { invoke: (cmd, args) => { window.__calls.push([cmd, args || {}]); return Promise.resolve(cmd === "get_state" ? a.host : null); } },
            event: { listen: (n, f) => { (L[n] = L[n] || []).push(f); return Promise.resolve(() => {}); } },
          };
          window.__emit = (n, p) => (L[n] || []).forEach((f) => f({ payload: p }));
        }, { theme: o.theme || "dark", desk: !!o.desk, host: o.host || null });
        const tag = q + " " + (o.theme || "dark");
        pg.on("pageerror", (e) => problems.push(tag + ": pageerror " + e.message));
        pg.on("console", (m) => { if (m.type() === "error" && !/status of (428|404|503|409|429)|Failed to load resource|EventSource/.test(m.text())) problems.push(tag + ": console " + m.text()); });
        await pg.goto(ORIGIN + "/joya-ai" + q, { waitUntil: "load" });
        await pg.waitForFunction(() => window.__joyaCC && window.__joyaCC.S && window.__joyaCC.S.online && window.JoyaProactive && window.JoyaProactive.state.loaded, null, { timeout: 15000 });
        await pg.waitForTimeout(600);
        return { ctx, page: pg, close: async () => { const c = await pg.evaluate(() => window.__csp).catch(() => []); c.forEach((x) => problems.push(tag + ": CSP " + x)); await ctx.close(); } };
      }
      const shot = async (pg, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(SHOTS, name + ".png") }); };
      // The brief to show: written by the real server from the fake supervisor's data.
      db.prepare("UPDATE proactive_inbox SET dismissed_at = ? WHERE user_id = ? AND kind IN ('brief','catchup')").run(new Date().toISOString(), aliceId);
      db.prepare("UPDATE proactive_prefs SET brief_time = '08:00', brief_days = '0,1,2,3,4,5,6', tz = 'Africa/Cairo', read_aloud = 0 WHERE user_id = ?").run(aliceId);
      // The brief the real server wrote above ("brief now"), shown again.
      const briefId = bid;
      db.prepare("UPDATE proactive_inbox SET dismissed_at = NULL WHERE id = ?").run(briefId);

      section("the browser: the Command Center");
      for (const theme of ["dark", "light"]) {
        const v = await open(1440, 900, "", { theme });
        const card = await v.page.evaluate(() => { const c = document.getElementById("pa-card"); return c ? { text: c.innerText, r: c.getBoundingClientRect().toJSON() } : null; });
        check(`${theme}: the brief card shows, top left, its lines from the data`, card && /Morning brief/.test(card.text) && /Needs you/.test(card.text) && /Invoice audit/.test(card.text) && card.r.x < 120 && card.r.y < 140, JSON.stringify(card));
        const feed = await v.page.evaluate(() => window.__joyaCC.S.feed.filter((f) => f.kind === "watch" || f.kind === "brief").map((f) => f.kind + ":" + f.html));
        check(`${theme}: today's watcher alerts and the brief are in the Live feed (as history)`, feed.some((f) => /^watch:<b>Watcher<\/b> · Today(&#39;|')s spend passed/.test(f)) && feed.some((f) => /^brief:/.test(f)), JSON.stringify(feed));
        await shot(v.page, `cc-brief-${theme}`);
        // Joins: a session's line opens its story; a watcher alert chirps (JoyaSound) and its toast links the story.
        await v.page.evaluate(() => { window.__calls = []; window.JoyaStory.open = (sid, t) => { window.__calls.push(["story", sid, t]); return true; }; const p = window.JoyaSound.play; window.JoyaSound.play = (n, o) => { window.__calls.push(["sound", n, o && o.role]); return p.call(window.JoyaSound, n, o); }; });
        if (theme === "dark") {
          const st = await v.page.evaluate(() => [...document.querySelectorAll('#pa-card [data-pa="story"]')].map((b) => b.textContent + "=" + b.getAttribute("data-sid")));
          check("dark: a brief line about one session links its story (its id)", st.some((x) => /^Planning engine=bbbbbbbb-0000-4000-8000-000000000001$/.test(x)) && !st.some((x) => /^(Needs you|Spend|Finished|Failed)=/.test(x)), JSON.stringify(st));
          if (st.length) { await v.page.click('#pa-card [data-pa="story"]'); check("  clicking it opens JoyaStory at the window's start", await v.page.evaluate(() => window.__calls.some((c) => c[0] === "story" && /^[0-9a-f-]{36}$/.test(c[1]) && /^\d{4}-\d\d-\d\dT/.test(c[2] || "")))); }
        }
        // A watcher fires while the page is open.
        const wt = theme === "dark" ? ["Customs docs has been waiting on you 26 min (for the October rates).", "When any session waits on you 10 min or more · once"] : ["Invoice audit wrote “done”: Done — 214 invoices checked, 3 flagged.", "When any session writes “done” · every time"];
        put("watch", wt[0], { text: wt[0], watcher: wt[1], session: theme === "dark" ? "bbbbbbbb-0000-4000-8000-000000000002" : null });
        await v.page.evaluate(() => window.JoyaProactive.poll());
        await v.page.waitForSelector(".pa-toast", { timeout: 4000 }).catch(() => {});
        const toast = await v.page.evaluate(() => { const t = document.querySelector(".pa-toast"); return t ? t.innerText : null; });
        check(`${theme}: a watcher firing: a toast with the alert and the watcher, and a new line in the Live feed`, toast && toast.includes(wt[0]) && toast.includes(wt[1]) && (await v.page.evaluate(() => window.__joyaCC.S.feed[0].kind)) === "watch", toast);
        check(`${theme}: the alert asks JoyaSound for 'needs' (JOYA AI's voice)`, await v.page.evaluate(() => window.__calls.some((c) => c[0] === "sound" && c[1] === "needs" && c[2] === "core")));
        const tb = await v.page.evaluate(() => { const b = document.querySelector(".pa-toast .pa-b"); return b ? b.textContent : null; });
        if (theme === "dark") {
          check("  a toast about one session has a Story button that opens it", tb === "Story" && (await v.page.evaluate(() => { document.querySelector(".pa-toast .pa-b").click(); return window.__calls.some((c) => c[0] === "story" && c[1] === "bbbbbbbb-0000-4000-8000-000000000002"); })));
        } else check("  a toast with no session has no Story button", tb === null, tb);
        await v.page.waitForTimeout(450); // the slide-in done
        await shot(v.page, `cc-watcher-fires-${theme}`);
        // The composer: "tell me when ..." -> Set a watcher?
        await v.page.fill("#cc-input", "tell me when Customs docs finishes");
        await v.page.press("#cc-input", "Enter");
        await v.page.waitForSelector("#pa-offer", { timeout: 4000 }).catch(() => {});
        const offer = await v.page.evaluate(() => { const o = document.getElementById("pa-offer"); return o ? o.innerText : null; });
        check(`${theme}: the composer offers a watcher first, and sends nothing to JOYA AI yet`, offer && /Set a watcher\?/i.test(offer) && /When Customs docs finishes · once/.test(offer) && /Send to JOYA AI instead/.test(offer), offer);
        await v.page.waitForTimeout(450); // the slide-in done
        await shot(v.page, `cc-set-watcher-${theme}`);
        if (theme === "dark") {
          await v.page.click('#pa-offer [data-o="set"]');
          await v.page.waitForFunction(() => /watching/i.test((document.getElementById("pa-offer") || {}).innerText || ""), null, { timeout: 4000 }).catch(() => {});
          check("  Set watcher: it is set ('Watching'), the composer cleared", /watching/i.test(await v.page.evaluate(() => document.getElementById("pa-offer").innerText)) && (await v.page.inputValue("#cc-input")) === "");
        } else await v.page.click('#pa-offer [data-o="close"]');
        await v.close();
      }
      // The catch-up card.
      const cuId = put("catchup", "While you were away · 1 h 40 min", { lines: [{ k: "Needs you", text: "Customs docs is waiting on you 25 min (for the October rates)", tone: "warn" }, { k: "Failed", text: "Invoice audit: Check the October invoices — the session ended", tone: "err" }, { k: "Watchers", text: "Today's spend passed $10.00: ≈ $14.20 so far.", tone: "warn" }, { k: "Spend", text: "≈ $3.40 while away, ≈ $14.20 today · JOYA AI 4.1M of 5.0M tokens (82%)", tone: "warn" }], source: "template", speech: "x" });
      for (const theme of ["dark", "light"]) {
        const v = await open(1440, 900, "", { theme });
        const t = await v.page.evaluate(() => document.getElementById("pa-card").innerText);
        check(`${theme}: the catch-up card (the newest) shows`, /While you were away/.test(t) && /1 h 40 min/.test(t) && /Invoice audit/.test(t), t);
        await shot(v.page, `cc-catchup-${theme}`);
        if (theme === "light") {
          await v.page.click('#pa-card [data-pa="dismiss"]');
          await v.page.waitForTimeout(300);
          check("  Dismiss: the card goes (the brief, still not dismissed, comes next)", /Morning brief/.test(await v.page.evaluate(() => (document.getElementById("pa-card") || {}).innerText || "")));
          const row = db.prepare("SELECT dismissed_at FROM proactive_inbox WHERE id = ?").get(cuId);
          check("  and it is dismissed on the server (every device)", !!row.dismissed_at);
        }
        await v.close();
      }
      // Phone width.
      {
        const v = await open(390, 844, "", { theme: "dark" });
        const r = await v.page.evaluate(() => document.getElementById("pa-card").getBoundingClientRect().toJSON());
        check("a phone: the card spans the width with 12 px margins, no sideways scroll", Math.round(r.x) === 12 && Math.round(r.right) === 378 && (await v.page.evaluate(() => document.documentElement.scrollWidth <= 390)), JSON.stringify(r));
        await shot(v.page, "cc-brief-phone-dark");
        await v.close();
      }

      section("the browser: Settings ▸ Briefs & watchers");
      for (const theme of ["dark", "light"]) {
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 1180 }, colorScheme: theme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
        const pg = await ctx.newPage();
        await pg.addInitScript((t) => { try { localStorage.setItem("joya-theme", t); } catch (e) { /* storage */ } }, theme);
        pg.on("pageerror", (e) => problems.push("settings " + theme + ": " + e.message));
        await pg.goto(ORIGIN + "/joya-ai/settings/proactive#pa-watchers", { waitUntil: "load" });
        await pg.waitForTimeout(300);
        const txt = await pg.evaluate(() => document.getElementById("pa-watchers").innerText);
        check(`${theme}: the watchers list, with state, last alert, pause and delete`, /When Planning engine finishes · once/.test(txt) && /When today's spend passes \$10\.00/.test(txt) && /fired once/.test(txt) && /(Pause|Resume|Watch again)/.test(txt), txt.slice(0, 400));
        if (SHOTS) {
          await pg.evaluate(() => { const g = document.getElementById("pa-watchers"); if (g) g.scrollIntoView({ block: "start" }); });
          await pg.screenshot({ path: path.join(SHOTS, `settings-watchers-${theme}.png`) });
          await pg.evaluate(() => { const m = document.querySelector("main.content") || document.scrollingElement; m.scrollTo(0, 0); window.scrollTo(0, 0); });
          await pg.screenshot({ path: path.join(SHOTS, `settings-brief-${theme}.png`) });
        }
        if (theme === "dark") {
          await pg.fill('#pa-add input[name="text"]', "watch for a session waiting on me more than 15 minutes");
          await pg.click('#pa-add button[type="submit"]');
          await pg.waitForLoadState("load");
          await pg.waitForFunction(() => /15 min or more/.test(document.getElementById("pa-watchers").innerText), null, { timeout: 5000 }).catch(() => {});
          check("  added from the box (the page reloads with it)", /When any session waits on you 15 min or more/.test(await pg.evaluate(() => document.getElementById("pa-watchers").innerText)));
        }
        await ctx.close();
      }

      section("the browser: the desktop app (?shell=desktop, a mocked app bridge)");
      // A fresh brief for the desktop shots, not dismissed.
      db.prepare("UPDATE proactive_inbox SET dismissed_at = NULL WHERE id = ?").run(briefId);
      for (const theme of ["dark", "light"]) {
        const host = { mode: "floating", focus: false, size: "m", pos: "br", ink: theme === "light" ? "dark" : "light", opacity: 100, still: false, peekOpen: false, talkKey: "Ctrl+Space", liveKey: "Ctrl+Alt+L", hidden: false, glass: false, glance: true, glancePin: null };
        const v = await open(748, 860, "?shell=desktop&mode=floating&glance=1", { theme, desk: true, host });
        await v.page.waitForFunction(() => document.querySelector("#dk-gl-cards .dk-gl-pa"), null, { timeout: 6000 }).catch(() => {});
        const gl = await v.page.evaluate(() => { const c = document.querySelector("#dk-gl-cards .dk-gl-pa"); const first = document.querySelector("#dk-gl-cards > *"); return c ? { text: c.innerText, first: first === c } : null; });
        check(`${theme}: the brief is the first glance card, four lines and '+N more'`, gl && gl.first && /Morning brief/i.test(gl.text) && /Needs you/.test(gl.text) && /more/.test(gl.text), JSON.stringify(gl));
        check(`${theme}: no Command Center card in the app (the glance card is it)`, (await v.page.evaluate(() => { const c = document.getElementById("pa-card"); return !c || getComputedStyle(c).display === "none"; })));
        await shot(v.page, `desktop-brief-glance-${theme}`);
        // A watcher fires: the glance's Live card and the Windows toast.
        const ft = theme === "dark" ? "Planning engine finished after 1 h 35 min of work." : "Joya Builder finished after 2 h 10 min of work.";
        const fid = put("watch", ft, { text: ft, watcher: "When " + ft.split(" finished")[0] + " finishes · once" });
        await v.page.evaluate(() => window.JoyaProactive.poll());
        await v.page.waitForTimeout(500);
        const live = await v.page.evaluate(() => (document.querySelector("#dk-gl-cards .dk-gl-al") || {}).innerText || "");
        const calls = await v.page.evaluate(() => window.__calls.filter((c) => c[0] === "needs_you"));
        check(`${theme}: the alert is in the glance's Live card`, live.includes(ft), live);
        check(`${theme}: and the app is asked for its toast (negative id, title, body)`, calls.some((c) => c[1].id === -(1000000 + Number(fid)) && /watcher/.test(c[1].title) && c[1].body.includes(ft)), JSON.stringify(calls));
        await v.page.waitForTimeout(450); // the slide-in done
        await shot(v.page, `desktop-watcher-fires-${theme}`);
        if (theme === "dark") {
          await v.page.click('#dk-gl-cards [data-gl-pa-more]');
          await v.page.waitForTimeout(150);
          check("  '+N more' opens the rest", /Less/.test(await v.page.evaluate(() => document.querySelector("#dk-gl-cards .dk-gl-pa").innerText)));
          await shot(v.page, "desktop-brief-open-dark");
          await v.page.evaluate((id) => window.__emit("joya://toast-deny", { id: -(1000000 + id) }), briefId);
          await v.page.waitForTimeout(400);
          check("  the toast's second button on the brief's toast dismisses it (never denies an approval)", !(await v.page.evaluate(() => !!document.querySelector("#dk-gl-cards .dk-gl-pa"))) && !!db.prepare("SELECT dismissed_at FROM proactive_inbox WHERE id = ?").get(briefId).dismissed_at);
          db.prepare("UPDATE proactive_inbox SET dismissed_at = NULL WHERE id = ?").run(briefId);
        }
        await v.close();
      }
      check("no page errors, console errors or CSP violations", problems.length === 0, problems.join("\n"));
    }
  } catch (e) {
    check("the run itself", false, e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (s) s.stop();
    server.close();
  }
  finish();
})();
