/**
 * The turn queue's ordering (lib/turnqueue.js), without a supervisor.
 *
 *     node joya-ai/tools/test-turnqueue.cjs
 *
 * User turns before background ones, FIFO within each class, nothing dropped,
 * and a background turn that has waited too long is promoted (no starvation).
 * tools/test-queue.cjs checks the same through a real supervisor.
 */
"use strict";
const path = require("path");
const q = require(path.join(__dirname, "..", "lib", "turnqueue.js"));

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

const NOW = Date.parse("2026-09-29T12:00:00Z");
const at = (sAgo) => new Date(NOW - sAgo * 1000).toISOString();
const t = (id, source, sAgo, actor) => ({ row: { id, source, actor: actor === undefined ? null : actor, created_at: at(sAgo) } });
const ids = (list) => list.map((p) => p.row.id).join(",");
const MAX = 600 * 1000;

// classes
check("dashboard is a user turn", q.classOf({ source: "dashboard" }) === "user");
check("voice-desk is a user turn", q.classOf({ source: "voice-desk" }) === "user");
check("mission-request is a user turn", q.classOf({ source: "mission-request" }) === "user");
check("decision (approve / ask) is a user turn", q.classOf({ source: "decision" }) === "user");
check("watcher is background", q.classOf({ source: "watcher", actor: "watcher" }) === "background");
check("a scheduled standing order is background", q.classOf({ source: "order", actor: "scheduler" }) === "background");
check("a standing order run by hand is the user's", q.classOf({ source: "order", actor: "amaraghy" }) === "user");
// 2026-09-30: peer turns were classed as the administrator's, and a spoken request waited behind them.
check("a peer session's message is background", q.classOf({ source: "peer", actor: "Giza Odoo" }) === "background");
check("  so are cross-session idle / delivery notices and system turns", ["idle", "delivery", "system"].every((x) => q.classOf({ source: x }) === "background"));
check("  a peer message held at the token cap is background; one from Remote Control (the administrator) is the user's", q.classOf({ source: "cap-held", actor: "Giza Odoo" }) === "background" && q.classOf({ source: "cap-held", actor: "remote" }) === "user");
check("a voice turn overtakes an earlier held peer message", q.pickNext([t(70, "cap-held", 20, "Giza Odoo"), t(71, "voice-desk", 2)], NOW, MAX) === 1);
check("  and the peer message still runs, promoted once it has waited too long (no starvation)", q.pickNext([t(70, "cap-held", 700, "Giza Odoo"), t(71, "voice-desk", 2)], NOW, MAX) === 0);

// the reported case: a voice turn (L61) queued behind a watcher turn (L60)
check("a user turn overtakes an earlier background turn", q.pickNext([t(60, "watcher", 30, "watcher"), t(61, "voice-desk", 5)], NOW, MAX) === 1);

// FIFO within each class, users first
const mixed = [t(1, "watcher", 50), t(2, "order", 40, "scheduler"), t(3, "dashboard", 30), t(4, "watcher", 20), t(5, "voice-desk", 10), t(6, "dashboard", 5)];
check("users first, then background, FIFO within each", ids(q.order(mixed, NOW, MAX)) === "3,5,6,1,2,4", ids(q.order(mixed, NOW, MAX)));
check("order() keeps every turn (nothing dropped)", q.order(mixed, NOW, MAX).length === mixed.length);
check("FIFO is by ledger id, not array position (re-queued turns keep their place)", ids(q.order([t(9, "dashboard", 1), t(7, "dashboard", 3), t(8, "dashboard", 2)], NOW, MAX)) === "7,8,9");

// background runs when no user turn waits
check("background runs when no user turn is waiting", q.pickNext([t(1, "watcher", 5), t(2, "order", 4, "scheduler")], NOW, MAX) === 0);
check("an empty queue picks nothing", q.pickNext([], NOW, MAX) === -1);

// no starvation: a background turn older than the limit competes by arrival
const starving = [t(1, "watcher", 700), t(2, "dashboard", 30), t(3, "voice-desk", 10)];
check("a background turn waiting past the limit goes by arrival order", ids(q.order(starving, NOW, MAX)) === "1,2,3", ids(q.order(starving, NOW, MAX)));
check("below the limit it still waits", ids(q.order([t(1, "watcher", 500), t(2, "dashboard", 30)], NOW, MAX)) === "2,1");
check("maxWait 0 means strict priority", ids(q.order(starving, NOW, 0)) === "2,3,1");

// a stream of user turns cannot hold a background turn back for ever
{
  let pending = [t(1, "watcher", 0)];
  let clock = NOW;
  let nextId = 2;
  let ranAt = null;
  for (let step = 0; step < 200 && ranAt === null; step++) {
    pending.push({ row: { id: nextId++, source: "dashboard", created_at: new Date(clock).toISOString() } });
    const i = q.pickNext(pending, clock, MAX);
    if (pending[i].row.id === 1) ranAt = step;
    pending.splice(i, 1);
    clock += 30 * 1000; // a user turn every 30 s, each taking 30 s
  }
  check("under a steady stream of user turns the background turn still runs, after the limit", ranAt !== null && ranAt >= 19 && ranAt <= 21, "ran at step " + ranAt);
}

// a bad created_at never throws or starves
check("a missing created_at is treated as new", q.pickNext([t(1, "watcher", 0), { row: { id: 2, source: "dashboard" } }], NOW, MAX) === 1);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
