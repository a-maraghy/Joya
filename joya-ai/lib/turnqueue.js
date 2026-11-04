"use strict";
/**
 * Which queued turn JOYA AI takes next.
 *
 * The supervisor used to write every queued turn straight into the CLI, which
 * runs them strictly in arrival order -- so a question the administrator
 * typed or spoke waited behind a watcher investigation or a standing order
 * (one voice turn waited 86 s behind a watcher turn). Now the supervisor
 * keeps the queue itself and hands the CLI one turn at a time, picking:
 *
 *   1. user turns -- whatever a panel user started: typed or spoken in the
 *      Command Center, the voice desk's hand-offs, mission requests, decision
 *      approvals and questions, a standing order run by hand;
 *   2. background turns -- watcher investigations, scheduled standing
 *      orders, and what other sessions send (peer messages, their idle and
 *      delivery notices, a peer message held at the token cap) -- only when no
 *      user turn is waiting (2026-09-30: peer turns were classed as the
 *      administrator's, and a spoken request waited 22 s behind them);
 *
 * first-in first-out within each class (by ledger id, which is arrival
 * order, so re-queued turns keep their place).
 *
 * Nothing is dropped, and nothing starves: a background turn that has waited
 * `maxWaitMs` is promoted and competes with user turns by arrival order.
 *
 * A running turn is never interrupted for a waiting one: an interrupted
 * investigation or order would lose its work and have to start again, and a
 * running turn may be holding an approval card. The user turn goes next.
 */

const BACKGROUND_SOURCES = new Set(["watcher", "order", "peer", "idle", "delivery", "system", "machine"]);

/**
 * "user" or "background". A standing order run by hand is the user's; a
 * message held at the token cap is a peer's (background) unless it came
 * through Remote Control (the administrator: actor "remote").
 */
function classOf(row) {
  if (!row) return "user";
  if (row.source === "watcher") return "background";
  if (row.source === "order") return row.actor && row.actor !== "scheduler" ? "user" : "background";
  if (row.source === "cap-held") return row.actor === "remote" ? "user" : "background";
  return BACKGROUND_SOURCES.has(row.source) ? "background" : "user";
}

function ageMs(row, nowMs) {
  const t = Date.parse(row && row.created_at);
  return isFinite(t) ? nowMs - t : 0;
}

/**
 * Index into `pending` ([{ row, ... }]) of the turn to run next, or -1.
 * @param maxWaitMs background turns older than this rank as user turns
 */
function pickNext(pending, nowMs = Date.now(), maxWaitMs = 10 * 60 * 1000) {
  let best = -1;
  let bestKey = null;
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i].row;
    const urgent = classOf(row) === "user" || (maxWaitMs > 0 && ageMs(row, nowMs) >= maxWaitMs);
    const key = [urgent ? 0 : 1, Number(row && row.id) || 0, i];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = i;
      bestKey = key;
    }
  }
  return best;
}

/** Position (1-based) each pending turn would run in, for the panel. */
function order(pending, nowMs = Date.now(), maxWaitMs) {
  const rest = pending.slice();
  const out = [];
  while (rest.length) {
    const i = pickNext(rest, nowMs, maxWaitMs);
    out.push(rest.splice(i, 1)[0]);
  }
  return out;
}

module.exports = { classOf, pickNext, order, BACKGROUND_SOURCES };
