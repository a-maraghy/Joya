#!/usr/bin/env node
"use strict";
/**
 * A stand-in for systemctl, for the hired-session tests (M-6): never touches
 * the real systemd. "enable --now joya-session@<slug>.service" starts
 * bin/joya-session <slug> in the background (its pid in FAKE_SYSTEMCTL_DIR);
 * "disable --now ..." sends it SIGTERM and waits for it to go; every call is
 * appended to FAKE_SYSTEMCTL_DIR/calls.log.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const dir = process.env.FAKE_SYSTEMCTL_DIR;
if (!dir) {
  console.error("FAKE_SYSTEMCTL_DIR is not set");
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\n");
const unit = args.find((a) => /^joya-session@[a-z0-9-]+\.service$/.test(a));
const slug = unit ? unit.slice("joya-session@".length, -".service".length) : null;
const pidFile = slug && path.join(dir, slug + ".pid");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
};
(async () => {
  if (!slug) process.exit(0);
  if (args[0] === "enable" || args[0] === "start") {
    const out = fs.openSync(path.join(dir, slug + ".log"), "a");
    const child = spawn(process.execPath, [path.join(__dirname, "..", "bin", "joya-session"), slug], { detached: true, stdio: ["ignore", out, out], env: process.env });
    fs.writeFileSync(pidFile, String(child.pid));
    child.unref();
    process.exit(0);
  }
  if (args[0] === "disable" || args[0] === "stop") {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(pidFile, "utf8"));
    } catch (_) {
      process.exit(0);
    }
    if (pid && alive(pid)) {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    }
    fs.rmSync(pidFile, { force: true });
    process.exit(0);
  }
  process.exit(0);
})();
