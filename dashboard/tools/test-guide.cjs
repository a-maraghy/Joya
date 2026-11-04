#!/usr/bin/env node
"use strict";
/**
 * Tests for Help ▸ Guide (lib/views-guide.js, public/guide.js).
 *
 *   NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-guide.cjs
 *
 * Renders the guide and checks: the fourteen sections are there, each with a
 * literal id in the source (the page registry scans for them), a "where" line
 * and a contents entry; the text says nothing about removed features; the old
 * detailed Telegram / memory material survived the rewrite; hosts are escaped;
 * the search script and stylesheet are loaded as external assets.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.JOYA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "guide-test-"));
const ROOT = path.join(__dirname, "..");
const lib = (m) => require(path.join(ROOT, "lib", m));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
}

const rbac = lib("rbac");
const views = lib("views-guide");
const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
const user = { name: "Ann", roleLabel: "Administrator", perm: admin, chrome: lib("chrome").forActor(admin, null) };

const IDS = ["around", "cc", "voice", "hire", "screen", "budget", "approvals", "briefs", "chatgpt", "computers", "agents", "memory", "machine", "access", "devices", "trouble", "where"];

const page = views.guide({ csrf: "c", user, publicHost: "h<x>", publicPort: 8443, sshHost: 'ssh"<b>' });
const src = fs.readFileSync(path.join(ROOT, "lib", "views-guide.js"), "utf8");

// The document column only: the shell around it (sidebar, top bar) is not the guide's text.
const docMain = (page.match(/<div class="doc-main">([\s\S]*)<\/div><aside class="doc-side">/) || [])[1] || "";
const side = (page.match(/<aside class="doc-side">([\s\S]*?)<\/aside>/) || [])[1] || "";
const visible = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const text = visible(docMain);

console.log("sections");
const sections = [...docMain.matchAll(/<section id="([a-z0-9-]+)" class="card gd">([\s\S]*?)<\/section>/g)].map((m) => ({ id: m[1], body: m[2] }));
check("seventeen guide sections, in order (Briefs, ChatGPT and Computers since 2026-10-25)", JSON.stringify(sections.map((s) => s.id)) === JSON.stringify(IDS), sections.map((s) => s.id).join(","));
IDS.forEach((id) => check(`#${id} is a literal section id in the source`, src.includes(`<section id="${id}" class="card gd">`)));
const allIds = [...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dup = allIds.filter((id, i) => allIds.indexOf(id) !== i);
check("no id appears twice on the page", dup.length === 0, dup.join(","));
sections.forEach((s) => check(`#${s.id} has a heading and a where line`, /^\s*<h2>[^<]+<\/h2>\s*<p class="where">[^<]+<\/p>/.test(s.body)));
const whereOf = (id) => ((sections.find((s) => s.id === id) || {}).body || "").match(/<p class="where">([^<]+)<\/p>/)?.[1] || "";
check("voice sits under JOYA AI › Settings › Voice", whereOf("voice") === "JOYA AI › Settings › Voice");
check("hire limits point at Settings › Sessions &amp; hiring", /Sessions &amp; hiring/.test(whereOf("hire")));
check("devices sit under Access &amp; security", /^Access &amp; security › Devices/.test(whereOf("devices")));

console.log("contents");
const toc = [...side.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]);
check("the contents list every section, in order", JSON.stringify(toc) === JSON.stringify(IDS), toc.join(","));
check("the contents are the side column's data-toc list", /data-toc/.test(side) && /class="doc-side"/.test(page));
check("the contents' first entry is highlighted", /<li><a href="#around" class="on">/.test(side));

console.log("search");
check("a search box is on the page", /<input type="search" id="guide-q"/.test(docMain));
check("an empty note for no matches", /id="gd-empty"/.test(docMain));
check("guide.css and guide.js are loaded from /static", /<link rel="stylesheet" href="[^"]*guide\.css[^"]*">/.test(page) && /<script src="[^"]*guide\.js[^"]*" defer><\/script>/.test(page));
check("no inline script (CSP)", !/<script(?![^>]*\bsrc=)[^>]*>/.test(page));
check("public/guide.js exists", fs.existsSync(path.join(ROOT, "public", "guide.js")));
check("public/guide.css hides non-matching sections", /\.gd\.hide\s*\{\s*display:\s*none/.test(fs.readFileSync(path.join(ROOT, "public", "guide.css"), "utf8")));

console.log("facts");
[
  [/\bconsole\b/i, "console"],
  [/classic chat/i, "Classic chat"],
  [/front desk/i, "front desk"],
  [/push[- ]to[- ]talk/i, "push to talk"],
  [/\btrial\b/i, "trial"],
  [/hands-free/i, "hands-free"],
  [/\$|money budget|daily budget|dollar/i, "a money budget"],
  [/OS Dashboard|Agents Dashboard/, "the old dashboards"],
].forEach(([re, label]) => check(`the guide never mentions ${label}`, !re.test(text), (text.match(new RegExp(".{0,40}" + re.source + ".{0,40}", "i")) || [])[0]));
check("voice is a live conversation", /live conversation/.test(text));
check("Off turns off all voice incl. a reply's Read aloud, the key kept", /<b>Off<\/b> turns off all voice[^.]*Read aloud/.test(docMain) && /key stays saved/.test(text));
check("only administrators may talk by voice (voice.use)", /Only administrators may talk by voice/.test(text) && /voice\.use/.test(text));
check("the voice model: 2.1 mini the default with its facts, GPT-Live + JOYA AI when the key can use it, cut replies read word for word by 2.1 mini; the voices follow the model (GPT-Live 31, realtime 10) with a sample button; what JOYA AI hears: GPT-Live's own transcript, or GPT-4o Transcribe on the realtime models, nothing to set; a detailed spoken result", /<h3>Voice model<\/h3>/.test(docMain) && /GPT Realtime 2\.1 mini/.test(text) && /18 of 18/.test(text) && /GPT-Live \+ JOYA AI/.test(text) && /when your OpenAI key can use it/.test(text) && /GPT-Live has 31/.test(text) && /realtime models have 10/.test(text) && /speaks a short sample/.test(text) && /<h3>What JOYA AI hears<\/h3>/.test(docMain) && /GPT-Live's own transcript/.test(text) && /GPT-4o Transcribe/.test(text) && /nothing to set/.test(text) && !/Settings › Voice › Transcription|Transcription language|GPT-4o mini Transcribe|whisper/i.test(text.replace(/whisper\.cpp — no API key[\s\S]{0,200}/, "")) && /in a few\s+sentences, with its figures/.test(text) && !/Listening model|Read replies aloud|Arabic persona/.test(text));
check("caps count cache tokens, the N tok today figure", /input, output and cache/.test(text) && /N tok today/.test(text));
check("caps are checked at turn end and after each cost scan", /end of every JOYA AI turn/.test(text) && /cost scan/.test(text));
check("your own sessions only warn", /can only warn/.test(text));
check("hire limits default 7 and 3, editable", /default up to 7 live sessions and 3 hires an hour/.test(text) && /editable/.test(text));
check("retiring always needs consent", /retiring always needs your consent/.test(text));
check("new page-map entries allowed at once by default", /allowed at once \(the default\)/.test(text));
check("an administrator may sign out other users' devices", /administrator can sign out another user's devices/.test(text));
check("SSH pairing lives under SSH keys › Pair a device, /pair unchanged", /SSH keys › Pair a device/.test(text) && /\/pair/.test(text));
check("avatar menu entries", ["Account & sign-in", "Signed-in devices", "JOYA AI appearance", "Sign out"].every((s) => text.includes(s)));
check("the four sidebar groups, the Guide in the avatar menu", /in four groups/.test(text) && ["JOYA AI", "Agents & sessions", "Machine", "Access & security"].every((s) => text.includes(s)) && /Guide &amp; help|Guide & help/.test(docMain));
check("no stale wording: Budgets, Rules & watchers, Standing orders sheet, Usage & budget", !/Budgets|Rules &amp; watchers|Usage &amp; budget|Usage & budget|Morning briefing/.test(docMain));
check("Briefs, ChatGPT and Computers are covered", /<h2>Briefs and watchers<\/h2>/.test(docMain) && /<h2>ChatGPT<\/h2>/.test(docMain) && /Restart now/.test(docMain) && /<h2>Your computers<\/h2>/.test(docMain));
check("the ☰ at the foot of the Command Center's icon bar", /☰ button at the bottom of that bar/.test(text));

console.log("nothing lost from the old guide");
[
  ["bot creation", /@BotFather/, "bot"],
  ["user id", /@userinfobot/, "userid"],
  ["agent + channel forms", /Short name/, "create"],
  ["bot commands", /\/verbose 0\|1\|2/, "talk"],
  ["add-ons (voice notes, files)", /whisper\.cpp/, "addons"],
  ["groups and topics", /Manage Topics/, "topics"],
  ["WhatsApp", /install-whatsapp\.sh/, "whatsapp"],
  ["broadcast channels", /can only talk, never listen/, "channels"],
  ["the vault", /WORKLOG\.md/, "vault"],
  ["the vector index", /memory_search/, "vault"],
  ["Obsidian over RDP", /13389/, "obsidian"],
  ["the agents' file tree", /claude-auth\.env/, "layout"],
  ["privilege", /joya-helper/, "where"],
  ["how it works", /No inbound port/, "how"],
].forEach(([label, re, anchor]) => check(`${label} is still covered (#${anchor})`, re.test(docMain) && allIds.includes(anchor)));
check("old anchors still resolve", ["how", "bot", "userid", "create", "talk", "addons", "topics", "whatsapp", "channels", "obsidian", "trouble", "layout"].every((id) => allIds.includes(id)));

console.log("escaping");
check("the SSH host is escaped", page.includes("ubuntu@ssh&quot;&lt;b&gt;") && !page.includes('ssh"<b>'));
const fallback = views.guide({ csrf: "c", user, publicHost: "<pub>", publicPort: 1 });
check("with no SSH host the public host is used, escaped", fallback.includes("ubuntu@&lt;pub&gt;") && !fallback.includes("<pub>"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
