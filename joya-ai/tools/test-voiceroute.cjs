#!/usr/bin/env node
"use strict";
/**
 * Where a live call's request goes (lib/voiceroute.js), the voice lanes' pure parts (lib/voicelane.js)
 * and the weather tool (lib/weather.js, against a fake HTTP client). No processes, no network.
 *
 *     node joya-ai/tools/test-voiceroute.cjs
 */
const path = require("path");
const route = require(path.join(__dirname, "..", "lib", "voiceroute.js"));
const lane = require(path.join(__dirname, "..", "lib", "voicelane.js"));
const { weather } = require(path.join(__dirname, "..", "lib", "weather.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}

const agents = route.agentNames(
  [{ name: "JOYA AI", self: true }, { name: "JOYA Pace" }, { name: "[GSH] Planning Automation" }, { name: "Joya Builder" }, { name: "joya-internal-voice-lvx-work1" }],
  [{ name: "Report Writer", status: "hired" }, { name: "Old Hire", status: "retired" }],
  { "[GSH] Planning Automation": ["giza odoo automation", "odoo automation"], "JOYA Pace": ["جويا بيس"] }
);
check("agentNames: live sessions and hired ones, never JOYA AI itself, an internal session or a retired hire", agents.map((a) => a.name).join("|") === "JOYA Pace|[GSH] Planning Automation|Joya Builder|Report Writer", JSON.stringify(agents.map((a) => a.name)));
check("  a [TAG] prefix is optional when naming it, and the administrator's aliases count", agents[1].words.includes("planning automation") && agents[1].words.includes("giza odoo automation"));

// The requests of call lv1jz4g (2026-10-30), and others.
const table = [
  ["[speaker: Abdul] Um, can you tell me what's the weather like today", "quick"],
  ["[speaker: Abdul] Uh, I live in the 6th of October", "work"],
  ["[speaker: Abdul] ممكن تقولي آخر حاجة اشتغلنا عليها في أودو كانت ايه", "work"],
  ["[speaker: Abdul] ممكن تقولي ايه اللي قدامي على الشاشة", "work"],
  ["what time is it", "quick"],
  ["الجو عامل ايه النهارده", "quick"],
  ["how many grams in a pound", "quick"],
  ["what is photosynthesis", "quick"],
  ["what is the disk usage", "work"],
  ["restart odoo", "work"],
  ["what is the weather in the server room", "work"],
  ["what's the status of the backups", "work"],
  ["open the missions panel", "work"],
  ["ask JOYA Pace whether my inbox has anything urgent", "agent"],
  ["JOYA Pace, what is on my calendar?", "agent"],
  ["tell planning automation to run the tests", "agent"],
  ["اسأل planning automation عن آخر حاجة", "agent"],
  ["Ask Giza Odoo Automation for its status", "agent"],
  ["what did JOYA Pace do yesterday", "work"],
  ["have the report writer draft the summary", "agent"],
];
for (const [text, want] of table) {
  const r = route.classify(text, { agents });
  check(`classify -> ${want}: ${text}`, r.lane === want, JSON.stringify(r));
}
check("  the agent named is the one routed to", route.classify("tell planning automation to run the tests", { agents }).agent.name === "[GSH] Planning Automation");
check("  a name merely mentioned (not addressed) is no hand-over", !route.findAgent("did planning automation finish?", agents));
check("  a name inside a longer word is not that agent", !route.findAgent("ask joya pacers about it", agents));

// D: folding a follow-up
const now = 100000;
const young = { source: "voice-desk", call: "lvx", startedMs: now - 5000, wrote: false, approvals: 0, tools: [{ name: "WebFetch" }, { name: "mcp__memory__memory_search" }] };
check("foldable: young, nothing written, only reads", route.foldable(young, { call: "lvx", now, maxMs: 45000 }).ok);
check("  not once it has written its answer", !route.foldable({ ...young, wrote: true }, { call: "lvx", now, maxMs: 45000 }).ok);
check("  not while it waits on an approval", !route.foldable({ ...young, approvals: 1 }, { call: "lvx", now, maxMs: 45000 }).ok);
check("  not after it ran something that changes things", !route.foldable({ ...young, tools: [{ name: "SendMessage" }] }, { call: "lvx", now, maxMs: 45000 }).ok && route.foldable({ ...young, tools: [{ name: "Bash", harmless: true }] }, { call: "lvx", now, maxMs: 45000 }).ok);
check("  not when it is old, or another call's", !route.foldable({ ...young, startedMs: now - 60000 }, { call: "lvx", now, maxMs: 45000 }).ok && !route.foldable(young, { call: "lvy", now, maxMs: 45000 }).ok);
check("foldedText keeps the first request first and marks the follow-up", /^what's the weather\n\n\[Said next, before you had answered/.test(route.foldedText("what's the weather", "I live in 6th of October")));

// voicelane: argv and preface
const cfg = { voice_quick_model: "claude-haiku-5-5", voice_lane_model: "claude-sonnet-5", voice_lane_effort: "medium", permission_mode: "auto", cli_extra_args: [] };
const qa = lane.argvFor({ kind: "quick", name: "joya-internal-voice-lvx-quick1", sessionId: "11111111-1111-1111-1111-111111111111", cfg, quickMcp: { "joya-quick": {}, memory: {} } });
check("argvFor quick: no charter, no machine tools, memory search only", qa.includes("--strict-mcp-config") && qa[qa.indexOf("--tools") + 1] === "WebSearch,WebFetch" && qa.includes("mcp__memory__memory_search") && qa.includes("mcp__joya-quick") && qa[qa.indexOf("--disallowedTools") + 1] === "mcp__memory__memory_store" && qa[qa.indexOf("--setting-sources") + 1] === "user");
const wa = lane.argvFor({ kind: "work", name: "n", sessionId: "22222222-2222-2222-2222-222222222222", cfg, mcp: ["--mcp-config", "{}", "--allowedTools", "mcp__joya-ai"] });
check("argvFor work: its model and effort, the permission prompt on stdio, a fresh session id", wa[wa.indexOf("--model") + 1] === "claude-sonnet-5" && wa[wa.indexOf("--effort") + 1] === "medium" && wa[wa.indexOf("--permission-prompt-tool") + 1] === "stdio" && wa[wa.indexOf("--session-id") + 1] === "22222222-2222-2222-2222-222222222222" && !wa.includes("--resume"));
const pf = lane.prefaceFor([{ id: 1, text: "weather?", reply: "Sunny, 25." }, { id: 2, text: "disk?", running: true }, { id: 3, text: "seen one", reply: "x" }], new Set([3]), 4);
check("prefaceFor: what the lane did not see, answers clipped, running ones marked", /They asked: "weather\?" -- you answered: "Sunny, 25\."/.test(pf) && /disk\?" \(still being answered separately\)/.test(pf) && !/seen one/.test(pf));
check("nowNote dates a quick question in the administrator's zone", /^\[Now: \w{3}, \d{1,2} \w{3} 2026, \d\d:\d\d \(Africa\/Cairo\)\]$/.test(lane.nowNote(Date.parse("2026-10-30T12:28:00Z"), "Africa/Cairo")), lane.nowNote(Date.parse("2026-10-30T12:28:00Z"), "Africa/Cairo"));
check("langNote: the request's own words decide (a speaker tag and notes aside)", /English/.test(lane.langNote("[speaker: Abdul] what's the weather like today\n\n[Screen: ... «عربي» ...]")) && /Egyptian Arabic/.test(lane.langNote("الجو عامل ايه النهارده")) && /Egyptian Arabic/.test(lane.langNote("ممكن تقولي آخر حاجة في Odoo")));
check("ESCALATE is recognised only as the answer itself", lane.ESCALATE_RE.test("ESCALATE") && lane.ESCALATE_RE.test(" **ESCALATE**") && !lane.ESCALATE_RE.test("It is sunny. ESCALATE"));

// weather, with a fake HTTP client
(async () => {
  const urls = [];
  const fake = async (url) => {
    urls.push(url);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes("geocoding")) return ok({ results: [{ name: "Village", latitude: 1, longitude: 1, population: 10 }, { name: "6th of October City", latitude: 29.82, longitude: 31.05, population: 368650, country: "Egypt", admin1: "Giza Governorate", timezone: "Africa/Cairo" }] });
    return ok({ current: { time: "2026-10-30T14:00", temperature_2m: 24.6, apparent_temperature: 22.3, relative_humidity_2m: 36, wind_speed_10m: 12.4, weather_code: 1 }, daily: { time: ["2026-10-30"], temperature_2m_max: [25.4], temperature_2m_min: [14.8], precipitation_probability_max: [0], weather_code: [2] } });
  };
  const w = await weather({ place: "6th of october", days: 1 }, { fetch: fake });
  check("weather: the spoken alias is looked up as the city, the most populous match wins", w.place === "6th of October City, Giza Governorate, Egypt" && /name=6th%20of%20October%20City/.test(urls[0]), JSON.stringify(w) + " " + urls[0]);
  check("  current conditions in words and whole units", w.current.sky === "mainly clear" && w.current.temp_c === 25 && w.current.feels_like_c === 22 && w.current.wind_kmh === 12 && w.days[0].low_c === 15 && w.days[0].high_c === 25 && w.days[0].rain_chance_pct === 0 && w.source === "Open-Meteo", JSON.stringify(w));
  check("  the forecast asks for the place's own time zone", /timezone=Africa%2FCairo/.test(urls[1]));
  let err = null;
  try {
    await weather({ place: "nowhere-at-all" }, { fetch: async () => ({ ok: true, json: async () => ({}) }) });
  } catch (e) {
    err = e.message;
  }
  check("  an unknown place is said plainly", /no place called "nowhere-at-all"/.test(err || ""), err);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
