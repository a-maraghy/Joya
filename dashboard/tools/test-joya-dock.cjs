#!/usr/bin/env node
"use strict";
/**
 * M-5 part 1: JOYA AI's dock on every Joya page (lib/ui.js dockMarkup,
 * public/joya-dock.js, public/joya-dock.css). Static checks; the browser run
 * is Playwright on a scratch stack.
 *
 *     node dashboard/tools/test-joya-dock.cjs
 */
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const ui = require(path.join(ROOT, "lib", "ui.js"));
const UA = require(path.join(ROOT, "public", "ui-actions.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}
const permOf = (list) => ({ can: (p) => list === "*" || list.includes(p), canDash: () => true });
// voice: the dock's mic -- voice on, a key and voice.use (server.js ctx(): req.voiceMic)
const render = (perms, extra, voiceOk) => ui.shell("Test", "<p>body</p>", Object.assign({ user: { name: "demo-admin", perm: permOf(perms), voice: voiceOk !== false }, csrf: "demo-csrf-token", active: "home" }, extra || {}));
const renderCore = (core) => ui.shell("Test", "<p>body</p>", { user: { name: "demo-admin", perm: permOf("*"), voice: true, core }, csrf: "demo-csrf-token", active: "home" });

console.log("where the dock appears");
{
  const all = render("*");
  check("on an ordinary page for someone who may use JOYA AI", /id="joya-dock-root"/.test(all));
  check("  with its three assets", ["joya-dock.css", "ui-actions.js", "joya-dock.js"].every((f) => all.includes("/" + f) || new RegExp(f.replace(".", "\\.") + "(\\?|\")").test(all)));
  check("  hidden until its script runs (no dock without JavaScript)", /<div class="md-root" id="joya-dock-root"[^>]* hidden>/.test(all));
  check("  carrying the CSRF token for its posts", /data-csrf="demo-csrf-token"/.test(all));
  check("  mic, orb, state, expand; every link goes to the Command Center", /id="md-mic"/.test(all) && /id="md-orb"[^>]*|href="\/joya-ai"[^>]*id="md-orb"/.test(all) && (all.match(/href="\/joya-ai"/g) || []).length >= 3);
  const quiet = render("*", null, false);
  check("  no mic at all when voice is off for this viewer (off, no key, or no voice.use): orb, state, expand only", /id="joya-dock-root"/.test(quiet) && !/id="md-mic"/.test(quiet) && !/hold to talk|mic starts a live call/.test(quiet));
  check("  the mic starts a live conversation (no hold to talk)", /id="md-mic" aria-label="Start a live conversation"/.test(all) && !/Hold to talk|hold to talk/.test(all));
  check("not for a role without joyaai.use", !/joya-dock-root/.test(render(["os.view"])) && !/joya-dock\.js/.test(render(["os.view"])));
  check("not on the Command Center (the bare page: it is JOYA AI already)", !/joya-dock-root/.test(render("*", { bare: true, active: "joya-ai" })) && !/dock-band/.test(render("*", { bare: true, active: "joya-ai" })));
  check("  opts.dash is ignored (no dashboard switches the dock off any more)", /joya-dock-root/.test(render("*", { dash: "console", active: "console" })));
  check("not when a page opts out (dock: false)", !/joya-dock-root/.test(render("*", { dock: false })));
  check("not signed out", !/joya-dock-root/.test(ui.shell("Sign in", "<div class=\"card\">x</div>", {})));
  check("the Command Center route renders its page bare, as the joya-ai item", /active: "joya-ai",\s*bare: true/.test(fs.readFileSync(path.join(ROOT, "lib", "views-joyaai.js"), "utf8")));
  check("the dock sits in its band under the content column (with-dock on <html>, .dock-band before the dock)", /<html lang="en" class="framed with-dock">/.test(all) && all.indexOf('class="dock-band"') > 0 && all.indexOf('class="dock-band"') < all.indexOf("joya-dock-root"));
  check("  no band and no with-dock without the dock", !/with-dock|dock-band/.test(render(["os.view"])) && !/with-dock|dock-band/.test(render("*", { dock: false })));
}

console.log("\nthe role decides where page.open may go (before moving)");
{
  const pagesOf = (html) => (/data-pages="([^"]*)"/.exec(html.slice(html.indexOf("joya-dock-root"))) || [])[1].split(" ");
  const lim = pagesOf(render(["os.view", "joyaai.use"]));
  check("a limited role: only the pages it can see (and guide, account, your devices, the Command Center and its Settings)", lim.sort().join() === ["os", "devices", "guide", "account", "cc", "settings"].sort().join(), lim.join());
  const full = pagesOf(render("*"));
  check("an administrator: every entry of the page map in use (the built-in pages before a scan)", full.join() === Object.keys(UA.pages()).join() && full.length === Object.keys(UA.BUILTIN_PAGES).length, full.join());
  const all = render("*");
  const mapJson = (/data-page-map="([^"]*)"/.exec(all) || [])[1] || "[]";
  const map = JSON.parse(mapJson.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  check("the dock also carries the map (data-page-map JSON: key, url, label, perm) for UiActions.setPages", map.length === full.length && map.every((e) => e.key && /^\//.test(e.url) && e.label && "perm" in e));
}

console.log("\nno inline code (the CSP forbids it)");
{
  const html = render("*");
  const dock = html.slice(html.indexOf('<div class="md-root"'));
  check("no style= and no on*= in the dock's markup", !/\sstyle=|\son[a-z]+=/.test(dock.slice(0, dock.indexOf("</div>\n</div>") + 20)));
  check("no inline <script> in the dock", !/<script>/.test(dock));
}

console.log("\npublic/joya-dock.js");
{
  const js = fs.readFileSync(path.join(ROOT, "public", "joya-dock.js"), "utf8");
  const code = js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("no eval, no new Function, no document.write", !/\beval\(|new Function|document\.write/.test(code));
  check("innerHTML only for the escaped «You: …» line and the reply card's body (the Command Center's markdown, which escapes first)", (code.match(/innerHTML/g) || []).length === 2 && /innerHTML = st\.you \? "You: <b>" \+ esc\(st\.you\)/.test(code) && /body\.innerHTML = o\.html \|\| ""/.test(code));
  check("its posts carry the CSRF header", /"X-CSRF-Token": CSRF/.test(code));
  check("the tab's id is the Command Center's (sessionStorage joya-tab), so JOYA AI's screen actions reach this tab", /sessionStorage\.getItem\("joya-tab"\)/.test(code) && /events\?tab=/.test(code) && /tab: TAB_ID/.test(code));
  check("the mic starts a live call in the Command Center, this page kept in its frame (no push to talk here)", /location\.assign\("\/joya-ai\?at=" \+ encodeURIComponent\(here\) \+ "&call=1"\)/.test(code) && !/api\("transcribe"|MediaRecorder|getUserMedia/.test(code));
  check("page.open: the role is checked (data-pages) before moving, and a refusal is answered and shown", /PAGES_OK\.indexOf\(" " \+ v\.args\.page \+ " "\) < 0/.test(code) && /their role cannot open/.test(code) && /your role cannot see it/.test(code));
  check("page.open leaves a note for the next page (Undo) and moves by a known key only", /sessionStorage\.setItem\("joya-opened"/.test(code) && /location\.assign\(np\.url\)/.test(code) && !/location\.assign\(v\.args/.test(code));
  check("Undo returns only to a path of this site", /\^\\\/\[A-Za-z0-9\/_-\]\*\$/.test(code));
  check("a Tier-2 change is withdrawn here (cancel), never applied", /api\("ui\/confirm", \{ id: ev\.confirm, decision: "cancel" \}\)/.test(code) && !/decision: "confirm"/.test(code));
  check("anything else is refused: it needs the Command Center", /needs the Command Center open/.test(code));
  check("no live call of its own (the Command Center holds it; in the shell the mic is the Command Center's)", !/voice\/live|getUserMedia/.test(code) && /window\.__joyaLive/.test(code));
  check("the core pauses when the tab is hidden, and draws one still frame under reduced motion", /document\.hidden/.test(code) && /prefers-reduced-motion: reduce/.test(code) && /if \(reduced\) \{ t = 2\.4; drawOrb\(\); if \(meshCore\) meshCore\.start\(\); \}/.test(code));
  check("core D: the dock root says D and joya-core-d.js loads before joya-dock.js; with C neither", /id="joya-dock-root" data-core="D"/.test(renderCore("D")) && renderCore("D").indexOf("joya-core-d.js") > 0 && renderCore("D").indexOf("joya-core-d.js") < renderCore("D").indexOf("joya-dock.js") && /data-core="dots"/.test(renderCore("C")) && !/joya-core-d\.js/.test(renderCore("C")));
  check("core D (the default): the dock draws the mesh at dock size (joya-core-d.js, loaded before joya-dock.js), the dotted 2D core otherwise", /root\.getAttribute\("data-core"\) === "D" && window\.JoyaCoreD/.test(code) && /meshCore\.resize\(34, 34, meshCore\.S\.concept === "E" \? 27 : 21, 68, 68\)/.test(code) && /dockCoreD \? \["joya-core-d\.js"\] : \[\], dockCoreE \? \["cc-logic\.js", "joya-core-bot\.js"\] : \[\], \["joya-dock\.js"\]/.test(fs.readFileSync(path.join(ROOT, "lib", "ui.js"), "utf8")) && /data-core="\$\{opts\.core === "D" \|\| opts\.core === "E" \? opts\.core : "dots"\}"/.test(fs.readFileSync(path.join(ROOT, "lib", "ui.js"), "utf8")));
  check("core E (the bot): the dock draws the viewer's bot head (joya-core-bot.js, with its head, face and colours from data-bot-head / data-bot-face / data-bot-colors)", /root\.getAttribute\("data-core"\) === "E" && window\.JoyaCoreBot/.test(code) && /head: root\.getAttribute\("data-bot-head"\)/.test(code) && /data-bot-head="\$\{esc\(opts\.botHead \|\| ""\)\}" data-bot-face="\$\{esc\(opts\.botFace \|\| "smooth"\)\}" data-bot-colors=/.test(fs.readFileSync(path.join(ROOT, "lib", "ui.js"), "utf8")));
  check("no Space to talk (it went with push to talk)", !/"Space"/.test(code));
}

console.log("\npublic/joya-dock.css");
{
  const css = fs.readFileSync(path.join(ROOT, "public", "joya-dock.css"), "utf8");
  check("tokens for light, system-dark and forced dark", /:root \{/.test(css) && /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/.test(css) && /:root\[data-theme="dark"\]/.test(css));
  check("a phone layout, reduced motion, and hidden in print", /@media \(max-width: 600px\)/.test(css) && /prefers-reduced-motion: reduce/.test(css) && /@media print \{ \.md-root \{ display: none; \} \}/.test(css));
  check("every rule is its own (md- prefix): it cannot restyle the Command Center", css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.split("{")[0].trim()).filter((sel) => sel && !/^@|^:root|^from|^to|^\d+%|^50%/.test(sel)).every((sel) => sel.split(",").every((x) => /\.md-/.test(x))));
}

console.log("\nthe Command Center as a shell (M-5 part 2)");
{
  const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  check("CSP: frame-ancestors 'self' (a same-origin frame only), never 'none' or a host", /frameAncestors: \["'self'"\]/.test(server) && !/frameAncestors: \["'none'"\]/.test(server));
  check("  X-Frame-Options stays helmet's SAMEORIGIN (frameguard not switched off)", !/frameguard:\s*false/.test(server) && !/xFrameOptions:\s*false/.test(server));
  const shellDock = ui.dockMarkup("demo-csrf-token", permOf("*"), { shell: true });
  check("the shell's dock: data-shell, a frame named joya-frame (hidden), the flight canvas, an end-call button; hidden until a page is up", /data-shell="1"/.test(shellDock) && /<iframe class="md-frame" id="md-frame" name="joya-frame" title="Joya page" hidden><\/iframe>/.test(shellDock) && /id="md-hero"/.test(shellDock) && /id="md-end"/.test(shellDock) && /class="md-dock off"/.test(shellDock));
  check("  the frame has no sandbox and no src until a page opens", !/sandbox|md-frame"[^>]*src=/.test(shellDock));
  const pageDock = ui.dockMarkup("demo-csrf-token", permOf("*"));
  check("  an ordinary page's dock has none of that", !/md-frame|md-hero|md-end|data-shell/.test(pageDock));
  const vsrc = fs.readFileSync(path.join(ROOT, "lib", "views-joyaai.js"), "utf8");
  check("the Command Center page renders the shell's dock and loads joya-dock.css/js and joya-shell.js after joya-ai.js", /dockMarkup\(o\.csrf, perm, \{ shell: true, noVoice: !vOk, core, botHead: logic\.normBotHead\(o\.botHead\), botColors: logic\.botColorsJson\(o\.botColors\), botFace: logic\.normBotFace\(o\.botFace\) \}\)/.test(vsrc) && /"joya-ai\.js", "joya-dock\.js", "joya-shell\.js"\]/.test(vsrc) && /"joya-dock\.css"/.test(vsrc));
  const sh = fs.readFileSync(path.join(ROOT, "public", "joya-shell.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("joya-shell.js: only paths of this site open in the frame (not /joya-ai, /login, /logout, the API, //host)", /x\.origin !== ORIGIN/.test(sh) && /\/\^\\\/\(\?!\\\/\)\//.test(sh) && /logout\|login\|joya-ai\\\/api/.test(sh) && /isCC\(x\.pathname\)/.test(sh));
  check("  messages only from this origin and from the frame's own window; posts only to this origin", /e\.origin !== ORIGIN \|\| e\.source !== frame\.contentWindow/.test(sh) && /postMessage\(\{ joya: "theme", theme: [^}]*\}, ORIGIN\)/.test(sh) && !/postMessage\([^)]*"\*"\)/.test(sh));
  check("  history: an entry per switch (/joya-ai?at=... and /joya-ai), popstate follows, the address follows moves inside the frame", /history\.pushState\(\{ joya: "frame"/.test(sh) && /history\.pushState\(\{ joya: "cc" \}, "", "\/joya-ai"\)/.test(sh) && /addEventListener\("popstate"/.test(sh) && /history\.replaceState\(\{ joya: "frame", url: p \}/.test(sh));
  check("  a deep link (?at=) opens straight onto the page, back lands on the Command Center", /get\("at"\)/.test(sh) && /open\(deep, \{ instant: true \}\)/.test(sh));
  check("  the Command Center under a page is inert and its core stopped; restored on the way back", /setAttribute\("inert", ""\)/.test(sh) && /removeAttribute\("inert"\)/.test(sh) && /coreStop\(\)/.test(sh) && /coreStart\(\)/.test(sh));
  check("  every flight style is cleared on landing (the Command Center looks as before)", /setOp\(cc, ""\); setOp\(frame, ""\); setOp\(dockEl, ""\);/.test(sh) && /html\.classList\.remove\("md-flying"\)/.test(sh));
  check("  reduced motion: no flight", /if \(reduced \|\| o\.instant\)/.test(sh));
  const cd = fs.readFileSync(path.join(ROOT, "public", "joya-core-d.js"), "utf8"), dcss = fs.readFileSync(path.join(ROOT, "public", "joya-dock.css"), "utf8");
  check("  core D: the mesh itself flies -- a core D on a canvas made for the flight, driven by the flight's frame (place / tick)", /function coreIsD\(\)/.test(sh) && /\(E \? window\.JoyaCoreBot : window\.JoyaCoreD\)\(heroCv, \{/.test(sh) && /heroD\.place\(q\.cx, q\.cy, q\.R\);\s*heroD\.tick\(dt\);/.test(sh) && /place: function \(cx, cy, R\)/.test(cd) && /tick: function \(dt\)/.test(cd));
  check("  …adopting the running core's state and phases at take-off and handing them on at landing (dock going down, Command Center coming up)", /heroD\.adopt\(src\)/.test(sh) && /dst\.adopt\(heroD\)/.test(sh) && /meshDown\(D\(\)\.mesh \? D\(\)\.mesh\(\) : null\)/.test(sh) && /meshDown\(c && c\.core\)/.test(sh) && /adopt: function \(o\)/.test(cd) && /api_\.mesh = function \(\) \{ return meshCore; \}/.test(fs.readFileSync(path.join(ROOT, "public", "joya-dock.js"), "utf8")));
  check("  …one context drawing: the Command Center's core stops for the flight, the flight's context is freed on landing, the dock's mesh hides in flight", /if \(mesh\) coreStop\(\);/.test(sh) && /heroD\.destroy\(\)/.test(sh) && /html\.md-fly-mesh #md-orb-c \{ visibility: hidden; \}/.test(dcss) && /html\.classList\.remove\("md-fly-mesh"\)/.test(sh));
  check("  A/B/C (or no WebGL2) keep the dotted 2D flight", /if \(heroD\) \{[\s\S]*?\} else \{\s*g\.setTransform[\s\S]*?drawCore\(/.test(sh) && /if \(!heroD\.isGL && !E\) \{ meshDown\(\); return false; \}/.test(sh));
  check("  core E: the bot flies the same way (its 2D renderer too), landing on the dock bot's size", /function coreIsE\(\)/.test(sh) && /if \(coreIsD\(\) \|\| coreIsE\(\)\) \{/.test(sh) && /var dR = dm\.S && dm\.S\.concept === "E" \? 27 : 21;/.test(sh));
  check("  no live call is stopped by opening a page", !/VoiceLive\.stop|liveStop/.test(sh));
  const cc = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("joya-ai.js: page.open opens in the shell (Undo = back) and falls back to the old whole-tab move only without it", /window\.JoyaShell && window\.JoyaShell\.open\(np\.url\)\) \{ undo = function \(\) \{ window\.JoyaShell\.back\(\); \}/.test(cc) && /if \(!pageOpenSoon\(a\.page, np\)\) return \{ ok: false/.test(cc));
  const pos = cc.slice(cc.indexOf("function pageOpenSoon"), cc.indexOf("function uiToast"));
  check("  pageOpenSoon never ends a call, and never moves the tab while a call is on or the shell is here (a link instead)", pos.length > 200 && !/VoiceLive\.stop|liveStop/.test(pos) && /if \(liveActive\(\) \|\| window\.JoyaShell\) \{ uiToast\(np\.label/.test(pos));
  check("  anything but the call, page.open and a Tier-2 ask brings the Command Center back first", /shellUp\(\) && v\.tier !== 2 && \["call\.end", "call\.mute", "call\.interrupt", "page\.open"\]\.indexOf\(v\.action\) < 0\) window\.JoyaShell\.expand\(\)/.test(cc));
  check("  its notes go to the dock while a page is up, and it feeds the dock its state", /if \(shellUp\(\)\) return window\.JoyaShell\.toast/.test(cc) && /window\.JoyaShell\.feed\(\{ state: st/.test(cc));
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const br = app.slice(app.indexOf("The bridge to the Command Center's shell"));
  check("app.js bridge: only when framed by the shell (same origin, parent is top)", /window\.top !== window && window\.parent === window\.top && window\.top\.location\.origin === location\.origin && window\.top\.JoyaShell/.test(br) && /if \(!parent\) return;/.test(br));
  check("  breaks out when signed out, on logout, and for the Command Center itself", /\.auth-wrap/.test(br) && /parent\.location\.replace/.test(br) && /form\[action="\/logout"\]/.test(br) && /\.target = "_top"/.test(br) && /send\(\{ joya: "expand" \}\)/.test(br));
  check("  sends where it is and theme changes (no Space to talk any more); takes the theme only from its parent", /send\(\{ joya: "nav" \}\)/.test(br) && !/joya: "space"/.test(br) && /e\.origin !== ORIGIN \|\| e\.source !== parent/.test(br) && /parent\.postMessage\(m, ORIGIN\)/.test(br));
  const dj = fs.readFileSync(path.join(ROOT, "public", "joya-dock.js"), "utf8");
  check("joya-dock.js: none of its own inside the frame; in the shell no stream or recorder of its own", /if \(framed\) \{ root\.remove\(\); return; \}/.test(dj) && /if \(!SHELL\) \{\s*var drv = pageDriver\(\);/.test(dj));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
