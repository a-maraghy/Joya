"use strict";
/**
 * The one transcription model: gpt-4o-transcribe (the administrator,
 * 2026-10-30: "make the gpt 4o transcribe be used with gpt realtime mini 2.1.
 * remove all other models, and remove the transcription section from the
 * settings").
 *
 * Where it is used. Only with the realtime voice model (gpt-realtime-2.1-mini,
 * lib/voice-live.js): it writes down the FULL turn this server relayed -- the
 * text a hand-off to JOYA AI is grounded on (transcribeTurn) -- and it is the
 * live session's own input transcription model too (sessionModelFor; OpenAI
 * accepts its own transcription models inside a realtime session, and this one
 * is known to work there). GPT-Live calls (lib/voice-gptlive.js) use no
 * transcription model at all since 2026-10-30: GPT-Live's own input
 * transcript is the request text (measured on the real calls of 2026-10-29: it
 * read better than the full-turn transcript -- English 0 vs 1.5 % word
 * errors, Arabic 0 vs 2 meaning errors -- and two requests GPT-Live had
 * understood were lost as "ungrounded" waiting for the other one).
 *
 * The list was a Settings choice from 2026-09-30 to 2026-10-30
 * (gpt-4o-mini-transcribe, gpt-transcribe, gpt-4o-transcribe, and whisper.cpp
 * on this server until 2026-10-25). It is one entry now; TRANSCRIBERS stays a
 * list so a later model is one entry again. A stored choice naming any other
 * model, or a language, just reads as gpt-4o-transcribe with no language
 * (clean): nothing errors, nothing is offered. The helper's local
 * whisper-server commands (voice-whisper-*) and its unit are left installed but
 * unused; nothing here starts them.
 *
 * Language: none is sent (the model detects it; Egyptian Arabic and English
 * mixed in one sentence read right that way). Only a live call's second try,
 * when no transcript of a turn read right, pins one ("ar" / "en":
 * LiveCall.groundedText through cfg.transcribe_language).
 *
 * Price: $0.006 a minute (lib/voice-usage.js prices it, and keeps the retired
 * models' prices so older rows still add up).
 */

const voice = require("./voice");

const MODEL = "gpt-4o-transcribe";
const DEFAULT_ID = MODEL;
const FALLBACK_MODEL = MODEL; // kept for callers that name it in a log line

/*
 * id     what a stored setting names
 * model  the OpenAI model id
 * live   may be the live session's own transcription model
 */
const TRANSCRIBERS = Object.freeze([
  Object.freeze({ id: MODEL, kind: "openai", model: MODEL, label: "GPT-4o Transcribe", hint: "$0.006/min", live: true }),
]);

function byId(id) {
  return TRANSCRIBERS.find((t) => t.id === id) || null;
}
/** A stored choice, cleaned: whatever it named, it reads as the one model and no pinned language. */
function clean() {
  return { model: DEFAULT_ID, language: "auto" };
}
/** The live session's own transcription model. */
function sessionModelFor() {
  return MODEL;
}
/** How long a live hand-off waits for the full-turn transcript beyond the usual: nothing extra (an OpenAI model). */
function heardWaitMs() {
  return null;
}

/**
 * voice.transcribeFull with the one model. cfg.transcribe_language "ar" or
 * "en" pins the language for this one call (a live call's second try).
 * Resolves {text, model, usage, tokens, transcriber, ms}.
 */
async function transcribeFull(audio, cfg, mime) {
  const c = cfg || {};
  const language = c.transcribe_language === "ar" || c.transcribe_language === "en" ? c.transcribe_language : null;
  const t0 = Date.now();
  const out = await voice.transcribeFull(audio, { ...c, transcribe_model: MODEL, transcribe_language: language }, mime);
  return { ...out, transcriber: MODEL, ms: Date.now() - t0 };
}

module.exports = {
  TRANSCRIBERS,
  MODEL,
  DEFAULT_ID,
  FALLBACK_MODEL,
  byId,
  clean,
  sessionModelFor,
  heardWaitMs,
  transcribeFull,
};
