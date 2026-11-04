/**
 * The Joya icon, "Mesh": the JOYA AI core (core D) drawn as an icon --
 * a slightly lumpy sphere, a dotted lat/long grid, cyan -> electric blue ->
 * violet -> hot magenta from upper left to lower right, a crescent rim that
 * glows strongest lower right, a halo of fine dots. Approved 2026-10-06
 * (mockups/app-icon): 16 px = the "lines" simplification, 32 px = the "dots"
 * one, the full drawing from 48 px up. One icon for every page.
 *
 *     node dashboard/tools/make-app-icon.cjs            the SVGs + the web manifest's icon list
 *     PW=/path/to/node_modules/playwright \
 *     node dashboard/tools/make-app-icon.cjs --raster   ...and the PNGs and favicon.ico
 *
 * public/brand/favicon-16.svg       16 px, pixel-fitted: rim + one meridian + the equator
 * public/brand/favicon-32.svg       32 px: rim + a curved grid of bright dots
 * public/favicon.svg                sizes="any": the full drawing, light (dotted strokes, ~20 KB)
 * public/favicon.ico                16 (lines) / 32 (dots) / 48 (full) PNGs
 * public/brand/app-icon-180.png     apple-touch-icon: filled tile, iOS rounds it (no black corners)
 * public/brand/app-icon-192.png     manifest "any", transparent
 * public/brand/app-icon-512.png     manifest "any", transparent
 * public/brand/app-icon-maskable-512.png   manifest "maskable": full-bleed field, mark in the 80 % safe circle
 *
 * Every drawing is generated here from one geometry, so the sizes stay one
 * family. The SVGs are deterministic (tools/test-brand.cjs checks they are
 * current); the PNGs need a browser to rasterise the full drawing, so they are
 * made with Playwright at authoring time only -- the panel ships no image
 * library and gains no dependency. The .ico is written by hand (PNG entries).
 * .cjs because it uses require.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "..", "public");
// PREC: decimals in the output; the light favicon uses 1 (a 100-unit box at 64 px).
let PREC = 2;
const f = (n) => +(+n).toFixed(PREC);
const D = Math.PI / 180;
const C = { violet: "#8A2BE2", magenta: "#FF2BD6", cyan: "#22D3EE", plum: "#2A0F4A" };

/* ------------------------------------------------------------ geometry - */

// The silhouette's radius multiplier by screen angle: the core's folds. RIP
// adds the finer ripple, used by the large drawings only.
let RIP = 0;
const fold = (t, amp = 1) =>
  1 + amp * (0.009 * Math.sin(3 * t + 0.7) + 0.008 * Math.sin(7 * t + 2.1) + 0.007 * Math.sin(11 * t + 0.4) + 0.005 * Math.sin(17 * t + 1.3)) +
  RIP * (0.014 * Math.sin(10 * t + 0.3) + 0.008 * Math.sin(13 * t + 1.9) + 0.005 * Math.sin(4 * t + 2.6));

/** The folded outline as a closed Catmull-Rom curve. */
function blob(cx, cy, R, amp = 1, n = 120) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI, r = R * fold(t, amp);
    p.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n], e = p[(i + 2) % n];
    d += `C${f(b[0] + (c[0] - a[0]) / 6)} ${f(b[1] + (c[1] - a[1]) / 6)} ${f(c[0] - (e[0] - b[0]) / 6)} ${f(c[1] - (e[1] - b[1]) / 6)} ${f(c[0])} ${f(c[1])}`;
  }
  return d + "Z";
}

// A sphere tilted toward the viewer and turned a little, folded radially so the
// grid follows the lumpy outline.
const TX = 0.2, TY = 0.42;
function project(lat, lon, cx, cy, R, amp = 1) {
  const x = Math.cos(lat) * Math.sin(lon), y = Math.sin(lat), z = Math.cos(lat) * Math.cos(lon);
  const x1 = x * Math.cos(TY) + z * Math.sin(TY), z1 = -x * Math.sin(TY) + z * Math.cos(TY);
  const y2 = y * Math.cos(TX) - z1 * Math.sin(TX), z2 = y * Math.sin(TX) + z1 * Math.cos(TX);
  const k = R * fold(Math.atan2(-y2, x1), amp);
  return { x: cx + k * x1, y: cy - k * y2, z: z2 };
}

/** Grid lines as polylines, split into the front-facing and the far side. */
function gridLines(cx, cy, R, lats, lons, amp, step = 3) {
  const front = [], back = [];
  const run = (pts) => {
    let cur = null, side = null;
    for (const p of pts) {
      const s = p.z >= 0 ? "f" : "b";
      if (s !== side) { if (cur && cur.length > 1) (side === "f" ? front : back).push(cur); cur = cur ? [cur[cur.length - 1]] : []; side = s; }
      cur.push(p);
    }
    if (cur && cur.length > 1) (side === "f" ? front : back).push(cur);
  };
  for (const la of lats) { const pts = []; for (let lo = 0; lo <= 360; lo += step) pts.push(project(la * D, lo * D, cx, cy, R, amp)); run(pts); }
  for (const lo of lons) { const pts = []; for (let la = -90; la <= 90; la += step) pts.push(project(la * D, lo * D, cx, cy, R, amp)); run(pts); }
  // relative moves, minus signs as separators: a third shorter than absolute L commands
  const n = (v) => String(f(v)).replace(/^(-?)0\./, "$1.");
  const pair = (x, y) => { const b = n(y); return `${n(x)}${b[0] === "-" ? "" : " "}${b}`; };
  const d = (list) => list.map((l) => {
    let s = `M${pair(l[0].x, l[0].y)}`, px = f(l[0].x), py = f(l[0].y);
    for (let i = 1; i < l.length; i++) { const x = f(l[i].x), y = f(l[i].y); const q = pair(x - px, y - py); s += (i === 1 ? "l" : (q[0] === "-" ? "" : " ")) + q; px = x; py = y; }
    return s;
  }).join("");
  return { front: d(front), back: d(back) };
}

function gridDots(cx, cy, R, lats, lons, rmin, rmax, zmin, amp = 0.7) {
  let s = "";
  for (const la of lats) for (const lo of lons) {
    const p = project(la * D, lo * D, cx, cy, R, amp);
    if (p.z > zmin) s += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(rmin + (rmax - rmin) * p.z)}"/>`;
  }
  return s;
}

/* --------------------------------------------------------------- paint - */

const lin = (id, a, b, stops) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}">` +
  stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("") + `</linearGradient>`;
// the rim: cyan / electric blue upper left -> violet -> hot magenta lower right
const rimGrad = (id, a, b) => lin(id, a, b, [[0, "#46EAFF"], [".3", "#2F7BFF"], [".62", C.violet], [1, C.magenta]]);
// the grid: the same run, lighter, so it reads on the navy body
const dotGrad = (id, a, b) => lin(id, a, b, [[0, "#7FF3FF"], [".3", "#5E8CFF"], [".62", "#B05CFF"], [1, "#FF5FE0"]]);
const lineGrad = (id, a, b) => lin(id, a, b, [[0, "#8CF0FF"], [".35", "#8FB0FF"], [".7", "#C792FF"], [1, "#FF9BEF"]]);
const bodyGrad = (id, cx, cy, r) =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fx="${f(cx - r * 0.3)}" fy="${f(cy - r * 0.35)}">` +
  `<stop offset="0" stop-color="#1C1A5E"/><stop offset=".7" stop-color="#15124A"/><stop offset="1" stop-color="#2A1056"/></radialGradient>`;
const field = lin("bg", [0, 0], [100, 100], [[0, "#0B1238"], [".55", "#1A0F44"], [1, "#3A0F55"]]);

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/* ------------------------------------------------------------- drawings - */

/**
 * The full drawing in a 100-unit box. `lite` draws the grid as dotted strokes
 * (dash 0 + round caps = a row of dots) and fewer halo dots: the same picture
 * at a twentieth of the bytes, for the favicon every page fetches. The full one
 * places every dot and is only rasterised.
 */
function full({ lite = false } = {}) {
  seed = 7; RIP = lite ? 0.6 : 1; PREC = lite ? 1 : 2;
  const cx = 50, cy = 50, R = 40, n = lite ? 90 : 180;
  const out = blob(cx, cy, R, 1, n), inner = blob(cx - 0.7, cy - 0.7, R - 1.5, 1, n);
  const lats = [], lons = [];
  for (let la = -72; la <= 72; la += 9) lats.push(la);
  for (let lo = 0; lo < 360; lo += 10) lons.push(lo);
  let grid;
  if (lite) {
    const g = gridLines(cx, cy, R - 1.2, lats, lons, 1, 6);
    let nodes = "";
    for (const la of lats) for (const lo of lons) {
      const p = project(la * D, lo * D, cx, cy, R - 1.2);
      if (p.z > 0.3) nodes += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(0.42 + 0.26 * p.z)}"/>`;
    }
    grid =
      `<path d="${g.back}" fill="none" stroke="url(#dg)" stroke-width=".5" stroke-dasharray="0 2.4" stroke-linecap="round" opacity=".22"/>` +
      `<path d="${g.front}" fill="none" stroke="url(#dg)" stroke-width=".72" stroke-dasharray="0 2.4" stroke-linecap="round" opacity=".85"/>` +
      `<g fill="url(#dg)">${nodes}</g>`;
  } else {
    let back = "", front = "", limb = "", nodes = "";
    const dot = (p, r, op) => `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(r)}"${op < 0.995 ? ` opacity="${f(op)}"` : ""}/>`;
    const put = (la, lo) => {
      const p = project(la * D, lo * D, cx, cy, R - 1.2);
      if (p.z < 0) back += dot(p, 0.26, 0.16 + 0.1 * (1 + p.z));
      else if (p.z < 0.28) limb += dot(p, 0.3, 0.95); // dots crowd at the limb: the bright edge
      else front += dot(p, 0.27 + 0.13 * p.z, 0.5 + 0.4 * p.z);
    };
    for (const la of lats) for (let lo = 0; lo < 360; lo += 2.4) put(la, lo);
    for (const lo of lons) for (let la = -81; la <= 81; la += 2.4) put(la, lo);
    for (const la of lats) for (const lo of lons) {
      const p = project(la * D, lo * D, cx, cy, R - 1.2);
      if (p.z > 0.1) nodes += dot(p, 0.42 + 0.26 * p.z, 1);
    }
    grid = `<g fill="url(#dg)">${back}${front}${limb}${nodes}</g>`;
  }
  let halo = "";
  for (let i = 0, N = lite ? 90 : 520; i < N; i++) {
    const t = rnd() * 2 * Math.PI, bias = 0.5 + 0.5 * Math.abs(Math.cos(t + Math.PI / 4));
    const d = R * fold(t) + 0.8 + Math.pow(rnd(), 2.4) * 9 * bias;
    const op = Math.max(0.1, 1 - (d - R) / 10) * (0.45 + 0.55 * rnd());
    halo += `<circle cx="${f(cx + d * Math.cos(t))}" cy="${f(cy + d * Math.sin(t))}" r="${f((lite ? 0.24 : 0.16) + 0.24 * rnd())}" opacity="${f(op)}"/>`;
  }
  const glow = blob(cx + 1.6, cy + 1.6, R + 0.4, 1, n);
  RIP = 0; PREC = 2;
  const defs = `<defs>${rimGrad("g", [16, 14], [84, 86])}${dotGrad("dg", [18, 16], [82, 84])}${bodyGrad("b", cx, cy, R).replace(/fx="[^"]*" fy="[^"]*"/, 'fx="44" fy="40"')}` +
    `<path id="in" d="${inner}"/><clipPath id="k"><use href="#in"/></clipPath>` +
    `<filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>` +
    `<filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation=".6"/></filter>` +
    `<radialGradient id="sheen" gradientUnits="userSpaceOnUse" cx="64" cy="66" r="32"><stop offset="0" stop-color="${C.magenta}" stop-opacity=".36"/><stop offset="1" stop-color="${C.magenta}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="sheen2" gradientUnits="userSpaceOnUse" cx="34" cy="30" r="26"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".24"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient></defs>`;
  return defs +
    `<path d="${glow}" fill="url(#g)" opacity=".8" filter="url(#blur)"/>` +
    `<g fill="url(#dg)">${halo}</g>` +
    `<path d="${out}" fill="url(#g)"/><use href="#in" fill="url(#b)"/>` +
    `<g clip-path="url(#k)"><use href="#in" fill="url(#sheen)"/><use href="#in" fill="url(#sheen2)"/>` +
    `<use href="#in" fill="none" stroke="url(#dg)" stroke-width="2.4" opacity=".55" filter="url(#soft)"/>${grid}</g>`;
}

/** 16 px, on the pixel grid: the folds are under a pixel here, so a true circle. */
function fav16() {
  return `<defs>${rimGrad("g", [2, 2], [14, 14])}${lineGrad("l", [3, 3], [13, 13])}${bodyGrad("b", 7.6, 7.6, 6.4)}</defs>` +
    `<circle cx="8" cy="8" r="7.75" fill="url(#g)"/><circle cx="7.55" cy="7.55" r="6.1" fill="url(#b)"/>` +
    `<g fill="none" stroke="url(#l)" stroke-width="1"><ellipse cx="7.5" cy="7.5" rx="2.5" ry="5.6"/><path d="M1.9 7.5H13.1"/></g>`;
}

/** 32 px: the folded rim and a curved grid of bright dots. */
function fav32() {
  const cx = 16, cy = 16, R = 15.3, rim = 1.9, amp = 0.7;
  const out = blob(cx, cy, R, amp, 72), inner = blob(cx - rim * 0.45, cy - rim * 0.45, R - rim, amp, 72);
  const dots = gridDots(cx, cy, R - rim * 0.8, [-50, -20, 10, 40], [-75, -40, -5, 30, 65], 0.75, 1.45, 0.3);
  return `<defs>${rimGrad("g", [cx - R * 0.78, cy - R * 0.78], [cx + R * 0.78, cy + R * 0.78])}${lineGrad("l", [cx - R * 0.7, cy - R * 0.7], [cx + R * 0.7, cy + R * 0.7])}${bodyGrad("b", cx, cy, R)}<clipPath id="k"><path d="${inner}"/></clipPath></defs>` +
    `<path d="${out}" fill="url(#g)"/><path d="${inner}" fill="url(#b)"/><g clip-path="url(#k)"><g fill="url(#l)">${dots}</g></g>`;
}

const svg = (vb, px, inner) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Joya" viewBox="0 0 ${vb} ${vb}" width="${px}" height="${px}">${inner}</svg>\n`;

/** The SVGs shipped in public/, deterministic. */
function files() {
  return {
    "brand/favicon-16.svg": svg(16, 16, fav16()),
    "brand/favicon-32.svg": svg(32, 32, fav32()),
    "favicon.svg": svg(100, 64, full({ lite: true })),
  };
}

/** Drawings that are only rasterised (not shipped as SVG). */
function rasterSources() {
  const master = full();
  return {
    master: svg(100, 512, master),
    tile: svg(100, 512, `<defs>${field}</defs><rect width="100" height="100" fill="url(#bg)"/><g transform="translate(9 9) scale(.82)">${master}</g>`),
    maskable: svg(100, 512, `<defs>${field}</defs><rect width="100" height="100" fill="url(#bg)"/>` +
      `<circle cx="50" cy="50" r="40" fill="${C.violet}" opacity=".10"/><g transform="translate(15 15) scale(.7)">${master}</g>`),
  };
}

// The PNGs and what each is drawn from.
const RASTERS = [
  { file: "brand/app-icon-180.png", from: "tile", size: 180 },
  { file: "brand/app-icon-192.png", from: "master", size: 192 },
  { file: "brand/app-icon-512.png", from: "master", size: 512 },
  { file: "brand/app-icon-maskable-512.png", from: "maskable", size: 512 },
];
const ICO = [
  { size: 16, from: "brand/favicon-16.svg" },
  { size: 32, from: "brand/favicon-32.svg" },
  { size: 48, from: "favicon.svg" },
];

/** A .ico of PNG entries (Vista+ and every browser read these). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/** Width/height of a PNG buffer (for the tests). */
function pngSize(b) {
  if (!b || b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** The .ico's entries: [{ size, png: {w,h} }]. */
function readIco(b) {
  if (b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  const n = b.readUInt16LE(4), out = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16, len = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
    out.push({ size: b[e] || 256, png: pngSize(b.subarray(off, off + len)) });
  }
  return out;
}

async function raster() {
  const { chromium } = require(process.env.PW || "playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shot = async (svgText, size) => {
    await page.setViewportSize({ width: size, height: size });
    const src = "data:image/svg+xml;base64," + Buffer.from(svgText).toString("base64");
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete);
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  const src = rasterSources(), shipped = files();
  for (const r of RASTERS) fs.writeFileSync(path.join(PUB, r.file), await shot(src[r.from], r.size));
  const images = [];
  for (const i of ICO) images.push({ size: i.size, data: await shot(shipped[i.from], i.size) });
  fs.writeFileSync(path.join(PUB, "favicon.ico"), ico(images));
  await browser.close();
}

module.exports = { files, rasterSources, RASTERS, ICO, ico, readIco, pngSize };

if (require.main === module) {
  (async () => {
    fs.mkdirSync(path.join(PUB, "brand"), { recursive: true });
    const out = files();
    for (const [name, body] of Object.entries(out)) fs.writeFileSync(path.join(PUB, name), body);
    console.log("wrote", Object.entries(out).map(([n, b]) => `${n} (${(b.length / 1024).toFixed(1)} KB)`).join(", "));
    if (process.argv.includes("--raster")) {
      await raster();
      console.log("wrote", RASTERS.map((r) => r.file).join(", "), "and favicon.ico");
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
