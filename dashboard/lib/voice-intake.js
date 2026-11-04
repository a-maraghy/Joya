"use strict";
/**
 * A recording in, what was said out -- or nothing. Used by the console's
 * dictation (/console/:id/transcribe); until 2026-09-30 also by the Command
 * Center's push to talk and the front desk, both removed (voice is live
 * conversation only, and the live call has its own guards in
 * lib/voice-live.js). See lib/voice-guard.js for why.
 *
 *   before OpenAI: a clip smaller than MIN_AUDIO_BYTES is not speech (a webm
 *                  header and a few frames); a clip the page measured as
 *                  shorter than MIN_SPEECH_MS, or with less than MIN_LOUD_MS
 *                  above its speech threshold, is not sent at all (nothing is
 *                  spent on it). Decoding opus here to measure the level would
 *                  need a codec; the page has the level already, and layers 2
 *                  and 3 hold without it.
 *   after OpenAI:  voice-guard.checkTranscript -- prompt echo, more words than
 *                  the audio holds, stock silence phrases on a short or quiet
 *                  clip.
 *
 * A drop is not an error: the caller answers as for silence ("didn't catch
 * that") and logs the rule, never the words.
 */

const guard = require("./voice-guard");
const usageLib = require("./voice-usage");

const MIN_AUDIO_BYTES = 1200; // 0.4 s of digital silence in webm/opus is ~730 bytes; "Are we live?" was 2,554
const MIN_SPEECH_MS = 300;
const MIN_LOUD_MS = 150;

/** The page's measurement of the recording: {ms, loud_ms, peak}, or null. */
function cleanLevel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const num = (v, max) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const out = { ms: num(raw.ms, 600000), loud_ms: num(raw.loud_ms, 600000), peak: num(raw.peak, 2) };
  return out.ms == null && out.loud_ms == null ? null : out;
}

/** Why this clip is not worth transcribing, or null. */
function preCheck(audio, level) {
  const n = audio ? audio.length : 0;
  if (n < MIN_AUDIO_BYTES) return "tiny";
  if (level) {
    if (level.ms != null && level.ms < MIN_SPEECH_MS) return "short";
    if (level.loud_ms != null && level.loud_ms < MIN_LOUD_MS) return "quiet";
  }
  return null;
}

/**
 * {audio, mime, level, cfg, transcribe} -> {text, dropped, heard, audioSeconds}
 * `transcribe` is voice.transcribeFull (or a test's mock). `heard` is the
 * model's full result when it was called (its usage is billed either way).
 * `text` is "" whenever anything was dropped.
 */
async function intake({ audio, mime, level, cfg, transcribe, sources }) {
  const lv = cleanLevel(level);
  const pre = preCheck(audio, lv);
  if (pre) return { text: "", dropped: pre, heard: null, audioSeconds: null };
  const heard = await transcribe(audio, cfg, mime);
  const audioSeconds = guard.audioSecondsFromUsage(heard && heard.usage);
  const text = String((heard && heard.text) || "").trim();
  const g = guard.checkTranscript(text, { audioSeconds, quiet: !!(lv && lv.peak != null && lv.loud_ms != null && lv.loud_ms < 400), sources });
  if (!g.ok) return { text: "", dropped: g.rule, why: g.detail || null, heard, audioSeconds };
  return { text, dropped: null, heard, audioSeconds };
}

/**
 * The direct path's transcription (/joya-ai/api/transcribe): intake(), and a
 * transcript that passed is remembered for (actor, vt), so the send that
 * follows can be held to it (sendRefusal).
 */
async function transcribeTurn({ audio, mime, level, cfg, transcribe, grounds, actor, vt, sources }) {
  const got = await intake({ audio, mime, level, cfg, transcribe, sources });
  if (!got.dropped && got.text && vt && grounds) grounds.remember(actor, vt, got.text);
  return got;
}

/**
 * Why a send must not reach JOYA AI, or null. `body.vt` marks a voice turn:
 * its text must be exactly what this server heard for that voice turn (once),
 * and never read as a prompt. A send with no vt is typed, the administrator's
 * own keystrokes, and passes as before.
 */
function sendRefusal({ grounds, actor, body, text, sources }) {
  const raw = body && body.vt;
  if (raw === undefined || raw === null || raw === "") return null;
  if (!usageLib.cleanVt(raw)) return { rule: "bad-vt" };
  const door = guard.refuseAtDoor(text, sources);
  if (door) return door;
  if (!grounds || !grounds.take(actor, raw, text)) return { rule: "ungrounded" };
  return null;
}

module.exports = { intake, transcribeTurn, sendRefusal, preCheck, cleanLevel, MIN_AUDIO_BYTES, MIN_SPEECH_MS, MIN_LOUD_MS };
