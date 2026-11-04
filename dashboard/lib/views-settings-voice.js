"use strict";
/**
 * JOYA AI ▸ Settings ▸ Voice (/joya-ai/settings/voice): the section's body.
 * The page around it is lib/views-settings.js; the routes are server.js's
 * voice code (they sit with the voice they change).
 *
 * Voice is live conversation only (Joya reorganisation, 2026-09-30): one
 * Enabled / Disabled switch for everyone, the voice model, the key, the voice,
 * the voiceprint and the live call's audio. While voice is off the section carries `voice-off` (joya-os.css):
 * the rows that only matter with voice on dim (.dep) or hide (.dep-hide), and
 * the key row stays usable -- the key is kept while voice is off.
 *
 * Every row that changes something is a small form (V.form: sent in place by
 * os.js, a plain POST without JavaScript). The key is typed in a dialog and
 * posted once, to be handed to the helper on stdin; it is never shown again.
 *
 * The voice model holds the live call and reads replies aloud when it passed
 * the verbatim check (else gpt-realtime-2.1-mini reads them); a gated model the
 * OpenAI key cannot reach is listed, disabled (2026-10-01).
 *
 * Removed on 2026-10-30 at the administrator's request: the Transcription and
 * Transcription language rows (one model now, gpt-4o-transcribe, on the
 * realtime models; GPT-Live's own transcript on GPT-Live --
 * lib/voice-transcribe.js), the "Arabic" persona row (the persona is learned
 * from how they speak; the voice's persona.set screen action still sets one) and
 * "Read replies aloud" (typed replies are no longer read by themselves).
 *
 * The voice cards follow the voice model (lib/voice.js voicesFor: GPT-Live 31,
 * the realtime models 10). Each card has a play button that speaks a short
 * sample in that voice (POST {BASE}/sample, public/joya-settings-voice.js)
 * without choosing it.
 *
 * Anchors (the page registry scans them): v-model, v-token, v-test, v-voice,
 * v-live-audio, v-voiceprint, v-vp-gate, v-vp-strict, v-vp-people, v-vp-stats,
 * v-vp-forget. Voice spend moved to Usage & token caps (2026-10-25). Rarely
 * needed rows sit under "More" disclosures (V.more): noise reduction, the
 * voiceprint's last 7 days and Delete everything.
 *
 * The Voiceprint group (lib/voiceprint.js): the On / Off switch, "Only respond
 * to my voice" (greyed while the voiceprint is off or not enrolled), the
 * enrolment, the last 7 days of checks, and Delete everything.
 */

const { esc, icon, state } = require("./ui");
const V = require("./views-settings");

const BASE = "/joya-ai/settings/voice";

const GENDER = {
  female: ["♀", "Female"],
  male: ["♂", "Male"],
  neutral: ["◌", "Neutral"],
};

const NOISE = [
  ["far_field", "Laptop or room microphone (default)"],
  ["near_field", "Headset microphone"],
  ["off", "Off"],
];

const MIC_LABEL = { laptop: "Laptop microphone", headset: "Headset", other: "Other microphone" };
const micLabel = (m) => MIC_LABEL[m] || m;
const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "—");

/** The score histogram of the last days (inline SVG: no inline style, CSP-clean). */
function vpHistogram(st, th) {
  const h = st.hist || [];
  const max = Math.max(1, ...h);
  const W = 240;
  const H = 56;
  const bw = W / Math.max(1, h.length);
  const x = (score) => ((score - st.hist_from) / (st.hist_step * h.length)) * W;
  const bars = h
    .map((n, i) => {
      const lo = st.hist_from + i * st.hist_step;
      const cls = lo >= th.accept ? "ok" : lo + st.hist_step <= th.reject ? "bad" : "mid";
      const bh = n ? Math.max(2, Math.round((n / max) * (H - 4))) : 0;
      return bh ? `<rect class="${cls}" x="${(i * bw + 1).toFixed(1)}" y="${H - bh}" width="${(bw - 2).toFixed(1)}" height="${bh}"><title>${lo.toFixed(2)}–${(lo + st.hist_step).toFixed(2)}: ${n}</title></rect>` : "";
    })
    .join("");
  const line = (v, cls) => `<line class="${cls}" x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="0" y2="${H}"></line>`;
  return `<svg class="vp-hist" viewBox="0 0 ${W} ${H + 12}" role="img" aria-label="Scores of the last ${st.days} days"><line class="base" x1="0" x2="${W}" y1="${H}" y2="${H}"></line>${bars}${line(th.accept, "acc")}${line(th.reject, "rej")}<text x="0" y="${H + 11}">${st.hist_from}</text><text x="${x(0).toFixed(1)}" y="${H + 11}" text-anchor="middle">0</text><text x="${x(th.accept).toFixed(1)}" y="${H + 11}" text-anchor="middle">${th.accept}</text><text x="${W}" y="${H + 11}" text-anchor="end">1</text></svg>`;
}

/**
 * The Voiceprint group (lib/voiceprint.js). o.voiceprint = { enabled, gate, thresholds, service, enrolled,
 * model, stats }.
 */
function voiceprintGroup(o) {
  const vp = o.voiceprint;
  if (!vp) return "";
  const csrf = o.csrf;
  const en = !!vp.enabled;
  const people = vp.people || [];
  const enrolled = people.some((p) => p.enrolled);
  const th = vp.thresholds || { accept: 0.31, reject: 0.2, stickyMin: 0.2, echo: 0.45 };
  const svcBad = en && vp.service && (vp.service.ok === false || vp.service.error);
  const warn = svcBad
    ? `<div class="alert bad vp-warn" id="vp-service-warn">${icon("alert")}<div><strong>The voiceprint service is not answering.</strong> Turns are not being checked and nothing is blocked (fail open). ${esc(
        vp.service.error || ""
      )} <span class="muted">It is <code>joya-voiceprint.service</code>, installed with <code>deploy/install-voiceprint.sh</code>.</span></div></div>`
    : "";
  const sw1 = V.row(
    "Voiceprint",
    `Checks each turn of a call against the stored voices, on this server, and greets people by name. On its own it blocks nothing. <b>A voice identifies; it never approves anything.</b>`,
    V.form(`${BASE}/voiceprint`, csrf, V.sw('name="enabled" value="1" id="vp-enabled" aria-label="Voiceprint"', en, "On", "Off"), {
      confirm: en ? "Switch the voiceprint off?" : null,
      confirmBody: en ? "Turns are no longer checked or named; “Only respond to stored voices” stops too. The voiceprints are kept." : null,
      confirmYes: en ? "Switch off" : null,
    }),
    { id: "v-voiceprint", scope: "everyone" }
  );
  const canGate = en && enrolled;
  const gateHelp = `On: voices it does not know, and turns where it is not sure who is speaking, get no answer. If the check itself fails, the turn goes through.${
    canGate ? "" : en ? ` <span class="muted" id="vp-gate-why">Store a voiceprint first.</span>` : ` <span class="muted" id="vp-gate-why">The voiceprint is off.</span>`
  }`;
  const sw2 = V.row(
    "Only respond to stored voices",
    gateHelp,
    V.form(`${BASE}/voiceprint/gate`, csrf, V.sw(`name="gate" value="1" id="vp-gate" aria-label="Only respond to stored voices"${canGate ? "" : " disabled"}`, canGate && vp.gate, "On", "Off"), {
      confirm: vp.gate ? null : "Only respond to stored voices?",
      confirmBody: vp.gate ? null : "From the next turn, unknown voices and unsure turns get no answer.",
      confirmYes: vp.gate ? null : "Turn on",
    }),
    { id: "v-vp-gate", scope: "everyone" }
  );
  const presets = vp.presets || [];
  const cur = vp.preset || "relaxed";
  const curP = presets.find((p) => p.id === cur);
  const presetForm = V.form(
    `${BASE}/voiceprint/strictness`,
    csrf,
    `<div class="vp-presets" role="radiogroup" aria-label="Strictness">${presets
      .map(
        (p) =>
          `<label class="vp-preset${p.id === cur ? " on" : ""}"><input type="radio" name="preset" value="${esc(p.id)}"${p.id === cur ? " checked" : ""}${en ? "" : " disabled"}><span class="t"><b>${esc(p.label)}</b><small>${esc(p.effect)}</small></span></label>`
      )
      .join("")}${cur === "custom" ? `<p class="small vp-custom" id="vp-custom">Custom values (Advanced).</p>` : ""}</div>`
  );
  const num = (name, label, val, lo, hi, hint) =>
    `<label class="vp-num"><span class="small">${esc(label)}</span><input type="number" name="${name}" value="${esc(String(val))}" min="${lo}" max="${hi}" step="0.01" required data-no-live${en ? "" : " disabled"}><small class="muted">${esc(hint)}</small></label>`;
  const B = vp.bounds || { accept: [0.05, 0.8], reject: [0.05, 0.8], stickyMin: [0.05, 0.8], echo: [0.2, 0.9] };
  const adv = `<details class="vp-adv" id="vp-adv"${cur === "custom" ? " open" : ""}><summary>Advanced</summary>${V.form(
    `${BASE}/voiceprint/strictness`,
    csrf,
    `<div class="vp-nums-grid">${num("accept", "Recognised from", th.accept, B.accept[0], B.accept[1], "a score this high is you")}${num("reject", "Another voice below", th.reject, B.reject[0], B.reject[1], "lower than the next")}${num(
      "stickyMin",
      "Call's voice from",
      th.stickyMin,
      B.stickyMin[0],
      B.stickyMin[1],
      "after you're recognised; ≤ Recognised from"
    )}${num("echo", "JOYA AI's own voice from", th.echo, B.echo[0], B.echo[1], "heard over its playback")}</div><p class="btn-row"><button class="btn small primary" type="submit" id="vp-adv-save"${en ? "" : " disabled"}>Save</button><button class="btn small" type="submit" name="reset" value="1" id="vp-adv-reset"${en ? "" : " disabled"}>Reset to defaults</button></p>`,
    { noSave: true }
  )}</details>`;
  const strictRow = V.row(
    "Strictness",
    `How much benefit of the doubt a speaker gets once recognised in a call.${curP ? "" : " Now: custom values."}`,
    `<div class="vp-strict">${presetForm}${adv}</div>`,
    { id: "v-vp-strict", scope: "everyone", full: true }
  );
  const day = (t) => (t ? esc(String(t).slice(0, 10)) : "never");
  const personCard = (p) => {
    const ms = Object.keys(p.mics || {});
    const micList = ms
      .map(
        (m) =>
          `<li class="vp-mic"><span><b>${esc(micLabel(m))}</b> <span class="muted">${esc(String(p.mics[m].speech_s || "?"))} s${p.mics[m].source === "trial" ? " · trial recordings" : ""}</span></span>${V.form(
            `${BASE}/voiceprint/people/${esc(p.id)}/remove-mic`,
            csrf,
            `<input type="hidden" name="mic" value="${esc(m)}"><button class="btn small" type="submit">Remove</button>`,
            { noSave: true, cls: "inline", confirm: `Remove this microphone from ${p.name}'s voiceprint?`, confirmBody: ms.length > 1 ? "It is rebuilt from the other microphones." : "It is the only one: the voiceprint is emptied until it is enrolled again.", confirmYes: "Remove" }
          )}</li>`
      )
      .join("");
    const linked = p.user_id != null ? (vp.users || []).find((u) => u.id === p.user_id) : null;
    return `<li class="vp-person" data-person="${esc(p.id)}">
      <div class="vp-ph"><span class="vp-pn"><b>${esc(p.name)}</b>${p.spoken ? ` <span class="muted" dir="auto">«${esc(p.spoken)}»</span>` : ""}${linked ? ` <span class="tag-s" title="Dashboard user">${esc(linked.username)}</span>` : ""}${
        p.enrolled ? "" : ` <span class="pill bad">not enrolled</span>`
      }</span><span class="muted small">last heard ${day(p.last_heard)} · added ${day(p.created_at)}</span></div>
      <div class="vp-pc">${V.form(
        `${BASE}/voiceprint/people/${esc(p.id)}/command`,
        csrf,
        `<label class="vp-cmd"><span class="small">May give commands</span>${V.sw(`name="may" value="1" aria-label="${esc(p.name)} may give commands"${en ? "" : " disabled"}`, p.may_command, "On", "Off")}</label>`
      )}</div>
      ${ms.length ? `<ul class="vp-mics">${micList}</ul>` : ""}
      <div class="vp-acts"><a class="btn small${p.enrolled ? "" : " primary"}" href="/joya-ai/voiceprint/enrol?person=${encodeURIComponent(p.id)}">${icon("voice", 14)} ${p.enrolled ? "Add or redo a microphone" : "Enrol (about 2 minutes)"}</a>
        <details class="vp-rename"><summary class="btn small">Rename</summary>${V.form(
          `${BASE}/voiceprint/people/${esc(p.id)}/rename`,
          csrf,
          `<label class="vp-field"><span class="small">Name</span><input name="name" value="${esc(p.name)}" maxlength="40" required data-no-live></label><label class="vp-field"><span class="small">Spoken name (optional)</span><input name="spoken" value="${esc(p.spoken || "")}" maxlength="40" dir="auto" data-no-live></label><button class="btn small primary" type="submit">Save</button>`,
          { noSave: true, cls: "vp-rename-form" }
        )}</details>
        ${V.form(`${BASE}/voiceprint/people/${esc(p.id)}/delete`, csrf, `<button class="btn small danger" type="submit">${icon("trash", 14)} Delete</button>`, {
          noSave: true,
          cls: "inline",
          confirm: `Delete ${p.name}'s voiceprint?`,
          confirmBody: "Only this voiceprint is deleted. Their voice is unknown from the next turn.",
          confirmYes: "Delete",
        })}</div>
    </li>`;
  };
  const full = people.length >= (vp.max || 10);
  const addForm = `<form method="post" action="${BASE}/voiceprint/people" class="vp-add" id="vp-add"><input type="hidden" name="_csrf" value="${esc(csrf)}">
      <label class="vp-field"><span class="small">Name</span><input name="name" maxlength="40" required placeholder="Zaghloul" pattern="[A-Za-z0-9][A-Za-z0-9 .'\\-]{0,39}"${full || !en ? " disabled" : ""}></label>
      <label class="vp-field"><span class="small">Spoken name (optional)</span><input name="spoken" maxlength="40" dir="auto" placeholder="زغلول"${full || !en ? " disabled" : ""}></label>
      ${vp.me ? "" : `<label class="vp-me"><input type="checkbox" name="me" value="1"${full || !en ? " disabled" : ""}> This is my own voice</label>`}
      <button class="btn small primary" type="submit" id="vp-add-btn"${full || !en ? " disabled" : ""}>${icon("plus", 14)} Add and enrol</button></form>`;
  const peopleRow = V.row(
    `Stored voiceprints <span class="muted">(${people.length} of ${vp.max || 10})</span>`,
    `People JOYA AI knows by voice. With “May give commands” off, it only talks with them. Record only people who agreed. Stored as sealed numbers, never as recordings (model ${esc(vp.model || "")}).`,
    `<div class="vp-people-box">${people.length ? `<ul class="vp-people" id="vp-people">${people.map(personCard).join("")}</ul>` : `<span class="kv-mask" id="vp-none">${icon("fingerprint", 15)}<span>No voiceprints stored</span></span>`}${full ? `<p class="small muted">At most ${vp.max || 10} stored voiceprints.</p>` : addForm}</div>`,
    { id: "v-vp-people", full: true }
  );
  const st = vp.stats || { checked: 0, by: {} };
  const by = st.by || {};
  const perPerson = (st.people || []).map((x) => `<span><b>${x.turns}</b> ${esc(x.name)}${x.talk_only ? ` (${x.talk_only} talk only)` : ""}</span>`).join("");
  const statsBody = st.checked
    ? `<div class="vp-stats" id="vp-stats"><div class="vp-nums"><span><b>${st.checked}</b> turns checked</span>${perPerson}<span class="${st.unknown ? "vp-attn" : ""}"><b>${st.unknown || 0}</b> unknown voice</span><span><b>${
        st.unsure || 0
      }</b> not sure who</span>${by.echo ? `<span class="vp-attn"><b>${by.echo}</b> JOYA AI's echo</span>` : ""}${by.unverified ? `<span><b>${by.unverified}</b> too short to check</span>` : ""}${
        by.error ? `<span class="vp-attn"><b>${by.error}</b> not checked (service)</span>` : ""
      }<span class="muted">median best score ${st.score_p50 == null ? "—" : st.score_p50} · check ${st.ms_p50 == null ? "—" : Math.round(st.ms_p50) + " ms"} (p95 ${st.ms_p95 == null ? "—" : Math.round(st.ms_p95) + " ms"})</span></div>${vpHistogram(st, th)}</div>`
    : `<span class="muted-num" id="vp-stats">${en ? (enrolled ? "No turns checked yet — talk in a live call." : "Nothing yet: store a voiceprint first.") : "The voiceprint is off."}</span>`;
  const statsRow = V.row(
    `Last ${st.days || 7} days${vp.gate ? "" : " (watching only)"}`,
    `Who was heard. <span id="vp-active">Now: recognised from ${th.accept}; unknown below ${th.reject}; the call's speaker from ${th.stickyMin}; JOYA AI's own voice from ${th.echo}${
      curP ? ` (${esc(curP.label.replace(/ \(recommended\)$/, ""))})` : " (custom)"
    }.</span>`,
    statsBody,
    { id: "v-vp-stats", full: !!st.checked }
  );
  const forget = V.row(
    "Delete everything",
    "Every stored voiceprint, its sealing key, JOYA AI's own voice print and the check log.",
    V.form(`${BASE}/voiceprint/forget-all`, csrf, `<button class="btn small danger" type="submit" id="vp-forget-all">${icon("trash", 14)} Delete everything</button>`, {
      noSave: true,
      cls: "inline",
      confirm: "Delete every stored voiceprint?",
      confirmBody: "All voiceprints, the key and the check log are removed. This cannot be undone.",
      confirmYes: "Delete everything",
    }),
    { id: "v-vp-forget" }
  );
  return V.group("Voiceprint", "fingerprint", warn + sw1 + `<div class="vp-dep${en ? "" : " vp-off"}">${sw2}${strictRow}${peopleRow}</div>` + V.more("More: last 7 days, delete everything", statsRow + forget, { id: "v-vp-more" }), { id: "v-vp" });
}

/**
 * A voice card: name, gender (as the voice presents: in OpenAI's samples for
 * the realtime voices, OpenAI's own label for GPT-Live's), a word or two, and a
 * play button beside the radio label (not inside it: a click on it must not
 * choose the voice). The button is hidden until the page script shows it.
 */
function voiceCard(name, cur, meta, opts) {
  const m = meta || {};
  const o = opts || {};
  const g = GENDER[m.gender] || null;
  const tip =
    m.gender === "neutral"
      ? "OpenAI presents alloy as neutral; labelled Neutral rather than guessed"
      : m.labelled
        ? "as OpenAI labels this GPT-Live voice"
        : "as the voice presents in OpenAI's own samples (OpenAI does not label gender)";
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return `<div class="voice-slot"><label class="voice-card"><input type="radio" name="voice" value="${esc(name)}"${name === cur ? " checked" : ""}><span class="top"><b>${esc(label)}</b>${
    g ? `<span class="g" title="${esc(tip)}"><i aria-hidden="true">${g[0]}</i>${esc(g[1])}</span>` : ""
  }</span><span>${esc(m.note || "")}</span></label><button type="button" class="voice-play" data-sample="${esc(name)}" aria-label="Play a sample of ${esc(label)}" title="Play a sample of ${esc(label)}"${
    o.canPlay ? "" : " disabled"
  } hidden><span class="vp-i-play">${icon("play", 13)}</span><span class="vp-i-stop">${icon("stop", 12)}</span></button></div>`;
}

/**
 * @param o {
 *   csrf,
 *   on            the switch
 *   status        priv.voiceStatus(): configured, modified (never the key)
 *   model         the voice model now (lib/voice.js VOICE_MODELS id)
 *   models        lib/voice.js VOICE_MODELS [{id, label, short, hint, gated?}]
 *   access        lib/voice.js modelAccess(): { id: { available, known } }
 *   voice, voices, meta   the voice, the voices the model can use (lib/voice.js voicesFor), VOICE_META
 *   liveAudio     { duplex, noise }
 *   test          { ok, text } from a no-JavaScript Test
 *   switchRow     settings row of the switch: { updated_at, updated_by } | null
 * }
 */
function body(o) {
  const on = !!o.on;
  const set = !!(o.status && o.status.configured);
  const csrf = o.csrf;

  const hero = `<div class="hero-sw"><span class="hs-ico">${icon("voice", 22)}</span><div class="hs-t"><b id="voice-state">${
    on ? "Voice is on" : "Voice is off"
  }</b><span>${
    on ? (set ? `Live calls · ${esc(o.model)} · ${esc(o.voice)}` : "On, but there is no OpenAI key yet. Add one below.") : "Nothing listens or speaks. The key stays saved."
  }</span></div>${V.form(`${BASE}/enabled`, csrf, V.sw('name="enabled" value="1" id="voice-master" aria-label="Voice for everyone"', on, "On", "Off", "big"), {
    cls: "hs-form",
    confirm: on ? "Turn voice off for everyone?" : null,
    confirmBody: on ? "The microphone and call buttons disappear, and an open call ends. The key stays saved." : null,
    confirmYes: on ? "Turn voice off" : null,
  })}</div>`;

  const offnote = `<div class="offnote">${icon("info", 16)}<div>Voice is off for everyone. The microphone and call buttons are hidden, and JOYA AI's voice actions are refused. Typing works as usual.</div></div>`;

  // The voice model: the option says its name; the line under the list says its facts. A gated model the
  // key cannot reach is listed, disabled (lib/voice.js modelAccess), unless it is current.
  const access = o.access || {};
  const models = o.models || [];
  const reach = (m) => !m.gated || !!(access[m.id] && access[m.id].available);
  const away = (m) => (access[m.id] && access[m.id].known ? "not on this key" : "not checked yet");
  const mCur = models.find((m) => m.id === o.model) || models[0] || { hint: "" };
  const mHint = (m) =>
    reach(m)
      ? m.hint || ""
      : access[m.id] && access[m.id].known
        ? "This OpenAI key cannot use it. It is offered once the key can."
        : "Not checked on this OpenAI key yet. It is offered once the key's model list shows it.";
  const mOpt = (m) =>
    `<option value="${esc(m.id)}" data-hint="${esc(mHint(m))}"${m.id === o.model ? " selected" : ""}${reach(m) || m.id === o.model ? "" : " disabled"}>${esc(
      (m.label || m.id) + (reach(m) ? "" : " (" + away(m) + ")") + (m.id === o.model ? " (current)" : "")
    )}</option>`;
  const retiring = models.some((m) => m.id === "gpt-realtime-mini");
  const modelRow = V.row(
    "Voice model",
    `Holds the call and speaks.${retiring ? ` <span class="muted" id="voice-retire-note">GPT Realtime mini retires on 20 January 2027.</span>` : ""}`,
    `<div class="tr-pick">${V.form(
      `${BASE}/options`,
      csrf,
      `<select name="model" id="voice-model" aria-label="Voice model"${on ? "" : " disabled"}>${models.map(mOpt).join("")}</select>`
    )}<small class="tr-hint" id="voice-model-hint">${esc(mHint(mCur))}</small></div>`,
    { dep: true, scope: "everyone", id: "v-model" }
  );

  const token = set
    ? `<span class="kv-mask">${icon("lock", 15)}<span>••••••••••••••••••••</span>${state("ok", "Set")}</span>
       <button type="button" class="btn small" data-modal-open="m-voice-token" id="voice-token-replace">Replace</button>
       ${V.form(`${BASE}/clear`, csrf, `<button class="btn small danger" type="submit" id="voice-remove">${icon("trash", 14)} Remove</button>`, {
         noSave: true,
         cls: "inline",
         confirm: "Remove the OpenAI key?",
         confirmBody: "Voice stops for everyone until a key is added again. Typing keeps working.",
         confirmYes: "Remove key",
       })}`
    : `<span class="kv-mask">${icon("lock", 15)}<span>No key</span>${state("bad", "Not set")}</span>
       <button type="button" class="btn small primary" data-modal-open="m-voice-token" id="voice-token-replace">${icon("plus", 14)} Add key</button>`;
  const tokenRow = V.row("OpenAI key", "Saved in a file only root can read, and never shown again.", `<div class="keybox">${token}</div>`, { id: "v-token" });

  const testRow = V.row(
    "Test the voice",
    "Speaks one line with the voice model and writes it back with gpt-4o-transcribe. Costs a fraction of a cent.",
    V.form(`${BASE}/test`, csrf, `<button class="btn small" type="submit" id="voice-test"${on && set ? "" : " disabled"}>${icon("play", 14)} Test</button>`, { noSave: true, cls: "inline" }),
    { dep: true, id: "v-test" }
  );
  const test = o.test
    ? `<div class="alert ${o.test.ok ? "good" : "bad"} test-out" id="voice-test-result">${icon(o.test.ok ? "check" : "alert")}<div><strong>${
        o.test.ok ? "Test passed." : "Test failed."
      }</strong> ${esc(o.test.text)}</div></div>`
    : "";

  const main = `<div class="group" id="v-main">${hero}${offnote}${modelRow}${tokenRow}${testRow}${test}</div>`;

  const hiddenNote = `<p class="hidden-note">${icon("info", 16)}The rest of the voice settings are hidden while voice is off. Their values are kept.</p>`;

  const canPlay = on && set;
  const cards = o.voices.map((n) => voiceCard(n, o.voice, o.meta[n], { canPlay })).join("");
  const many = o.voices.length > 10;
  const voiceGroup = V.group(
    "Voice",
    "voice",
    V.row(
      "Voice",
      `How JOYA AI sounds. ▶ plays a short sample without choosing it. An open call reconnects in the new voice.${
        many ? ` <span class="muted" id="voice-live-note">GPT-Live's own voices (Quartz to Noeul) are for GPT-Live only.</span>` : ""
      }`,
      V.form(`${BASE}/options`, csrf, `<div class="voice-cards" role="radiogroup" aria-label="Voice">${cards}</div>`, { cls: "voice-form" }) +
        `<p class="voice-sample-msg small" id="voice-sample-msg" role="status" aria-live="polite" hidden></p>`,
      { full: true, scope: "everyone", id: "v-voice" }
    )
  );

  const a = o.liveAudio || {};
  const liveGroup = V.group(
    "Live calls",
    "network",
    V.row(
      "Speakers or headphones",
      "Speakers: the microphone pauses while JOYA AI talks. Headphones: you can talk over it. A call lasts up to 20 minutes, one at a time.",
      V.form(`${BASE}/live-audio`, csrf, V.seg("duplex", [["speakers", "Speakers"], ["full", "Headphones"]], a.duplex === "full" ? "full" : "speakers")),
      { scope: "default · each browser can switch", id: "v-live-audio" }
    ) +
      V.more(
        "More: noise reduction",
        V.row(
          "Noise reduction",
          "OpenAI's filter on the microphone.",
          V.form(`${BASE}/live-audio`, csrf, `<select name="noise" aria-label="Noise reduction">${NOISE.map(([v, l]) => V.opt(v, l, a.noise || "far_field")).join("")}</select>`),
          { scope: "everyone", id: "v-noise" }
        )
      )
  );

  const dialog = `<section class="cc-modal os narrow" id="m-voice-token" role="dialog" aria-modal="true" aria-labelledby="m-voice-token-t" hidden>
    <div class="cc-mh">${icon("lock", 18)}<div class="cc-min0"><h2 id="m-voice-token-t">${set ? "Replace the OpenAI key" : "Add the OpenAI key"}</h2><small>A project key limited to the Realtime and Audio endpoints is enough.</small></div>
      <span class="cc-sp"><button type="button" class="cc-ibtn" data-modal-close aria-label="Close">${icon("close", 16)}</button></span></div>
    <form method="post" action="${BASE}/key" autocomplete="off" id="voice-key-form">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <div class="mb"><label>OpenAI API key <span class="hint">Saved in a file only root can read, and never shown again.</span>
        <input name="value" type="password" placeholder="sk-proj-…" required autocomplete="new-password" spellcheck="false" minlength="20"></label></div>
      <div class="mf"><span class="sp"></span><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn primary" type="submit" id="voice-key-save">Save key</button></div>
    </form></section>`;

  return (
    V.head("Voice", "Talk with JOYA AI in a live call. You speak, it answers at once, and you can interrupt it. One switch turns voice on or off for everyone.") +
    main +
    hiddenNote +
    `<div class="dep-hide">${voiceGroup}${voiceprintGroup(o)}${liveGroup}</div>` +
    dialog
  );
}

module.exports = { body, voiceCard, voiceprintGroup, GENDER, BASE };
