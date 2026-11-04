"use strict";
/**
 * Schedules for standing orders: five-field cron evaluated in a time zone.
 *
 *   minute hour day-of-month month day-of-week      (0 or 7 = Sunday)
 *
 * Fields take *, n, a-b, a-b/s, * /s and comma lists. When both day fields are
 * restricted a day matches either one (Vixie cron's rule).
 *
 * Times are wall-clock times in the order's zone (Africa/Cairo by default),
 * which has daylight saving: Egypt moves 00:00 -> 01:00 on the last Friday of
 * April and 00:00 -> 23:00 (the day before) at the end of October. A time that
 * does not exist that day runs at the first moment after the gap; a time that
 * happens twice runs once, at the first.
 *
 * The friendly kinds the editor offers compile to cron:
 *   daily    at HH:MM            "M H * * *"
 *   weekdays at HH:MM            "M H * * 0-4"   Egypt's working week, Sun-Thu
 *   weekly   at HH:MM on dow     "M H * * D"
 *   hours    every N hours       "M * /N * * *"  (M = minute of `at`, default 0)
 *   cron     as written
 */

const DAY = 24 * 3600 * 1000;
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const KINDS = ["daily", "weekdays", "weekly", "hours", "cron"];
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/* ------------------------------------------------------------------ cron --- */

function field(spec, min, max, name) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad ${name} field "${part}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (!(step >= 1) || lo < min || hi > max || lo > hi) throw new Error(`${name} out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a cron schedule has five fields: minute hour day month weekday");
  const dow = field(parts[4], 0, 7, "weekday");
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    min: [...field(parts[0], 0, 59, "minute")].sort((a, b) => a - b),
    hour: [...field(parts[1], 0, 23, "hour")].sort((a, b) => a - b),
    dom: field(parts[2], 1, 31, "day"),
    mon: field(parts[3], 1, 12, "month"),
    dow,
    domStar: parts[2] === "*",
    dowStar: parts[4] === "*",
  };
}

/* ------------------------------------------------------------ time zones --- */

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" })
    );
  }
  return fmtCache.get(tz);
}

function checkTz(tz) {
  try {
    fmt(tz).format(new Date());
    return tz;
  } catch (_) {
    throw new Error(`unknown time zone "${tz}"`);
  }
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a zone. */
function wall(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, dow: WD[o.weekday] };
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(ms, tz) {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in a zone. Ambiguous: the first.
 * Nonexistent (in a spring-forward gap): the first moment after the gap.
 */
function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const cands = [];
  for (const probe of [guess - DAY / 2, guess, guess + DAY / 2]) {
    const t = guess - offsetAt(probe, tz);
    const w = wall(t, tz);
    if (w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi) cands.push(t);
  }
  if (cands.length) return Math.min(...cands);
  // In a gap: the wall time was skipped. Using the offset from before the
  // jump lands just after it.
  const before = guess - offsetAt(guess - DAY / 2, tz);
  const after = guess - offsetAt(guess + DAY / 2, tz);
  return Math.max(before, after);
}

/** Next run strictly after `afterMs`, or null if none within ~400 days. */
function nextRun(expr, tz, afterMs) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const start = wall(afterMs, tz);
  let y = start.y;
  let m = start.m;
  let d = start.d;
  for (let i = 0; i < 400; i++) {
    const dayUtc = Date.UTC(y, m - 1, d);
    const dow = new Date(dayUtc).getUTCDay();
    const domOk = c.dom.has(d);
    const dowOk = c.dow.has(dow);
    const dayOk = c.mon.has(m) && (c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk);
    if (dayOk) {
      for (const h of c.hour) {
        for (const mi of c.min) {
          const t = zonedToUtc(y, m, d, h, mi, tz);
          if (t > afterMs) return t;
        }
      }
    }
    const next = new Date(dayUtc + DAY);
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return null;
}

/* ----------------------------------------------------------- friendly kinds --- */

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Validate an editor schedule and compile it.
 * Returns { kind, at, dow, every_h, cron, label }.
 */
function compile(s) {
  if (!s || typeof s !== "object") throw new Error("schedule is required");
  const kind = s.kind;
  if (!KINDS.includes(kind)) throw new Error("schedule kind must be one of " + KINDS.join(", "));
  const at = s.at === undefined || s.at === null || s.at === "" ? null : String(s.at);
  if (at !== null && !AT_RE.test(at)) throw new Error("time must be HH:MM (24-hour)");
  const [hh, mm] = at ? at.split(":").map(Number) : [null, null];
  let cron;
  let label;
  let dow = null;
  let every = null;
  switch (kind) {
    case "daily":
      if (at === null) throw new Error("a daily order needs a time");
      cron = `${mm} ${hh} * * *`;
      label = `Every day at ${at}`;
      break;
    case "weekdays":
      if (at === null) throw new Error("a working-day order needs a time");
      cron = `${mm} ${hh} * * 0-4`;
      label = `Sunday to Thursday at ${at}`;
      break;
    case "weekly":
      if (at === null) throw new Error("a weekly order needs a time");
      dow = Number(s.dow);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new Error("weekday must be 0 (Sunday) to 6 (Saturday)");
      cron = `${mm} ${hh} * * ${dow}`;
      label = `${DOW_NAMES[dow]}s at ${at}`;
      break;
    case "hours":
      every = Number(s.every_h);
      if (!Number.isInteger(every) || every < 1 || every > 24) throw new Error("every N hours needs N from 1 to 24");
      cron = `${mm === null ? 0 : mm} ${every === 1 ? "*" : "*/" + every} * * *`;
      label = every === 1 ? `Every hour at :${pad(mm || 0)}` : `Every ${every} hours at :${pad(mm || 0)}`;
      break;
    case "cron":
      if (typeof s.cron !== "string" || s.cron.length > 100) throw new Error("cron must be five fields");
      cron = s.cron.trim().replace(/\s+/g, " ");
      parseCron(cron);
      label = `Cron ${cron}`;
      break;
  }
  parseCron(cron);
  return { kind, at, dow, every_h: every, cron, label };
}

function label(order) {
  try {
    return compile({ kind: order.kind, at: order.at, dow: order.dow, every_h: order.every_h, cron: order.cron }).label;
  } catch (_) {
    return "Cron " + order.cron;
  }
}

/** YYYY-MM-DD of an instant in a zone. */
function dayOf(ms, tz) {
  const w = wall(ms, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

module.exports = { KINDS, parseCron, nextRun, zonedToUtc, wall, offsetAt, compile, label, checkTz, dayOf };
