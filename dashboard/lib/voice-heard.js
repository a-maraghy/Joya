"use strict";
/**
 * Which of a live turn's transcripts goes to JOYA AI (lib/voice-live.js
 * groundedText), and what JOYA AI is told when the words may be misheard.
 *
 * Why (2026-10-22, the administrator: "the voice API understands me, but when
 * it passes to JOYA AI it does not pass the right words"). Every live turn is
 * written down twice by this server's own transcription models: the full-turn
 * transcript (the relayed audio, with the vocabulary prompt) and the live
 * session's own input transcription. Until now the hand-off took the
 * full-turn one whenever it passed the transcript guard. The voice-usage
 * ledger shows the two disagreeing on exactly the turns that reached JOYA AI
 * wrong (output tokens, full-turn vs session): request 377 8 vs 20 («أريد أن
 * أعود.»), 378 9 vs 23 («إلا إحنا نناقص»), 379 15 vs 22, 380 8 vs 18 («La parte
 * más vital es difícil»), 381 4 vs 9 («context:»); on the good turn after them,
 * 28 vs 24. With the language on "auto", the transcription models write short
 * Egyptian Arabic in another language: replaying the administrator's own
 * voiceprint-trial clips (34, Egyptian Arabic, English and mixed) through the
 * full-turn settings gave Georgian, Greek, Danish-looking and Latin-letter
 * Arabic for 5 to 7 of the 19 Arabic clips per run («اقفل المكالمة» → «Έλα
 * φίλε μου, κάλμα.», «نعم» → «Naam.», «الديسك مليان قد إيه» → «Didskemelian
 * ad»). No single prompt or pinned language fixed it without breaking the
 * English turns (measured the same day).
 *
 * So, per turn, all pure here:
 *
 *   assess()   is a transcript plausible for this administrator, who speaks
 *              Egyptian Arabic and English? "wrong-language": letters in a
 *              script that is neither Arabic nor Latin, or Latin text that is
 *              not English (accented letters, other languages' function
 *              words, or too few English words); "short": far fewer letters
 *              than the turn's measured speech could hold; else "good".
 *   choose()   the best of the candidates (good > short > wrong-language; the
 *              full-turn transcript first among equals unless another is
 *              clearly longer), and another server transcript that says
 *              something materially different (JOYA AI sees both).
 *   retryLanguage()  when no candidate is good, the language to transcribe
 *              the same audio again with, pinned: the language the live voice
 *              understood the turn in, else Arabic (the language these models
 *              mislabel; English is recognised reliably).
 *   noteFor()  the line appended to the hand-off: the other transcript and,
 *              only when no transcript is good, what the live voice
 *              understood -- each marked as such, never as the
 *              administrator's words.
 *
 * What stays as it was: a hand-off needs a transcript this server produced
 * that passed the transcript guard (grounding) -- the voice model's own text
 * is never the request, only a marked note beside a grounded one, and only
 * when every transcript looks wrong.
 */

const fs = require("fs");
const arabic = require("./voice-arabic");

/* ------------------------------------------------------------ English -- */

// English words common in what the administrator says to JOYA AI, the
// function words, and the names the vocabulary prompt carries. The system's
// word list (/usr/share/dict/words, when there is one) is added to it.
const COMMON = `a about above after again against all also am an and any are as ask at back be because been before being below
between both but by can cancel check claude close come could day did do does doing done down dashboard during each else
error everything fail failed few find fine first for from full get give go going good got had has have having he her here
him his how i if in into is it its just keep know last let like list look make me joya joya more most my need new next
no not now odoo of off ok okay on once one only open or other our out over please pmo put read ready really restart right
run running say see send server service should show so some start status still stop such sure take tell than thank thanks
that the their them then there these they thing this those through time to today too try turn up us use vps wait want was
we well were what when where which while who why will with would yes yesterday you your giza agents agent sub session
sessions disk memory logs log deploy update allocation engine planning purchase plan order orders approve approval mission
missions telegram backup backups problem solve improve trust happening completely listen listening hear speak talk call
report page pages percent number numbers kilos week month morning tonight tomorrow`.split(/\s+/);
// Function words of the languages these models drift into (Spanish, Portuguese, Italian, French, German, Dutch,
// the Scandinavian ones), without those that are also English words or fillers ("a", "an", "in", "is", "die",
// "con", "son", "per", "non", "met", "med", "den", "til", "ma", "pa", "er", "um", "os", ...).
const FOREIGN = new Set(
  `el la los las del es esta está estas este eso y que por para una uno unos unas pero muy más mas como
   ou não nao uma também tambem é mais isso aqui
   il gli della di che sono questo questa anche ciao
   le les et est une des du je tu nous vous pas avec mais sur dans ce cette qui oui
   der das und ist nicht ein eine ich wir sie mit auf für auch noch
   het een niet ik je wij voor ook
   og det ikke jeg af på som lille`.split(/\s+/).filter(Boolean)
);
// Latin letters English does not use (é, ñ, ø, å, ß, ...): a transcript with them is not English.
const NON_ENGLISH_LETTER = /[À-ÖØ-öø-ɏ\u0300-\u036f]/u;

let dictCache = null;
function systemDict(file) {
  if (dictCache && dictCache.file === file) return dictCache.set;
  const set = new Set();
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const w = line.trim().toLowerCase().replace(/'/g, ""); // "don't" -> "dont", as the transcript's words are read
      if (/^[a-z]+$/.test(w)) set.add(w);
    }
  } catch (_) {
    /* no word list: COMMON alone */
  }
  dictCache = { file, set };
  return set;
}
const COMMON_SET = new Set(COMMON.filter(Boolean));
function isEnglishWord(w, dict) {
  return COMMON_SET.has(w) || (dict && dict.has(w)) || /^\d+$/.test(w);
}

/* -------------------------------------------------------------- assess -- */

const SHORT_LETTERS_PER_S = 3; // speech that fast writes 10-15 letters a second; under 3 is a transcript that lost words
const SHORT_MIN_SPEECH_MS = 2000; // a shorter turn may really be one word ("لأ", "yes")

function lettersOf(text) {
  return (arabic.normalize(String(text || "")).match(/[\p{L}\p{N}]/gu) || []).length; // "41%" is something said
}

/**
 * Is `text` plausibly what this administrator said?
 * o: { speechMs (measured speech in the turn, ms), dict (a Set of English words; default: COMMON + the system's list),
 *      dictFile }
 * -> { quality: "good" | "short" | "wrong-language" | "empty", lang: "ar" | "en" | "foreign" | "other" | "", why, letters }
 */
function assess(text, o) {
  const c = o || {};
  const s = String(text || "").normalize("NFC").trim(); // "ä" may arrive as "a" + a combining mark
  const letters = lettersOf(s);
  if (!letters) return { quality: "empty", lang: "", why: "no words", letters: 0 };
  const sc = arabic.scriptOf(s);
  const all = sc.arabic + sc.latin + sc.other;
  let lang;
  let why = "";
  if (sc.other / all > 0.15) {
    lang = "other";
    why = "letters that are neither Arabic nor Latin";
  } else if (sc.arabic / all >= 0.3) lang = "ar";
  else {
    const dict = c.dict !== undefined ? c.dict : systemDict(c.dictFile || process.env.JOYA_WORDS || "/usr/share/dict/words");
    const words = (s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).map((w) => w.replace(/'s$|'/g, "")).filter(Boolean);
    const latinWords = words.filter((w) => /\p{Script=Latin}/u.test(w) || /^\d+$/.test(w));
    const marked = latinWords.filter((w) => NON_ENGLISH_LETTER.test(w)).length;
    const foreign = latinWords.filter((w) => FOREIGN.has(w)).length;
    const english = latinWords.filter((w) => !NON_ENGLISH_LETTER.test(w) && isEnglishWord(w, dict)).length;
    if (marked) {
      lang = "foreign";
      why = "letters English does not use";
    } else if (foreign && foreign >= english) {
      lang = "foreign";
      why = "another language's words";
    } else if (!english || english / latinWords.length < 0.6) {
      lang = "foreign";
      why = "too few English words";
    } else lang = "en";
  }
  if (lang === "other" || lang === "foreign") return { quality: "wrong-language", lang, why, letters };
  const speechMs = Number(c.speechMs) || 0;
  if (speechMs >= SHORT_MIN_SPEECH_MS && letters / (speechMs / 1000) < SHORT_LETTERS_PER_S) {
    return { quality: "short", lang, why: `${letters} letters for ${Math.round(speechMs / 100) / 10} s of speech`, letters };
  }
  return { quality: "good", lang, why: "", letters };
}

/* ------------------------------------------------------------- compare -- */

const norm = (s) => arabic.normalize(String(s || "")).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** Character similarity of two transcripts, 0..1 (1 - edit distance / the longer one). */
function similarity(a, b) {
  const x = [...norm(a)];
  const y = [...norm(b)];
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}
/**
 * Does `other` say something `pick` does not? Not a near copy, not a cut-short part of it. `below`: the
 * similarity under which it differs (0.5 beside a good transcript: "12,000" against "twelve thousand" is not
 * worth a note; 0.7 beside a doubtful one).
 */
function differs(pick, other, below) {
  const p = norm(pick);
  const q = norm(other);
  if (!q || p.includes(q)) return false;
  return similarity(pick, other) < (below || 0.7);
}

const RANK = { good: 0, short: 1, "wrong-language": 2, empty: 3 };
const LONGER = 1.3; // a candidate this much longer (in letters), at the same quality, is the more complete one

/**
 * cands: [{ source: "turn" | "session" | "retry-ar" | ..., text }] in order of preference.
 * o: as for assess().
 * -> { pick: {source, text, a}, also: {source, text, a} | null, all: [...] } or null when none has words.
 */
function choose(cands, o) {
  const all = (cands || [])
    .filter((c) => c && String(c.text || "").trim())
    .map((c, i) => ({ source: c.source, text: String(c.text).trim(), i, a: assess(c.text, o) }))
    .filter((c) => c.a.quality !== "empty");
  if (!all.length) return null;
  const sorted = [...all].sort((x, y) => {
    const r = RANK[x.a.quality] - RANK[y.a.quality];
    if (r) return r;
    if (x.a.letters >= y.a.letters * LONGER) return -1;
    if (y.a.letters >= x.a.letters * LONGER) return 1;
    return x.i - y.i;
  });
  const pick = sorted[0];
  const below = pick.a.quality === "good" ? 0.5 : 0.7;
  const also = sorted.slice(1).find((c) => c.a.quality !== "wrong-language" && differs(pick.text, c.text, below)) || null;
  return { pick, also, all };
}

/**
 * No candidate is good: the language to transcribe the same audio again in. The live voice's own
 * understanding of the turn decides when it has one (it hears the audio in either language reliably);
 * otherwise Arabic, unless every candidate is short English (then English).
 */
function retryLanguage(choice, voiceText) {
  if (!choice || choice.pick.a.quality === "good") return null;
  const v = String(voiceText || "").trim();
  if (v && lettersOf(v)) {
    const sc = arabic.scriptOf(v);
    if (sc.arabic >= sc.latin && sc.arabic > 0) return "ar";
    if (sc.latin > 0 && sc.other === 0) return "en";
  }
  if (choice.all.every((c) => c.a.lang === "en")) return "en";
  return "ar";
}

const MAX_NOTE_TEXT = 400;
const clip = (s) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > MAX_NOTE_TEXT ? t.slice(0, MAX_NOTE_TEXT) + "…" : t;
};

/**
 * The note JOYA AI gets after the request, or "" when the transcript is good and the other agrees.
 * voiceText: what the live voice understood (its look_into text); shown only when no transcript is good.
 */
function noteFor(choice, voiceText) {
  if (!choice) return "";
  const good = choice.pick.a.quality === "good";
  const parts = [];
  if (choice.also) parts.push(`Another transcription of the same audio: «${clip(choice.also.text)}».`);
  const v = clip(voiceText);
  if (!good && v && differs(choice.pick.text, v) && (!choice.also || differs(choice.also.text, v))) parts.push(`The live voice understood it as: «${v}» (its own wording, not theirs).`);
  if (good && !parts.length) return "";
  const lead = good
    ? "[Voice: the two transcriptions of this turn disagree; the administrator speaks Egyptian Arabic and English."
    : "[Voice: speech-to-text may have misheard this turn (the administrator speaks Egyptian Arabic and English; this transcript looks " +
      (choice.pick.a.quality === "short" ? "cut short" : "like the wrong language") +
      ").";
  return [lead, ...parts, "Go by what they most likely said; if it is still unclear, ask them in one short line.]"].join(" ");
}

module.exports = { assess, choose, retryLanguage, noteFor, similarity, differs, COMMON, FOREIGN, SHORT_LETTERS_PER_S, SHORT_MIN_SPEECH_MS };
