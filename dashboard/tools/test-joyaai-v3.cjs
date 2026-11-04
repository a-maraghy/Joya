/**
 * Tests for the Command Center v3 page (phase 1): the new frame in
 * lib/views-joyaai.js, and the pure helpers in public/joya-ai.js,
 * public/cc-panels.js and public/cc-map.js, cut out of the files that ship
 * and run here (the approach of test-joyaai-page.cjs).
 *
 *     node dashboard/tools/test-joyaai-v3.cjs
 *
 * What it holds the page to: this VPS only (no live Odoo anywhere), the
 * approved layout (rail, centre Map | Missions, drawer Conversation |
 * Decisions | Timeline | Rules), voice kept in the composer, no inline style
 * or script, every server string escaped, and the helpers that turn schedules,
 * rule patterns and palette queries into what the page shows.
 *
 * The interactions themselves (approvals, rules, watchers, standing orders,
 * missions, budget, deep view, palette) are exercised against a scratch
 * supervisor by the Playwright run described in the v3 hand-off.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const read = (f) => fs.readFileSync(path.join(ROOT, "public", f), "utf8");
const main = read("joya-ai.js"), panels = read("cc-panels.js"), map = read("cc-map.js"), css = read("joya-ai.css");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}
function cut(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}

/* ------------------------------------------------------------ the frame --- */

const admin = rbac.actor({ permissions: ["*"] });
const EVIL = `<img src=x onerror=alert(1)>"'&`;
const html = views.page({ csrf: "t", user: { name: EVIL, perm: admin }, voice: { configured: true, voice: "marin", model: "gpt-realtime-2.1-mini", manage: true, on: true, use: true, live: true } });
const noKey = views.page({ csrf: "t", user: { name: "a", perm: admin }, voice: { configured: false, manage: true, on: true, use: true, live: false } });

check("no live Odoo anywhere in the frame", !/live odoo|gizaseeds\.cloud|test\.gizaseeds/i.test(html + noKey));
check("no live Odoo anywhere in the page scripts", ![main, panels, map].some((s) => /live odoo|gizaseeds\.cloud/i.test(s.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, ""))));
check("no machine filter (Trial / Live) and no second machine card", !/data-m="live"|data-m="trial"|mach-filter/.test(html) && (html.match(/id="cc-mach-this"/g) || []).length === 1);
check("Hire a session: no \"coming later\"; it says how (ask JOYA AI), the limits, Keep / Retire on right-click, and the count of places in use",
  /id="cc-hire-note"[\s\S]{0,300}Hire a session[\s\S]{0,200}id="cc-hire-count"[\s\S]{0,120}Ask JOYA AI to hire a session[\s\S]{0,200}At most 7 sessions at a time and 3 hires an hour[\s\S]{0,80}Keep or retire a hired session with its buttons here, or right-click its sphere/.test(html) &&
  !/Hire a session<\/b><span class="sp"><\/span><span class="cc-tag mute">coming later/.test(html) && /hc\.textContent = nLive \+ " of 7 in use · " \+ nHired \+ " hired";/.test(main));
check("no disabled 'Add a machine'; the Machine sheet links to Computers", !/cc-mach-add|Add a machine/.test(html) && /<a class="cc-card cc-link-card" href="\/machines">/.test(html));
// Schedules ("orders") live inside Rules & alerts since 2026-10-25: eight sheets.
const SHEETS = ["conv", "sessions", "missions", "dec", "tl", "rules", "cost", "machine"];
check("the dock opens the eight sheets, in order", (() => {
  const dockHtml = (/<nav class="cc-rail" id="cc-rail"[^>]*>([\s\S]*?)<\/nav>/.exec(html) || [])[1] || "";
  return [...dockHtml.matchAll(/data-sheet="([a-z]+)"/g)].map((m) => m[1]).join(" ") === SHEETS.join(" ") && /id="cc-kbtn"/.test(dockHtml);
})());
check("every sheet has its pane, closed until opened; Schedules sit inside Rules & alerts", /id="cc-orders-wrap"/.test(html) && SHEETS.concat(["everything"]).every((k) => new RegExp(`<section class="cc-pane" id="cc-pane-${k}" data-sheet-pane="${k}"[^>]*hidden>`).test(html)));
check("the phone gets one button for everything, and the sheet lists all eight", /id="cc-more" aria-label="Everything"/.test(html) && SHEETS.every((k) => new RegExp(`id="cc-pane-everything"[\\s\\S]*data-sheet="${k}"`).test(html)));
check("the Machine sheet has the core grid's eight cells", ["core", "sessions", "agents", "memory", "watchers", "rules", "voice", "guard"].every((k) => html.includes(`data-cell="${k}"`)));
check("the core sits in the centre: one canvas, the orbit, the caption (no sparkline)", /<canvas class="cc-core" id="cc-core"/.test(html) && /id="cc-orbit"/.test(html) && !/id="cc-spark"/.test(html) && /id="cc-cap-state"/.test(html) && /id="cc-cap" aria-live="polite"/.test(html));
check("the missions board is a sheet (tabs, head, lanes)", /id="cc-pane-missions"[\s\S]*id="cc-mis-tabs"[\s\S]*id="cc-mis-head"[\s\S]*id="cc-lanes"/.test(html));
check("the event log lives under Decisions", /id="cc-pane-dec"[\s\S]*id="cc-evlog"[\s\S]*id="cc-feed"[\s\S]*id="cc-pane-tl"/.test(html));
check("the composer keeps the live-conversation button (the waveform), the voice bar and the call's keys line", /id="cc-c-mic"[^>]*title="Start a live conversation"/.test(html) && /id="cc-voicebar"/.test(html) && /id="cc-kb-live"/.test(html) && !/<kbd>Esc<\/kbd> ends/.test(html));
check("no replies-aloud toggle in the Conversation sheet's head (removed 2026-10-30)", /id="cc-pane-conv"/.test(html) && !/id="cc-speak-toggle"/.test(html));
check("without a key: no toggle, no live button; the struck-through waveform says to add a token in Settings ▸ Voice", !/id="cc-speak-toggle"/.test(noKey) && !/id="cc-c-mic"/.test(noKey) && /id="cc-mic-off"[^>]*title="Voice is off: add an OpenAI token in JOYA AI Settings ▸ Voice"/.test(noKey));
check("the palette button is in the dock, with its shortcut", /id="cc-kbtn"[^>]*aria-keyshortcuts="Control\+K"/.test(html));
check("one decision card, top right, and the amber pill that brings it back", /<aside class="cc-need" id="cc-need" role="alertdialog"/.test(html) && /id="cc-needpill"[^>]*hidden>[\s\S]{0,120}need you/.test(html));
check("no mockup leftovers (sample-data tag, Play demo, state preview)", !/SAMPLE DATA|Play flow|demo-btn|data-open="hire"|State preview/.test(html + main + panels));
check("scripts load in order: logic, core, map, panels, then the page", (() => {
  const i = ["cc-logic.js", "joya-core-d.js", "cc-map.js", "cc-panels.js", "/joya-ai.js"].map((f) => html.indexOf(f));
  return i.every((x, k) => x > 0 && (k === 0 || x > i[k - 1]));
})());
check("every page script is deferred", ["cc-logic.js", "joya-core-d.js", "cc-map.js", "cc-panels.js", "joya-ai.js"].every((f) => new RegExp(`/static/${f.replace(/\./g, "\\.")}\\?v=[^"]+" defer>`).test(html)));
check("the overlay root comes after the sheets", /<\/aside>\s*<div id="cc-overlay"><\/div>/.test(html));
check("no inline style anywhere in the frame", !/\sstyle\s*=/i.test(html) && !/<style[\s>]/i.test(html));
check("the viewer name is escaped", !html.includes(EVIL));
check("every id is unique", (() => { const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]); return ids.length === new Set(ids).size; })());

/* ----------------------------------------------------- the icons in use --- */

check("every icon the palette and panels name is in the sprite", (() => {
  const names = new Set();
  for (const src of [main, panels]) {
    for (const m of src.matchAll(/\bic\(\s*"([a-z0-9]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/add\("[^"]+", [^\n]*?, "([a-z0-9]+)", "(?:m|)", /g)) names.add(m[1]);
    for (const m of src.matchAll(/\bic\([^()]*? \? "([a-z0-9]+)" : "([a-z0-9]+)"\)/g)) { names.add(m[1]); names.add(m[2]); }
  }
  ["core", "desktop", "terminal", "remote", "sessions"].forEach((n) => names.add(n)); // sessIcon()
  const logic = require(path.join(ROOT, "public", "cc-logic.js"));
  logic.SHEETS.filter((x) => x !== "-").forEach((x) => names.add(x.icon)); // the dock
  ["shield", "alert", "stop"].forEach((n) => names.add(n)); // the decision card (JoyaLogic.card)
  const missing = [...names].filter((n) => !views.SPRITE[n] && !/^(work|wait|idle|off|bad|warn|ok|done|x|w|est|hot|on|mis|self)$/.test(n));
  return missing.length === 0 || (console.log("   missing:", missing.join(", ")), false);
})());

/* ------------------------------------------------------ pure helpers --- */

const box = {};
vm.runInNewContext(
  ["scheduleLabel", "globMatch", "fuzzy", "tokens"].map((n) => cut(panels, n)).join("\n") + "\nvar DOW = " + /var DOW = (\[[^\]]+\])/.exec(panels)[1] + ";",
  box
);
check("schedule: every day", box.scheduleLabel({ kind: "daily", at: "07:30" }) === "Every day at 07:30");
check("schedule: weekdays, time padded", box.scheduleLabel({ kind: "weekdays", at: "7:05" }) === "Weekdays at 07:05");
check("schedule: weekly names the day (0 = Sunday)", box.scheduleLabel({ kind: "weekly", at: "09:15", dow: 3 }) === "Every Wednesday at 09:15" && /Sunday/.test(box.scheduleLabel({ kind: "weekly", at: "09:00", dow: 0 })));
check("schedule: every N hours, clamped 1..24", box.scheduleLabel({ kind: "hours", every_h: 6 }) === "Every 6 hours" && box.scheduleLabel({ kind: "hours", every_h: 1 }) === "Every hour" && box.scheduleLabel({ kind: "hours", every_h: 99 }) === "Every 24 hours");
check("schedule: cron shows the expression", box.scheduleLabel({ kind: "cron", cron: "30 7 * * 1-5" }) === "Cron: 30 7 * * 1-5");
check("schedule: a bad time never renders as a time", box.scheduleLabel({ kind: "daily", at: "7pm" }) === "Every day at --:--");

check("glob: * is any text, over the whole command", box.globMatch("systemctl restart *", "systemctl restart odoo") && !box.globMatch("systemctl restart *", "sudo systemctl restart odoo"));
check("glob: \\* is a literal star", box.globMatch("ls \\*", "ls *") && !box.globMatch("ls \\*", "ls a"));
check("glob: regex characters are literal", box.globMatch("rm /tmp/a.b", "rm /tmp/a.b") && !box.globMatch("rm /tmp/a.b", "rm /tmp/axb") && box.globMatch("echo (x)|[y]", "echo (x)|[y]"));
check("glob: * crosses newlines (a message body)", box.globMatch("fake-target: *", "fake-target: line one\nline two"));

check("fuzzy: a substring wins over scattered letters", box.fuzzy("odoo", "Deep view · Odoo 19 VPS").score > box.fuzzy("odoo", "Open Decisions · no odd ones overall").score);
check("fuzzy: letters in order match, with their positions", (() => { const m = box.fuzzy("thm lght", "Theme: light"); return m && m.idx.length === 7; })());
check("fuzzy: out of order does not match", box.fuzzy("zx", "Theme: light") === null);

check("tokens read like people say them", box.tokens(812) === "812" && box.tokens(44000) === "44k" && box.tokens(3100000) === "3.1M" && box.tokens(null) === "—");

const box2 = {};
vm.runInNewContext(["esc", "plain", "pct", "applyBars", "clip"].map((n) => cut(main, n)).join("\n"), box2);
{
  // Tokens, not money, in the Command Center (voice aside): one formatter, the Usage sheet's.
  const L = require(path.join(__dirname, "..", "public", "cc-logic.js"));
  const t = { input: 1234, output: 567, cache_read: 1200000, cache_write: 3000, total: 1204801 };
  check("tokens: compact totals, \"1.2M tok today\", and a tooltip that splits input / output / cache", L.tokLine(t, "today") === "1.2M tok today" && L.tokens(44000) === "44k" && L.tokens(812) === "812" && L.tokLine(null) === "" &&
    L.tokTip(t) === "Input 1,234 · Output 567 · Cache read 1,200,000 · Cache write 3,000 · Total 1,204,801 (counted on this box from the transcripts)");
  const panelsTok = /function tokens\(n\) \{[\s\S]*?\n  \}/.exec(panels)[0].replace(/\s+/g, " "), logicTok = /function tokens\(n\) \{[\s\S]*?\n  \}/.exec(fs.readFileSync(path.join(__dirname, "..", "public", "cc-logic.js"), "utf8"))[0].replace(/\s+/g, " ");
  check("  the same formatter as the Usage sheet (and its labels)", panelsTok === logicTok && /var TOK_KEYS = \[\["input", "Input"\], \["output", "Output"\], \["cache_read", "Cache read"\], \["cache_write", "Cache write"\]\];/.test(panels) && L.TOK_KEYS.map((k) => k[1]).join() === "Input,Output,Cache read,Cache write");
}
check("plain: markdown becomes one line of text", box2.plain("**Disk** 6%\n- `nginx` ok\n[docs](https://x)") === "Disk 6% nginx ok docs");
check("applyBars: widths, --v and left from data attributes, clamped", (() => {
  const mk = (attr, v) => ({ attr, v, style: { setProperty(k, x) { this[k] = x; } }, getAttribute() { return this.v; } });
  const w = mk("data-w", "150"), v = mk("data-v", "42"), l = mk("data-l", "-5");
  box2.applyBars({ querySelectorAll: (sel) => (sel === "[data-w]" ? [w] : sel === "[data-v]" ? [v] : [l]) });
  return w.style.width === "100%" && v.style["--v"] === "42%" && l.style.left === "0%";
})());

/* An approval card, run with the real code: three choices, escaped, rule-aware. */
{
  const b = {
    hm: () => "12:00",
    ic: (n) => `<svg data-i="${n}"></svg>`,
    ML: require(path.join(__dirname, "..", "public", "cc-logic.js")),
  };
  vm.runInNewContext(["esc", "clip", "approvalTarget", "approvalCmd", "decidedBy", "approvalHTML"].map((n) => cut(main, n)).join("\n"), b);
  const a = { id: 7, tool: "Bash", status: "pending", input: { command: `rm -rf /tmp/"x"<b>` }, category: "delete", label: "Deletes files", reason: EVIL,
    rule_suggestion: { tool: "Bash", pattern: "rm -rf /tmp/<p>" }, mission_ref: "M-7", step_n: 3, expires_at: "2026-09-28T12:10:00Z", created_at: "2026-09-28T12:00:00Z" };
  const h = b.approvalHTML(a);
  // M-6: a hired session's question names it and has no "Always allow"; JOYA AI's retire question is Retire / Keep.
  const hs = b.approvalHTML({ ...a, id: 8, origin: "session:demo-worker", origin_name: "Demo Worker" });
  check("a hired session's card: from Demo Worker, Approve once / Deny, no Always allow", /Demo Worker \(a session JOYA AI hired\) wants to/.test(hs) && !/data-always=/.test(hs) && /data-deny="8"/.test(hs));
  const rt = b.approvalHTML({ id: 9, tool: "SessionRetire", status: "pending", input: { session: "Demo Worker" }, summary: "Retire the session", origin: "joya-ai", origin_name: "JOYA AI", rule_suggestion: { tool: "Bash", pattern: "x" } });
  check("JOYA AI's retire card: retire the session Demo Worker, Retire / Keep, no Always allow", /JOYA AI wants to retire the session <b>Demo Worker<\/b>\. Nothing ends/.test(rt) && /data-approve="9"[^>]*>[\s\S]*?Retire</.test(rt) && /data-deny="9"[^>]*>[\s\S]*?Keep</.test(rt) && !/data-always=/.test(rt));
  check("approval card: Approve once, Always allow this, Deny", /data-approve="7"[^>]*>[\s\S]*Approve once/.test(h) && /data-always="7"[\s\S]*Always allow this/.test(h) && /data-deny="7"/.test(h));
  check("approval card: command, reason and suggested pattern are escaped", !h.includes('"x"<b>') && !h.includes(EVIL) && !h.includes("/tmp/<p>") && h.includes("rm -rf /tmp/&lt;p&gt;"));
  check("approval card: names its mission step", /M-7 · step 3/.test(h));
  const auto = b.approvalHTML(Object.assign({}, a, { status: "approved", decided_by: "rule:12", decided_at: "2026-09-28T12:01:00Z" }));
  check("approval card: a rule's answer reads as auto-approved by that rule", /Auto-approved/.test(auto) && /rule #12/.test(auto) && /resolved ok/.test(auto));
  const sm = b.approvalHTML({ id: 8, tool: "SendMessage", status: "pending", input: { to: "Odoo 19 VPS [ab12cd]", message: "hello" }, created_at: "x", expires_at: "y" });
  check("approval card: a message names its session without the ref", /send this to <b>Odoo 19 VPS<\/b>/.test(sm));
}

/* --------------------------------------------------------- the core --- */

// Cores A, B and C are retired (2026-10-25); D (Mesh) is the dotted core, E the bot.
const coreSrc = read("joya-core-d.js");
check("cores A, B and C are gone; D knows the six states", !fs.existsSync(path.join(__dirname, "..", "public", "joya-core.js")) && /var STATES = \["idle", "listening", "thinking", "delegating", "speaking", "needs"\]/.test(coreSrc));
check("the core pauses when the tab is hidden", /visibilitychange/.test(coreSrc) && /if \(document\.hidden\) stop\(true\)/.test(coreSrc));
check("the core honours reduced motion with a still frame per change", /prefers-reduced-motion: reduce/.test(coreSrc) && /function stillFrame\(\)/.test(coreSrc) && /if \(S\.still\) stillFrame\(\)/.test(coreSrc));
check("the core caps the device pixel ratio at 2", /Math\.min\(window\.devicePixelRatio \|\| 1, 2\)/.test(coreSrc));
check("without WebGL the core draws in 2D", /canvas\.getContext\("2d"\)/.test(coreSrc));
check("the core is fed the real levels: the microphone listening, the voice's output speaking", /micSource: function \(fn\)/.test(map) && /outSource: function \(fn\)/.test(map) && /Orb\.micSource\(/.test(main) && /Orb\.outSource\(outLevel\)/.test(main));
check("delegation streams fly out to the session, replies flash it", /send: function \(id, ms\)/.test(map) && /reply: function \(id\)/.test(map) && /Orb\.send\(/.test(main) && /Orb\.reply\(/.test(main));
check("the page sets the core's state from one place (JoyaLogic)", /Orb\.setState\(st\)/.test(main) && /ML\.coreState\(snap\)/.test(main));

/* ------------------------------------------------ events the page follows --- */

check("the page follows the new event types", ["mission", "decision", "watcher", "order", "order_run", "rule", "machine"].every((t) => new RegExp(`"${t}"`).test(main.slice(main.indexOf("var EVENTS"), main.indexOf("var EVENTS") + 600))));
check("the panels handle mission, decision, watcher, order, order_run, rule", ["mission", "decision", "watcher", "order", "order_run", "rule"].every((t) => panels.includes(`case "${t}":`)));
check("the deep view refreshes every 5 s and stops when closed", /setInterval\(function \(\) \{ if \(!document\.hidden\) fetchDeep\(\); \}, 5000\)/.test(panels) && /clearInterval\(OV\.timer\)/.test(panels));
check("Interrupt and Open in Claude Desktop only in JOYA AI's own deep view", /s\.self \? \(st === "working" \? '<button[^']*data-deep="interrupt"/.test(panels) && /data-deep="rc"/.test(panels));
check("'Always allow this' shows the rule before it saves", /rule-suggestion/.test(panels) && /approvals\/" \+ id \+ "\/approve", \{ body: \{ rule: \{ pattern: pattern, tool: tool \} \} \}/.test(panels));
check("Telegram delivery is offered disabled, with the server's reason", /Telegram<\/button>/.test(panels) && /tg\.why/.test(panels));

/* ------------------------------------------ plan usage, as /usage says it --- */
{
  const a = panels.indexOf("var PlanUsage = {");
  const b = panels.indexOf("window.JoyaPlanUsage = PlanUsage;");
  const ctx = { Intl, Date, Math, Number, String, isFinite };
  vm.createContext(ctx);
  vm.runInContext(panels.slice(a, b) + "this.PU = PlanUsage;", ctx);
  const PU = ctx.PU;
  // Claude Code 2.1.283's own reset formatter (function ud/zft in the binary), verbatim but for names,
  // with the zone passed in: the reference the panel must agree with.
  function cliReset(iso, alwaysDate, nowMs, tz) {
    const e = Math.floor(new Date(iso).getTime() / 1000);
    const o = new Date(e * 1000), s = new Date(nowMs), m = (o.getTime() - s.getTime()) / 3600000;
    const c = Number(new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: tz }).format(o)); // o.getMinutes() in that zone
    if (alwaysDate || m > 24) {
      const u = { month: "short", day: "numeric", hour: "numeric", minute: c === 0 ? undefined : "2-digit", hour12: true, timeZone: tz };
      if (new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: tz }).format(o) !== new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: tz }).format(s)) u.year = "numeric";
      return o.toLocaleString("en-US", u).replace(/[ \u202f]([AP]M)/i, (d, l) => l.toLowerCase()) + ` (${tz})`;
    }
    return o.toLocaleTimeString("en-US", { hour: "numeric", minute: c === 0 ? undefined : "2-digit", hour12: true, timeZone: tz }).replace(/[ \u202f]([AP]M)/i, (d, l) => l.toLowerCase()) + ` (${tz})`;
  }
  const NOW = Date.parse("2026-09-30T07:03:35Z");
  check("session reset: time only, minutes shown, zone named", PU.resetText("2026-09-30T09:30:00.411Z", false, NOW, "Africa/Cairo") === "12:30pm (Africa/Cairo)", PU.resetText("2026-09-30T09:30:00.411Z", false, NOW, "Africa/Cairo"));
  check("weekly reset: always the date, no :00 on the hour", PU.resetText("2026-10-05T13:00:00.411Z", true, NOW, "Africa/Cairo") === "Oct 5, 4pm (Africa/Cairo)", PU.resetText("2026-10-05T13:00:00.411Z", true, NOW, "Africa/Cairo"));
  check("a session reset over 24 h away gets the date", /^Oct 2, /.test(PU.resetText("2026-10-02T07:30:00Z", false, NOW, "Europe/Berlin")));
  check("next year's reset carries the year", /2027/.test(PU.resetText("2027-01-02T10:00:00Z", true, NOW, "UTC")));
  let agree = 0, total = 0, first = "";
  for (const tz of ["Africa/Cairo", "Europe/Berlin", "UTC", "America/New_York"]) {
    for (let h = -2; h < 24 * 9; h += 5) {
      for (const min of [0, 7, 30]) {
        const iso = new Date(NOW + h * 3600000 + min * 60000 + 411).toISOString();
        for (const ad of [false, true]) {
          total++;
          const mine = PU.resetText(iso, ad, NOW, tz), ref = cliReset(iso, ad, NOW, tz);
          if (mine === ref) agree++;
          else if (!first) first = iso + " " + tz + " " + ad + ": " + mine + " vs " + ref;
        }
      }
    }
  }
  check("reset text agrees with Claude Code's own formatter on " + total + " cases", agree === total, first);
  check("% used is floored, as /usage does", PU.pctUsed(39.6) === 39 && PU.pctUsed(18) === 18 && PU.pctUsed(0) === 0 && PU.pctUsed(102.5) === 102 && PU.pctUsed(null) === 0);
  check("time left", PU.inText("2026-09-30T09:30:00Z", NOW) === "in 2 h 26 min" && PU.inText("2026-10-05T13:00:00Z", NOW) === "in 5 d 5 h" && PU.inText("2026-09-30T07:03:00Z", NOW) === "due now" && PU.inText("2026-09-30T07:05:00Z", NOW) === "in 1 min");
  check("plan names and full counts", PU.planName("max") === "Max" && PU.planName(null) === "" && PU.fullNum(1234567) === "1,234,567" && PU.fullNum(0) === "0");
}
{
  // No dollars anywhere in the Command Center outside the voice block: the sphere hover cards, the sessions list,
  // JOYA AI's own card, the mission header, the palette -- tokens instead.
  const fam = read("cc-family.js"), logic = read("cc-logic.js");
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const voiceA = panels.indexOf("/* ---- the voice's own spend"), voiceB = panels.indexOf("function loadCost()");
  const outside = strip(panels.slice(0, voiceA) + panels.slice(voiceB));
  const DOLLAR = /\bmoney\(|["']\$["']\s*\+|\$[0-9]+\.[0-9]|usd_est|cost_usd|today_usd/; // a "$" + figure, a $0.00 text, a dollar field
  check("no dollars outside the voice block: the sphere hover card, the sessions list, JOYA AI's card, the mission header, the palette",
    voiceA > 0 && voiceB > voiceA && !DOLLAR.test(strip(fam)) && !DOLLAR.test(strip(main)) && !DOLLAR.test(outside) && !/function money\(/.test(main) && !/Cost details and budget/.test(panels),
    [strip(fam), strip(main), outside].map((x) => (DOLLAR.exec(x) || [""])[0]).join("|"));
  check("  they show tokens: hover card, sessions line, JOYA AI's card, mission KPI", /<dt>Today<\/dt><dd" \+ \(k\.tokTip \? ' title="' \+ esc\(k\.tokTip\)/.test(fam) && /ML\.tokLine\(s\.tokens_today, "today"\)/.test(main) && /tok: ML\.tokLine\(s\.tokens_today\), tokTip: ML\.tokTip\(s\.tokens_today\)/.test(main) &&
    /ML\.tokens\(mt\.tokens\.total\)[\s\S]{0,40}<span>tokens<\/span>/.test(panels) && !/\$/.test(logic.slice(logic.indexOf("function tokens(n)"), logic.indexOf("function tokTip"))));
  check("  sphere size follows tokens, not dollars", /Math\.min\(20, \(\(s\.tokens_today && s\.tokens_today\.total\) \|\| 0\) \/ 5e5\)/.test(main));
}
check("the Usage sheet: plan first, then tokens, voice folded below; no dollars outside the voice block",
  /<div id="cc-cost-widget">[\s\S]*<details class="cc-vu-box" id="cc-vu-box">/.test(html) && /planBlock\(P\.usage, \{ refresh: true \}\) \+ tokenSection\(P\.usage, false\)/.test(panels) && !/money\(|\$"|usd/i.test(panels.slice(panels.indexOf("/* ======================================================== usage */"), panels.indexOf("/* ---- the voice's own spend"))));
check("the Usage sheet reads /joya-ai/api/usage, refreshes on open and every minute", /api\("usage"\)/.test(panels) && /attributeFilter: \["hidden"\]/.test(panels) && /setInterval\(function \(\) \{ if \(!document\.hidden && S\.online\) loadCost\(\); \}, 60000\)/.test(panels));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
