"use strict";
/**
 * UI control, Phase 2: JOYA AI's own ui_action (its MCP tool) reaching the
 * Command Center tab that asked -- and no other.
 *
 * The chain:
 *   1. The administrator sends from a tab (typed, direct voice, the relay
 *      desk's hand-off or a live call's hand-off). THIS server mints a one-time
 *      ui token (`ut`) for that send, remembers {actor, tab, via} for it here,
 *      in memory only, and passes it with the send.
 *   2. The supervisor keeps the token with that turn (memory only) and accepts
 *      JOYA AI's ui-action only while that very turn runs; it then publishes a
 *      live "ui" event (never in its replay ring) carrying a TAG of the token
 *      (sha256, 16 hex) -- never the token.
 *   3. Each Command Center event stream (one per tab) asks route(): the tag
 *      must be one minted here, for this user, for this tab; the event is
 *      claimed once (nonce), bound to the first turn it came from, and only
 *      then delivered. An unknown tag is dropped and audited once.
 *   4. The tab (or the live call) does it and answers; the answer goes back to
 *      the supervisor as ui-ack, by the same user, for a nonce delivered here.
 *
 * So a `send` forged straight onto the supervisor's socket carries a token
 * nobody minted here: its screen actions are dropped at step 3.
 */
const crypto = require("crypto");

const TTL_MS = 60 * 60 * 1000; // a turn can run long; the supervisor also ends it with the turn
const MAX_TOKENS = 500;
const TAB_RE = /^[A-Za-z0-9_-]{8,40}$/;

const tag = (ut) => crypto.createHash("sha256").update(String(ut)).digest("hex").slice(0, 16);

function createRelay({ now = Date.now } = {}) {
  const byTag = new Map(); // tag -> { actor, tab, via, callId, exp, turnId }
  const claimed = new Map(); // nonce -> expiry (delivered or dropped once)
  const delivered = new Map(); // nonce -> { actor, exp } (waiting for the page's ack)

  function sweep() {
    const t = now();
    for (const [k, v] of byTag) if (v.exp < t) byTag.delete(k);
    for (const [k, v] of claimed) if (v < t) claimed.delete(k);
    for (const [k, v] of delivered) if (v.exp < t) delivered.delete(k);
    while (byTag.size > MAX_TOKENS) byTag.delete(byTag.keys().next().value);
  }

  return {
    /** A new token for one send from `tab` by `actor`; null when the tab id is not one. */
    joya({ actor, tab, via, callId }) {
      if (!actor || typeof tab !== "string" || !TAB_RE.test(tab)) return null;
      sweep();
      const ut = crypto.randomBytes(18).toString("base64url"); // 24 chars
      byTag.set(tag(ut), { actor, tab, via: via === "live" ? "live" : "page", callId: callId || null, exp: now() + TTL_MS, turnId: null });
      return ut;
    },

    /**
     * One supervisor "ui" event seen by the stream of (`actor`, `tab`).
     * Returns {deliver: reg} for the one stream that should act on it,
     * {forged: true} once for an event no token here explains, or {} (not
     * this stream's, or already claimed).
     */
    route(ev, actor, tab) {
      if (!ev || typeof ev.nonce !== "string" || typeof ev.ut_tag !== "string") return {};
      const reg = byTag.get(ev.ut_tag);
      const t = now();
      if (!reg || reg.exp < t || reg.actor !== ev.actor || (reg.turnId !== null && reg.turnId !== ev.turn_id)) {
        if (claimed.has(ev.nonce)) return {};
        claimed.set(ev.nonce, t + 60000);
        return { forged: true };
      }
      if (reg.actor !== actor || reg.tab !== tab) return {};
      if (claimed.has(ev.nonce)) return {};
      claimed.set(ev.nonce, t + 60000);
      if (reg.turnId === null) reg.turnId = ev.turn_id; // one token, one turn
      delivered.set(ev.nonce, { actor, exp: t + 10000 });
      return { deliver: reg };
    },

    /** The turn the supervisor started for a token's send: from now on only that turn's events match it. */
    bind(ut, turnId) {
      const reg = byTag.get(tag(ut));
      if (reg && reg.turnId === null && turnId != null) reg.turnId = turnId;
    },

    /** The page's answer: only for a nonce delivered here to that same user, once. */
    takeAck(nonce, actor) {
      const d = delivered.get(String(nonce || ""));
      if (!d || d.actor !== actor || d.exp < now()) return false;
      delivered.delete(String(nonce));
      return true;
    },

    size: () => byTag.size,
  };
}

module.exports = { createRelay, tag, TAB_RE };
