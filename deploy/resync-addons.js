#!/usr/bin/env node
"use strict";
/**
 * Re-derive every agent's and channel's environment from the add-on catalogue.
 *
 * The catalogue is the single source of truth for "what does this capability
 * imply", and it lives in the dashboard. Anything that writes an agent or a
 * channel without going through the panel -- a migration, a hand edit, a
 * restored backup -- leaves the stored add-on ids correct but the environment
 * they imply missing or stale.
 *
 * Run after a migration, or after changing the catalogue, to bring the two back
 * into line. Idempotent, and safe while agents are running: each one is
 * restarted only if its configuration actually changed.
 *
 *     sudo -u joyaadmin node /opt/joya/deploy/resync-addons.js [--dry-run]
 */

const { execFileSync } = require("child_process");
const path = require("path");

const DASHBOARD = process.env.JOYA_DASHBOARD_DIR || "/opt/joya-dashboard";
const catalog = require(path.join(DASHBOARD, "lib", "catalog"));

const DRY = process.argv.includes("--dry-run");
const HELPER = "/usr/local/sbin/joya-helper";

function helper(args, stdin) {
  const out = execFileSync("sudo", ["-n", HELPER, ...args], {
    input: stdin,
    maxBuffer: 8 * 1024 * 1024,
  }).toString();
  const parsed = JSON.parse(out.trim().split("\n").pop());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}

function sameEnv(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k && String(a[k]) === String(b[k]));
}

function resync(kind, records, scope, update) {
  let changed = 0;
  for (const record of records) {
    // An add-on id no longer in the catalogue is dropped rather than carried
    // forward: it would contribute nothing and confuse the next reader.
    const known = new Set(catalog.byScope(scope).map((a) => a.id));
    const ids = (record.addons || []).filter((id) => known.has(id));
    for (const a of catalog.byScope(scope)) {
      if (a.locked && !ids.includes(a.id)) ids.push(a.id);
    }
    ids.sort();

    const env = catalog.envFor(ids, scope, {});
    if (sameEnv(record.addon_env, env) && String(record.addons) === String(ids)) {
      console.log(`  ${kind} ${record.slug.padEnd(20)} already in sync`);
      continue;
    }

    console.log(
      `  ${kind} ${record.slug.padEnd(20)} -> ${ids.length} add-on(s), ${
        Object.keys(env).length
      } env keys`
    );
    if (DRY) continue;
    update({ slug: record.slug, addons: ids, addon_env: env });
    changed++;
  }
  return changed;
}

function main() {
  console.log(DRY ? "Dry run — nothing will be written.\n" : "Resyncing add-ons.\n");

  const agents = helper(["agent-list"]);
  const channels = helper(["channel-list"]);

  let changed = 0;
  changed += resync("agent  ", agents, "agent", (payload) =>
    helper(["agent-update"], JSON.stringify(payload))
  );
  changed += resync("channel", channels, "channel", (payload) =>
    helper(["channel-update"], JSON.stringify(payload))
  );

  console.log(
    DRY
      ? "\nDry run complete."
      : `\nDone. ${changed} record(s) updated.` +
        (changed ? " Affected agents were restarted." : "")
  );
}

try {
  main();
} catch (e) {
  console.error("Failed:", e.message);
  process.exit(1);
}
