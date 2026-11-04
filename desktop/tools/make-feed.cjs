#!/usr/bin/env node
"use strict";
/**
 * The update feed for /desktop/ on joya.example.com (dashboard/lib/desktop.js serves it):
 *
 *   node desktop/tools/make-feed.cjs --bundle <nsis bundle dir> --out <dir> [--cert <.cer>] [--notes "..."] [--base https://joya.example.com/desktop/files/]
 *
 * Writes <out>/latest.json -- the static manifest Tauri's updater reads:
 *   { version, notes, pub_date, platforms: { "windows-x86_64": { signature, url } } }
 * where `signature` is the installer's .sig (the updater key's minisign signature, made by
 * `cargo tauri build` with createUpdaterArtifacts) -- and copies the installer (and the
 * code-signing certificate) into <out>/files/. The version comes from the installer's
 * name and must equal desktop/src-tauri/tauri.conf.json's. Nothing secret is written.
 *
 * Deploying (the main session's step): copy <out>/ to the dashboard's data dir
 * (/var/lib/joya-dashboard/desktop/ on the box, owned by the dashboard's user).
 */
const fs = require("fs");
const path = require("path");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
}

/** Pure: the manifest for one installer. Throws on anything inconsistent. */
function manifest({ version, installer, sig, notes, base, date }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("bad version: " + version);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*_x64-setup\.exe$/.test(installer || "")) throw new Error("not an NSIS x64 installer name: " + installer);
  if (!installer.includes("_" + version + "_")) throw new Error(`installer ${installer} is not version ${version}`);
  const s = String(sig || "").trim();
  // A Tauri updater signature: base64 of the minisign text ("untrusted comment: ...\n<sig>\ntrusted comment: ...\n<sig>").
  let text = "";
  try {
    text = Buffer.from(s, "base64").toString("utf8");
  } catch (_) {
    text = "";
  }
  if (!/^untrusted comment: /.test(text) || !/\ntrusted comment: /.test(text)) throw new Error("the .sig is not a minisign signature");
  if (!/^https:\/\/[^/]+\/.+\/$/.test(base)) throw new Error("bad base URL: " + base);
  return {
    version,
    notes: String(notes || "").slice(0, 500),
    pub_date: (date || new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: s, url: base + encodeURIComponent(installer) } },
  };
}

function main() {
  const bundle = arg("bundle");
  const out = arg("out");
  if (!bundle || !out) {
    console.log("usage: make-feed.cjs --bundle <nsis dir> --out <dir> [--cert <.cer>] [--notes text] [--base url]");
    process.exit(2);
  }
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"));
  const exe = fs.readdirSync(bundle).filter((f) => /_x64-setup\.exe$/.test(f) && f.includes("_" + conf.version + "_"));
  if (exe.length !== 1) throw new Error("expected one installer for " + conf.version + " in " + bundle + ", found " + exe.join(", "));
  const installer = exe[0];
  const sig = fs.readFileSync(path.join(bundle, installer + ".sig"), "utf8");
  const m = manifest({ version: conf.version, installer, sig, notes: arg("notes", ""), base: arg("base", "https://joya.example.com/desktop/files/") });
  fs.mkdirSync(path.join(out, "files"), { recursive: true });
  fs.copyFileSync(path.join(bundle, installer), path.join(out, "files", installer));
  const cert = arg("cert");
  if (cert) fs.copyFileSync(cert, path.join(out, "files", "joya-desktop-codesign.cer"));
  fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(m, null, 2) + "\n");
  console.log("feed written: " + path.join(out, "latest.json") + " (" + m.version + ", " + installer + ")");
}

module.exports = { manifest };
if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("make-feed: " + e.message);
    process.exit(1);
  }
}
