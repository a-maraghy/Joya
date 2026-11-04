"use strict";
/**
 * The JOYA AI Command Center, simplified (Joya, 2026-09-29).
 *
 * One quiet screen: the JOYA AI core in the middle (a canvas, two concepts --
 * D mesh, the default, and E bot -- chosen per person in Settings and
 * switchable any time), the live sessions round it, a one-line caption under
 * it saying what is happening, and one composer with voice. Everything else is
 * one tap away: the icon bar on the left opens sheets from the right
 * (Conversation, Sessions, Missions while one is open, Decisions, Timeline,
 * Rules & alerts with its Schedules, Usage, Machine); on a phone a grid button
 * opens them all. Anything that needs a decision appears as one card, top right.
 *
 * Everything that changes is filled in by public/joya-ai.js (with cc-logic.js,
 * joya-core-d.js / joya-core-bot.js, cc-map.js and cc-panels.js) from the JSON and SSE API under
 * /joya-ai/api/ -- this renders the frame, the labels and the few facts the
 * server already knows (who is looking, whether a voice is installed, which
 * core they chose), all escaped here. No inline script, style or handler
 * anywhere: the CSP refuses them. The chosen core is written as data-core on
 * #cc, so the right one is drawn from the first frame.
 *
 * Only this VPS is shown. The live Odoo server appears nowhere on this page.
 */

const { esc, shell, asset, dockMarkup } = require("./ui");
const logic = require("../public/cc-logic");

/* Icons for the page, as one sprite referenced by <use>. */
const SPRITE = {
  core: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  sessions: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  agents: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  memory: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  remote: '<path d="M5 12a7 7 0 0 1 14 0"/><path d="M8.5 12a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="15" r="1.5"/><path d="M12 16.5V21"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12.5 15h4.5"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7Z"/><path d="M11 13l9-9"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/>',
  chev: '<path d="M6 15l6-6 6 6"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  delegate: '<path d="M4 12h11"/><path d="M11 7l5 5-5 5"/><path d="M20 5v14"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6Z"/><path d="M12 8v5M12 16.5h.01"/>',
  speaker: '<path d="M4 9.5h4l5-4v13l-5-4H4Z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="14" width="4" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4" height="6.5" rx="1.5"/>',
  mute: '<path d="M4 9.5h4l5-4v13l-5-4H4Z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  message: '<path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12.5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  orbit: '<circle cx="12" cy="12" r="2.5"/><ellipse cx="12" cy="12" rx="9.5" ry="5.5"/><circle cx="20" cy="9" r="1.4"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  play: '<path d="M7 5v14l11-7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.6.8-2.6 2s1.1 1.6 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2c-1.2 0-2.2-.5-2.7-1.3M12 6.5V8M12 16v1.5"/>',
  scale: '<path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7 2.5 13a2.8 2.8 0 0 0 5 0Z"/><path d="M19 7l-2.5 6a2.8 2.8 0 0 0 5 0Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  alert: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  sun2: '<circle cx="12" cy="13" r="4"/><path d="M4 20h16M12 3v3M5 8l1.5 1.5M19 8l-1.5 1.5"/>',
  jump: '<path d="M5 12h12"/><path d="M13 7l5 5-5 5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
};

/* Icons the simple Command Center added: the dock, the menus, the chevrons. */
Object.assign(SPRITE, {
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.2 4.4a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7 2 2 0 1 1 0 4Z"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6Z"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  chevd: '<path d="M6 9l6 6 6-6"/>',
  chevl: '<path d="M15 6l-6 6 6 6"/>',
  chevr: '<path d="M9 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  gauge: '<path d="M4.2 17.5a9 9 0 1 1 15.6 0"/><path d="M12 13.5l4-5"/><circle cx="12" cy="14" r="1.6"/>',
  spark: '<path d="M12 2.5c.6 4.6 2.9 6.9 9.5 9.5-6.6 2.6-8.9 4.9-9.5 9.5-.6-4.6-2.9-6.9-9.5-9.5 6.6-2.6 8.9-4.9 9.5-9.5Z"/>',
  clip: '<path d="M20.5 11.5 12.4 19.6a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 8.6v4.6a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7"/>',
  micoff: '<path d="M9 9V6a3 3 0 0 1 5.8-1.1M15 10.5V11a3 3 0 0 1-4.6 2.5"/><path d="M5.5 11a6.5 6.5 0 0 0 10.8 4.9M18.5 11a6.4 6.4 0 0 1-.4 2.2M12 17.5V21"/><path d="M3.5 3.5l17 17"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  wave: '<path d="M6 10v4M10 7v10M14 4v16M18 9v6"/>',
  waveoff: '<path d="M6 10v4M10 7v4M14 4v4M18 9v6M3.5 3.5l17 17M10 16v1M14 17v3"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-9 8.5"/>',
});

function ic(name, cls) {
  return `<svg class="cc-i${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"><use href="#cc-i-${name}"/></svg>`;
}

function sprite() {
  return (
    `<svg class="cc-sprite" aria-hidden="true" focusable="false">` +
    Object.keys(SPRITE)
      .map((k) => `<symbol id="cc-i-${k}" viewBox="0 0 24 24">${SPRITE[k]}</symbol>`)
      .join("") +
    `</svg>`
  );
}

/** One cell of the Machine sheet's JOYA AI core grid. Values arrive from the page script. */
function coreCell(key, label) {
  return `<div data-cell="${key}"><span>${esc(label)}</span><b data-st>—</b></div>`;
}

/** A sheet behind the dock: its head (title, a line under it, actions, close) and body. */
function pane(key, title, sub, actions, body, foot) {
  return `<section class="cc-pane" id="cc-pane-${key}" data-sheet-pane="${key}" role="dialog" aria-labelledby="cc-h-${key}" tabindex="-1" hidden>
    <div class="sh-hd"><div class="cc-min0"><h2 id="cc-h-${key}">${esc(title)}</h2><div class="sub">${sub}</div></div><span class="sp"></span>${actions || ""}<button type="button" class="cc-ibtn" data-sheet-close title="Close (Esc)" aria-label="Close">${ic("close")}</button></div>
    <div class="sh-bd cc-scroll"${key === "conv" ? ' id="cc-chat-scroll"' : ""}>${body}</div>${foot ? `<div class="sh-ft">${foot}</div>` : ""}
  </section>`;
}

/** The dock: the sheets, in the order JoyaLogic.SHEETS gives them, then search. Missions starts hidden:
    cc-panels.js shows it while a mission is open or running (2026-10-25 cleanup). */
function dock() {
  const badge = { dec: `<span class="cc-badge-n warn" id="cc-dec-count" hidden>0</span>`, missions: `<span class="cc-badge-n" id="cc-mis-count" hidden>0</span>` };
  return (
    logic.SHEETS.map((s) =>
      s === "-"
        ? `<span class="sep" aria-hidden="true"></span>`
        : `<button type="button" data-sheet="${s.key}" aria-expanded="false" aria-label="${esc(s.label)}"${s.key === "missions" ? " hidden" : ""}>${ic(s.icon)}${badge[s.key] || ""}<span class="tip">${esc(s.label)}</span></button>`
    ).join("") +
    `<span class="sep" aria-hidden="true"></span>` +
    `<button type="button" id="cc-kbtn" aria-label="Search or run (Ctrl+K)" aria-keyshortcuts="Control+K">${ic("search")}<span class="tip">Search or run · Ctrl K</span></button>` +
    // The whole Joya sidebar, as a drawer over the Command Center (app.js).
    `<span class="sep" aria-hidden="true"></span>` +
    `<button type="button" class="cc-os-btn" id="cc-os-btn" data-os-toggle aria-controls="sidebar" aria-label="Joya menu" aria-expanded="false"><svg class="cc-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h11"/></svg><span class="tip">Joya · every page</span></button>` +
    // Settings were only reachable through the menu drawer, which users did not find (2026-10-25).
    `<a class="cc-set-btn" href="/joya-ai/settings" aria-label="JOYA AI settings">${ic("settings")}<span class="tip">Settings</span></a>`
  );
}

/* Top-bar additions, before the theme switch: the status chip, the amber
   "N need you" pill, the active mission, and the phone's Everything button.
   The clock goes after it. */
function topExtra() {
  return (
    `<span class="cc-sys-chip" id="cc-sys" role="status"><span class="cc-dot" id="cc-sys-dot"></span><span id="cc-sys-label"><span class="long">Connecting</span><span class="short">Connecting</span></span></span>` +
    `<button type="button" class="cc-needpill" id="cc-needpill" hidden><span class="cc-dot warn"></span><span id="cc-needn">0</span> need you</button>` +
    `<button type="button" class="cc-mis-chip" id="cc-mis-chip" title="Open the missions" hidden></button>` +
    `<button type="button" class="cc-ibtn cc-evbtn" id="cc-more" aria-label="Everything">${ic("grid")}</button>`
  );
}
const TOP_CLOCK = `<div class="cc-clock" aria-hidden="true"><b id="cc-clock">--:--</b><span id="cc-clock-date">Cairo</span></div>`;

/**
 * @param o  { csrf, user, core, voice: {configured, model, voice, manage, on, use, live, liveDuplex} }
 *   voice.live  voice works for this viewer (on in Settings, a key, voice.use):
 *         the only case with a mic, read-aloud and the live controls on the page
 *   core  the viewer's saved JOYA AI core (D or E; anything else is D),
 *         rendered here so the page paints the right one from the first frame
 */
function page(o) {
  const voice = o.voice || {};
  // The desktop app's render mode (?shell=desktop): the same Command Center, no page round it.
  const desk = o.shell === "desktop";
  const core = logic.normCore(o.core);
  const sessview = logic.normSessView(o.sessview);
  const perm = o.user && o.user.perm;
  // Voice is live conversation only; with voice off, no key or no voice.use there is no mic at all.
  const vOk = !!(voice.configured && voice.live);
  // Why the mic is off, for its tooltip and screen readers (the hint row says it in words with a link).
  const micOffWhy = vOk
    ? ""
    : !voice.use
      ? "Voice is off: your role does not include voice"
      : !voice.manage
        ? "Voice is off: an administrator can switch it on"
        : !voice.on
        ? "Voice is off: switch it on in JOYA AI Settings ▸ Voice"
        : !voice.configured
          ? "Voice is off: add an OpenAI token in JOYA AI Settings ▸ Voice"
          : "Voice is off for this account";
  // (With voice off there is no note under the field any more: the waveform button is struck through and
  // says why -- tooltip, description, and in words with the link when clicked; the + menu links there too.)
  // Every page of Joya is in the ☰ drawer; these are the few worth one tap on a phone.
  const dashLinks = [
    ["/agents/dashboard", "bot", "Agents & sessions", (p) => p.can("agents.view") || p.can("claude.running.view")],
    ["/os", "cpu", "Machine", (p) => p.can("os.view")],
    ["/joya-ai/settings", "panel", "JOYA AI Settings", (p) => p.admin || p.can("voice.manage")],
  ]
    .filter((d) => !perm || d[3](perm))
    .concat([["/account", "user", "Your account", null]])
    .map((d) => `<a class="cc-card cc-link-card" href="${d[0]}">${ic(d[1])}<b>${esc(d[2])}</b><span class="sp"></span>${ic("chevr")}</a>`)
    .join("");

  const pageMap = require("./ui").pageMapFor(perm);
  const body = `${sprite()}
<div class="cc-shell" id="cc"${desk ? ' data-shell="desktop"' : ""}
     data-core="${core}" data-state="idle" data-sessview="${sessview}"
     data-bot-head="${esc(logic.normBotHead(o.botHead))}" data-bot-face="${logic.normBotFace(o.botFace)}" data-bot-colors="${esc(logic.botColorsJson(o.botColors))}" data-bot-team="${esc(logic.botTeamJson(o.botTeam))}"
     data-sound="${esc(require("../public/joya-sound").soundPrefsJson(o.sound))}"
     data-pages="${esc(pageMap.keys)}" data-page-map="${esc(pageMap.map)}"
     data-csrf="${esc(o.csrf)}"
     data-viewer="${esc(o.user && o.user.name)}"
     data-voice-ready="${vOk ? "1" : ""}"
     data-voice-manage="${voice.manage ? "1" : ""}"
     data-voice-off="${esc(micOffWhy)}"
     data-voice="${esc(vOk ? voice.voice || "" : "")}"
     data-voice-model="${esc(vOk ? voice.model || "" : "")}"
     data-voice-live="${vOk ? "1" : ""}"
     data-live-worklet="${vOk ? esc(asset("voice-live-worklet.js")) : ""}"
     data-live-duplex="${vOk ? esc(voice.liveDuplex || "speakers") : ""}">
  <div class="cc-bg" aria-hidden="true"></div>
  <div class="cc-halo" id="cc-halo" aria-hidden="true"></div>
  <canvas class="cc-core" id="cc-core" aria-hidden="true"></canvas>
  <div class="cc-orbit" id="cc-orbit" role="group" aria-label="Live sessions"><svg class="cc-ring" id="cc-ring" aria-hidden="true" focusable="false"><ellipse/></svg></div>
  <canvas class="cc-family" id="cc-family" aria-hidden="true"></canvas>
  <div class="cc-kids" id="cc-kids" role="group" aria-label="Live sessions"></div>
  <div class="cc-kcard" id="cc-kcard" aria-hidden="true"></div>
${desk ? deskParts() : ""}

  <main class="cc-main" id="cc-center" aria-label="JOYA AI">
    <h1 class="cc-sr">JOYA AI Command Center</h1>
    <div class="cc-stage" id="cc-stage"><div class="cc-offline" id="cc-offline" hidden><b>JOYA AI is not reachable</b><span id="cc-offline-msg"></span></div></div>
    <div class="cc-caption" id="cc-caption">
      <span class="cc-cap-state" id="cc-cap-state" data-s="idle"><span class="d" aria-hidden="true"></span><span class="cc-vp-ico" id="cc-cap-vp" aria-hidden="true" hidden></span><span id="cc-cap-label">Connecting</span></span>
      <span class="cc-sr" id="cc-vp-live" aria-live="polite"></span>
      <div class="cc-cap-line" id="cc-cap" aria-live="polite">Connecting to JOYA AI…</div>
      <button type="button" class="cc-cap-more" id="cc-cap-more" aria-expanded="false" aria-controls="cc-reply" hidden>${ic("chev")}<span id="cc-cap-more-t">Full reply</span> · <span id="cc-cap-at"></span></button>
    </div>
    <div class="cc-dock" id="cc-dock">
      <form class="cc-composer" id="cc-compose" autocomplete="off" aria-label="Message to JOYA AI">
        <div class="cc-att" id="cc-att" role="list" aria-label="Attached files" hidden></div>
        <div class="cc-c-row">
          <button type="button" class="cc-c-tool cc-c-attach" id="cc-attach" aria-haspopup="menu" aria-expanded="false" title="Attach files or photos, or address a session (you can also paste or drop files)" aria-label="Add: files, photos, a session">${ic("plus")}</button>
          <button type="button" class="cc-target" id="cc-target" aria-haspopup="menu" aria-expanded="false" title="Address a session (@): JOYA AI picks one now" aria-label="Address a session: JOYA AI picks">${ic("at")}<span id="cc-target-label">Auto-route</span></button>
          <textarea id="cc-input" name="text" rows="1" placeholder="Ask JOYA AI" aria-label="Message JOYA AI" aria-describedby="cc-kbd-help" maxlength="20000" autocomplete="off" enterkeyhint="send" spellcheck="true"></textarea>
          ${desk ? `<span class="kb dk-kb" id="dk-kb" title="Hold Ctrl+Space to talk"><span class="dk-kb-w">hold </span><b>Ctrl</b><b>Space</b><span class="dk-kb-w"> to talk</span></span>` : ""}<button type="button" class="cc-vm cc-c-pill" id="cc-vm" aria-haspopup="menu" aria-expanded="false" title="Voice and core settings: how JOYA AI speaks, the core"><span id="cc-mic-mode" data-mode="${vOk ? "live" : "off"}">${vOk ? `Live · ${esc(voice.voice || "voice")}` : "Voice off"}</span>${ic("chevd")}</button>${
            vOk
              ? `<button type="button" class="cc-c-mic cc-c-round" id="cc-c-mic" title="Start a live conversation" aria-label="Start a live conversation" aria-pressed="false">${ic("wave")}</button>`
              : `<button type="button" class="cc-c-mic cc-c-round off" id="cc-mic-off" aria-disabled="true" title="${esc(micOffWhy)}" aria-label="Voice is off" aria-describedby="cc-mic-why">${ic("waveoff")}</button>`
          }<button type="button" class="cc-c-stop cc-c-round" id="cc-stop" title="Stop: interrupt the current turn" aria-label="Interrupt the current turn" hidden>${ic("stop")}</button><button type="submit" class="cc-c-send cc-c-round" id="cc-send" title="Send (Enter)" aria-label="Send" hidden>${ic("up")}</button>
        </div>
        <div class="cc-drop" id="cc-drop" aria-hidden="true">${ic("clip")}<span>Drop files to attach them</span></div>
        <input type="file" id="cc-file" multiple hidden tabindex="-1" aria-hidden="true" accept="${esc(logic.ATTACH_ACCEPT)}">
        <input type="file" id="cc-photo" multiple hidden tabindex="-1" aria-hidden="true" accept="image/png,image/jpeg,image/gif,image/webp">
      </form>
      <span class="cc-sr" id="cc-kbd-help">Enter sends. Shift+Enter starts a new line. Type @ first to address a session. Attach files with the paperclip, by pasting, or by dropping them here.</span>
      <span class="cc-sr" id="cc-mic-why">${esc(vOk ? "" : micOffWhy)}</span>
      <div class="cc-sr" id="cc-att-live" role="status" aria-live="polite"></div>
      <div class="cc-voicebar" id="cc-voicebar">
        <button type="button" class="cc-c-mic cc-live-end cc-live-only" id="cc-live-end" title="End the conversation" aria-label="End conversation" hidden>${ic("close")}</button>
        <div class="cc-vb-text"><b>TALK TO JOYA AI</b><span id="cc-vb-text">Listening…</span></div>
        <div class="cc-vb-wave" id="cc-vb-wave" aria-hidden="true"></div>
        <span class="cc-vb-tags"><span class="cc-tag cc-tag-mode" id="cc-vb-mode">Live</span><span class="cc-tag">OpenAI</span><span class="cc-tag" id="cc-voice-tag">${esc(vOk ? String(voice.voice || "voice") : "off")}</span></span>
        <span class="cc-target cc-static">${ic("route")}<span id="cc-vb-target">Auto-route</span></span>
        <span class="cc-live-acts cc-live-only" id="cc-live-acts" hidden><button type="button" class="cc-btn sm cc-live-duplex" id="cc-live-duplex" data-duplex="speakers" title="Speakers mode" aria-label="Speakers mode: switch to headphones mode">${ic("speaker", "dx-sp")}${ic("headphones", "dx-hp")}<span class="lbl" id="cc-live-duplex-lbl">Speakers</span></button><button type="button" class="cc-ibtn" id="cc-live-mute" title="Mute the microphone (the conversation stays open)" aria-label="Mute" aria-pressed="false">${ic("mute")}</button></span>
        <button type="button" class="cc-ibtn" id="cc-vb-close" title="Back to typing" aria-label="Back to typing">${ic("close")}</button>
      </div>
      <div class="cc-hint" id="cc-hint" role="status">${vOk ? `<span class="kb cc-live-only" id="cc-kb-live" hidden></span>` : ""}<span class="kb cc-guard">destructive steps wait for your approval</span></div>
    </div>
  </main>

  <nav class="cc-rail" id="cc-rail" aria-label="Behind the scenes">${dock()}</nav>
</div>

<section class="cc-reply" id="cc-reply" aria-label="JOYA AI's last reply" hidden>
  <div class="hd"><span id="cc-reply-h">JOYA AI</span><span class="sp"></span><button type="button" class="cc-ibtn" id="cc-reply-x" aria-label="Close">${ic("close")}</button></div>
  <div class="bd cc-scroll" id="cc-reply-body"></div>
  <div class="ft"><button type="button" class="cc-btn sm" data-sheet="conv">${ic("message")}Whole conversation</button>${vOk ? `<button type="button" class="cc-btn sm" id="cc-reply-read">${ic("speaker")}Read aloud</button>` : ""}</div>
</section>

<aside class="cc-need" id="cc-need" role="alertdialog" aria-label="Needs you" hidden></aside>
<div class="cc-pop" id="cc-pop" role="menu" hidden></div>
<div class="cc-sheet-scrim" id="cc-scrim" hidden></div>
<aside class="cc-sheet" id="cc-sheet" aria-label="Behind the scenes">
  ${pane(
    "conv",
    "Conversation",
    `<span id="cc-dr-sub">the JOYA AI session</span>`,
    `<button type="button" class="cc-ibtn" id="cc-rc-open" title="Open in Claude Desktop (Remote Control)" aria-label="Open in Claude Desktop">${ic("open")}</button>` +
      `<button type="button" class="cc-ibtn" id="cc-expand" title="Widen the sheet" aria-label="Widen the sheet">${ic("expand")}</button>`,
    `<section class="cc-activity" id="cc-activity"><h3><span class="cc-dot" id="cc-act-dot"></span>Current AI activity<span class="cc-muted" id="cc-act-sub">—</span></h3><ol class="cc-steps" id="cc-steps"></ol></section>
      <div class="cc-chat" id="cc-chat" aria-live="polite"></div>`,
    `<span class="cc-dot" id="cc-rc-dot"></span><span id="cc-rc-text">Mirrors the JOYA AI session — the same conversation in Claude Desktop (Remote Control) and here.</span>`
  )}
  ${pane(
    "sessions",
    "Sessions",
    `<span id="cc-sess-aside">—</span>`,
    "",
    `<div class="cc-stats"><div><b id="cc-stat-deleg">—</b><span>delegated · 24h</span></div><div><b id="cc-stat-done">—</b><span>done · 24h</span></div><div><b id="cc-stat-median">—</b><span>median turn</span></div></div>
      <div class="cc-sess-list" id="cc-sessions"></div>
      <div class="cc-card dashed cc-hire-note" id="cc-hire-note">
        <div class="t">${ic("plus")}<b>Hire a session</b><span class="sp"></span><span class="cc-tag mute" id="cc-hire-count">—</span></div>
        <div class="m">Ask JOYA AI to hire a session for a job that needs its own context. At most 7 sessions at a time and 3 hires an hour. Keep or retire a hired session with its buttons here, or right-click its sphere. JOYA AI can only ask to retire one; you decide.</div>
      </div>`
  )}
  ${pane(
    "missions",
    "Missions",
    `<span id="cc-mis-sub">goals JOYA AI plans into steps</span>`,
    `<button type="button" class="cc-btn pri sm" data-open="mission-new">${ic("plus")}New mission</button>`,
    `<div class="cc-mis-tabs" id="cc-mis-tabs"></div><div class="cc-mis-head" id="cc-mis-head" hidden></div><div class="cc-lanes" id="cc-lanes"></div>`
  )}
  ${pane(
    "dec",
    "Decisions",
    `<span id="cc-dec-sub">approvals and watcher findings</span>`,
    "",
    `<div id="cc-dec-list"></div>
      <details class="cc-evlog" id="cc-evlog" open><summary class="cc-inbox-h">${ic("bolt")}Event log<span class="cc-muted"><span id="cc-feed-count">0</span> events · this VPS</span></summary><ul class="cc-feed" id="cc-feed"></ul></details>`
  )}
  ${pane("tl", "Timeline", `<span id="cc-tl-count">0</span> delegations and approvals, newest first`, "", `<ul class="cc-timeline" id="cc-timeline"></ul>`)}
  ${pane(
    "rules",
    "Rules & alerts",
    "what needs your approval, what is checked, what runs on a schedule",
    "",
    `<div id="cc-rules-pane"></div><div class="cc-orders-wrap" id="cc-orders-wrap" hidden><div class="cc-orders-hd"><button type="button" class="cc-btn pri sm" data-open="order-new">${ic("plus")}New schedule</button></div><ul class="cc-orders" id="cc-orders"></ul></div>`
  )}
  ${pane(
    "cost",
    "Usage",
    "Claude plan limits · tokens · voice",
    `<button type="button" class="cc-btn sm" data-open="cost">Details</button>`,
    `<div id="cc-cost-widget"><div class="cc-empty-s">—</div></div>${
      voice.configured
        ? `<details class="cc-vu-box" id="cc-vu-box"><summary>${ic("coin")}<span>Voice · OpenAI</span><small class="cc-muted">billed separately</small><b id="cc-vu-sum"></b></summary><div class="cc-vu" id="cc-voice-usage" aria-live="polite"><div class="cc-empty-s">Voice usage —</div></div></details>`
        : ""
    }`
  )}
  ${pane(
    "machine",
    "Machine",
    `<span id="cc-mach-aside">this VPS</span>`,
    "",
    `<div class="cc-card cc-mach-this" id="cc-mach-this">
        <div class="cc-mach-top">${ic("server")}<b id="cc-host">This VPS</b><span class="sp"></span><span class="cc-tag mute" id="cc-mach-badge">—</span></div>
        <div class="cc-mach-sub cc-mono" id="cc-mach-sub">this box</div>
        <div class="cc-mach-bars"><span class="cc-mb" data-mb="cpu">CPU —<i></i></span><span class="cc-mb" data-mb="ram">RAM —<i></i></span><span class="cc-mb" data-mb="disk">DISK —<i></i></span></div>
        <div class="cc-mach-note" id="cc-mach-note">—</div>
      </div>
      <div class="cc-sec-t">JOYA AI core<span class="cc-muted cc-mono" id="cc-core-aside">—</span></div>
      <div class="cc-core-grid" id="cc-core-grid">
        ${coreCell("core", "Core")}${coreCell("sessions", "Sessions")}${coreCell("agents", "Agents")}${coreCell("memory", "Memory")}
        ${coreCell("watchers", "Watchers")}${coreCell("rules", "Rules")}${coreCell("voice", "Voice")}${coreCell("guard", "Guardrails")}
      </div>
      <div class="cc-sec-t">Your computers</div>
      <a class="cc-card cc-link-card" href="/machines">${ic("monitor")}<b>Computers</b><span class="sp"></span><span class="cc-muted">the laptops linked through the desktop app</span>${ic("chevr")}</a>`
  )}
  ${pane(
    "everything",
    "Everything",
    "one tap away",
    "",
    `<div class="cc-everything">${logic.SHEETS.filter((s) => s !== "-")
      .map((s) => `<button type="button" data-sheet="${s.key}">${ic(s.icon)}<span>${esc(s.label)}</span>${s.key === "dec" ? `<span class="cc-badge-n warn" data-dec-mirror hidden>0</span>` : ""}</button>`)
      .join("")}<button type="button" data-open-palette>${ic("search")}<span>Search or run</span></button></div>
      ${dashLinks ? `<div class="cc-sec-t">Joya</div>${dashLinks}` : ""}
      <div class="cc-sec-t">Theme</div>
      <div class="cc-theme-mini" role="group" aria-label="Theme"><button type="button" data-theme-to="system" aria-label="System theme">${ic("monitor")}</button><button type="button" data-theme-to="dark" aria-label="Dark theme">${ic("moon")}</button><button type="button" data-theme-to="light" aria-label="Light theme">${ic("sun")}</button></div>`
  )}
</aside>
<div id="cc-overlay"></div>
${perm && !desk ? dockMarkup(o.csrf, perm, { shell: true, noVoice: !vOk, core, botHead: logic.normBotHead(o.botHead), botColors: logic.botColorsJson(o.botColors), botFace: logic.normBotFace(o.botFace) }) : ""}
<noscript><div class="cc-noscript">The Command Center needs JavaScript.</div></noscript>`;

  return shell("JOYA AI", body, {
    user: o.user,
    csrf: o.csrf,
    active: "joya-ai",
    bare: true,
    brand: "ai",
    heading: null,
    pageClass: desk ? "cc-page cc-desk" : "cc-page",
    assets: desk
      ? ["joya-desktop-webauthn.js", "voice-live.css", "joya-desktop.css", "console.js", "cc-logic.js", "joya-sound.js", "joya-core-d.js", "joya-core-bot.js", "cc-family.js", "cc-map.js", "cc-panels.js", "cc-story.css", "cc-story.js", "voice-live-detect.js", "voice-live.js", "ui-actions.js", "joya-desktop-layout.js", "joya-desktop-glance.js", "joya-desktop-companion.js", "joya-ai.js", "joya-proactive.css", "joya-proactive.js", "joya-widgets.js", "joya-canvas-policy.js", "joya-canvas.css", "joya-canvas.js", "joya-presence.css", "joya-presence-logic.js", "joya-presence.js", "joya-presence-bind.js", "joya-desktop.js"]
      : ["voice-live.css", "joya-dock.css", "console.js", "cc-logic.js", "joya-sound.js", "joya-core-d.js", "joya-core-bot.js", "cc-family.js", "cc-map.js", "cc-panels.js", "cc-story.css", "cc-story.js", "voice-live-detect.js", "voice-live.js", "joya-proactive.css", "joya-proactive.js", "joya-desktop-glance.js", "joya-widgets.js", "joya-canvas-policy.js", "joya-canvas.css", "joya-canvas.js", "joya-presence.css", "joya-presence-logic.js", "joya-presence.js", "joya-presence-bind.js", "ui-actions.js", "joya-ai.js", "joya-dock.js", "joya-shell.js"],
    topExtra: topExtra(),
    topEnd: TOP_CLOCK,
  });
}

/**
 * What only the desktop render mode adds (public/joya-desktop.js places it):
 * the live-call button and the chat button on the core and the chat panel it opens (the recent
 * conversation; joya-desktop.js moves the composer, #cc-dock, into it), the glance cards beside the
 * core and their button (approvals, sessions, today's tokens, alerts; joya-desktop.js fills them), the
 * core's own click target (in Floating the core is the handle you drag the
 * box by), and the Floating box's tools.
 */
function deskParts() {
  const b = (k, t, d) => `<button type="button" data-dk="${k}" title="${esc(t)}" aria-label="${esc(t)}"><svg class="cc-i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg></button>`;
  const svg = (d) => `<svg class="cc-i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  return `<button type="button" class="dk-livebtn" id="dk-livebtn" title="Start a live conversation" aria-label="Start a live conversation">${svg('<path class="dk-wave" d="M4 10.5v3M8 7.5v9M12 4.5v15M16 7.5v9M20 10.5v3"/><path class="dk-end" d="M7 7l10 10M17 7 7 17"/>')}</button>
  <button type="button" class="dk-chatbtn" id="dk-chatbtn" title="Chat" aria-label="Chat" aria-expanded="false" aria-controls="dk-panel">${svg('<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8.5L6 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>')}<span class="dk-dot" aria-hidden="true"></span></button>
  <section class="dk-panel" id="dk-panel" aria-label="Chat with JOYA AI" hidden>
    <div class="dk-panel-hd"><b>Chat</b><button type="button" class="dk-panel-x" id="dk-panel-x" title="Close (Esc)" aria-label="Close the chat">${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
    <div class="dk-log" id="dk-log" aria-live="polite"></div>
    <div class="dk-panel-dock" id="dk-panel-dock"></div>
  </section>
  <button type="button" class="dk-glbtn" id="dk-glbtn" title="Glance cards" aria-label="Show the glance cards" aria-pressed="false" aria-controls="dk-glance" hidden>${svg('<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>')}</button>
  <section class="dk-glance" id="dk-glance" aria-label="At a glance: approvals, sessions, today's tokens, alerts" hidden>
    <div class="dk-gl-hd dk-gl-hit" id="dk-gl-hd"><span class="dk-gl-grip" id="dk-gl-grip" title="At a glance">${svg('<circle cx="9" cy="8" r="1.3"/><circle cx="15" cy="8" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="16" r="1.3"/><circle cx="15" cy="16" r="1.3"/>')}<b>At a glance</b></span>
      <button type="button" class="dk-gl-ib" data-gl="pin" id="dk-gl-pin" title="Pin here on the desktop" aria-label="Pin the cards here on the desktop" aria-pressed="false" hidden>${svg('<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5zM12 14v6"/>')}</button>
      <button type="button" class="dk-gl-ib" data-gl="hide" title="Hide the glance cards" aria-label="Hide the glance cards">${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
    <div class="dk-gl-cards" id="dk-gl-cards"></div>
  </section>
  <span class="cc-sr" id="dk-gl-live" aria-live="polite"></span>
  <div class="dk-corehit" id="dk-corehit" title="JOYA AI" aria-hidden="true"></div>
  <div class="dk-tools" id="dk-tools" role="toolbar" aria-label="JOYA AI window" hidden>${
    b("drag", "Drag to move", '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>') +
    b("focus", "Focus: just the core", '<circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="8.5"/>') +
    b("size", "Size S / M / L", '<path d="M4 20 20 4M4 20h6M4 20v-6M20 4h-6M20 4v6"/>') +
    b("hide", "Hide (Ctrl Alt M brings it back)", '<path d="M5 12h14"/>')
  }</div>`;
}

/* ------------------------------------------------ core E: head and colours --- */

const BOT_DESC = "A wireframe bot head; its face shows each state in one colour. Pick a face, a head and colours below.";
const APPEARANCE_ASSETS = ["joya-settings.css", "cc-logic.js", "joya-core-d.js", "joya-core-bot.js", "joya-settings.js"];

/**
 * Core E's settings in Appearance (the Settings section and the Account card render the same): the
 * face style (smooth / dots / minimal, a live thumbnail each, 2026-10-22), the ten heads, each with a thumbnail drawn by joya-settings.js (JoyaBot.thumb), the colour presets
 * (swatches painted through the CSSOM), and Custom: one colour picker per state and the wireframe,
 * with each pick's derived dark / light shade, a reset to a preset, a warning when two state colours
 * are too close, and a strip of the six states in both themes. Without JavaScript the head and the
 * preset post with the form; custom colours need JavaScript. Shown while core E is chosen
 * (joya-settings.css, .core-e); no inline style anywhere (CSP).
 */
function botSettings(o) {
  const head = logic.normBotHead(o.botHead);
  const face = logic.normBotFace(o.botFace);
  const faceDesc = { smooth: "Rounded glyphs that morph between states", dots: "A crisp LED dot matrix", minimal: "Two soft pills and a line" };
  const faces = Object.keys(logic.BOT_FACES)
    .map(
      (k) => `<label class="joya-bot-head joya-bot-face" data-bot-face-opt="${k}"><input type="radio" name="bot_face" value="${k}"${k === face ? " checked" : ""}>
        <canvas data-bot-face-thumb="${k}" aria-hidden="true"></canvas><span><b>${esc(logic.BOT_FACES[k])}</b><br>${esc(faceDesc[k])}</span></label>`
    )
    .join("");
  const colors = logic.normBotColors(o.botColors);
  const heads = Object.keys(logic.BOT_HEADS)
    .map(
      (k) => `<label class="joya-bot-head" data-bot-head-opt="${k}"><input type="radio" name="bot_head" value="${k}"${k === head ? " checked" : ""}>
        <canvas data-bot-thumb="${k}" aria-hidden="true"></canvas><span>${esc(logic.BOT_HEADS[k])}</span></label>`
    )
    .join("");
  const presets = Object.keys(logic.BOT_PRESETS)
    .concat(["custom"])
    .map((k) => {
      const base = k === "custom" ? colors.c : logic.botPresetBase(k);
      const sw = logic.BOT_STATE_ITEMS.map((i) => `<i data-swatch="${esc(base[i])}"></i>`).join("");
      return `<label class="joya-bot-preset" data-bot-preset-opt="${k}"><input type="radio" name="bot_preset" value="${k}"${k === colors.p ? " checked" : ""}>
        <span class="joya-bot-sw" aria-hidden="true">${sw}</span><span>${esc(k === "custom" ? "Custom" : logic.BOT_PRESETS[k].name)}</span></label>`;
    })
    .join("");
  const picks = logic.BOT_ITEMS.map(
    (k) => `<label class="joya-bot-pick"><input type="color" value="${esc(colors.c[k].toLowerCase())}" data-bot-item="${k}" aria-label="${esc(logic.BOT_ITEM_LABEL[k])} colour">
      <span class="nm">${esc(logic.BOT_ITEM_LABEL[k])}</span><span class="joya-bot-shades" title="Dark / light theme shade"><i data-shade="${k}:dark"></i><i data-shade="${k}:light"></i></span></label>`
  ).join("");
  const strip = (th) => logic.BOT_STATE_ITEMS.map((k) => `<span><canvas data-bot-state="${k}" data-bot-theme="${th}"></canvas><em>${esc(logic.BOT_ITEM_LABEL[k])}</em></span>`).join("");
  return `<div class="joya-bot" id="joya-bot" data-bot-colors="${esc(logic.botColorsJson(colors))}" data-bot-head="${head}" data-bot-face="${face}">
        ${o.inRow ? "" : `<p class="muted joya-sess-h"><b>Bot</b> — core E's face, head and colours. The sessions round it, the dock, the page flight and the desktop app use the same.</p>`}
        <fieldset class="joya-bot-faces"><legend class="joya-bot-lg">Face</legend>${faces}</fieldset>
        <fieldset class="joya-bot-heads"><legend class="cc-sr">Bot head</legend>${heads}</fieldset>
        <fieldset class="joya-bot-presets"><legend class="joya-bot-lg">Colours</legend>${presets}</fieldset>
        <div class="joya-bot-custom" id="joya-bot-custom"${colors.p === "custom" ? "" : " hidden"}>
          <div class="joya-bot-picks">${picks}</div>
          <p class="muted small">One colour each; its dark- and light-theme shades are worked out from it (at least 3:1 on each background).</p>
          <div class="btn-row"><button type="button" class="btn small" id="joya-bot-reset">Reset to preset</button><select id="joya-bot-reset-from" aria-label="Preset to reset to">${Object.keys(logic.BOT_PRESETS)
            .map((k) => `<option value="${k}">${esc(logic.BOT_PRESETS[k].name)}</option>`)
            .join("")}</select></div>
        </div>
        <p class="joya-bot-warn" id="joya-bot-warn" role="status" hidden></p>
        <div class="joya-bot-strip" aria-hidden="true"><div class="row dark">${strip("dark")}</div><div class="row light">${strip("light")}</div></div>
      </div>`;
}

module.exports = { page, botSettings, BOT_DESC, APPEARANCE_ASSETS, SPRITE };

