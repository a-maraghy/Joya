"use strict";
/**
 * UI control, Phase 3: the Tier-2 screen actions (theme.set, persona.set,
 * voice.set) wait for the administrator's own confirm, which this server checks.
 *
 * When the voice (or JOYA AI) asks for one, open() records it for that user --
 * one at a time, for 30 s -- and the page shows a confirm chip. It is applied
 * only after:
 *   (a) a click on Confirm, or
 *   (b) the administrator's NEXT utterance, as this server transcribed it
 *       (never a model's words), being a whole "yes" (public/voice-stop.js
 *       yes(): "yes", "go ahead", «أيوه», «اعملها»...). heard() marks it
 *       confirmed and the page is told.
 * In both cases the page then calls take(), which hands the entry over once;
 * the page applies it through the existing, CSRF'd, permission-checked route.
 * A "no" cancels it; any other utterance cancels it too (the next turn has
 * moved on), and so does the 30 s expiry. Nothing here writes a setting.
 *
 * The 30 s run from when the voice has finished asking (arm(), called by the
 * live call once its voice is quiet), not from the ask itself. Expiry is not
 * silent: onExpire(actor, entry) is called once when an entry runs out
 * unanswered, so the server can audit it, update the chip and tell the voice.
 */
const crypto = require("crypto");

const TTL_MS = 30000;

function createConfirms({ now = Date.now, onExpire = null, setTimer = null } = {}) {
  const byActor = new Map(); // actor -> { id, action, args, tab, exp, heardYes }
  const later = setTimer || ((fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; });

  const expire = (actor, e) => {
    if (byActor.get(actor) !== e) return;
    byActor.delete(actor);
    if (onExpire) {
      try {
        onExpire(actor, { id: e.id, action: e.action, args: { ...e.args }, tab: e.tab, ip: e.ip });
      } catch (_) {
        /* best effort */
      }
    }
  };
  const live = (actor) => {
    const e = byActor.get(actor);
    if (e && e.exp < now()) {
      expire(actor, e);
      return null;
    }
    return e || null;
  };
  // One timer per entry, re-checked on firing (arm() may have moved exp later).
  const watch = (actor, e) => {
    const gen = (e.gen = (e.gen || 0) + 1);
    later(() => {
      if (e.gen !== gen || byActor.get(actor) !== e) return;
      if (e.exp <= now()) expire(actor, e);
    }, Math.max(0, e.exp - now()) + 5);
  };

  return {
    TTL_MS,
    /** A new pending confirm; refused while another one is waiting. */
    open({ actor, action, args, tab, ip }) {
      if (!actor) return { error: "no user" };
      if (live(actor)) return { error: "a confirm is already waiting on the screen: let the administrator answer it first" };
      const id = crypto.randomBytes(9).toString("hex");
      const e = { id, action, args: { ...(args || {}) }, tab: tab || null, ip: ip || null, exp: now() + TTL_MS, heardYes: false };
      byActor.set(actor, e);
      watch(actor, e);
      return { id };
    },

    /** The voice has finished asking: the 30 s start now. Only that user's pending id. */
    arm(actor, id) {
      const e = live(actor);
      if (!e || e.id !== id || e.heardYes) return false;
      e.exp = now() + TTL_MS;
      watch(actor, e);
      return true;
    },

    /** Is an action of this kind waiting for anyone's confirm? */
    anyPending(action) {
      for (const [actor, e] of byActor) {
        if (e.exp < now()) expire(actor, e);
        else if (e.action === action) return true;
      }
      return false;
    },

    /** What is pending for this user (a copy), or null. */
    pending(actor) {
      const e = live(actor);
      return e ? { id: e.id, action: e.action, args: { ...e.args }, heardYes: e.heardYes } : null;
    },

    /**
     * The administrator's next utterance, as this server heard it. Returns
     * {confirmed: entry} for a whole "yes", {cancelled: entry} for a whole
     * "no", {dropped: entry} for anything else (the turn goes on as usual),
     * or null when nothing was pending.
     */
    heard(actor, text, matchers) {
      const e = live(actor);
      if (!e || e.heardYes) return null;
      if (matchers.yes(text)) {
        e.heardYes = true;
        return { confirmed: { id: e.id, action: e.action, args: { ...e.args } } };
      }
      byActor.delete(actor);
      const out = { id: e.id, action: e.action, args: { ...e.args } };
      return matchers.no(text) ? { cancelled: out } : { dropped: out };
    },

    /**
     * The page's decision: "confirm" (a click, or after a heard yes) hands the
     * entry over once; "cancel" drops it. Only that user's pending id.
     */
    take(actor, id, decision) {
      const e = live(actor);
      if (!e || e.id !== id) return null;
      byActor.delete(actor);
      if (decision !== "confirm") return { cancelled: true, action: e.action, args: e.args };
      return { action: e.action, args: e.args, spoken: e.heardYes };
    },
  };
}

module.exports = { createConfirms, TTL_MS };
