#!/usr/bin/env node
"use strict";
/**
 * The Windows app's icons (desktop/src-tauri/icons/) from the same drawings as the dashboard's bot icon
 * (dashboard/tools/make-bot-icon.cjs, head "cap": JOYA AI's own head with its cap and headphones), since 0.1.9.
 *
 *     PW=/path/to/node_modules/playwright node desktop/tools/make-icons.cjs [--head cap]
 *
 * Small sizes use the pixel-fitted drawings, large ones the full wireframe on its dark disc:
 *
 *     32x32.png          the 32 px drawing -- also the TRAY icon (lib.rs tray_base; Windows shows it at 16 px
 *                        at 100 %, where the 32 px drawing still reads: outline, two eyes, the smile, the phones)
 *     64x64.png, 128x128.png, 128x128@2x.png (256), icon.png (512), source-512.png   the full drawing
 *     icon.ico           16 (the 16 px drawing), 24 / 32 / 48 (the 32 px drawing), 64 / 256 (the full drawing):
 *                        the exe, the taskbar, the window and the installer (tauri.conf.json installerIcon)
 */
const fs = require("fs");
const path = require("path");
const BI = require(path.join(__dirname, "..", "..", "dashboard", "tools", "make-bot-icon.cjs"));
const MESH = require(path.join(__dirname, "..", "..", "dashboard", "tools", "make-app-icon.cjs"));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg("--out", path.join(__dirname, "..", "src-tauri", "icons"));

const PNGS = [
  { file: "32x32.png", from: "favicon-32.svg", size: 32 },
  { file: "64x64.png", from: "master", size: 64 },
  { file: "128x128.png", from: "master", size: 128 },
  { file: "128x128@2x.png", from: "master", size: 256 },
  { file: "icon.png", from: "master", size: 512 },
  { file: "source-512.png", from: "master", size: 512 },
];
const ICO = [
  { size: 16, from: "favicon-16.svg" }, { size: 24, from: "favicon-32.svg" }, { size: 32, from: "favicon-32.svg" },
  { size: 48, from: "favicon-32.svg" }, { size: 64, from: "master" }, { size: 256, from: "master" },
];

async function main() {
  const head = arg("--head", "cap");
  const src = Object.assign({}, BI.files(head), BI.rasterSources(head));
  const { chromium } = require(process.env.PW || process.env.PLAYWRIGHT || "playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shot = async (svgText, size) => {
    await page.setViewportSize({ width: size, height: size });
    const s = "data:image/svg+xml;base64," + Buffer.from(svgText).toString("base64");
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${s}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete);
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of PNGS) fs.writeFileSync(path.join(OUT, p.file), await shot(src[p.from], p.size));
  const images = [];
  for (const i of ICO) images.push({ size: i.size, data: await shot(src[i.from], i.size) });
  fs.writeFileSync(path.join(OUT, "icon.ico"), MESH.ico(images));
  await browser.close();
  console.log("wrote", PNGS.map((p) => p.file).join(", "), "and icon.ico (" + ICO.map((i) => i.size).join(" / ") + ") in", OUT, "-- head", head);
}

module.exports = { PNGS, ICO };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
