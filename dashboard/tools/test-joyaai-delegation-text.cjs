/**
 * Tests for showing a delegation's FULL sent text in the Command Center
 * (administrator request, 2026-09-28): the session deep view (v3; it replaced
 * the v2 card's message popover) and the Timeline's delegation rows must carry the whole `text` field from
 * the ledger, not a clipped summary or first line -- while still escaping it
 * (it is arbitrary content JOYA AI sent, not trusted markup) and staying
 * inside its own scrolling box rather than growing the page.
 *
 *     node dashboard/tools/test-joyaai-delegation-text.cjs
 *
 * Companion to test-joyaai-page.cjs, which already covers the page frame and
 * the broad CSP/escaping rules that apply to every string the client builds;
 * this file is narrower, about this one feature.
 *
 * .cjs because it uses require, and some directories it may be run from
 * declare "type": "module".
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
const client = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "joya-ai.css"), "utf8");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}

/** Pull `function name(...) {...}` out of the client by brace matching. */
function cut(name) {
  const start = client.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = client.indexOf("{", start); i < client.length; i++) {
    if (client[i] === "{") depth++;
    else if (client[i] === "}" && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}

/* ---------------------------------------------------------------- icon --- */

check("a message icon exists for the sprite", !!views.SPRITE.message);
check("the page references the message icon", /ic\("message"\)/.test(client + fs.readFileSync(path.join(ROOT, "public", "cc-panels.js"), "utf8")));

/* ------------------------------------------------------- deep view --- */
/* v3: clicking a session card opens its read-only deep view, whose "What JOYA
   AI told it · full text" box replaced v2's message popover. */

const panels = fs.readFileSync(path.join(ROOT, "public", "cc-panels.js"), "utf8");
function cutFrom(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}
check("the session card opens the deep view (wired in the sessions click handler)", /data-deep-open[\s\S]{0,200}P\.openDeep\(/.test(client));
{
  const fn = cutFrom(panels, "deepToldHTML");
  check("the deep view shows each delegation's full text (summary only as a fallback)", /esc\(d\.text \|\| d\.summary \|\| ""\)/.test(fn));
  check("the deep view never truncates the text with clip() or firstLine()", !/\b(clip|firstLine)\(\s*d\.text/.test(fn));
  check("the text sits in its own .cc-told block", fn.includes("cc-told"));
  check("each message shows when it was sent and its status", /esc\(hm\(d\.created_at\)\)/.test(fn) && /TL_LAB\[d\.status\]/.test(fn));
  check("no inline handler in the deep view text", !/on[a-z]+\s*=/.test(fn));
  // Run it: the text comes out whole and escaped.
  const vm = require("vm");
  const box = { esc: null, hm: (x) => "12:00", CC: { TL_LAB: { done: "done" } } };
  vm.runInNewContext(cut("esc") + "\n" + fn.replace("function deepToldHTML", "this.deepToldHTML = function"), box);
  const long = "Step 1: " + "x".repeat(5000) + "\n<img src=x onerror=alert(1)>\nLine three.";
  const out = box.deepToldHTML([{ text: long, status: "done", created_at: "2026-09-28T10:00:00Z" }], { self: false });
  check("the whole long message is there", out.includes("x".repeat(5000)) && out.includes("Line three."));
  check("markup in the message is escaped", !out.includes("<img") && out.includes("&lt;img"));
  check("JOYA AI's own deep view says it is the one delegating", /one delegating/.test(box.deepToldHTML([], { self: true })));
}
check("the deep view reads the full delegation rows from the mirror", /d\.delegations \|\|/.test(panels));

/* -------------------------------------------------------------- timeline --- */

{
  const fn = cut("renderTimeline");
  // The delegation branch (kind === "d") must render the row's own `.text`
  // (or `.summary` as a fallback for rows that predate the field), never a
  // clipped or first-line-only rendering as before.
  const delegationLine = fn.split("\n").find((l) => l.includes('class="t full"'));
  check("renderTimeline has a delegation row with the full-text class", !!delegationLine);
  check(
    "the delegation row shows esc(r.text || r.summary), not clip()/firstLine() of the message",
    !!delegationLine && /esc\(r\.text \|\| r\.summary \|\| ""\)/.test(delegationLine)
  );
  check(
    "the delegation row's own text is never wrapped in clip()/firstLine()",
    !!delegationLine && !/\b(clip|firstLine)\(r\.text/.test(delegationLine)
  );
  // The approval branch is untouched: still clipped, since approvals are a
  // different, already-short kind of entry this feature does not cover.
  const approvalLine = fn.split("\n").find((l) => l.includes("approvalCmd(r).text"));
  check("the approval row (a different ledger) still clips as before", !!approvalLine && /clip\(approvalCmd\(r\)\.text, 160\)/.test(approvalLine));
  check("the time and status badge are still rendered on the delegation row", !!delegationLine && delegationLine.includes("cc-tl-time") && /cc-badge b-.*TL_LAB/.test(delegationLine));
}

/* ------------------------------------------------------------------ css --- */

check(
  "the timeline's full-text block is unclamped and scrolls within itself",
  /\.cc-tl-cmd \.t\.full\s*\{[^}]*-webkit-line-clamp:\s*unset[^}]*overflow-y:\s*auto/s.test(css.replace(/\n/g, " "))
);
check(
  "the timeline's full-text block preserves the message's own line breaks",
  /\.cc-tl-cmd \.t\.full\s*\{[^}]*white-space:\s*pre-wrap/s.test(css.replace(/\n/g, " "))
);
check(
  "the deep view's full-text box scrolls within itself, not the page",
  /\.cc-told\s*\{[^}]*overflow-y:\s*auto/s.test(css.replace(/\n/g, " "))
);
check(
  "the deep view's full-text box wraps long words instead of overflowing",
  /\.cc-told\s*\{[^}]*overflow-wrap:\s*anywhere/s.test(css.replace(/\n/g, " "))
);
check(
  "the full-text box has a fixed max-height (never grows the page) and keeps line breaks",
  /\.cc-told\s*\{[^}]*max-height:\s*\d/s.test(css.replace(/\n/g, " ")) && /\.cc-told\s*\{[^}]*white-space:\s*pre-wrap/s.test(css.replace(/\n/g, " "))
);
// No new colour literal was introduced; the theme rule from test-joyaai-page.cjs already
// checks the whole file, but a scoped check here documents the intent locally.
check("the new rules use theme tokens, not literal colours", !/\.cc-told[\s\S]{0,400}#[0-9a-fA-F]{3,8}/.test(css));

/* ---------------------------------------------------- escaping, in practice --- */

{
  const { esc } = (() => {
    const vm = require("vm");
    const sandbox = {};
    vm.runInNewContext(cut("esc"), sandbox);
    return sandbox;
  })();
  const evil = `<img src=x onerror=alert(1)>Please pick up the review.\nLine two.`;
  const rendered = esc(evil);
  check("esc() neutralises HTML that could be sitting in a delegation's text", !rendered.includes("<img"));
  check("esc() keeps the newline (CSS white-space:pre-wrap renders it, not <br>)", rendered.includes("\n"));
}

/* ---------------------------------------------------- no CSP regressions --- */

check("no inline style attribute was introduced by this feature", !/cc-told[\s\S]{0,200}style=\\?"/.test(panels));
check("no inline event handler was introduced by this feature", !/cc-told[\s\S]{0,400}\son[a-z]+=/.test(panels));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
