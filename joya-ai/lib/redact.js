"use strict";
/**
 * Secrets never leave the supervisor for the dashboard.
 *
 * The same patterns as dashboard/lib/priv.js, applied to every event and ledger
 * row on the way out. The dashboard redacts again; two passes cost nothing and
 * the second one does not depend on the first being complete.
 */
const SECRET_PATTERNS = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,60}\b/g, "«bot-token»"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "«anthropic-key»"],
  [/\bsk-[A-Za-z0-9_-]{32,}/g, "«api-key»"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "«github-token»"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "«private-key»"],
  [/\b(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/gi, "$1«token»"],
  [/\b(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|PGPASSWORD|PASSWORD|SECRET|TOKEN)(\s*[=:]\s*["']?)[^\s"',;]+/g, "$1$2«redacted»"],
];

function redact(text) {
  let out = String(text == null ? "" : text);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function redactDeep(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactDeep(x);
    return o;
  }
  return v;
}

function clip(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

module.exports = { redact, redactDeep, clip };
