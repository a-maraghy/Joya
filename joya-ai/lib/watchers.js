"use strict";
/**
 * Watchers: things on THIS machine worth JOYA AI's attention without being
 * asked. Each one reads an event source the box already has, decides whether
 * what it sees crosses its line, and if so raises a decision card and asks
 * JOYA AI to investigate and propose a fix. JOYA AI acts only after the
 * administrator approves -- and even then through the approval gate.
 *
 *   service_failed  a tracked unit enters the failed state (helper service-list)
 *   ban_burst       more than N fail2ban bans within a window (helper pulse-feed)
 *   disk            the root filesystem above a threshold (statfs)
 *   agent_failing   a Telegram agent restarts N times within a window (pulse-feed starts)
 *   odoo_errors     N or more ERROR lines in the TRIAL box's Odoo log within a window
 *                   (read-only tail of /var/log/odoo/odoo.log; live Odoo is never watched)
 *
 * Flood control, so a flapping service cannot swamp JOYA AI:
 *   - de-duplication: one open card per (watcher, subject); a repeat only bumps
 *     its count and last-seen time;
 *   - cooldown: after a card is closed (done, failed) the same (watcher,
 *     subject) stays quiet for cooldown_s; after a Dismiss, for
 *     dismiss_quiet_s (a day), so a condition that persists does not return
 *     every half hour;
 *   - rate limit: at most max_investigations_per_hour JOYA AI turns; past that
 *     the card is still raised, marked rate-limited, with an Investigate button.
 *
 * All of that state is in the ledger, so a restart neither forgets an open card
 * nor re-fires everything it saw in the last fifteen minutes.
 */

const DEFS = [
  {
    key: "service_failed",
    name: "Service failed",
    description: "Any tracked unit on this VPS enters the failed state",
    threshold: {},
    action: "investigate + decision card",
  },
  {
    key: "ban_burst",
    name: "Burst of bans",
    description: "More than 20 fail2ban bans within 10 minutes",
    threshold: { bans: 20, window_min: 10 },
    action: "investigate; info only if all refused",
  },
  {
    key: "disk",
    name: "Disk over threshold",
    description: "Root filesystem above 85%",
    threshold: { pct: 85 },
    action: "find the growth + propose cleanup",
  },
  {
    key: "agent_failing",
    name: "Agent failing",
    description: "A Telegram agent restarts 3 times within 10 minutes",
    threshold: { starts: 3, window_min: 10 },
    action: "decision card",
  },
  {
    key: "odoo_errors",
    name: "Odoo errors (trial box)",
    description: "5 or more ERROR lines in the trial Odoo log within 5 minutes",
    threshold: { errors: 5, window_min: 5 },
    action: "read the traceback + propose a fix",
  },
];
const KEYS = DEFS.map((d) => d.key);
const OPEN = ["investigating", "proposed", "open", "approved", "running"];
const ODOO_ERROR_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d+ \d+ (ERROR|CRITICAL) /;

class Watchers {
  /**
   * ledger: the Ledger. onFire(decision, {investigate}) is called for a new
   * card; onBump(decision) for a repeat. now(): ms clock (tests).
   */
  constructor({ ledger, cfg = {}, now = () => Date.now(), onFire = () => {}, onBump = () => {} }) {
    this.ledger = ledger;
    this.now = now;
    this.onFire = onFire;
    this.onBump = onBump;
    this.cooldownMs = (cfg.watcher_cooldown_s || 1800) * 1000;
    // Dismissed means "I know, leave it": a condition that persists (an Odoo
    // cron failing every minute) must not come back every half hour.
    this.dismissQuietMs = (cfg.watcher_dismiss_quiet_s || 86400) * 1000;
    this.maxPerHour = cfg.watcher_max_investigations_per_hour || 4;
    this.windows = { bans: [], starts: new Map(), odoo: [] };
    this.states = new Map(); // key -> state text for the page
    this.seed();
  }

  seed() {
    const t = new Date(this.now()).toISOString();
    const ins = this.ledger.db.prepare("INSERT OR IGNORE INTO watchers (key, enabled, updated_by, updated_at) VALUES (?, 1, 'seed', ?)");
    for (const k of KEYS) ins.run(k, t);
  }

  enabled(key) {
    const r = this.ledger.db.prepare("SELECT enabled FROM watchers WHERE key = ?").get(key);
    return !!(r && r.enabled);
  }

  set(key, enabled, actor) {
    if (!KEYS.includes(key)) throw new Error("no such watcher");
    this.ledger.db.prepare("UPDATE watchers SET enabled = ?, updated_by = ?, updated_at = ? WHERE key = ?").run(enabled ? 1 : 0, actor, new Date(this.now()).toISOString(), key);
    return this.get(key);
  }

  get(key) {
    const d = DEFS.find((x) => x.key === key);
    const r = this.ledger.db.prepare("SELECT * FROM watchers WHERE key = ?").get(key) || {};
    const since = new Date(this.now() - 86400000).toISOString();
    const fired = this.ledger.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM decisions WHERE watcher = ? AND last_seen >= ?").get(key, since).n;
    return {
      key,
      name: d.name,
      description: d.description,
      action: d.action,
      threshold: d.threshold,
      enabled: !!r.enabled,
      last_fired_at: r.last_fired_at || null,
      fired_24h: fired,
      state_text: this.states.get(key) || (r.enabled ? "quiet" : "off"),
      updated_by: r.updated_by || null,
      updated_at: r.updated_at || null,
    };
  }

  list() {
    return KEYS.map((k) => this.get(k));
  }

  /* ------------------------------------------------------------ firing --- */

  /**
   * Something crossed a line. Returns { decision, created, investigate }.
   * `force` skips the enabled check (fault injection in tests still honours it
   * unless forced).
   */
  fire(key, subject, { title, detail, evidence }, { force = false } = {}) {
    if (!KEYS.includes(key)) throw new Error("no such watcher");
    if (!force && !this.enabled(key)) return { decision: null, created: false, skipped: "disabled" };
    const db = this.ledger.db;
    const t = new Date(this.now()).toISOString();
    const open = db
      .prepare(`SELECT * FROM decisions WHERE watcher = ? AND subject = ? AND status IN (${OPEN.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`)
      .get(key, subject, ...OPEN);
    if (open) {
      db.prepare("UPDATE decisions SET count = count + 1, last_seen = ?, updated_at = ? WHERE id = ?").run(t, t, open.id);
      const d = this.ledger.get("decisions", open.id);
      this.onBump(d);
      return { decision: d, created: false, skipped: "duplicate" };
    }
    const closed = db
      .prepare(`SELECT * FROM decisions WHERE watcher = ? AND subject = ? AND status NOT IN (${OPEN.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`)
      .get(key, subject, ...OPEN);
    const quiet = closed && closed.status === "dismissed" ? Math.max(this.dismissQuietMs, this.cooldownMs) : this.cooldownMs;
    if (closed && this.now() - Date.parse(closed.updated_at) < quiet) {
      return { decision: closed, created: false, skipped: "cooldown" };
    }
    const hourAgo = new Date(this.now() - 3600000).toISOString();
    const recent = db.prepare("SELECT count(*) AS n FROM decisions WHERE kind = 'watcher' AND rate_limited = 0 AND created_at >= ?").get(hourAgo).n;
    const limited = recent >= this.maxPerHour;
    const r = db
      .prepare(
        `INSERT INTO decisions (kind, watcher, subject, title, detail, evidence, status, count, first_seen, last_seen, created_at, updated_at, rate_limited)
         VALUES ('watcher', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
      )
      .run(key, subject, String(title).slice(0, 300), detail ? String(detail).slice(0, 4000) : null, evidence ? String(evidence).slice(0, 8000) : null, limited ? "open" : "investigating", t, t, t, t, limited ? 1 : 0);
    db.prepare("UPDATE watchers SET last_fired_at = ? WHERE key = ?").run(t, key);
    const d = this.ledger.get("decisions", Number(r.lastInsertRowid));
    this.onFire(d, { investigate: !limited });
    return { decision: d, created: true, investigate: !limited };
  }

  /* --------------------------------------------------------- observers --- */

  /** helper service-list rows: [{unit, active, since, kind}] */
  observeServices(rows) {
    const failed = (rows || []).filter((s) => s && s.active === "failed");
    this.states.set("service_failed", failed.length ? `${failed.length} failed: ${failed.map((s) => s.unit).join(", ")}` : `quiet · ${(rows || []).length} units up`);
    return failed.map((s) =>
      this.fire("service_failed", s.unit, {
        title: `${s.unit}.service failed`,
        detail: `${s.unit}.service is in the failed state on this VPS${s.since ? " (since " + s.since + ")" : ""}.`,
      })
    );
  }

  /** helper pulse-feed events: [{type, at, unit?, jail?}] */
  observeEvents(events) {
    const t = this.now();
    const out = [];
    const banDef = DEFS.find((d) => d.key === "ban_burst").threshold;
    const startDef = DEFS.find((d) => d.key === "agent_failing").threshold;
    for (const e of events || []) {
      const at = Date.parse(e.at) || t;
      if (e.type === "ban") this.windows.bans.push({ at, jail: e.jail });
      if (e.type === "start" && /^joya-agent@/.test(String(e.unit || ""))) {
        const arr = this.windows.starts.get(e.unit) || [];
        arr.push(at);
        this.windows.starts.set(e.unit, arr);
      }
    }
    const banWin = banDef.window_min * 60000;
    this.windows.bans = this.windows.bans.filter((b) => b.at >= t - banWin);
    const n = this.windows.bans.length;
    this.states.set("ban_burst", n ? `${n} bans in ${banDef.window_min} min` : "quiet");
    if (n > banDef.bans) {
      const jails = [...new Set(this.windows.bans.map((b) => b.jail).filter(Boolean))];
      out.push(
        this.fire("ban_burst", "fail2ban", {
          title: `${n} fail2ban bans in ${banDef.window_min} minutes`,
          detail: `fail2ban banned ${n} addresses in the last ${banDef.window_min} minutes (jails: ${jails.join(", ") || "unknown"}).`,
        })
      );
    }
    const stWin = startDef.window_min * 60000;
    let worst = 0;
    for (const [unit, arr] of this.windows.starts) {
      const recent = arr.filter((x) => x >= t - stWin);
      this.windows.starts.set(unit, recent);
      worst = Math.max(worst, recent.length);
      if (recent.length >= startDef.starts) {
        out.push(
          this.fire("agent_failing", unit, {
            title: `${unit} restarted ${recent.length} times in ${startDef.window_min} minutes`,
            detail: `The agent ${unit} has started ${recent.length} times in the last ${startDef.window_min} minutes: it is probably crashing and being restarted.`,
          })
        );
      }
    }
    this.states.set("agent_failing", worst ? `most restarts in ${startDef.window_min} min: ${worst}` : "quiet");
    return out;
  }

  observeDisk(disk) {
    if (!disk || disk.pct == null) return [];
    const th = DEFS.find((d) => d.key === "disk").threshold.pct;
    this.states.set("disk", `${disk.pct >= th ? "over" : "quiet"} · ${disk.pct}%`);
    if (disk.pct < th) return [];
    return [
      this.fire("disk", "/", {
        title: `Root filesystem at ${disk.pct}%`,
        detail: `The root filesystem is ${disk.pct}% full (threshold ${th}%); ${Math.round((disk.free || 0) / 1073741824)} GB free.`,
      }),
    ];
  }

  /** New lines of the trial Odoo log since the last read. */
  observeOdooLines(lines) {
    const t = this.now();
    const def = DEFS.find((d) => d.key === "odoo_errors").threshold;
    for (const l of lines || []) if (ODOO_ERROR_RE.test(l)) this.windows.odoo.push({ at: t, line: l });
    this.windows.odoo = this.windows.odoo.filter((x) => x.at >= t - def.window_min * 60000);
    const n = this.windows.odoo.length;
    this.states.set("odoo_errors", n ? `${n} errors in ${def.window_min} min` : "quiet");
    if (n < def.errors) return [];
    return [
      this.fire("odoo_errors", "odoo.log", {
        title: `${n} errors in the trial Odoo log in ${def.window_min} minutes`,
        detail: `The trial box's Odoo (/var/log/odoo/odoo.log) logged ${n} ERROR lines in the last ${def.window_min} minutes.`,
        evidence: this.windows.odoo.slice(-8).map((x) => x.line.slice(0, 400)).join("\n"),
      }),
    ];
  }
}

module.exports = { Watchers, DEFS, KEYS, OPEN, ODOO_ERROR_RE };
