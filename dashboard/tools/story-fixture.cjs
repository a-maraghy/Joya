"use strict";
/**
 * A small, made-up world for the session story (tests and screenshots only): Claude Code transcripts in
 * the shape the CLI writes them (prompts, tool calls with usage, tool results with toolUseResult /
 * structuredPatch / permissionDecision, custom titles, cross-session messages) and a ledger with the
 * supervisor's real schema (joya-ai/lib/ledger.js) holding delegations, approvals, a mission and a hire.
 *
 *     const SHIFT = pinClock();             // optional: this process's clock at the latest 13:50 Cairo (see below)
 *     const W = buildWorld(dir, Date.now());
 *     // W.projectsDir, W.ledger (Ledger), W.sessions (the live list), W.selfIds, W.ids
 *
 * The real joya-ai/lib/story.js reads it -- the figures the pages show are whatever that parser makes of it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const { Ledger } = require(path.join(ROOT, "joya-ai", "lib", "ledger.js"));

const IDS = {
  self: "aaaaaaaa-0000-4000-8000-000000000000",
  planning: "bbbbbbbb-0000-4000-8000-000000000001",
  customs: "bbbbbbbb-0000-4000-8000-000000000002",
  audit: "bbbbbbbb-0000-4000-8000-000000000003",
  freight: "bbbbbbbb-0000-4000-8000-000000000004",
  desk: "bbbbbbbb-0000-4000-8000-000000000005",
};

function transcript(sid, name, cwd, now) {
  const lines = [];
  let n = 0;
  const at = (min) => new Date(now - min * 60000).toISOString();
  const base = (t) => ({ sessionId: sid, cwd, timestamp: t, uuid: sid.slice(0, 8) + "-" + ++n, isSidechain: false, userType: "external", entrypoint: "claude-desktop" });
  const usage = (o) => ({ input_tokens: 40 + (o % 7), output_tokens: o, cache_read_input_tokens: o * 60, cache_creation_input_tokens: o * 4 });
  const api = {
    title(t) { lines.push({ type: "custom-title", customTitle: t, sessionId: sid }); return api; },
    prompt(min, text) { lines.push({ ...base(at(min)), type: "user", message: { role: "user", content: text } }); return api; },
    peer(min, from, text) { lines.push({ ...base(at(min)), type: "user", message: { role: "user", content: `<cross-session-message from="uds:/run/user/0/cc-socks/1.sock" from-name="${from}" from-mode="prompting">\n${text}\n</cross-session-message>` } }); return api; },
    say(min, text, out) { lines.push({ ...base(at(min)), type: "assistant", message: { id: "msg_" + sid.slice(-4) + "_" + ++n, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text }], usage: usage(out || 300) } }); return api; },
    tool(min, name, input, result, extra) {
      const id = "toolu_" + sid.slice(-4) + "_" + ++n;
      lines.push({ ...base(at(min)), type: "assistant", message: { id: "msg_" + id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id, name, input }], usage: usage((extra && extra.out) || 500) } });
      const rec = { ...base(at(min - 0.4)), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: (extra && extra.error) || "ok", is_error: !!(extra && extra.error) }] } };
      if (result) rec.toolUseResult = result;
      if (extra && extra.pd) rec.permissionDecision = extra.pd;
      lines.push(rec);
      return api;
    },
    edit(min, file, add, del, extra) {
      const lines_ = [" context"];
      for (let i = 0; i < del; i++) lines_.push("-old line " + i);
      for (let i = 0; i < add; i++) lines_.push("+new line " + i);
      return api.tool(min, "Edit", { file_path: file, old_string: "a", new_string: "b" }, { filePath: file, structuredPatch: [{ oldStart: 10, oldLines: del + 1, newStart: 10, newLines: add + 1, lines: lines_ }] }, extra);
    },
    write(min, file, nlines) {
      return api.tool(min, "Write", { file_path: file, content: "x" }, { type: "create", filePath: file, content: Array.from({ length: nlines }, (_, i) => "line " + i).join("\n"), structuredPatch: [] });
    },
    bash(min, command, extra) { return api.tool(min, "Bash", { command }, { stdout: "", stderr: "", interrupted: false }, extra); },
    todo(min, todos) { return api.tool(min, "TodoWrite", { todos: todos.map(([content, status]) => ({ content, status, activeForm: content })) }, { oldTodos: [], newTodos: [] }); },
    send(min, to, message) { return api.tool(min, "SendMessage", { to, message }, { success: true, message: "Message sent." }); },
    ask(min, question) { return api.tool(min, "AskUserQuestion", { questions: [{ question, header: "Choice", options: [{ label: "Yes" }, { label: "No" }] }] }, { answers: {} }, { pd: { decision: "accept", source: "user_temporary" } }); },
    agent(min, description) { return api.tool(min, "Agent", { description, prompt: "…", subagent_type: "general-purpose" }, { status: "async_launched", agentId: "a" + "0".repeat(16) }); },
    lines: () => lines,
  };
  if (name) api.title(name);
  return api;
}

/** Writes the world into dir (made if missing) and returns its handles. now: the instant "now" is. */
function buildWorld(dir, now) {
  fs.mkdirSync(dir, { recursive: true });
  const proj = path.join(dir, "projects");
  const write = (slug, sid, api) => {
    fs.mkdirSync(path.join(proj, slug), { recursive: true });
    fs.writeFileSync(path.join(proj, slug, sid + ".jsonl"), api.lines().map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const P = "/root/joya/giza-planning-engine";

  // JOYA AI itself: it delegates (the ledger has the delegations; its transcript has the SendMessage calls).
  const self = transcript(IDS.self, null, "/root/joya-ai", now)
    .prompt(400, "[Morning briefing] Services, disk, sign-ins, missions.")
    .bash(399, "systemctl --failed --no-legend")
    .say(398, "**Services** all running. **Disk** 41% used.", 400)
    .prompt(330, "Plan the October material plan review as a mission.")
    .tool(329, "mcp__joya-ai__mission_create", { title: "October material plan" }, null)
    .send(328, "Planning engine", "M-3 step 1: run the engine for 1–31 Oct and compare with last week.")
    .send(250, "Customs docs", "File the October declarations for the three open shipments.")
    .prompt(120, "Ask the invoice audit to check the duplicate bills.")
    .send(119, "Invoice audit", "Check the 14 duplicate supplier bills from September.")
    .say(20, "Waiting on the planning engine's reply.", 120);
  write("-root-joya-ai", IDS.self, self);

  const planning = transcript(IDS.planning, "Planning engine", P, now)
    .peer(327, "JOYA AI", "M-3 step 1: run the engine for 1–31 Oct and compare with last week.")
    .bash(325, "python3 -m unittest discover -s tests", { out: 900 })
    .edit(318, P + "/giza_planning/domain/allocation.py", 24, 9)
    .edit(305, P + "/giza_planning/domain/allocation.py", 6, 2)
    .bash(300, "bash odoo/deploy.sh --label m3", { pd: { decision: "accept", source: "user_temporary" }, out: 700 })
    .say(296, "Run 1–31 Oct: 45 rows, covered 26.", 600)
    .prompt(240, "Now write the comparison into the docs and push.")
    .edit(236, P + "/docs/production-plan-migration-study.md", 41, 3)
    .write(230, P + "/tests/test_compare.py", 58)
    .bash(226, "git push origin main release --tags", { pd: { decision: "accept", source: "user_temporary" } })
    .agent(222, "Verify the comparison on a copy")
    .say(214, "Pushed main and release.", 500)
    .prompt(60, "Check the stale MOs count on the copy.")
    .bash(58, "psql -c 'select count(*) from mrp_production'", { out: 300 })
    .edit(41, P + "/odoo/planning_engine/models/engine_run.py", 12, 30)
    .bash(9, "rm -rf /tmp/pe_old_runs", { pd: { decision: "reject", source: "user_reject" }, error: "The user doesn't want to proceed with this tool use." })
    .say(6, "Waiting for the next step.", 200);
  write("-root-joya", IDS.planning, planning);

  const customs = transcript(IDS.customs, "Customs docs", "/root/joya/customs", now)
    .peer(249, "JOYA AI", "File the October declarations for the three open shipments.")
    .todo(248, [["Collect the three bills of lading", "in_progress"], ["Fill the declarations", "pending"], ["Check the HS codes", "pending"], ["File and send the receipts", "pending"]])
    .bash(240, "ls ~/customs/2026-10")
    .todo(222, [["Collect the three bills of lading", "completed"], ["Fill the declarations", "in_progress"], ["Check the HS codes", "pending"], ["File and send the receipts", "pending"]])
    .write(214, "/root/joya/customs/2026-10/declaration-GSH-1041.md", 64)
    .write(206, "/root/joya/customs/2026-10/declaration-GSH-1042.md", 61)
    .todo(180, [["Collect the three bills of lading", "completed"], ["Fill the declarations", "completed"], ["Check the HS codes", "in_progress"], ["File and send the receipts", "pending"]])
    .edit(170, "/root/joya/customs/2026-10/declaration-GSH-1041.md", 3, 3)
    .say(150, "HS codes checked; two need your look.", 400)
    .send(148, "Invoice audit", "The freight bill for GSH-1042 is in the customs folder.");
  write("-root-joya-customs", IDS.customs, customs);

  const audit = transcript(IDS.audit, "Invoice audit", "/root/joya/audit", now)
    .peer(147, "Customs docs", "The freight bill for GSH-1042 is in the customs folder.")
    .say(146, "Noted.", 80)
    .peer(118, "JOYA AI", "Check the 14 duplicate supplier bills from September.")
    .bash(116, "python3 audit/dupes.py --month 2026-09", { out: 1400 })
    .ask(100, "Bill 2219 and 2231 match on amount but not on date. Treat them as duplicates?")
    .edit(92, "/root/joya/audit/report-2026-09.md", 33, 0)
    .bash(40, "python3 audit/dupes.py --month 2026-09 --apply", { out: 800 })
    .say(3, "Working through bill 2240.", 300);
  write("-root-joya-audit", IDS.audit, audit);

  const freight = transcript(IDS.freight, "Freight quotes", "/root/joya/freight", now)
    .prompt(200, "Get three quotes for the Hamburg container.")
    .bash(198, "curl -s https://example.invalid/quotes", { out: 300 })
    .say(190, "Three quotes saved.", 200);
  write("-root-joya-freight", IDS.freight, freight);

  // Ledger: the real schema.
  const led = new Ledger(path.join(dir, "ledger.db"));
  const iso = (min) => new Date(now - min * 60000).toISOString();
  const ins = (sql, ...a) => led.db.prepare(sql).run(...a);
  const del = (target, sid, text, sent, replied, status) =>
    ins("INSERT INTO delegations (msg_id, target, target_name, target_session, text, summary, status, created_at, replied_at, done_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "m" + sent, target, target, sid, text, text.split("\n")[0], status, iso(sent), replied == null ? null : iso(replied), replied == null ? null : iso(replied), iso(replied == null ? sent : replied));
  del("Planning engine", IDS.planning, "M-3 step 1: run the engine for 1–31 Oct and compare with last week.", 328, 295, "done");
  del("Customs docs", IDS.customs, "File the October declarations for the three open shipments.", 250, 149, "done");
  del("Invoice audit", IDS.audit, "Check the 14 duplicate supplier bills from September.", 119, null, "working");
  del("Planning engine", IDS.planning, "M-3 step 3: count the stale MOs on the copy.", 61, 7, "done");
  const appr = (tool, summary, origin, name, min, status, decided) =>
    ins("INSERT INTO approvals (request_id, tool, input_json, summary, status, created_at, expires_at, decided_at, decided_by, origin, origin_name, label) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "r" + min, tool, "{}", summary, status, iso(min), iso(min - 5), decided == null ? null : iso(decided), decided == null ? null : "admin", origin, name, "Needs permission");
  appr("Bash", "systemctl restart odoo", null, null, 300, "approved", 299);
  appr("Bash", "git push --force origin main", null, null, 180, "denied", 179);
  appr("Bash", "rm -rf ~/customs/2026-09/drafts", "session:customs", "Customs docs", 160, "approved", 158);
  appr("Bash", "python3 audit/dupes.py --apply --delete", "session:audit", "Invoice audit", 2, "pending", null);
  ins("INSERT INTO hired_sessions (slug, name, cwd, purpose, model, session_id, status, kept, hired_by, hired_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "customs", "Customs docs", "/root/joya/customs", "October declarations", null, IDS.customs, "hired", 0, "joya-ai", iso(260), iso(260));
  ins("INSERT INTO hired_sessions (slug, name, cwd, purpose, model, session_id, status, kept, hired_by, hired_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "audit", "Invoice audit", "/root/joya/audit", "Duplicate bills", null, IDS.audit, "hired", 0, "joya-ai", iso(125), iso(125));
  ins("INSERT INTO missions (id, title, goal, status, created_by, created_at, updated_at) VALUES (3, 'October material plan', 'Review the October plan', 'active', 'admin', ?, ?)", iso(330), iso(5));
  const step = (n, title, target, status, started, done) =>
    ins("INSERT INTO steps (mission_id, n, title, target, status, created_at, updated_at, started_at, done_at) VALUES (3,?,?,?,?,?,?,?,?)", n, title, target, status, iso(330), iso(5), started == null ? null : iso(started), done == null ? null : iso(done));
  step(1, "Run the engine for 1–31 Oct", "Planning engine", "done", 328, 295);
  step(2, "Write the comparison and push", "Planning engine", "done", 240, 214);
  step(3, "Count the stale MOs on the copy", "Planning engine", "working", 61, null);
  step(4, "Review with the team", "joya-ai", "planned", null, null);
  step(5, "Close or reschedule the dead orders", "Planning engine", "planned", null, null);

  const sessions = [
    { self: true, name: "JOYA AI", pid: 100, session_id: IDS.self, status: "idle", where: "Supervisor" },
    { name: "Planning engine", pid: 201, session_id: IDS.planning, status: "busy", where: "Terminal", cwd: P, tokens_today: { total: 2.1e6 } },
    { name: "Customs docs", pid: 202, session_id: IDS.customs, status: "idle", where: "Terminal", cwd: "/root/joya/customs", hired: true, hire: { slug: "customs", kept: false } },
    { name: "Invoice audit", pid: 203, session_id: IDS.audit, status: "waiting", waiting_for: "your approval", where: "Terminal", cwd: "/root/joya/audit", hired: true, hire: { slug: "audit", kept: false } },
    { name: "Freight quotes", pid: 204, session_id: IDS.freight, status: "idle", where: "Desktop", cwd: "/root/joya/freight" },
  ];
  return { dir, projectsDir: proj, ledger: led, sessions, selfIds: new Set([IDS.self]), ids: IDS };
}

/**
 * Pins this process's clock to the most recent 13:50 in Cairo and returns the shift (ms) to give the browser
 * (page.clock.setSystemTime(Date.now())). The story's day is "today" in Cairo and the fixture reaches about seven
 * hours back: run on the real clock just after Cairo's midnight, most of it would land in yesterday and the day
 * view would be nearly empty. Date.now() and new Date() move on from there at the real pace (timers unchanged).
 */
function pinClock(tz, hh, mm) {
  tz = tz || "Africa/Cairo"; hh = hh == null ? 13 : hh; mm = mm == null ? 50 : mm;
  const Real = globalThis.__RealDate || Date, real = Real.now();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Real(real));
  const g = (t) => +parts.find((p) => p.type === t).value;
  const off = Real.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - Math.floor(real / 60000) * 60000; // the zone's offset (ms)
  let target = Real.UTC(g("year"), g("month") - 1, g("day"), hh, mm) - off;
  if (target > real) target -= 24 * 3600 * 1000;
  return require("./story-clock.cjs").shiftDate(target - real);
}

module.exports = { buildWorld, transcript, IDS, pinClock };
