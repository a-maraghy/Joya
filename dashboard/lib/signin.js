"use strict";
/**
 * How people sign in to this panel (2026-11-02; the administrator: "remove the authenticator
 * option completely" for Joya's installs).
 *
 *   default            username + password + a second factor: the authenticator code (TOTP),
 *                      or a passkey (Windows Hello). Step-up asks for either.
 *   JOYA_PASSWORD_ONLY=1   username + password, nothing else: no authenticator enrolment, no
 *                      code at sign-in, no passkeys; step-up (approving a sensitive action)
 *                      asks for the password again. Joya (github.com/a-maraghy/Joya) sets it.
 */
const passwordOnly = process.env.JOYA_PASSWORD_ONLY === "1";

module.exports = { passwordOnly };
