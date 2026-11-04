#!/usr/bin/env node
"use strict";
/**
 * The update feed (tools/make-feed.cjs) and how the dashboard reads it
 * (dashboard/lib/desktop.js latest()/offer()): node desktop/tools/test-feed.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { manifest } = require("./make-feed.cjs");
const DK = require("../../dashboard/lib/desktop.js");

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); } else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + detail : "")); }
}
function throws(fn) { try { fn(); return false; } catch (_) { return true; } }

const SIG = Buffer.from("untrusted comment: signature from tauri secret key\nRUQ...\ntrusted comment: timestamp:1\tfile:JOYA AI_0.1.0_x64-setup.exe\nabc==\n").toString("base64");
const base = "https://joya.example.com/desktop/files/";
const m = manifest({ version: "0.1.0", installer: "JOYA AI_0.1.0_x64-setup.exe", sig: SIG + "\n", notes: "First", base, date: new Date("2026-10-07T12:00:00.123Z") });
check("the manifest Tauri's updater reads: version, notes, pub_date (RFC 3339), windows-x86_64 signature + url", m.version === "0.1.0" && m.pub_date === "2026-10-07T12:00:00Z" && m.platforms["windows-x86_64"].signature === SIG && m.platforms["windows-x86_64"].url === base + "JOYA%20AI_0.1.0_x64-setup.exe");
check("refused: a bad version, an installer of another version, a non-installer, a .sig that is not minisign, a base that is not https", throws(() => manifest({ version: "1.0", installer: "x_1.0_x64-setup.exe", sig: SIG, base })) && throws(() => manifest({ version: "0.1.1", installer: "JOYA AI_0.1.0_x64-setup.exe", sig: SIG, base })) && throws(() => manifest({ version: "0.1.0", installer: "JOYA AI_0.1.0_x64.msi", sig: SIG, base })) && throws(() => manifest({ version: "0.1.0", installer: "JOYA AI_0.1.0_x64-setup.exe", sig: "bm9wZQ==", base })) && throws(() => manifest({ version: "0.1.0", installer: "JOYA AI_0.1.0_x64-setup.exe", sig: SIG, base: "http://x/desktop/files/" })));

// The dashboard reads what make-feed writes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
fs.mkdirSync(path.join(dir, "files"));
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(m));
fs.writeFileSync(path.join(dir, "files", "JOYA AI_0.1.0_x64-setup.exe"), Buffer.alloc(3 * 1048576));
const d = DK.create({ db: { getSetting: (k, f) => f, setSetting() {} }, dir });
const off = d.offer();
check("the dashboard's download page finds the installer and its size", off && off.version === "0.1.0" && off.installer && off.installer.name === "JOYA AI_0.1.0_x64-setup.exe" && off.installer.size === 3 * 1048576 && off.cert === null, JSON.stringify(off));
fs.writeFileSync(path.join(dir, "files", "joya-desktop-codesign.cer"), "x");
check("  and the certificate once it is there", d.offer().cert === "joya-desktop-codesign.cer");
fs.writeFileSync(path.join(dir, "latest.json"), "{not json");
check("a broken latest.json is no release (404), not a crash", d.latest() === null && d.offer() === null);
fs.rmSync(dir, { recursive: true, force: true });

// The real one, if a build has been made (tools/build-windows.sh --feed DIR): FEED=DIR node test-feed.cjs
if (process.env.FEED) {
  const j = JSON.parse(fs.readFileSync(path.join(process.env.FEED, "latest.json"), "utf8"));
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"));
  const w = j.platforms["windows-x86_64"];
  const name = decodeURIComponent(w.url.split("/").pop());
  check("the built feed: the app's version, its installer present, a minisign signature", j.version === conf.version && fs.existsSync(path.join(process.env.FEED, "files", name)) && /^untrusted comment:/.test(Buffer.from(w.signature, "base64").toString()), JSON.stringify(j).slice(0, 300));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
