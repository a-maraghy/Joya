/**
 * Tests for the JOYA AI Command Center page: the server-rendered frame
 * (lib/views-joyaai.js), the shell changes it relies on (lib/ui.js), the tab's
 * permission, and the pure helpers inside public/joya-ai.js.
 *
 *     node dashboard/tools/test-joyaai-page.cjs
 *
 * What matters most here is what the Content-Security-Policy would silently
 * break and what an attacker-controlled string could do: the page must carry no
 * inline script, no inline handler and no inline style (style-src 'self' and
 * script-src-attr 'none' refuse them without an error anyone would notice),
 * and every server-side value must arrive escaped.
 *
 * The client helpers are cut out of joya-ai.js and run here rather than copied,
 * so this tests the code that ships -- the same approach as test-markdown.cjs.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
const ui = require(path.join(ROOT, "lib", "ui.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));

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

/* ------------------------------------------------------------ the frame --- */

const EVIL = `<img src=x onerror=alert(1)>"'&`;
const admin = rbac.actor({ permissions: ["*"] });
const html = views.page({
  csrf: `tok"en<`,
  user: { name: EVIL, roleLabel: "Administrator", perm: admin, dash: "console" },
  voice: { configured: true, voice: `v-${EVIL}`, model: "gpt-realtime-2.1-mini", manage: true, on: true, use: true, live: true },
});

check("renders a whole page", html.startsWith("<!doctype html>") && html.includes("</html>"));
check("html carries the page class", /<html lang="en" class="cc-page">/.test(html));
check("no inline <script> bodies", !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html));
// Quoted attribute values are emptied first: the escaped viewer name sits in
// data-viewer as text, which is harmless and not an attribute of its own.
check("no inline event handlers on any tag", !/<[a-z][^>]*\son[a-z]+\s*=/i.test(html.replace(/"[^"]*"/g, '""')));
check("no inline style attributes", !/\sstyle\s*=/i.test(html));
check("no <style> blocks", !/<style[\s>]/i.test(html));
check("no external URLs in src or href", !/(src|href)="(https?:)?\/\//i.test(html));
check("viewer name is escaped", !html.includes(EVIL) && html.includes("&lt;img src=x onerror=alert(1)&gt;"));
check("csrf token is escaped in the data attribute", html.includes('data-csrf="tok&quot;en&lt;"'));
check("voice name is escaped", !html.includes(`v-${EVIL}`) && html.includes("v-&lt;img"));
check("loads the theme script before the stylesheet", html.indexOf("theme-init.js") > -1 && html.indexOf("theme-init.js") < html.indexOf("style.css"));
check("theme script is blocking (not deferred)", /<script src="\/static\/theme-init\.js\?v=[^"]+"><\/script>/.test(html));
check("loads its own stylesheet and deferred script", /joya-ai\.css\?v=/.test(html) && /<script src="\/static\/joya-ai\.js\?v=[^"]+" defer>/.test(html));
check("offers System, Dark and Light", ["system", "dark", "light"].every((t) => html.includes(`data-theme-opt="${t}"`)));
check("System is the default choice", /data-theme-opt="system" aria-checked="true"/.test(html));
check("every icon reference has a symbol", (() => {
  const used = new Set([...html.matchAll(/href="#cc-i-([a-z]+)"/g)].map((m) => m[1]));
  for (const f of ["joya-ai.js", "cc-panels.js"]) {
    const js = fs.readFileSync(path.join(ROOT, "public", f), "utf8");
    for (const m of js.matchAll(/ic\("([a-z0-9]+)"/g)) used.add(m[1]);
    for (const m of js.matchAll(/ic\(o\.it\.icon\)|icon: "([a-z0-9]+)"/g)) if (m[1]) used.add(m[1]);
  }
  const missing = [...used].filter((n) => !views.SPRITE[n]);
  return missing.length === 0 || (console.log("   missing:", missing.join(", ")), false);
})());
check("the Command Center's sidebar item is current and points at /joya-ai (no top-bar tabs)", /<a href="\/joya-ai" class="side-item on" aria-current="page"/.test(html) && !/class="top-tab/.test(html));
check("the sidebar is rendered here too, as a drawer the rail's ☰ opens", html.includes('class="sidebar"') && /<div class="layout bare">/.test(html) && /id="os-scrim"[^>]*data-os-close/.test(html));
check("  the rail's #cc-os-btn (data-os-toggle) sits right after the search button", /<button[^>]*class="cc-os-btn" id="cc-os-btn" data-os-toggle aria-controls="sidebar"/.test(html) && /<button type="button" id="cc-kbtn"[^>]*>[\s\S]{0,1500}?<\/button><span class="sep" aria-hidden="true"><\/span><button type="button" class="cc-os-btn" id="cc-os-btn"/.test(html));
check("  and the top bar's ☰ toggles the same drawer (data-os-toggle, not the phone nav)", /<button class="nav-toggle"[^>]*data-os-toggle>/.test(html));
check("no dock band on the Command Center (its dock is the shell's own)", !/class="dock-band"/.test(html) && !/<html[^>]*with-dock/.test(html));
check("console.js is the Command Center's own, loaded before joya-ai.js", /console\.js\?v=/.test(html) && html.indexOf("console.js?v=") < html.indexOf("joya-ai.js?v="));
check("every id is unique", (() => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  return ids.length === new Set(ids).size;
})());
check("a page without an OpenAI key (voice on) has no mic, and points a manager to Settings ▸ Voice", (() => {
  const p = views.page({ csrf: "t", user: { name: "a", perm: admin }, voice: { configured: false, manage: true, on: true, use: true, live: false } });
  return !/id="cc-c-mic"/.test(p) && /id="cc-mic-off"[^>]*title="Voice is off: add an OpenAI token in JOYA AI Settings ▸ Voice"/.test(p) && /data-voice-off="Voice is off: add an OpenAI token in JOYA AI Settings ▸ Voice"/.test(p);
})());

/* ----------------------------------------------------------- the shell --- */

const plain = ui.shell("X", "<p>body</p>", { user: { name: "u", perm: admin }, csrf: "c" });
// Framed pages carry only the frame marker (the fixed top bar and sidebar);
// the Command Center's own palette class stays on the Command Center.
check("other pages keep no page class but the frame's (and the dock's band)", /<html lang="en" class="framed with-dock">/.test(plain) && !plain.includes("cc-page"));
check("every page loads style.css, os.css, joya-ai.css and joya-os.css, in that order", ["style.css", "os.css", "joya-ai.css", "joya-os.css"].map((f) => plain.indexOf("/static/" + f + "?v=")).every((i, n, a) => i > 0 && (n === 0 || i > a[n - 1])));
check("console.js is no longer a global script", !/console\.js/.test(plain));
check("every page loads the theme script before its stylesheet", plain.indexOf("theme-init.js") > -1 && plain.indexOf("theme-init.js") < plain.indexOf("style.css"));
check("every signed-in page carries the theme switch", plain.includes("data-theme-switch") && ["system", "dark", "light"].every((t) => plain.includes(`data-theme-opt="${t}"`)));
check("the signed-out page has no switch (no top bar at all)", !ui.shell("Sign in", "<form></form>", {}).includes("data-theme-switch"));
check("assets outside public/ are refused", !ui.page("x", "", { assets: ["../server.js", "a b.js", "evil.css?x"] }).includes("server.js"));
check("a page class with markup is refused", !ui.page("x", "", { pageClass: 'a" onload="x' }).includes("onload"));

/* ----------------------------------------------------------- the tab --- */

check("joyaai.use alone reveals the JOYA AI tab", rbac.actor({ permissions: ["joyaai.use"] }).canDash("console"));
check("console.use is gone with the classic chat (2026-10-25): it reveals nothing", !rbac.actor({ permissions: ["console.use"] }).canDash("console") && !rbac.ALL_PERMISSIONS.includes("console.use") && !rbac.ALL_PERMISSIONS.includes("console.full") && rbac.RETIRED.join() === "console.use,console.full");
check("a viewer without either does not see it", !rbac.actor({ permissions: ["os.view"] }).canDash("console"));
check("the Command Center item's href is /joya-ai, first in the JOYA AI group", ui.NAV[0].key === "joya-ai" && ui.NAV[0].items[0].key === "joya-ai" && ui.NAV[0].items[0].href === "/joya-ai" && ui.NAV[0].items[0].perm === "joyaai.use");

/* ------------------------------------------------- server wiring (source) --- */

const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
check("no route takes a large body any more: one 64 KB JSON parser for all (the console's upload went with it)", !/PAYLOAD_ROUTES/.test(server) && /app\.use\(express\.json\(\{ limit: "64kb" \}\)\);/.test(server) && !/app\.post\("\/joya-ai\/api\/transcribe"/.test(server));
check("/joya-ai is behind requireAuth", /app\.get\("\/joya-ai", requireAuth,/.test(server));
check("/joya-ai checks joyaai.use", /app\.get\("\/joya-ai"[\s\S]{0,400}can\("joyaai\.use"\)/.test(server));
check("speak needs the permission (joyaai.use and voice.use) and CSRF", /app\.post\("\/joya-ai\/api\/speak", \.\.\.joyaAiWrite, requireApiPerm\("voice\.use"\),/.test(server));
check("/console only redirects to the Command Center (its handlers were removed)", /app\.all\(\/\^\\\/console\(\?:\\\/\|\$\)\/, \(req, res\) => res\.redirect\(302, "\/joya-ai"\)\);/.test(server) && !/requirePerm\("console\.use"\)/.test(server) && !fs.existsSync(path.join(ROOT, "lib", "views-console.js")));
check("/joya-ai no longer bounces a console.use-only role to /console", !/redirect\("\/console"\)/.test(server));

/* ------------------------------------------------ client helpers (source) --- */

const client = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");

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
const sandbox = {};
vm.runInNewContext(["esc", "modelLabel", "dur", "clip", "firstLine", "speakable", "nonSpace", "offsetAfter", "pieces"].map(cut).join("\n"), sandbox);

check("esc escapes the five", sandbox.esc(`<a href="x" onclick='y'>&</a>`) === "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
check("esc of null is empty", sandbox.esc(null) === "" && sandbox.esc(undefined) === "");
check("model label: opus 5.5", sandbox.modelLabel("claude-opus-5-5") === "Opus 5.5");
check("model label: dated haiku keeps no date", sandbox.modelLabel("claude-haiku-4-5-20251001") === "Haiku 4.5");
check("model label: sonnet 5", sandbox.modelLabel("claude-sonnet-5") === "Sonnet 5");
check("durations read like a person would say them", sandbox.dur(4000) === "4s" && sandbox.dur(108000) === "1m 48s" && sandbox.dur(3900000) === "1h 05m");
check("no duration is a dash", sandbox.dur(null) === "—");
check("clip adds an ellipsis only when it cuts", sandbox.clip("abcdef", 4) === "abc…" && sandbox.clip("abc", 4) === "abc");
check("first line skips blank lines", sandbox.firstLine("\n\n  \nhello\nworld") === "hello");
check("speech drops code blocks and links", (() => {
  const s = sandbox.speakable("Run `ls` then:\n```\nrm -rf /\n```\nsee https://example.com/x and [the docs](https://d)");
  return !s.includes("rm -rf") && s.includes("(code)") && s.includes("a link") && s.includes("the docs") && !s.includes("`");
})());
check("sentences come out whole and the rest waits", (() => {
  const r = sandbox.pieces("One. Two! Three", false);
  return r.list.join("|") === "One.|Two!" && r.consumed === "One. Two!".length;
})());
check("a full stop inside a file name, a service or a number does not end a sentence", (() => {
  const r = sandbox.pieces("Open victim-ui.txt now. Version 2.5 of joya-ai.service is live. Next", false);
  return r.list.join("|") === "Open victim-ui.txt now.|Version 2.5 of joya-ai.service is live.";
})());
check("a line end ends a piece (bullets), a fenced block is never cut", (() => {
  const r = sandbox.pieces("- one\n- two\n```\nrm -rf /.\nls\n", false);
  return r.list.join("|") === "- one|- two" && r.consumed === "- one\n- two\n".length;
})());
check("the first piece of a reply may end at a clause, so the voice starts sooner", (() => {
  const r = sandbox.pieces("I looked at the dashboard logs for today, and nothing failed", true);
  return r.list.join("|") === "I looked at the dashboard logs for today," && !sandbox.pieces("Yes, it is.", true).list.includes("Yes,");
})());
check("the reading position survives the reply changing shape (deltas, then blocks)", (() => {
  const text = "One two.\n\nThree four. Five";
  return sandbox.offsetAfter(text, sandbox.nonSpace("One two. Three")) === text.indexOf("Three") + 5;
})());
check("a streamed markdown reply is read word for word, whatever the chunk size", (() => {
  const B1 = "Yes, I can hear you \u2014 loud and clear. I checked `joya-dashboard.service` and it is **running**.\n\n- The file `victim-ui.txt` is in /tmp/scratch.\n- Version 2.5 is live\n- No errors since 17:05";
  const B2 = "Next, I will restart the **allocation engine**, then report back. Done?";
  // Each piece is cleaned on its own, as the page does before asking for speech.
  const norm = (t) => sandbox.speakable(t).toLowerCase().replace(/[^a-z0-9.:\/\s-]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  const want = norm(B1 + "\n\n" + B2);
  return [1, 3, 7, 50, 1000].every((size) => {
    const said = [];
    let spoken = 0, blocks = [], partial = "";
    const ai = () => blocks.join("\n\n") + (partial ? (blocks.length ? "\n\n" : "") + partial : "");
    const feed = (text) => {
      const rest = text.slice(sandbox.offsetAfter(text, spoken));
      const f = sandbox.pieces(rest, spoken === 0);
      spoken += sandbox.nonSpace(rest.slice(0, f.consumed));
      said.push(...f.list);
    };
    // Block 1 streams with a leading newline its finished form lacks.
    for (const [b, lead] of [[B1, "\n"], [B2, ""]]) {
      const s = lead + b;
      for (let i = 0; i < s.length; i += size) { partial += s.slice(i, i + size); feed(ai()); }
      blocks.push(b); partial = ""; feed(ai());
    }
    const text = ai(), rest = text.slice(sandbox.offsetAfter(text, spoken)), f = sandbox.pieces(rest, spoken === 0);
    said.push(...f.list);
    if (rest.slice(f.consumed).trim()) said.push(rest.slice(f.consumed).trim());
    return said.map(norm).join(" ") === want;
  });
})());

/* The strings the client builds as markup must not carry inline style either:
   CSP refuses a style="" set through innerHTML just as it refuses one in the
   served page. */
// The page's three scripts: the main one and the two it loads beside it.
const clients = ["joya-ai.js", "cc-panels.js", "cc-map.js"].map((f) => [f, fs.readFileSync(path.join(ROOT, "public", f), "utf8")]);
for (const [f, src] of clients) {
  check(f + " builds no style attributes", !/style=\\?"/.test(src.replace(/\.style\./g, "")));
  check(f + " builds no inline handlers", !/\son(click|error|load|mouse\w+|key\w+)=/i.test(src));
  check(f + " talks only to this origin", !/(fetch|EventSource)\(\s*["']https?:/.test(src) && !/api\(\s*["']https?:/.test(src));
  check(f + " never writes a style attribute through setAttribute", !/setAttribute\(\s*["']style/.test(src));
}
check("the Remote Control link is only opened for claude.ai", /\^https:\\\/\\\/claude\\\.ai\\\//.test(client));
const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const initJs = fs.readFileSync(path.join(ROOT, "public", "theme-init.js"), "utf8");
check("the theme key is the same in theme-init.js and app.js", initJs.includes('"joya-theme"') && appJs.includes('"joya-theme"'));
check("the Command Center repaints on a theme change", appJs.includes('"joya-theme"') && /addEventListener\("joya-theme"/.test(client));
check("storage access is guarded (theme-init.js, app.js)", [initJs, appJs].every((src) => {
  const idx = [...src.matchAll(/localStorage\./g)].map((m) => m.index);
  return idx.length > 0 && idx.every((i) => src.lastIndexOf("try {", i) > src.lastIndexOf("}", i - 1) - 200 && src.lastIndexOf("try {", i) > -1);
}));
check("theme-init only accepts dark or light", /t === "dark" \|\| t === "light"/.test(initJs));

/* ---------------------------------------------------- the site palette --- */

const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
/** The rules, without comments and without the palette blocks at the top. */
const body = (() => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = noComments.indexOf(":root {");
  const media = noComments.indexOf("@media (prefers-color-scheme: dark)");
  let depth = 0, end = -1;
  for (let i = noComments.indexOf("{", media); i < noComments.length; i++) {
    if (noComments[i] === "{") depth++;
    else if (noComments[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return noComments.slice(0, start) + noComments.slice(end);
})();
const literals = (body.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((c) => c.toLowerCase() !== "#fff");
check("style.css rules use tokens, not literal colours (QR codes stay white)", literals.length === 0, literals.join(" "));
check("a dark palette exists, chosen and from the system", css.includes(':root[data-theme="dark"]') && /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/.test(css));
check("the dark palette sets every token the light one declares for colour", (() => {
  const light = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  const colourTokens = [...light.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{3,8}|rgba?\()/gi)].map((m) => m[1]);
  // The brand constants (Obsidian, Joya, Deep Teal, AI Violet, off-white) are
  // the same in both themes on purpose, and are declared once.
  const constants = ["--obsidian", "--joya", "--deep-teal", "--ai-violet", "--offwhite"];
  const missing = colourTokens.filter((t) => !constants.includes(t) && !dark.includes(t + ":"));
  return missing.length === 0 || (console.log("   not in dark:", missing.join(" ")), false);
})());
const ccCss = fs.readFileSync(path.join(ROOT, "public", "joya-ai.css"), "utf8");
// Its tokens are global now (every page carries its dialogs): on :root, light then dark, like style.css.
check("the Command Center's tokens are global on :root (light, forced dark, system dark), no longer :root.cc-page", /^:root \{/m.test(ccCss) && /^:root\[data-theme="dark"\] \{/m.test(ccCss) && /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/.test(ccCss) && !/^:root\.cc-page( |\[data-theme="dark"\] )\{/m.test(ccCss));
{
  // Global tokens must not redefine style.css's: that would restyle every page.
  const styleCss = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  const rootTokens = (css) => new Set([...css.matchAll(/(?:^|\n)\s*:root(?:\[data-theme="(?:dark|light)"\]|:not\(\[data-theme="light"\]\))?\s*\{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1])));
  const mine = rootTokens(ccCss), theirs = rootTokens(styleCss);
  const clash = [...mine].filter((t) => theirs.has(t));
  check("  and none of them redefines a style.css token", mine.size > 10 && clash.length === 0, clash.join(" "));
}
check("the Command Center no longer carries its own green palette: the Joya tokens come from style.css", !/--brand:\s*#47723e|--accent:\s*#8bd46a|--bg:\s*#0b0e0b/i.test(ccCss));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
