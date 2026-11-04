#!/usr/bin/env node
/**
 * A stand-in for /usr/local/sbin/joya-helper, for tests: the two read-only
 * subcommands the supervisor's watchers use.
 *
 *   service-list   prints $FAKE_HELPER_DIR/services.json (or twelve healthy units)
 *   pulse-feed     prints the events in $FAKE_HELPER_DIR/events.json once, then
 *                  empties it, like a cursor moving on
 *
 * FAKE_HELPER_DIR comes from the supervisor's own environment, which the
 * helper call inherits.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const dir = process.env.FAKE_HELPER_DIR || "";
const ok = (data) => {
  process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
  process.exit(0);
};
const [sub] = process.argv.slice(2);
if (sub === "service-list") {
  try {
    ok(JSON.parse(fs.readFileSync(path.join(dir, "services.json"), "utf8")));
  } catch (_) {
    ok(["nginx", "ssh", "fail2ban", "ufw", "joya-dashboard", "odoo", "postgresql@16-main", "claude-memory", "joya-ai"].map((u) => ({ unit: u, active: "active", kind: "system", since: "Mon 2026-09-28 06:00:00 EEST" })));
  }
}
if (sub === "pulse-feed") {
  let input = "";
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    const f = path.join(dir || "/nonexistent", "events.json");
    let events = [];
    try {
      events = JSON.parse(fs.readFileSync(f, "utf8"));
      fs.writeFileSync(f, "[]");
    } catch (_) {
      /* none */
    }
    ok({ cursor: { j: null, f: {}, r: {} }, events, counts: {}, unavailable: [], now: new Date().toISOString() });
  });
} else if (sub !== "service-list") {
  process.stdout.write(JSON.stringify({ ok: false, error: "unknown subcommand" }) + "\n");
  process.exit(2);
}
