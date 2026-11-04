#!/usr/bin/env node
"use strict";
/**
 * The session story and the day timeline (2026-10-20).
 *
 *     node dashboard/tools/test-session-story.cjs
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright \
 *       node dashboard/tools/test-session-story.cjs [--shots DIR] [--no-gif]
 *
 *  1. The supervisor's parser (joya-ai/lib/story.js) over transcripts in the CLI's shape: the plan (a
 *     mission's steps, a todo list, the turns), files with +/- from structuredPatch, approvals only where
 *     a person was asked, tokens once per message, active time, incremental reads, the day's lanes and
 *     hand-offs, approvals by origin.
 *  2. The page's pure helpers (public/cc-story.js): the rail at a moment, its window, files by then,
 *     deep links, the replay's spheres.
 *  3. The panel: lib/story-api.js (cleaners, the cache), the routes, the hooks, the assets.
 *  4. With Playwright: a scratch copy of the real server.js and a fake supervisor that runs the real
 *     parser over the fixture world (story-fixture.cjs): the story from a deep link, the moment
 *     scrubber, the day timeline replaying onto the spheres and back to live, keyboard, phone width (no
 *     horizontal scroll), the desktop shell, zero CSP violations and page errors. --shots DIR writes the
 *     preview screenshots and a GIF of scrubbing.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const JOYA = path.join(ROOT, "..", "joya-ai");
const S = require(path.join(JOYA, "lib", "story.js"));
const L = require(path.join(ROOT, "public", "cc-story.js"));
const api = require(path.join(ROOT, "lib", "story-api.js"));
const { buildWorld, transcript, IDS, pinClock } = require("./story-fixture.cjs");
const names = require(path.join(JOYA, "lib", "names.js"));

const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const GIF = !process.argv.includes("--no-gif");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 800) : "")); }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "now" for the fixture: the latest 13:50 in Cairo, at any hour (pinClock: this process's Date; each page gets the
// same through page.clock.setSystemTime, so the page, the parser and the fixture agree).
const SHIFT = pinClock();
const NOW = Date.now();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "story-test-"));

(async () => {
  const W = buildWorld(path.join(TMP, "world"), NOW);
  const mk = (o) => S.createStory({ projectsDir: W.projectsDir, db: W.ledger.db, tz: "Africa/Cairo", sessions: () => W.sessions, selfIds: () => W.selfIds, selfBusy: () => false, describeTool: (n, i) => (n === "Bash" ? "Ran: " + (i.command || "") : n), isSelfName: names.isSelfName, ...(o || {}) });
  const story = mk();

  section("1. the parser (joya-ai/lib/story.js)");
  const pl = await story.sessionStory(IDS.planning);
  check("a session on a mission: its rail is the mission's steps", pl.plan.source === "mission" && pl.plan.mission.ref === "M-3" && pl.plan.steps.length === 5, JSON.stringify(pl.plan.mission));
  check("  statuses from the ledger: done, done, now, next, next", pl.plan.steps.map((s) => s.status).join() === "done,done,now,next,next", pl.plan.steps.map((s) => s.status).join());
  check("  its own steps are marked; JOYA AI's step is not", pl.plan.steps.map((s) => s.mine).join() === "true,true,true,false,true");
  check("  step times are the ledger's started_at / done_at", pl.plan.steps[0].t0 && pl.plan.steps[0].t1 && pl.plan.steps[3].t0 === null);
  const f = Object.fromEntries(pl.files.map((x) => [path.basename(x.path), x]));
  check("files: +/- counted from structuredPatch, two edits of one file add up", f["allocation.py"] && f["allocation.py"].add === 30 && f["allocation.py"].del === 11 && f["allocation.py"].edits === 2, JSON.stringify(f["allocation.py"]));
  check("  a new file (Write, type create) counts its lines as added", f["test_compare.py"] && f["test_compare.py"].add === 58 && f["test_compare.py"].created === true);
  check("  totals", pl.file_totals.add === 30 + 41 + 58 + 12 && pl.file_totals.del === 11 + 3 + 30, JSON.stringify(pl.file_totals));
  check("  latest first", path.basename(pl.files[0].path) === "engine_run.py");
  check("approvals: two asked and approved, one refused (the transcript's permissionDecision)", pl.approvals.filter((a) => a.from === "transcript").map((a) => a.decision).join() === "approved,approved,denied", JSON.stringify(pl.approvals));
  check("  each names its tool and what it ran", pl.approvals[0].tool === "Bash" && /deploy\.sh/.test(pl.approvals[0].summary));
  const msgs = 12; // assistant records in the planning fixture (tools + says)
  check("tokens: once per message id, all four kinds", pl.tokens.total > 0 && pl.tokens.output > 0 && pl.tokens.cache_read === pl.tokens.output * 60, JSON.stringify(pl.tokens));
  check("time: first, last, active time counts only gaps of 5 min or less", pl.time.first < pl.time.last && pl.time.active_ms > 0 && pl.time.active_ms < pl.time.span_ms, JSON.stringify(pl.time));
  check("hand-offs: JOYA AI's two delegations and their replies (ledger)", pl.handoffs.filter((h) => h.kind === "delegation").length === 2 && pl.handoffs.filter((h) => h.kind === "reply").length === 2);
  check("  a sub-agent it started", pl.agents.length === 1 && /Verify the comparison/.test(pl.agents[0].description));
  check("  the session's state from the live list", pl.session.state === "working" && pl.session.live === true && pl.session.name === "Planning engine");
  check("bins: its activity in 5-minute blocks", pl.bins.length > 5 && pl.bin_ms === 300000 && pl.bin_from);

  const cu = await story.sessionStory(IDS.customs);
  check("a session with a todo list (TodoWrite): the list is its rail", cu.plan.source === "todos" && cu.plan.steps.length === 4, cu.plan.source);
  check("  done / done / now / next, with the times each one changed", cu.plan.steps.map((s) => s.status).join() === "done,done,now,next" && cu.plan.steps[0].t0 && cu.plan.steps[0].t1 && !cu.plan.steps[3].t0, JSON.stringify(cu.plan.steps));
  check("  a hired session's approvals come from the ledger (origin session:<slug>)", cu.approvals.length === 1 && cu.approvals[0].from === "ledger" && /customs\/2026-09\/drafts/.test(cu.approvals[0].summary));
  check("  its message to another session is a hand-off", cu.handoffs.some((h) => h.kind === "message" && h.to === "Invoice audit"));
  check("  hired, waiting state off (idle)", cu.session.hired && cu.session.hired.slug === "customs" && cu.session.state === "idle");

  const au = await story.sessionStory(IDS.audit);
  check("a session with neither: its turns, each a real prompt (here two hand-offs it got)", au.plan.source === "turns" && au.plan.steps.length === 2 && au.plan.steps.every((s) => s.from === "peer"), JSON.stringify(au.plan.steps));
  check("  a turn's title is the message, without the cross-session markup", au.plan.steps[1].title === "Check the 14 duplicate supplier bills from September." && au.plan.steps[1].peer === "JOYA AI");
  check("  AskUserQuestion is a question, not an approval", au.questions.length === 1 && au.approvals.every((a) => a.tool !== "AskUserQuestion"));
  check("  its pending ledger card shows as pending", au.approvals.some((a) => a.decision === "pending"));
  check("  waiting (the live list says so)", au.session.state === "waiting");
  const me = await story.sessionStory(IDS.self);
  check("JOYA AI's own story: its approvals are origin NULL / joya-ai", me.session.self && me.approvals.length === 2 && me.approvals.map((a) => a.decision).join() === "approved,denied", JSON.stringify(me.approvals.map((a) => a.decision)));
  let threw = null;
  try { await story.sessionStory("cccccccc-0000-4000-8000-00000000000f"); } catch (e) { threw = e.message; }
  check("an unknown session is refused", threw === "no such session");
  threw = null;
  try { await story.sessionStory("../../etc/passwd"); } catch (e) { threw = e.message; }
  check("  and so is a path", threw === "no such session");

  // titles and markup
  check("promptTitle: the first real line", S.promptTitle("## Goal\nDo it") === "Goal" && S.promptTitle("<command-name>/clear</command-name>") === null && S.promptTitle("[Cross-session idle notice] x") === null);
  check("  a system reminder is not a title", S.promptTitle("<system-reminder>be careful</system-reminder>\nShip it") === "Ship it");
  check("  secrets are redacted in titles", !/sk-ant-/.test(S.promptTitle("use sk-ant-abcdefghijklmnopqrstuvwxyz123 now")));
  check("peerFrom reads from-name", S.peerFrom('<cross-session-message from="uds:x" from-name="JOYA AI">hi') === "JOYA AI");
  check("countPatch ignores the file headers", JSON.stringify(S.countPatch([{ lines: ["--- a/x", "+++ b/x", "+a", "-b", " c", "+d"] }])) === JSON.stringify({ add: 2, del: 1 }));

  // tokens once per message id; a rule's auto-allow is not "asked"; a message to a sub-agent is not a hand-off
  {
    const st = S.newState("x");
    const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 };
    const a = (t) => ({ type: "assistant", timestamp: t, message: { id: "msg_1", model: "m", content: [{ type: "text", text: "x" }], usage: u } });
    S.parseLines(st, [JSON.stringify(a("2026-10-20T08:00:00Z")), JSON.stringify(a("2026-10-20T08:00:01Z"))]);
    check("streamed blocks of one message count once", st.tokens.output === 5 && st.tokens.cache_read === 100);
    const tu = (id, name, input) => JSON.stringify({ type: "assistant", timestamp: "2026-10-20T08:01:00Z", message: { id: "m" + id, content: [{ type: "tool_use", id, name, input }], usage: u } });
    const tr = (id, pd) => JSON.stringify({ type: "user", timestamp: "2026-10-20T08:01:02Z", permissionDecision: pd, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    S.parseLines(st, [tu("t1", "Bash", { command: "ls" }), tr("t1", { decision: "accept", source: "user_permanent", reasonType: "rule" }), tu("t2", "Bash", { command: "rm x" }), tr("t2", { decision: "accept", source: "config", reasonType: "classifier" })]);
    check("an allow by a saved rule or the classifier is not an approval asked", st.approvals.length === 0);
    S.parseLines(st, [tu("t3", "SendMessage", { to: "a8f3c2d1e0b9a7c65", message: "go" }), tu("t4", "SendMessage", { to: "Customs docs [48c4ab]", message: "hello\nmore" })]);
    check("a message to its own sub-agent is not a hand-off; to a session (its [ref] dropped) is", st.sends.length === 1 && st.sends[0].to === "Customs docs" && st.sends[0].text === "hello" && st.subMsgs === 1, JSON.stringify(st.sends));
    S.parseLines(st, ["not json", "", '{"type":"assistant"', JSON.stringify({ type: "user", isSidechain: true, timestamp: "2026-10-20T09:00:00Z", message: { content: "side" } })]);
    check("broken lines and sidechain records are skipped", st.turns.length === 0 && st.last === Date.parse("2026-10-20T08:01:02Z"));
    const tw = (todos) => JSON.stringify({ type: "assistant", timestamp: "2026-10-20T08:02:00Z", message: { id: "tw" + Math.random(), content: [{ type: "tool_use", id: "tw", name: "TodoWrite", input: { todos } }] } });
    S.parseLines(st, [tw([{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }]), tw([{ content: "A", status: "completed" }])]);
    check("a todo item dropped from the list leaves the rail", st.todos.size === 1 && [...st.todos.values()][0].status === "completed");
    const tc = (id, name, input, t) => JSON.stringify({ type: "assistant", timestamp: t, message: { id: "x" + id, content: [{ type: "tool_use", id, name, input }] } });
    const s2 = S.newState("y");
    S.parseLines(s2, [tc("c1", "TaskCreate", { subject: "Write tests" }, "2026-10-20T08:00:00Z"), tc("c2", "TaskCreate", { subject: "Ship" }, "2026-10-20T08:00:01Z"), tc("u1", "TaskUpdate", { taskId: "1", status: "in_progress" }, "2026-10-20T08:05:00Z"), tc("u2", "TaskUpdate", { taskId: "1", status: "completed" }, "2026-10-20T08:20:00Z")]);
    const p2 = S.planOf(s2, {});
    check("TaskCreate / TaskUpdate make a todo rail too", p2.source === "todos" && p2.steps.map((x) => x.status).join() === "done,next" && p2.steps[0].t0 === "2026-10-20T08:05:00.000Z" && p2.steps[0].t1 === "2026-10-20T08:20:00.000Z", JSON.stringify(p2));
  }

  // incremental reads
  {
    const dir = path.join(TMP, "inc"), slug = path.join(dir, "-p");
    fs.mkdirSync(slug, { recursive: true });
    const sid = "dddddddd-0000-4000-8000-000000000001", file = path.join(slug, sid + ".jsonl");
    const tx = transcript(sid, "Inc", "/x", NOW).prompt(30, "First").edit(29, "/x/a.js", 3, 1);
    fs.writeFileSync(file, tx.lines().map((l) => JSON.stringify(l)).join("\n") + "\n");
    const st = S.newState(sid);
    await S.readFile(st, file, null);
    const off1 = st.off;
    check("a read takes the whole file", st.turns.length === 1 && st.files.get("/x/a.js").add === 3 && off1 === fs.statSync(file).size);
    const more = transcript(sid, null, "/x", NOW).prompt(10, "Second").edit(9, "/x/a.js", 2, 2);
    fs.appendFileSync(file, more.lines().map((l) => JSON.stringify(l)).join("\n") + "\n" + '{"type":"user","timest');
    await S.readFile(st, file, null);
    check("the next read takes only what was appended (a half-written last line waits)", st.turns.length === 2 && st.files.get("/x/a.js").add === 5 && st.files.get("/x/a.js").edits === 2 && st.off < fs.statSync(file).size);
    fs.writeFileSync(file + ".tmp", tx.lines().map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.renameSync(file + ".tmp", file);
    await S.readFile(st, file, null);
    check("a replaced file (new inode) is read again from the start", st.turns.length === 1 && st.files.get("/x/a.js").add === 3);
  }

  // the day
  const day = await story.day();
  const lane = (sid) => day.sessions.find((s) => s.session_id === sid);
  check("the day: one lane per session that worked, JOYA AI first", day.sessions[0].self && day.sessions.length === 5 && day.bins >= 276 && day.bins <= 300, day.sessions.map((s) => s.name).join());
  check("  bins are 5 minutes from the day's start (Cairo midnight)", day.bin_ms === 300000 && new Date(day.from).toISOString() === day.from && lane(IDS.planning).bins.every((b) => b[0] >= 0 && b[0] < day.bins));
  check("  lanes ordered by activity after JOYA AI", lane(IDS.planning).records >= lane(IDS.freight).records && day.sessions[1].session_id === IDS.planning);
  const kinds = day.handoffs.map((h) => h.kind).join();
  check("  hand-offs: delegations and replies from the ledger, a message between two sessions", (kinds.match(/delegation/g) || []).length === 4 && (kinds.match(/reply/g) || []).length === 3 && (kinds.match(/message/g) || []).length === 1, kinds);
  const msg = day.handoffs.find((h) => h.kind === "message");
  check("  the message resolves both ends by name", msg.from_sid === IDS.customs && msg.to_sid === IDS.audit);
  check("  JOYA AI's own SendMessage calls are not counted twice (the ledger has them)", !day.handoffs.some((h) => h.kind === "message" && h.from === "JOYA AI"));
  check("  approvals: JOYA AI's (origin null) are 'self', a hired session's resolve to its id, the transcript's are there", day.approvals.some((a) => a.sid === "self") && day.approvals.some((a) => a.sid === IDS.customs) && day.approvals.some((a) => a.from === "transcript" && a.sid === IDS.planning));
  const t0 = Date.now();
  await story.day();
  check("  the second call within 15 s answers from the cache", Date.now() - t0 < 20);
  threw = null;
  try { await story.day("2020-01-01"); } catch (e) { threw = e.message; }
  check("  a day older than two weeks is refused", /two weeks/.test(threw || ""));
  threw = null;
  try { await story.day("2099-01-01"); } catch (e) { threw = e.message; }
  check("  a day not yet begun is refused", /not started/.test(threw || ""));
  const b = S.dayBounds("2026-10-20", "Africa/Cairo");
  check("dayBounds: Cairo midnight to midnight", new Date(b.from).toISOString() === "2026-10-19T21:00:00.000Z" && b.to - b.from === 24 * 3600 * 1000, new Date(b.from).toISOString());
  const echo = S.dropSocketEchoes([{ t: "2026-10-20T09:25:47.551Z", kind: "reply", from_sid: "s" }, { t: "2026-10-20T09:25:47.000Z", kind: "message", from_sid: "s", to: "uds:/run/x.sock" }, { t: "2026-10-20T11:00:00Z", kind: "message", from_sid: "s", to: "uds:/run/y.sock" }]);
  check("a reply sent to a raw socket is the ledger's reply (dropped); an unmatched one is kept, named", echo.length === 2 && echo[1].to === "a session (by its socket)");

  section("2. the page's helpers (public/cc-story.js)");
  const steps = [{ title: "a", status: "done", t0: "2026-10-20T08:00:00Z", t1: "2026-10-20T09:00:00Z" }, { title: "b", status: "now", t0: "2026-10-20T09:00:00Z", t1: null }, { title: "c", status: "next", t0: null, t1: null }];
  check("railAt(null): the statuses as they are", L.railAt(steps, null).map((s) => s.at).join() === "done,now,next");
  check("railAt(08:30): a now, b next", L.railAt(steps, Date.parse("2026-10-20T08:30:00Z")).map((s) => s.at).join() === "now,next,next");
  check("railAt(07:00): all next", L.railAt(steps, Date.parse("2026-10-20T07:00:00Z")).map((s) => s.at).join() === "next,next,next");
  check("railAt(09:30): done, now, next", L.railAt(steps, "2026-10-20T09:30:00Z").map((s) => s.at).join() === "done,now,next");
  check("  a failed step reads failed once it ended", L.railAt([{ status: "failed", t0: "2026-10-20T08:00:00Z", t1: "2026-10-20T08:10:00Z" }], "2026-10-20T09:00:00Z")[0].at === "failed");
  check("  a step with no times keeps its status, marked untimed", L.railAt([{ status: "done" }], "2026-10-20T09:00:00Z")[0].untimed === true);
  const many = Array.from({ length: 20 }, (_, i) => ({ title: "s" + i, at: i < 12 ? "done" : i === 12 ? "now" : "next" }));
  const w = L.railWindow(many, 7);
  check("railWindow: 7 round the current step, the rest counted", w.items.length === 7 && w.before + w.items.length + w.after === 20 && w.items.some((x) => x.at === "now") && w.before === 8, JSON.stringify([w.before, w.after]));
  check("  short lists are whole", L.railWindow(many.slice(0, 4), 7).before === 0 && L.railWindow(many.slice(0, 4), 7).items.length === 4);
  check("filesAt(t): only the edits made by then, added up", (() => { const fs_ = L.filesAt(pl, Date.parse(pl.files[3].last) + 1000); return fs_.length === 1 && fs_[0].add === 30 && fs_[0].edits === 2; })());
  check("filesAt(null): the server's list", L.filesAt(pl, null).length === pl.files.length);
  check("binsUpTo: tokens by a moment", L.binsUpTo(pl, null).tokens === pl.bins.reduce((a, x) => a + x[2], 0) && L.binsUpTo(pl, Date.parse(pl.bin_from)).blocks === 1);
  check("parseT: ISO, epoch seconds and ms; junk is null", L.parseT("2026-10-20T13:05Z") === Date.parse("2026-10-20T13:05Z") && L.parseT("1792400000") === 1792400000000 && L.parseT("1792400000000") === 1792400000000 && L.parseT("tomorrow") === null && L.parseT("") === null);
  const ln = L.linkFor("/joya-ai", "?shell=desktop&x=1", IDS.planning, Date.parse("2026-10-20T13:05:00Z"));
  check("linkFor keeps other parameters and writes session + t", ln === "/joya-ai?shell=desktop&x=1&session=" + IDS.planning + "&t=2026-10-20T13%3A05Z", ln);
  check("  null removes them", L.linkFor("/joya-ai", "?session=" + IDS.planning + "&t=x&shell=desktop", null, null) === "/joya-ai?shell=desktop");
  check("parseLink reads them back; a bad session id is ignored", L.parseLink("?session=" + IDS.planning + "&t=2026-10-20T13%3A05Z").t === Date.parse("2026-10-20T13:05Z") && L.parseLink("?session=../x").session === null);
  const tMid = Date.parse(lane(IDS.planning).first) + 30 * 60000;
  const nodes = L.replayNodes(day, tMid, { headFor: () => "cap" });
  check("replayNodes: the sessions that existed then, JOYA AI not among them (it is the core)", nodes.length >= 1 && nodes.every((n) => n.id !== IDS.self) && nodes.some((n) => n.id === IDS.planning), JSON.stringify(nodes.map((n) => n.name)));
  check("  in cc-family's shape", nodes.every((n) => n.id && n.label && n.st && Array.isArray(n.subs) && typeof n.act === "number" && n.head === "cap"));
  const aw = day.approvals.find((a) => a.status === "pending" && a.sid === IDS.audit);
  check("  waiting while its approval card was open", aw && L.waitingAt(day, IDS.audit, Date.parse(aw.t) + 1000) && L.replayNodes(day, Date.parse(aw.t) + 1000, {}).find((n) => n.id === IDS.audit).st === "waiting");
  check("  before a session's first record it is not there", !L.replayNodes(day, Date.parse(lane(IDS.audit).first) - 60000, {}).some((n) => n.id === IDS.audit));
  check("between(a, b]: hand-offs in a window", L.between(day.handoffs, 0, Date.now() + 1).length === day.handoffs.length && L.between(day.handoffs, Date.now(), Date.now() + 1).length === 0);
  check("formatting: tokens, durations, paths", L.fmtTok(1530000) === "1.5M" && L.fmtTok(53000) === "53k" && L.fmtDur(95 * 60000) === "1 h 35 min" && L.shortPath("/root/joya/giza-planning-engine/docs/a.md", "/root/joya/giza-planning-engine") === "docs/a.md" && L.shortPath("/etc/a/b/c.conf") === "…/b/c.conf");
  check("dayOf in Cairo", L.dayOf(Date.parse("2026-10-19T21:30:00Z"), "Africa/Cairo") === "2026-10-20" && L.shiftDay("2026-10-31", 1) === "2026-11-01");

  section("3. the panel (lib/story-api.js, routes, hooks, assets)");
  const refuses = (f) => { try { f(); return false; } catch (e) { return e.code === "invalid"; } };
  check("cleanDay: YYYY-MM-DD, empty = today, junk and impossible dates refused", api.cleanDay("2026-10-20") === "2026-10-20" && api.cleanDay("") === null && api.cleanDay(undefined) === null && refuses(() => api.cleanDay("2026-02-30")) && refuses(() => api.cleanDay("20261020")) && refuses(() => api.cleanDay("../x")));
  check("cleanSession: UUIDs only", api.cleanSession(IDS.planning) === IDS.planning && refuses(() => api.cleanSession("../../etc")));
  {
    let clock = 0, calls = 0;
    const c = api.createCache({ now: () => clock, ttl: { day: 1000 } });
    const fn = () => { calls++; return new Promise((r) => setTimeout(() => r({ n: calls }), 10)); };
    const [a1, a2] = await Promise.all([c.get("day", "x", fn), c.get("day", "x", fn)]);
    check("cache: two requests at once make one call", calls === 1 && a1 === a2);
    await c.get("day", "x", fn);
    check("  a fresh entry answers without a call", calls === 1);
    clock = 1500;
    await c.get("day", "x", fn);
    check("  a stale one calls again", calls === 2);
    let bad = 0;
    await c.get("day", "y", () => { bad++; throw new Error("down"); }).catch(() => {});
    await c.get("day", "y", () => { bad++; return {}; });
    check("  a failure is not cached", bad === 2);
  }
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const routes = [...src.matchAll(/app\.(get|post)\("(\/joya-ai\/api\/[^"]+)",\s*([^\n]*)/g)].filter((x) => /story/.test(x[2]));
  check("two routes, both GET, both behind joyaai.use", routes.length === 2 && routes.every((r) => r[1] === "get" && /^\.\.\.joyaAiGuard/.test(r[3])), routes.map((r) => r[2]).join(" "));
  check("  they call only the two read ops", /joyaai\.call\("session-story"/.test(src) && /joyaai\.call\("story-day"/.test(src));
  const proto = require(path.join(JOYA, "lib", "protocol.js"));
  check("the supervisor's protocol: both ops, read-only, checked parameters", proto.OPS["session-story"] && proto.OPS["session-story"].mutating === false && proto.OPS["story-day"] && proto.OPS["story-day"].mutating === false);
  const pr = (o) => proto.parseRequest(JSON.stringify(Object.assign({ id: "1", actor: "a" }, o)));
  check("  a bad session id or day is refused by the protocol; good ones pass", !pr({ op: "session-story", session_id: "x" }).ok && !pr({ op: "story-day", day: "2026-1-1" }).ok && pr({ op: "session-story", session_id: IDS.planning }).ok && pr({ op: "story-day" }).ok && pr({ op: "story-day", day: "2026-10-20" }).ok,
    JSON.stringify([pr({ op: "session-story", session_id: IDS.planning }), pr({ op: "story-day" })]));
  const feat = fs.readFileSync(path.join(JOYA, "lib", "features.js"), "utf8");
  check("  features.js registers them", /"session-story": \(p\) => story\.sessionStory/.test(feat) && /"story-day": \(p\) => story\.day/.test(feat));
  const views = fs.readFileSync(path.join(ROOT, "lib", "views-joyaai.js"), "utf8");
  check("the page loads cc-story.css and .js in the browser and the desktop shell, before joya-ai.js", (views.match(/"cc-story\.css", "cc-story\.js"/g) || []).length === 2 && views.indexOf('"cc-story.js"') < views.indexOf('"joya-ai.js"'));
  const mai = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("hooks: the Command Center leaves the spheres to the replay, opens the story, attaches it", /JoyaStory\.replaying\(\)\) nodesSig = ""/.test(mai) && /JoyaStory\.openKey\(key\)/.test(mai) && /JoyaStory\.attach\(CC, P\)/.test(mai));
  const pan = fs.readFileSync(path.join(ROOT, "public", "cc-panels.js"), "utf8");
  check("  the deep view opens the story unless asked for the mirror", /function openDeep\(key, opt\)/.test(pan) && /opt && opt\.mirror/.test(pan));
  const mp = fs.readFileSync(path.join(ROOT, "public", "cc-map.js"), "utf8"), fam = fs.readFileSync(path.join(ROOT, "public", "cc-family.js"), "utf8");
  check("  the spheres keep clear of [data-cc-obstacle]; link() streams between two heads", /\[data-cc-obstacle\]/.test(mp) && /link: function \(fromId, toId\)/.test(mp) && /link: function \(fromId, toId\)/.test(fam) && /\[data-cc-obstacle\]/.test(fam));
  const js = fs.readFileSync(path.join(ROOT, "public", "cc-story.js"), "utf8"), css = fs.readFileSync(path.join(ROOT, "public", "cc-story.css"), "utf8");
  check("no style attribute written in markup, no inline handler", !/style="/.test(js) && !/\son[a-z]+="/.test(js) && !/setAttribute\("style"/.test(js));
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "").split("}").map((r) => r.split("{")[0].trim()).filter((r) => r && !/^(from|to|@keyframes)/.test(r) && !/^\d/.test(r));
  const loose = rules.flatMap((r) => r.split(",")).map((x) => x.trim()).filter((x) => x && !/\.cc-|#cc-|^html/.test(x));
  check("every rule is scoped by a cc- class (or the html root)", loose.length === 0, loose.join(" | "));
  check("reduced motion is handled in the CSS and the script", /prefers-reduced-motion: reduce/.test(css) && /prefers-reduced-motion: reduce/.test(js));
  check("the API for other builds: open, link, replay, live, replaying, at", ["open: function", "link: function", "replay: replay", "live: function", "replaying: function", "at: function"].every((k) => js.includes(k)));

  /* ------------------------------------------------------------------ 4. the browser */
  let pw = null;
  try { pw = require(process.env.PLAYWRIGHT || "playwright"); } catch (e) { pw = null; }
  if (!pw) {
    console.log("\n(4. browser part skipped: set PLAYWRIGHT=/path/to/node_modules/playwright)");
  } else {
    await browserPart(pw, W);
  }
  console.log("\n" + passed + " passed, " + failed + " failed");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* left */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/* ===================================================================== the browser */
async function browserPart(pw, W) {
  section("4. in the browser (a scratch server.js, a fake supervisor running the real parser)");
  const scratch = require("./scratch-server.cjs");
  const { startFake } = require("./story-fake-supervisor.cjs");
  const SOCK = path.join(scratch.DATA, "fake-joya-ai-story.sock");
  const sup = await startFake(SOCK, W);
  const PORT = 3720 + Math.floor(Math.random() * 60);
  const ORIGIN = `http://a.localhost:${PORT}`;
  const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.10";
  let s = null, browser = null;
  const problems = [];
  const report = { shots: [], gifs: [] };
  try {
    s = await scratch.startScratch({ port: PORT, env: { JOYA_AI_SOCKET: SOCK } });
    await s.makeUser("alice", "administrator");
    const db = require(path.join(__dirname, "..", "lib", "db.js"));
    db.setUserJoyaCore(db.getUserByName("alice").id, "E");
    // sign-in (its time-based code) on the real clock: the server's clock is real, only this process is pinned
    const Pinned = globalThis.Date;
    let cookie;
    globalThis.Date = globalThis.__RealDate || Date;
    try { cookie = (await s.signIn("alice")).cookie; } finally { globalThis.Date = Pinned; }
    browser = await pw.chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    async function open(w, h, q, o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: o.dpr || 1, colorScheme: o.theme || "dark", reducedMotion: o.reduced ? "reduce" : "no-preference", userAgent: o.desk ? APP_UA : undefined, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
      const page = await ctx.newPage();
      // the pinned clock (pinClock), moving on at the real pace; Playwright's client reads this process's Date,
      // so it is called with the real one in place (or it would see no shift at all)
      { const t = Date.now(), Pinned = globalThis.Date; globalThis.Date = globalThis.__RealDate || Date; try { await page.clock.setSystemTime(t); } finally { globalThis.Date = Pinned; } }
      await page.addInitScript((theme) => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
        try { localStorage.setItem("theme", theme); } catch (e) { /* none */ }
      }, o.theme || "dark");
      const tag = w + "x" + h + " " + q;
      page.on("pageerror", (e) => problems.push(tag + ": pageerror " + e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (404|503)|Failed to load resource|EventSource/.test(m.text())) problems.push(tag + ": console " + m.text()); });
      await page.goto(ORIGIN + "/joya-ai" + (q ? "?" + q : ""), { waitUntil: "load" });
      await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); document.dispatchEvent(new Event("joya-theme")); }, o.theme || "dark");
      await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.S && window.__joyaCC.S.online && window.__joyaCC.S.sessions.length > 1, null, { timeout: 15000 }).catch(() => {});
      await sleep(500);
      return { ctx, page, close: async () => { const c = await page.evaluate(() => window.__csp).catch(() => []); c.forEach((x) => problems.push(tag + ": CSP " + x)); await ctx.close(); } };
    }
    const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await sleep(1500); await page.screenshot({ path: path.join(SHOTS, name + ".png") }); report.shots.push(name); };
    const storyInfo = (page) => page.evaluate(() => {
      const r = document.getElementById("cc-story");
      if (!r || r.hidden) return null;
      return {
        title: document.getElementById("cc-st-title").textContent, steps: [...r.querySelectorAll(".cc-st-step")].map((li) => li.className.replace("cc-st-step ", "")),
        src: r.querySelector('[data-st="railsrc"]').textContent, cards: [...r.querySelectorAll(".cc-st-card")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
        at: r.querySelector('[data-st="at"]').textContent, url: location.search, sw: document.documentElement.scrollWidth, w: innerWidth,
        rect: r.querySelector(".cc-st").getBoundingClientRect().toJSON(),
      };
    });
    const tAt = (min) => new Date(NOW - min * 60000);

    // the story from a deep link
    {
      const t = L.fmtT(tAt(232));
      const v = await open(1440, 900, "session=" + IDS.planning + "&t=" + encodeURIComponent(t));
      await v.page.waitForFunction(() => document.querySelectorAll("#cc-story .cc-st-step").length > 0, null, { timeout: 8000 }).catch(() => {});
      let i = await storyInfo(v.page);
      check("a deep link ?session=…&t=… opens that session's story at that moment", i && i.title === "Planning engine" && /^At \d\d:\d\d/.test(i.at), JSON.stringify(i && [i.title, i.at]));
      check("  the rail is the mission's, as it stood then: done, now, next, next, next", i && i.steps.map((x) => x.split(" ")[0]).join() === "done,now,next,next,next" && /Mission M-3/.test(i.src), JSON.stringify(i && i.steps));
      check("  files by then: allocation.py and the docs (the later edits not yet)", i && /allocation\.py/.test(i.cards[0]) && /production-plan-migration-study/.test(i.cards[0]) && !/engine_run/.test(i.cards[0]), i && i.cards[0]);
      check("  approvals, tokens, time and hand-offs cards", i && i.cards.length === 5 && /Approvals/.test(i.cards[1]) && /Tokens/.test(i.cards[2]) && /Time spent/.test(i.cards[3]) && /Hand-offs/.test(i.cards[4]));
      await shot(v.page, "story-mission-moment-browser-dark");
      // the moment scrubber: End -> live; the URL drops t
      await v.page.focus("#cc-story .cc-st-mtrack");
      await v.page.keyboard.press("End");
      await sleep(200);
      i = await storyInfo(v.page);
      check("the moment scrubber: End is now (live), the rail as it is", i && i.at === "Live" && i.steps.map((x) => x.split(" ")[0]).join() === "done,done,now,next,next" && !/[?&]t=/.test(i.url), JSON.stringify(i && [i.at, i.steps, i.url]));
      check("  all four files now", i && /engine_run\.py/.test(i.cards[0]) && /test_compare\.py/.test(i.cards[0]), i && i.cards[0]);
      await shot(v.page, "story-mission-live-browser-dark");
      await v.page.keyboard.press("Home");
      await sleep(150);
      i = await storyInfo(v.page);
      // Home: the session's first record; step 1 had already begun (JOYA AI's delegation came just before it).
      check("  Home is its first moment: step 1 now, the rest next", i && i.steps.map((x) => x.split(" ")[0]).join() === "now,next,next,next,next" && /[?&]t=/.test(i.url), JSON.stringify(i && i.steps));
      // Live mirror -> the old deep view; Esc closes
      await v.page.click('#cc-story [data-st-act="mirror"]');
      await sleep(400);
      check("Live mirror opens the read-only deep view (the old text view)", await v.page.evaluate(() => !!document.querySelector(".cc-deep") && document.getElementById("cc-story").hidden));
      await v.page.keyboard.press("Escape");
      await sleep(200);
      // a sphere click opens the story
      const kid = await v.page.evaluate((id) => { const k = document.querySelector('.cc-kid[data-kid="' + id + '"]'); return !!k; }, IDS.customs);
      if (kid) { await v.page.evaluate((id) => document.querySelector('.cc-kid[data-kid="' + id + '"]').click(), IDS.customs); await sleep(600); }
      i = await storyInfo(v.page);
      check("clicking a session's head opens its story (a todo rail here)", i && i.title === "Customs docs" && /todo list/.test(i.src) && i.steps.map((x) => x.split(" ")[0]).join() === "done,done,now,next", JSON.stringify(i && [i.title, i.src, i.steps]));
      await shot(v.page, "story-todos-browser-dark");
      await v.page.keyboard.press("Escape");
      await sleep(200);
      check("  Esc closes it and the URL forgets the session", await v.page.evaluate(() => document.getElementById("cc-story").hidden && !/session=/.test(location.search)));
      await v.close();
    }
    // light theme story
    {
      const v = await open(1440, 900, "session=" + IDS.planning, { theme: "light" });
      await v.page.waitForFunction(() => document.querySelectorAll("#cc-story .cc-st-step").length > 0, null, { timeout: 8000 }).catch(() => {});
      await sleep(300);
      await shot(v.page, "story-mission-live-browser-light");
      await v.close();
    }

    // the day timeline
    {
      const v = await open(1440, 900, "");
      await v.page.click("#cc-daytl [data-dt=toggle]");
      await v.page.waitForFunction(() => window.JoyaStory && document.querySelector("#cc-daytl .cc-dt-bar") && !document.querySelector("#cc-daytl .cc-dt-bar").hidden, null, { timeout: 5000 });
      await sleep(800);
      const note = await v.page.evaluate(() => document.querySelector('#cc-daytl [data-dt="note"]').textContent);
      check("the day timeline opens with the day's summary", /4 sessions worked · 4 delegations · 1 message between sessions · 7 approvals/.test(note), note);
      { const lv = await v.page.evaluate(() => ({ rep: window.JoyaStory.replaying(), on: document.querySelector('#cc-daytl [data-dt="live"]').classList.contains("on"), now: new Date().toISOString(), url: location.search })); check("  it starts live", !lv.rep && lv.on, JSON.stringify(lv)); }
      await shot(v.page, "day-live-browser-dark");
      // replay at the moment the customs session was filing: Planning idle?, Customs working
      const t1 = tAt(210).getTime();
      await v.page.evaluate((t) => window.JoyaStory.replay(t), t1);
      await sleep(900);
      const kids = await v.page.evaluate(() => window.__joyaCC.orbit.family.kids().filter((k) => !k.dis).map((k) => [k.label, k.st]));
      check("replaying a moment: the spheres are the sessions as they were (the audit did not exist yet)", kids.length >= 2 && !kids.some((k) => k[0] === "Invoice audit") && kids.some((k) => k[0] === "Customs docs" && k[1] === "working"), JSON.stringify(kids));
      check("  the bar shows the time, and the URL has t", await v.page.evaluate(() => /^\d\d:\d\d$/.test(document.querySelector('#cc-daytl [data-dt="at"]').textContent) && /[?&]t=/.test(location.search) && window.JoyaStory.replaying()));
      // live data must not overwrite the replay
      await v.page.evaluate(() => window.__joyaCC.renderSessions(true));
      const still = await v.page.evaluate(() => window.__joyaCC.orbit.family.kids().filter((k) => !k.dis).some((k) => k.label === "Invoice audit"));
      check("  a live sessions update does not overwrite the replay", !still);
      // lanes
      await v.page.click('#cc-daytl [data-dt="lanes"]');
      await sleep(300);
      const lanes = await v.page.evaluate(() => [...document.querySelectorAll("#cc-daytl .cc-dt-lane .nm")].map((x) => x.textContent));
      check("lanes: one per session, JOYA AI first", lanes.length === 5 && lanes[0] === "JOYA AI", JSON.stringify(lanes));
      await shot(v.page, "day-replay-lanes-browser-dark");
      // a hand-off flies: step across the customs -> audit message
      const msgT = (await sup.story.day()).handoffs.find((h) => h.kind === "message").t;
      await v.page.evaluate((t) => window.JoyaStory.replay(t), Date.parse(msgT) - 60000);
      await sleep(300);
      await v.page.focus("#cc-daytl .cc-dt-track");
      await v.page.keyboard.press("ArrowRight");
      await sleep(250);
      const noteM = await v.page.evaluate(() => document.querySelector('#cc-daytl [data-dt="note"]').textContent);
      check("stepping across a hand-off streams it and names it (Customs docs → Invoice audit)", /Customs docs → Invoice audit/.test(noteM), noteM);
      await shot(v.page, "day-handoff-browser-dark");
      // a lane click opens that session's story at the replayed moment
      await v.page.click('#cc-daytl [data-dt-lane="' + IDS.audit + '"]');
      await sleep(600);
      const si = await storyInfo(v.page);
      check("a lane opens its session's story at the replayed moment", si && si.title === "Invoice audit" && /^At /.test(si.at), JSON.stringify(si && [si.title, si.at]));
      await v.page.keyboard.press("Escape");
      await sleep(200);
      // Now -> live
      await v.page.click('#cc-daytl [data-dt="live"]');
      await sleep(600);
      const back = await v.page.evaluate(() => [window.JoyaStory.replaying(), window.__joyaCC.orbit.family.kids().filter((k) => !k.dis).map((k) => k.label).sort().join(), /[?&]t=/.test(location.search)]);
      check("Now returns to live: the live sessions, no t in the URL", back[0] === false && back[1] === "Customs docs,Freight quotes,Invoice audit,Planning engine" && back[2] === false, JSON.stringify(back));
      // keyboard: Space plays, then End is live
      await v.page.focus("#cc-daytl .cc-dt-track");
      await v.page.keyboard.press("Home");
      await v.page.keyboard.press(" ");
      await sleep(600);
      const playing = await v.page.evaluate(() => [window.JoyaStory.replaying(), document.querySelector('#cc-daytl [data-dt="play"]').classList.contains("on")]);
      check("keyboard: Home then Space plays the day", playing[0] && playing[1], JSON.stringify(playing));
      await v.page.keyboard.press("End");
      await sleep(300);
      check("  End goes back to live", await v.page.evaluate(() => !window.JoyaStory.replaying()));
      // the GIF: dragging the scrubber across the day
      if (SHOTS && GIF) {
        await v.page.evaluate(() => window.JoyaStory.replay(Date.now() - 400 * 60000));
        await sleep(400);
        const box = await v.page.evaluate(() => document.querySelector("#cc-daytl .cc-dt-track").getBoundingClientRect().toJSON());
        const frames = path.join(TMP, "frames");
        fs.mkdirSync(frames, { recursive: true });
        const sp = await v.page.evaluate(() => { const d = document.querySelector("#cc-daytl .cc-dt-track"); return [Number(d.getAttribute("aria-valuemin")), Number(d.getAttribute("aria-valuemax"))]; });
        const x0 = box.x + 6 + (box.width - 12) * ((Date.now() - 400 * 60000 - sp[0]) / (sp[1] - sp[0]));
        const x1 = box.x + 6 + (box.width - 12) * ((Date.now() - 2 * 60000 - sp[0]) / (sp[1] - sp[0]));
        await v.page.mouse.move(x0, box.y + box.height / 2);
        await v.page.mouse.down();
        const N = 48;
        for (let k = 0; k <= N; k++) {
          await v.page.mouse.move(x0 + (x1 - x0) * (k / N), box.y + box.height / 2);
          await sleep(110);
          await v.page.screenshot({ path: path.join(frames, "f" + String(k).padStart(3, "0") + ".png"), clip: { x: 220, y: 40, width: 1000, height: 820 } });
        }
        await v.page.mouse.up();
        try {
          const { execFileSync } = require("child_process");
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "8", "-i", path.join(frames, "f%03d.png"), "-vf", "scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", path.join(SHOTS, "day-scrub.gif")]);
          report.gifs.push("day-scrub");
        } catch (e) { problems.push("gif: " + e.message); }
      }
      await v.close();
    }
    // light theme timeline replay
    {
      const v = await open(1440, 900, "t=" + encodeURIComponent(L.fmtT(tAt(115))), { theme: "light" });
      await sleep(1200);
      check("?t= alone opens the day timeline replaying that moment", await v.page.evaluate(() => window.JoyaStory.replaying() && !document.querySelector("#cc-daytl .cc-dt-bar").hidden));
      await v.page.click('#cc-daytl [data-dt="lanes"]');
      await sleep(300);
      await shot(v.page, "day-replay-lanes-browser-light");
      await v.close();
    }
    // phone width
    for (const theme of ["dark", "light"]) {
      const v = await open(390, 844, "session=" + IDS.planning, { theme, dpr: 2 });
      await v.page.waitForFunction(() => document.querySelectorAll("#cc-story .cc-st-step").length > 0, null, { timeout: 8000 }).catch(() => {});
      await sleep(300);
      const i = await storyInfo(v.page);
      check("phone (" + theme + "): the story is a full-width sheet, no horizontal scroll", i && i.sw <= i.w && Math.round(i.rect.left) === 0 && Math.round(i.rect.right) === 390, JSON.stringify(i && [i.sw, i.w, i.rect]));
      const gut = await v.page.evaluate(() => { const b = document.querySelector("#cc-story .cc-st-body"); const r = b.getBoundingClientRect(), c = b.firstElementChild.getBoundingClientRect(); return Math.round(c.left - r.left); });
      check("  16 px gutter", gut === 16, gut);
      const vert = await v.page.evaluate(() => { const s = [...document.querySelectorAll("#cc-story .cc-st-step")].map((x) => x.getBoundingClientRect()); return s.length > 1 && s[1].top > s[0].top && Math.abs(s[1].left - s[0].left) < 2; });
      check("  the rail runs down the screen", vert);
      await shot(v.page, "story-phone-" + theme);
      await v.page.keyboard.press("Escape");
      await sleep(200);
      await v.page.evaluate(() => window.JoyaStory.replay(Date.now() - 200 * 60000));
      await sleep(700);
      const dt = await v.page.evaluate(() => { const r = document.querySelector("#cc-daytl .cc-dt-bar").getBoundingClientRect(); return [Math.round(r.left), Math.round(innerWidth - r.right), document.documentElement.scrollWidth <= innerWidth]; });
      check("  the day timeline: 16 px gutters, no horizontal scroll", dt[0] === 16 && dt[1] === 16 && dt[2], JSON.stringify(dt));
      await shot(v.page, "day-phone-" + theme);
      await v.close();
    }
    // the desktop shell
    for (const theme of ["dark", "light"]) {
      const v = await open(1100, 760, "shell=desktop&session=" + IDS.customs, { theme, desk: true });
      await v.page.waitForFunction(() => document.querySelectorAll("#cc-story .cc-st-step").length > 0, null, { timeout: 8000 }).catch(() => {});
      await sleep(400);
      const i = await storyInfo(v.page);
      check("desktop shell (" + theme + "): the story opens inside the app's box", i && i.title === "Customs docs" && i.sw <= i.w && i.rect.left >= 0 && i.rect.right <= 1100, JSON.stringify(i && [i.title, i.rect]));
      await shot(v.page, "story-desktop-shell-" + theme);
      await v.page.keyboard.press("Escape");
      await sleep(200);
      await v.page.evaluate(() => window.JoyaStory.replay(Date.now() - 245 * 60000));
      await sleep(800);
      await v.page.click('#cc-daytl [data-dt="lanes"]');
      await sleep(300);
      await shot(v.page, "day-desktop-shell-" + theme);
      await v.close();
    }
    // reduced motion: the story opens and the replay steps without errors
    {
      const v = await open(1280, 800, "session=" + IDS.audit, { reduced: true });
      await v.page.waitForFunction(() => document.querySelectorAll("#cc-story .cc-st-step").length > 0, null, { timeout: 8000 }).catch(() => {});
      const anim = await v.page.evaluate(() => getComputedStyle(document.querySelector("#cc-story .cc-st")).animationName);
      check("reduced motion: no slide-in", anim === "none", anim);
      await v.close();
    }
    check("no page errors, console errors or CSP violations", problems.length === 0, problems.join("\n"));
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "report.json"), JSON.stringify(report, null, 1));
  } finally {
    if (browser) await browser.close();
    if (s) s.stop();
    sup.close();
  }
}
