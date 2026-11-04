/**
 * Standing-order schedules (lib/schedule.js): cron parsing, the editor's
 * friendly kinds, next run in Africa/Cairo across daylight saving, and the
 * scheduler's missed-run rule (run once, never a burst) against a real ledger.
 *
 *     node joya-ai/tools/test-schedule.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const s = require(path.join(__dirname, "..", "lib", "schedule.js"));

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
const TZ = "Africa/Cairo";
const iso = (ms) => (ms == null ? String(ms) : new Date(ms).toISOString());
const throws = (f) => {
  try {
    f();
    return false;
  } catch (_) {
    return true;
  }
};

/* ------------------------------------------------------------- parsing --- */
{
  const c = s.parseCron("*/15 9-17 * * 1-5");
  check("*/15 minutes", c.min.join() === "0,15,30,45");
  check("9-17 hours", c.hour.length === 9 && c.hour[0] === 9 && c.hour[8] === 17);
  check("1-5 weekdays", [...c.dow].sort().join() === "1,2,3,4,5");
  check("7 means Sunday", s.parseCron("0 0 * * 7").dow.has(0));
  check("lists and steps", s.parseCron("0,30 1-10/3 * * *").hour.join() === "1,4,7,10");
  check("four fields refused", throws(() => s.parseCron("* * * *")));
  check("minute 60 refused", throws(() => s.parseCron("60 * * * *")));
  check("garbage refused", throws(() => s.parseCron("a b c d e")));
  check("reversed range refused", throws(() => s.parseCron("0 10-5 * * *")));
}

/* --------------------------------------------------------- friendly kinds --- */
{
  const d = s.compile({ kind: "daily", at: "07:30" });
  check("daily 07:30", d.cron === "30 7 * * *" && d.label === "Every day at 07:30");
  const w = s.compile({ kind: "weekdays", at: "09:05" });
  check("working days are Sunday to Thursday (Egypt)", w.cron === "5 9 * * 0-4" && /Sunday to Thursday/.test(w.label));
  check("weekly on Monday", s.compile({ kind: "weekly", at: "09:00", dow: 1 }).cron === "0 9 * * 1");
  check("every 6 hours at :15", s.compile({ kind: "hours", every_h: 6, at: "00:15" }).cron === "15 */6 * * *");
  check("every hour", s.compile({ kind: "hours", every_h: 1 }).cron === "0 * * * *");
  check("cron passes through", s.compile({ kind: "cron", cron: "0  2 * * 0" }).cron === "0 2 * * 0");
  check("daily without a time refused", throws(() => s.compile({ kind: "daily" })));
  check("bad time refused", throws(() => s.compile({ kind: "daily", at: "24:00" })));
  check("weekly without a weekday refused", throws(() => s.compile({ kind: "weekly", at: "09:00" })));
  check("every 25 hours refused", throws(() => s.compile({ kind: "hours", every_h: 25 })));
  check("unknown kind refused", throws(() => s.compile({ kind: "monthly", at: "09:00" })));
  check("unknown zone refused", throws(() => s.checkTz("Mars/Olympus")));
}

/* ---------------------------------------------------- next run, with DST --- */
{
  // 28 Sep 2026 is summer time in Cairo (UTC+3).
  const t = s.nextRun("30 7 * * *", TZ, Date.parse("2026-09-28T10:00:00Z"));
  check("07:30 Cairo in summer is 04:30 UTC, next day", iso(t) === "2026-09-29T04:30:00.000Z", iso(t));
  const before = s.nextRun("30 7 * * *", TZ, Date.parse("2026-09-28T04:00:00Z"));
  check("same day when it is still before 07:30", iso(before) === "2026-09-28T04:30:00.000Z", iso(before));
  const exact = s.nextRun("30 7 * * *", TZ, Date.parse("2026-09-28T04:30:00Z"));
  check("strictly after: at 07:30 exactly the next is tomorrow", iso(exact) === "2026-09-29T04:30:00.000Z", iso(exact));
  // winter (UTC+2)
  const win = s.nextRun("30 7 * * *", TZ, Date.parse("2026-12-01T00:00:00Z"));
  check("07:30 Cairo in winter is 05:30 UTC", iso(win) === "2026-12-01T05:30:00.000Z", iso(win));
  // DST ends: the night of Thu 29 Oct 2026, 24:00 -> 23:00; 23:30 happens twice
  const a = s.nextRun("30 23 * * *", TZ, Date.parse("2026-10-29T12:00:00Z"));
  const b = s.nextRun("30 23 * * *", TZ, a);
  check("a doubled wall time runs at its first occurrence", iso(a) === "2026-10-29T20:30:00.000Z", iso(a));
  check("and not again an hour later", iso(b) === "2026-10-30T21:30:00.000Z", iso(b));
  // DST starts: Fri 30 Apr 2027, 00:00 -> 01:00; 00:30 does not exist
  const gap = s.nextRun("30 0 * * *", TZ, Date.parse("2027-04-29T12:00:00Z"));
  const w = s.wall(gap, TZ);
  check("a skipped wall time runs once, just after the jump", w.d === 30 && w.h === 1 && w.mi === 30, JSON.stringify(w));
  const after = s.nextRun("30 0 * * *", TZ, gap);
  check("and the next day is normal again", s.wall(after, TZ).h === 0 && s.wall(after, TZ).d === 1, iso(after));
  // weekdays across a weekend (Fri, Sat off)
  const fri = s.nextRun("0 9 * * 0-4", TZ, Date.parse("2026-10-01T08:00:00Z")); // Thu 1 Oct 11:00 Cairo
  check("Sun-Thu: after Thursday 09:00 comes Sunday", s.wall(fri, TZ).dow === 0, JSON.stringify(s.wall(fri, TZ)));
  check("dom OR dow when both are set (Vixie)", s.wall(s.nextRun("0 12 1 * 5", TZ, Date.parse("2026-10-02T12:00:00Z")), TZ).dow === 5);
  check("Feb 30 never happens", s.nextRun("0 0 30 2 *", TZ, Date.now()) === null);
  check("every 6 hours", s.wall(s.nextRun("15 */6 * * *", TZ, Date.parse("2026-09-28T10:00:00Z")), TZ).h === 18);
}

/* -------------------------------------------- the scheduler, missed runs --- */
{
  // The supervisor's rule, exercised on a real ledger through lib/features.js:
  // a run missed while the supervisor was down runs ONCE at the next tick, and
  // the next run is computed from now -- never a burst of the missed ones.
  const { Ledger } = require(path.join(__dirname, "..", "lib", "ledger.js"));
  const { createFeatures } = require(path.join(__dirname, "..", "lib", "features.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-sched-"));
  const ledger = new Ledger(path.join(tmp, "ledger.db"));
  const queued = [];
  let tid = 0;
  const f = createFeatures({
    ledger,
    cfg: { tz: TZ, helper: "/nonexistent", odoo_log: "/nonexistent" },
    emit: () => {},
    queueTurn: (t) => {
      const row = ledger.addTurn({ uuid: "u" + ++tid, source: t.source, actor: t.actor, text: t.text, status: "queued", order_id: t.order_id });
      queued.push(row);
      return row;
    },
    log: () => {},
    warn: () => {},
    vitals: () => ({ host: "test", disk: { pct: 5 } }),
    sessions: () => [],
    sessionsWithLedger: () => [],
    selfSessionId: () => null,
    currentTurnId: () => null,
    projectsDir: path.join(tmp, "projects"),
    describeTool: (n) => n,
  });
  f.ops["order-create"]({ name: "Hourly", schedule: { kind: "cron", cron: "0 * * * *" }, target: "joya-ai", prompt: "p", delivery: ["cc"] }, { actor: "t" });
  const o = ledger.db.prepare("SELECT * FROM orders WHERE name = 'Hourly'").get();
  // pretend the supervisor was down for five hours
  const missed = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  ledger.update("orders", o.id, { next_run_at: missed });
  f.tickOrders();
  f.tickOrders();
  f.tickOrders();
  const runs = ledger.db.prepare("SELECT * FROM order_runs WHERE order_id = ?").all(o.id);
  check("five missed hourly runs run once, not five times", runs.length === 1 && runs[0].scheduled_for === missed, JSON.stringify(runs));
  const after = ledger.get("orders", o.id);
  check("the next run is in the future", Date.parse(after.next_run_at) > Date.now());
  check("a scheduled run is not manual", runs[0].manual === 0);
  // a run still going when the next is due is not started twice
  ledger.update("orders", o.id, { next_run_at: new Date(Date.now() - 1000).toISOString() });
  f.tickOrders();
  check("while a run is still going, the next is skipped, not stacked", ledger.db.prepare("SELECT count(*) AS n FROM order_runs WHERE order_id = ?").get(o.id).n === 1);
  // a paused order never runs
  f.ops["order-pause"]({ order_id: o.id, paused: true }, { actor: "t" });
  check("pausing clears the next run", ledger.get("orders", o.id).next_run_at === null);
  f.ops["order-pause"]({ order_id: o.id, paused: false }, { actor: "t" });
  check("resuming sets it again", Date.parse(ledger.get("orders", o.id).next_run_at) > Date.now());
  // the seeded briefing
  f.start();
  f.stop();
  const brief = ledger.db.prepare("SELECT * FROM orders WHERE seed_key = 'morning-briefing'").get();
  check("start() seeds the Morning briefing at 07:30 Cairo, daily", brief && brief.cron === "30 7 * * *" && brief.tz === TZ);
  const b2 = s.wall(Date.parse(brief.next_run_at), TZ);
  check("its next run is 07:30 Cairo", b2.h === 7 && b2.mi === 30);
  check("a run left 'running' by a dead supervisor is closed at start", ledger.db.prepare("SELECT count(*) AS n FROM order_runs WHERE status = 'running'").get().n === 0);
  ledger.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
