"use strict";
/**
 * Proactive JOYA AI (functionality upgrade 2, 2026-10-20): the morning brief,
 * the watchers and "while you were away". Everything is here and in
 * lib/proactive.js (pure) / lib/proactive-store.js (rows) /
 * lib/proactive-writer.js (the model's wording), so server.js only mounts it.
 *
 * The clock (every 20 s, on this server): reads the supervisor (status,
 * sessions, the token caps once a minute, the ledger's newest inbound and
 * delegation rows) -- read-only ops, as actor "proactive" -- notes what the
 * sessions did (proactive_events), checks every armed watcher, and writes a
 * person's brief when their time comes (their time zone, their days; a brief
 * missed while the panel was down is written once, up to 6 hours late, never a
 * backlog). What it writes goes to that person's inbox (proactive_inbox); the
 * Command Center and the desktop app fetch it (public/joya-proactive.js).
 *
 * Nothing leaves the box: no Telegram, no mail, no push service. A watcher
 * never acts -- it has no field for an action -- it only writes a line.
 *
 * "While you were away": the page reports activity (a key, a click, the tab
 * coming back) at most once a minute (POST /joya-ai/api/proactive/seen). When
 * the last report is `away_min` or more ago, the gap is summarised -- once, and
 * only if something happened in it.
 *
 * Routes (all need joyaai.use; writes need the CSRF token):
 *   GET  /joya-ai/api/proactive                 prefs, watchers, the inbox
 *   GET  /joya-ai/api/proactive/inbox?after=N    newer inbox rows
 *   POST /joya-ai/api/proactive/seen             activity; may answer with a catch-up
 *   POST /joya-ai/api/proactive/inbox/:id/dismiss
 *   POST /joya-ai/api/proactive/parse            {text} -> the watcher it would be
 *   POST /joya-ai/api/proactive/watchers         {text} or {spec}
 *   POST /joya-ai/api/proactive/watchers/:id/pause   {paused}
 *   POST /joya-ai/api/proactive/watchers/:id/delete
 *   POST /joya-ai/api/proactive/prefs            {brief_on, brief_time, brief_days, tz, read_aloud, catchup_on, away_min}
 *   POST /joya-ai/api/proactive/brief-now        a brief now (at most one a minute)
 * and JOYA AI ▸ Settings ▸ Briefs & watchers (the forms post to /joya-ai/settings/proactive/*).
 *
 *   mount(app, deps) -> { engine, store }
 *   deps: { requireAuth, requireCsrf, apiGuard, apiWrite, db, joyaai, rbac, settingsRoutes,
 *           voice: { enabled(), config() -> {key, ...}, record(row) }, tickMs, now, wsBase, log }
 */

const P = require("./proactive");
const Store = require("./proactive-store");
const Writer = require("./proactive-writer");
const { esc, icon } = require("./ui");

const ACTOR = "proactive";
const TICK_MS = 20000;
const CAPS_MS = 60000;
const LATE_MS = 6 * 3600e3; // a brief missed while the panel was down: written up to this late
const BRIEF_MAX_WINDOW_MS = 48 * 3600e3;
const SUMMARY_MODEL = "gpt-realtime-mini"; // lib/voice-shared.js SUMMARY_MODEL: the summaries' model

/* ================================================================== the clock */

function createEngine(o) {
  const store = o.store;
  const now = o.now || (() => Date.now());
  const log = o.log || ((m) => console.log("proactive: " + m));
  const call = (op, p) => o.joyaai.call(op, p || {}, ACTOR, { timeout: 15000 });
  const E = {
    last: null, // { at, status, sessions }
    caps: null,
    capsAt: 0,
    prev: null,
    inboundMark: null,
    delegMark: null,
    busy: false,
    briefing: new Set(),
    lastPrune: 0,
    ticks: 0,
    error: null,
    timer: null,
  };

  function users() {
    try {
      return o.db.listUsers().filter((u) => !u.disabled && o.rbac.actor(u.role).can("joyaai.use"));
    } catch (e) {
      return [];
    }
  }
  /** The time zone a person's brief keeps when they chose none: the supervisor's (the Command Center clock's). */
  function defaultTz() {
    const tz = E.last && E.last.status && E.last.status.process && E.last.status.process.tz;
    return P.validTz(tz) ? tz : o.defaultTz || "Africa/Cairo";
  }
  function spendOf(status, sessions, caps) {
    const cost = (status && status.cost_today) || {};
    const by = {};
    for (const s of sessions || []) {
      if (s.self) continue;
      by[s.name] = { usd: Number(s.cost_today_usd_est) || 0, tokens: (s.tokens_today && s.tokens_today.total) || 0 };
    }
    by["JOYA AI"] = { usd: Number(cost.joya_ai_usd) || 0, tokens: (status && status.tokens_today && status.tokens_today.total) || 0 };
    let tokens = 0;
    if (caps && caps.sessions) for (const r of caps.sessions) tokens += (r.today && Number(r.today.total)) || 0;
    else for (const s of sessions || []) tokens += (s.tokens_today && s.tokens_today.total) || 0;
    return { usd: Number(cost.total_usd) || 0, tokens, by };
  }

  async function tick() {
    if (E.busy) return;
    E.busy = true;
    const t = now();
    try {
      const [status, sess] = await Promise.all([call("status"), call("sessions")]);
      const sessions = (sess && sess.sessions) || [];
      if (t - E.capsAt >= CAPS_MS) {
        E.capsAt = t;
        E.caps = await call("token-caps").catch(() => E.caps);
      }
      const [inb, del] = await Promise.all([call("ledger", { table: "inbound", limit: 50 }).catch(() => null), call("ledger", { table: "delegations", limit: 60 }).catch(() => null)]);
      // What changed since the last look.
      const trans = P.transitions(E.prev, sessions, t);
      for (const e of trans) store.addEvent(e);
      let inboundNew = [];
      const inRows = (inb && inb.rows) || [];
      const maxIn = inRows.reduce((m, r) => Math.max(m, r.id || 0), 0);
      if (E.inboundMark == null) E.inboundMark = maxIn;
      else {
        inboundNew = inRows.filter((r) => r.id > E.inboundMark);
        E.inboundMark = Math.max(E.inboundMark, maxIn);
      }
      let failures = [];
      const dRows = (del && del.rows) || [];
      const bad = dRows.filter((d) => d.status === "failed" || d.status === "held");
      const maxD = bad.reduce((m, d) => (String(d.updated_at || "") > m ? String(d.updated_at) : m), "");
      if (E.delegMark == null) E.delegMark = maxD;
      else {
        failures = bad.filter((d) => String(d.updated_at || "") > E.delegMark);
        if (maxD > E.delegMark) E.delegMark = maxD;
      }
      // A copy: what the supervisor answered is never the thing compared next time.
      E.prev = sessions.map((x) => Object.assign({}, x));
      E.last = { at: t, status, sessions: E.prev };
      E.error = null;
      const spend = spendOf(status, sessions, E.caps);
      const people = users();
      const ids = new Set(people.map((u) => u.id));
      const tzOf = {};
      for (const u of people) tzOf[u.id] = store.prefs(u.id, defaultTz()).tz;
      // The watchers.
      for (const w of store.armed()) {
        if (!ids.has(w.user_id)) continue;
        const r = P.evaluate(w, { now: t, local: P.localNow(t, tzOf[w.user_id]), transitions: trans, sessions, approvals: status.approvals || [], inbound: inboundNew, failures, spend });
        const n = r.fires.length;
        store.saveCheck(w.id, r.state, n, r.done, n ? r.fires[n - 1].text : null);
        for (const f of r.fires) store.addInbox(w.user_id, "watch", f.text, { text: f.text, watcher: P.describe(w), label: w.label, session: f.session, once: r.done }, w.id);
      }
      // The briefs.
      for (const u of people) {
        const pr = store.prefs(u.id, defaultTz());
        if (briefDue(pr, t)) {
          // Marked first, so a slow write is never started twice.
          const l = P.localNow(t, pr.tz);
          store.setPrefs(u.id, { last_brief_day: l.date });
          writeBrief(u, pr, "scheduled").catch((e) => log("brief for " + u.username + " failed: " + e.message));
        }
      }
      if (t - E.lastPrune > 3600e3) {
        E.lastPrune = t;
        store.prune();
      }
      E.ticks++;
    } catch (e) {
      // The supervisor away: nothing is decided on half a picture; the next look carries on.
      E.error = e.message;
    } finally {
      E.busy = false;
    }
  }

  function briefDue(pr, t) {
    if (!pr.brief_on) return false;
    const l = P.localNow(t, pr.tz);
    if (pr.last_brief_day === l.date) return false;
    if (!pr.brief_days.includes(l.dow)) return false;
    const due = Number(pr.brief_time.slice(0, 2)) * 60 + Number(pr.brief_time.slice(3));
    return l.min >= due && (l.min - due) * 60000 <= LATE_MS;
  }

  /** Everything the words are written from, for one window. */
  async function factsFor(kind, from, to, userId, extra) {
    const [status, sess, caps, inb, del, turns] = await Promise.all([
      call("status"),
      call("sessions"),
      call("token-caps").catch(() => E.caps),
      call("ledger", { table: "inbound", limit: 200 }).catch(() => ({ rows: [] })),
      call("ledger", { table: "delegations", limit: 200 }).catch(() => ({ rows: [] })),
      call("ledger", { table: "turns", limit: 100 }).catch(() => ({ rows: [] })),
    ]);
    return P.gather({
      kind,
      from,
      to,
      sessions: (sess && sess.sessions) || [],
      status,
      caps,
      events: store.events(from, to),
      inbound: inb.rows || [],
      delegations: del.rows || [],
      turns: turns.rows || [],
      fires: store.fires(userId, from, to),
      usdAtFrom: extra && extra.usdAtFrom,
    });
  }

  /** "8:00 yesterday", "8:00 Mon 19 Oct", in the person's zone. */
  function whenText(ms, tz) {
    const t = now();
    const a = P.localNow(ms, tz), b = P.localNow(t, tz);
    const y = P.localNow(t - 86400e3, tz);
    const day = a.date === b.date ? "today" : a.date === y.date ? "yesterday" : new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
    return P.hmLabel(a.hm) + " " + day;
  }

  /** The template's words, reworded by the summaries' model when the voice is on and the result is grounded. */
  async function words(c, actor) {
    // " · " joins parts of one line on the card; the model read it as a line break, so it gets "; ".
    const text = P.asText(c, false).replace(/ · /g, "; ");
    const out = { lines: c.lines, source: "template", why: "" };
    const v = o.voice;
    if (!v || !v.enabled || !v.enabled()) return Object.assign(out, { why: "voice is off" });
    let cfg = null;
    try {
      cfg = await v.config();
    } catch (_) {
      cfg = null;
    }
    if (!cfg || !cfg.key) return Object.assign(out, { why: "no key" });
    try {
      const r = await (o.writer || Writer.write)({ key: cfg.key, model: SUMMARY_MODEL, wsBase: o.wsBase, text, timeoutMs: o.writerTimeoutMs || 15000 });
      if (r.usage && v.record) {
        try {
          v.record({ part: "desk", model: SUMMARY_MODEL, tokens: require("./voice-usage").realtimeTokens(r.usage), actor, cat: "direct" });
        } catch (_) {
          /* the brief is not refused for its bookkeeping */
        }
      }
      const g = P.grounded(r.text, c);
      if (!g.ok) return Object.assign(out, { why: "the model's words were not used: " + g.why });
      return { lines: P.linesFrom(r.text, c), source: "model", why: "" };
    } catch (e) {
      return Object.assign(out, { why: "the model did not answer: " + String(e.message).slice(0, 100) });
    }
  }

  async function writeBrief(u, pr, why) {
    if (E.briefing.has(u.id)) return null;
    E.briefing.add(u.id);
    try {
      const t = now();
      const lastAt = Date.parse(pr.last_brief_at);
      const from = isFinite(lastAt) && t - lastAt < BRIEF_MAX_WINDOW_MS ? lastAt : t - 24 * 3600e3;
      const f = await factsFor("brief", from, t, u.id);
      const c = P.compose(f, { whenText: whenText(from, pr.tz) });
      const w = await words(c, u.username);
      const body = { lines: w.lines, template: w.source === "model" ? c.lines : undefined, source: w.source, why: w.why, from: new Date(from).toISOString(), to: new Date(t).toISOString(), tz: pr.tz, speech: speechOf(c.title, w.lines), reason: why };
      const row = store.addInbox(u.id, "brief", c.title, body);
      store.supersede(u.id, "brief", row.id);
      store.setPrefs(u.id, { last_brief_at: new Date(t).toISOString(), last_brief_day: P.localNow(t, pr.tz).date });
      log(`brief for ${u.username} (${why}, ${w.source}${w.why ? ": " + w.why : ""}): ${c.lines.length} lines`);
      return row;
    } finally {
      E.briefing.delete(u.id);
    }
  }

  /** The person was active. Returns a catch-up row when they come back to news. */
  async function seen(u) {
    const t = now();
    const pr = store.prefs(u.id, defaultTz());
    const lastSeen = Date.parse(pr.last_seen_at);
    const l = P.localNow(t, pr.tz);
    const usdNow = E.last && E.last.status && E.last.status.cost_today ? Number(E.last.status.cost_today.total_usd) || 0 : null;
    // Recorded first: a second tab reporting at the same moment is not away.
    store.setPrefs(u.id, { last_seen_at: new Date(t).toISOString(), seen_usd: usdNow, seen_day: l.date });
    if (!pr.catchup_on || !isFinite(lastSeen) || t - lastSeen < pr.away_min * 60000) return null;
    // A brief written while they were away (and not dismissed) already covers its part.
    const b = store.lastOf(u.id, "brief");
    let from = lastSeen;
    if (b && !b.dismissed_at && Date.parse(b.created_at) > from) from = Date.parse(b.created_at);
    const f = await factsFor("catchup", from, t, u.id, { usdAtFrom: pr.seen_day === l.date ? pr.seen_usd : null });
    if (f.empty) return null;
    f.from = lastSeen; // the title says how long they were away
    const c = P.compose(f, {});
    const w = await words(c, u.username);
    const row = store.addInbox(u.id, "catchup", c.title, { lines: w.lines, source: w.source, why: w.why, from: new Date(lastSeen).toISOString(), to: new Date(t).toISOString(), speech: speechOf(c.title, w.lines) });
    store.supersede(u.id, "catchup", row.id);
    return row;
  }

  function start() {
    if (E.timer) return;
    const ms = o.tickMs || TICK_MS;
    const first = setTimeout(tick, Math.min(3000, ms));
    if (first.unref) first.unref();
    E.timer = setInterval(tick, ms);
    if (E.timer.unref) E.timer.unref();
  }
  function stop() {
    clearInterval(E.timer);
    E.timer = null;
  }
  /** The live names for a parse: after one look at the supervisor, if none was taken yet. */
  async function names() {
    if (!E.last) await tick().catch(() => {});
    for (let i = 0; i < 30 && !E.last && E.busy; i++) await new Promise((r) => setTimeout(r, 100)); // a look already under way
    return ((E.last && E.last.sessions) || []).filter((s) => !s.self).map((s) => s.name);
  }
  return { tick, start, stop, seen, names, writeBrief, briefDue, factsFor, words, defaultTz, state: E, liveNames: () => ((E.last && E.last.sessions) || []).filter((s) => !s.self).map((s) => s.name) };
}

/** What reading aloud says: the title and the lines, labels as words. */
function speechOf(title, lines) {
  return (title.replace(/ · /g, ", ") + ". " + lines.map((l) => (l.k === "Quiet" ? l.text : `${l.k}: ${l.text}`).replace(/\s·\s/g, "; ")).join(". ")).replace(/\.\./g, ".").slice(0, 1500);
}

/* ================================================================== routes */

function clean(body, dflt) {
  const b = body || {};
  const p = {};
  const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
  if (b.brief_on !== undefined) p.brief_on = bool(b.brief_on);
  if (b.read_aloud !== undefined) p.read_aloud = bool(b.read_aloud);
  if (b.catchup_on !== undefined) p.catchup_on = bool(b.catchup_on);
  if (b.brief_time !== undefined) {
    if (!P.validHm(b.brief_time)) return { error: "The brief's time: HH:MM, 00:00 to 23:59." };
    p.brief_time = b.brief_time;
  }
  if (b.brief_days !== undefined) {
    let d = b.brief_days;
    if (typeof d === "string") d = d.split(",").filter((x) => x !== "");
    if (!Array.isArray(d)) d = [d];
    d = d.map(Number);
    if (!d.length) return { error: "Pick at least one day for the brief (or switch it off)." };
    if (!d.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)) return { error: "Days are Sunday (0) to Saturday (6)." };
    p.brief_days = [...new Set(d)].sort();
  }
  if (b.tz !== undefined) {
    if (b.tz === "" || b.tz === "default") p.tz = "";
    else if (!P.validTz(b.tz)) return { error: "That is not a time zone (use a name like Africa/Cairo or Europe/London)." };
    else p.tz = b.tz;
  }
  if (b.away_min !== undefined) {
    const n = Number(b.away_min);
    if (!Number.isInteger(n) || n < Store.AWAY_MIN[0] || n > Store.AWAY_MIN[1]) return { error: `Away after: ${Store.AWAY_MIN[0]} to ${Store.AWAY_MIN[1]} minutes.` };
    p.away_min = n;
  }
  if (!Object.keys(p).length && !dflt) return { error: "Nothing to change." };
  return { p };
}

function publicWatcher(w) {
  return { id: w.id, kind: w.kind, kind_label: P.KIND_LABEL[w.kind], params: w.params, repeat: w.repeat, cooldown_min: w.cooldown_min, label: w.label, paused: w.paused, done: w.done, text: w.text, fired_count: w.fired_count, last_fired_at: w.last_fired_at, last_text: w.last_text, created_at: w.created_at };
}
function publicItem(r) {
  return { id: r.id, kind: r.kind, title: r.title, body: r.body, created_at: r.created_at, read_at: r.read_at, dismissed_at: r.dismissed_at, watcher_id: r.watcher_id };
}

function mount(app, deps) {
  const rawDb = deps.rawDb || deps.db.db;
  const store = deps.store || Store.create(rawDb, { now: deps.now });
  const engine = createEngine({ store, joyaai: deps.joyaai, db: deps.db, rbac: deps.rbac, voice: deps.voice, now: deps.now, tickMs: deps.tickMs, wsBase: deps.wsBase, writer: deps.writer, log: deps.log });
  const G = deps.apiGuard, W = deps.apiWrite;
  const audit = (req, what) => {
    try {
      deps.db.logLogin(req.ip, req.me.username, "joya-proactive", String(what).slice(0, 200));
    } catch (_) {
      /* the audit log is a nicety here */
    }
  };
  const prefsOut = (u) => {
    const p = store.prefs(u.id, engine.defaultTz());
    return { brief_on: p.brief_on, brief_time: p.brief_time, brief_days: p.brief_days, tz: p.tz, tz_set: p.tz_set, read_aloud: p.read_aloud, catchup_on: p.catchup_on, away_min: p.away_min, last_brief_at: p.last_brief_at };
  };
  const briefLimit = new Map(); // user id -> ms of the last brief-now

  async function addWatcher(req, body) {
    let v;
    if (body && typeof body.text === "string") {
      const r = P.parse(body.text, await engine.names());
      if (!r.ok) return { status: 400, out: { error: r.error, code: "invalid" } };
      v = r;
      if (body.repeat === "every" || body.repeat === "once") v.value.repeat = body.repeat;
    } else {
      const r = P.validate(body && body.spec);
      if (!r.ok) return { status: 400, out: { error: r.error, code: "invalid" } };
      v = { value: r.value, note: "" };
    }
    const w = store.addWatcher(req.me.id, v.value);
    if (!w) return { status: 409, out: { error: `You have ${P.MAX_WATCHERS} watchers, the most there can be. Delete one first.`, code: "full" } };
    audit(req, `watcher ${w.id} added: ${w.text}`);
    return { status: 200, out: { watcher: publicWatcher(w), note: v.note || "", count: store.watcherCount(req.me.id), max: P.MAX_WATCHERS } };
  }

  app.get("/joya-ai/api/proactive", ...G, (req, res) => {
    res.json({ prefs: prefsOut(req.me), watchers: store.watchers(req.me.id).map(publicWatcher), max: P.MAX_WATCHERS, inbox: store.inbox(req.me.id, 0).map(publicItem), kinds: P.KIND_LABEL });
  });
  app.get("/joya-ai/api/proactive/inbox", ...G, (req, res) => {
    const after = Number(req.query.after) || 0;
    res.json({ items: store.inbox(req.me.id, after).map(publicItem) });
  });
  app.post("/joya-ai/api/proactive/seen", ...W, async (req, res) => {
    try {
      const r = await engine.seen(req.me);
      res.json({ catchup: r ? publicItem(r) : null });
    } catch (e) {
      res.json({ catchup: null, error: "JOYA AI could not be read: " + String(e.message).slice(0, 80) });
    }
  });
  app.post("/joya-ai/api/proactive/inbox/:id/dismiss", ...W, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !store.dismiss(req.me.id, id)) return res.status(404).json({ error: "No such item." });
    res.json({ dismissed: id });
  });
  app.post("/joya-ai/api/proactive/parse", ...W, async (req, res) => {
    const text = req.body && req.body.text;
    if (typeof text !== "string") return res.status(400).json({ error: "Send the words.", code: "invalid" });
    const r = P.parse(text, await engine.names());
    if (!r.ok) return res.json({ ok: false, error: r.error, looks: P.looksLikeWatcher(text) });
    res.json({ ok: true, spec: r.value, text: r.text, note: r.note || "", count: store.watcherCount(req.me.id), max: P.MAX_WATCHERS });
  });
  app.post("/joya-ai/api/proactive/watchers", ...W, async (req, res) => {
    const r = await addWatcher(req, req.body);
    res.status(r.status).json(r.out);
  });
  app.post("/joya-ai/api/proactive/watchers/:id/pause", ...W, (req, res) => {
    const id = Number(req.params.id);
    if (typeof (req.body && req.body.paused) !== "boolean") return res.status(400).json({ error: "paused must be true or false.", code: "invalid" });
    const w = Number.isInteger(id) && store.setPaused(req.me.id, id, req.body.paused);
    if (!w) return res.status(404).json({ error: "No such watcher." });
    audit(req, `watcher ${id} ${req.body.paused ? "paused" : "resumed"}`);
    res.json({ watcher: publicWatcher(w) });
  });
  app.post("/joya-ai/api/proactive/watchers/:id/delete", ...W, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !store.deleteWatcher(req.me.id, id)) return res.status(404).json({ error: "No such watcher." });
    audit(req, `watcher ${id} deleted`);
    res.json({ deleted: id, count: store.watcherCount(req.me.id) });
  });
  app.post("/joya-ai/api/proactive/prefs", ...W, (req, res) => {
    const c = clean(req.body);
    if (c.error) return res.status(400).json({ error: c.error, code: "invalid" });
    store.setPrefs(req.me.id, c.p, req.me.username);
    audit(req, "proactive settings " + JSON.stringify(c.p));
    res.json({ prefs: prefsOut(req.me) });
  });
  app.post("/joya-ai/api/proactive/brief-now", ...W, async (req, res) => {
    const t = Date.now();
    if (t - (briefLimit.get(req.me.id) || 0) < 60000) return res.status(429).json({ error: "One brief a minute.", code: "rate" });
    briefLimit.set(req.me.id, t);
    try {
      const row = await engine.writeBrief(req.me, store.prefs(req.me.id, engine.defaultTz()), "asked");
      if (!row) return res.status(409).json({ error: "A brief is being written already." });
      res.json({ item: publicItem(row) });
    } catch (e) {
      res.status(503).json({ error: "JOYA AI could not be read: " + String(e.message).slice(0, 100), code: "offline" });
    }
  });

  /* ---------------------------------------------- Settings ▸ Briefs & watchers */
  const SR = deps.settingsRoutes;
  if (SR) {
    const V = require("./views-settings");
    SR.sections.proactive = async (req, res) => section(req, res);
    const reply = (req, res, o) => SR.reply(req, res, "proactive", o);
    const guard = (req, res, next) => {
      if (!req.me) return res.redirect("/login");
      if (V.mayOpen(req.perm, "proactive")) return next();
      if (SR.wantsJson(req)) return res.status(403).json({ ok: false, flash: "" });
      res.status(403).send("Not allowed");
    };
    const post = (path, fn) => app.post("/joya-ai/settings/proactive/" + path, deps.requireAuth, guard, deps.requireCsrf, fn);
    const setOne = (req, res, body, msg, anchor) => {
      const c = clean(body);
      if (c.error) return reply(req, res, { err: c.error, anchor });
      store.setPrefs(req.me.id, c.p, req.me.username);
      audit(req, "proactive settings " + JSON.stringify(c.p));
      reply(req, res, { msg: typeof msg === "function" ? msg(store.prefs(req.me.id, engine.defaultTz())) : msg, anchor });
    };
    post("brief", (req, res) => setOne(req, res, { brief_on: req.body.on === "1" || req.body.on === "on" ? "1" : "0" }, (p) => (p.brief_on ? `The morning brief is on: ${P.hmLabel(p.brief_time)}, ${P.daysLabel(p.brief_days)} (${p.tz}).` : "The morning brief is off."), "pa-brief"));
    post("time", (req, res) => setOne(req, res, { brief_time: req.body.time }, (p) => `The brief comes at ${P.hmLabel(p.brief_time)} (${p.tz}).`, "pa-time"));
    post("days", (req, res) => setOne(req, res, { brief_days: req.body.days === undefined ? [] : req.body.days }, (p) => `The brief comes ${P.daysLabel(p.brief_days)}.`, "pa-days"));
    post("tz", (req, res) => setOne(req, res, { tz: String(req.body.tz || "").trim() }, (p) => `Your time zone: ${p.tz}${p.tz_set ? "" : " (JOYA AI's)"}.`, "pa-tz"));
    post("read", (req, res) => setOne(req, res, { read_aloud: req.body.on === "1" || req.body.on === "on" ? "1" : "0" }, (p) => (p.read_aloud ? "The next time you start a live conversation, a brief you have not read is read to you first." : "Briefs are not read aloud."), "pa-read"));
    post("catchup", (req, res) => setOne(req, res, { catchup_on: req.body.on === "1" || req.body.on === "on" ? "1" : "0" }, (p) => (p.catchup_on ? "“While you were away” is on." : "“While you were away” is off."), "pa-catchup"));
    post("away", (req, res) => setOne(req, res, { away_min: Number(req.body.minutes) }, (p) => `You count as away after ${p.away_min} minutes without activity.`, "pa-away"));
    post("brief-now", async (req, res) => {
      const t = Date.now();
      if (t - (briefLimit.get(req.me.id) || 0) < 60000) return reply(req, res, { err: "One brief a minute.", anchor: "pa-now" });
      briefLimit.set(req.me.id, t);
      try {
        await engine.writeBrief(req.me, store.prefs(req.me.id, engine.defaultTz()), "asked");
        reply(req, res, { msg: "A brief is in the Command Center now.", anchor: "pa-now" });
      } catch (e) {
        reply(req, res, { err: "Not written: JOYA AI could not be read (" + String(e.message).slice(0, 80) + ").", anchor: "pa-now" });
      }
    });
    post("watch", async (req, res) => {
      const r = await addWatcher(req, { text: String(req.body.text || "") });
      if (r.status !== 200) return reply(req, res, { err: r.out.error, anchor: "pa-add" });
      reply(req, res, { msg: `Watching: ${r.out.watcher.text}.${r.out.note ? " " + r.out.note : ""}`, anchor: "pa-watchers", reload: true });
    });
    app.post("/joya-ai/settings/proactive/watch/:id/:act", deps.requireAuth, guard, deps.requireCsrf, (req, res) => {
      const id = Number(req.params.id);
      const act = req.params.act;
      if (!Number.isInteger(id) || !["pause", "resume", "delete"].includes(act)) return reply(req, res, { err: "No such watcher." });
      if (act === "delete") {
        if (!store.deleteWatcher(req.me.id, id)) return reply(req, res, { err: "No such watcher." });
        audit(req, `watcher ${id} deleted`);
        return reply(req, res, { msg: "Watcher deleted.", anchor: "pa-watchers", reload: true });
      }
      const w = store.setPaused(req.me.id, id, act === "pause");
      if (!w) return reply(req, res, { err: "No such watcher." });
      audit(req, `watcher ${id} ${act === "pause" ? "paused" : "resumed"}`);
      reply(req, res, { msg: act === "pause" ? "Paused: " + w.text : "Watching again: " + w.text, anchor: "pa-watchers", reload: true });
    });

    function section(req, res) {
      const csrf = res.locals.csrf;
      const pr = store.prefs(req.me.id, engine.defaultTz());
      const ws = store.watchers(req.me.id);
      const daysBox = P.DAY_NAMES.map((d, i) => `<label class="pa-day"><input type="checkbox" name="days" value="${i}"${pr.brief_days.includes(i) ? " checked" : ""}><span>${d}</span></label>`).join("");
      const zones = ["Africa/Cairo", "Europe/London", "Europe/Berlin", "Asia/Dubai", "Asia/Riyadh", "America/New_York", "UTC"];
      const status = (w) => (w.done ? `<span class="pill neutral">fired · done</span>` : w.paused ? `<span class="pill warn">paused</span>` : `<span class="pill ok">watching</span>`);
      const fired = (w) => (w.last_fired_at ? ` · fired ${w.fired_count === 1 ? "once" : w.fired_count + " times"}, last ${esc(new Intl.DateTimeFormat("en-GB", { timeZone: pr.tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(w.last_fired_at)))}` : "");
      const wRow = (w) =>
        `<div class="lr pa-w" data-watcher="${w.id}"><div><b>${esc(w.text)}</b><span class="d">${w.label ? "“" + esc(w.label) + "”" : esc(P.KIND_LABEL[w.kind])}${fired(w)}${w.last_text ? `<br><span class="pa-last">${esc(P.clip(w.last_text, 140))}</span>` : ""}</span></div><div class="pa-acts">${status(w)}` +
        `<form method="post" action="/joya-ai/settings/proactive/watch/${w.id}/${w.paused || w.done ? "resume" : "pause"}" class="set-form" data-live><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="btn small">${w.done ? "Watch again" : w.paused ? "Resume" : "Pause"}</button></form>` +
        `<form method="post" action="/joya-ai/settings/proactive/watch/${w.id}/delete" class="set-form" data-live data-confirm-dlg="Delete this watcher?" data-confirm-body="${esc(w.text)}" data-confirm-yes="Delete"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="btn small danger" aria-label="Delete: ${esc(w.text)}">${icon("trash", 14)}</button></form></div></div>`;
      const body =
        V.head(
          "Briefs & watchers",
          "JOYA AI tells you things without being asked: a brief each morning, the watchers you set, and what happened while you were away. Only here and in the desktop app; a watcher only notifies, it never acts."
        ) +
        V.group(
          "Morning brief",
          "clock",
          V.row("Morning brief", "What each session did, what finished, failed or waits on you, today's usage and anything stuck.", V.form("/joya-ai/settings/proactive/brief", csrf, V.sw('name="on" value="1" aria-label="Morning brief"', pr.brief_on)), { scope: "you", id: "pa-brief" }) +
            V.row("Time", null, V.form("/joya-ai/settings/proactive/time", csrf, `<input type="time" name="time" value="${esc(pr.brief_time)}" aria-label="Brief time" required>`), { scope: "you", id: "pa-time" }) +
            V.row("Days", null, V.form("/joya-ai/settings/proactive/days", csrf, `<div class="pa-days" role="group" aria-label="Brief days">${daysBox}</div>`), { scope: "you", id: "pa-days" }) +
            V.row("Read it aloud", "An unread brief is read to you when you next start a live call.", V.form("/joya-ai/settings/proactive/read", csrf, V.sw('name="on" value="1" aria-label="Read the brief aloud"', pr.read_aloud)), { scope: "you", id: "pa-read" }) +
            V.row("Brief me now", pr.last_brief_at ? "The last one: " + esc(new Intl.DateTimeFormat("en-GB", { timeZone: pr.tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(pr.last_brief_at))) + "." : "None written yet.", V.form("/joya-ai/settings/proactive/brief-now", csrf, `<button type="submit" class="btn small">${icon("play", 14)} Write one now</button>`, { noSave: true }), { id: "pa-now" }) +
            V.more(
              "More: time zone",
              V.row(
                "Time zone",
                `The brief's clock. Empty: JOYA AI's (${esc(engine.defaultTz())}).`,
                V.form("/joya-ai/settings/proactive/tz", csrf, `<input type="text" name="tz" list="pa-zones" value="${esc(pr.tz_set ? pr.tz : "")}" placeholder="${esc(engine.defaultTz())}" aria-label="Time zone" maxlength="64" spellcheck="false"><datalist id="pa-zones">${zones.map((z) => `<option value="${esc(z)}">`).join("")}</datalist>`),
                { scope: "you", id: "pa-tz" }
              ),
              { id: "pa-more", open: !!pr.tz_set }
            )
        ) +
        V.group(
          "While you were away",
          "eye",
          V.row("Catch-up", "When you come back after a while away, one short card says what happened, if anything did.", V.form("/joya-ai/settings/proactive/catchup", csrf, V.sw('name="on" value="1" aria-label="While you were away"', pr.catchup_on)), { scope: "you", id: "pa-catchup" }) +
            V.row("Away after", null, V.form("/joya-ai/settings/proactive/away", csrf, `<input type="number" name="minutes" min="${Store.AWAY_MIN[0]}" max="${Store.AWAY_MIN[1]}" value="${esc(pr.away_min)}" aria-label="Minutes without activity"><span class="unit">minutes without activity</span>`), { scope: "you", id: "pa-away" })
        ) +
        V.group(
          "Your watchers",
          "activity",
          `<div class="lr" id="pa-add"><div><span class="d">Say it in plain words: “tell me when the Planning engine session finishes”, “remind me at 17:30 to call the warehouse”. You can also ask JOYA AI in the Command Center. System checks are under Approvals &amp; automations ▸ System alerts.</span>` +
            `<form method="post" action="/joya-ai/settings/proactive/watch" class="set-form pa-addf" data-live><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="text" name="text" maxlength="300" placeholder="Tell me when…" aria-label="A new watcher, in plain words" required${ws.length >= P.MAX_WATCHERS ? " disabled" : ""}><button type="submit" class="btn small primary"${ws.length >= P.MAX_WATCHERS ? " disabled" : ""}>${icon("plus", 14)} Watch</button></form></div></div>` +
            (ws.length ? ws.map(wRow).join("") : `<div class="lr"><div><span class="d">No watchers yet.</span></div></div>`),
          { id: "pa-watchers", aside: `${ws.length} of ${P.MAX_WATCHERS}` }
        );
      return { body, assets: ["joya-proactive-settings.css"] };
    }
  }

  if (deps.start !== false) engine.start();
  return { engine, store };
}

module.exports = { mount, createEngine, speechOf, clean, TICK_MS };
