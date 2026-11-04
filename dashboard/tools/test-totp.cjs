/**
 * Tests for the second-factor checks in lib/totp.js.
 *
 *     node dashboard/tools/test-totp.cjs
 *
 * Runs against a scratch database, so it never touches the panel's own. The
 * cases that matter are replay and near-misses: a code that works twice would
 * make every gate built on this decorative.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
process.env.JOYA_DATA_DIR = "/tmp/totp-test-" + Date.now();

const { authenticator } = require("otplib");
const totp = require(require("path").join(__dirname, "..", "lib", "totp.js"));

const user = { id: 1, totp_secret: authenticator.generateSecret() };
const other = { id: 2, totp_secret: authenticator.generateSecret() };

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return console.log("ok   " + name);
  failures++;
  console.log("FAIL " + name + "  (got " + actual + ", wanted " + expected + ")");
}

const code = authenticator.generate(user.totp_secret);

check("a valid code is accepted", totp.verifyAndConsume(user, code), true);
check("the same code is refused a second time", totp.verifyAndConsume(user, code), false);
check("a third attempt is still refused", totp.verifyAndConsume(user, code), false);

check("a wrong code is refused", totp.verifyAndConsume(user, "000000"), false);
check("a short code is refused", totp.verifyAndConsume(user, "12345"), false);
check("a non-numeric code is refused", totp.verifyAndConsume(user, "abcdef"), false);
check("an empty code is refused", totp.verifyAndConsume(user, ""), false);
check("a missing user is refused", totp.verifyAndConsume(null, code), false);
check(
  "a user with no secret is refused",
  totp.verifyAndConsume({ id: 3, totp_secret: "" }, code),
  false
);

// Someone else's current code must not work here, and burning one user's code
// must not burn another's.
const otherCode = authenticator.generate(other.totp_secret);
check("another user's code is refused", totp.verifyAndConsume(user, otherCode), false);
check("that code still works for its owner", totp.verifyAndConsume(other, otherCode), true);

// Spaces are how people paste a code off a phone. A third account, so this
// does not depend on the clock having crossed a thirty-second boundary.
const spaced = { id: 4, totp_secret: authenticator.generateSecret() };
const spacedCode = authenticator.generate(spaced.totp_secret);
check(
  "a code with spaces is accepted",
  totp.verifyAndConsume(spaced, spacedCode.slice(0, 3) + " " + spacedCode.slice(3)),
  true
);
check("and the same code is then refused", totp.verifyAndConsume(spaced, spacedCode), false);


/* --------------------------------------------------- the clock keeps moving --
 *
 * The regression these exist for: recovering which step a code belonged to used
 * to assign `epoch` on the shared otplib instance and then try to put the old
 * options back. It could not -- the setter merges, and the getter's snapshot
 * has no key to clear with -- so the clock stayed pinned to the moment of the
 * last accepted code for the life of the process. The first code after a
 * restart worked and every later one was refused, which from the outside looked
 * exactly like "signing in works, unlocking root a minute later does not".
 *
 * Every test above passes with that bug present, because none of them lets any
 * time pass. These two do: one checks the invariant directly, and one waits for
 * a real thirty-second boundary and offers the code a phone would be showing.
 */
check(
  "verifying leaves the shared authenticator's clock alone",
  authenticator.options.epoch === undefined,
  true
);

const clockUser = { id: 5, totp_secret: authenticator.generateSecret() };
const stepNow = () => Math.floor(Date.now() / 1000 / totp.STEP_SECONDS);

check(
  "a code is accepted in the current step",
  totp.verifyAndConsume(clockUser, authenticator.generate(clockUser.totp_secret)),
  true
);

/** Wait for the clock to roll into the next step, then check a fresh code. */
function acrossBoundary(remaining, done) {
  if (!remaining) return done();
  const startedIn = stepNow();
  const poll = () => {
    if (stepNow() === startedIn) return setTimeout(poll, 1000);
    check(
      "a code from the next step is accepted too (" + remaining + " to go)",
      totp.verifyAndConsume(clockUser, authenticator.generate(clockUser.totp_secret)),
      true
    );
    acrossBoundary(remaining - 1, done);
  };
  setTimeout(poll, 1000);
}

// Two boundaries: one proves the clock is not pinned, the second proves the
// first success did not pin it either.
acrossBoundary(2, () => {
  check(
    "and the clock is still not pinned at the end",
    authenticator.options.epoch === undefined,
    true
  );
  console.log(failures ? "\nFAILURES: " + failures : "\nALL TOTP TESTS PASSED");
  process.exit(failures ? 1 : 0);
});
