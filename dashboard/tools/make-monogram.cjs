/**
 * The browser-tab icon (2026-10-25): the letter M, black on white, with a
 * white-on-black variant when the browser is in dark mode. It replaces the
 * leaf / Mesh favicons; the installed app icon (manifest, apple-touch) stays
 * the bot head (tools/make-bot-icon.cjs).
 *
 *     node dashboard/tools/make-monogram.cjs            the three SVGs
 *     PLAYWRIGHT=/path/to/playwright node dashboard/tools/make-monogram.cjs --raster   ...and favicon.ico
 *
 * public/brand/m/favicon-16.svg   pixel-fitted 16 px
 * public/brand/m/favicon-32.svg   32 px
 * public/brand/m/favicon.svg      any size
 * public/brand/m/favicon.ico      16 / 32 / 48 PNGs (light only: an .ico has no dark mode)
 *
 * The SVGs carry their own prefers-color-scheme rule; browsers that ignore it
 * show the light one, which reads on both tab colours because of its frame.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const MESH = require("./make-app-icon.cjs"); // ico()

const OUT = path.join(__dirname, "..", "public", "brand", "m");

const STYLE = `<style>.t{fill:#FFFFFF;stroke:#000000}.m{stroke:#000000}@media (prefers-color-scheme: dark){.t{fill:#000000;stroke:#FFFFFF}.m{stroke:#FFFFFF}}</style>`;
const LIGHT = `<style>.t{fill:#FFFFFF;stroke:#000000}.m{stroke:#000000}</style>`;

function svg(size, style) {
  if (size === 16)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="JOYA">${style}<rect class="t" x="0.5" y="0.5" width="15" height="15" rx="3" stroke-width="1"/><path class="m" d="M4 12V4.5l4 5 4-5V12" fill="none" stroke-width="2" stroke-linejoin="miter" stroke-miterlimit="8"/></svg>\n`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="JOYA">${style}<rect class="t" x="1" y="1" width="30" height="30" rx="6.5" stroke-width="2"/><path class="m" d="M9 23.5V9l7 9.5L23 9v14.5" fill="none" stroke-width="3.6" stroke-linejoin="miter" stroke-miterlimit="8"/></svg>\n`;
}

function files() {
  return { "favicon-16.svg": svg(16, STYLE), "favicon-32.svg": svg(32, STYLE), "favicon.svg": svg(32, STYLE).replace('width="32" height="32" ', "") };
}

async function raster() {
  const { chromium } = require(process.env.PW || process.env.PLAYWRIGHT || "playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1, colorScheme: "light" });
  const images = [];
  for (const size of [16, 32, 48]) {
    await page.setViewportSize({ width: size, height: size });
    const src = "data:image/svg+xml;base64," + Buffer.from(svg(size === 16 ? 16 : 32, LIGHT)).toString("base64");
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete);
    images.push({ size, data: await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }) });
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "favicon.ico"), MESH.ico(images));
}

module.exports = { files, svg };

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [n, b] of Object.entries(files())) fs.writeFileSync(path.join(OUT, n), b);
  console.log("wrote the three monogram SVGs");
  if (process.argv.includes("--raster"))
    raster().then(
      () => console.log("wrote favicon.ico"),
      (e) => {
        console.error(e);
        process.exit(1);
      }
    );
}
