"use strict";
/**
 * Second-factor checks for things that are not signing in.
 *
 * Sign-in proves who you are at the start of a session. That is a different
 * question from "is the person at the keyboard right now willing to turn on
 * root", asked possibly hours later on a laptop somebody walked past. This
 * module answers the second one.
 *
 * Every accepted code is burned. Without that a code is a bearer token for its
 * whole ninety-second life: read over a shoulder, or seen once in a screen
 * share, it would still work. Burning also protects the sign-in path, where a
 * replayed code plus a known password was previously enough.
 */

const { authenticator } = require("otplib");
const { db, nowIso } = require("./db");

// RFC 6238's step, which is what every authenticator app assumes.
const STEP_SECONDS = 30;
// Rows older than this cannot match a code that is still valid, so they are
// only taking up space.
const RETENTION_SECONDS = STEP_SECONDS * 10;

db.exec(`
  CREATE TABLE IF NOT EXISTS totp_used (
    user_id INTEGER NOT NULL,
    step    INTEGER NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (user_id, step)
  );
`);

const claim = db.prepare(
  "INSERT OR IGNORE INTO totp_used (user_id, step, used_at) VALUES (?, ?, ?)"
);
const prune = db.prepare("DELETE FROM totp_used WHERE used_at < ?");

/**
 * Check a code for a user and spend it.
 *
 * Returns true only if the code was valid *and* had not been used. The two are
 * one operation on purpose: checking and then separately recording leaves a
 * window in which the same code passes twice.
 *
 * `checkDelta` answers both halves at once -- whether the code is good, and
 * which step it came from, which is the thing that gets burned. It also answers
 * them without touching anything, and that matters more than the tidiness.
 *
 * The version before this one recovered the step by assigning `epoch` to the
 * shared `authenticator` and putting the old options back afterwards. Putting
 * them back did not work: `authenticator.options` is a getter returning a
 * merged snapshot, and the setter merges rather than replaces, so a key that is
 * absent from the snapshot cannot clear the one set during the search. The
 * epoch stayed pinned to the moment of the last successful code, for the life
 * of the process. Every later code was then checked against a clock that had
 * stopped, so the first code after a restart worked and every one after it
 * failed -- which is exactly what it looked like from the outside: signing in
 * worked, and unlocking root ninety seconds later did not.
 */
function verifyAndConsume(user, code) {
  const supplied = String(code || "").replace(/\D/g, "");
  if (supplied.length !== 6) return false;
  if (!user || !user.totp_secret) return false;

  // null when the code does not match anywhere in the accepted window; a
  // number -- the offset in steps from now -- when it does.
  let delta = null;
  try {
    delta = authenticator.checkDelta(supplied, user.totp_secret);
  } catch (_) {
    delta = null;
  }
  if (typeof delta !== "number") return false;

  const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + delta;

  const inserted = claim.run(user.id, step, nowIso()).changes;
  prune.run(new Date(Date.now() - RETENTION_SECONDS * 1000).toISOString());

  return inserted === 1;
}

module.exports = { verifyAndConsume, STEP_SECONDS };
