/**
 * The Joya icon, "Bot" variant (2026-10-20; live since 0.1.9 with JOYA_APP_ICON=bot -- unset, the icon is
 * "Mesh", tools/make-app-icon.cjs): JOYA AI's core E head -- a faint wireframe rounded box with
 * its face lit in joya on the grid's nodes -- drawn as an icon from the renderer's own
 * geometry (public/joya-core-bot.js build(); the icon keeps its node smile, ICON_FACE below,
 * since the core's face became a vector layer on 2026-10-22). The same set of files as the Mesh icon, in public/brand/bot/:
 *
 *     brand/bot/favicon-16.svg       16 px, pixel-fitted: the head's outline, two 2 x 2 eyes, a smile, the accessory in 1 px
 *     brand/bot/favicon-32.svg       32 px: the outline, a hint of the grid, 3 x 3 eyes, the smile, the accessory
 *     brand/bot/favicon.svg          sizes="any": the full wireframe (lighter: every other grid line) on a dark disc
 *     brand/bot/favicon.ico          16 / 32 / 48 PNGs
 *     brand/bot/app-icon-180.png     apple-touch-icon: on the navy -> violet field
 *     brand/bot/app-icon-192.png     manifest "any": the head on its dark disc, transparent corners
 *     brand/bot/app-icon-512.png     manifest "any"
 *     brand/bot/app-icon-maskable-512.png   manifest "maskable": full-bleed field, the head inside the 80 % safe circle
 *
 *     node dashboard/tools/make-bot-icon.cjs [--head cap] [--out DIR]               the SVGs
 *     PW=/path/to/node_modules/playwright node dashboard/tools/make-bot-icon.cjs --raster  ...and the PNGs and the .ico
 *     ... --preview DIR     sheets of every size on light and dark (for review)
 *
 * The head defaults to "cap" (JOYA AI's own core head: the cap, its antenna and the headphones -- the
 * user's pick, 2026-10-20); --head picks another of the ten. The switch is lib/ui.js appIcon():
 * JOYA_APP_ICON=bot in the dashboard's environment (a systemd drop-in). The Windows app's icons
 * (desktop/src-tauri/icons/) are made from the same files by desktop/tools/make-icons.cjs.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const B = require(path.join(__dirname, "..", "public", "joya-core-bot.js"));
const MESH = require("./make-app-icon.cjs"); // ico(), readIco(), pngSize()

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PUB = path.join(__dirname, "..", "public");
const C = { joya: "#00E6A5", joyaHi: "#7DFFD6", wire: "#E1E8F8", edge: "#8C9AB8", // edge: the small sizes' outline, readable on a light and a dark tab
  ink: "#0D1117", plate: "#151C2C", plate2: "#0B0F18" };
let PREC = 2;
const f = (n) => +(+n).toFixed(PREC);

/* ------------------------------------------------------------ the head, projected */

/** Every vertex of a head at (yaw, tilt), fitted into the box [x0, y0, x0 + w, y0 + h]: {X, Y, Z, k, s}. */
function projected(head, detail, box) {
  const geo = B.build(head, detail), cfg = B.HEADS[head], V = geo.v, n = geo.n;
  const yaw = cfg.yaw, tilt = cfg.tilt || 0.1, cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) {
    const b = i * 7, x = V[b], y = V[b + 1], z = V[b + 2];
    const xa = x * cy + z * sy, za = -x * sy + z * cy, yb = y * ct - za * st, zb = za * ct + y * st;
    X[i] = xa; Y[i] = -yb; Z[i] = zb;
    x0 = Math.min(x0, xa); x1 = Math.max(x1, xa); y0 = Math.min(y0, -yb); y1 = Math.max(y1, -yb);
  }
  const s = Math.min(box[2] / (x1 - x0), box[3] / (y1 - y0)), ox = box[0] + (box[2] - (x1 - x0) * s) / 2 - x0 * s, oy = box[1] + (box[3] - (y1 - y0) * s) / 2 - y0 * s;
  for (let i = 0; i < n; i++) { X[i] = X[i] * s + ox; Y[i] = Y[i] * s + oy; }
  return { geo, X, Y, Z, s };
}

/*
 * The icon's face: the ready smile lit on the 19 x 19 front grid's nodes. The core's own face became a vector layer
 * (joya-core-bot.js FACE, 2026-10-22); the icon keeps this drawing -- its map is the renderer's old "base" map,
 * placed the same way -- so the shipped icons (and the desktop app's, made from them) stay exactly as they are.
 */
const ICON_FACE = ["..................", "..................", "...cccc....cccc...", "..c.cc.c..c.cc.c..", "..cccccc..cccccc..", "..c.cc.c..c.cc.c..", "...cccc....cccc...", "..................", "..................", "..m............m..", "...m..........m...", "....mmmmmmmmmm....", ".................."];
/** The face's lit nodes (the ready smile), as weights on the 19 x 19 front grid (0 / 255, indexed row * 19 + col). */
function faceWeights() {
  const w = new Uint8Array(B.NF), fr = ICON_FACE.length, fc = ICON_FACE[0].length, oR = Math.round((18 - fr + 1) / 2), oC = Math.round((18 - fc + 1) / 2);
  for (let r = 0; r < 19; r++) for (let c = 0; c < 19; c++) { const ri = r - oR, ci = c - oC; if (ri >= 0 && ri < fr && ci >= 0 && ci < fc && ICON_FACE[ri].charAt(ci) !== ".") w[r * 19 + c] = 255; }
  return w;
}

/**
 * The full drawing in a 100-unit box: the wireframe (front lines bright, the far side faint, in three
 * depth bands), the accessory's rods and joints, the lit face (a blurred joya glow under crisp dots and
 * the strokes between neighbouring lit nodes). lite: every other grid line ("lo"), one decimal.
 */
function full({ head = "cap", lite = false, box = [12, 9, 76, 82], face = "base" } = {}) {
  PREC = lite ? 1 : 2;
  const P = projected(head, lite ? "lo" : "hi", box), V = P.geo.v, L = P.geo.lines, W8 = faceWeights(face);
  const band = ["", "", ""], rods = [], lit = [];
  for (let i = 0; i < L.length; i += 2) {
    const a = L[i], b = L[i + 1], ka = V[a * 7 + 3];
    const seg = `M${f(P.X[a])} ${f(P.Y[a])}L${f(P.X[b])} ${f(P.Y[b])}`;
    if (ka === 6) { rods.push(seg); continue; }
    if (ka === 2) { lit.push(seg); continue; }
    if (ka === 0 && (P.Z[a] < -0.02 || P.Z[b] < -0.02)) continue;
    const d = ((P.Z[a] + P.Z[b]) / 2 + 1) / 2;
    band[d < 0.45 ? 0 : d < 0.75 ? 1 : 2] += seg;
  }
  // the face: lit front nodes, and the strokes along the grid between two lit ones
  const front = P.geo.front, at = (r, c) => front[(18 - r) * 19 + c]; // front[i * 19 + j] is (col i, row-from-bottom j)
  const lw = (r, c) => { const fv = front[c * 19 + (18 - r)]; return W8[V[fv * 7 + 4]] / 255; };
  let dots = "", strokes = "";
  const R = P.s * (2 / 18) * 0.34; // a dot: about a third of the grid's spacing
  for (let r = 0; r < 19; r++) for (let c = 0; c < 19; c++) {
    const w = lw(r, c);
    if (w < 0.5) continue;
    const fv = front[c * 19 + (18 - r)];
    if (P.Z[fv] < -0.03) continue;
    dots += `<circle cx="${f(P.X[fv])}" cy="${f(P.Y[fv])}" r="${f(R)}"/>`;
    if (c < 18 && lw(r, c + 1) >= 0.5) { const g = front[(c + 1) * 19 + (18 - r)]; strokes += `M${f(P.X[fv])} ${f(P.Y[fv])}L${f(P.X[g])} ${f(P.Y[g])}`; }
    if (r < 18 && lw(r + 1, c) >= 0.5) { const g = front[c * 19 + (18 - r - 1)]; strokes += `M${f(P.X[fv])} ${f(P.Y[fv])}L${f(P.X[g])} ${f(P.Y[g])}`; }
  }
  let joints = "";
  for (let i = 0; i < P.geo.n; i++) {
    const k = V[i * 7 + 3];
    if (k !== 3 && k !== 4) continue;
    joints += k === 4 ? `<circle cx="${f(P.X[i])}" cy="${f(P.Y[i])}" r="${f(R * 1.25)}" fill="${C.joya}"/>` : `<circle cx="${f(P.X[i])}" cy="${f(P.Y[i])}" r="${f(R * 1.25)}" fill="${C.wire}"/><circle cx="${f(P.X[i])}" cy="${f(P.Y[i])}" r="${f(R * 0.7)}" fill="#fff"/>`;
  }
  const sw = lite ? 0.42 : 0.3;
  return `<defs><filter id="fg" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${lite ? 1.6 : 1.4}"/></filter>` +
    `<radialGradient id="hd" gradientUnits="userSpaceOnUse" cx="50" cy="56" r="40"><stop offset="0" stop-color="${C.joya}" stop-opacity=".16"/><stop offset="1" stop-color="${C.joya}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="50" cy="56" r="38" fill="url(#hd)"/>` +
    `<g fill="none" stroke="${C.wire}" stroke-linecap="round">` +
    `<path d="${band[0]}" stroke-width="${sw}" opacity=".16"/><path d="${band[1]}" stroke-width="${sw}" opacity=".32"/><path d="${band[2]}" stroke-width="${f(sw * 1.15)}" opacity=".55"/>` +
    (rods.length ? `<path d="${rods.join("")}" stroke-width="${f(sw * 2)}" opacity=".7"/>` : "") + `</g>` +
    (lit.length ? `<path d="${lit.join("")}" fill="none" stroke="${C.joya}" stroke-width="${f(sw * 2)}" stroke-linecap="round"/>` : "") +
    `<g filter="url(#fg)" opacity=".85" fill="${C.joya}" stroke="${C.joya}" stroke-width="${f(R * 1.6)}"><path d="${strokes}"/>${dots}</g>` +
    `<path d="${strokes}" fill="none" stroke="${C.joya}" stroke-width="${f(R * 1.2)}" stroke-linecap="round"/>` +
    `<g fill="${C.joyaHi}">${dots}</g>${joints}`;
}

/* ------------------------------------------------------------ the small sizes, by hand on the pixel grid */

const ACC_KIND = { antennas: "ant", cap: "phones", headphones: "phones", headset: "phones", bowtie: "phones", mortar: "mortar", beanie: "none", goggles: "none", ears: "ears", halo: "halo" };

/** 32 px: a rounded box, a hint of its grid, 3 x 3 eyes, a smile, the accessory. */
function fav32(head) {
  const k = ACC_KIND[head] || "none";
  let acc = "";
  if (k === "ant") acc = `<path d="M11.5 10.5L9.5 4.5M20.5 10.5L22.5 4.5" stroke="${C.edge}" stroke-width="1.3" stroke-linecap="round"/><circle cx="9.3" cy="4" r="2" fill="${C.joya}"/><circle cx="22.7" cy="4" r="2" fill="${C.joya}"/>`;
  else if (k === "phones") acc = `<path d="M5.5 17.5C5.5 6 26.5 6 26.5 17.5" fill="none" stroke="${C.edge}" stroke-width="1.4"/><rect x="2" y="15" width="4" height="8" rx="1.6" fill="${C.edge}"/><rect x="26" y="15" width="4" height="8" rx="1.6" fill="${C.edge}"/>`;
  else if (k === "mortar") acc = `<path d="M3 8.5L16 4.5L29 8.5L16 12.5Z" fill="${C.edge}"/><path d="M26.5 8.5V14" stroke="${C.joya}" stroke-width="1.3"/>`;
  else if (k === "halo") acc = `<ellipse cx="16" cy="5" rx="8" ry="2.2" fill="none" stroke="${C.edge}" stroke-width="1.3"/>`;
  else if (k === "ears") acc = `<path d="M8 11L9 4L14 10ZM24 11L23 4L18 10Z" fill="${C.edge}"/>`;
  return `<defs><radialGradient id="p" cx="16" cy="19" r="15" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.plate}"/><stop offset="1" stop-color="${C.plate2}"/></radialGradient></defs>` +
    acc +
    `<rect x="5.5" y="10.5" width="21" height="18" rx="5.5" fill="url(#p)" stroke="${C.edge}" stroke-width="1.2"/>` +
    `<path d="M12.5 11V28M19.5 11V28M6 16.5H26M6 22.5H26" stroke="${C.edge}" stroke-width=".5" opacity=".28"/>` +
    `<rect x="9.5" y="14.5" width="4" height="4" rx=".6" fill="${C.joya}"/><rect x="18.5" y="14.5" width="4" height="4" rx=".6" fill="${C.joya}"/>` +
    `<path d="M10 22.5V24H22V22.5" fill="none" stroke="${C.joya}" stroke-width="1.6" stroke-linejoin="round"/>`;
}
/** 16 px, every edge on a pixel: an outlined box, 2 x 2 eyes, a three-pixel-wide smile, the accessory in 1 px. */
function fav16(head) {
  const k = ACC_KIND[head] || "none";
  let acc = "";
  if (k === "ant") acc = `<path d="M5.5 5V3M10.5 5V3" stroke="${C.edge}" stroke-width="1"/><rect x="4" y="1" width="2" height="2" fill="${C.joya}"/><rect x="10" y="1" width="2" height="2" fill="${C.joya}"/>`;
  else if (k === "phones") acc = `<path d="M2.5 9V6.5C2.5 2.5 13.5 2.5 13.5 6.5V9" fill="none" stroke="${C.edge}" stroke-width="1"/><rect x="0" y="8" width="2" height="4" fill="${C.edge}"/><rect x="14" y="8" width="2" height="4" fill="${C.edge}"/>`;
  else if (k === "mortar") acc = `<path d="M1 4L8 1L15 4L8 6Z" fill="${C.edge}"/>`;
  else if (k === "halo") acc = `<path d="M4 2.5H12" stroke="${C.edge}" stroke-width="1"/>`;
  else if (k === "ears") acc = `<path d="M3 5L4 1L7 5ZM13 5L12 1L9 5Z" fill="${C.edge}"/>`;
  return acc +
    `<rect x="2.5" y="5.5" width="11" height="9" rx="2.5" fill="${C.plate}" stroke="${C.edge}" stroke-width="1"/>` +
    `<rect x="5" y="8" width="2" height="2" fill="${C.joya}"/><rect x="9" y="8" width="2" height="2" fill="${C.joya}"/>` +
    `<path d="M5 11H11V12H5Z" fill="${C.joya}"/>`;
}

const svg = (vb, px, inner, label) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label || "Joya"}" viewBox="0 0 ${vb} ${vb}" width="${px}" height="${px}">${inner}</svg>\n`;
const disc = `<defs><radialGradient id="dk" gradientUnits="userSpaceOnUse" cx="50" cy="44" r="52"><stop offset="0" stop-color="${C.plate}"/><stop offset="1" stop-color="${C.plate2}"/></radialGradient></defs><circle cx="50" cy="50" r="48" fill="url(#dk)"/><circle cx="50" cy="50" r="47.4" fill="none" stroke="${C.joya}" stroke-opacity=".22" stroke-width=".9"/>`;
const field = `<defs><linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100"><stop offset="0" stop-color="#0B1238"/><stop offset=".55" stop-color="#101A33"/><stop offset="1" stop-color="#0B2A2A"/></linearGradient></defs><rect width="100" height="100" fill="url(#bg)"/>`;

/** The SVGs shipped in public/brand/bot/ (deterministic). */
function files(head) {
  head = B.HEADS[head] ? head : "cap";
  return {
    "favicon-16.svg": svg(16, 16, fav16(head)),
    "favicon-32.svg": svg(32, 32, fav32(head)),
    "favicon.svg": svg(100, 64, disc + full({ head, lite: true, box: [17, 13, 66, 72] })),
  };
}
/** Drawings that are only rasterised. */
function rasterSources(head) {
  head = B.HEADS[head] ? head : "cap";
  return {
    master: svg(100, 512, disc + full({ head, box: [17, 13, 66, 72] })),
    tile: svg(100, 512, field + full({ head, box: [15, 11, 70, 76] })),
    maskable: svg(100, 512, field + full({ head, box: [24, 22, 52, 56] })),
  };
}
const RASTERS = [
  { file: "app-icon-180.png", from: "tile", size: 180 },
  { file: "app-icon-192.png", from: "master", size: 192 },
  { file: "app-icon-512.png", from: "master", size: 512 },
  { file: "app-icon-maskable-512.png", from: "maskable", size: 512 },
];
const ICO = [{ size: 16, from: "favicon-16.svg" }, { size: 32, from: "favicon-32.svg" }, { size: 48, from: "favicon.svg" }];
const OUT_FILES = ["favicon-16.svg", "favicon-32.svg", "favicon.svg", "favicon.ico"].concat(RASTERS.map((r) => r.file));

async function raster(head, dir) {
  const { chromium } = require(process.env.PW || process.env.PLAYWRIGHT || "playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shot = async (svgText, size) => {
    await page.setViewportSize({ width: size, height: size });
    const src = "data:image/svg+xml;base64," + Buffer.from(svgText).toString("base64");
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete);
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  const src = rasterSources(head), shipped = files(head);
  for (const r of RASTERS) fs.writeFileSync(path.join(dir, r.file), await shot(src[r.from], r.size));
  const images = [];
  for (const i of ICO) images.push({ size: i.size, data: await shot(shipped[i.from], i.size) });
  fs.writeFileSync(path.join(dir, "favicon.ico"), MESH.ico(images));
  await browser.close();
}

/** Review sheets: every size, at 1x and enlarged, on a light and a dark page, plus a browser-tab mock. */
async function preview(head, dir, outDir) {
  const { chromium } = require(process.env.PW || process.env.PLAYWRIGHT || "playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const b64 = (f) => "data:" + (/\.svg$/.test(f) ? "image/svg+xml" : /\.ico$/.test(f) ? "image/x-icon" : "image/png") + ";base64," + fs.readFileSync(path.join(dir, f)).toString("base64");
  for (const theme of ["light", "dark"]) {
    const bg = theme === "light" ? "#F6F8FB" : "#0D1117", fg = theme === "light" ? "#262E40" : "#E1E8F8", tab = theme === "light" ? "#FFFFFF" : "#1E2330";
    const cell = (label, img, px, extra) => `<div class="c"><div class="i" style="width:${Math.max(px, 64)}px;height:${Math.max(px, 64)}px"><img src="${img}" width="${px}" height="${px}" style="${extra || ""}"></div><div class="l">${label}</div></div>`;
    const html = `<html><body style="margin:0;background:${bg};color:${fg};font:600 13px system-ui;padding:24px">
<style>.row{display:flex;gap:22px;align-items:flex-end;flex-wrap:wrap;margin-bottom:22px}.c{display:flex;flex-direction:column;align-items:center;gap:8px}.i{display:flex;align-items:center;justify-content:center}.l{opacity:.75;font-size:12px}
.tab{display:inline-flex;align-items:center;gap:8px;background:${tab};padding:8px 14px;border-radius:10px 10px 0 0;font:500 13px system-ui;box-shadow:0 1px 0 rgba(0,0,0,.15)}.px{image-rendering:pixelated}</style>
<div style="margin-bottom:14px;font-size:15px">Bot app icon · head “${head}” · ${theme}</div>
<div class="row">${cell("16 svg", b64("favicon-16.svg"), 16)}${cell("32 svg", b64("favicon-32.svg"), 32)}${cell("48 (ico)", b64("favicon.svg"), 48)}${cell("any svg 64", b64("favicon.svg"), 64)}${cell("180 apple", b64("app-icon-180.png"), 180, "border-radius:40px")}${cell("192 any", b64("app-icon-192.png"), 192)}</div>
<div class="row">${cell("512 any", b64("app-icon-512.png"), 256)}${cell("512 maskable (circle mask)", b64("app-icon-maskable-512.png"), 256, "border-radius:50%")}${cell("512 maskable (squircle)", b64("app-icon-maskable-512.png"), 256, "border-radius:28%")}
<div class="c"><div class="i" style="width:256px;height:256px;flex-direction:column;gap:14px"><span class="tab"><img src="${b64("favicon-16.svg")}" width="16" height="16">Command Center</span><span class="tab"><img src="${b64("favicon-32.svg")}" width="16" height="16">32 svg at 16</span></div><div class="l">in a tab</div></div></div>
<div class="row">${cell("16 x 8 (pixels)", b64("favicon-16.svg"), 128, "image-rendering:pixelated")}${cell("32 x 4", b64("favicon-32.svg"), 128)}</div></body></html>`;
    await page.setViewportSize({ width: 1240, height: 900 });
    await page.setContent(html);
    await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width: 1240, height: h });
    await page.screenshot({ path: path.join(outDir, `icon-${head}-${theme}.png`) });
  }
  await browser.close();
}

module.exports = { files, rasterSources, RASTERS, ICO, OUT_FILES, full, fav16, fav32 };

if (require.main === module) {
  (async () => {
    const head = arg("--head", "cap");
    const dir = arg("--out", path.join(PUB, "brand", "bot"));
    fs.mkdirSync(dir, { recursive: true });
    const out = files(head);
    for (const [name, body] of Object.entries(out)) fs.writeFileSync(path.join(dir, name), body);
    console.log("wrote", Object.entries(out).map(([n, b]) => `${n} (${(b.length / 1024).toFixed(1)} KB)`).join(", "), "in", dir);
    if (process.argv.includes("--raster") || process.argv.includes("--preview")) {
      await raster(head, dir);
      console.log("wrote", RASTERS.map((r) => r.file).join(", "), "and favicon.ico");
    }
    const pv = arg("--preview", null);
    if (pv) { fs.mkdirSync(pv, { recursive: true }); await preview(head, dir, pv); console.log("preview sheets in", pv); }
  })().catch((e) => { console.error(e); process.exit(1); });
}
