/**
 * Watchers (lib/watchers.js) on a scratch ledger with a fake clock:
 * thresholds, de-duplication, the cooldown, the hourly rate limit, the on/off
 * switch, and state surviving a new Watchers (a supervisor restart).
 *
 *     node joya-ai/tools/test-watchers.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Ledger } = require(path.join(__dirname, "..", "lib", "ledger.js"));
const { Watchers, ODOO_ERROR_RE } = require(path.join(__dirname, "..", "lib", "watchers.js"));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-watch-"));
const ledger = new Ledger(path.join(tmp, "ledger.db"));
let clock = Date.parse("2026-09-28T10:00:00Z");
const fired = [];
const bumped = [];
const mk = (cfg = {}) =>
  new Watchers({ ledger, cfg: { watcher_cooldown_s: 600, watcher_max_investigations_per_hour: 3, ...cfg }, now: () => clock, onFire: (d, o) => fired.push({ d, o }), onBump: (d) => bumped.push(d) });
let w = mk();
const at = (ms) => new Date(ms).toISOString();

/* ----------------------------------------------------------- thresholds --- */
check("five watchers, seeded on", w.list().length === 5 && w.list().every((x) => x.enabled));
check("healthy services fire nothing", w.observeServices([{ unit: "nginx", active: "active" }]).length === 0 && fired.length === 0);
let r = w.observeServices([{ unit: "nginx", active: "active" }, { unit: "joya-agent@admin", active: "failed", since: "now" }]);
check("a failed unit fires", r.length === 1 && r[0].created && fired.length === 1 && fired[0].d.subject === "joya-agent@admin");
check("the card starts as investigating", fired[0].d.status === "investigating" && fired[0].o.investigate === true);

check("disk under the threshold is quiet", w.observeDisk({ pct: 84, free: 1e10 }).length === 0);
r = w.observeDisk({ pct: 85, free: 1e10 });
check("disk at 85% fires", r.length === 1 && r[0].created);

const bans = (n, start) => Array.from({ length: n }, (_, i) => ({ type: "ban", jail: "sshd", at: at(start - i * 1000) }));
check("20 bans in 10 minutes is not a burst", w.observeEvents(bans(20, clock)).length === 0);
clock += 60000;
r = w.observeEvents(bans(1, clock));
check("the 21st within the window is", r.length === 1 && r[0].created && r[0].decision.watcher === "ban_burst");
clock += 11 * 60000;
check("the window slides: old bans drop out", w.observeEvents([]).length === 0 && /quiet/.test(w.get("ban_burst").state_text));

const starts = (unit, n) => Array.from({ length: n }, (_, i) => ({ type: "start", unit, at: at(clock - i * 60000) }));
check("two agent restarts are fine", w.observeEvents(starts("joya-agent@admin", 2)).length === 0);
r = w.observeEvents(starts("joya-agent@admin", 1));
check("the third within 10 minutes fires agent_failing", r.some((x) => x.created && x.decision.watcher === "agent_failing"));
check("other units' starts do not count", w.observeEvents(starts("nginx", 5)).every((x) => x.decision.watcher !== "agent_failing" || x.decision.subject !== "nginx"));

const errs = (n) => Array.from({ length: n }, (_, i) => `2026-09-28 10:00:0${i},111 4242 ERROR gizaseeds_test odoo.http: boom`);
check("the Odoo error pattern matches Odoo's log format", ODOO_ERROR_RE.test(errs(1)[0]) && !ODOO_ERROR_RE.test("2026-09-28 10:00:00,111 4242 INFO db: ok"));
check("four errors are quiet", w.observeOdooLines(errs(4)).length === 0);
r = w.observeOdooLines(errs(1));
check("the fifth within 5 minutes fires, with the lines as evidence", r.length === 1 && r[0].created && /boom/.test(r[0].decision.evidence));

/* ------------------------------------------- de-duplication and cooldown --- */
const before = fired.length;
r = w.observeServices([{ unit: "joya-agent@admin", active: "failed" }]);
check("a still-failed unit does not raise a second card", !r[0].created && r[0].skipped === "duplicate" && fired.length === before);
check("it bumps the open card's count", r[0].decision.count === 2 && bumped.length >= 1);
// close the card (fixed), then it recurs
ledger.update("decisions", r[0].decision.id, { status: "done", updated_at: at(clock) });
clock += 5 * 60000;
r = w.observeServices([{ unit: "joya-agent@admin", active: "failed" }]);
check("within the cooldown a closed subject stays quiet", !r[0].created && r[0].skipped === "cooldown");
clock += 6 * 60000;
r = w.observeServices([{ unit: "joya-agent@admin", active: "failed" }]);
check("after the cooldown it raises a fresh card", r[0].created);

/* ------------------------------------------------------------ rate limit --- */
// 3 investigations an hour in this config; several already happened this hour.
const hour = ledger.db.prepare("SELECT count(*) AS n FROM decisions WHERE rate_limited = 0 AND created_at >= ?").get(at(clock - 3600000)).n;
check("the limit has been reached in this hour", hour >= 3, String(hour));
r = w.fire("service_failed", "nginx", { title: "nginx failed" });
check("past the hourly limit the card is still raised", r.created);
check("but marked rate-limited, open, with no investigation", r.decision.rate_limited === 1 && r.decision.status === "open" && fired[fired.length - 1].o.investigate === false);
clock += 3600000 + 1000;
r = w.fire("service_failed", "ssh", { title: "ssh failed" });
check("an hour later investigations resume", r.created && r.investigate === true);

// a dismissed card keeps its subject quiet for a day, not the cooldown
{
  const x = w.fire("disk", "/data", { title: "t" });
  ledger.update("decisions", x.decision.id, { status: "dismissed", updated_at: at(clock) });
  clock += 20 * 60000;
  check("after a Dismiss the cooldown alone does not bring it back", w.fire("disk", "/data", { title: "t" }).skipped === "cooldown");
  clock += 24 * 3600000;
  check("a day after a Dismiss it can fire again", w.fire("disk", "/data", { title: "t" }).created);
}

/* ------------------------------------------------------ switch + restart --- */
w.set("odoo_errors", false, "amaraghy");
w = mk(); // a new supervisor on the same ledger
check("the switch survives a restart", w.get("odoo_errors").enabled === false && w.get("odoo_errors").updated_by === "amaraghy");
check("a switched-off watcher never fires", w.observeOdooLines(errs(9)).every((x) => x.skipped === "disabled"));
r = w.observeServices([{ unit: "ssh", active: "failed" }]);
check("an open card survives a restart: no second card", !r[0].created && r[0].skipped === "duplicate");
check("fired_24h counts recent hits", w.get("service_failed").fired_24h >= 2, String(w.get("service_failed").fired_24h));
check("unknown watcher refused", (() => {
  try {
    w.set("nope", true, "x");
    return false;
  } catch (_) {
    return true;
  }
})());

ledger.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
