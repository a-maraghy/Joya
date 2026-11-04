#!/usr/bin/env node
"use strict";
/**
 * The living canvas's layout policy and its learning verdicts (public/joya-canvas-policy.js). Pure.
 *
 *     node dashboard/tools/test-canvas-policy.cjs
 */
const path = require("path");
const P = require(path.join(__dirname, "..", "public", "joya-canvas-policy.js"));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 700) : "")); }
}
const section = (t) => console.log("\n" + t);
const NOW = Date.parse("2026-10-20T07:30:00Z"), M = 60e3, H = 3600e3;
const QUIET = ["metric:usage.spend", "metric:sessions", "metric:approvals"];
const base = (o) => Object.assign({ now: NOW, hour: 9, small: false, brief: null, sessions: [], failures: [], acked: {}, pinned: [], offered: [], standing: [], quiet: QUIET, locked: false }, o || {});
const slots = (p) => p.tiles.map((t) => t.type + ":" + t.slot + ":" + t.size).join(" ");

section("calm: the core and a few quiet tiles");
{
  const p = P.plan(base());
  check("nothing happening: mode calm, no hero", p.mode === "calm" && p.hero === null && p.why === "all calm");
  check("  three quiet tiles, small, on the right", p.tiles.length === 3 && p.tiles.every((t) => t.type === "standing" && t.quiet && t.size === "s" && t.slot === "right"), slots(p));
  check("  idle and working sessions do not disturb it", P.plan(base({ sessions: [{ key: "a", name: "A", state: "working", since: NOW - 3 * H }, { key: "b", name: "B", state: "idle" }] })).mode === "calm");
  check("  a short wait (5 min) does not either", P.plan(base({ sessions: [{ key: "a", name: "A", state: "waiting", since: NOW - 5 * M }] })).mode === "calm");
  check("  quiet tiles put away are not drawn", P.plan(base({ quiet: ["metric:sessions"] })).tiles.length === 1);
}

section("the morning brief takes the centre");
{
  const brief = { id: 7, kind: "brief", at: NOW - 40 * M };
  const p = P.plan(base({ brief, pinned: [{ id: "p1", key: "chart:usage.spend", size: "l" }] }));
  check("a fresh brief at 09:00: mode brief, the brief is the hero", p.mode === "brief" && p.hero && p.hero.type === "brief" && p.hero.id === 7, JSON.stringify(p.hero));
  check("  pinned widgets step down to small while it is", p.tiles.find((t) => t.id === "p1").size === "s");
  check("not in the afternoon (hour 15)", P.plan(base({ brief, hour: 15 })).mode === "calm");
  check("not before 05:00", P.plan(base({ brief, hour: 4 })).mode === "calm");
  check("not once it is 3 h old", P.plan(base({ brief: { id: 7, kind: "brief", at: NOW - 3 * H - M } })).mode === "calm");
  check("a catch-up is fresh 30 min, at any hour", P.plan(base({ brief: { id: 8, kind: "catchup", at: NOW - 20 * M }, hour: 16 })).mode === "brief" && P.plan(base({ brief: { id: 8, kind: "catchup", at: NOW - 31 * M }, hour: 16 })).mode === "calm");
}

section("a session fails or waits long: its card grows");
{
  const fail = { id: 41, key: "s-plan", name: "Planning engine", at: new Date(NOW - 12 * M).toISOString(), status: "failed", text: "ImportError: pandas" };
  const p = P.plan(base({ failures: [fail], brief: { id: 7, kind: "brief", at: NOW - 10 * M }, pinned: [{ id: "p1", key: "list:sessions", size: "m" }] }));
  check("a failure beats the brief: mode incident, that session is the hero with its error", p.mode === "incident" && p.hero.type === "session" && p.hero.key === "s-plan" && p.hero.reason === "failed" && p.hero.text === "ImportError: pandas", JSON.stringify(p.hero));
  check("  pinned widgets step down to small", p.tiles.find((t) => t.id === "p1").size === "s");
  check("  why: the session and what happened", /Planning engine's work failed/.test(p.why), p.why);
  check("a held delegation counts too", P.plan(base({ failures: [Object.assign({}, fail, { status: "held" })] })).hero.reason === "held");
  check("a delegation still working does not", P.plan(base({ failures: [Object.assign({}, fail, { status: "working" })] })).mode === "calm");
  check("an old failure (2 h+) does not", P.plan(base({ failures: [Object.assign({}, fail, { at: NOW - 2 * H - M })] })).mode === "calm");
  check("put away (acked): back to calm", P.plan(base({ failures: [fail], acked: { "f:41": 1 } })).mode === "calm");
  const wait = { key: "s-audit", name: "Invoice audit", state: "waiting", since: NOW - 25 * M, waiting_for: "your approval" };
  const pw = P.plan(base({ sessions: [wait] }));
  check("waiting 25 min (>= 10): incident, the waiting session is the hero, how long it has waited", pw.mode === "incident" && pw.hero.reason === "waiting" && pw.hero.key === "s-audit" && /waited on you 25 min/.test(pw.why), JSON.stringify(pw));
  check("  its incident id carries when it began waiting: a new wait is a new incident", pw.hero.id === "w:s-audit@" + (NOW - 25 * M));
  const both = P.plan(base({ sessions: [wait, { key: "s-x", name: "X", state: "waiting", since: NOW - 50 * M }], failures: [fail] }));
  check("several: the failure is the hero, the waits are small cards on the right (longest wait first)", both.hero.key === "s-plan" && both.tiles.filter((t) => t.type === "incident").map((t) => t.key).join() === "s-x,s-audit", slots(both));
  check("one session, one incident (a failure and a wait of the same session)", P.incidents(base({ sessions: [{ key: "s-plan", name: "Planning engine", state: "waiting", since: NOW - 30 * M }], failures: [fail] })).length === 1);
  const two = P.incidents(base({ failures: [fail, Object.assign({}, fail, { id: 42, key: "s-c", name: "C", at: NOW - 2 * M })] }));
  check("failures newest first", two[0].key === "s-c" && two[1].key === "s-plan");
}

section("widgets: an answer beside the reply, pins on the board");
{
  const p = P.plan(base({ offered: [{ id: "o1", key: "chart:usage.spend" }], pinned: [{ id: "p1", key: "table:payload", size: "l" }, { id: "p2", key: "list:sessions", size: "m" }] }));
  check("board mode; an answer goes to the centre (under the core); pinned keep their size, left first", p.mode === "board" && p.tiles[0].slot === "centre" && p.tiles.find((t) => t.id === "p1").size === "l" && p.tiles.find((t) => t.id === "p1").slot === "left", slots(p));
  check("  quiet tiles still there, but not of a kind already shown", P.plan(base({ pinned: [{ id: "p1", key: "metric:usage.spend", size: "s" }] })).tiles.filter((t) => t.key === "metric:usage.spend").length === 1);
  const inc = P.plan(base({ offered: [{ id: "o1", key: "chart:usage.spend" }], sessions: [{ key: "a", name: "A", state: "waiting", since: NOW - 20 * M }] }));
  check("with a hero in the centre, an answer moves to the right", inc.tiles.find((t) => t.id === "o1").slot === "right");
  check("at most two answers at once", P.plan(base({ offered: [1, 2, 3].map((i) => ({ id: "o" + i, key: "list:payload" })) })).tiles.filter((t) => t.type === "offered").length === 2);
  const many = P.plan(base({ pinned: Array.from({ length: 9 }, (_, i) => ({ id: "p" + i, key: "list:payload", size: "m" })) }));
  check("4 to a column; past that on the right, small", many.tiles.filter((t) => t.slot === "left").length === 4 && many.tiles.filter((t) => t.type === "pinned" && t.slot === "right").every((t, i) => i < 4 || t.size === "s"), slots(many));
  const learned = P.plan(base({ standing: ["chart:usage.spend"] }));
  check("a learned standing tile replaces the default quiet ones (calm adds them back)", learned.tiles.some((t) => t.key === "chart:usage.spend" && t.type === "standing"));
  const bd = P.plan(base({ standing: ["chart:usage.spend"], pinned: [{ id: "p", key: "list:payload", size: "m" }] }));
  check("  on a board with widgets: only the learned one", bd.tiles.filter((t) => t.type === "standing").map((t) => t.key).join() === "chart:usage.spend");
}

section("a phone");
{
  const p = P.plan(base({ small: true, pinned: [{ id: "p1", key: "list:payload", size: "m" }] }));
  check("no side columns: pinned and quiet tiles go to the tray under the core", p.tiles.every((t) => t.slot === "tray" || t.slot === "centre"), slots(p));
  check("  at most two quiet tiles", p.tiles.filter((t) => t.type === "standing").length <= 2);
}

section("locked");
{
  const fail = { id: 41, key: "s-plan", name: "Planning engine", at: NOW - 12 * M, status: "failed", text: "x" };
  const p = P.plan(base({ locked: true, failures: [fail], brief: { id: 1, kind: "brief", at: NOW - M }, pinned: [{ id: "p1", key: "list:payload", size: "l" }] }));
  check("nothing grows: no hero, pinned keep their size", p.locked && p.hero === null && p.tiles.find((t) => t.id === "p1").size === "l" && p.mode === "board");
  check("  what would have changed it is listed for a badge (the failure, the brief)", p.attention.length === 2 && p.attention[0].key === "s-plan" && p.attention[1].reason === "brief", JSON.stringify(p.attention));
  check("  no incident cards either", !p.tiles.some((t) => t.type === "incident"));
}

section("learning: what you keep");
{
  const L = P.learn([
    { key: "chart:usage.spend", offered: 5, pins: 3, dismissals: 1, opens: 2 },
    { key: "table:payload", offered: 4, pins: 0, dismissals: 4, opens: 0 },
    { key: "list:sessions", offered: 4, pins: 0, dismissals: 3, opens: 1 },
    { key: "story:story", offered: 3, pins: 3, dismissals: 2, opens: 0 },
    { key: "files:story", offered: 2, pins: 0, dismissals: 2, opens: 0 },
  ]);
  check("pinned 3x, dismissed once: standing", L.standing.indexOf("chart:usage.spend") >= 0);
  check("always dismissed (4x, never pinned or opened): not offered", L.suppressed.join() === "table:payload", L.suppressed.join());
  check("dismissed 3x but opened once: still offered", L.suppressed.indexOf("list:sessions") < 0);
  check("pinned 3x but dismissed 2x (less than twice as often): not standing", L.standing.indexOf("story:story") < 0);
  check("dismissed only twice: still offered", L.suppressed.indexOf("files:story") < 0);
  check("each row carries its verdict for Settings", L.rows.find((r) => r.key === "table:payload").verdict === "not offered" && L.rows.find((r) => r.key === "chart:usage.spend").verdict === "standing");
  check("nothing learned from nothing", P.learn([]).standing.length === 0 && P.learn(null).suppressed.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
