#!/usr/bin/env node
"use strict";
/**
 * The simplified Command Center's logic and wiring (public/cc-logic.js, the
 * page scripts, lib/views-joyaai.js).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-cc-logic.cjs
 *
 *   - caption / core state: what the core shows and the one line under it say,
 *     from real events (turn step, delegation target, the spoken sentence, the
 *     microphone, anything that needs you);
 *   - the decision card: which items, in what order, and each button -> the
 *     existing API route it calls;
 *   - the dock's sheets and the data each one is filled with;
 *   - "nothing lost": every API call, control, overlay, shortcut and voice path
 *     of the v3 page is still reachable in the new client code.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const L = require(path.join(ROOT, "public", "cc-logic.js"));
const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const main = read("public/joya-ai.js"), panels = read("public/cc-panels.js"), map = read("public/cc-map.js"), server = read("server.js");
const client = main + "\n" + panels + "\n" + map;

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
function section(t) { console.log("\n" + t); }

/* ------------------------------------------------------ caption and state */
section("caption and core state, from events");
const base = { online: true, listening: false, speaking: false, voiceLive: false, busy: false, pending: 0, delegatingTo: "", lastReply: "" };
const cap = (o) => L.caption(Object.assign({}, base, o));

let c = cap({ lastReply: "Stale requests will be listed, not counted." });
check("idle: Ready, and the gist of the last reply", c.state === "idle" && c.label === "Ready" && c.text === "Stale requests will be listed, not counted.", JSON.stringify(c));
check("idle with nothing said yet", cap({}).text === "Ready when you are.");
c = cap({ online: false, offlineMsg: "JOYA AI's supervisor is not running" });
check("offline: says so, and why", c.label === "Offline" && /supervisor is not running/.test(c.text) && c.state === "idle");
c = cap({ busy: true, stepText: "Reading the live server summary" });
check("a running turn: Thinking, with its current step", c.state === "thinking" && c.label === "Thinking" && c.text === "Reading the live server summary…", JSON.stringify(c));
c = cap({ busy: true, streamText: "Looking now. The plan is recomputed: 91 tonnes to buy. Open requests cover the rest" });
check("…and while the reply streams, its latest whole sentence", c.text === "The plan is recomputed: 91 tonnes to buy.", c.text);
c = cap({ busy: true, waitingOn: "planning-engine", queued: 2 });
check("…waiting on a session it delegated to, with the queue behind it", c.label === "Waiting on planning-engine · 2 queued", c.label);
c = cap({ busy: true, delegatingTo: "planning-engine", delegation: "Recompute the Q4 purchase plan" });
check("a SendMessage just went out: Delegating → the target, with what it said", c.state === "delegating" && c.label === "Delegating → planning-engine" && c.text === "Recompute the Q4 purchase plan", JSON.stringify(c));
check("…the core's state is delegating (the stream flies to that session)", L.coreState(Object.assign({}, base, { busy: true, delegatingTo: "x" })) === "delegating");
c = cap({ listening: true, voiceText: "Listening — release to send" });
check("the microphone: Listening, the voice bar's line, marked interim", c.state === "listening" && c.interim && c.text === "Listening — release to send");
c = cap({ speaking: true, spoken: "The plan is recomputed: 91 tonnes to buy." });
check("speaking: the sentence being read aloud, revealed word by word", c.state === "speaking" && c.words && c.text === "The plan is recomputed: 91 tonnes to buy.");
check("…never the microphone's old line while the first sentence loads", cap({ speaking: true, voiceText: "Listening…" }).text === "…");
c = cap({ pending: 3, needTitle: "Upgrade 252 modules on the trial box", busy: true });
check("needs you: waiting for you, the first item, how many more", c.state === "needs" && c.label === "Needs you" && c.text === "Waiting for you: upgrade 252 modules on the trial box (2 more).", c.text);
check("needs you wins over a running turn and a delegation", L.coreState(Object.assign({}, base, { pending: 1, busy: true, delegatingTo: "x" })) === "needs");
check("your voice wins over everything (listening, then speaking)", L.coreState(Object.assign({}, base, { pending: 1, listening: true })) === "listening" && L.coreState(Object.assign({}, base, { pending: 1, speaking: true, listening: true })) === "speaking");
c = cap({ voiceLive: true, voiceText: "Transcribing…" });
check("after a recording, before the turn starts: Heard / Transcribing", c.state === "thinking" && c.label === "Heard" && c.text === "Transcribing…" && c.interim);
check("every state is one the core knows", ["idle", "listening", "thinking", "delegating", "speaking", "needs"].join() === L.STATES.join());
check("gist: the first sentence of a markdown reply, as text", L.gist("**Disk** is at 6%. Nothing else.\n- a") === "Disk is at 6%.", L.gist("**Disk** is at 6%. Nothing else.\n- a"));
check("the page feeds the caption from real events (step, delegation, spoken sentence, voice bar)", /stepText: currentStep\(\)/.test(main) && /S\.delegTo = d\.target_name/.test(main) && /Voice\.onSpeak = function \(text\) \{ S\.spoken = text;/.test(main) && /api_\.onSpeak\(said\)/.test(main) && /new MutationObserver\(function \(\) \{ paintCaption\(\); \}\)\.observe\(\$\("cc-vb-text"\)/.test(main));
check("the spoken sentence reaches the caption when its audio starts, not when it is fetched", /setTimeout\(function \(\) \{ if \(my === gen\) api_\.onSpeak\(said\); \}, Math\.max\(0, st\.t\.play - Date\.now\(\)\)\)/.test(main));
check("caption words are revealed through CSSOM, not style attributes", /sp\.style\.animationDelay = /.test(main) && !/style=\\?"/.test(main.replace(/\.style\./g, "")));

/* ------------------------------------------------------ the decision card */
section("the decision card: each button -> its existing API");
const ap = { id: 12, status: "pending", tool: "Bash", input: { command: "rm -rf /tmp/x" }, category: "delete", label: "Deletes files or records", created_at: "2026-09-29T10:00:00Z", expires_at: "2026-09-29T10:10:00Z" };
const dProposed = { id: 7, kind: "watcher", watcher: "disk", status: "proposed", title: "/var/log grew 4.1 GB", proposal: "Rotate now.", fix_command: "logrotate -f /etc/logrotate.conf", last_seen: "2026-09-29T10:05:00Z" };
const dOpen = { id: 8, kind: "watcher", status: "open", title: "nginx failed", last_seen: "2026-09-29T10:06:00Z" };
const dRetire = { id: 9, kind: "retire", status: "proposed", title: "Retire the idle joya-dashboard session", last_seen: "2026-09-29T09:00:00Z" };
const q = L.needQueue([ap, Object.assign({}, ap, { id: 3 }), Object.assign({}, ap, { id: 4, status: "approved" })], [dProposed, dOpen, dRetire, { id: 10, status: "done", kind: "watcher", title: "x" }]);
check("the queue: pending approvals first (oldest first), then open findings (freshest first); done ones never", q.map((x) => x.key).join(" ") === "a3 a12 d8 d7 d9", q.map((x) => x.key).join(" "));
const acts = (item) => L.card(item).actions.map((a) => a.act + (a.path ? "=" + a.path : "") + (a.local ? "(local)" : "")).join(" | ");
check("approval: Approve -> approvals/:id/approve, Deny -> approvals/:id/deny, Always allow (rule dialog), Later",
  acts(q[1]) === "approve=approvals/12/approve | deny=approvals/12/deny | always(local) | later(local)", acts(q[1]));
check("watcher with a proposed fix: Apply fix -> decisions/:id/approve, Dismiss -> decisions/:id/dismiss, Later", acts(q[3]) === "approve=decisions/7/approve | dismiss=decisions/7/dismiss | later(local)", acts(q[3]));
check("open finding: Investigate -> decisions/:id/ask (with the Investigate text), Dismiss, Later",
  acts(q[2]) === "investigate=decisions/8/ask | dismiss=decisions/8/dismiss | later(local)" && L.card(q[2]).actions[0].body.text === "Investigate this and propose a fix.", acts(q[2]));
check("a retire proposal: Retire -> decisions/:id/approve, Keep -> decisions/:id/dismiss, Later", acts(q[4]) === "approve=decisions/9/approve | dismiss=decisions/9/dismiss | later(local)" && L.card(q[4]).actions.map((a) => a.label).join() === "Retire,Keep,Later");
check("labels as the mockup: Approve/Deny, Apply fix/Dismiss, Retire/Keep/Later", L.card(q[1]).actions.map((a) => a.label).slice(0, 2).join() === "Approve,Deny" && L.card(q[3]).actions.map((a) => a.label).join() === "Apply fix,Dismiss,Later");
check("an id is URL-encoded into its route", L.card({ type: "decision", id: "a/b", item: { status: "proposed", title: "t" } }).actions[0].path === "decisions/a%2Fb/approve");
{
  // Every route the card names is one server.js serves (under joyaAiWrite).
  const routes = [/app\.post\("\/joya-ai\/api\/approvals\/:id\/:decision", \.\.\.joyaAiWrite/, /app\.post\("\/joya-ai\/api\/decisions\/:id\/:action", \.\.\.joyaAiWrite/, /\["approve", "dismiss", "ask", "resume"\]\.includes\(action\)/];
  check("every route the card calls exists on the server, behind joyaai.use + CSRF", routes.every((r) => r.test(server)));
  // (Since 2026-10-08 Resume and Approve go through Windows Hello first: lib/stepup.js, decisionStepUp.)
  check("  decisions/:id/resume is the supervisor's budget-resume, after Windows Hello", /if \(action === "resume" \|\| action === "approve"\) \{[\s\S]{0,500}callStepped\(req, action === "resume" \? "budget-resume" : "decision-approve", p\)/.test(server) && /"\/joya-ai\/api\/decisions\/:id\/:action", \.\.\.joyaAiWrite, decisionStepUp,/.test(server));
}
{
  // A daily token cap card (kind "cap"): Resume for today / Leave paused, as the Decisions sheet offers.
  const cap = { id: 21, kind: "cap", status: "open", title: "JOYA AI passed its daily cap", actions: ["resume", "dismiss"], last_seen: "2026-09-29T11:00:00Z" };
  const cq = L.needQueue([], [cap]);
  check("a cap card: Resume for today -> decisions/:id/resume, Leave paused -> dismiss, Later (never Investigate)", acts(cq[0]) === "resume=decisions/21/resume | dismiss=decisions/21/dismiss | later(local)" && L.card(cq[0]).actions.map((a) => a.label).join() === "Resume for today,Leave paused,Later", acts(cq[0]));
  const warnCap = L.card({ type: "decision", id: 22, key: "d22", item: Object.assign({}, cap, { id: 22, actions: ["dismiss"] }) });
  check("  a warn-only cap (nothing paused): Dismiss and Later only", warnCap.actions.map((a) => a.act).join() === "dismiss,later" && warnCap.actions[0].label === "Dismiss");
  check("  its done text", L.doneText("resume") === "Resumed for today");
  check("the Decisions sheet offers the same two on a cap card", /d\.kind === "cap" && st === "open"/.test(panels) && /data-dact="resume"/.test(panels) && /"Leave paused"/.test(panels));
}
check("the card's click handler posts exactly the action's path and body", /api\(act\.path, \{ body: act\.body \}\)/.test(main) && /if \(act\.act === "always"\) \{ P\.openAlways\(it\.id\); return; \}/.test(main) && /if \(act\.act === "later"\) \{ closeNeed\(\); return; \}/.test(main));
check("the card pages (1 of N) and the amber pill brings it back", /data-need-pg/.test(main) && /\$\("cc-needpill"\)\.addEventListener\("click"/.test(main));
check("a new approval opens the card (and still says so aloud when voice is on)", /openNeed\("a" \+ a\.id\)/.test(main) && /Voice\.say\("I need your approval before I go on\."\)/.test(main));
check("approvals already waiting on load get the card", /if \(pendingApprovals\(\)\.length\) openNeed\(\);/.test(main));
check("the card counts down an approval's expiry", /data-need-timer/.test(main) && /function tickNeed\(\)/.test(main) && /tickNeed\(\);/.test(main));

/* ------------------------------------------------------ the dock's sheets */
section("the dock's sheets and their data");
const html = views.page({ csrf: "t", user: { name: "a", perm: rbac.actor({ permissions: ["*"] }) }, voice: { configured: true, voice: "marin", manage: true, on: true, use: true, live: true } });
const paneOf = (k) => {
  const i = html.indexOf(`id="cc-pane-${k}"`);
  const n = html.indexOf('<section class="cc-pane"', i + 10);
  const j = n > 0 ? n : html.indexOf("</aside>", i);
  return i < 0 ? "" : html.slice(i, j);
};
const FILL = {
  conv: [["cc-steps", "renderSteps"], ["cc-chat", "paintTurn"], ["cc-rc-text", "renderDrawerHead"]],
  sessions: [["cc-sessions", "renderSessions"], ["cc-stat-deleg", "renderStats"], ["cc-sess-aside", "renderSessions"]],
  missions: [["cc-mis-tabs", "renderMissions"], ["cc-lanes", "renderMissions"], ["cc-mis-head", "renderMissions"]],
  dec: [["cc-dec-list", "renderDecisions"], ["cc-feed", "renderFeed"], ["cc-evlog", "Event log"]],
  tl: [["cc-timeline", "renderTimeline"], ["cc-tl-count", "renderTimeline"]],
  // Standing orders became the Schedules tab of Rules & alerts (2026-10-25): its list lives in that sheet.
  rules: [["cc-rules-pane", "renderRules"], ["cc-orders", "renderOrders"], ["cc-orders-wrap", "renderRules"]],
  cost: [["cc-cost-widget", "renderCostWidget"], ["cc-voice-usage", "renderVoiceUsage"]],
  machine: [["cc-mach-note", "renderMachine"], ["cc-core-grid", "renderCore"], ["cc-mach-badge", "renderMachine"]],
};
for (const k of Object.keys(FILL)) {
  const p = paneOf(k);
  const missing = FILL[k].filter(([id, fn]) => !p.includes(`id="${id}"`) || !(client.includes(`function ${fn}(`) || client.includes(fn)));
  check(`sheet ${k}: holds ${FILL[k].map((x) => "#" + x[0]).join(", ")}, filled by the page`, p && !missing.length, missing.map((x) => x[0]).join(" "));
}
check("the Machine sheet's grid cells are what renderCore writes (data-cell)", /querySelector\('\[data-cell="' \+ key \+ '"\]'\)/.test(main) && (paneOf("machine").match(/data-cell="/g) || []).length === 8);
check("the old #orders key still opens the Schedules tab of Rules & alerts", /if \(id === "orders"\) \{ if \(P\.setRulesSub\) P\.setRulesSub\("orders"\); id = "rules";/.test(main) && !html.includes('id="cc-pane-orders"'));
check("the Missions rail button shows only while a mission is open or running", /railBtn\.hidden = !\(S\.pane === "missions" \|\| missionList\(\)\.some/.test(client));
check("opening a sheet refreshes it (rules, decisions, missions, sessions, conversation)", /if \(id === "rules"\) P\.renderRules\(\);/.test(main) && /if \(id === "dec"\) P\.renderDecisions\(\);/.test(main) && /if \(id === "missions"\) P\.renderMissions\(\);/.test(main) && /if \(id === "sessions"\) renderSessions\(true\);/.test(main));
check("the sessions sheet: JOYA AI as CEO, each session with its sub-agents, Deep view and Message via JOYA AI", /CEO · you talk to it/.test(main) && /cc-subagents/.test(main) && /data-deep-open=/.test(main) && /Message via JOYA AI/.test(main) && /data-at=/.test(main));
check("a session point on the orbit opens the Sessions sheet", /onClick: function \(key\) \{ openSheet\("sessions"\); highlightSess\(key\); \}/.test(main));
check("Escape closes, in order: palette/dialog, menu, reply, sheet, card", /if \(e\.defaultPrevented\) return;/.test(main) && /if \(S\.pane\) \{ closeSheet\(\); return; \}/.test(main));

/* ------------------------------------------------------ nothing lost */
section("nothing lost from v3");
// Every API path the v3 client called (joya-ai.js, cc-panels.js at 26aee75), and where it is used now.
// 2026-09-30: "cost" and "cost/budget" gave way to "usage" -- the administrator asked for the sheet to
// show Claude plan usage and tokens, not money; the (never set) dollar budget went with it.
const API = [
  // 2026-09-30: "transcribe" (push to talk) and "desk/turn", "desk/summary" (the front desk) went: voice is live conversation only.
  "ledger/turns", "ledger/approvals", "ledger/delegations", "ledger/inbound", "overview", "status", "send", "interrupt", "rc", "speak",
  "voice/usage", "missions", "missions/request", "decisions", "watchers", "rules", "rules/test", "orders", "usage",
  "sessions/", "rule-suggestion", "approvals/",
];
const missingApi = API.filter((a) => !new RegExp(`["'/]${a.replace(/[/?]/g, "\\$&")}`).test(client) && !client.includes('"' + a));
check("every API path the v3 page called is still called", missingApi.length === 0, missingApi.join(" "));
check("the event stream and every event type it follows", /new EventSource\("\/joya-ai\/api\/events[?"]/.test(main) && ["proc", "init", "rc", "status", "turn", "text", "assistant", "tool", "tool_result", "steps", "result", "approval", "delegation", "inbound", "sessions", "vitals", "notice", "offline", "mission", "decision", "watcher", "order", "order_run", "rule", "machine"].every((t) => main.includes('"' + t + '"')));
// Every element the client reaches by id exists in the served page (or is built by the client itself).
{
  const built = new Set(["cc-ov", "cc-pal-q", "cc-pal-list", "cc-mis-goal", "cc-mis-err", "cc-mis-go", "cc-al-body", "cc-al-err", "cc-al-save", "cc-al-pat", "cc-al-match", "cc-try-in", "cc-try-btn", "cc-try-res", "cc-ord-form", "cc-ord-side", "cc-ord-foot", "cc-ord-name", "cc-ord-at", "cc-ord-every", "cc-ord-cron", "cc-ord-prompt", "cc-ord-words", "cc-ord-err", "cc-cost-body", "cc-deep-in", "cc-vu-today", "cc-vu-month", "cc-vu-last", "cc-pop-vu"]);
  const ids = new Set();
  for (const m of client.matchAll(/\$\("([a-z0-9-]+)"\)/g)) ids.add(m[1]);
  for (const m of client.matchAll(/getElementById\("([a-z0-9-]+)"\)/g)) ids.add(m[1]);
  const missing = [...ids].filter((id) => !built.has(id) && !html.includes(`id="${id}"`));
  check("every element the page scripts reach by id is in the served page", missing.length === 0, missing.join(" "));
}
const KEEP = [
  ["the composer: send, interrupt, auto-route / @ a session", /\$\("cc-compose"\)\.addEventListener\("submit"/.test(main) && /\$\("cc-stop"\)\.addEventListener\("click"/.test(main) && /function openMenu\(\)/.test(main) && /e\.key === "@" && !input\.value/.test(main)],
  ["voice is live conversation only: the mic starts a call, and during one mutes it (no push to talk, hands-free, Space to talk or front desk)", /LIVE_TIP = "Start a live conversation"/.test(main) && /return LiveUI\.active \? liveMuteToggle\(\) : liveStart\(\);/.test(main) && !/voiceModeFrom|pttDown|desk\/turn|desk\/summary|MODE_KEY/.test(main)],
  ["streamed reader audio (NDJSON PCM chunks)", /Accept: "application\/x-ndjson"/.test(main) && /function playStream\(st, my\)/.test(main)],
  ["barge-in (the live call's interrupt)", /window\.VoiceLive\.interrupt\(\)/.test(main)],
  ["the Full reply's Read aloud (the replies-aloud toggle was removed 2026-10-30)", !/\$\("cc-speak-toggle"\)/.test(main) && /\$\("cc-reply-read"\)\.addEventListener/.test(main) && !/READ_KEY = "joya-read-aloud"/.test(main)],
  ["Remote Control link (claude.ai only) and Interrupt", /function openRemoteControl\(\)/.test(main) && /function interrupt\(btn\)/.test(main)],
  ["the Ctrl+K palette", /String\(e\.key\)\.toLowerCase\(\) === "k"/.test(panels) && /function openPalette\(q\)/.test(panels)],
  ["the session deep view (5 s refresh, Interrupt / Open in Claude for JOYA AI only)", /function openDeep\(key(, opt)?\)/.test(panels) && /data-deep="interrupt"/.test(panels)],
  ["new mission, standing order editor, usage detail, Always allow", /function openNewMission\(goal\)/.test(panels) && /function openOrder\(id\)/.test(panels) && /function openCost\(\)/.test(panels) && /function openAlways\(id\)/.test(panels)],
  ["watchers on/off, rule add/edit/delete/test", /function toggleWatcher\(btn\)/.test(panels) && /api\("rules\/test"/.test(panels) && /"\/delete", \{ body: \{\} \}/.test(panels)],
  ["the active mission chip", /id="cc-mis-chip"/.test(html) && /function renderMisChip\(\)/.test(panels)],
  ["load earlier turns", /Load earlier turns/.test(main)],
  ["the status chip and clock in the top bar", /id="cc-sys"/.test(html) && /id="cc-clock"/.test(html)],
  ["the offline notice", /id="cc-offline"/.test(html) && /off\.hidden = S\.online;/.test(main)],
  ["theme: System / Dark / Light (shell switch, palette, Everything sheet)", /data-theme-to="light"/.test(html) && /Theme: dark/.test(panels)],
];
KEEP.forEach(([name, ok]) => check("kept: " + name, !!ok));

// The composer rests translucent when nothing is going on (hover and focus lift it in CSS).
{
  const b = { online: true, state: "idle", text: false, voice: false, live: false };
  check("composer calm: idle, online, empty, no voice or call -> translucent", L.composerCalm(b) === true);
  check("composer calm: solid with text, a voice turn, a live call, offline, or JOYA AI thinking / speaking / listening / delegating / needing you",
    !L.composerCalm({ ...b, text: true }) && !L.composerCalm({ ...b, voice: true }) && !L.composerCalm({ ...b, live: true }) && !L.composerCalm({ ...b, online: false }) &&
    ["thinking", "speaking", "listening", "delegating", "needs"].every((st) => !L.composerCalm({ ...b, state: st })));
  const css = read("public/joya-ai.css");
  check("composer calm CSS: opacity only (0.6) on the pill and hint row, lifted by hover and focus-within, no transition under reduced motion, no hover lift on touch",
    /\.cc-dock\.calm:not\(:hover\):not\(:focus-within\) \.cc-composer \{ opacity: \.6; \}/.test(css) && /\.cc-dock\.calm:not\(:hover\):not\(:focus-within\) \.cc-hint \{ opacity: \.6; \}/.test(css) &&
    /@media \(hover: none\) \{ \.cc-dock\.calm:hover:not\(:focus-within\) \.cc-composer/.test(css) && /prefers-reduced-motion: reduce\) \{ \.cc-composer, \.cc-hint \{ transition: none; \}/.test(css) &&
    /paintCalm\(st\);/.test(main));
}

// Reload / replay / shell trip: an old reply is never the caption (the administrator's ask, 2026-09-30).
{
  const snap = { online: true, busy: false, pending: 0, lastReply: "" };
  check("no live reply: the caption is the idle line", L.caption(snap).text === "Ready when you are." && L.caption({ ...snap, lastReply: "You're welcome!" }).text === "You're welcome!");
  check("the page: only replies that ended live (not a replay) feed the caption; a trip back from the shell clears them; See last reply stays",
    /lastReply: last && S\.liveReplies\.has\(last\.id\) \? ML\.gist\(aiText\(last\)\) : ""/.test(main) && /if \(!replay\) S\.liveReplies\.add\(row\.id\);/.test(main) &&
    /document\.addEventListener\("joya-shell-full", function \(\) \{ S\.liveReplies\.clear\(\); paintState\(\); \}\);/.test(main) &&
    /document\.dispatchEvent\(new CustomEvent\("joya-shell-full"\)\)/.test(read("public/joya-shell.js")) && /rest \|\| !o\.hasReply \? "See last reply" : "Full reply"/.test(main));
  check("replayed turns never speak: voice read-aloud only for turns this page sent, and only when not a replay",
    /if \(!replay && voiceTurns\.has\(row\.id\)\) \{ Voice\.flush/.test(main) && /if \(!replay && voiceTurns\.has\(ta\.id\)\) Voice\.feed/.test(main));
}

// The last reply rests after 15 s of quiet (the administrator's ask, 2026-09-30).
{
  const b = { state: "idle", online: true, hasReply: true, quietSince: 1000 };
  check("caption rest: 15 s is the constant", L.CAPTION_REST_MS === 15000);
  check("caption rest: shown until 15 s of quiet, then it rests", !L.captionRests({ ...b, now: 1000 + 14999 }) && L.captionRests({ ...b, now: 1000 + 15000 }));
  check("caption rest: never while JOYA AI thinks, speaks, listens, delegates or waits on you",
    ["thinking", "speaking", "listening", "delegating", "needs"].every((st) => !L.captionRests({ ...b, state: st, now: 1e9 }) && L.captionRestIn({ ...b, state: st, now: 1e9 }) === null));
  check("caption rest: never while you type, a voice turn or call is on, the full reply is open, offline, or with no reply to rest",
    !L.captionRests({ ...b, typing: true, now: 1e9 }) && !L.captionRests({ ...b, voice: true, now: 1e9 }) && !L.captionRests({ ...b, replyOpen: true, now: 1e9 }) && !L.captionRests({ ...b, online: false, now: 1e9 }) && !L.captionRests({ ...b, hasReply: false, now: 1e9 }));
  check("caption rest: when to look again", L.captionRestIn({ ...b, now: 6000 }) === 10000 && L.captionRestIn({ ...b, now: 99999 }) === 0);
  check("the page: new caption / non-idle state / typing / focus / closing the reply restart the quiet spell; the line is aria-hidden while it rests; the control says See last reply",
    /if \(c\.state !== "idle" \|\| sig !== capRestSig\) \{ capQuietSince = Date\.now\(\);/.test(main) && /input\.addEventListener\("focus", capActivity\);/.test(main) && /capActivity\(\);\n    paintCalm\(\);\n    fitInput\(\);\n    paintSend\(\);/.test(main) &&
    /line\.setAttribute\("aria-hidden", rest \? "true" : "false"\);/.test(main) && /rest \|\| !o\.hasReply \? "See last reply" : "Full reply"/.test(main) && /\.cc-caption\.rest \.cc-cap-line \{ opacity: 0; max-height: 0; \}/.test(read("public/joya-ai.css")) && /prefers-reduced-motion: reduce\) \{ \.cc-cap-line \{ transition: none; \}/.test(read("public/joya-ai.css")));
}

// Hired sessions (M-6): JOYA AI's retire question is the Keep / Retire consent; a hired session's own
// question says who asks and never offers "Always allow"; the routes are the administrator's, CSRF'd.
{
  const r = L.card({ type: "approval", id: 7, item: { id: 7, tool: "SessionRetire", status: "pending", input: { session: "Demo Worker", slug: "demo-worker" }, origin: "joya-ai", origin_name: "JOYA AI" } });
  check("a retire question: kind Retire, \"Retire the session Demo Worker\", Retire (approve) / Keep (deny), no Always allow",
    r.kind === "Retire" && r.title === "Retire the session Demo Worker" && r.actions[0].label === "Retire" && /approve$/.test(r.actions[0].path) && r.actions[1].label === "Keep" && /deny$/.test(r.actions[1].path) && !r.actions.some((a) => a.act === "always"));
  const h = L.card({ type: "approval", id: 8, item: { id: 8, tool: "Bash", status: "pending", input: { command: "rm -rf /tmp/demo" }, origin: "session:demo-worker", origin_name: "Demo Worker" } });
  check("a hired session's question: says it is from Demo Worker (hired), Approve / Deny, no Always allow", /^From Demo Worker \(hired\)/.test(h.meta) && h.actions.map((a) => a.act).join() === "approve,deny,later", JSON.stringify(h));
  const m = L.card({ type: "approval", id: 9, item: { id: 9, tool: "Bash", status: "pending", input: { command: "rm -rf /tmp/demo" } } });
  check("JOYA AI's own question still offers Always allow", m.actions.some((a) => a.act === "always") && L.approvalFrom({}) === "JOYA AI");
  check("routes: keep and retire a hired session (joyaai.use + CSRF)", /app\.post\("\/joya-ai\/api\/sessions\/:slug\/keep", \.\.\.joyaAiWrite/.test(server) && /app\.post\("\/joya-ai\/api\/sessions\/:slug\/retire", \.\.\.joyaAiWrite/.test(server));
  check("the page: a sphere's menu, the Keep / Retire dialog, keep toggle", /function sessMenu\(key, x, y\)/.test(main) && /function retireDialog\(s\)/.test(main) && /function hireKeep\(s, kept\)/.test(main) && /onMenu: function \(id, x, y\)/.test(map));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
