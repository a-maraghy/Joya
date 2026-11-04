/**
 * The Joya brand: marks, favicons, fonts, tokens and the chrome that wears them.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-brand.cjs
 *
 * Static checks, then the real server.js on a scratch port (scratch data dir,
 * no supervisor) to check the files are served with the right content types
 * and that pages reference them:
 *
 *  - the M monogram favicons are current with tools/make-monogram.cjs, and the
 *    leaf marks (lib/marks.js, tools/make-brand.cjs) are gone;
 *  - the fonts (Atkinson Hyperlegible Next + Mono, 2026-10-25) are self-hosted
 *    with their licences, latin woff2 only;
 *  - style.css declares them and holds the redesign's palette in both themes, every
 *    text token at 4.5:1 or more and every control edge at 3:1 or more;
 *  - every page (JOYA AI's too) carries the M monogram in the tab, the app icon
 *    set for apple-touch and the web app manifest (tools/make-app-icon.cjs); every top bar
 *    (JOYA AI's too) carries the same logo: the word JOYA as text, no leaf, no tag;
 *  - the sign-in page carries the wordmark and no leaf;
 *  - no seedling, leaf or spark is left in lib/brand.js; no style="" anywhere.
 *
 * .cjs because it uses require.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "joya-brand-"));
fs.mkdirSync(path.join(DATA, "log"));
process.env.JOYA_DATA_DIR = DATA;
process.env.JOYA_LOG_DIR = path.join(DATA, "log");
const PORT = 3800 + Math.floor(Math.random() * 90);

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}

/* ------------------------------------------------------------- files --- */

const mono = require("./make-monogram.cjs");
for (const [name, body] of Object.entries(mono.files())) {
  const f = path.join(PUB, "brand", "m", name);
  check(`brand/m/${name} is current with tools/make-monogram.cjs`, fs.existsSync(f) && fs.readFileSync(f, "utf8") === body);
}
check("the monogram is black on white, white on black in dark mode, and draws an M", Object.values(mono.files()).every((b) => /\.t\{fill:#FFFFFF;stroke:#000000\}/.test(b) && /prefers-color-scheme: dark\)\{\.t\{fill:#000000;stroke:#FFFFFF\}/.test(b) && /<path class="m" d="M/.test(b) && !/<image|<text|url\(|href=/.test(b)));
{
  const entries = require("./make-app-icon.cjs").readIco(fs.readFileSync(path.join(PUB, "brand/m/favicon.ico")));
  check("brand/m/favicon.ico holds 16/32/48 PNGs", !!entries && entries.map((e) => `${e.size}:${e.png && e.png.w}x${e.png && e.png.h}`).join(",") === "16:16x16,32:32x32,48:48x48", JSON.stringify(entries));
}
for (const gone of ["lib/marks.js", "tools/make-brand.cjs", "public/brand/joya-os-mark.svg", "public/brand/joya-ai-mark.svg"]) {
  check(`the leaf ${gone} is gone`, !fs.existsSync(path.join(ROOT, gone)));
}
// The Joya icon ("Mesh"), the same on every page: tools/make-app-icon.cjs.
const appIcon = require("./make-app-icon.cjs");
for (const [name, body] of Object.entries(appIcon.files())) {
  const f = path.join(PUB, name);
  check(`${name} is current with tools/make-app-icon.cjs`, fs.existsSync(f) && fs.readFileSync(f, "utf8") === body);
}
check("the light favicon.svg stays small (every page fetches it)", fs.statSync(path.join(PUB, "favicon.svg")).size < 48 * 1024, fs.statSync(path.join(PUB, "favicon.svg")).size);
check("the icon SVGs embed no raster, font or outside reference", Object.values(appIcon.files()).every((b) => !/<image|<text|@import|url\((?!#)|href="(?!#)/.test(b.replace(/xmlns="[^"]*"/, ""))));
for (const r of appIcon.RASTERS) {
  const b = fs.existsSync(path.join(PUB, r.file)) ? fs.readFileSync(path.join(PUB, r.file)) : null;
  const sz = b && appIcon.pngSize(b);
  check(`${r.file} is a ${r.size}x${r.size} PNG`, !!sz && sz.w === r.size && sz.h === r.size, JSON.stringify(sz));
}
{
  const entries = appIcon.readIco(fs.readFileSync(path.join(PUB, "favicon.ico")));
  check("favicon.ico holds 16/32/48 PNGs", !!entries && entries.map((e) => `${e.size}:${e.png && e.png.w}x${e.png && e.png.h}`).join(",") === "16:16x16,32:32x32,48:48x48", JSON.stringify(entries));
}
for (const gone of ["favicon-ai.svg", "favicon-ai.ico", "brand/favicon-os-16.svg", "brand/favicon-os-32.svg", "brand/favicon-ai-16.svg", "brand/favicon-ai-32.svg"]) {
  check(`the old leaf favicon ${gone} is gone`, !fs.existsSync(path.join(PUB, gone)));
}

// The 2026-10-25 redesign: one family, Atkinson Hyperlegible Next, and its Mono.
check("the three old families (Space Grotesk, Inter, JetBrains Mono) are gone", !fs.readdirSync(path.join(PUB, "fonts")).some((f) => /space-grotesk|inter-|jetbrains|OFL-(Inter|SpaceGrotesk|JetBrainsMono)/.test(f)));
const FONTS = [
  ...[400, 500, 600, 700, 800].map((w) => `atkinson-hyperlegible-next-latin-${w}-normal.woff2`),
  ...[400, 500, 600].map((w) => `atkinson-hyperlegible-mono-latin-${w}-normal.woff2`),
];
const fontDir = fs.readdirSync(path.join(PUB, "fonts"));
check("the eight latin woff2 faces are self-hosted", FONTS.every((f) => fontDir.includes(f)), FONTS.filter((f) => !fontDir.includes(f)).join(" "));
check("nothing but latin woff2 and the licences in public/fonts", fontDir.every((f) => /^[a-z-]+-latin-\d{3}-normal\.woff2$/.test(f) || /^OFL-.*\.txt$/.test(f)), fontDir.join(" "));
for (const lic of ["OFL-AtkinsonHyperlegibleNext.txt", "OFL-AtkinsonHyperlegibleMono.txt"]) {
  const t = fs.existsSync(path.join(PUB, "fonts", lic)) ? fs.readFileSync(path.join(PUB, "fonts", lic), "utf8") : "";
  check(`${lic} is the SIL Open Font License`, /SIL Open Font License, Version 1\.1/.test(t));
}
check("each face is a real woff2 (wOF2 magic)", FONTS.every((f) => fs.readFileSync(path.join(PUB, "fonts", f)).slice(0, 4).toString() === "wOF2"));

const css = fs.readFileSync(path.join(PUB, "style.css"), "utf8");
check("style.css declares all eight faces, from public/fonts", FONTS.every((f) => css.includes(`url("fonts/${f}?v=`)));
check("one family for reading, its Mono for code", /--ui: "Atkinson Hyperlegible Next"/.test(css) && /--brand-font: var\(--ui\)/.test(css) && /--mono: "Atkinson Hyperlegible Mono"/.test(css));
check("no font is fetched from anywhere but the panel", !/url\(["']?https?:/.test(css) && !/@import/.test(css));
const light = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
const dark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)[1];
check("light: a white ground with black as the accent", /--bg: #FFFFFF/.test(light) && /--accent: #000000/.test(light) && /--on-accent: #FFFFFF/.test(light));
check("dark: a black ground with white as the accent", /--bg: #000000/.test(dark) && /--accent: #FFFFFF/.test(dark) && /--on-accent: #000000/.test(dark));
check("no glow: the old glow token is transparent", /--glow: transparent/.test(light));
{
  // Joya #00E6A5 is never a text colour on the light ground.
  const textRules = [...light.matchAll(/--(accent|brand-deep|good-ink|wordmark|ink|body|muted): (#[0-9A-Fa-f]{6})/g)];
  check("no light-theme text token is the bright joya", textRules.every((m) => m[2].toUpperCase() !== "#00E6A5"), textRules.map((m) => m[1] + m[2]).join(" "));
}
{
  // WCAG contrast of the light text tokens on white and on the ground.
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const tok = (block, n) => (new RegExp("--" + n + ": (#[0-9A-Fa-f]{6})").exec(block) || [])[1];
  for (const n of ["ink", "body", "muted", "dim", "accent", "ok", "warn", "bad", "info", "violet-ink"]) {
    for (const g of ["bg", "panel", "panel-2"]) {
      check(`light --${n} reads at >= 4.5:1 on --${g}`, ratio(tok(light, n), tok(light, g)) >= 4.5, ratio(tok(light, n), tok(light, g)).toFixed(2));
      check(`dark --${n} reads at >= 4.5:1 on --${g}`, ratio(tok(dark, n), tok(dark, g)) >= 4.5, ratio(tok(dark, n), tok(dark, g)).toFixed(2));
    }
  }
  check("text on the accent fill reads at >= 4.5:1, both themes", ratio(tok(light, "on-accent"), tok(light, "accent")) >= 4.5 && ratio(tok(dark, "on-accent"), tok(dark, "accent")) >= 4.5);
  check("a control's edge (--line-strong) is >= 3:1 on the page and the panel, both themes",
    ["bg", "panel"].every((g) => ratio(tok(light, "line-strong"), tok(light, g)) >= 3 && ratio(tok(dark, "line-strong"), tok(dark, g)) >= 3));
}

/* ---------------------------------------------------------- rendering --- */

const ui = require(path.join(ROOT, "lib", "ui.js"));
const brand = require(path.join(ROOT, "lib", "brand.js"));
const views = require(path.join(ROOT, "lib", "views.js"));
const osPage = ui.shell("Services", "<p>x</p>", { user: { name: "desk" }, active: "services", csrf: "c" });
const TOP_LOCKUP = /<a class="brand" href="[^"]*" aria-label="Joya">\s*<span class="wordmark brand-text"><span class="wm-joya">JOYA<\/span><\/span>\s*<\/a>/;
check("an OS page's top bar is the word JOYA as text: no leaf, no [OS] tag", TOP_LOCKUP.test(osPage) && !/pill-brand/.test(osPage) && !/mark-os|lk-mk/.test(osPage));
const ICON_LINKS = (pg) =>
  /<link rel="icon" href="\/static\/brand\/m\/favicon-16\.svg\?v=[^"]+" type="image\/svg\+xml" sizes="16x16">/.test(pg) &&
  /<link rel="icon" href="\/static\/brand\/m\/favicon-32\.svg\?v=[^"]+" type="image\/svg\+xml" sizes="32x32">/.test(pg) &&
  /<link rel="icon" href="\/static\/brand\/m\/favicon\.svg\?v=[^"]+" type="image\/svg\+xml" sizes="any">/.test(pg) &&
  /<link rel="alternate icon" href="\/static\/brand\/m\/favicon\.ico\?v=[^"]+"/.test(pg) &&
  /<link rel="apple-touch-icon" href="\/static\/brand\/app-icon-180\.png\?v=[^"]+" sizes="180x180">/.test(pg) &&
  /<link rel="manifest" href="\/manifest\.webmanifest\?v=[0-9a-f]{10}">/.test(pg) &&
  !/favicon-(os|ai)/.test(pg);
check("an OS page carries the M monogram in the tab (16, 32, any, .ico) and the app icon for apple-touch and the manifest", ICON_LINKS(osPage));
check("an OS page's title ends Joya", /<title>Services — Joya<\/title>/.test(osPage));
// JOYA AI's own page is the Command Center (brand "ai"); the classic chat is gone.
const aiPage = ui.shell("JOYA AI", "<p>x</p>", { user: { name: "desk" }, active: "joya-ai", bare: true, brand: "ai", csrf: "c" });
check("JOYA AI's pages carry the same wordmark (no leaf, no [AI] tag)", TOP_LOCKUP.test(aiPage) && !/pill-brand/.test(aiPage) && !/mark-os|mark-ai|lk-mk/.test(aiPage));
check("JOYA AI's pages carry the same Joya icon (no AI favicon any more)", ICON_LINKS(aiPage) && ui.iconLinks() === ui.iconLinks());
{
  const m = ui.manifest();
  check("the manifest names Joya, starts at / and carries 192, 512 and a maskable 512", m.name === "Joya" && m.start_url === "/" && m.display === "standalone" &&
    m.icons.some((i) => i.sizes === "192x192" && /app-icon-192\.png\?v=/.test(i.src)) && m.icons.some((i) => i.sizes === "512x512" && i.purpose === "any") &&
    m.icons.some((i) => i.purpose === "maskable" && /app-icon-maskable-512\.png\?v=/.test(i.src)) && /^#[0-9A-F]{6}$/i.test(m.theme_color) && /^#[0-9A-F]{6}$/i.test(m.background_color));
}
check("the sidebar's Command Center item carries the plain core icon (no spark, no top-bar tabs)", /<a href="\/joya-ai" class="side-item[^"]*"[^>]*><svg[^>]*class="ico"/.test(osPage) && !/class="ico spark"/.test(osPage) && !/class="top-tab/.test(osPage));
check("the fonts are preloaded from the panel", /<link rel="preload" href="\/static\/fonts\/atkinson-hyperlegible-next-latin-400-normal\.woff2\?v=5\.3\.0" as="font" type="font\/woff2" crossorigin>/.test(osPage));
check("every page loads the redesign's component layer last", /joya-os\.css\?v=[^"]+">\s*<link rel="stylesheet" href="\/static\/joya-ds\.css\?v=/.test(osPage));
check("every framed page starts with a skip link to the content", /<a class="skip-link" href="#main">Skip to content<\/a>/.test(osPage) && /id="main" tabindex="-1"/.test(osPage));
const login = views.login({ csrf: "c" });
check("the sign-in card carries the JOYA wordmark", /<div class="card auth-card"><div class="auth-lockup"><span class="wordmark full"><span class="wm-joya">JOYA<\/span>/.test(login) && /Operating System/.test(login));
check("the sign-in page has no leaf behind the card", !/auth-leaf/.test(login) && !/<svg class="mark/.test(login));
check("lib/brand.js is the wordmark only (no leaf, seedling, spark or watermark)", Object.keys(brand).join() === "lockup");
for (const [n, html] of [["OS page", osPage], ["AI page", aiPage], ["sign-in", login]]) {
  check(`${n}: no style attributes and no inline script (CSP)`, !/\sstyle=/.test(html) && !/<script>(?!<\/script>)/.test(html) && !/<script(?![^>]*\ssrc=)[^>]*>/.test(html));
}

/* -------------------------------------------------------------- HTTP --- */

function req(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: p, headers: { "X-Forwarded-Proto": "https" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.setTimeout(8000, () => r.destroy(new Error("timeout " + p)));
    r.end();
  });
}

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, { JOYA_PORT: String(PORT), JOYA_BIND: "127.0.0.1", JOYA_AI_SOCKET: path.join(DATA, "no.sock"), NODE_ENV: "production" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
    if (!/listening/.test(out)) throw new Error("server did not start: " + out);
    const TYPES = [
      ["/static/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2", "font/woff2"],
      ["/static/fonts/atkinson-hyperlegible-next-latin-800-normal.woff2", "font/woff2"],
      ["/static/fonts/atkinson-hyperlegible-mono-latin-500-normal.woff2", "font/woff2"],
      ["/static/fonts/OFL-AtkinsonHyperlegibleNext.txt", "text/plain"],
      ["/static/brand/m/favicon-16.svg", "image/svg+xml"],
      ["/static/brand/m/favicon.svg", "image/svg+xml"],
      ["/static/brand/m/favicon.ico", "image/x-icon"],
      ["/static/brand/favicon-16.svg", "image/svg+xml"],
      ["/static/brand/favicon-32.svg", "image/svg+xml"],
      ["/static/favicon.svg", "image/svg+xml"],
      ["/static/favicon.ico", "image/x-icon"],
      ["/static/brand/app-icon-180.png", "image/png"],
      ["/static/brand/app-icon-192.png", "image/png"],
      ["/static/brand/app-icon-512.png", "image/png"],
      ["/static/brand/app-icon-maskable-512.png", "image/png"],
      ["/favicon.ico", "image/x-icon"],
      ["/manifest.webmanifest", "application/manifest+json"],
    ];
    for (const [p, type] of TYPES) {
      const r = await req(p);
      check(`${p} -> 200 ${type}`, r.status === 200 && String(r.headers["content-type"] || "").startsWith(type), r.status + " " + r.headers["content-type"]);
    }
    {
      const ico = await req("/favicon.ico");
      check("/favicon.ico is the M monogram, cached a day", ico.body.equals(fs.readFileSync(path.join(PUB, "brand/m/favicon.ico"))) && /max-age=86400/.test(ico.headers["cache-control"] || ""), ico.headers["cache-control"]);
      const plain = await req("/manifest.webmanifest");
      const stamped = await req("/manifest.webmanifest?v=" + ui.MANIFEST_VERSION());
      let m = null; try { m = JSON.parse(stamped.body.toString()); } catch (_) {}
      check("the manifest is public JSON, long-cached when stamped and briefly when not", stamped.status === 200 && !!m && m.name === "Joya" && /max-age=2592000/.test(stamped.headers["cache-control"] || "") && /max-age=300/.test(plain.headers["cache-control"] || ""), stamped.status + " " + stamped.headers["cache-control"] + " / " + plain.headers["cache-control"]);
      for (const i of (m && m.icons) || []) {
        const r = await req(i.src);
        check(`the manifest icon ${i.src.split("?")[0]} loads (${i.type})`, r.status === 200 && String(r.headers["content-type"] || "").startsWith(i.type), r.status + " " + r.headers["content-type"]);
      }
      // A scratch panel has no users yet, so /login sends to /setup, which without its
      // token is the panel's own 404 page -- an error page, rendered by page() like the rest.
      let first = await req("/login");
      if (first.status >= 300 && first.status < 400) first = await req(new URL(first.headers.location, "http://x").pathname);
      check("a served error page (setup without its token) carries the monogram icon links", first.status === 404 && ICON_LINKS(first.body.toString()), first.status);
    }
    const r = await req("/static/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2?v=5.3.0");
    check("a stamped font is cached long", /max-age=2592000/.test(r.headers["cache-control"] || ""), r.headers["cache-control"]);
    const lg = await req("/login");
    const csp = String(lg.headers["content-security-policy"] || "");
    check("the CSP still allows no font or style host but the panel", /default-src 'self'/.test(csp) && /style-src 'self'/.test(csp) && !/fonts\.googleapis|unsafe-inline/.test(csp), csp);
    check("the served sign-in page references only panel assets", !/(href|src)="https?:/.test(lg.body.toString()));
  } catch (e) {
    check("server run", false, e.message);
  } finally {
    child.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
