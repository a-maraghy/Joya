"use strict";
/**
 * The Telegram agents' avatars (2026-10-25, the user: "every agent gets a random bot avatar based on what
 * it does"). Each agent wears a small still bot head from JOYA AI's own family -- the core E geometry
 * (public/joya-core-bot.js build(), the same wireframe and accessories) -- told apart from JOYA AI itself:
 * a small tile with a hairline frame instead of a floating glowing core, every other grid line, no glow,
 * its own accessory, colour and face. JOYA AI's own look (the cap with antenna and headphones, joya
 * green) is never given to an agent.
 *
 * The rules:
 *   theme   what the agent does, from its role text by keyword (THEMES: the theme with the most keyword
 *           hits wins, ties in table order; none -> "general")
 *   head    one of the theme's accessories (mail -> headset, design -> beret or pencil, code -> glasses or
 *           goggles, finance -> glasses or tie, research -> magnifier, ...)
 *   hue     one of the theme's colours (HUES: a dark shade on white, a light one on black)
 *   face    smooth / dots / minimal (the core's three face styles)
 *   turn    which way the head is turned
 * Every pick is seeded (mulberry32 over FNV-1a of slug + seed): the first avatar's seed is the slug's
 * own hash, so it never changes on reload, and two agents with the same role still differ. The spec is
 * stored in agent.json ("avatar", joya-helper validate_avatar), so editing the role later does not
 * change the face; Settings ▸ Avatar shuffles (a new seed) and "Use this" stores the one shown.
 *
 * Rendered on the server as a static inline SVG (no script, no canvas, no WebGL): its colours are CSS
 * custom properties (joya-ds.css .av), so it follows the light and dark theme. Decorative: aria-hidden,
 * the agent's name is always beside it in text. svg(spec, {standalone}) is the same drawing with fixed
 * colours on a plate, for the download (the PNG is made from it in the browser, public/agent-avatar.js).
 */

const path = require("path");
const B = require(path.join(__dirname, "..", "public", "joya-core-bot.js"));

/** Restrained identity colours: [light theme (dark shade, >= 4.5:1 on white), dark theme (light shade, >= 7:1 on black)]. */
const HUES = {
  teal: ["#0F766E", "#5EEAD4"],
  blue: ["#1D4ED8", "#93C5FD"],
  indigo: ["#4338CA", "#A5B4FC"],
  violet: ["#7E22CE", "#D8B4FE"],
  rose: ["#BE123C", "#FDA4AF"],
  orange: ["#C2410C", "#FDBA74"],
  amber: ["#A16207", "#FCD34D"],
  green: ["#15803D", "#86EFAC"],
};
const FACES = ["smooth", "dots", "minimal"];
/** Every head an agent may wear: the core's ten without JOYA AI's own "cap", plus the agents' five (joya-core-bot.js XHEADS). */
const HEADS = B.HEAD_IDS.filter((h) => h !== "cap").concat(Object.keys(B.XHEADS));
const TURNS = ["l", "r"];

/**
 * What an agent does -> its theme. re: whole-word-ish keywords in the role text (case-insensitive);
 * heads / hues: the theme's choices, one picked by the seed.
 */
const THEMES = [
  { id: "mail", label: "Email", heads: ["headset"], hues: ["blue", "teal", "indigo"],
    re: /\be-?mails?\b|\bmail(?:s|box|boxes)?\b|\binbox(?:es)?\b|\boutlook\b|\bgmail\b|\bnewsletters?\b|\bsmtp\b|\bimap\b/gi },
  { id: "support", label: "Support", heads: ["headset", "headphones"], hues: ["teal", "blue", "green"],
    re: /\bsupport\b|\bcustomers?\b|\bhelp ?desk\b|\btickets?\b|\bchat(?:s|bot)?\b|\bcomplaints?\b|\bfaq\b|\bconcierge\b/gi },
  { id: "design", label: "Design", heads: ["beret", "pencil"], hues: ["rose", "violet", "orange"],
    re: /\bdesign(?:s|er|ers|ing)?\b|\blogos?\b|\bbrand(?:s|ing)?\b|\bdraw(?:s|ing|ings|n)?\b|\billustrat\w*|\bgraphics?\b|\bicons?\b|\bsketch\w*|\bposters?\b|\bmoodboards?\b|\bvisual\w*|\bart(?:work|ist)?\b|\bui\b|\bux\b/gi },
  { id: "code", label: "Code", heads: ["glasses", "goggles"], hues: ["green", "teal", "indigo"],
    re: /\bcod(?:e|es|ing|er)\b|\bdevelop\w*|\bdev\b|\bodoo\b|\bpython\b|\bjavascript\b|\btypescript\b|\bprogramm\w*|\bengineer\w*|\bdeploy\w*|\bgit(?:hub)?\b|\bmodules?\b|\bapi\b|\bdebug\w*|\bmigrations?\b/gi },
  { id: "finance", label: "Finance", heads: ["glasses", "tie"], hues: ["amber", "green", "blue"],
    re: /\bfinanc\w*|\binvoic\w*|\baccount(?:s|ing|ant)\b|\btax(?:es)?\b|\bcustoms\b|\bpayroll\b|\bbudget\w*|\bbank\w*|\bexpenses?\b|\bpayments?\b|\bledger\b|\bvat\b/gi },
  { id: "research", label: "Research", heads: ["magnifier", "glasses"], hues: ["indigo", "violet", "teal"],
    re: /\bresearch\w*|\banaly[sz]\w*|\binvestigat\w*|\bstud(?:y|ies)\b|\bmarket\b|\bcompetitors?\b|\binsights?\b|\bfind out\b|\bsources?\b/gi },
  { id: "writing", label: "Writing", heads: ["pencil", "beret"], hues: ["violet", "rose", "indigo"],
    re: /\bwrit(?:e|es|ing|er|ten)\b|\bcopy(?:writing)?\b|\bblogs?\b|\barticles?\b|\bcontent\b|\bedit(?:s|ing|or)?\b|\btranslat\w*|\bposts?\b|\bcaptions?\b/gi },
  { id: "schedule", label: "Assistant", heads: ["bowtie", "headphones"], hues: ["teal", "amber", "blue"],
    re: /\bcalendars?\b|\bschedul\w*|\bmeetings?\b|\bappointments?\b|\bbriefs?\b|\bbriefing\w*|\bassistant\b|\bsecretary\b|\breminders?\b|\btasks?\b|\bto-?dos?\b/gi },
  { id: "teaching", label: "Teaching", heads: ["mortar"], hues: ["indigo", "amber"],
    re: /\bteach\w*|\btutor\w*|\blearn\w*|\bcourses?\b|\bschool\b|\blessons?\b|\bquiz\w*|\bexplain\w*/gi },
  { id: "ops", label: "Operations", heads: ["antennas", "goggles"], hues: ["orange", "amber", "teal"],
    re: /\bservers?\b|\bdevops\b|\bmonitor\w*|\binfra\w*|\bbackups?\b|\bsecurity\b|\buptime\b|\balerts?\b|\blogs?\b|\bnginx\b|\bdocker\b/gi },
];
const GENERAL = { id: "general", label: "General", heads: HEADS, hues: Object.keys(HUES) };
const THEME_IDS = THEMES.map((t) => t.id).concat([GENERAL.id]);

/* ------------------------------------------------------------ seeded picks */

/** FNV-1a, 32 bit. */
function hash(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** mulberry32: a small, good, deterministic PRNG. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];

/** The theme of a role text: the most keyword hits wins (ties: table order); nothing -> general. */
function themeOf(text) {
  const s = String(text || "");
  let best = GENERAL, bestN = 0;
  for (const t of THEMES) {
    const n = (s.match(t.re) || []).length;
    if (n > bestN) { best = t; bestN = n; }
  }
  return best;
}
const themeById = (id) => THEMES.find((t) => t.id === id) || GENERAL;

/**
 * The avatar for an agent: derive(slug, text, seed?) -> {v, theme, head, face, hue, turn, seed}.
 * seed: absent -> the slug's own hash (the first avatar, stable); a shuffle passes a new one.
 */
function derive(slug, text, seed, themeId) {
  const th = themeId && THEME_IDS.includes(themeId) ? themeById(themeId) : themeOf(text);
  const sd = Number.isInteger(seed) && seed >= 0 && seed <= 0x7fffffff ? seed : hash(slug) & 0x7fffffff;
  const r = rng(hash(String(slug) + ":" + sd));
  return { v: 1, theme: th.id, head: pick(r, th.heads), face: pick(r, FACES), hue: pick(r, th.hues), turn: pick(r, TURNS), seed: sd };
}

/**
 * Settings ▸ Avatar ▸ Shuffle: a new seed in the current avatar's theme (what the agent does stays what it
 * was judged to be), a different look from `current` where it can (another head, colour or face).
 */
function shuffle(slug, text, current) {
  const cur = norm(current), theme = cur ? cur.theme : themeOf(text).id;
  for (let i = 0; i < 12; i++) {
    const d = derive(slug, text, Math.floor(Math.random() * 0x7fffffff), theme);
    if (!cur || d.head !== cur.head || d.hue !== cur.hue || d.face !== cur.face) return d;
  }
  return derive(slug, text, Math.floor(Math.random() * 0x7fffffff), theme);
}

/**
 * A stored / posted spec, checked against the whitelists (the same as joya-helper validate_avatar):
 * exactly these keys, each value one of its list. Anything else -> null.
 */
const KEYS = ["v", "theme", "head", "face", "hue", "turn", "seed"];
function norm(a) {
  if (typeof a === "string") { try { a = JSON.parse(a); } catch (_) { return null; } }
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const keys = Object.keys(a);
  if (keys.length !== KEYS.length || !keys.every((k) => KEYS.includes(k))) return null;
  if (a.v !== 1 || !THEME_IDS.includes(a.theme) || !HEADS.includes(a.head) || !FACES.includes(a.face) || !Object.prototype.hasOwnProperty.call(HUES, a.hue) || !TURNS.includes(a.turn)) return null;
  if (!Number.isInteger(a.seed) || a.seed < 0 || a.seed > 0x7fffffff) return null;
  return { v: 1, theme: a.theme, head: a.head, face: a.face, hue: a.hue, turn: a.turn, seed: a.seed };
}

/** The text an agent is judged by: its role, else its name. */
const roleText = (agent) => [agent && agent.role, agent && agent.name].filter(Boolean).join("\n");
/** The avatar an agent wears: the stored one, else the one its slug and role give (stable). */
function specFor(agent) {
  return norm(agent && agent.avatar) || derive((agent && agent.slug) || "agent", roleText(agent));
}

/* ------------------------------------------------------------ drawing */

const F = (n) => Math.round(n * 10) / 10;
const VB = 64;
const cache = new Map();

/** Every vertex projected into the box (x0, y0, w, h), the head turned by its yaw (mirrored for turn "l"). */
function project(head, turn, box) {
  const geo = B.build(head, "lo"), cfg = B.HEADS[head] || B.XHEADS[head], V = geo.v, n = geo.n;
  const yaw = Math.abs(cfg.yaw) * (turn === "l" ? -1 : 1), tilt = cfg.tilt || 0.12;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) {
    const b = i * 7, x = V[b], y = V[b + 1], z = V[b + 2];
    const xa = x * cy + z * sy, za = -x * sy + z * cy, yb = y * ct - za * st, zb = za * ct + y * st;
    X[i] = xa; Y[i] = -yb; Z[i] = zb;
    if (V[b + 3] === 5) continue; // off-grid front nodes do not set the bounds
    x0 = Math.min(x0, xa); x1 = Math.max(x1, xa); y0 = Math.min(y0, -yb); y1 = Math.max(y1, -yb);
  }
  const s = Math.min(box[2] / (x1 - x0), box[3] / (y1 - y0));
  const ox = box[0] + (box[2] - (x1 - x0) * s) / 2 - x0 * s, oy = box[1] + (box[3] - (y1 - y0) * s) / 2 - y0 * s;
  for (let i = 0; i < n; i++) { X[i] = X[i] * s + ox; Y[i] = Y[i] * s + oy; }
  return { geo, X, Y, Z, s };
}

/** A point on the face (u, v in -1..1, v up) through the front grid's projection (bilinear between its nodes). */
function facePoint(P, u, v) {
  const G = B.G, GN = B.GN, fr = P.geo.front;
  const fi = Math.max(0, Math.min(G - 1e-6, ((u + 1) / 2) * G)), fj = Math.max(0, Math.min(G - 1e-6, ((v + 1) / 2) * G));
  const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
  const n00 = fr[i * GN + j], n10 = fr[(i + 1) * GN + j], n01 = fr[i * GN + j + 1], n11 = fr[(i + 1) * GN + j + 1];
  const lerp = (A) => (A[n00] * (1 - a) + A[n10] * a) * (1 - b) + (A[n01] * (1 - a) + A[n11] * a) * b;
  return [lerp(P.X), lerp(P.Y)];
}
/** The face's features as SVG, in the hue (class av-c). */
function faceSvg(P, face, lite) {
  const K = lite ? 1.3 : 1;
  const pt = (u, v) => facePoint(P, u, v);
  const unit = (u, v) => { const a = pt(u - 0.05, v), b = pt(u + 0.05, v), c = pt(u, v - 0.05), d = pt(u, v + 0.05); return [Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1, Math.hypot(d[0] - c[0], d[1] - c[1]) / 0.1]; };
  const curve = (u0, u1, v0, sag, steps) => {
    let d = "";
    for (let k = 0; k <= steps; k++) { const u = u0 + (u1 - u0) * (k / steps), t = (u - (u0 + u1) / 2) / ((u1 - u0) / 2), q = pt(u, v0 - sag * (1 - t * t)); d += (k ? "L" : "M") + F(q[0]) + " " + F(q[1]); }
    return d;
  };
  const sw = F(P.s * 0.075 * K);
  let out = "";
  if (face === "dots") {
    const r = F(P.s * 0.038 * K);
    for (const s of [-1, 1]) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const q = pt(s * 0.38 + a * 0.085, 0.14 + b * 0.085); out += `<circle cx="${F(q[0])}" cy="${F(q[1])}" r="${r}"/>`; }
    for (let k = 0; k < 7; k++) { const u = -0.3 + 0.1 * k, t = u / 0.3, q = pt(u, -0.36 - 0.12 * (1 - t * t)); out += `<circle cx="${F(q[0])}" cy="${F(q[1])}" r="${r}"/>`; }
    return `<g class="av-c av-fill">${out}</g>`;
  }
  const tall = (face === "minimal" ? [0.055, 0.16] : [0.1, 0.17]).map((x) => x * K);
  for (const s of [-1, 1]) {
    const c = pt(s * 0.38, 0.14), k = unit(s * 0.38, 0.14);
    out += `<ellipse cx="${F(c[0])}" cy="${F(c[1])}" rx="${F(tall[0] * k[0])}" ry="${F(tall[1] * k[1])}"/>`;
    if (face === "smooth") { const h = pt(s * 0.38 + 0.035, 0.2); out += `<circle class="av-hl" cx="${F(h[0])}" cy="${F(h[1])}" r="${F(0.032 * k[0])}"/>`; }
  }
  const mouth = face === "minimal" ? curve(-0.2, 0.2, -0.4, 0.05, 6) : curve(-0.3, 0.3, -0.34, 0.16, 10);
  return `<g class="av-c av-fill">${out}</g><path class="av-c av-line" d="${mouth}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`;
}

/** The convex hull of the head's own vertices (its silhouette), as a closed path. */
function silhouette(P) {
  const V = P.geo.v, pts = [];
  for (let i = 0; i < P.geo.n; i++) { const k = V[i * 7 + 3]; if (k === 0 || k === 5) pts.push([P.X[i], P.Y[i]]); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  const h = lo.slice(0, -1).concat(hi.slice(0, -1));
  return h.map((p, i) => (i ? "L" : "M") + F(p[0]) + " " + F(p[1])).join("") + "Z";
}

/**
 * The inner drawing (no <svg> wrapper) of one spec, cached. Back to front: the accessory's far side, the head's
 * silhouette as a plate (it hides what is behind the head), the head's front grid, the accessory's near side, the
 * lit parts and the face. lite (the small table tiles): the nearest grid lines only, heavier strokes, a bolder face.
 */
function inner(spec, lite) {
  const key = [spec.head, spec.face, spec.turn, lite ? 1 : 0].join(":");
  if (cache.has(key)) return cache.get(key);
  const P = project(spec.head, spec.turn, lite ? [5, 4, 54, 56] : [8, 7, 48, 50]), V = P.geo.v, L = P.geo.lines;
  const band = ["", "", ""], acc = ["", ""];
  let lit = "", rods = "";
  for (let i = 0; i < L.length; i += 2) {
    const a = L[i], b = L[i + 1], ka = V[a * 7 + 3];
    const seg = `M${F(P.X[a])} ${F(P.Y[a])}L${F(P.X[b])} ${F(P.Y[b])}`;
    if (ka === 6) { rods += seg; continue; }
    if (ka === 2) { lit += seg; continue; }
    const za = P.Z[a], zb = P.Z[b];
    if (ka === 0 && (za < -0.02 || zb < -0.02)) continue; // the head's far side: behind the plate anyway
    const d = ((za + zb) / 2 + 1) / 2;
    if (ka === 1) { acc[d < 0.5 ? 0 : 1] += seg; continue; }
    band[d < 0.5 ? 0 : d < 0.78 ? 1 : 2] += seg;
  }
  let joints = "";
  for (let i = 0; i < P.geo.n; i++) {
    const k = V[i * 7 + 3];
    if (k !== 3 && k !== 4) continue;
    joints += `<circle class="${k === 4 ? "av-c av-fill" : "av-w av-fill"}" cx="${F(P.X[i])}" cy="${F(P.Y[i])}" r="${F(P.s * (lite ? 0.07 : 0.05))}"/>`;
  }
  const k = lite ? 1.7 : 1;
  const out =
    (acc[0] ? `<path class="av-w av-line" d="${acc[0]}" fill="none" stroke-width="${F(0.45 * k)}" opacity="${lite ? ".45" : ".4"}"/>` : "") +
    `<path class="av-plate" d="${silhouette(P)}" stroke-width="${F(0.9 * k)}" stroke-linejoin="round"/>` +
    `<g class="av-w av-line" fill="none" stroke-linecap="round">` +
    (!lite && band[0] ? `<path d="${band[0]}" stroke-width=".35" opacity=".14"/>` : "") +
    (!lite && band[1] ? `<path d="${band[1]}" stroke-width=".4" opacity=".28"/>` : "") +
    (band[2] ? `<path d="${band[2]}" stroke-width="${lite ? ".5" : ".45"}" opacity="${lite ? ".3" : ".5"}"/>` : "") +
    (acc[1] ? `<path d="${acc[1]}" stroke-width="${F(0.5 * k)}" opacity="${lite ? ".85" : ".7"}"/>` : "") +
    (rods ? `<path d="${rods}" stroke-width="${F(1 * k)}" opacity=".85"/>` : "") +
    `</g>` +
    (lit ? `<path class="av-c av-line" d="${lit}" fill="none" stroke-width="${F(0.75 * k)}" stroke-linecap="round"/>` : "") +
    joints + faceSvg(P, spec.face, lite);
  cache.set(key, out);
  return out;
}

/**
 * The avatar as SVG. In a page (default): decorative, colours from CSS (.av / .av-h-<hue>, joya-ds.css).
 * standalone "light" | "dark": a file of its own -- fixed colours on a plate, for the download.
 */
function svg(spec, o = {}) {
  spec = norm(spec) || derive("agent", "");
  const body = inner(spec, !!o.lite);
  if (o.standalone) {
    const dark = o.standalone === "dark", hue = HUES[spec.hue][dark ? 1 : 0], ink = dark ? "#FFFFFF" : "#000000", bg = dark ? "#000000" : "#FFFFFF";
    const coloured = body
      .replace(/class="av-w av-line"/g, `stroke="${ink}"`)
      .replace(/class="av-c av-line"/g, `stroke="${hue}"`)
      .replace(/class="av-c av-fill"/g, `fill="${hue}"`)
      .replace(/class="av-w av-fill"/g, `fill="${ink}"`)
      .replace(/class="av-hl"/g, `fill="${bg}"`)
      .replace(/class="av-plate"/g, `fill="${bg}" stroke="${ink}"`);
    const px = o.px || 640;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${px}" height="${px}">` +
      `<rect width="${VB}" height="${VB}" fill="${bg}"/><g transform="translate(6.4 6.4) scale(.8)">${coloured}</g></svg>\n`;
  }
  return `<svg class="av-svg" viewBox="0 0 ${VB} ${VB}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** The tile a page shows: <span class="av av-<size> av-h-<hue>"> + the SVG. size: sm (tables) / md (page heads) / lg (Settings). */
function tile(spec, size) {
  spec = norm(spec) || derive("agent", "");
  const sz = ["sm", "md", "lg"].includes(size) ? size : "sm";
  return `<span class="av av-${sz} av-h-${spec.hue}" aria-hidden="true">${svg(spec, { lite: sz !== "lg" })}</span>`;
}
/** An agent's tile (its stored avatar, else the derived one). */
const agentTile = (agent, size) => tile(specFor(agent), size);

/** Words for Settings: "Email theme · headset · blue · smooth face". */
const HEAD_WORDS = { headphones: "headphones", beanie: "beanie", goggles: "goggles", headset: "headset", ears: "cat ears", halo: "halo", mortar: "graduation cap", antennas: "antennas", bowtie: "bow tie", beret: "beret", glasses: "glasses", magnifier: "magnifier", pencil: "pencil", tie: "tie" };
const FACE_WORDS = { smooth: "smooth face", dots: "dot face", minimal: "minimal face" };
function describe(spec) {
  spec = norm(spec) || derive("agent", "");
  return `${themeById(spec.theme).label} · ${HEAD_WORDS[spec.head] || spec.head} · ${spec.hue} · ${FACE_WORDS[spec.face]}`;
}

module.exports = { HUES, FACES, HEADS, TURNS, THEMES, THEME_IDS, KEYS, hash, themeOf, derive, shuffle, norm, specFor, roleText, svg, tile, agentTile, describe };
