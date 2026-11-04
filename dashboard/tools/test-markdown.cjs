/**
 * Tests for the console's markdown renderer.
 *
 *     node dashboard/tools/test-markdown.cjs dashboard/public/console.js
 *
 * The renderer is pulled out of console.js and run here rather than duplicated,
 * so this tests the code that ships.
 *
 * The cases that matter are the escaping ones. This renderer displays the
 * contents of files the model has just read, which is about the least trusted
 * input a page can have: anything that turns a quoted <script> into a real one
 * is the bug worth catching, and the reason the renderer escapes first and
 * formats second rather than the other way round.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
const fs = require("fs");

const path = require("path");
const target = process.argv[2] || path.join(__dirname, "..", "public", "console.js");
const src = fs.readFileSync(target, "utf8");
// Keep the closing "})()" but not the statement's semicolon, so the slice is a
// bare expression the wrapping parentheses can accept.
const start = src.indexOf("var MD = (function");
const end = src.indexOf("})();", start) + 4;
const MD = eval("(" + src.slice(start + "var MD = ".length, end) + ")");

let failures = 0;
function check(name, input, mustContain, mustNotContain) {
  const out = MD(input);
  const ok =
    (mustContain || []).every((s) => out.includes(s)) &&
    (mustNotContain || []).every((s) => !out.includes(s));
  if (!ok) {
    failures++;
    console.log("FAIL " + name);
    console.log("   in : " + JSON.stringify(input));
    console.log("   out: " + out);
  } else {
    console.log("ok   " + name);
  }
}

check("bold", "**Listening ports**: 22", ["<strong>Listening ports</strong>"], ["**"]);
check("inline code", "check `systemctl status` now", ["<code>systemctl status</code>"], ["`"]);
check("bullets", "- one\n- two", ["<ul>", "<li>one</li>", "<li>two</li>"]);
check("numbered", "1. first\n2. second", ["<ol>", "<li>first</li>"]);
check("heading", "## Flagged issues", ["<h3>Flagged issues</h3>"]);
check("fence", "```\nrm -rf /\n```", ["<pre><code>rm -rf /</code></pre>"]);
check("paragraphs", "one\n\ntwo", ["<p>one</p>", "<p>two</p>"]);
check("link", "see [docs](https://example.com/x)", [
  '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">docs</a>',
]);

/* --- the ones that actually matter ------------------------------------- */
check(
  "script tag is text",
  "<script>alert(1)</script>",
  ["&lt;script&gt;"],
  ["<script>"]
);
check(
  "img onerror is text",
  '<img src=x onerror="alert(1)">',
  ["&lt;img"],
  ["<img"]
);
check(
  "html inside a fence stays text",
  "```\n<script>alert(1)</script>\n```",
  ["&lt;script&gt;"],
  ["<script>"]
);
check(
  "markup inside inline code stays text",
  "run `<b>hi</b>` please",
  ["<code>&lt;b&gt;hi&lt;/b&gt;</code>"],
  ["<b>hi</b>"]
);
check(
  "javascript: link is not linkified",
  "[click](javascript:alert(1))",
  [],
  ["<a href"]
);
check(
  "quote attribute cannot break out of href",
  '[x](https://e.com/"onmouseover="alert(1))',
  [],
  ['onmouseover="alert']
);
check(
  "asterisks inside code are not emphasis",
  "`a * b * c`",
  ["<code>a * b * c</code>"],
  ["<em>"]
);
check(
  "digits around a code span survive",
  "set it to `5` in 1 of 2 places",
  ["<code>5</code>", "1 of 2 places"]
);
check("plain text with asterisk is untouched", "2 * 3 = 6", ["2 * 3 = 6"], ["<em>"]);

console.log(failures ? "\nFAILURES: " + failures : "\nALL MARKDOWN TESTS PASSED");
process.exit(failures ? 1 : 0);
