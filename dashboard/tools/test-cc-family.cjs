/**
 * The Command Center's family of spheres (public/cc-family.js) and its setting.
 *
 *     node dashboard/tools/test-cc-family.cjs
 *
 * Static and wiring checks; the behaviour (layout with no overlaps at
 * 1920/1440/1366/390, 1..7 sessions, both themes, frame time, birth,
 * dissolve, hover, click, reduced motion, sub-agents) is checked in the
 * browser on a scratch stack (scratchpad pw-spheres.cjs).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return console.log("  ok   " + name); }
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const fam = read("public/cc-family.js"), map = read("public/cc-map.js"), page = read("public/joya-ai.js"), css = read("public/joya-ai.css");
const server = read("server.js"), views = read("lib/views-joyaai.js"), settings = read("public/joya-settings.js");
const logic = require(path.join(ROOT, "public", "cc-logic.js"));

console.log("the setting");
check("two views, spheres by default; anything else is spheres", logic.normSessView("") === "spheres" && logic.normSessView("orbit") === "orbit" && logic.normSessView("x") === "spheres" && logic.isSessView("orbit") && !logic.isSessView("depth"));
check("stored on the user row like joya_core", /addColumn\("users", "sessions_view"/.test(read("lib/db.js")) && /setUserSessionsView/.test(read("lib/db.js")));
check("POST /joya-ai/api/prefs/sessions: CSRF'd (joyaAiWrite), validated, audited", /app\.post\("\/joya-ai\/api\/prefs\/sessions", \.\.\.joyaAiWrite/.test(server) && /isSessView\(view\)/.test(server) && /"account", `Sessions view \$\{was\} -> \$\{view\}/.test(server));
check("the sessions view is fixed to spheres: no control in Appearance, the stored column stays", /req\.body\.sessions_view/.test(server) && !/name="sessions_view"/.test(views + read("lib/routes-settings.js")) && /migration\.sessions_view_spheres/.test(read("lib/db.js")));
check("the page is rendered with data-sessview", /data-sessview="\$\{sessview\}"/.test(views) && /sessview: req\.me\.sessions_view/.test(server));
check("the canvas, the names and the card are in the page, and cc-family.js loads before cc-map.js", /id="cc-family"/.test(views) && /id="cc-kids"/.test(views) && /id="cc-kcard"/.test(views) && /"cc-family\.js", "cc-map\.js"/.test(views));

console.log("\nthe view");
check("CSP: no inline style attribute is ever written (CSSOM only)", !/style="/.test(fam) && !/setAttribute\("style"/.test(fam));
check("classic orbit hides the spheres; spheres hide the orbit", /\.cc-shell:not\(\[data-sessview="orbit"\]\) \.cc-orbit \{ display: none; \}/.test(css) && /\[data-sessview="orbit"\] \.cc-family/.test(css));
check("it rides the core's own frame and forwards delegations and replies", /family\.frame\(\)/.test(map) && /family\.send\(id\)/.test(map) && /family\.reply\(id\)/.test(map));
check("the core's delegation stream aims at the sphere", /var fp = family\.positions\(\);\s*if \(id && fp\[id\]\) \{ lastPos\[id\] = fp\[id\]; return fp\[id\]; \}/.test(map));
check("it stays clear of the top bar, caption, composer / voice bar, approval card, icon rail, reply, menus and an open sheet", ["top bar", "caption", "composer", "approval card", "icon rail", "reply", "menu"].every((n) => map.includes('"' + n + '"')) && /cc-sheet/.test(map));
check("hard guarantees every frame: her edge, the chrome, each other, the screen", /function guarantee\(live\)/.test(fam) && /herMin\(k, dy, hd\)/.test(fam) && /rects\.forEach\(function \(rc\) \{ var p = pen\(kidBox/.test(fam));
check("spheres stay above the message bar: a floor from the caption / composer band, used by the clamp, the drift ellipse and the audit", /L\.floor = f;/.test(fam) && /function yMax\(k\)/.test(fam) && /k\.y = clamp\(k\.y, L\.top \+ r \+ 30, yMax\(k\)\);/.test(fam) && /below the message bar/.test(fam));
check("prefers-reduced-motion: settled once, still frames", /prefers-reduced-motion: reduce/.test(fam) && /if \(reduced\) settle\(160\);/.test(fam) && /if \(!on \|\| reduced\) return;/.test(fam));
check("needs you (waiting) is amber with a badge; a finished one blooms and says done", /k\.st === "waiting" \? "needs you" : t < k\.doneUntil \? "done"/.test(fam) && /was === "working" && k\.st === "idle"\) \{ k\.bloom = 1/.test(fam));
check("birth from her, dissolve back into her; nothing here retires anything (no call, no fetch)", /form: born && !reduced \? 0 : 1/.test(fam) && /k\.dis = 0\.0001/.test(fam) && !/retire\w*\s*\(|hire\(|fetch\(|api\(/i.test(fam.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))); // M-6: it only offers a menu (opts.onMenu); the page retires, after consent
check("sub-agent specks from real sub-agent data (running ones, at most 6)", /Math\.min\(6, \(d\.subs \|\| \[\]\)\.length\)/.test(fam) && /a\.status !== "done" && a\.status !== "failed"/.test(page));
check("hover card: task, last message, tokens today; click / Enter opens the existing deep view", /<dt>Now<\/dt>/.test(fam) && /<dt>Last<\/dt>/.test(fam) && /<dt>Today<\/dt>/.test(fam) && /onOpen: function \(key\) \{ (if \(window\.JoyaStory && window\.JoyaStory\.openKey\(key\)\) return; )?if \(P && P\.openDeep && findSess\(key\)\) P\.openDeep\(key\)/.test(page));
check("names are buttons (keyboard) with an aria-label; the canvas is aria-hidden", /document\.createElement\("button"\)/.test(fam) && /setAttribute\("aria-label", line \+ "\. Open its conversation\."\)/.test(fam) && /class="cc-family" id="cc-family" aria-hidden="true"/.test(views));
check("an overlap audit and frame stats are exposed for the checks", /audit: function \(\)/.test(fam) && /stats: function \(\)/.test(fam));
check("real data only in the page: task from waiting_for / mission / delegation, last from its messages, size from today's tokens and delegations", /function familyNode\(s\)/.test(page) && /S\.inbound\.forEach/.test(page) && /s\.tokens_today && s\.tokens_today\.total/.test(page) && !/cost_today_usd_est/.test(page));

console.log("\nwith core D (the mesh)");
const coreD = read("public/joya-core-d.js");
check("the spheres become mesh replicas drawn by core D in ONE batch on its canvas (setMesh / meshKids), not 7 contexts", /setMesh: function \(yes\)/.test(fam) && /meshKids: function \(\)/.test(fam) && /if \(!mesh\) drawSphere\(PC,/.test(fam) && /kids: function \(\) \{ return family && family\.enabled\(\) \? family\.meshKids\(\) : null; \}/.test(map) && /gl\.drawArrays\(gl\.POINTS, 0, n \* KPER\)/.test(coreD) && (coreD.match(/getContext\("webgl2"/g) || []).length === 1);
check("the family moves before the core draws (beforeDraw), so meshes and names agree; never twice a frame", /beforeDraw: function \(\) \{ if \(family && family\.enabled\(\)\) family\.frame\(\); \}/.test(map) && /family\.enabled\(\) && !drawsKids\(\)\) family\.frame\(\)/.test(map) && /function drawsKids\(\) \{ return core\.S\.concept === "D" \|\| core\.S\.concept === "E"; \}/.test(map) && /if \(opts\.beforeDraw\) opts\.beforeDraw\(S, W\)/.test(coreD));
check("each sphere keeps its state in the mesh: tint, dim / shimmer (faster folds), amber, born / dissolving, catching a delegation", ["tint: tc.dark", "shimmer:", "amb:", "form: k.form", "dis: k.dis", "catchK:"].every((x) => fam.includes(x)) && /k\.fold \+= dt \* \(0\.05 \+ 0\.25 \* \(k\.st === "working"/.test(fam));
check("only with D and WebGL2, or E (its 2D renderer draws them too); A/B/C (or D without WebGL2) keep the dotted spheres", /family\.setMesh\(\(core\.S\.concept === "D" && core\.isGL\) \|\| core\.S\.concept === "E"\)/.test(map));

console.log("\nwith core E (the bot)");
const coreE = read("public/joya-core-bot.js");
check("the sessions become small bot heads drawn by core E on its canvas, from the same meshKids list (plus key / st / glow / bloom for the face)", /key: k\.id, st: k\.st, glow: k\.glow, bloom: k\.bloom/.test(fam) && /var list = opts\.kids \? opts\.kids\(\) : null;/.test(coreE) && (coreE.match(/getContext\("webgl2"/g) || []).length === 1);
check("each head's face and colour come from the session's state (JoyaLogic.botSessState): needs you, listening, speaking, a grin, thinking, ready", /function botSessState\(k\)/.test(read("public/cc-logic.js")) && /sessState\(k\)/.test(coreE));
check("born out of the core's dots, dissolving back into them (form / dis in the shader and the 2D renderer)", /if\(u_form<1\.0\)/.test(coreE) && /if\(u_dis>0\.0\)/.test(coreE) && /o\.form < 1 \|\| o\.dis > 0/.test(coreE));
check("cc-map hands E the viewer's head and colours, and the offline face", /head: botHead\(\), colors: botColors\(\)/.test(map) && /setBot: function \(head, colors\)/.test(map) && /setOffline: function \(on\)/.test(map));
check("reduced motion: a change redraws the core's still meshes", /if \(mesh && reduced && opts\.meshRedraw\) opts\.meshRedraw\(\);/.test(fam) && /meshRedraw: function \(\)/.test(map));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
