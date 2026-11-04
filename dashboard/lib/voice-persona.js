"use strict";
/**
 * How the voice speaks to one administrator, learned from how they speak to it
 * (the administrator's decision, 2026-09-29: "replies in my language and saves
 * the persona based on how I speak"). There is no free-text persona: only what
 * is read from the administrator's own words.
 *
 *   language   per utterance, never saved: the reply is in the language of the
 *              LAST utterance (English → English; Arabic or mixed → Arabic,
 *              technical terms in Latin script)
 *   dialect    "egyptian" | "msa": the Arabic register the administrator uses
 *   gender     "f" | "m": the grammatical gender the administrator uses when
 *              addressing the voice («تقدميني», «إنتِ مصرية» → feminine;
 *              «إنتَ», «إنت مصري» → masculine). The voice then uses that gender
 *              for itself. Unknown → gender-neutral phrasing.
 *
 * dialect and gender are saved per user (users.voice_persona, JSON) and change
 * only when an utterance CLEARLY shows a change: a dialect needs at least two
 * markers of one register and none of the other (or three times as many); a
 * gender needs an unambiguous form of address and none of the other gender.
 * The voice is always JOYA AI's voice and never claims to be human, whatever
 * is saved.
 *
 * Pure: no I/O. The panel stores the JSON (lib/db.js) and audits each change.
 */

const arabic = require("./voice-arabic");

const set = (s) => new Set(s.split(/\s+/).filter(Boolean).map(arabic.normalize));

// Words that mark a register. Normalized spellings (ة → ه, أ → ا, ى → ي).
const EGYPTIAN = set(
  "عايز عاوز عايزه عاوزه عايزك عاوزك ازيك ازايك ده دي دول ايه ازاي فين امتي امته مش مفيش مافيش بتاع بتاعت بتاعه دلوقتي دلوقت كده كدا بص طب اللي علشان عشان " +
    "خالص قوي اوي برضه برضو لسه ليه ماشي اوكي خلاص حاجه حاجات بقي بقا يلا ياريت اهو اهي ازاي عامل عامله شويه تاني ابقي"
);
const MSA = set(
  "هل ماذا لماذا كيف اريد نريد اود الان ذلك تلك هذا هذه هؤلاء ليس ليست سوف لقد قم قومي يرجي رجاء اين متي لدي لديك لديه الذي التي الذين حيث ايضا جدا " +
    "هناك هنا هو هي هم بالتاكيد نعم سيتم اخبرني اخبريني اعطني عندما لكي كي"
);

// Being addressed as a woman / as a man. Checked on the raw text (a kasra or a
// fatha on انت decides it) and on normalized words.
const ADDRESS_F_RAW = /(?:^|[^\p{L}])[إا]نتِ(?![\p{L}])|(?:^|[^\p{L}])[إا]نتي(?![\p{L}])/u;
const ADDRESS_M_RAW = /(?:^|[^\p{L}])[إا]نتَ(?![\p{L}])/u;
const VOCATIVE_F = set("ست هانم حبيبتي حلوه جميله ستي مدام انسه");
const VOCATIVE_M = set("عم باشا معلم صاحبي حبيبي ريس باشمهندس استاذ برنس");
// Adjectives and participles said of "you": masculine form, and its feminine with ـه.
const YOU_ADJ = set("عارف فاهم سامع جاهز شاطر متاكد مستعد صاحي موجود فاكر قادر مركز معايا مبسوط زعلان تعبان");
const YOU = set("انت انتي انك انتو");

/** Words of a normalized text. */
function words(text) {
  return arabic.wordsOf(arabic.normalize(String(text || "")).toLowerCase()).map((x) => x.w);
}

/**
 * Is this word a second-person FEMININE verb with an object: «تقدميني»,
 * «تعمليلي», «هتقوليلي», «اسمعيني», «قوليلي»? (A masculine one has no ي
 * before the suffix: تقدمني، قولّي.) Words starting with ال are nouns.
 */
function feminineVerb(w) {
  if (/^ال/.test(w) || w.length < 6) return false;
  // تقدميني، تعمليلي، هتقوليلي، بتسمعيني، تعمليه
  if (/^(?:[وف])?(?:[هحب])?ت\p{L}{2,}ي(?:ني|لي|لنا|ه|ها|هم)$/u.test(w)) return true;
  // the imperative: اسمعيني، قوليلي، شوفيلي
  return /^(?:[وف])?\p{L}{2,}ي(?:ني|لي|لنا)$/u.test(w);
}

/**
 * What one utterance shows: { lang, dialect, gender, markers }.
 * dialect and gender are null unless the utterance is clear about them.
 */
function detect(text) {
  const raw = String(text || "");
  const lang = arabic.isArabic(raw) ? "ar" : "en";
  const out = { lang, dialect: null, gender: null, markers: { egyptian: 0, msa: 0, f: 0, m: 0 } };
  if (!arabic.hasArabic(raw)) return out;
  const ws = words(raw);
  const mk = out.markers;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const bare = /^[وف]/.test(w) && w.length > 3 ? w.slice(1) : w;
    if (EGYPTIAN.has(w) || EGYPTIAN.has(bare)) mk.egyptian++;
    else if (MSA.has(w) || MSA.has(bare)) mk.msa++;
    // Egyptian future ه + verb (هعمل، هتقولي، هنشوف).
    else if (/^ه(?:ت|ي|ن)?\p{L}{3,}$/u.test(w)) mk.egyptian++;
    // The address.
    if (feminineVerb(w)) mk.f++;
    if (w === "يا" && ws[i + 1]) {
      if (VOCATIVE_F.has(ws[i + 1])) mk.f++;
      else if (VOCATIVE_M.has(ws[i + 1])) mk.m++;
    }
    if (YOU.has(w) && ws[i + 1]) {
      const n = ws[i + 1];
      const adjF = n.endsWith("ه") && YOU_ADJ.has(n.slice(0, -1));
      const nisbaF = /\p{L}{2,}يه$/u.test(n) && !/^ال/.test(n);
      const adjM = YOU_ADJ.has(n);
      // (not «سامعاني»: a feminine participle with "me")
      const nisbaM = /\p{L}{2,}ي$/u.test(n) && !/ني$/.test(n) && !/^ال/.test(n) && n.length >= 4;
      if (adjF || nisbaF) mk.f++;
      else if (w !== "انتي" && !ADDRESS_F_RAW.test(raw) && (adjM || nisbaM)) mk.m++;
    }
  }
  if (ADDRESS_F_RAW.test(raw)) mk.f++;
  if (ADDRESS_M_RAW.test(raw)) mk.m++;
  const clear = (a, b) => (a >= 2 && b === 0) || (a >= 3 && a >= 3 * b);
  if (clear(mk.egyptian, mk.msa)) out.dialect = "egyptian";
  else if (clear(mk.msa, mk.egyptian)) out.dialect = "msa";
  if (mk.f > 0 && mk.m === 0) out.gender = "f";
  else if (mk.m > 0 && mk.f === 0) out.gender = "m";
  return out;
}

/**
 * The persona can also be CHOSEN (the administrator's request of 2026-09-29:
 * «بنت عربية مصرية من القاهرة», "an Egyptian Arab girl from Cairo"), in
 * Settings > OpenAI voice > Voice persona only -- never by speech. A choice is
 * {mode: "explicit", preset}; learning never overrides it, and Reset goes back
 * to learning. The presets, and nothing else (no free text):
 */
const PRESETS = Object.freeze({
  cairene_f: Object.freeze({ dialect: "egyptian", gender: "f", cairene: true, label: "Cairene Egyptian — feminine" }),
  cairene_m: Object.freeze({ dialect: "egyptian", gender: "m", cairene: true, label: "Cairene Egyptian — masculine" }),
  msa_n: Object.freeze({ dialect: "msa", gender: null, cairene: false, label: "Modern Standard Arabic — neutral" }),
});
const LEARNED_LABEL = "Learn from how I speak";

/** A saved persona, cleaned: only known values survive. */
function clean(v) {
  let o = v;
  if (typeof o === "string") {
    try {
      o = o ? JSON.parse(o) : {};
    } catch (_) {
      o = {};
    }
  }
  o = o && typeof o === "object" ? o : {};
  const at = typeof o.updated_at === "string" ? o.updated_at.slice(0, 40) : null;
  if (o.mode === "explicit" && Object.prototype.hasOwnProperty.call(PRESETS, o.preset)) {
    const p = PRESETS[o.preset];
    return { mode: "explicit", preset: o.preset, dialect: p.dialect, gender: p.gender, updated_at: at };
  }
  return {
    mode: "learned",
    preset: null,
    dialect: o.dialect === "egyptian" || o.dialect === "msa" ? o.dialect : null,
    gender: o.gender === "f" || o.gender === "m" ? o.gender : null,
    updated_at: at,
  };
}

/** The persona for a Settings choice ("learned" or a preset), or null if unknown. */
function choose(preset, nowIso) {
  if (preset === "learned") return { mode: "learned", preset: null, dialect: null, gender: null, updated_at: nowIso || new Date().toISOString() };
  if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) return null;
  const p = PRESETS[preset];
  return { mode: "explicit", preset, dialect: p.dialect, gender: p.gender, updated_at: nowIso || new Date().toISOString() };
}

/**
 * The saved persona after one utterance: { persona, changed: [field...] }.
 * Only a clear signal (detect) moves a field; nothing is ever cleared here.
 * A chosen persona is never changed by speech.
 */
function merge(saved, detected, nowIso) {
  const p = clean(saved);
  if (p.mode === "explicit") return { persona: p, changed: [] };
  const d = detected || {};
  const changed = [];
  if (d.dialect && d.dialect !== p.dialect) {
    p.dialect = d.dialect;
    changed.push("dialect");
  }
  if (d.gender && d.gender !== p.gender) {
    p.gender = d.gender;
    changed.push("gender");
  }
  if (changed.length) p.updated_at = nowIso || new Date().toISOString();
  return { persona: p, changed };
}

const DIALECT_LABEL = { egyptian: "Egyptian colloquial", msa: "Modern Standard Arabic" };
const GENDER_LABEL = { f: "feminine", m: "masculine" };

/** For Settings and the audit log. */
function describe(p) {
  const c = clean(p);
  const chosen = c.mode === "explicit" ? PRESETS[c.preset] : null;
  return {
    mode: c.mode,
    preset: c.preset,
    choice: chosen ? chosen.label : LEARNED_LABEL,
    dialect: chosen && chosen.cairene ? "Cairene Egyptian (Cairo colloquial)" : c.dialect ? DIALECT_LABEL[c.dialect] : "not known yet",
    gender: c.gender ? GENDER_LABEL[c.gender] : c.mode === "explicit" ? "gender-neutral" : "not known yet (gender-neutral)",
    updated_at: c.updated_at,
  };
}

/** The register and self-gender sentences, shared by the desk's and the live instructions. */
function registerLine(dialect, p, live) {
  if (p.mode === "explicit" && PRESETS[p.preset].cairene)
    return "answer in Cairo colloquial Egyptian Arabic (as spoken in Cairo, never Modern Standard Arabic), in the voice of a Cairene " + (p.gender === "f" ? "woman" : "man");
  if (p.mode === "explicit") return "answer in Modern Standard Arabic";
  if (dialect === "msa") return live ? "they usually speak Modern Standard Arabic, so answer in MSA" : "answer in Modern Standard Arabic, as they speak it";
  if (dialect === "egyptian") return live ? "they usually speak Egyptian colloquial Arabic, so answer in Egyptian (not Modern Standard Arabic)" : "answer in Egyptian colloquial Arabic (not Modern Standard Arabic), as they speak it";
  return live ? "answer in the same register they use (Egyptian colloquial or Modern Standard Arabic)" : "answer in Arabic, in the same register they used (Egyptian colloquial if they spoke Egyptian, Modern Standard Arabic if they spoke MSA)";
}
function genderLine(p) {
  const why = p.mode === "explicit" ? "The administrator chose this persona" : null;
  if (p.gender === "f") return (why || "They address you in the feminine") + ", so use feminine forms for yourself (أنا جاهزة، متأكدة، هبعتلك، حاضر).";
  if (p.gender === "m") return (why || "They address you in the masculine") + ", so use masculine forms for yourself (أنا جاهز، متأكد، هبعتلك).";
  return (p.mode === "explicit" ? "Use" : "Their form of address does not show a gender: use") + " gender-neutral phrasing for yourself (تحت أمرك، ثواني وهسأل JOYA AI), not gendered adjectives.";
}

/**
 * The instruction line for one response: the language of the last utterance,
 * and for Arabic the register and the voice's own gender. `turn` is detect()
 * of this utterance (its clear dialect wins for this reply, unless a persona
 * was chosen), `saved` the merged persona.
 */
function noteFor(turn, saved) {
  const t = turn || { lang: "en" };
  if (t.lang !== "ar") return "The administrator's last utterance was in English: answer in plain English.";
  const p = clean(saved);
  const dialect = p.mode === "explicit" ? p.dialect : t.dialect || p.dialect;
  return (
    "The administrator's last utterance was in Arabic: " +
    registerLine(dialect, p, false) +
    ", with a warm manner, keeping technical terms and units in English in Latin script (Odoo, disk, restart, dashboard, GB). " +
    genderLine(p) +
    " JOYA AI is \"he\" (ردّه). You are JOYA AI's voice, never a person: never claim to be human."
  );
}

/**
 * The same rule for the live conversation (lib/voice-live.js), where the
 * model hears the audio and answers before any transcript exists: one standing
 * line in the session's instructions, refreshed when the saved persona changes.
 */
function liveNote(saved) {
  const p = clean(saved);
  return (
    "Language: always reply in the language the administrator has just spoken. English gets plain English. Arabic, or Arabic mixed with English: " +
    registerLine(p.dialect, p, true) +
    ", keeping technical terms and units in English (Odoo, disk, restart, dashboard, GB). " +
    genderLine(p) +
    " JOYA AI is \"he\". You are JOYA AI's voice, never a person: never claim to be human."
  );
}

/**
 * What the voice says after it asks for a Tier-2 confirm (theme, persona,
 * voice): that it waits -- never "or say yes", which its own speaker would
 * then play back into the microphone as a "yes". The Arabic follows the
 * voice's own gender (مستنية / مستني), neutral in formal Arabic or when unknown.
 */
function waitingLine(persona) {
  const p = persona || {};
  const ar = p.dialect === "msa" || !p.gender ? "في انتظار تأكيدك." : p.gender === "f" ? "مستنية تأكيدك." : "مستني تأكيدك.";
  return { en: "Waiting for your confirmation.", ar };
}
/** The same, when a confirm ran out: said once, briefly. */
function expiredLine(persona) {
  const p = persona || {};
  const ar = p.dialect === "msa" ? "انتهت مهلة التأكيد، ولم يتغيّر شيء." : "التأكيد خلص وقته، ومفيش حاجة اتغيّرت.";
  return { en: "The confirmation timed out; nothing changed.", ar };
}

module.exports = { waitingLine, expiredLine, PRESETS, LEARNED_LABEL, choose, liveNote, detect, clean, merge, describe, noteFor, feminineVerb, EGYPTIAN, MSA, DIALECT_LABEL, GENDER_LABEL };
