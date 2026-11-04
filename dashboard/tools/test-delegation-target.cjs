#!/usr/bin/env node
"use strict";
/**
 * Who a delegation's dot stream goes to (public/cc-logic.js resolveTarget /
 * resolveFrom / makeAliases / ghostWhere), on DEMO data shaped like the real
 * ledger of 2026-09-30: 52 delegations and 3 live sessions, where the old
 * name-or-pid match found only 22 (a session renamed, restarted with a new pid,
 * an old name, a sub-agent id, denied rows with no target). Plus the page and
 * map wiring (joya-ai.js, cc-map.js, cc-family.js).
 *
 *     node dashboard/tools/test-delegation-target.cjs
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const L = require(path.join(ROOT, "public", "cc-logic.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 400) : "")); }
}

// Demo ids and names (the real ledger's shape, none of its data).
const OS = "11111111-aaaa-4aaa-8aaa-000000000001"; // the build session: "Demo Agent OS", later renamed "Demo OS"
const OS_OLD = "11111111-aaaa-4aaa-8aaa-000000000009"; // an older session that also used the old name
const ODOO = "22222222-bbbb-4bbb-8bbb-000000000002";
const E2E = "33333333-cccc-4ccc-8ccc-000000000003";
const UI = "44444444-dddd-4ddd-8ddd-000000000004";
const SESSIONS = [
  { pid: 5001, session_id: OS, name: "Demo OS", kind: "interactive", where: "Claude Desktop · Remote Control", self: false },
  { pid: 5002, session_id: ODOO, name: "Demo Odoo", kind: "interactive", where: "Claude Desktop · Remote Control", self: false },
  { pid: 5000, session_id: "55555555-eeee-4eee-8eee-000000000005", name: "JOYA AI", self: true },
];
const rows = [];
let id = 0;
const add = (n, o) => { for (let i = 0; i < n; i++) rows.push({ id: ++id, status: "done", ...o }); };
add(2, { target_name: "demo-e2e-target", target_pid: 4001, target_session: E2E });
add(2, { target_name: "demo-ui-test", target_pid: 4002, target_session: UI });
add(1, { target_name: "demo-ui-test", target_pid: null, target_session: null, status: "denied" });
add(2, { target_name: "demo-ui-test", target_pid: 4002, target_session: UI });
add(1, { target_name: "demo-ui-test", target_pid: null, target_session: null, status: "denied" });
add(2, { target_name: "Demo Agent OS", target_pid: 4003, target_session: OS_OLD });
add(3, { target_name: "Demo Agent OS", target_pid: 4004, target_session: OS }); // #11-13: old name, old pid, today's session
add(12, { target_name: "Demo Agent OS", target_pid: 4005, target_session: OS }); // #14-25: restarted (new pid)
add(1, { target_name: "af3216f9a333c5215", target_pid: null, target_session: null, status: "failed" }); // #26: a sub-agent id
add(3, { target_name: "Demo Agent OS", target_pid: 4005, target_session: OS }); // #27-29
add(1, { target_name: "Demo Agent OS", target_pid: null, target_session: null, status: "denied" }); // #30
add(2, { target_name: "Demo Agent OS", target_pid: 5001, target_session: OS }); // #31-32
add(16, { target_name: "Demo OS", target_pid: 5001, target_session: OS }); // #33-48: renamed
add(1, { target_name: "Demo Odoo", target_pid: 5002, target_session: ODOO }); // #49
add(3, { target_name: "Demo OS", target_pid: 5001, target_session: OS }); // #50-52

console.log("resolution by stable id (the real ledger's shape)");
{
  check("the fixture has the real shape: 52 delegations, 3 sessions", rows.length === 52 && SESSIONS.length === 3);
  const al = L.makeAliases();
  al.learnSessions(SESSIONS);
  rows.forEach((d) => al.learnDelegation(d));
  const got = rows.map((d) => ({ d, r: L.resolveTarget(d, SESSIONS, al) }));
  const ok = got.filter((x) => x.r.session).length;
  const oldWay = rows.filter((d) => SESSIONS.some((s) => d.target_pid && s.pid === d.target_pid) || SESSIONS.some((s) => !s.self && s.name === d.target_name)).length;
  check(`the old pid-or-exact-name match found ${oldWay} of 52; by session id first: ${ok}`, oldWay === 22 && ok === 40, `${oldWay} / ${ok}`);
  const os = (n) => got[n - 1].r.session && got[n - 1].r.session.session_id === OS;
  check("#11-25 and #27-29 (old name, old or new pid) all go to today's build session by target_session", [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29].every(os));
  check("#49 goes to Demo Odoo; #52 to Demo OS", got[48].r.session.session_id === ODOO && os(52));
  check("#9-10 (an older session with the old name, not live): no sphere (gone)", !got[8].r.session && got[8].r.why === "gone");
  check("#26, a sub-agent id: no sphere; the marker says sub-agent", !got[25].r.session && L.ghostWhere(got[25].d, got[25].r.why) === "sub-agent");
  check("#30 (old name, no ids; that name was used by two sessions): no sphere", !got[29].r.session);
  check("the JOYA AI session itself is never a target", !got.some((x) => x.r.session && x.r.session.self));
}

console.log("\nnames, namesakes, renames, restarts");
{
  check("normName: [ref] dropped, case and spaces/dashes/underscores folded (as joya-ai/lib/names.js)", L.normName("Demo_Agent-OS [a1b2c3]") === "demo agent os" && L.normName("  Demo  OS ") === "demo os");
  const two = [{ pid: 1, session_id: "s1", name: "Twin" }, { pid: 2, session_id: "s2", name: "twin" }];
  const r = L.resolveTarget({ target_name: "Twin" }, two, null);
  check("two live sessions with the same (normalised) name: ambiguous, no sphere", !r.session && r.why === "ambiguous" && /more than one/.test(L.ghostWhere({ target_name: "Twin" }, r.why)));
  check("  but a session id still picks the right one", L.resolveTarget({ target_name: "Twin", target_session: "s2" }, two, null).session.pid === 2);
  const renamed = [{ pid: 9, session_id: "s9", name: "New Name" }];
  const al = L.makeAliases();
  al.learnSessions([{ pid: 8, session_id: "s9", name: "Old Name" }]);
  check("a renamed session: its old name still finds it (alias table from sessions events)", L.resolveTarget({ target_name: "Old Name" }, renamed, al).session.pid === 9);
  check("a restarted session (new pid, same session id): found by session id", L.resolveTarget({ target_name: "New Name", target_pid: 3, target_session: "s9" }, renamed, al).session.pid === 9);
  check("a stale session id falls through to the pid", L.resolveTarget({ target_pid: 9, target_session: "zz" }, renamed, al).session.pid === 9);
  check("remote / sub-agent / unknown kinds label the marker", L.ghostWhere({ target_kind: "remote" }) === "Remote" && L.ghostWhere({ target_kind: "subagent" }) === "sub-agent" && L.ghostWhere({ target_name: "gone" }, "gone") === "offline");
  check("inbound: from_pid first, then a unique normalised name; namesakes -> nobody", L.resolveFrom({ from_pid: 2, from_name: "Twin" }, two).session_id === "s2" && L.resolveFrom({ from_name: "twin" }, two) === null && L.resolveFrom({ from_name: "new-name" }, renamed).pid === 9);
}

console.log("\nthe page and the map");
{
  const pg = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  const map = fs.readFileSync(path.join(ROOT, "public", "cc-map.js"), "utf8");
  const fam = fs.readFileSync(path.join(ROOT, "public", "cc-family.js"), "utf8");
  check("every new delegation re-aims the stream: its sphere, or send(null) + the edge marker", /if \(s && Orb\.send\(sessKey\(s\), 2600\)\) highlightSess\(sessKey\(s\)\);\s*else \{ Orb\.send\(null, 2600\); if \(Orb\.ghost\) Orb\.ghost\(/.test(pg));
  check("one reply stream per inbound message (none on the ack transition)", !/d\.status === "ack" && s\) Orb\.reply/.test(pg) && /ML\.resolveFrom\(row, S\.sessions\)/.test(pg));
  check("sphere size counts delegations by who they really went to; sphere ids are session ids first", /ML\.resolveTarget\(d, S\.sessions, ALIAS\)\.session === s\) dels\+\+/.test(pg) && /function sessKey\(s\) \{ return String\(s\.session_id \|\| s\.pid \|\| s\.name\); \}/.test(pg));
  check("cc-map: with the spheres on, never the hidden orbit's dots or a fixed point; a dissolved sphere keeps its last place", /if \(id && lastPos\[id\]\) return lastPos\[id\];\s*return \[L\.cx, L\.cy\];/.test(map) && /if \(id === GHOST && ghostAt\) return ghostAt;/.test(map));
  check("cc-family: a ghost marker at the edge, named, flashing, fading", /function ghost\(name, where\)/.test(fam) && /gk\.age > 4\.1/.test(fam) && /ghost: function \(name, where\)/.test(fam));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
