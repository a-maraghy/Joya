#!/usr/bin/env node
"use strict";
/**
 * The Telegram agents' bot avatars (2026-10-25, lib/agent-avatar.js):
 *   - derivation: deterministic per slug, the theme from the role's keywords, a seeded fallback, never
 *     JOYA AI's own cap; the stored spec wins over the role; shuffle stays in the theme
 *   - the checks: norm() accepts exactly the made specs; the helper's lists (deploy/joya-helper) match
 *   - drawing: static inline SVG, decorative, no inline style
 *   - pages (a scratch server, no helper): the avatar on Agents overview, Telegram agents, the agent's
 *     page head, Settings ▸ Avatar (Shuffle / Use this), Channels; avatar.svg; the PNG download
 *
 *   NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright node dashboard/tools/test-agent-avatar.cjs [SHOTS_DIR]
 */
const path = require("path");
const fs = require("fs");
const scratch = require("./scratch-server.cjs");
const A = require(path.join(__dirname, "..", "lib", "agent-avatar.js"));
const SHOTS = process.argv[2] || null;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); } else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
}

/* ------------------------------------------------------------ derivation */
console.log("derivation");
const PACE_ROLE = "You are JOYA Pace, the user's email assistant for their Microsoft 365 mailbox. You brief them on new mail over Telegram and prepare replies. The Outlook tool ... draft-reply ... inbox.";
const a1 = A.derive("joya-pace", PACE_ROLE), a2 = A.derive("joya-pace", PACE_ROLE);
check("the same slug and role give the same avatar (stable on reload)", JSON.stringify(a1) === JSON.stringify(a2));
check("an email assistant is the Email theme with a headset", a1.theme === "mail" && a1.head === "headset", JSON.stringify(a1));
const THEME_CASES = [
  ["Designs logos and brand identity for Mavix, a startup; draws icons", "design", ["beret", "pencil"]],
  ["Maintains the Odoo modules: code changes, migrations, deploys, git", "code", ["glasses", "goggles"]],
  ["Prepares invoices, customs papers and the monthly tax report", "finance", ["glasses", "tie"]],
  ["Researches competitors and analyses the market", "research", ["magnifier", "glasses"]],
  ["Answers customer support chats and tickets", "support", ["headset", "headphones"]],
];
for (const [text, theme, heads] of THEME_CASES) {
  const d = A.derive("agent-x", text);
  check(`"${text.slice(0, 32)}…" -> ${theme} (${heads.join(" or ")})`, d.theme === theme && heads.includes(d.head), JSON.stringify(d));
}
const g = A.derive("plain", "Does a bit of everything");
check("an unknown role falls back to the general theme", g.theme === "general" && A.HEADS.includes(g.head));
check("planning is not read as planting, and nothing is a plant: no head or theme is a plant", !A.HEADS.some((h) => /plant|seed|leaf|flower/.test(h)) && !A.THEME_IDS.some((t) => /plant|seed|garden/.test(t)));
check("JOYA AI's own cap is never an agent's head", !A.HEADS.includes("cap"));
let differ = 0;
for (let i = 0; i < 20; i++) { const x = A.derive("bot-" + i, PACE_ROLE), y = A.derive("bot-" + (i + 100), PACE_ROLE); if (x.hue !== y.hue || x.face !== y.face || x.turn !== y.turn) differ++; }
check("two agents with the same role still differ (seeded by the slug): " + differ + " of 20 pairs", differ >= 15);
const seen = new Set();
for (let i = 0; i < 200; i++) seen.add(A.derive("s" + i, "").head);
check("the fallback spreads over the heads (" + seen.size + " of " + A.HEADS.length + ")", seen.size >= A.HEADS.length - 2);
const stored = Object.assign({}, a1, { hue: "rose", head: "pencil" });
check("a stored avatar wins over the role (editing the role does not change it)", JSON.stringify(A.specFor({ slug: "joya-pace", role: "Researches markets", avatar: stored })) === JSON.stringify(stored));
check("an agent with no stored avatar gets the derived one", JSON.stringify(A.specFor({ slug: "joya-pace", role: PACE_ROLE, name: "" })) === JSON.stringify(A.derive("joya-pace", PACE_ROLE)));
const design = A.derive("mavix-bot", "logo design brand");
let inTheme = true, changed = 0;
for (let i = 0; i < 30; i++) { const s = A.shuffle("mavix-bot", "", design); if (s.theme !== "design") inTheme = false; if (s.head !== design.head || s.hue !== design.hue || s.face !== design.face) changed++; }
check("shuffle stays in the current theme even when the role is empty", inTheme);
check("shuffle gives a different look", changed === 30);
const sh = A.shuffle("mavix-bot", "", design);
check("a shuffled avatar is reproducible from its seed and theme", JSON.stringify(A.derive("mavix-bot", "", sh.seed, sh.theme)) === JSON.stringify(sh));

/* ------------------------------------------------------------ checks */
console.log("checks");
check("norm accepts a made spec", JSON.stringify(A.norm(a1)) === JSON.stringify(a1));
check("norm accepts the JSON string too", JSON.stringify(A.norm(JSON.stringify(a1))) === JSON.stringify(a1));
const BAD = [
  ["an extra key", Object.assign({}, a1, { x: 1 })],
  ["a missing key", (() => { const c = Object.assign({}, a1); delete c.turn; return c; })()],
  ["an unknown head", Object.assign({}, a1, { head: "cap" })],
  ["an unknown hue", Object.assign({}, a1, { hue: "#ff0000" })],
  ["markup in a value", Object.assign({}, a1, { face: "<script>" })],
  ["a negative seed", Object.assign({}, a1, { seed: -1 })],
  ["a fractional seed", Object.assign({}, a1, { seed: 1.5 })],
  ["version 2", Object.assign({}, a1, { v: 2 })],
  ["an array", [a1]],
];
for (const [n, v] of BAD) check("norm refuses " + n, A.norm(v) === null);
const helper = fs.readFileSync(path.join(__dirname, "..", "deploy", "joya-helper"), "utf8");
const tuple = (name) => { const m = new RegExp("^" + name + " = \\(([\\s\\S]*?)\\)\\n", "m").exec(helper); return m ? (m[1].match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1)) : null; };
check("the helper's themes are the dashboard's", JSON.stringify(tuple("AVATAR_THEMES")) === JSON.stringify(A.THEME_IDS));
check("the helper's heads are the dashboard's", JSON.stringify(tuple("AVATAR_HEADS")) === JSON.stringify(A.HEADS));
check("the helper's faces are the dashboard's", JSON.stringify(tuple("AVATAR_FACES")) === JSON.stringify(A.FACES));
check("the helper's hues are the dashboard's", JSON.stringify(tuple("AVATAR_HUES")) === JSON.stringify(Object.keys(A.HUES)));
check("the helper's turns and keys are the dashboard's", JSON.stringify(tuple("AVATAR_TURNS")) === JSON.stringify(A.TURNS) && JSON.stringify(tuple("AVATAR_KEYS")) === JSON.stringify(A.KEYS));

/* ------------------------------------------------------------ drawing */
console.log("drawing");
const svg = A.svg(a1);
check("an inline SVG, decorative (aria-hidden, not focusable)", /^<svg class="av-svg"[^>]*aria-hidden="true" focusable="false"/.test(svg));
check("no inline style and no script in it (CSP)", !/style=|<script|on\w+=/.test(svg));
check("its colours come from CSS classes, not fixed values", !/#[0-9A-Fa-f]{6}/.test(svg) && /class="av-c av-fill"/.test(svg) && /class="av-plate"/.test(svg));
for (const h of A.HEADS) for (const f of A.FACES) {
  const s = A.svg({ v: 1, theme: "general", head: h, face: f, hue: "teal", turn: "l", seed: 1 }, { lite: true });
  if (!/<path class="av-plate" d="M[\d.]+ [\d.]+L/.test(s) || /NaN|Infinity/.test(s)) { check("head " + h + " / " + f + " draws", false); }
}
check("every head draws in every face style, no NaN", true);
const tile = A.tile(a1, "sm");
check("the tile carries the hue's class and is hidden from screen readers", /^<span class="av av-sm av-h-\w+" aria-hidden="true">/.test(tile));
const sa = A.svg(a1, { standalone: "light", px: 640 });
check("the standalone file has fixed colours, a white plate and no classes", /width="640"/.test(sa) && /fill="#FFFFFF"/.test(sa) && !/class=/.test(sa));
check("a small tile stays small (under 40 kB)", Buffer.byteLength(A.tile(a1, "sm")) < 40000, String(Buffer.byteLength(A.tile(a1, "sm"))));

/* ------------------------------------------------------------ pages */
const AGENTS = [
  { slug: "mavix-bot", name: "MAVIX", role: "", model: "claude-sonnet-5", effort: "medium", verbose_level: 1, state: { active: "active" }, memory: { chunks: 40 }, notes: 12,
    avatar: { v: 1, theme: "design", head: "beret", face: "minimal", hue: "orange", turn: "l", seed: 244245234 },
    channel: { slug: "mavix-tg", name: "MAVIX bot", type: "telegram", telegram_bot_username: "mavix_bot", allowed_users: "1234567" } },
  { slug: "joya-pace", name: "JOYA Pace", role: PACE_ROLE, model: "claude-opus-5-5", effort: "medium", verbose_level: 1, state: { active: "active" }, memory: { chunks: 9 }, notes: 4,
    avatar: a1, channel: { slug: "pace-tg", name: "JOYA Pace", type: "telegram", telegram_bot_username: "joya_pace_bot", allowed_users: "1234567" } },
  { slug: "odoo-dev", name: "Odoo Dev", role: "Maintains the Odoo modules and deploys them", model: "claude-opus-5-5", state: { active: "inactive" }, memory: {}, notes: 0, channel: null },
];
const CHANNELS = [
  { slug: "mavix-tg", name: "MAVIX bot", type: "telegram", telegram_bot_username: "mavix_bot", agent: "mavix-bot", agent_name: "MAVIX", agent_state: { active: "active" }, allowed_users: "1234567", token_set: true },
  { slug: "pace-tg", name: "JOYA Pace", type: "telegram", telegram_bot_username: "joya_pace_bot", agent: "joya-pace", agent_name: "JOYA Pace", agent_state: { active: "active" }, allowed_users: "1234567", token_set: true },
];

(async () => {
  const s = await scratch.startScratch({
    recordCalls: true,
    fakeReads: {
      "agent-list": AGENTS, "agent-get": AGENTS[1], "channel-list": CHANNELS, "agent-vault-list": [], "agent-logs": { lines: ["2026-10-25T10:00:00+02:00 host joya-agent@joya-pace[1]: started"] },
      "system-probe": { claude_credential: true, credential_stale_agents: [] }, "cc-running": { sessions: [] },
    },
  });
  const BASE = `http://127.0.0.1:${s.port}`;
  let browser = null;
  try {
    console.log("pages");
    await s.makeUser("avadmin", "administrator");
    const who = await s.signIn("avadmin");
    const get = (p) => s.req("GET", p, { cookie: who.cookie });

    const ov = await get("/agents/dashboard");
    check("Agents overview: a tile per agent, beside its name", ov.status === 200 && (ov.body.match(/class="av av-sm av-h-/g) || []).length === 3 && /<div class="who"><span class="av av-sm av-h-orange"[\s\S]*?<a class="nm" href="\/agents\/mavix-bot">MAVIX<\/a>/.test(ov.body));
    const list = await get("/agents");
    check("Telegram agents: the same tiles", list.status === 200 && (list.body.match(/class="av av-sm av-h-/g) || []).length === 3);
    check("no planting words on the agent pages", !/\b(plant|seedling|sprout|nursery|garden)/i.test(ov.body + list.body));
    const page = await get("/agents/joya-pace");
    check("the agent page head: a medium tile, the name in text", page.status === 200 && /<h1><span class="agent-h1"><span class="av av-md av-h-\w+" aria-hidden="true">[\s\S]*?<\/span><span>JOYA Pace<\/span>/.test(page.body));
    check("the agent page offers the PNG for the bot's picture", /data-avatar-png="\/agents\/joya-pace\/avatar.svg"/.test(page.body) && /Download avatar \(PNG\)/.test(page.body) && /agent-avatar\.js/.test(page.body));
    const set = await get("/agents/joya-pace/settings");
    check("Settings ▸ Avatar: the large tile, its words, Shuffle avatar", set.status === 200 && /id="avatar"/.test(set.body) && /av av-lg/.test(set.body) && /Email · headset/.test(set.body) && /href="\/agents\/joya-pace\/settings\?avatar=shuffle#avatar"[^>]*>[\s\S]*?Shuffle avatar/.test(set.body));
    const shf = await get("/agents/joya-pace/settings?avatar=shuffle");
    const csrf = s.csrfOf(shf.body);
    const hid = {};
    for (const m of shf.body.matchAll(/name="(avatar_\w+)" value="([^"]*)"/g)) hid[m[1]] = m[2];
    check("Shuffle shows a new one, not saved, with Use this and Keep the current one", /A new one, not saved yet/.test(shf.body) && /Use this/.test(shf.body) && /Keep the current one/.test(shf.body) && Object.keys(hid).length === 7 && hid.avatar_theme === "mail");
    const post = (body) => s.req("POST", "/agents/joya-pace/avatar", { cookie: who.cookie, body: new URLSearchParams(Object.assign({ _csrf: csrf }, body)).toString() });
    const bad = await post(Object.assign({}, hid, { avatar_head: "cap" }));
    check("Use this refuses a spec the panel does not make (before the helper)", bad.status === 302 && /err=That%20avatar%20is%20not%20one/.test(bad.headers.location || ""));
    const good = await post(hid);
    check("Use this sends a good spec to the helper's agent-avatar (refused only by the scratch guard)", good.status === 302 && /helper%20is%20not%20called%20\(agent-avatar\)/.test(good.headers.location || ""), good.headers.location);
    const nocsrf = await s.req("POST", "/agents/joya-pace/avatar", { cookie: who.cookie, body: new URLSearchParams(hid).toString() });
    check("Use this needs the CSRF token", nocsrf.status === 403 || nocsrf.status === 400);
    const file = await get("/agents/joya-pace/avatar.svg?theme=dark&px=256");
    check("avatar.svg: a file of its own, fixed colours", file.status === 200 && /image\/svg\+xml/.test(file.headers["content-type"]) && /width="256"/.test(file.body) && /fill="#000000"/.test(file.body));
    const dl = await get("/agents/joya-pace/avatar.svg?download=1");
    check("avatar.svg?download=1 is an attachment", /attachment; filename="joya-pace-avatar.svg"/.test(dl.headers["content-disposition"] || ""));
    const anon = await s.req("GET", "/agents/joya-pace/avatar.svg");
    check("avatar.svg needs a signed-in user", anon.status === 302 || anon.status === 401 || anon.status === 403);
    const ch = await get("/channels");
    check("Channels: the agent's tile beside its name", ch.status === 200 && (ch.body.match(/class="av av-sm av-h-/g) || []).length === 2);
    const nw = await get("/agents/new");
    check("Create agent: a plain form, What it does, Create agent", nw.status === 200 && /What it does/.test(nw.body) && /name="role"/.test(nw.body) && /Create agent<\/button>/.test(nw.body) && !/plant/i.test(nw.body));

    if (process.env.PLAYWRIGHT || process.env.PW) {
      console.log("browser");
      const { chromium } = require(process.env.PLAYWRIGHT || process.env.PW);
      browser = await chromium.launch();
      for (const scheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, acceptDownloads: true, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await context.addCookies(who.cookie.split("; ").map((kv) => { const i = kv.indexOf("="); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE }; }));
        const pg = await context.newPage();
        const problems = [];
        pg.on("pageerror", (e) => problems.push(e.message));
        pg.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused/.test(m.text())) problems.push(m.text()); });
        for (const [name, url] of [["overview", "/agents/dashboard"], ["agent", "/agents/joya-pace"], ["settings", "/agents/mavix-bot/settings"], ["channels", "/channels"]]) {
          await pg.goto(BASE + url, { waitUntil: "load" });
          const box = await pg.locator(".av").first().boundingBox();
          const col = await pg.evaluate(() => getComputedStyle(document.querySelector(".av-svg .av-c.av-fill")).fill);
          check(`${scheme}: ${name} shows the avatar (${box && Math.round(box.width)} px, colour ${col})`, !!box && box.width >= 39 && /rgb/.test(col));
          if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(SHOTS, `${name}-1440-${scheme}.png`), fullPage: false }); }
        }
        if (scheme === "light") {
          await pg.goto(BASE + "/agents/joya-pace", { waitUntil: "load" });
          const [d] = await Promise.all([pg.waitForEvent("download", { timeout: 8000 }), pg.locator("a[data-avatar-png]").first().click({ timeout: 6000 }).catch((e) => console.log("       click: " + e.message.split("\n").slice(0, 6).join(" | ")))]);
          const fp = await d.path();
          const head = fs.readFileSync(fp).subarray(0, 8);
          check("Download avatar (PNG) saves a PNG named for the agent", d.suggestedFilename() === "joya-pace-avatar.png" && head.toString("hex") === "89504e470d0a1a0a");
        }
        check(`${scheme}: no page error or CSP violation`, problems.length === 0, problems.join(" | "));
        await context.close();
      }
    }
  } catch (e) {
    failed++;
    console.log("  FAIL " + (e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    s.stop();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
