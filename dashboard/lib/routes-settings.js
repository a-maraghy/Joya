"use strict";
/**
 * JOYA AI ▸ Settings: the routes (/joya-ai/settings/<section> and the small
 * forms each row posts to). The views are lib/views-settings.js.
 *
 * Every write here is a thin, checked proxy: the supervisor's own settings go
 * through its ops (joya-ai/lib/protocol.js re-validates them and records who
 * changed what), the panel's own settings go to the panel database, and every
 * change leaves a line in the audit log. Each form works without JavaScript
 * (a redirect back with a note) and in place from os.js (JSON with the note
 * already rendered).
 *
 * The Voice section is rendered by whoever owns the voice (server.js registers
 * `sections.voice`), so everything voice stays next to the voice code.
 *
 *   mount(app, deps)   deps: { requireAuth, requireCsrf, ctx, db, joyaai, pageMap }
 */

const V = require("./views-settings");
const DK = require("./desktop");
const { esc, icon, flashes } = require("./ui");

/** Section renderers: async (req, res) -> { body, secClass?, assets?, status? }. */
const sections = {};

/** Per-section marks for the sub-nav, from whoever knows them (voice on/off, a cap reached). */
const marks = [];

function wantsJson(req) {
  return req.get("x-requested-with") === "fetch" || /application\/json/.test(req.get("accept") || "");
}

/**
 * Answer a settings form: JSON for os.js (the note rendered), a redirect back
 * to the section (and the row's anchor) otherwise.
 */
function reply(req, res, section, { msg, err, anchor, reload } = {}) {
  if (wantsJson(req)) return res.status(err ? 400 : 200).json({ ok: !err, flash: flashes({ msg, err }), reload: !!reload });
  const q = err ? "err=" + encodeURIComponent(err) : msg ? "msg=" + encodeURIComponent(msg) : "";
  return res.redirect(303, "/joya-ai/settings/" + section + (q ? "?" + q : "") + (anchor ? "#" + anchor : ""));
}

/** A supervisor op for a page render: the result, or { _error } when JOYA AI cannot answer. */
async function sup(deps, req, op, params, timeout) {
  try {
    return await deps.joyaai.call(op, params || {}, req.me.username, timeout ? { timeout } : undefined);
  } catch (e) {
    return { _error: e.message || "JOYA AI did not answer", _code: e.code || "error" };
  }
}

function offline(what) {
  return `<div class="alert bad set-offline">${icon("alert")}<div>${esc(what)}</div></div>`;
}

function intIn(v, lo, hi) {
  const s = String(v == null ? "" : v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
}

function usd(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function fmtTok(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
}

/* ------------------------------------------------------------- sections --- */

sections.general = async (req, res, deps) => {
  const st = await sup(deps, req, "status");
  const p = (st && st.process) || {};
  const rc = (st && st.remote_control) || {};
  const csrf = res.locals.csrf;
  const ch = await sup(deps, req, "charter");
  const charter = ch && !ch._error && typeof ch.text === "string" ? ch : null;
  const tz = p.tz || "Africa/Cairo";
  // The read-only facts of its Claude session (and the clock), from the supervisor's config: they change
  // only with a deploy, so they sit under one "Details" disclosure (2026-10-25 cleanup).
  const details = V.more(
    "Details: model, folder, version, time zone",
    V.row("Model", null, V.ro(p.model)) +
      V.row("Effort", null, V.ro(p.effort)) +
      V.row("Permission mode", "Risky tools still come to you as a Decision.", V.ro(p.permission_mode)) +
      V.row("Working folder", null, V.ro(p.cwd)) +
      V.row("Claude Code", null, V.ro(p.cli_version || p.cli_pinned)) +
      V.row("Time zone", "Used by the clock, the brief and every “today”.", V.ro(tz)),
    { id: "g-details" }
  );
  const body =
    V.head("General", "How JOYA AI's own Claude session runs, and the desktop app.") +
    (st._error ? offline("JOYA AI is not reachable (" + st._error + "): its values could not be read.") : "") +
    V.group(
      "JOYA AI",
      "core",
      V.row(
        "Charter",
        "Its standing instructions (joya-ai/home/CLAUDE.md).",
        charter ? `<button type="button" class="btn small" data-modal-open="m-charter">${icon("file", 14)} View charter</button>` : `<span class="muted-num">not readable now</span>`
      ) +
        V.row(
          "Remote control",
          "Reach this session from the Claude apps.",
          V.form("/joya-ai/settings/general/rc", csrf, V.sw('name="enabled" value="1" aria-label="Remote control"' + (st._error ? " disabled" : ""), !!rc.enabled), { noSave: false }),
          { scope: "everyone", id: "g-rc" }
        ) +
        details
    ) +
    V.group(
      "Desktop app",
      "monitor",
      V.row(
        "Stay signed in",
        `How long the Windows app stays signed in before it asks again. ${DK.MIN_DAYS} to ${DK.MAX_DAYS} days; a browser signs out after 8 idle hours.`,
        V.form(
          "/joya-ai/settings/general/desktop",
          csrf,
          `<input type="number" name="days" min="${DK.MIN_DAYS}" max="${DK.MAX_DAYS}" value="${esc(deps.desktopDays ? deps.desktopDays() : DK.DEFAULT_DAYS)}" aria-label="Days the desktop app stays signed in"><span class="unit">days</span>`
        ),
        { scope: "everyone", id: "g-desktop" }
      ) + V.row("Download", "The installer, and how to trust its certificate.", `<a class="btn small" href="/desktop/">Open the download page</a>`)
    ) +
    V.group(
      "Restart",
      "restart",
      V.row(
        "Restart JOYA AI",
        "Ends the turn it is on. Everything it knows is kept, and hired sessions keep running.",
        V.form("/joya-ai/settings/general/restart", csrf, `<button type="submit" class="btn small danger">${icon("restart", 14)} Restart…</button>`, {
          confirm: "Restart JOYA AI?",
          confirmBody: "The turn it is working on ends. Everything in its ledger is kept, and hired sessions keep running. It is back in a few seconds.",
          confirmYes: "Restart",
          noSave: true,
        }),
        { id: "x-restart" }
      )
    ) +
    (charter
      ? `<section class="cc-modal os wide" id="m-charter" role="dialog" aria-modal="true" aria-labelledby="m-charter-t" hidden>
          <div class="cc-mh">${icon("file", 18)}<div class="cc-min0"><h2 id="m-charter-t">JOYA AI's charter</h2><small>${esc(charter.path || "")} · read-only</small></div>
          <span class="cc-sp"><button type="button" class="cc-ibtn" data-modal-close aria-label="Close">${icon("close", 16)}</button></span></div>
          <div class="mb"><pre class="charter-text">${esc(charter.text)}</pre></div>
          <div class="mf"><span class="sp"></span><button type="button" class="btn" data-modal-close>Close</button></div></section>`
      : "");
  return { body };
};

sections.appearance = async (req, res, deps) => {
  const L = require("../public/cc-logic");
  const MV = require("./views-joyaai");
  const core = L.normCore(req.me.joya_core);
  const csrf = res.locals.csrf;
  // Two cores since 2026-10-25 (A, B and C were retired; their users moved to E).
  const desc = {
    D: "A folding sphere of dots, cyan to magenta. The default.",
    E: MV.BOT_DESC,
  };
  const cores = Object.keys(L.CORES)
    .map(
      (k) => `<label class="joya-core-opt" data-core-opt="${k}"><input type="radio" name="core" value="${k}"${k === core ? " checked" : ""}>
        <span class="joya-prev"><canvas data-prev-core="${k}" aria-hidden="true"></canvas></span>
        <span class="joya-core-name"><b>${esc(L.CORES[k])}</b></span><span class="joya-core-desc">${esc(desc[k] || "")}</span></label>`
    )
    .join("");
  const body =
    V.head("Appearance", "How JOYA AI looks to you.") +
    V.group(
      "Theme",
      "monitor",
      V.row("Theme", "Light, dark or the system's, from your avatar menu at the top right of every page.", `<span class="muted-num" id="a-theme-where">In your avatar menu</span>`, { scope: "this browser", id: "a-theme" })
    ) +
    `<form method="post" action="/account/appearance" class="joya-appearance" id="joya-appearance" data-csrf="${esc(csrf)}"><input type="hidden" name="_csrf" value="${esc(csrf)}">` +
    V.group(
      "JOYA AI core",
      "core",
      V.row("Core", "The shape at the centre of the Command Center.", `<fieldset class="joya-core-opts"><legend class="cc-sr">JOYA AI core</legend>${cores}</fieldset>`, {
        full: true,
        scope: "you",
        id: "a-core",
      }) +
        V.row("Bot", "The bot's face, head and colours. Sessions, the dock and the desktop app follow them.", MV.botSettings({ core, botHead: req.me.joya_bot_head, botColors: req.me.joya_bot_colors, botFace: req.me.joya_bot_face, inRow: true }), {
          full: true,
          scope: "you",
          id: "a-bot",
        }) +
        `<div class="lr set-note"><span class="muted small" id="joya-appearance-note" role="status"></span><noscript><button class="btn small primary" type="submit">Save</button></noscript></div>`
    ) +
    `</form>` +
    soundSettings(req.me.joya_sound, csrf) +
    presenceSettings(await voiceState(req, deps));
  return { body, assets: MV.APPEARANCE_ASSETS.concat(["joya-sound.js", "joya-sound-settings.js", "joya-presence.css", "joya-presence-logic.js", "joya-presence.js", "joya-presence-settings.js"]) };
};

/*
 * Appearance > Eye contact (2026-10-20, mockups/eye-contact/DESIGN.md): camera presence. Never stored on the
 * server and never per person: it is this browser's switch (localStorage "joya-presence"), and in the desktop
 * app the app's own setting -- which only the app's Settings window or its tray can switch ON (this page can
 * switch it off). Off by default. public/joya-presence-settings.js runs the rows; without JavaScript they say so.
 */
/** Whether voice works for this viewer (look and speak needs it): { live, manage }; unknown -> assumed on. */
async function voiceState(req, deps) {
  try {
    const v = deps && deps.voicePublic ? await deps.voicePublic(req) : null;
    return v ? { live: !!v.live, manage: !!v.manage, on: !!v.on, configured: !!v.configured } : { live: true };
  } catch (_) {
    return { live: true };
  }
}

function presenceSettings(voice) {
  voice = voice || { live: true };
  const voiceOff = voice.live
    ? ""
    : `<span class="mp-voiceoff" data-mp-voiceoff>Look and speak needs voice, and voice is off${voice.manage ? `: <a href="/joya-ai/settings/voice">${voice.on && !voice.configured ? "add a token in" : "switch it on in"} Settings ▸ Voice</a>` : " for you (ask an administrator)"}.</span>`;
  const sw = (k, label) => V.sw(`data-mp="${k}" aria-label="${esc(label)}"`, false);
  return `<div class="mp-set" id="mp-set" data-voice-ready="${voice.live ? "1" : ""}">` +
    V.group(
      "Eye contact",
      "eye",
      `<div class="mp-explain"><b>Use this computer's camera so JOYA AI knows when you are there.</b> Off unless you switch it on.<ul>` +
        `<li>The bot looks at you and follows you as you move, looks up when you sit down and dozes when you walk away.</li>` +
        `<li>The glance cards come forward while you look at this screen. Notes and sounds wait while you are away and come as one summary when you are back.</li>` +
        `<li>Everything happens on this computer: the picture is read a few times a second by a small face model in the page and thrown away. No picture, video or face data is stored or sent anywhere — not to Joya, not to anyone. Only “here / looking / away” is used.</li>` +
        `<li>The camera light is on while it works. It lets go of the camera when you switch this off, when the window is hidden, the screen locks, or another app is in a meeting.</li>` +
        `</ul></div>` +
        V.row("Camera presence", `<span class="mp-browser-only">For this browser only. The browser asks you once for the camera.</span><span class="mp-app-only">In the JOYA AI app, switch it on in the app's Settings or its tray menu (“Camera presence”) — so only you, at this computer, can turn the camera on. Here you can switch it off.</span>`, sw("cam", "Camera presence") + ` <button type="button" class="btn small mp-app-only" data-mp-off hidden>Switch off</button>`, { scope: "this browser", id: "mp-cam-row" }) +
        V.row(
          "Camera",
          `Which camera to use. Automatic takes this computer's own camera and never a phone (Phone Link) or a virtual one unless there is nothing else. <span class="mp-browser-only">Remembered by this browser only.</span><span class="mp-app-only">Remembered by the app on this computer.</span> The camera's name stays on this computer.`,
          `<div class="mp-camsel"><select data-mp-camsel aria-label="Camera for eye contact"><option value="">Automatic</option></select>` +
            `<span class="muted small mp-camhint" data-mp-camhint hidden>Allow the camera once to see the camera names. <button type="button" class="btn small" data-mp-allow>Allow the camera once</button></span>` +
            `<span class="muted small mp-camused" data-mp-camused role="status"></span></div>`,
          { scope: "this browser", id: "mp-camera-row" }
        ) +
        V.row("Look and speak", "Face JOYA AI and start talking: it listens without the talk key. While you face it, a microphone level meter runs on this computer (nothing is recorded or sent until you speak). A reply pauses when you look away and goes on when you look back.", sw("speak", "Look and speak"), { scope: "this browser", id: "mp-speak-row", tag: "" }).replace("</p></div>", "</p>" + voiceOff + "</div>") +
        V.row("Energy saver", "Let go of the camera while Windows' energy saver is on. On battery it looks less often.", sw("saver", "Release the camera in energy saver"), { scope: "this browser", id: "mp-saver-row" }) +
        V.more(
          "More: what it sees now",
          V.row("Now", null, `<span class="mp-state" data-mp-state>Off</span>`, { id: "mp-now" }) +
            V.row(
              "Show what it sees",
              "If look and speak does not start, open this, face the bot and talk: each check shows a tick or a cross with its numbers. Numbers only; nothing is stored or sent.",
              `<details class="mp-show" data-mp-show><summary>Show what it sees</summary><ul class="mp-checks" data-mp-checks aria-live="polite"></ul><p class="muted small mp-show-note" data-mp-show-note></p></details>`,
              { scope: "this browser", id: "mp-show-row", full: true }
            ),
          { id: "mp-more" }
        ) +
        `<div class="lr set-note"><span class="muted small" id="mp-note" role="status"></span><noscript><span class="muted small">Eye contact needs JavaScript.</span></noscript></div>`
    ) +
    `</div>`;
}

/*
 * Appearance > Sounds (2026-10-20, public/joya-sound.js): JOYA AI's sounds, per person (users.joya_sound,
 * POST /joya-ai/api/prefs/sound): on / off, one volume, quiet hours; and this browser's own switch (a plain
 * browser is silent until it is on). public/joya-sound-settings.js saves each change at once and plays the
 * previews. Needs JavaScript (sounds are WebAudio); without it the rows say so.
 */
function soundSettings(saved, csrf) {
  const SND = require("../public/joya-sound");
  const p = SND.normSoundPrefs(saved);
  const roleOpts = Object.keys(SND.ROLES).map((r) => `<option value="${esc(r)}">${esc(SND.ROLES[r].label)}</option>`).join("");
  const chirp = (n, l) => `<button type="button" class="btn small" data-snd-try="${n}">${icon("play", 12)}${esc(l)}</button>`;
  return `<div class="joya-sound-set" id="joya-sound-set" data-csrf="${esc(csrf)}" data-sound="${esc(SND.soundPrefsJson(p))}">` +
    V.group(
      "Sounds",
      "voice",
      V.row(
        "Sounds",
        "Short chirps when JOYA AI or a session starts, finishes, needs you or fails, and a chime when an approval waits. Never during a call.",
        V.sw('name="snd_on" data-snd="on"', p.on),
        { scope: "you", id: "s-sound" }
      ) +
        V.row(
          "Volume",
          "Quiet by default. Several things at once make one sound, never a pile.",
          `<div class="snd-vol"><input type="range" min="0" max="100" step="5" value="${p.vol}" data-snd="vol" aria-label="Volume of the sounds"><output class="muted-num" data-snd-out>${p.vol} %</output></div>`,
          { scope: "you", id: "s-sound-vol" }
        ) +
        V.row(
          "Quiet hours",
          "No sounds between these times (your computer's clock).",
          `<div class="snd-quiet">${V.sw('name="snd_quiet" data-snd="quiet"', p.quiet)}<label class="snd-time"><span>from</span><input type="time" value="${esc(p.from)}" data-snd="from" required></label><label class="snd-time"><span>to</span><input type="time" value="${esc(p.to)}" data-snd="to" required></label></div>`,
          { scope: "you", id: "s-sound-quiet" }
        ) +
        V.row(
          "This browser",
          "The desktop app plays them. A browser stays silent until you switch it on there.",
          V.sw('name="snd_browser" data-snd="browser"', false),
          { scope: "this browser", id: "s-sound-browser" }
        ) +
        V.row("Try a sound", "Plays at the volume above, whatever the switches and the hour say.", `<div class="snd-try">${chirp("approval", "Try a sound")}</div>`, { id: "s-sound-try" }) +
        V.more(
          "More: every sound",
          `<div class="snd-try">${chirp("approval", "Approval waiting")}${chirp("job", "Job done")}</div>` +
            `<div class="snd-try"><label class="snd-role"><span class="cc-sr">Whose voice</span><select data-snd-role aria-label="Whose voice">${roleOpts}</select></label>${chirp("wake", "Wake")}${chirp("think", "Starts")}${chirp("done", "Done")}${chirp("needs", "Needs you")}${chirp("error", "Error")}</div>`,
          { id: "s-sound-more" }
        ) +
        `<div class="lr set-note"><span class="muted small" id="joya-sound-note" role="status"></span><noscript><span class="muted small">The sounds and these settings need JavaScript.</span></noscript></div>`
    ) +
    `</div>`;
}

sections.sessions = async (req, res, deps) => {
  const h = await sup(deps, req, "hire-limits");
  const csrf = res.locals.csrf;
  const b = (h && h.bounds) || { max_live: [1, 12], per_hour: [0, 10] };
  const off = !!h._error;
  const modes = [
    ["auto", "Auto"],
    ["default", "Ask before risky tools"],
    ["plan", "Plan only"],
  ];
  const defMode = (h.defaults && h.defaults.perm_mode) || "auto";
  const body =
    V.head(
      "Sessions & hiring",
      `JOYA AI may hire worker sessions on its own. Retiring one always needs your consent, a session you keep is never retired, and your own sessions are never touched. <a href="/claude/sessions">Manage sessions</a>`
    ) +
    (off ? offline("JOYA AI is not reachable (" + h._error + "): the limits could not be read.") : "") +
    V.group(
      "Limits",
      "agents",
      V.row(
        "Live sessions",
        `Yours and hired together; JOYA AI itself is not counted.${off ? "" : ` Now ${esc(h.live)} of ${esc(h.max_live)} in use, ${esc(h.hired)} hired.`} It starts them only in ${((h && h.cwd_roots) || ["/root/joya", "/root"]).map((r) => `<code>${esc(r)}</code>`).join(" or ")}, never in a hidden folder.`,
        V.form(
          "/joya-ai/settings/sessions/limits",
          csrf,
          `<input type="number" name="max_live" min="${b.max_live[0]}" max="${b.max_live[1]}" value="${esc(h.max_live == null ? 7 : h.max_live)}" aria-label="Live sessions at most"${off ? " disabled" : ""}><span class="unit">at most</span>`
        ),
        { scope: "everyone", id: "s-max-live" }
      ) +
        V.row(
          "Hires per hour",
          "Stops a burst of hires.",
          V.form(
            "/joya-ai/settings/sessions/limits",
            csrf,
            `<input type="number" name="per_hour" min="${b.per_hour[0]}" max="${b.per_hour[1]}" value="${esc(h.per_hour == null ? 3 : h.per_hour)}" aria-label="Hires per hour"${off ? " disabled" : ""}><span class="unit">per hour</span>`
          ),
          { scope: "everyone", id: "s-per-hour" }
        ) +
        V.row(
          "Permission mode for hired sessions",
          "The gate for destructive actions always applies. A running session keeps the mode it started with.",
          V.form(
            "/joya-ai/settings/sessions/limits",
            csrf,
            `<select name="perm_mode" aria-label="Permission mode for hired sessions"${off ? " disabled" : ""}>${modes
              .map(([v, l]) => V.opt(v, l + (v === defMode ? " (default)" : ""), h.perm_mode || defMode))
              .join("")}</select>`
          ),
          { scope: "everyone", id: "s-perm-mode" }
        )
    );
  return { body };
};

/** Settings > Screen control > Allow screen actions, per person (default on). */
function uiActionsEnabled(db, userId) {
  try {
    return db.getSetting("ui_actions_enabled:" + Number(userId), "1") !== "0";
  } catch (_) {
    return true;
  }
}

const TIER1 = [
  "End, mute or interrupt a call",
  "Open or close a Command Center panel",
  "Show the map or Missions",
  "Switch the core",
  "Show or read the last reply",
  "Show the waiting Decision (approving stays yours)",
  "Open a page, section, tab or card",
];

/** The page map as a tree: page › section / sheet / tab › anchor, each with its allow switch. */
function treeHtml(entries, allow, newKeys, csrf) {
  const kids = new Map();
  for (const e of entries) {
    const k = e.parent || "";
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(e);
  }
  const isNew = new Set(newKeys || []);
  const node = (e, parentOff) => {
    const ch = kids.get(e.key) || [];
    const on = allow[e.key] !== false && !parentOff;
    return `<li${e.key === "settings" ? ' class="open"' : ""} data-tn="${esc((e.label + " " + e.key).toLowerCase())}"><div class="tn k-${esc(e.kind)}${on ? "" : " off"}">${
      ch.length ? `<button type="button" class="tw" data-tw aria-label="Expand">${icon("chevron")}</button>` : "<span></span>"
    }<span class="nm">${esc(e.label)} <code>${esc(e.key)}</code>${e.kind !== "page" ? `<span class="tag-s">${esc(e.kind)}</span>` : ""}${isNew.has(e.key) ? `<span class="tag-s new">new</span>` : ""}${
      e.perm ? `<span class="tag-s ro" title="Only roles with this permission">${esc(e.perm)}</span>` : ""
    }</span><span class="muted-num tn-url">${esc(e.url)}</span>
    <form method="post" action="/joya-ai/settings/screen/allow" class="set-form" data-live><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="key" value="${esc(e.key)}">${V.sw(
      'name="on" value="1" aria-label="Allow ' + esc(e.label) + '"' + (parentOff ? " disabled" : ""),
      allow[e.key] !== false,
      "",
      "",
      "nolab"
    )}</form></div>${ch.length ? `<ul>${ch.map((c) => node(c, !on)).join("")}</ul>` : ""}</li>`;
  };
  return `<ul>${(kids.get("") || []).map((e) => node(e, false)).join("")}</ul>`;
}

function diffHtml(d) {
  if (!d) return "";
  const lines = [];
  for (const k of d.added.slice(0, 12)) lines.push(`<div class="dl"><span class="tag-s ok">new</span><span><code>${esc(k)}</code></span><span></span></div>`);
  if (d.added.length > 12) lines.push(`<div class="dl"><span class="tag-s ok">new</span><span>…and ${d.added.length - 12} more (marked new in the map below)</span><span></span></div>`);
  for (const [k, from, to] of d.renamed) lines.push(`<div class="dl"><span class="tag-s warn">renamed</span><span><code>${esc(k)}</code> ${k === from ? "" : esc(from) + " "}→ <b>${esc(to)}</b></span><span></span></div>`);
  for (const [k, why] of d.removed) lines.push(`<div class="dl"><span class="tag-s bad">removed</span><span><code>${esc(k)}</code> — ${esc(why)}</span><span></span></div>`);
  if (!lines.length) lines.push(`<div class="hint-line">${icon("check", 15)}No changes since the last scan.</div>`);
  return `<div class="diff">${lines.join("")}</div>`;
}

const stampOf = (iso) => String(iso || "").replace("T", " ").slice(0, 16);

sections.screen = async (req, res, deps) => {
  const csrf = res.locals.csrf;
  const pm = deps.pageMap;
  const st = pm && pm.current();
  const allow = pm ? pm.allowMap() : {};
  const entries = st ? st.entries : [];
  const nAllowed = pm && st ? pm.effective().length : 0;
  const push = pm ? pm.lastPush() : {};
  const on = uiActionsEnabled(deps.db, req.me.id);
  const body =
    V.head(
      "Screen control",
      "What JOYA AI may do on your screen when you ask. It never clicks anything on a page for you, and a change to a preference waits for your confirm."
    ) +
    V.group(
      "Screen actions",
      "check",
      V.row(
        "Allow screen actions",
        "It acts at once, with a note and 60 seconds to undo. Off keeps JOYA AI to words.",
        V.form("/joya-ai/settings/screen/actions", csrf, V.sw('name="on" value="1" aria-label="Allow screen actions"', on)),
        { scope: "you", id: "sc-actions" }
      ) +
        V.more(
          "What it may do",
          `<div class="set-more-text"><p>At once: ${TIER1.map((x) => esc(x.charAt(0).toLowerCase() + x.slice(1))).join("; ")}.</p><p>Only after you confirm: the theme, the voice persona, and the voice for everyone.</p></div>`,
          { id: "sc-what" }
        )
    ) +
    V.group(
      "Pages it may open",
      "external",
      `<div class="lr"><div><b>${st ? `${nAllowed} of ${entries.length} pages allowed` : "Not scanned yet"}</b><span class="d" id="reg-stamp">${st ? "Last scanned " + esc(stampOf(st.at)) + (st.by ? " by " + esc(st.by) : "") + "." : "Until the first scan it uses its built-in pages."}${
        push && push.ok === false ? ` <span class="state warn">JOYA AI has not been told yet: ${esc(push.error || "")}</span>` : ""
      }</span></div>
      <form method="post" action="/joya-ai/settings/screen/rescan" class="set-form" data-rescan><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" class="btn small">${icon(
        "reindex",
        14
      )} Rescan pages</button></form></div>
      <div id="scan-live" hidden><div class="scanbar"><i id="scan-bar"></i></div><div class="scan-log" id="scan-log"></div></div>
      ${V.more(
        "Manage the page map",
        `<p class="set-more-text">Built from the routes, settings sections, Command Center sheets, tabs and card anchors in the source, so a new page becomes openable without a code change.</p>
        ${st && st.diff ? `<div class="gh gh-sub">${icon("activity", 16)}Last scan<span class="aside">${esc(stampOf(st.at))}</span></div>${diffHtml(st.diff)}` : ""}
        ${V.row(
          "New entries",
          "What a newly found page starts as.",
          V.form("/joya-ai/settings/screen/policy", csrf, `<select name="policy" aria-label="New entries">${V.opt("auto", "Allowed at once (default)", pm ? pm.policy() : "auto")}${V.opt("wait", "Off until I allow it", pm ? pm.policy() : "auto")}</select>`),
          { id: "sc-policy" }
        )}
        ${
          st
            ? `<div class="tree-tools"><input type="search" placeholder="Filter pages, sections, anchors…" data-reg-q aria-label="Filter the page map"><span class="sp"></span><span class="muted-num">${entries.length} entries · ${nAllowed} allowed</span>
              <form method="post" action="/joya-ai/settings/screen/allow-all" class="set-form" data-live><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit" name="all" value="1" class="btn small">Allow all</button></form></div>
              <div class="tree" id="reg-tree">${treeHtml(entries, allow, st.new_keys, csrf)}</div>`
            : ""
        }`,
        { id: "sc-map", open: !!(st && st.diff && (st.diff.added.length || st.diff.renamed.length || st.diff.removed.length) && st.at && Date.now() - Date.parse(st.at) < 5 * 60 * 1000) }
      )}`,
      { id: "sc-registry" }
    );
  return { body, assets: ["joya-screen.js"] };
};

sections.approvals = async (req, res, deps) => {
  const csrf = res.locals.csrf;
  const [t, w] = await Promise.all([sup(deps, req, "approval-timeout"), sup(deps, req, "watchers")]);
  const watchers = (w && w.watchers) || [];
  const off = t._error || w._error;
  const body =
    V.head("Approvals & automations", "How long JOYA AI waits for you, and what it checks on its own.") +
    (off ? offline("JOYA AI is not reachable (" + off + "): these values could not be read.") : "") +
    V.group(
      "Approvals",
      "shield",
      V.row(
        "Wait for your answer",
        "A Decision not answered by then is refused.",
        V.form(
          "/joya-ai/settings/approvals/timeout",
          csrf,
          `<input type="number" name="seconds" min="30" max="3600" value="${esc(t.seconds == null ? 300 : t.seconds)}" aria-label="Seconds to wait"${t._error ? " disabled" : ""}><span class="unit">seconds</span>`
        ),
        { scope: "everyone", id: "p-timeout" }
      ) + V.row("Approval rules", "Answers given in advance: allow, ask or deny, by pattern.", `<a class="btn small" href="/joya-ai#rules">Rules &amp; alerts</a>`)
    ) +
    V.group(
      "System alerts",
      "eye",
      `<div class="lr"><div><span class="d">Checks JOYA AI runs on the server and tells you about. Your own watchers are in <a href="/joya-ai/settings/proactive">Briefs &amp; watchers</a>.</span></div></div>` +
        (watchers.length
          ? watchers
              .map(
                (x) =>
                  `<div class="lr"><div><b>${esc(x.name)}</b><span class="d">${esc(x.description || "")}</span></div>${V.form(
                    "/joya-ai/settings/approvals/watcher/" + encodeURIComponent(x.key),
                    csrf,
                    V.sw('name="enabled" value="1" aria-label="' + esc(x.name) + '"', !!x.enabled)
                  )}</div>`
              )
              .join("")
          : `<div class="lr"><div><span class="d">No system alerts to show${w._error ? ": JOYA AI is not reachable" : ""}.</span></div></div>`),
      { id: "p-watchers" }
    ) +
    V.group(
      "Schedules",
      "clock",
      `<div class="lr"><div><span class="d">Standing orders run on a schedule. Add, edit, pause or run them from the Command Center.</span></div><a class="btn small" href="/joya-ai#rules">Rules &amp; alerts</a></div>`,
      { id: "p-orders" }
    );
  return { body };
};

/** A cap's state as a pill. */
function capPill(s) {
  if (s.paused) return `<span class="pill bad">paused at cap</span>`;
  if (s.state === "warned") return `<span class="pill warn">over cap · warned</span>`;
  if (s.state === "resumed") return `<span class="pill neutral">resumed today</span>`;
  if (s.state === "near") return `<span class="pill warn">near cap</span>`;
  if (!s.cap) return `<span class="pill neutral">no cap</span>`;
  return `<span class="pill ok">ok</span>`;
}

sections.usage = async (req, res, deps) => {
  const csrf = res.locals.csrf;
  const c = await sup(deps, req, "token-caps");
  const off = !!c._error;
  const warn = c.warn_pct == null ? 80 : c.warn_pct;
  const kindTag = { self: '<span class="cc-tag ai">JOYA AI</span>', yours: '<span class="pill neutral">yours</span>', hired: '<span class="cc-tag mute">hired</span>', kept: '<span class="cc-tag ok">kept</span>' };
  const rowOf = (s) => {
    const today = (s.today && s.today.total) || 0;
    const pct = s.cap ? Math.min(100, (today / s.cap) * 100) : 0;
    const cls = s.paused || (s.cap && today >= s.cap) ? "bad" : s.cap && today >= (s.cap * warn) / 100 ? "warn" : "";
    const yours = s.kind === "yours" || s.can_pause === false;
    const fid = "cap-" + String(s.key).replace(/[^a-z0-9_-]/gi, "_");
    return `<tr data-cap-key="${esc(s.key)}"><td class="first" data-h="Session"><div class="l1"><b class="ink">${esc(s.name || s.key)}</b>${kindTag[s.kind] || ""}</div></td>
      <td data-h="Cap / day"><form method="post" action="/joya-ai/settings/usage/cap" class="set-form capin" data-live id="${fid}"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="key" value="${esc(s.key)}">
        <input type="number" name="cap_m" min="0" max="10000" step="0.5" value="${s.cap ? esc(+(s.cap / 1e6).toFixed(2)) : ""}" placeholder="none" aria-label="Daily cap in millions of tokens for ${esc(s.name || s.key)}"><span>M tok</span></form></td>
      <td data-h="Today"><div class="ucell"><div class="ubar ${cls}"><i data-w="${pct.toFixed(1)}"></i><span class="wl" data-l="${esc(warn)}"></span></div><div class="n"><span>${fmtTok(today)}${s.cap ? " of " + fmtTok(s.cap) : ""}</span><span>${s.cap ? Math.round((today / s.cap) * 100) + "%" : ""}</span></div></div></td>
      <td data-h="At the cap"><select name="at" form="${fid}" aria-label="At the cap"${yours ? ' disabled title="Not started by JOYA AI: it can only warn"' : ""}>${V.opt("warn", "Warn", s.at || "warn")}${V.opt("pause", "Pause", yours ? "warn" : s.at)}</select></td>
      <td class="right" data-h="State"><div class="l1">${capPill(s)}${
        s.paused
          ? `<form method="post" action="/joya-ai/settings/usage/resume" class="set-form" data-step-up><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="key" value="${esc(s.key)}"><button type="submit" class="btn small primary">Resume</button></form>`
          : ""
      }</div></td></tr>`;
  };
  const d = c.default || { cap: null, at: "warn" };
  let vs = null;
  try {
    const u = deps.voiceSpend ? deps.voiceSpend() : null;
    vs = u && !u.error && u.today ? u : null;
  } catch (_) {
    vs = null;
  }
  const body =
    V.head(
      "Usage & token caps",
      "What JOYA AI and its sessions use, in tokens, and the daily caps. Tokens count input, output and cache; the day is Cairo's."
    ) +
    (off ? offline("JOYA AI is not reachable (" + c._error + "): the caps could not be read.") : "") +
    V.group(
      "Warning line",
      "activity",
      V.row(
        "Warn at",
        "The warning line on every token cap below: a session past it shows amber here and in the Command Center.",
        V.form("/joya-ai/settings/usage/warn", csrf, `<input type="number" name="warn_pct" min="50" max="100" value="${esc(warn)}" aria-label="Warn at percent"${off ? " disabled" : ""}><span class="unit">% of a cap</span>`),
        { scope: "everyone", id: "u-warn" }
      )
    ) +
    V.group(
      "Token caps per session",
      "activity",
      `<div class="lr"><div><span class="d"><b class="inl">Warn</b> raises a Decision card and keeps going. <b class="inl">Pause</b> stops the session at the end of its current step and holds new work until you resume or the day turns. Your own sessions were not started by JOYA AI, so they can only warn. Other sessions are checked after each usage scan, so they can pass a cap by up to one scan's worth before it acts.</span></div></div>
      <div class="caps-wrap"><table class="rows caps stack aligned"><thead><tr><th>Session</th><th>Cap / day</th><th>Today</th><th>At the cap</th><th class="right">State</th></tr></thead><tbody>${((c.sessions || []).map(rowOf)).join("")}
      <tr><td class="first" data-h="Session"><div class="l1"><b class="ink">Default for new hires</b><span class="tag-s">template</span></div></td>
      <td data-h="Cap / day"><form method="post" action="/joya-ai/settings/usage/cap" class="set-form capin" data-live id="cap-default"><input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="key" value="default"><input type="number" name="cap_m" min="0" max="10000" step="0.5" value="${d.cap ? esc(+(d.cap / 1e6).toFixed(2)) : ""}" placeholder="none" aria-label="Default daily cap for new hires, millions of tokens"><span>M tok</span></form></td>
      <td data-h="Today"><span class="muted-num">applied when JOYA AI hires</span></td>
      <td data-h="At the cap"><select name="at" form="cap-default" aria-label="At the cap for new hires">${V.opt("warn", "Warn", d.at)}${V.opt("pause", "Pause", d.at)}</select></td><td class="right nolabel" data-h=""></td></tr>
      </tbody></table></div>`,
      { id: "u-caps" }
    ) +
    V.group(
      "See the numbers",
      "activity",
      V.row("Voice spend", "From the usage OpenAI reports, at today's prices.", `<span class="muted-num" id="voice-spend">${vs ? `today ${esc(usd(vs.today.total))} · this month ${esc(usd(vs.month_totals.total))}` : "not available"}</span>`, { id: "u-voice-spend" }) +
        V.linkRow("Usage panel", "Tokens today by session, and Claude Code's plan windows.", "/joya-ai#cost")
    );
  return { body };
};

/* ChatGPT (the joya-chatgpt broker) lives in its own file: lib/routes-chatgpt.js. */
require("./routes-chatgpt").install(sections);

/* ---------------------------------------------------------------- mount --- */

function mount(app, deps) {
  const { requireAuth, requireCsrf, ctx, db, joyaai } = deps;
  const audit = (req, what) => db.logLogin(req.ip, req.me.username, "joya-ai", String(what).slice(0, 200));

  /** Guard: signed in, and allowed that section (a page, or a JSON 403 for os.js). */
  const guard = (key) => (req, res, next) => {
    if (!req.me) return res.redirect("/login");
    if (V.mayOpen(req.perm, key)) return next();
    if (wantsJson(req)) return res.status(403).json({ ok: false, flash: flashes({ err: "Your role does not include this setting." }) });
    return res.status(403).send(require("./views").error("Not allowed", "Your role does not include this part of JOYA AI's Settings."));
  };

  app.get("/joya-ai/settings", requireAuth, (req, res) => {
    const first = V.sectionsFor(req.perm)[0];
    if (!first) return res.status(403).send(require("./views").error("Not allowed", "Your role does not include JOYA AI's Settings."));
    res.redirect(302, "/joya-ai/settings/" + first[0]);
  });

  // Advanced was merged into General (2026-10-25): old links land there.
  app.get("/joya-ai/settings/advanced", requireAuth, (req, res) => res.redirect(302, "/joya-ai/settings/general#x-restart"));

  app.get("/joya-ai/settings/:section", requireAuth, (req, res, next) => {
    const key = req.params.section;
    if (!V.SETTINGS_SECTIONS.some((s) => s[0] === key)) return next();
    guard(key)(req, res, async () => {
      try {
        const fn = sections[key];
        const out = fn ? await fn(req, res, deps) : { body: V.head(key, "Not available in this build.") };
        const status = {};
        for (const m of marks) {
          try {
            Object.assign(status, (await m(req)) || {});
          } catch (_) {
            /* a mark is a nicety */
          }
        }
        res.send(
          V.page({
            user: ctx(req),
            csrf: res.locals.csrf,
            section: key,
            body: out.body,
            secClass: out.secClass,
            assets: out.assets,
            status: Object.assign(status, out.status || {}),
            msg: req.query.msg || null,
            err: req.query.err || null,
          })
        );
      } catch (e) {
        next(e);
      }
    });
  });

  require("./routes-chatgpt").mount(app, deps, { guard, reply, audit });

  /* ---- General ---- */
  app.post("/joya-ai/settings/general/desktop", requireAuth, guard("general"), requireCsrf, (req, res) => {
    const d = DK.cleanDays(req.body.days);
    if (d == null || !deps.desktopSetDays) return reply(req, res, "general", { err: `Stay signed in: ${DK.MIN_DAYS} to ${DK.MAX_DAYS} days.`, anchor: "g-desktop" });
    deps.desktopSetDays(d, req.me.username);
    audit(req, `desktop app stays signed in ${d} days`);
    reply(req, res, "general", { msg: `The desktop app stays signed in for ${d} days (new sign-ins and the ones already there).`, anchor: "g-desktop" });
  });
  app.post("/joya-ai/settings/general/rc", requireAuth, guard("general"), requireCsrf, async (req, res) => {
    const enabled = req.body.enabled === "1" || req.body.enabled === "on";
    try {
      audit(req, `remote control ${enabled ? "on" : "off"}`);
      await joyaai.call("rc", { enabled }, req.me.username, { timeout: 60000 });
      reply(req, res, "general", { msg: `Remote control is ${enabled ? "on" : "off"}.`, anchor: "g-rc" });
    } catch (e) {
      reply(req, res, "general", { err: "Not changed: " + e.message, anchor: "g-rc" });
    }
  });

  /* ---- Sessions & hiring ---- */
  app.post("/joya-ai/settings/sessions/limits", requireAuth, guard("sessions"), requireCsrf, async (req, res) => {
    const p = {};
    const b = req.body || {};
    if (b.max_live !== undefined) {
      const n = intIn(b.max_live, 1, 12);
      if (n === null) return reply(req, res, "sessions", { err: "Live sessions: a whole number from 1 to 12.", anchor: "s-max-live" });
      p.max_live = n;
    }
    if (b.per_hour !== undefined) {
      const n = intIn(b.per_hour, 0, 10);
      if (n === null) return reply(req, res, "sessions", { err: "Hires per hour: a whole number from 0 to 10.", anchor: "s-per-hour" });
      p.per_hour = n;
    }
    if (b.perm_mode !== undefined) {
      if (!["auto", "default", "plan"].includes(b.perm_mode)) return reply(req, res, "sessions", { err: "Choose Auto, Ask before risky tools or Plan only.", anchor: "s-perm-mode" });
      p.perm_mode = b.perm_mode;
    }
    if (!Object.keys(p).length) return reply(req, res, "sessions", { err: "Nothing to change." });
    try {
      const out = await joyaai.call("hire-limits-set", p, req.me.username);
      audit(req, "hire limits " + JSON.stringify(p));
      reply(req, res, "sessions", {
        msg: `Saved: at most ${out.max_live} live sessions, ${out.per_hour} hires an hour, hired sessions start in ${out.perm_mode} mode.`,
        anchor: Object.keys(p).length === 1 ? { max_live: "s-max-live", per_hour: "s-per-hour", perm_mode: "s-perm-mode" }[Object.keys(p)[0]] : null,
      });
    } catch (e) {
      reply(req, res, "sessions", { err: "Not saved: " + e.message });
    }
  });

  /* ---- Screen control ---- */
  app.post("/joya-ai/settings/screen/actions", requireAuth, guard("screen"), requireCsrf, (req, res) => {
    const on = req.body.on === "1" || req.body.on === "on";
    db.setSetting("ui_actions_enabled:" + Number(req.me.id), on ? "1" : "0", req.me.username);
    db.logLogin(req.ip, req.me.username, "joya-ui", `screen actions ${on ? "on" : "off"}`);
    reply(req, res, "screen", { msg: on ? "JOYA AI may act on your screen when you ask." : "Screen actions are off: JOYA AI keeps to words.", anchor: "sc-actions" });
  });
  app.post("/joya-ai/settings/screen/policy", requireAuth, guard("screen"), requireCsrf, (req, res) => {
    const p = req.body.policy === "wait" ? "wait" : "auto";
    deps.pageMap.setPolicy(p, req.me.username);
    db.logLogin(req.ip, req.me.username, "joya-ui", `page map: new entries ${p === "wait" ? "off until allowed" : "allowed at once"}`);
    reply(req, res, "screen", { msg: p === "wait" ? "New pages start off until you allow them." : "New pages are allowed at once.", anchor: "sc-policy" });
  });
  app.post("/joya-ai/settings/screen/allow", requireAuth, guard("screen"), requireCsrf, (req, res) => {
    const key = String(req.body.key || "");
    const st = deps.pageMap.current();
    if (!st || !st.entries.some((e) => e.key === key)) return reply(req, res, "screen", { err: "No such entry in the page map.", anchor: "sc-registry" });
    const on = req.body.on === "1" || req.body.on === "on";
    deps.pageMap.setAllow(key, on, req.me.username);
    db.logLogin(req.ip, req.me.username, "joya-ui", `page map: ${key} ${on ? "allowed" : "off"}`);
    reply(req, res, "screen", { msg: `${key}: ${on ? "JOYA AI may open it" : "off — JOYA AI cannot open it or anything under it"}.`, anchor: "sc-registry", reload: true });
  });
  app.post("/joya-ai/settings/screen/allow-all", requireAuth, guard("screen"), requireCsrf, (req, res) => {
    deps.pageMap.allowAll(req.me.username);
    db.logLogin(req.ip, req.me.username, "joya-ui", "page map: allowed all");
    reply(req, res, "screen", { msg: "Every entry of the page map is allowed.", anchor: "sc-registry", reload: true });
  });
  // Rescan pages: re-read the view sources on disk. JSON (with the scan's steps) for joya-screen.js.
  app.post("/joya-ai/settings/screen/rescan", requireAuth, guard("screen"), requireCsrf, (req, res) => {
    let st;
    try {
      st = deps.pageMap.scan(req.me.username);
    } catch (e) {
      return reply(req, res, "screen", { err: "The scan failed: " + e.message, anchor: "sc-registry" });
    }
    const d = st.diff || { added: [], renamed: [], removed: [] };
    const by = (k) => st.entries.filter((e) => e.kind === k).length;
    db.logLogin(req.ip, req.me.username, "joya-ui", `page map rescanned: ${st.entries.length} entries, ${d.added.length} new, ${d.renamed.length} renamed, ${d.removed.length} removed`);
    const msg = `Page map rebuilt: ${d.added.length} new, ${d.renamed.length} renamed, ${d.removed.length} removed.`;
    if (wantsJson(req))
      return res.json({
        ok: true,
        flash: flashes({ msg }),
        reload: true,
        steps: [
          `Reading the routes (ui NAV) … ${by("page")} pages`,
          `Reading settings sections … ${by("section")} sections`,
          `Reading Command Center sheets (cc-logic SHEETS) … ${by("sheet")}`,
          `Reading tabs and card anchors in lib/views-*.js … ${by("tab")} tabs, ${by("anchor")} anchors`,
          `Checking each entry's permission …`,
          `Comparing with the last map …`,
        ],
      });
    reply(req, res, "screen", { msg, anchor: "sc-registry" });
  });

  /* ---- Approvals & automations ---- */
  app.post("/joya-ai/settings/approvals/timeout", requireAuth, guard("approvals"), requireCsrf, async (req, res) => {
    const n = intIn(req.body.seconds, 30, 3600);
    if (n === null) return reply(req, res, "approvals", { err: "Wait for your answer: 30 to 3600 seconds.", anchor: "p-timeout" });
    try {
      await joyaai.call("approval-timeout-set", { seconds: n }, req.me.username);
      audit(req, `approval timeout ${n}s`);
      reply(req, res, "approvals", { msg: `JOYA AI waits ${n} seconds for your answer to a Decision.`, anchor: "p-timeout" });
    } catch (e) {
      reply(req, res, "approvals", { err: "Not saved: " + e.message, anchor: "p-timeout" });
    }
  });
  app.post("/joya-ai/settings/approvals/watcher/:key", requireAuth, guard("approvals"), requireCsrf, async (req, res) => {
    let key;
    try {
      key = joyaai.oneOf(req.params.key, "Watcher", joyaai.WATCHERS);
    } catch (e) {
      return reply(req, res, "approvals", { err: e.message, anchor: "p-watchers" });
    }
    const enabled = req.body.enabled === "1" || req.body.enabled === "on";
    try {
      await joyaai.call("watcher-set", { key, enabled }, req.me.username);
      audit(req, `watcher ${key} ${enabled ? "on" : "off"}`);
      reply(req, res, "approvals", { msg: `System alert ${enabled ? "on" : "off"}.`, anchor: "p-watchers" });
    } catch (e) {
      reply(req, res, "approvals", { err: "Not changed: " + e.message, anchor: "p-watchers" });
    }
  });

  /* ---- Usage & token caps ---- */
  app.post("/joya-ai/settings/usage/warn", requireAuth, guard("usage"), requireCsrf, async (req, res) => {
    const n = intIn(req.body.warn_pct, 50, 100);
    if (n === null) return reply(req, res, "usage", { err: "Warn at: 50 to 100 %.", anchor: "u-warn" });
    try {
      await joyaai.call("token-caps-set", { warn_pct: n }, req.me.username);
      audit(req, `token cap warning line ${n}%`);
      reply(req, res, "usage", { msg: `The warning line is at ${n} % of each cap.`, anchor: "u-warn", reload: true });
    } catch (e) {
      reply(req, res, "usage", { err: "Not saved: " + e.message, anchor: "u-warn" });
    }
  });
  app.post("/joya-ai/settings/usage/cap", requireAuth, guard("usage"), requireCsrf, async (req, res) => {
    const key = String(req.body.key || "");
    if (!/^[A-Za-z0-9<>._:-]{1,80}$/.test(key)) return reply(req, res, "usage", { err: "No such session.", anchor: "u-caps" });
    const raw = String(req.body.cap_m == null ? "" : req.body.cap_m).trim();
    let cap = null;
    if (raw !== "") {
      const m = Number(raw);
      if (!Number.isFinite(m) || m < 0 || m > 10000) return reply(req, res, "usage", { err: "A cap is a number of millions of tokens, 0.1 to 10000 — or empty for none.", anchor: "u-caps" });
      cap = m === 0 ? null : Math.round(m * 1e6);
      if (cap !== null && cap < 1e5) return reply(req, res, "usage", { err: "A cap below 0.1 M tokens would stop a session at once.", anchor: "u-caps" });
    }
    const at = req.body.at === "pause" ? "pause" : "warn";
    try {
      await joyaai.call("token-caps-set", { key, cap, at }, req.me.username);
      audit(req, `token cap ${key}: ${cap === null ? "none" : cap} (${at})`);
      reply(req, res, "usage", { msg: key === "default" ? "Saved the default for new hires." : "Saved the cap.", anchor: "u-caps", reload: true });
    } catch (e) {
      reply(req, res, "usage", { err: "Not saved: " + e.message, anchor: "u-caps" });
    }
  });
  // Resume lets a paused session run again: Windows Hello (or the code) first, lib/stepup.js.
  // The form carries data-step-up; public/step-up.js asks and posts the proof with it.
  const resumeStepUp = require("./stepup").requireStepUp({
    bind: (req) => {
      const key = String((req.body && req.body.key) || "");
      return /^[A-Za-z0-9<>._:-]{1,80}$/.test(key) ? "resume:" + key : null;
    },
    what: () => "Resume past the daily cap",
    audit: deps.stepAudit,
    html: (req, res, msg) => reply(req, res, "usage", { err: msg + " (Windows Hello needs JavaScript on this page.)", anchor: "u-caps" }),
  });
  app.post("/joya-ai/settings/usage/resume", requireAuth, guard("usage"), requireCsrf, resumeStepUp, async (req, res) => {
    const key = String(req.body.key || "");
    if (!/^[A-Za-z0-9<>._:-]{1,80}$/.test(key)) return reply(req, res, "usage", { err: "No such session.", anchor: "u-caps" });
    try {
      if (deps.callStepped) await deps.callStepped(req, "budget-resume", { key });
      else await joyaai.call("budget-resume", { key }, req.me.username);
      audit(req, `resumed ${key} past its daily cap${deps.steppedWith ? deps.steppedWith(req) : ""}`);
      reply(req, res, "usage", { msg: "Resumed for the rest of today.", anchor: "u-caps", reload: true });
    } catch (e) {
      reply(req, res, "usage", { err: "Not resumed: " + e.message, anchor: "u-caps" });
    }
  });

  /* ---- Restart (General; it was the Advanced section until 2026-10-25, whose URLs still work) ---- */
  const restart = async (req, res) => {
    try {
      audit(req, "restarted JOYA AI");
      await joyaai.call("restart", {}, req.me.username, { timeout: 90000 });
      reply(req, res, "general", { msg: "JOYA AI restarted.", anchor: "x-restart" });
    } catch (e) {
      reply(req, res, "general", { err: "Not restarted: " + e.message, anchor: "x-restart" });
    }
  };
  app.post("/joya-ai/settings/general/restart", requireAuth, guard("general"), requireCsrf, restart);
  app.post("/joya-ai/settings/advanced/restart", requireAuth, guard("general"), requireCsrf, restart);
}

module.exports = { mount, sections, marks, reply, wantsJson, sup, capPill, fmtTok, uiActionsEnabled };
