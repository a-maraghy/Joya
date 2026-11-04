#!/usr/bin/env node
"use strict";
/**
 * UI control, Phase 1: the shared allowlist (public/ui-actions.js) -- the
 * same file the server requires and the page loads.
 *
 *     node dashboard/tools/test-ui-actions.cjs
 */
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const UA = require(path.join(ROOT, "public", "ui-actions.js"));
const ML = require(path.join(ROOT, "public", "cc-logic.js"));

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

console.log("the allowlist");
check("exactly the Phase 1 actions plus the three Tier-2 preferences (voice.mode and settings.open are gone)", UA.names().sort().join() === ["call.end", "call.mute", "call.interrupt", "sheet.open", "sheet.close", "view", "core.set", "reply.show", "reply.read", "decision.show", "page.open", "theme.set", "persona.set", "voice.set"].sort().join(), UA.names().join());
check("  voice.mode and settings.open are refused as unknown", !UA.validate("voice.mode", { mode: "live" }).ok && !UA.validate("settings.open", { page: "voice" }).ok && /no such screen action/.test(UA.validate("settings.open", { page: "voice" }).why));
check("  MODES / PAGES / pageUrl / NAV_PAGES are no longer exported", UA.MODES === undefined && UA.PAGES === undefined && UA.pageUrl === undefined && UA.NAV_PAGES === undefined);
const TIER3 = ["approve", "deny", "approval.approve", "decision.approve", "decision.deny", "credentials.set", "key.set", "users.add", "rules.add", "gate.off", "restart", "deploy", "voice.set", "theme.set", "persona.set", "settings.set", "call.unmute", "eval", "navigate"];
check("no Tier-2 or Tier-3 name exists (approve, deny, keys, users, rules, gate, restart, deploy, settings values, unmute...)", TIER3.every((n) => !UA.validate(n, {}).ok), TIER3.filter((n) => UA.validate(n, {}).ok).join());
check("nothing named like an approval at all", !UA.names().some((n) => /approv|deny|confirm|key|user|rule|gate|restart|deploy|unmute/.test(n)));
check("the sheets are the dock's own (cc-logic) plus everything, and orders (now the Schedules tab of Rules & alerts)", Object.keys(UA.SHEETS).sort().join() === ML.sheetKeys().concat(["everything", "orders"]).sort().join() && !ML.sheetKeys().includes("orders"));
check("sheet.open takes a known sheet only", UA.validate("sheet.open", { key: "missions" }).ok && !UA.validate("sheet.open", { key: "credentials" }).ok && !UA.validate("sheet.open", {}).ok);
check("the mic can be muted, never unmuted", UA.validate("call.mute", {}).ok && UA.validate("call.mute", { on: true }).ok && !UA.validate("call.mute", { on: false }).ok && /never unmuted/.test(UA.validate("call.mute", { on: false }).why));
check("core.set: D or E (A, B and C retired)", !UA.validate("core.set", { core: "B" }).ok && UA.validate("core.set", { core: "D" }).ok && UA.validate("core.set", { core: "E" }).ok && !UA.validate("core.set", { core: "F" }).ok);
check("page.open's built-in map: no page with a side effect or a credentials form (keys/totp/rules sub-paths)", Object.values(UA.BUILTIN_PAGES).every((p) => !/\/(new|delete|clear|totp|rules|code)\b|\/keys\/|\/users\/|\/roles\//.test(p.url)));
check("an action without arguments refuses stray ones", UA.validate("sheet.close", {}).ok && !UA.validate("sheet.close", { key: "x" }).ok);
check("the toast says what Joya did", UA.toast("sheet.open", { key: "missions" }) === "Joya opened Missions" && UA.toast("call.end") === "Joya ended the call" && /approving it is yours/.test(UA.toast("decision.show")));

console.log("\nthe tool the voice sees");
const t = UA.tool();
check("one flat tool, ui_action, with the action as an enum", t.name === "ui_action" && t.parameters.properties.action.enum.join() === UA.names().join() && t.parameters.additionalProperties === false);
check("  its description says approving stays the administrator's click, and no unmute", /cannot approve, deny or confirm/.test(t.description) && /never unmute/.test(t.description));
check("fromTool splits action and args, and names stray fields", JSON.stringify(UA.fromTool({ action: "sheet.open", key: "dec" })) === JSON.stringify({ action: "sheet.open", args: { key: "dec" }, extra: [] }) && UA.fromTool({ action: "view", url: "/x" }).extra.join() === "url");

console.log("\nclosing a named panel (\"close the missions\", «اقفلي المهام»)");
check("sheet.close takes the panel it names (optional), and only a real one", UA.validate("sheet.close", { key: "missions" }).ok && UA.validate("sheet.close", { key: "missions" }).args.key === "missions" && !UA.validate("sheet.close", { key: "odoo" }).ok && !UA.validate("sheet.close", { key: "missions", mode: "live" }).ok);
check("  its toast names it", UA.toast("sheet.close", { key: "missions" }) === "Joya closed Missions" && UA.toast("sheet.close", {}) === "Joya closed the panel");
{
  const d = UA.tool().description;
  check("the tool gives the Arabic panel names (المهام، الميشنز، الجلسات، السيشنز، التكلفة، القرارات)", ["المهام", "الميشنز", "الجلسات", "السيشنز", "التكلفة", "القرارات"].every((w) => d.includes(w)));
  check("  and says closing a panel is sheet.close, never the call", /«اقفلي المهام», «اقفل الميشنز»[^.]*close that PANEL \(sheet\.close\), never the call/.test(d));
  check("  and does not offer «المحادثة» (the conversation) as a panel: that ends the call", !d.includes("المحادثة"));
}
{
  const page = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("the page closes a named panel only if it is the one open", /if \(a\.key && a\.key !== wasC && a\.key !== "everything"\) return \{ ok: false, why: "that panel is not the one open" \};/.test(page));
  for (const f of ["voice-live.js"]) { // the front desk (voice-desk.js) is gone
    const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
    check(`lib/${f}: the instructions say closing a panel is sheet.close, never ending the call`, /Closing a panel \(\\"close the missions\\", «اقفلي المهام», «اقفل الميشنز»\) is sheet\.close, never ending the call/.test(src));
  }
}

console.log("\nTier 2 (Phase 3): preferences, only after a confirm");
{
  const persona = require(path.join(ROOT, "lib", "voice-persona.js"));
  const voice = require(path.join(ROOT, "lib", "voice.js"));
  check("theme.set / persona.set / voice.set are tier 2, on the page", ["theme.set", "persona.set", "voice.set"].every((n) => UA.ACTIONS[n].tier === 2 && UA.ACTIONS[n].where === "page"));
  check("  every other action is tier 1", UA.names().filter((n) => !["theme.set", "persona.set", "voice.set"].includes(n)).every((n) => UA.ACTIONS[n].tier === 1));
  check("the personas are lib/voice-persona.js PRESETS plus learned", Object.keys(UA.PERSONAS).sort().join() === [...Object.keys(persona.PRESETS), "learned"].sort().join());
  // voice.set by voice offers the ten voices every voice model has (lib/voice.js REALTIME_VOICES); GPT-Live's
  // own 21 are chosen on the Settings cards (the supervisor holds an identical copy of this file).
  check("the voices are lib/voice.js REALTIME_VOICES (the ten every model can use)", Object.keys(UA.VOICE_NAMES).sort().join() === [...voice.REALTIME_VOICES].sort().join());
  check("validation: only listed values", UA.validate("theme.set", { theme: "dark" }).ok && !UA.validate("theme.set", { theme: "neon" }).ok && UA.validate("persona.set", { preset: "cairene_f" }).ok && !UA.validate("persona.set", { preset: "evil" }).ok && UA.validate("voice.set", { voice: "cedar" }).ok && !UA.validate("voice.set", { voice: "onyx" }).ok);
  check("the toast is a question, doneText the result", /\?/.test(UA.toast("voice.set", { voice: "cedar" })) && UA.doneText("voice.set", { voice: "cedar" }) === "The voice is now cedar" && UA.doneText("sheet.open", { key: "missions" }) === "Joya opened Missions");
  check("the tool takes theme / preset / voice, and says these need a confirm", ["theme", "preset", "voice"].every((k) => UA.tool().parameters.properties[k]) && /status \\?"confirm\\?"|status "confirm"/.test(UA.tool().description) && /never confirm for them/.test(UA.tool().description));
  check("fromTool keeps them", JSON.stringify(UA.fromTool({ action: "voice.set", voice: "cedar" })) === JSON.stringify({ action: "voice.set", args: { voice: "cedar" }, extra: [] }));
  const proto = fs.readFileSync(path.join(ROOT, "..", "joya-ai", "lib", "protocol.js"), "utf8");
  check("the supervisor's protocol takes exactly the same argument keys", proto.includes("const KEYS = " + JSON.stringify(UA.ARG_KEYS).replace(/,/g, ", ") + ";"));
}
console.log("\npage.open (M-5): another place in Joya, by a key of the page map");
{
  const BUILTIN = ["cc", "settings", "settings.voice", "agents", "sessions", "sessions.live", "telegram", "channels", "addons", "memory", "os", "services", "services.agents", "audit", "users", "roles", "devices", "keys", "firewall", "credentials", "guide", "account"];
  const OLD = ["os-overview", "agents", "agents-fleet", "agents-channels", "agents-addons", "agents-services", "os-services", "os-audit", "os-firewall", "manage-credentials", "manage-ssh-keys", "manage-devices", "manage-users", "manage-roles", "claude-memory", "claude-sessions", "claude-running", "guide", "account", "voice-settings", "command-center"];
  UA.setPages(null);
  check("until the first scan: exactly the built-in pages", Object.keys(UA.pages()).join() === BUILTIN.join() && Object.keys(UA.BUILTIN_PAGES).join() === BUILTIN.join(), Object.keys(UA.pages()).join());
  check("tier 1, on the page, once per turn", UA.ACTIONS["page.open"].tier === 1 && UA.ACTIONS["page.open"].where === "page" && UA.ACTIONS["page.open"].once === true);
  check("a key only, never a URL or a path (stray fields are not carried)", UA.validate("page.open", { page: "audit" }).ok && !UA.validate("page.open", { page: "/audit" }).ok && !UA.validate("page.open", { page: "https://evil.example" }).ok && !UA.validate("page.open", {}).ok && JSON.stringify(UA.validate("page.open", { page: "audit", key: "x" }).args) === '{"page":"audit"}');
  check("every target is a same-site path with its permission (guide, account and your own devices need none)", Object.entries(UA.pages()).every(([k, v]) => /^\/[a-z/?=.-]*$/.test(v.url) && v.label && (v.perm === null ? ["guide", "account", "devices"].includes(k) : /^[a-z.]+$/.test(v.perm))));
  check("all 21 old keys still validate, to their new key", OLD.every((k) => UA.validate("page.open", { page: k }).ok) && UA.validate("page.open", { page: "os-audit" }).args.page === "audit" && UA.validate("page.open", { page: "claude-running" }).args.page === "sessions.live" && UA.validate("page.open", { page: "voice-settings" }).args.page === "settings.voice", OLD.filter((k) => !UA.validate("page.open", { page: k }).ok).join());
  check("  the legacy map names only keys of the built-in map", Object.values(UA.LEGACY_PAGES).every((k) => BUILTIN.includes(k)));
  check("navPage / navKeysFor follow the role", UA.navPage("audit").url === "/audit" && UA.navPage("os-audit").url === "/audit" && UA.navPage("nope") === null && UA.navKeysFor((p) => p === "os.view").join() === "os,devices,guide,account", UA.navKeysFor((p) => p === "os.view").join());
  check("the toast names the page", UA.toast("page.open", { page: "audit" }) === "Joya opened Audit log");
  const L = UA.limiter();
  check("once per turn", L.take("p1", "page.open", 1) === null && /already done/.test(L.take("p1", "page.open", 2)));

  // The map changes as Joya grows (Settings > Screen control): setPages().
  const n = UA.setPages([
    { key: "os", url: "/os", label: "Machine overview", perm: "os.view", kind: "page" },
    { key: "guide.voice", url: "/guide#voice", label: "Talking to JOYA AI", perm: null, kind: "anchor", parent: "guide" },
    { key: "evil", url: "https://evil.example/", label: "x" },
    { key: "evil2", url: "//evil.example/", label: "x" },
    { key: "Bad Key", url: "/x", label: "x" },
    { key: "quote", url: '/x"onmouseover=1', label: "x" },
  ]);
  check("setPages takes a list, and skips entries whose url is not a path of this site or whose key is bad", n === 2 && Object.keys(UA.pages()).join() === "os,guide.voice", Object.keys(UA.pages()).join());
  check("  page.open then validates against the new map only", UA.validate("page.open", { page: "guide.voice" }).ok && !UA.validate("page.open", { page: "audit" }).ok && !UA.validate("page.open", { page: "evil" }).ok);
  check("  an old key still works when its new key is in the map, not otherwise", UA.validate("page.open", { page: "os-overview" }).ok && !UA.validate("page.open", { page: "os-audit" }).ok);
  check("  the catalog lists the map in use", Object.keys(UA.catalog().actions.find((a) => a.action === "page.open").args.page.values).join() === "os,guide.voice");
  check("  and the tool's description too", /guide\.voice/.test(UA.tool().description));
  UA.setPages(null);
  check("setPages(null) goes back to the built-in pages", Object.keys(UA.pages()).length === BUILTIN.length && UA.validate("page.open", { page: "audit" }).ok);

  const t = UA.tool();
  check("the tool's page argument is a free string (no enum): the schema stays stable as the map changes", t.parameters.properties.page.type === "string" && !t.parameters.properties.page.enum);
  check("  and the description says what page.open is for", /page\.open/.test(t.description));
  const page = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("the Command Center checks the role (data-pages) before moving", /case "page\.open"/.test(page) && /data-pages|dataset\.pages/.test(page));
  check("the Command Center page carries data-pages", /data-pages=/.test(fs.readFileSync(path.join(ROOT, "lib", "views-joyaai.js"), "utf8")) || /data-pages=/.test(fs.readFileSync(path.join(ROOT, "lib", "ui.js"), "utf8")));
  for (const f of ["voice-live.js", "voice-desk.js"]) if (fs.existsSync(path.join(ROOT, "lib", f))) check(`lib/${f} tells the voice about page.open`, /page\.open/.test(fs.readFileSync(path.join(ROOT, "lib", f), "utf8")));
  check("the supervisor's copy is byte-identical", fs.readFileSync(path.join(ROOT, "public", "ui-actions.js"), "utf8") === fs.readFileSync(path.join(ROOT, "..", "joya-ai", "lib", "ui-actions.js"), "utf8"));
}

console.log("\nthe MCP catalog (ui_actions_list) and ui_do's stable schema");
{
  const c = UA.catalog();
  check("the catalog lists every action, with what it does", c.actions.map((a) => a.action).join() === UA.names().join() && c.actions.every((a) => a.what));
  check("  needs_confirm is exactly tier 2", c.actions.every((a) => a.needs_confirm === (UA.ACTIONS[a.action].tier === 2)));
  const bad = [];
  c.actions.forEach((a) => Object.entries(a.args).forEach(([k, spec]) => Object.keys(spec.values).forEach((v) => { const o = {}; o[k] = k === "on" ? true : v; if (!UA.validate(a.action, o).ok) bad.push(a.action + " " + k + "=" + v); })));
  check("  every value it lists is accepted by validate()", bad.length === 0, bad.join(", "));
  const noArgs = c.actions.filter((a) => !Object.keys(a.args).length).map((a) => a.action);
  check("  an action it lists without arguments validates with none", noArgs.every((n) => UA.validate(n, {}).ok), noArgs.join());
  check("  a required argument it lists is really required", c.actions.every((a) => Object.entries(a.args).every(([k, spec]) => !spec.required || !UA.validate(a.action, {}).ok)));
  const sch = UA.stableSchema();
  check("ui_do's schema: action a plain string, every argument key, no enum", sch.properties.action.type === "string" && !/enum/.test(JSON.stringify(sch)) && Object.keys(sch.properties).join() === ["action"].concat(UA.ARG_KEYS).join() && sch.additionalProperties === false);
  // A resumed claude CLI keeps the schema it first loaded: it must never change, whatever is added.
  check("ARG_KEYS are fixed forever (\"mode\" stays though voice.mode is gone)", UA.ARG_KEYS.join() === "key,mode,name,core,page,on,theme,preset,voice", UA.ARG_KEYS.join());
  const SNAPSHOT = '{"type":"object","properties":{"action":{"type":"string","description":"An action name from ui_actions_list."},"key":{"type":"string","description":"As ui_actions_list gives for the action."},"mode":{"type":"string","description":"As ui_actions_list gives for the action."},"name":{"type":"string","description":"As ui_actions_list gives for the action."},"core":{"type":"string","description":"As ui_actions_list gives for the action."},"page":{"type":"string","description":"As ui_actions_list gives for the action."},"on":{"type":"boolean","description":"call.mute only: true (muting; never unmuting)"},"theme":{"type":"string","description":"As ui_actions_list gives for the action."},"preset":{"type":"string","description":"As ui_actions_list gives for the action."},"voice":{"type":"string","description":"As ui_actions_list gives for the action."}},"required":["action"],"additionalProperties":false}';
  check("stableSchema() is byte-for-byte the snapshot", JSON.stringify(sch) === SNAPSHOT, JSON.stringify(sch));
  UA.setPages([{ key: "only", url: "/only", label: "Only" }]);
  check("  and does not move when the page map does", JSON.stringify(UA.stableSchema()) === SNAPSHOT);
  UA.setPages(null);
}

console.log("\nTier 3: never by voice or AI -- no action names at all");
check("nothing about keys, users, roles, 2FA, rules, watchers, voice mode, budget, orders, restart, deploy, approve", !UA.names().some((n) => /key|user|role|totp|2fa|password|rule|watcher|desk|budget|order|restart|deploy|approve|deny|fresh|gate|credential|service|firewall/.test(n)), UA.names().join());

console.log("\nrate limits");
{
  const L = UA.limiter();
  const r = [];
  for (let i = 0; i < 7; i++) r.push(L.take("t1", "sheet.open", 1000 + i));
  check("at most 6 per turn", r.slice(0, 6).every((x) => x === null) && /one turn/.test(r[6]));
  check("call.end and page.open once per turn", L.take("t2", "call.end", 2000) === null && /already done/.test(L.take("t2", "call.end", 2001)) && L.take("t3", "page.open", 2002) === null && !!L.take("t3", "page.open", 2003));
  const M = UA.limiter();
  let last = null;
  for (let i = 0; i < 21; i++) last = M.take("turn" + i, "sheet.open", 5000 + i);
  check("at most 20 a minute", /this minute/.test(last));
  check("  and fine again a minute later", M.take("later", "sheet.open", 5000 + 61000) === null);
}

console.log("\nclaims the guard holds to a real ui_action");
check("English: \"I opened Missions\", \"I've ended the call\", \"I muted the microphone\"", UA.claims("i opened missions") && UA.claims("i've ended the call") && UA.claims("i muted the microphone"));
check("Arabic: «فتحتلك», «قفلتلك», «كتمت»", UA.claims("فتحتلك ال missions") && UA.claims("قفلتلك المكالمه") && UA.claims("كتمت المايك"));
check("not a claim: \"I can open Missions\", \"want me to open it?\"", !UA.claims("i can open missions") && !UA.claims("want me to open it"));

console.log("\nthe file");
const src = fs.readFileSync(path.join(ROOT, "public", "ui-actions.js"), "utf8");
check("pure (no DOM, no fetch, no storage) and loaded by the page before joya-ai.js", !/document|localStorage|fetch\(|XMLHttpRequest/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && /"ui-actions\.js", "joya-ai\.js"/.test(fs.readFileSync(path.join(ROOT, "lib", "views-joyaai.js"), "utf8")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
