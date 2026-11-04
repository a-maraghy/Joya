#!/usr/bin/env node
"use strict";
/**
 * The page map (lib/page-registry.js, lib/page-map.js): every place JOYA AI's
 * page.open may open, built from the source, compared with the last scan, and
 * allowed entry by entry -- and page.open (public/ui-actions.js) held to it.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-page-registry.cjs
 *
 * No server, no helper, no supervisor: page-map runs over an in-memory
 * settings store and a fake supervisor client.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.JOYA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pagereg-"));
const ROOT = path.join(__dirname, "..");
const lib = (m) => require(path.join(ROOT, "lib", m));

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

const ui = lib("ui");
const rbac = lib("rbac");
const R = lib("page-registry");
const UA = require(path.join(ROOT, "public", "ui-actions.js"));

/* ------------------------------------------------------------- the build --- */

console.log("the registry, built from the source");
const entries = R.build();
const byKey = new Map(entries.map((e) => [e.key, e]));
{
  const navItems = ui.NAV.flatMap((g) => g.items);
  const missing = navItems.filter((it) => !entries.some((e) => e.kind === "page" && e.url === it.href));
  check("every NAV item is a page entry (same url)", navItems.length === 18 && missing.length === 0, missing.map((i) => i.key).join());
  check("  under the key JOYA AI hears for it (PAGE_KEYS)", navItems.every((it) => byKey.has(R.PAGE_KEYS[it.key][0]) && byKey.get(R.PAGE_KEYS[it.key][0]).url === it.href));
  check("  plus Your account and the Guide (the avatar menu)", byKey.get("account") && byKey.get("account").url === "/account" && byKey.get("account").perm === null && byKey.get("guide") && byKey.get("guide").url === "/guide" && byKey.get("guide").kind === "page");
  const keys = entries.map((e) => e.key);
  check("no two entries share a key", new Set(keys).size === keys.length, keys.filter((k, i) => keys.indexOf(k) !== i).join());
  check("every url is a path of this site (starts with /, never //)", entries.every((e) => /^\/(?!\/)/.test(e.url)), entries.filter((e) => !/^\/(?!\/)/.test(e.url)).map((e) => e.key).join());
  check("every key is a valid page.open key", entries.every((e) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(e.key)));
  check("every entry names a kind of page / section / sheet / tab / anchor", entries.every((e) => ["page", "section", "sheet", "tab", "anchor"].includes(e.kind)));
  check("every child's parent is an entry", entries.every((e) => !e.parent || byKey.has(e.parent)));
  const sections = require(path.join(ROOT, "lib", "views-settings.js")).SETTINGS_SECTIONS.map((s) => s[0]);
  check("the nine Settings sections are sections of settings (ChatGPT added and Advanced merged into General, 2026-10-25)", sections.length === 9 && sections.every((k) => byKey.get("settings." + k) && byKey.get("settings." + k).kind === "section" && byKey.get("settings." + k).url === "/joya-ai/settings/" + k));
  check("  Voice needs voice.manage, the others joyaai.use", byKey.get("settings.voice").perm === "voice.manage" && byKey.get("settings.general").perm === "joyaai.use");
  const sheets = require(path.join(ROOT, "public", "cc-logic.js")).SHEETS;
  check("the Command Center's sheets open as /joya-ai#<sheet>", sheets.filter((s) => s && s.key).length >= 8 && sheets.filter((s) => s && s.key).every((s) => byKey.get("cc." + s.key) && byKey.get("cc." + s.key).url === "/joya-ai#" + s.key && byKey.get("cc." + s.key).kind === "sheet"));
  check("the Sessions and Services tabs are tabs (?tab= / ?kind=)", byKey.get("sessions.live").url === "/claude/sessions?tab=live" && byKey.get("sessions.archived").kind === "tab" && byKey.get("services.agents").url === "/services?kind=agents");
  check("anchors from the views: the Guide's sections, the Overview's cards, SSH keys' Pair a device", byKey.get("guide.voice").url === "/guide#voice" && byKey.get("agents.telegram").url === "/agents/dashboard#a-telegram" && byKey.get("keys.pair").url === "/keys#pair");
  check("an anchor carries its page's permission", byKey.get("agents.telegram").perm === byKey.get("agents").perm && byKey.get("keys.pair").perm === byKey.get("keys").perm);
}

console.log("\nscanAnchors");
{
  const src = `
    card("Live sessions", body, { id: "a-live" })
    card("Hidden", body, { id: "x-hidden" })
    <section class="card" id="s-thing"><div class="card-head"><h2>\${icon("x")}Thing &amp; more</h2></div></section>
    <input id="q-search">`;
  const a = R.scanAnchors(src);
  check("a card(...) id takes the card's title", a.some((x) => x.id === "a-live" && x.label === "Live sessions"));
  check("an id=\"\" in markup takes the next heading's text (tags and ${} out, entities in)", a.some((x) => x.id === "s-thing" && x.label === "Thing & more" && x.tag === "section"));
  check("an id with no title (a form input) is not an anchor", !a.some((x) => x.id === "q-search"));
  check("scanAnchors itself lists x- ids (build() drops them)", a.some((x) => x.id === "x-hidden"));
}

console.log("\na card added to a view appears after a rescan");
const TMP_LIB = fs.mkdtempSync(path.join(os.tmpdir(), "pagereg-lib-"));
let grown;
{
  fs.cpSync(path.join(ROOT, "lib"), TMP_LIB, { recursive: true });
  const f = path.join(TMP_LIB, "views-agents.js");
  const add = `
// test-page-registry: two cards added to a view
const __testCards = () => card("Test card", "<p>x</p>", { id: "a-testcard" }) + card("Private card", "<p>x</p>", { id: "x-private" });
`;
  fs.writeFileSync(f, fs.readFileSync(f, "utf8") + add);
  check("before: no such entry", !byKey.has("agents.testcard"));
  grown = R.build({ libDir: TMP_LIB });
  const e = grown.find((x) => x.key === "agents.testcard");
  check("after the rescan: agents.testcard, an anchor on the Overview, labelled by its card", e && e.kind === "anchor" && e.parent === "agents" && e.url === "/agents/dashboard#a-testcard" && e.label === "Test card", JSON.stringify(e));
  check("an x- id is private: never listed", !grown.some((x) => /x-private|\.private$/.test(x.key + " " + x.url)));
  const d = R.diff(entries, grown);
  check("the diff names it as new, and nothing else changed", d.added.join() === "agents.testcard" && !d.renamed.length && !d.removed.length, JSON.stringify(d));
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('card("Test card"', 'card("Test card, renamed"'));
  const d2 = R.diff(grown, R.build({ libDir: TMP_LIB }));
  check("a retitled card is renamed (same key and url, new label)", d2.renamed.length === 1 && d2.renamed[0].join("|") === "agents.testcard|Test card|Test card, renamed" && !d2.added.length, JSON.stringify(d2));
  fs.rmSync(TMP_LIB, { recursive: true, force: true });
}

console.log("\nthe diff");
{
  const first = R.diff(null, entries);
  const legacy = Object.keys(R.LEGACY_KEYS);
  check("page.open's 21 fixed keys are the legacy map", legacy.length === 21);
  check("the first scan maps every one of them: none removed", first.removed.length === 0, JSON.stringify(first.removed));
  const renamed = first.renamed.map((r) => r[0]);
  const same = legacy.filter((k) => R.LEGACY_KEYS[k] === k);
  check("the 18 that changed key show as renamed, the 3 that kept theirs (agents, guide, account) as mapped", renamed.length === 18 && renamed.every((k) => legacy.includes(k) && R.LEGACY_KEYS[k] !== k) && same.sort().join() === "account,agents,guide", renamed.join());
  check("  each renamed line names the new entry (claude-running -> sessions.live, voice-settings -> settings.voice)", first.renamed.some((r) => r[0] === "claude-running" && /\(sessions\.live\)$/.test(r[2])) && first.renamed.some((r) => r[0] === "voice-settings" && /\(settings\.voice\)$/.test(r[2])));
  check("  everything else is new", first.added.length === entries.length - new Set(Object.values(R.LEGACY_KEYS)).size && !first.added.includes("sessions.live"));
  check("ui-actions accepts the same legacy keys, to the same new keys", legacy.every((k) => R.LEGACY_KEYS[k] === k || UA.LEGACY_PAGES[k] === R.LEGACY_KEYS[k]));

  const prev = [
    { key: "a", url: "/a", label: "A" },
    { key: "b", url: "/b", label: "B" },
    { key: "c", url: "/c", label: "C" },
    { key: "d", url: "/d", label: "D" },
  ];
  const next = [
    { key: "a", url: "/a", label: "A" }, // same
    { key: "b", url: "/b2", label: "B" }, // same key, new url
    { key: "c2", url: "/c", label: "C" }, // same url, new key
    { key: "e", url: "/e", label: "E" }, // new
  ]; // d removed
  const d = R.diff(prev, next);
  check("renamed: same key with a new url", d.renamed.some((r) => r.join("|") === "b|/b|/b2"));
  check("renamed: same url under a new key", d.renamed.some((r) => r.join("|") === "c|c|c2"));
  check("new and removed", d.added.join() === "e" && d.removed.length === 1 && d.removed[0][0] === "d");
  check("an unchanged scan is no change", JSON.stringify(R.diff(entries, R.build())) === JSON.stringify({ added: [], renamed: [], removed: [] }));
}

console.log("\nallow switches: effective()");
{
  const all = R.effective(entries, {});
  check("with nothing switched off, every entry", all.length === entries.length);
  const off = R.effective(entries, { sessions: false });
  check("a disallowed entry is dropped", !off.some((e) => e.key === "sessions"));
  check("  and so are its children (the Live / All / Archived tabs)", !off.some((e) => e.parent === "sessions") && entries.some((e) => e.parent === "sessions"));
  const deep = R.effective(entries, { settings: false });
  check("  and their children in turn (Settings > Voice > its rows)", !deep.some((e) => e.key.startsWith("settings")) && entries.some((e) => e.parent === "settings.voice"));
  check("  others are untouched", off.length === entries.length - 1 - entries.filter((e) => e.parent === "sessions").length);
  check("switching a child off leaves its parent", R.effective(entries, { "sessions.live": false }).some((e) => e.key === "sessions"));
}

console.log("\npage.open over the map");
{
  UA.setPages(R.effective(entries, { audit: false, "sessions.live": false }));
  check("an allowed entry opens", UA.validate("page.open", { page: "os" }).ok && UA.validate("page.open", { page: "guide.voice" }).ok && UA.validate("page.open", { page: "cc.dec" }).ok);
  check("a disallowed key is refused", !UA.validate("page.open", { page: "audit" }).ok && !UA.validate("page.open", { page: "sessions.live" }).ok);
  check("  an old key for it too (os-audit, claude-running)", !UA.validate("page.open", { page: "os-audit" }).ok && !UA.validate("page.open", { page: "claude-running" }).ok);
  check("legacy keys still validate to their new key", UA.validate("page.open", { page: "os-overview" }).args.page === "os" && UA.validate("page.open", { page: "voice-settings" }).args.page === "settings.voice" && UA.validate("page.open", { page: "command-center" }).args.page === "cc");
  check("  all of them whose target is allowed", Object.keys(R.LEGACY_KEYS).filter((k) => !["os-audit", "claude-running"].includes(k)).every((k) => UA.validate("page.open", { page: k }).ok));
  check("a key that is not in the map at all is refused", !UA.validate("page.open", { page: "agents.testcard" }).ok && !UA.validate("page.open", { page: "/audit" }).ok);
  check("navPage gives the url from the map, never from the model", UA.navPage("guide.voice").url === "/guide#voice" && UA.navPage("sessions.all").url === "/claude/sessions?tab=all");
  check("the stable ui_do schema does not move with the map", Object.keys(UA.stableSchema().properties).join() === "action," + UA.ARG_KEYS.join() && UA.ARG_KEYS.join() === "key,mode,name,core,page,on,theme,preset,voice" && !/enum/.test(JSON.stringify(UA.stableSchema())));
  UA.setPages(null);
}

console.log("\nlib/page-map.js: stored scans, the allow switches, a viewer's keys");
(async () => {
  const PM = lib("page-map");
  const store = {};
  const db = { getSetting: (k, d) => (k in store ? store[k] : d), setSetting: (k, v) => (store[k] = v) };
  const pushes = [];
  const joyaai = { call: (op, params, actor) => (pushes.push({ op, params, actor }), Promise.resolve({ applied: true })) };
  PM.configure({ db, joyaai });
  check("before a scan: no current map (pages fall back to the built-in pages)", PM.current() === null && PM.effective() === null);
  const st = PM.scan("test");
  check("a scan stores the registry under ui_page_registry", store.ui_page_registry && JSON.parse(store.ui_page_registry).entries.length === entries.length);
  check("  the first scan's diff maps the legacy keys", st.diff.renamed.length === 18 && st.diff.removed.length === 0);
  check("  and it is pushed to the supervisor as op ui-pages", pushes.length === 1 && pushes[0].op === "ui-pages" && pushes[0].params.pages.length === entries.length && pushes[0].params.pages.every((p) => p.key && p.url));
  check("  and set in this process's ui-actions", Object.keys(UA.pages()).length === entries.length && UA.validate("page.open", { page: "guide.voice" }).ok);
  const again = PM.scan("test");
  check("a rescan with no change keeps the first scan's stamp and diff", again.at === st.at && again.diff.renamed.length === 18);

  PM.setAllow("users", false, "test");
  check("switching an entry off is stored in ui_page_allow", JSON.parse(store.ui_page_allow).users === false);
  check("  and page.open refuses it at once", !UA.validate("page.open", { page: "users" }).ok && !UA.validate("page.open", { page: "manage-users" }).ok);
  check("  and the supervisor is told", pushes[pushes.length - 1].params.pages.every((p) => p.key !== "users"));
  PM.setAllow("users", true, "test");
  check("switching it back on", UA.validate("page.open", { page: "users" }).ok && !("users" in JSON.parse(store.ui_page_allow)));

  // The role decides what a viewer's page may open (data-pages), whatever is allowed.
  const limited = rbac.actor({ permissions: ["joyaai.use", "os.view"], agent_scope: "*", channel_scope: "*" });
  const pm = ui.pageMapFor(limited);
  const keys = pm.keys.split(" ");
  check("a key the role cannot see is not in pageMapFor(perm).keys", !keys.includes("users") && !keys.includes("audit") && !keys.includes("settings.voice") && !keys.includes("sessions.live"));
  check("  the ones it can see are", ["cc", "settings", "settings.appearance", "os", "devices", "guide", "guide.voice", "account", "cc.dec"].every((k) => keys.includes(k)), pm.keys);
  check("  the map (data-page-map) lists every allowed entry, with its perm, for the page to check", JSON.parse(pm.map).length === entries.length && JSON.parse(pm.map).find((e) => e.key === "users").perm === "users.view");
  const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
  check("an administrator's keys are every allowed entry", ui.pageMapFor(admin).keys.split(" ").length === entries.length);
  PM.setAllow("audit", false, "test");
  check("a disallowed entry is in no one's keys, and not in the map", !ui.pageMapFor(admin).keys.split(" ").includes("audit") && !JSON.parse(ui.pageMapFor(admin).map).some((e) => e.key === "audit"));
  const html = ui.shell("T", "<p/>", { user: { name: "a", perm: limited }, csrf: "c", active: "os" });
  const dp = (/data-pages="([^"]*)"/.exec(html) || [])[1] || "";
  check("the dock on a page carries the viewer's keys", dp === ui.pageMapFor(limited).keys && !dp.split(" ").includes("users"));
  PM.allowAll("test");
  check("Allow all clears every switch", JSON.stringify(JSON.parse(store.ui_page_allow)) === "{}" && ui.pageMapFor(admin).keys.split(" ").includes("audit"));

  // New entries policy: "wait" leaves a new entry off until allowed.
  PM.setPolicy("wait", "test");
  const prevReg = JSON.parse(store.ui_page_registry);
  prevReg.entries = prevReg.entries.filter((e) => e.key !== "guide.voice");
  store.ui_page_registry = JSON.stringify(prevReg);
  const w = PM.scan("test");
  check("policy wait: an entry new since the last scan starts switched off", w.new_keys.join() === "guide.voice" && JSON.parse(store.ui_page_allow)["guide.voice"] === false && !UA.validate("page.open", { page: "guide.voice" }).ok, JSON.stringify(w.new_keys));
  PM.setPolicy("auto", "test");
  const prev2 = JSON.parse(store.ui_page_registry);
  prev2.entries = prev2.entries.filter((e) => e.key !== "guide.memory");
  store.ui_page_registry = JSON.stringify(prev2);
  PM.scan("test");
  check("policy auto (the default): a new entry is allowed at once", UA.validate("page.open", { page: "guide.memory" }).ok && JSON.parse(store.ui_page_allow)["guide.memory"] === undefined);

  // A failed push is retried, not lost.
  const failing = { call: () => Promise.reject(new Error("JOYA AI is down")) };
  PM.configure({ db, joyaai: failing });
  PM.scan("test");
  await new Promise((r) => setTimeout(r, 20));
  check("a push that fails is recorded (and retried later)", PM.lastPush().ok === false && /down/.test(PM.lastPush().error));
  UA.setPages(null);
  PM.configure({ db, joyaai: null });

  fs.rmSync(process.env.JOYA_DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL the run completed\n       " + e.stack);
  process.exit(1);
});
