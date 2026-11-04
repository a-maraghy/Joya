"use strict";
/**
 * The living canvas (2026-10-20): the Command Center as a board JOYA AI lays out moment to moment.
 * The page draws it (public/joya-canvas.js, the pure policy public/joya-canvas-policy.js, the
 * building blocks public/joya-widgets.js); this keeps each person's pins, their layout switches and
 * what the board learned from them (lib/canvas-store.js), and answers whether a widget JOYA AI sends
 * should still be offered to them.
 *
 * Routes (all need joyaai.use; writes need the CSRF token):
 *   GET  /joya-ai/api/canvas                  prefs, pins, what was learned (standing tiles, keys not offered), counts
 *   POST /joya-ai/api/canvas/pin              {widget, size}  -> the pin (the widget is checked again here)
 *   POST /joya-ai/api/canvas/pins/:id/size    {size: s|m|l}
 *   POST /joya-ai/api/canvas/pins/:id/unpin
 *   POST /joya-ai/api/canvas/event            {key, what: dismiss|open}  (one count)
 *   POST /joya-ai/api/canvas/prefs            {locked?, learn?}
 *   POST /joya-ai/api/canvas/reset            forget what was learned (pins stay)
 * and JOYA AI ▸ Settings ▸ Appearance ▸ Board (forms posting to /joya-ai/settings/canvas/*): the lock,
 * learning on/off, the counts with their verdicts, and Reset.
 *
 *   mount(app, deps) -> { store, offer(user, widget) }
 *   deps: { requireAuth, requireCsrf, apiGuard, apiWrite, db (lib/db.js), settingsRoutes }
 */

const W = require("../public/joya-widgets");
const Store = require("./canvas-store");
const { esc, icon } = require("./ui");

function mount(app, deps) {
  const store = Store.create(deps.db.db, { now: deps.now });
  const G = deps.apiGuard, Wr = deps.apiWrite;
  const audit = (req, what) => {
    try {
      deps.db.logLogin(req.ip, req.me.username, "joya-canvas", what);
    } catch (_) {
      /* the audit is a nicety here */
    }
  };
  /*
   * Board learning off for everyone, once (the 2026-10-25 cleanup, the administrator's decision): every
   * offered widget had been dismissed and none pinned. Recorded in settings ("migration.canvas_learn_off")
   * so it runs once; afterwards a person may switch it on again under Appearance ▸ Board ▸ More.
   */
  const LEARN_OFF = "migration.canvas_learn_off";
  (function migrateLearnOff() {
    try {
      if (!deps.db.getSetting || deps.db.getSetting(LEARN_OFF, null)) return;
      const users = deps.db.listUsers ? deps.db.listUsers() : [];
      let n = 0;
      for (const u of users) {
        if (!store.prefs(u.id).learn) continue;
        store.setPrefs(u.id, { learn: false });
        n++;
        try {
          deps.db.logLogin(null, u.username, "joya-canvas", "board learning off (cleanup, migration)");
        } catch (_) {
          /* the audit is a nicety here */
        }
      }
      deps.db.setSetting(LEARN_OFF, JSON.stringify({ switched_off: n, at: new Date().toISOString() }), "migration");
      if (n) console.log(`canvas: board learning switched off for ${n} account${n === 1 ? "" : "s"} (migration)`);
    } catch (e) {
      console.log("canvas: could not switch board learning off: " + e.message);
    }
  })();

  const view = (uid) => ({ prefs: store.prefs(uid), pins: store.pins(uid), learned: store.learned(uid), max_pins: store.MAX_PINS, version: W.VERSION });

  app.get("/joya-ai/api/canvas", ...G, (req, res) => res.json(view(req.me.id)));

  app.post("/joya-ai/api/canvas/pin", ...Wr, (req, res) => {
    const b = req.body || {};
    const r = store.pin(req.me.id, b.widget, b.size);
    if (r.error) return res.status(r.full ? 409 : 400).json({ error: r.error, code: r.full ? "full" : "invalid" });
    audit(req, `pinned a widget: ${r.pin.key} "${r.pin.spec.title}"`);
    res.json({ pin: r.pin, learned: store.learned(req.me.id) });
  });
  app.post("/joya-ai/api/canvas/pins/:id/size", ...Wr, (req, res) => {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) ? store.resize(req.me.id, id, req.body && req.body.size) : null;
    if (!p) return res.status(404).json({ error: "No such pinned widget, or no such size (s, m, l)." });
    res.json({ pin: p });
  });
  app.post("/joya-ai/api/canvas/pins/:id/unpin", ...Wr, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !store.unpin(req.me.id, id)) return res.status(404).json({ error: "No such pinned widget." });
    audit(req, `unpinned widget ${id}`);
    res.json({ unpinned: id, learned: store.learned(req.me.id) });
  });
  app.post("/joya-ai/api/canvas/event", ...Wr, (req, res) => {
    const b = req.body || {};
    const key = Store.cleanKey(b.key);
    if (!key || (b.what !== "dismiss" && b.what !== "open")) return res.status(400).json({ error: "Send a widget key and what happened (dismiss or open).", code: "invalid" });
    const counted = store.count(req.me.id, key, b.what);
    res.json({ counted, learned: store.learned(req.me.id) });
  });
  app.post("/joya-ai/api/canvas/prefs", ...Wr, (req, res) => {
    const b = req.body || {};
    const p = {};
    if (b.locked !== undefined) {
      if (typeof b.locked !== "boolean") return res.status(400).json({ error: "locked must be true or false.", code: "invalid" });
      p.locked = b.locked;
    }
    if (b.learn !== undefined) {
      if (typeof b.learn !== "boolean") return res.status(400).json({ error: "learn must be true or false.", code: "invalid" });
      p.learn = b.learn;
    }
    const next = store.setPrefs(req.me.id, p);
    audit(req, `board ${JSON.stringify(p)}`);
    res.json({ prefs: next, learned: store.learned(req.me.id) });
  });
  app.post("/joya-ai/api/canvas/reset", ...Wr, (req, res) => {
    const n = store.resetLearning(req.me.id);
    audit(req, `board learning reset (${n} keys)`);
    res.json({ reset: n, learned: store.learned(req.me.id) });
  });

  /* ---------------------------------------------------------------- Settings ▸ Appearance ▸ Board */
  const SR = deps.settingsRoutes;
  if (SR && SR.sections) {
    const V = require("./views-settings");
    const prev = SR.sections.appearance;
    SR.sections.appearance = async (req, res, d) => {
      const out = prev ? await prev(req, res, d) : { body: V.head("Appearance", "") };
      return Object.assign({}, out, { body: out.body + boardSettings(req, res.locals.csrf) });
    };
    const guard = (req, res, next) => {
      if (!req.me) return res.redirect("/login");
      if (V.mayOpen(req.perm, "appearance")) return next();
      if (SR.wantsJson(req)) return res.status(403).json({ ok: false, flash: "" });
      res.status(403).send("Not allowed");
    };
    const post = (p, fn) => app.post("/joya-ai/settings/canvas/" + p, deps.requireAuth, guard, deps.requireCsrf, fn);
    const reply = (req, res, o) => SR.reply(req, res, "appearance", Object.assign({ anchor: "a-board" }, o));
    const on = (req) => req.body.on === "1" || req.body.on === "on";
    post("lock", (req, res) => {
      const p = store.setPrefs(req.me.id, { locked: on(req) });
      audit(req, `board ${p.locked ? "locked" : "unlocked"}`);
      reply(req, res, { msg: p.locked ? "The board is locked: it stays as you arranged it; what needs you shows as a badge." : "The board follows the moment again." });
    });
    post("learn", (req, res) => {
      const p = store.setPrefs(req.me.id, { learn: on(req) });
      audit(req, `board learning ${p.learn ? "on" : "off"}`);
      reply(req, res, { msg: p.learn ? "The board learns from what you pin and dismiss." : "The board no longer learns; what it learned is set aside (Reset forgets it).", reload: true });
    });
    post("reset", (req, res) => {
      const n = store.resetLearning(req.me.id);
      audit(req, `board learning reset (${n} keys)`);
      reply(req, res, { msg: n ? `Forgotten: what the board learned from ${n} kind${n === 1 ? "" : "s"} of widget. Your pins stay.` : "Nothing was learned yet.", reload: true });
    });
  }

  function boardSettings(req, csrf) {
    const V = require("./views-settings");
    const pr = store.prefs(req.me.id);
    const L = store.learned(req.me.id);
    const pins = store.pins(req.me.id);
    const label = (k) => {
      const [kind, src] = k.split(":");
      const s = W.SOURCES[src];
      return `${esc(kind)} · ${esc(src === "payload" ? "from JOYA AI's answer" : s ? src : src)}`;
    };
    const rows = L.rows.length
      ? `<table class="cv-learn"><thead><tr><th scope="col">Widget</th><th scope="col" class="n">Offered</th><th scope="col" class="n">Pinned</th><th scope="col" class="n">Dismissed</th><th scope="col" class="n">Opened</th><th scope="col">Now</th></tr></thead><tbody>${L.rows
          .map(
            (r) =>
              `<tr><td>${label(r.key)}</td><td class="n">${r.offered}</td><td class="n">${r.pins}</td><td class="n">${r.dismissals}</td><td class="n">${r.opens}</td><td>${
                r.verdict === "standing" ? '<span class="cv-tag ok">standing tile</span>' : r.verdict ? '<span class="cv-tag off">not offered</span>' : '<span class="muted small">—</span>'
              }</td></tr>`
          )
          .join("")}</tbody></table>`
      : `<p class="muted small">Nothing yet. When JOYA AI answers with a widget, what you pin, dismiss and open is counted here.</p>`;
    return V.group(
      "Board",
      "core",
      V.row(
        "Lock the layout",
        "The Command Center's board follows the moment: the brief in the morning, a failed session with a Fix it button, a quiet board when all is calm. Locked, it stays as you arranged it.",
        V.form("/joya-ai/settings/canvas/lock", csrf, V.sw('name="on" value="1" aria-label="Lock the board\'s layout"', pr.locked, "Locked", "Follows the moment")),
        { scope: "you", id: "a-board" }
      ) +
        V.more(
          "More: learning",
        V.row(
          "Learn from what I keep",
          `Kinds you pin often become standing tiles; kinds you always dismiss stop being offered. ${pins.length} pinned now.`,
          V.form("/joya-ai/settings/canvas/learn", csrf, V.sw('name="on" value="1" aria-label="Learn from what I pin and dismiss"', pr.learn)),
          { scope: "you", id: "a-board-learn" }
        ) +
        V.row("What it learned", null, rows, { full: true, scope: "you", id: "a-board-stats" }) +
        V.row(
          "Reset",
          "Forget the counts and what they decided. Your pinned widgets stay.",
          V.form("/joya-ai/settings/canvas/reset", csrf, `<button type="submit" class="btn small">${icon("restart", 14)}Reset what the board learned</button>`, {
            noSave: true,
            confirm: "Reset what the board learned?",
            confirmBody: "The counts of offered, pinned, dismissed and opened widgets are forgotten. Pinned widgets stay.",
            confirmYes: "Reset",
          }),
          { scope: "you", id: "a-board-reset" }
        ),
          { id: "a-board-more" }
        ),
      { id: "board" }
    );
  }

  /**
   * A widget JOYA AI sent, about to reach this person's tab: still offered to them? Counts the offer.
   * Returns { ok: true, value, key } or { ok: false, why }.
   */
  function offer(user, widget) {
    const v = W.validate(widget);
    if (!v.ok) return { ok: false, why: v.why };
    if (store.suppressed(user.id, v.key)) return { ok: false, why: `the administrator keeps dismissing ${v.value.kind} widgets of this kind (${v.key}); answer in words instead` };
    store.count(user.id, v.key, "offered");
    return v;
  }

  return { store, offer };
}

module.exports = { mount };
