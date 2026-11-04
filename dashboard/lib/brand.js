"use strict";
/**
 * The Joya logo as server-rendered markup: the word JOYA, set as text in the
 * type system (2026-10-25). The leaf marks, the seedlings of the old Agents
 * nursery, the spark and the sign-in watermark are gone with lib/marks.js; the
 * browser-tab icon is the M monogram (tools/make-monogram.cjs).
 */

/**
 * `kind` ("os" / "ai") is kept for the callers; the mark is the same for both.
 * `sub` adds the plain line under it on the sign-in pages ("Operating System" /
 * "Artificial Intelligence").
 */
function lockup(kind, o = {}) {
  const ai = kind === "ai";
  const sub = o.sub ? `<span class="wm-sub">${ai ? "Artificial Intelligence" : "Operating System"}</span>` : "";
  return `<span class="wordmark${o.sub ? " full" : ""}${o.cls ? " " + o.cls : ""}"><span class="wm-joya">JOYA</span>${sub}</span>`;
}

module.exports = { lockup };
