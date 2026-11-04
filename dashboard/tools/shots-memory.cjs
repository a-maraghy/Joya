#!/usr/bin/env node
"use strict";
/**
 * Screenshots of the memory pages (Claude Code memory, an agent's memory, one note, one fact)
 * at 1440 px in light and dark, from a scratch copy of the server whose helper answers from
 * fixture files -- nothing reaches the real helper.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright \
 *       node dashboard/tools/shots-memory.cjs FIXTURE_DIR OUT_DIR [prefix]
 *
 * FIXTURE_DIR holds one <subcommand>.json per helper read (the helper's "data", or its whole
 * {"ok":true,"data":...} answer), e.g. agent-list.json, agent-get.json, agent-vault-index.json,
 * cc-memory-stats.json, cc-facts-list.json. A missing one is simply an error on the page.
 */
const scratch = require("./scratch-server.cjs");
const fs = require("fs");
const path = require("path");

const [FIX, OUT, PREFIX = ""] = process.argv.slice(2);
if (!FIX || !OUT) {
  console.error("usage: shots-memory.cjs FIXTURE_DIR OUT_DIR [prefix]");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

function fixtures() {
  const out = {};
  for (const f of fs.readdirSync(FIX)) {
    if (!f.endsWith(".json")) continue;
    let v = JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
    if (v && typeof v === "object" && v.ok === true && "data" in v) v = v.data;
    out[f.replace(/\.json$/, "").replace(/_.*$/, "")] = v;
  }
  return out;
}

const PAGES = (process.env.PAGES || [
  "claude-memory=/claude/memory",
  "claude-facts=/claude/memory?view=list&topic=joya_ai_os",
  "claude-graph=/claude/memory?view=graph",
  "claude-fact=/claude/memory/facts/" + (process.env.FACT_ID || "1"),
  "agent-memory=/agents/mavix-bot/memory",
  "agent-graph=/agents/mavix-bot/memory?view=graph",
  "agent-note=/agents/mavix-bot/memory/note?path=" + encodeURIComponent(process.env.NOTE || "memory/mavix-final-logo-approved.md"),
  "agent-home=/agents/mavix-bot/memory/note?path=MEMORY.md",
].join(","))
  .split(",")
  .map((s) => s.split("="))
  .map(([name, ...rest]) => [name, rest.join("=")]);

(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({ fakeReads: fixtures() });
  try {
    await s.makeUser("admin1", "administrator");
    const who = await s.signIn("admin1");
    const browser = await chromium.launch();
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: Number(process.env.SHOT_H || 900) }, colorScheme: scheme });
      await ctx.addCookies(
        who.cookie.split("; ").map((c) => {
          const i = c.indexOf("=");
          return { name: c.slice(0, i), value: c.slice(i + 1), domain: "127.0.0.1", path: "/" };
        })
      );
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      for (const [name, url] of PAGES) {
        await page.goto("http://127.0.0.1:" + s.port + url, { waitUntil: "networkidle" });
        await page.waitForTimeout(name.includes("graph") ? 2500 : 300);
        const file = path.join(OUT, PREFIX + name + "-" + scheme + ".png");
        await page.screenshot({ path: file, fullPage: !name.includes("graph") });
        console.log(file);
      }
      if (errors.length) console.log("page errors (" + scheme + "): " + errors.join(" | "));
      await ctx.close();
    }
    await browser.close();
  } finally {
    s.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
