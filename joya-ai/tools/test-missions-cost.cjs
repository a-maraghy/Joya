/**
 * The missions store (lib/missions.js) and cost (lib/cost.js), on a scratch
 * ledger.
 *
 *     node joya-ai/tools/test-missions-cost.cjs
 *
 * Missions: create with steps, add, update, the step tag and target linking,
 * the delegation lifecycle driving steps, a pending approval, derived mission
 * status, refusals. Cost: per-turn deltas from the CLI's running total across
 * process restarts (by stamp and by the total going down), transcript usage
 * de-duplicated per message and priced, and the incremental scanner neither
 * double counting on a rescan nor after a restart.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Ledger } = require(path.join(__dirname, "..", "lib", "ledger.js"));
const { Missions, TAG_RE } = require(path.join(__dirname, "..", "lib", "missions.js"));
const cost = require(path.join(__dirname, "..", "lib", "cost.js"));

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}
const throws = (f, re) => {
  try {
    f();
    return false;
  } catch (e) {
    return re ? re.test(e.message) : true;
  }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-mc-"));
const ledger = new Ledger(path.join(tmp, "ledger.db"));
const M = new Missions(ledger);

/* --------------------------------------------------------------- missions --- */
const m = M.create({ title: "Ops review", goal: "g", steps: [{ title: "Uptime", target: "fake-target" }, { title: "Bans", target: "JOYA Agent OS" }, { title: "Draft", target: "joya-ai" }], actor: "joya-ai" });
check("create returns M-<id> with its steps numbered", m.ref === "M-" + m.id && m.steps.map((s) => s.n).join() === "1,2,3" && m.status === "planned");
check("metrics: 0 of 3 done, the sessions named", m.metrics.steps_done === 0 && m.metrics.steps_total === 3 && m.metrics.sessions.includes("fake-target"));
check("the ref is accepted everywhere", M.get("M-" + m.id).id === m.id && M.get(String(m.id)).id === m.id);
check("an unknown mission is refused", throws(() => M.updateStep("M-9999", 1, { status: "done" }), /no mission/));
check("an unknown step is refused", throws(() => M.updateStep(m.id, 9, { status: "done" }), /no step/));
check("an unknown status is refused", throws(() => M.updateStep(m.id, 1, { status: "exploded" })));
check("the tag regex reads 'M-12 step 3'", TAG_RE.exec("M-12 step 3: go")[1] === "12" && TAG_RE.exec("Mission M-12, step 3 of 8")[2] === "3");

const deleg = (fields) => {
  const d = ledger.addDelegation({ target: "fake-target [ab12]", target_name: "fake-target", text: "", status: "sent", ...fields });
  return d;
};
let d1 = deleg({ msg_id: "a", text: `M-${m.id} step 1: collect uptime` });
let r = M.onDelegation(d1);
check("a tagged delegation links to its step and marks it delegated", r && r.steps[0].status === "delegated" && r.steps[0].delegation_id === d1.id);
check("the delegation row records mission and step", ledger.get("delegations", d1.id).mission_id === m.id && ledger.get("delegations", d1.id).step_id === r.steps[0].id);
check("the mission becomes active", r.status === "active");
d1 = ledger.updateDelegation(d1.id, { status: "working" });
check("working -> working", M.onDelegation(d1).steps[0].status === "working");
d1 = ledger.updateDelegation(d1.id, { status: "ack", reply_text: "12 of 12 up" });
r = M.onDelegation(d1);
check("ack -> still working, with the reply as the result", r.steps[0].status === "working" && r.steps[0].result === "12 of 12 up");
d1 = ledger.updateDelegation(d1.id, { status: "done" });
check("done -> done", M.onDelegation(d1).steps[0].status === "done");

// untagged: step marked delegated to a target first
M.updateStep(m.id, 2, { status: "delegated" });
const d2 = ledger.addDelegation({ msg_id: "b", target: "JOYA Agent OS", target_name: "JOYA Agent OS", text: "please summarise the bans", status: "sent" });
r = M.onDelegation(d2);
check("an untagged delegation links to the one step marked delegated to that target", r && r.steps[1].delegation_id === d2.id);
const stray = ledger.addDelegation({ msg_id: "c", target: "someone-else", target_name: "someone-else", text: "hello", status: "sent" });
check("a delegation with no tag and no matching step links to nothing", M.onDelegation(stray) === null);
const held = ledger.updateDelegation(d2.id, { status: "held" });
check("held -> waiting approval", M.onDelegation(held).steps[1].status === "waiting_approval");
const failed = ledger.updateDelegation(d2.id, { status: "denied" });
check("denied -> failed", M.onDelegation(failed).steps[1].status === "failed");
const retry = ledger.addDelegation({ msg_id: "d", target: "JOYA Agent OS", target_name: "JOYA Agent OS", text: `M-${m.id} step 2 (retry)`, status: "sent" });
check("a re-sent step moves on from failed", M.onDelegation(retry).steps[1].status === "delegated");
check("an older delegation cannot move a re-sent step back", M.onDelegation(ledger.updateDelegation(d2.id, { status: "done" })) === null);

// approval for a tagged SendMessage
const ap = ledger.addApproval({ request_id: "q", tool: "SendMessage", input_json: "{}", summary: "s", expires_at: new Date().toISOString() });
r = M.onApproval(ap, { to: "joya-ai", message: `M-${m.id} step 3: delete the draft` });
check("a pending card for a tagged delegation puts the step in waiting approval", r && r.steps[2].status === "waiting_approval" && r.steps[2].approval_id === ap.id);
check("the approval row records its step", ledger.get("approvals", ap.id).step_id === r.steps[2].id);

M.updateStep(m.id, 2, { status: "done" });
r = M.updateStep(m.id, 3, { status: "skipped", note: "not needed" });
check("every step done or skipped: the mission is done", r.status === "done" && r.done_at);
check("a done step is not walked back by a late lifecycle event", M.onDelegation(ledger.updateDelegation(retry.id, { status: "working" })) === null || M.get(m.id).steps[1].status === "done");
r = M.update(m.id, { status: "cancelled" });
check("JOYA AI can close a mission explicitly", r.status === "cancelled");
check("steps cannot be added to a closed mission", throws(() => M.addStep(m.id, { title: "late" }), /cancelled/));
const m2 = M.create({ title: "Two", goal: "", steps: [], actor: "joya-ai" });
check("steps can be added later", M.addStep(m2.id, { title: "a", target: "fake-target" }).steps.length === 1);
check("forSession finds the step a session is on (map tint)", M.forSession("fake-target").id === m2.id);
check("forSession is null for a session with no open step", M.forSession("nobody") === null);
check("list(active) excludes closed missions", M.list({ status: "active" }).every((x) => ["planned", "active"].includes(x.status)));
check("at most 50 steps", throws(() => M.create({ title: "big", steps: Array.from({ length: 51 }, () => ({ title: "s" })) })));

/* ------------------------------------------------------------- cost deltas --- */
{
  const d = cost.turnDeltas([
    { id: 1, cost_usd: 0.5 },
    { id: 2, cost_usd: 1.25 },
    { id: 3, cost_usd: null },
    { id: 4, cost_usd: 2.0 },
    { id: 5, cost_usd: 0.3 }, // restarted: the total went down
    { id: 6, cost_usd: 0.9 },
  ]);
  check("the first turn costs its total", d.get(1) === 0.5);
  check("later turns cost the difference", Math.abs(d.get(2) - 0.75) < 1e-9 && Math.abs(d.get(4) - 0.75) < 1e-9);
  check("a turn without a cost is skipped", !d.has(3));
  check("a total that goes down is a new process: that turn costs its own total", Math.abs(d.get(5) - 0.3) < 1e-9 && Math.abs(d.get(6) - 0.6) < 1e-9);
  const sum = [...d.values()].reduce((a, b) => a + b, 0);
  check("the day's cost is the sum of deltas, not of totals", Math.abs(sum - 2.9) < 1e-9);
  const e = cost.turnDeltas([
    { id: 1, cost_usd: 5.0, proc_start: "A" },
    { id: 2, cost_usd: 6.0, proc_start: "B" }, // new process that spent MORE before its first turn
    { id: 3, cost_usd: 6.5, proc_start: "B" },
  ]);
  // (Until 2026-09-30 a new stamp started over; but a new process RESUMES the session and the CLI carries its total on.)
  check("a new process whose total is higher resumed the session: its first turn costs the difference", Math.abs(e.get(2) - 1.0) < 1e-9 && Math.abs(e.get(3) - 0.5) < 1e-9);
  const f = cost.turnDeltas([
    { id: 261, cost_usd: 51.231, proc_start: "2026-09-30T08:25:29.882Z" },
    { id: 262, cost_usd: 51.75, proc_start: "2026-09-30T13:59:25.622Z" }, // the first turn after a supervisor restart
    { id: 263, cost_usd: 51.979, proc_start: "2026-09-30T13:59:25.622Z" },
  ]);
  check("the fact from 30 Sep: 51.231 then, after a restart, 51.75 is 0.519 (not 51.75)", Math.abs(f.get(262) - 0.519) < 1e-9 && Math.abs(f.get(263) - 0.229) < 1e-9);
  const g = cost.turnDeltas([{ id: 1, cost_usd: 40, proc_start: "A" }, { id: 2, cost_usd: 0.4, proc_start: "B" }]);
  check("a fresh session (the total went down) still starts from zero", Math.abs(g.get(2) - 0.4) < 1e-9);
  const h = cost.turnDeltas([{ id: 1, cost_usd: 0.3, proc_start: "A" }, { id: 2, cost_usd: 0.5, proc_start: "B#new" }, { id: 3, cost_usd: 0.7, proc_start: "B#new" }]);
  check("a process that started a new session (#new) starts from zero even when its total is higher", Math.abs(h.get(2) - 0.5) < 1e-9 && Math.abs(h.get(3) - 0.2) < 1e-9);
  check("the fact from 28 Sep: 6.08 then 9.12 in one process is 3.04", Math.abs(cost.turnDeltas([{ id: 1, cost_usd: 6.08, proc_start: "P" }, { id: 2, cost_usd: 9.12, proc_start: "P" }]).get(2) - 3.04) < 1e-9);
}

/* ---------------------------------- the migration of the inflated rows --- */
{
  const db = ledger.db;
  const add = (cost_usd, proc_start, delta) => {
    const r = ledger.addTurn({ uuid: "mig-" + Math.random().toString(36).slice(2), source: "dashboard", actor: "t", text: "x", status: "done" });
    db.prepare("UPDATE turns SET cost_usd = ?, proc_start = ?, cost_delta_usd = ? WHERE id = ?").run(cost_usd, proc_start, delta, r.id);
    return r.id;
  };
  db.exec("DELETE FROM turns");
  const a = add(51.231, "P1", 51.231); // the first row costs its whole total
  const b = add(51.75, "P2", 51.75); // written by the old code: the whole running total
  const c = add(51.979, "P2", 0.229);
  const r1 = cost.recomputeTurnDeltas(db);
  const val = (id) => db.prepare("SELECT cost_delta_usd AS v FROM turns WHERE id = ?").get(id).v;
  check("the start-up recompute corrects the inflated row (51.75 -> 0.519) and reports it", r1.changed === 1 && Math.abs(val(b) - 0.519) < 1e-9 && Math.abs(r1.before - 51.75) < 1e-9 && Math.abs(r1.after - 0.519) < 1e-9, JSON.stringify(r1));
  check("  the other rows are untouched, cost_usd (the CLI's own figure) too", Math.abs(val(a) - 51.231) < 1e-9 && Math.abs(val(c) - 0.229) < 1e-9 && db.prepare("SELECT cost_usd AS v FROM turns WHERE id = ?").get(b).v === 51.75);
  const r2 = cost.recomputeTurnDeltas(db);
  check("  idempotent: a second run changes nothing", r2.changed === 0);
  db.exec("DELETE FROM turns");
}

/* ------------------------------------------------ JOYA AI's tokens per turn --- */
{
  // The result's usage is the PROCESS's running total (Claude Code sums its per-model usage), like total_cost_usd.
  const U = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
  const a = cost.turnTokenDelta(U(1000, 100, 5000, 300), "P", null);
  const b = cost.turnTokenDelta(U(2500, 300, 12000, 300), "P", { cum: a.cum, proc_start: "P" });
  const c = cost.turnTokenDelta(U(900, 50, 4000, 100), "Q", { cum: b.cum, proc_start: "P" });
  const d = cost.turnTokenDelta(U(10, 1, 1, 1), "P", { cum: b.cum, proc_start: "P" });
  check("turn tokens: the first turn is its running total", JSON.stringify(a.delta) === JSON.stringify({ input: 1000, output: 100, cache_read: 5000, cache_write: 300 }));
  check("  the next turn of the same process is the difference", JSON.stringify(b.delta) === JSON.stringify({ input: 1500, output: 200, cache_read: 7000, cache_write: 0 }));
  check("  a new process starts again from zero (another stamp, or a count going down)", c.delta.input === 900 && c.delta.cache_read === 4000 && d.delta.input === 10);
  // A mission's tokens: the sum over its turns; none counted -> null ("—" on the board).
  const mt = M.create({ title: "Tok", goal: "", steps: [], actor: "joya-ai" });
  check("a mission with no counted turns has no token figure", M.get(mt.id).metrics.tokens === null);
  const t1 = ledger.addTurn({ source: "user", text: "x", status: "done" }), t2 = ledger.addTurn({ source: "user", text: "y", status: "done" });
  ledger.update("turns", t1.id, { tok_input: 1000, tok_output: 100, tok_cache_read: 5000, tok_cache_write: 300 });
  ledger.update("turns", t2.id, { tok_input: 1500, tok_output: 200, tok_cache_read: 7000, tok_cache_write: 0 });
  M.linkTurn(mt.id, t1.id); M.linkTurn(mt.id, t2.id);
  const tk = M.get(mt.id).metrics.tokens;
  check("a mission's tokens: JOYA AI's turns on it, summed, with the total", tk && tk.input === 2500 && tk.output === 300 && tk.cache_read === 12000 && tk.cache_write === 300 && tk.total === 15100, JSON.stringify(tk));
}

/* ---------------------------------------------------------- transcripts --- */
{
  check("prices: Opus 5.5 is $4/$20", cost.priceOf("claude-opus-5-5").join() === "4,20,0.2");
  check("prices: Haiku 4.5 by its dated id", cost.priceOf("claude-haiku-4-5-20251001")[0] === 1);
  const u = { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000000 } };
  check("usage cost: input + output + cache read + 1h cache write", Math.abs(cost.usageCost("claude-opus-5-5", u) - (4 + 2 + 0.2 + 8)) < 1e-9);
  const rec = (id, ts, out) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const lines = [rec("m1", iso, 100), rec("m1", iso, 100), rec("m2", iso, 50), "not json", JSON.stringify({ type: "user", message: { content: "hi" } })];
  const seen = new Set();
  const p = cost.parseUsage(lines, seen, () => "D", 0);
  check("usage is counted once per message id (streamed blocks repeat it)", p.agg.length === 1 && p.agg[0].output === 150 && p.agg[0].input === 20);
  check("old records are ignored", cost.parseUsage([rec("m9", "2020-01-01T00:00:00Z", 5)], new Set(), () => "D", now - 1000).agg.length === 0);

  // the incremental scanner
  const proj = path.join(tmp, "projects", "-root-x");
  fs.mkdirSync(proj, { recursive: true });
  const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const file = path.join(proj, sid + ".jsonl");
  fs.writeFileSync(file, lines.slice(0, 3).join("\n") + "\n");
  const sub = path.join(proj, sid, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-x1.jsonl"), rec("s1", iso, 7) + "\n");
  const self = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  fs.writeFileSync(path.join(proj, self + ".jsonl"), rec("z1", iso, 999) + "\n");
  const day = () => "2026-09-28";
  const scan = async () => {
    const sc = new cost.Scanner({ ledger, projectsDir: path.join(tmp, "projects"), dayOf: day, exclude: (s) => s === self });
    await sc.scan();
    return ledger.db.prepare("SELECT session_id, SUM(output) AS o FROM cost_daily GROUP BY session_id").all();
  };
  (async () => {
    let rows = await scan();
    const mine = rows.find((x) => x.session_id === sid);
    check("the scanner totals a session and its sub-agents together", mine && mine.o === 157, JSON.stringify(rows));
    check("JOYA AI's own transcript is excluded (its cost comes from the ledger)", !rows.some((x) => x.session_id === self));
    rows = await scan();
    check("a rescan with nothing new adds nothing (a restart too: offsets are in the ledger)", rows.find((x) => x.session_id === sid).o === 157);
    fs.appendFileSync(file, rec("m2", iso, 50) + "\n" + rec("m3", iso, 1) + "\n");
    rows = await scan();
    check("appended lines are read once; a message id repeated across the boundary is not double counted", rows.find((x) => x.session_id === sid).o === 158, JSON.stringify(rows));
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })();
}
