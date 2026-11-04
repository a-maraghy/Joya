"use strict";
/**
 * Enrol your voiceprint (/joya-ai/voiceprint/enrol; lib/voiceprint-routes.js):
 * pick the microphone, read four short paragraphs aloud, save. Each recording
 * is turned into numbers on this server as it arrives and then thrown away;
 * only the voiceprint is kept, sealed. No inline script or style:
 * public/voiceprint-enrol.js, and the trial page's stylesheet.
 */
const { esc, shell, card, icon } = require("./ui");

function page({ csrf, user, person, isMe, paragraphs, slots, worklet, enabled, minSeconds }) {
  const have = (person && person.mics) || {};
  const who = person ? person.name : "";
  const slotOpts = slots.map((s, i) => `<option value="${esc(s.id)}"${i === 0 ? " selected" : ""}>${esc(s.label)}${have[s.id] ? " — enrolled (redo)" : ""}</option>`).join("");
  const rows = paragraphs
    .map(
      (p) => `<li class="vp-row" data-id="${esc(p.id)}" data-part="enrol" data-max="40">
      <span class="vp-n">${esc(p.id.replace("e", ""))}</span>
      <span class="vp-text" dir="auto" lang="${p.lang === "en" ? "en" : "ar"}">${esc(p.text)}</span>
      <span class="vp-kind">${esc(p.lang === "ar" ? "Egyptian" : p.lang === "en" ? "English" : "mixed")}</span>
      <span class="vp-ctl"><button type="button" class="btn small vp-rec" data-rec="${esc(p.id)}"${enabled ? "" : " disabled"}>Record</button><span class="vp-state muted small" data-state="${esc(p.id)}" aria-live="polite">not recorded</span></span>
    </li>`
    )
    .join("");
  const off = enabled
    ? ""
    : `<div class="alert bad" id="vpe-off">${icon("alert")}<div>The voiceprint is off. Switch it on in <a href="/joya-ai/settings/voice#v-voiceprint">Settings ▸ Voice</a> first.</div></div>`;
  const consent = isMe
    ? ""
    : `<div class="alert warn" id="vpe-consent">${icon("alert")}<div><strong>Only record someone who agreed to it.</strong> ${esc(who)} reads the paragraphs at this computer's microphone; tell them what it is for and that you can delete it any time.</div></div>`;
  const body = `<div id="vpe" data-csrf="${esc(csrf)}" data-worklet="${esc(worklet)}" data-need="${Number(minSeconds) || 30}" data-person="${esc(person ? person.id : "")}">
${off}
${consent}
${card(
  isMe ? `Your voiceprint (${who})` : `${who}'s voiceprint`,
  `<p>JOYA AI learns what ${isMe ? "your" : esc(who) + "'s"} voice sounds like from about a minute of reading aloud, so in a live call it can tell who is speaking — and address them by name — apart from people it does not know, a TV, or its own voice coming back through the speakers.</p>
   <ul class="vp-facts">
     <li>${icon("lock", 14)} Each recording is turned into numbers on this server and then deleted. Only the voiceprint is kept, sealed with a key only the server's root can use. Nothing is sent to OpenAI or anyone else.</li>
     <li>${icon("voice", 14)} One microphone at a time. Enrolling a second one (laptop and headset) makes it surer on both.</li>
     <li>${icon("shield", 14)} A voice identifies; it never authorises. Approvals still need the signed-in user's ${require("./signin").passwordOnly ? "password" : "Windows Hello (or authenticator code)"}.</li>
     <li>${icon("trash", 14)} Remove a microphone or delete the voiceprint in Settings ▸ Voice ▸ Voiceprint.</li>
   </ul>`,
  { icon: "fingerprint", id: "vpe-why" }
)}
${card(
  "1. The microphone",
  `<div class="vp-mic">
     <label class="vp-field"><span class="small">This voiceprint is for</span><select id="vp-slot">${slotOpts}</select></label>
     <label class="vp-field"><span class="small">Microphone</span><select id="vp-device"><option value="">The browser's default microphone</option></select></label>
     <button type="button" class="btn small" id="vp-allow">${icon("voice", 14)} Allow the microphone</button>
   </div>
   <p class="muted small" id="vp-mic-note">The microphone names appear once the browser may use the microphone.</p>
   <div class="vp-meter" aria-hidden="true"><span id="vp-level"></span></div>`,
  { icon: "voice", id: "vpe-mic" }
)}
${card(
  "2. Read these aloud",
  `<p class="muted small">Press Record, read at your normal pace, press Stop. Mistakes do not matter. ${Number(minSeconds) || 30} seconds of speech are needed; all four give about a minute.</p>
   <ol class="vp-list">${rows}</ol>
   <p class="btn-row"><button type="button" class="btn primary small" id="vpe-save" disabled>${icon("save", 14)} ${isMe ? "Save my voiceprint" : "Save " + esc(who) + "'s voiceprint"}</button><span class="small" id="vpe-total" aria-live="polite">0 s of speech</span></p>
   <p class="small" id="vpe-done" aria-live="polite"></p>`,
  { icon: "file", id: "vpe-read" }
)}
</div>`;
  return shell(isMe ? "Enrol your voiceprint" : "Enrol a voiceprint", body, {
    user,
    csrf,
    active: "joya-ai",
    subtitle: `${who}: about two minutes, four short paragraphs read aloud`,
    assets: ["voiceprint-enrol.css", "voiceprint-enrol.js"],
    crumbs: [["JOYA AI", "/joya-ai"], ["Settings", "/joya-ai/settings/voice#v-vp-people"], [who || "Voiceprint", null]],
  });
}

module.exports = { page };
