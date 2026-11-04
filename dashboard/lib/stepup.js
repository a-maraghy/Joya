"use strict";
/**
 * Windows Hello for every approval (user decision, 2026-10-08).
 *
 * Anything that lets something run -- Approve once, Always allow this, Apply
 * fix, Retire, Resume past a cap, an allow rule or a rule change, the console's
 * Allow -- needs a fresh passkey assertion with user verification from the
 * signed-in user (Windows Hello on the laptop, the platform authenticator
 * elsewhere), or, where no passkey can be used, a fresh authenticator code.
 * Deny, Keep, Dismiss and the like never do.
 *
 * The server enforces it; the page only helps. A route wrapped in
 * `requireStepUp(spec)` refuses a request that carries no proof with 428 and a
 * challenge bound to exactly that request (spec.bind: the approval id and the
 * decision, plus a hash of an always-allow rule's pattern), and accepts the
 * same request again with `step_up` in its body:
 *
 *   { token, response }   the challenge and navigator.credentials.get()'s answer
 *   { totp: "123456" }    the authenticator code (burned, like every code)
 *
 * A challenge is single use, two minutes at most, and bound to the user, the
 * browser session and the bind string (lib/passkeys.js stepUpOptions). A wrong
 * answer is refused with a fresh challenge so the page can try again. Wrong
 * codes are counted: five in ten minutes and codes are refused for a while
 * (Windows Hello still works).
 *
 * There is no setting that turns this off.
 */

const passkeys = require("./passkeys");
const totp = require("./totp");
const signin = require("./signin");

const FAIL_MAX = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const fails = new Map(); // user id -> {n, first}

function codeLocked(userId) {
  const f = fails.get(userId);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) {
    fails.delete(userId);
    return false;
  }
  return f.n >= FAIL_MAX;
}
function codeFailed(userId) {
  const f = fails.get(userId);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) fails.set(userId, { n: 1, first: Date.now() });
  else f.n++;
}

/** The proof from a JSON body or a form's hidden field (JSON text). */
function proofOf(body) {
  let p = body && body.step_up;
  if (typeof p === "string") {
    if (p.length > 20000) return null;
    try {
      p = JSON.parse(p);
    } catch (_) {
      return null;
    }
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (typeof p.totp === "string" || typeof p.totp === "number") return { totp: String(p.totp) };
  if (signin.passwordOnly && typeof p.password === "string" && p.password.length <= 1024) return { password: p.password };
  if (typeof p.token === "string" && p.response && typeof p.response === "object") return { token: p.token, response: p.response };
  return null;
}

/** A challenge for `bind`: what the page needs to ask for Windows Hello, or why it cannot. */
async function challenge(req, bind, what) {
  // Password-only sign-in (lib/signin.js): the password is the only thing to confirm with.
  if (signin.passwordOnly)
    return { what: what || "Approve", token: null, passkey: null, no_passkey: null, totp: false, password: true, code_locked: codeLocked(req.me.id) };
  const rp = passkeys.rpFor(req);
  let opts = null;
  let noPasskey = null;
  if (!rp) noPasskey = "This address cannot use Windows Hello" + (passkeys.primaryOrigin() ? ` (it works at ${passkeys.primaryOrigin()})` : "") + ".";
  else {
    opts = await passkeys.stepUpOptions(req.me, rp, req.sessionID, bind);
    if (!opts) noPasskey = "No Windows Hello passkey is registered for this address yet (Account ▸ Passkeys).";
  }
  return {
    what: what || "Approve",
    token: opts ? opts.challenge : null,
    passkey: opts,
    no_passkey: noPasskey,
    totp: !!(req.me && req.me.totp_secret),
    code_locked: codeLocked(req.me.id),
  };
}

/**
 * Check a proof against `bind`. {ok: true, method: "hello"|"totp", with} or
 * {ok: false, status, error}.
 */
async function verify(req, bind, proof) {
  if (signin.passwordOnly) {
    if (proof.password === undefined) return { ok: false, status: 403, error: "Enter your password to approve." };
    if (codeLocked(req.me.id)) return { ok: false, status: 429, error: "Too many wrong passwords. Wait ten minutes." };
    let good = false;
    try {
      good = await require("argon2").verify(req.me.password_hash, proof.password);
    } catch (_) {
      good = false;
    }
    if (!good) {
      codeFailed(req.me.id);
      return { ok: false, status: 403, error: "That password is not right." };
    }
    fails.delete(req.me.id);
    return { ok: true, method: "password", with: "password" };
  }
  if (proof.totp !== undefined) {
    if (codeLocked(req.me.id)) return { ok: false, status: 429, error: "Too many wrong codes. Use Windows Hello, or wait ten minutes." };
    if (!totp.verifyAndConsume(req.me, proof.totp)) {
      codeFailed(req.me.id);
      return { ok: false, status: 403, error: "That code is wrong or was already used. Wait for the next one." };
    }
    fails.delete(req.me.id);
    return { ok: true, method: "totp", with: "authenticator code" };
  }
  const rp = passkeys.rpFor(req);
  if (!rp) return { ok: false, status: 403, error: "This address cannot use Windows Hello. Use your authenticator code." };
  const r = await passkeys.verifyStepUp(req.me, rp, req.sessionID, bind, proof.token, proof.response);
  if (!r.ok) return { ok: false, status: 403, error: "Windows Hello was not accepted: " + r.error + "." };
  return { ok: true, method: "hello", with: r.passkey.name };
}

/** "Windows Hello (Laptop Windows Hello)" / "authenticator code", for audit lines. */
function label(s) {
  if (!s) return "no step-up";
  return s.method === "hello" ? `Windows Hello (${s.with})` : s.method === "password" ? "password" : "authenticator code";
}

const wantsJson = (req) => /json/.test(String(req.get("accept") || "")) || req.get("x-requested-with") === "fetch" || req.is("application/json");

/**
 * Middleware. spec:
 *   bind(req)  -> the bind string, or null when this request allows nothing
 *                 (a deny, a deny rule) and passes without Hello; it may throw
 *                 on a malformed request (answered 400)
 *   what(req)  -> a short line the dialog shows ("Approve request #12")
 *   hold(req)  -> optional, async: keep the card alive while Hello runs;
 *                 resolves to its new expires_at (or null)
 *   html(req, res, message) -> optional: a refusal for a plain form post
 *   audit(req, line) -> optional: write an audit line for a refusal
 * On success req.stepUp = {method, with, bind} and step_up is gone from the body.
 */
function requireStepUp(spec) {
  return async (req, res, next) => {
    let bind;
    try {
      bind = spec.bind(req);
    } catch (e) {
      return res.status(400).json({ error: (e && e.message) || "Bad request." });
    }
    if (!bind) {
      if (req.body) delete req.body.step_up;
      return next();
    }
    const what = spec.what ? spec.what(req) : "Approve";
    const proof = proofOf(req.body);
    if (req.body) delete req.body.step_up;
    const refuse = async (status, error, code) => {
      if (spec.audit) spec.audit(req, `${what}: refused (${error})`);
      if (!wantsJson(req) && spec.html) return spec.html(req, res, error);
      const body = { error, code, step_up: await challenge(req, bind, what) };
      if (spec.hold) {
        try {
          const exp = await spec.hold(req);
          if (exp) body.step_up.expires_at = exp;
        } catch (_) {
          /* the card may be gone; the decision itself will say so */
        }
      }
      return res.status(status).json(body);
    };
    try {
      if (!proof) return await refuse(428, signin.passwordOnly ? "Confirm it is you: enter your password." : "Confirm it is you: Windows Hello, or your authenticator code.", "step-up");
      const r = await verify(req, bind, proof);
      if (!r.ok) return await refuse(r.status, r.error, r.status === 429 ? "step-up-locked" : "step-up-failed");
      req.stepUp = { method: r.method, with: r.with, bind };
      next();
    } catch (e) {
      res.status(500).json({ error: "Windows Hello could not be checked: " + ((e && e.message) || e) });
    }
  };
}

module.exports = { requireStepUp, proofOf, verify, challenge, label, FAIL_MAX };
