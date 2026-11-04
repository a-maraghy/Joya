"use strict";
/**
 * What the voice costs, from what OpenAI reports -- in one place.
 *
 * Every call the voice makes to OpenAI comes back with its real usage: a
 * realtime response's `usage` (text and audio tokens, cached or not), the
 * text-to-speech stream's `speech.audio.done` usage, the transcription's
 * `usage` (audio tokens in, text tokens out). Each is priced here with the
 * list below and written to the panel's database as one row, tagged with the
 * voice turn it belongs to and what kind of turn that was:
 *
 *   direct       read-aloud: JOYA AI's reply read aloud word for word (the
 *                "Read replies aloud" switch and the reply's Read aloud)
 *   small_talk, snapshot, handoff
 *                the relay front desk's turns, removed 2026-09-30 (voice is
 *                live conversation only); kept so older rows still add up
 *   live         the live conversation (lib/voice-live.js): the
 *                realtime speech-to-speech model's audio in and out and its
 *                text tokens (part "realtime"), and the safe lines and JOYA
 *                AI's summaries read into the same call (part "speech")
 *   sample       Settings ▸ Voice: a voice card's play button (a short line in
 *                that voice, made once per voice and model and kept on disk)
 *
 * and transcription (what the administrator said, turned into text) is its own
 * line, whichever path the turn took. There is no cap: the administrator
 * decided (2026-09-29) to see the spend on screen instead of limiting it.
 *
 * Days and months are Africa/Cairo days and months, like the rest of the panel.
 */

/**
 * USD per 1M tokens (transcription also per minute, the page's estimate, used
 * only when a response reports seconds instead of tokens). From OpenAI's
 * pricing page, read on PRICES_READ. The transcription models are listed with
 * one input price, which applies to their audio and text input alike.
 */
const PRICES_READ = "2026-09-29";
const PRICES_SOURCE = "https://developers.openai.com/api/docs/pricing";
const PRICES = Object.freeze({
  "gpt-realtime-mini": { text_in: 0.6, text_cached: 0.06, text_out: 2.4, audio_in: 10.0, audio_cached: 0.3, audio_out: 20.0 },
  "gpt-realtime": { text_in: 4.0, text_cached: 0.4, text_out: 16.0, audio_in: 32.0, audio_cached: 0.4, audio_out: 64.0 },
  // The live conversation's models (read on the pricing page 2026-09-29 as well).
  "gpt-realtime-2.1-mini": { text_in: 0.6, text_cached: 0.06, text_out: 2.4, audio_in: 10.0, audio_cached: 0.3, audio_out: 20.0 },
  "gpt-realtime-2.1": { text_in: 4.0, text_cached: 0.4, text_out: 24.0, audio_in: 32.0, audio_cached: 0.4, audio_out: 64.0 },
  "gpt-4o-mini-tts": { text_in: 0.6, audio_out: 12.0 },
  "gpt-4o-mini-transcribe": { text_in: 1.25, audio_in: 1.25, text_out: 5.0, per_minute: 0.003 },
  "gpt-4o-transcribe": { text_in: 2.5, audio_in: 2.5, text_out: 10.0, per_minute: 0.006 },
  // gpt-4o-transcribe is the one transcription model since 2026-10-30 (lib/voice-transcribe.js); the
  // retired ones stay priced so older rows still read and add up.
  // Listed per minute only (read 2026-09-30); token usage is priced by its audio
  // length (TRANSCRIBE_AUDIO_TOKENS_PER_S), marked as an estimate there.
  "gpt-transcribe": { per_minute: 0.0045 },
  // GPT-Live (lib/voice-gptlive.js) is billed by session time, per second (read 2026-10-29 on
  // https://developers.openai.com/api/docs/models/gpt-live-1); it reports {seconds}.
  "gpt-live-1": { per_minute: 0.05 },
});
// About 10 audio tokens a second of speech on the transcribe models (lib/voice-guard.js uses the same).
const TRANSCRIBE_AUDIO_TOKENS_PER_S = 10;
const TOKEN_KINDS = ["text_in", "text_cached", "audio_in", "audio_cached", "text_out", "audio_out"];

const CATEGORIES = Object.freeze(["small_talk", "snapshot", "handoff", "direct", "live", "sample"]);
const CATEGORY_LABELS = Object.freeze({ small_talk: "Small talk", snapshot: "Snapshot answers", handoff: "Hand-offs", direct: "Direct (read aloud)", live: "Live conversation", sample: "Voice samples", transcription: "Transcription" });
const PARTS = Object.freeze(["transcription", "desk", "speech", "realtime"]);
const TZ = "Africa/Cairo";

/* ------------------------------------------------------------ tokens -- */

/** A realtime `usage` object as billable counts. */
function realtimeTokens(usage) {
  const u = usage || {};
  const i = u.input_token_details || {};
  const c = i.cached_tokens_details || {};
  const o = u.output_token_details || {};
  const cachedText = c.text_tokens || 0;
  const cachedAudio = c.audio_tokens || 0;
  return {
    text_in: Math.max(0, (i.text_tokens || 0) - cachedText),
    text_cached: cachedText,
    audio_in: Math.max(0, (i.audio_tokens || 0) - cachedAudio),
    audio_cached: cachedAudio,
    text_out: o.text_tokens || 0,
    audio_out: o.audio_tokens || 0,
  };
}

/** gpt-4o-mini-tts, streamed: speech.audio.done {usage: {input_tokens, output_tokens}}. */
function ttsTokens(usage) {
  const u = usage || {};
  return { text_in: u.input_tokens || 0, audio_out: u.output_tokens || 0 };
}

/**
 * A transcription's `usage`: {type: "tokens", input_tokens, input_token_details
 * {text_tokens, audio_tokens}, output_tokens} -- or {type: "duration", seconds}.
 */
function transcribeTokens(usage) {
  const u = usage || {};
  if (u.type === "duration") return { seconds: u.seconds || 0 };
  const d = u.input_token_details || {};
  const audio = d.audio_tokens != null ? d.audio_tokens : Math.max(0, (u.input_tokens || 0) - (d.text_tokens || 0));
  return { audio_in: audio || 0, text_in: d.text_tokens || 0, text_out: u.output_tokens || 0 };
}

function addTokens(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + (v || 0);
  return out;
}

/** USD for counts on a model. An unknown model is priced as gpt-realtime-mini. */
function costOf(tokens, model) {
  const p = PRICES[model] || PRICES["gpt-realtime-mini"];
  const t = tokens || {};
  let usd = 0;
  for (const k of TOKEN_KINDS) usd += (t[k] || 0) * (p[k] || 0);
  usd /= 1e6;
  if (t.seconds && p.per_minute) usd += (t.seconds / 60) * p.per_minute;
  // A per-minute-only model that reported tokens: its minutes from its audio tokens.
  else if (p.per_minute && p.audio_in == null && t.audio_in) usd += (t.audio_in / TRANSCRIBE_AUDIO_TOKENS_PER_S / 60) * p.per_minute;
  return usd;
}

/**
 * What a reading cost: the sum of its billing records ({model, tokens}), one
 * per OpenAI response it took -- a realtime reading, a reading cut short, the
 * text-to-speech fallback. A cached clip has none and costs nothing.
 */
function billingCost(billing) {
  return (billing || []).reduce((n, b) => n + costOf(b.tokens, b.model), 0);
}

/* ---------------------------------------------------------- calendar -- */

function cairoDay(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d instanceof Date ? d : new Date(d));
}
function cairoMonth(d, tz) {
  return cairoDay(d, tz).slice(0, 7);
}

/* ------------------------------------------------------------ ledger -- */

const VT_RE = /^[A-Za-z0-9_-]{4,48}$/;
function cleanVt(vt) {
  return typeof vt === "string" && VT_RE.test(vt) ? vt : null;
}
function cleanCat(cat) {
  return CATEGORIES.includes(cat) ? cat : null;
}

/**
 * The ledger over a store: { insert(row), rowsSince(ms) -> rows }. Rows are
 * { ts (ms), day, month, vt, cat, part, model, usd, tokens (JSON text), actor }.
 */
function createLedger(store, opts) {
  const o = opts || {};
  const tz = o.tz || TZ;
  const now = o.now || (() => Date.now());
  return {
    /**
     * Record one priced call. `tokens` are counts (realtimeTokens & co.); usd
     * is computed here so every row is priced by the same list.
     */
    add({ vt, cat, part, model, tokens, actor, usd }) {
      if (!PARTS.includes(part)) throw new Error("unknown part " + part);
      const ts = now();
      const cost = usd != null ? Number(usd) : costOf(tokens, model);
      const row = {
        ts,
        day: cairoDay(ts, tz),
        month: cairoMonth(ts, tz),
        vt: cleanVt(vt),
        cat: cleanCat(cat),
        part,
        model: String(model || "").slice(0, 60),
        usd: isFinite(cost) ? cost : 0,
        tokens: JSON.stringify(tokens || {}),
        actor: actor ? String(actor).slice(0, 80) : null,
      };
      store.insert(row);
      return row;
    },
    /** Every billing record of a reading, as speech rows. Returns their USD. */
    addBilling({ vt, cat, actor, billing }) {
      let usd = 0;
      for (const b of billing || []) usd += this.add({ vt, cat, part: "speech", model: b.model, tokens: b.tokens, actor }).usd;
      return usd;
    },
    /** Today's, this month's and the last turn's figures. */
    summary() {
      // Rows of this month and a little before (a month boundary in Cairo is
      // not one in UTC); aggregate() does the exact cut.
      const rows = store.rowsSince(now() - 33 * 86400000);
      return aggregate(rows, now(), tz);
    },
  };
}

function emptyTotals() {
  const by = {};
  for (const c of CATEGORIES) by[c] = 0;
  return { total: 0, by, transcription: 0, turns: 0 };
}

/**
 * The on-screen figures from rows (pure: `nowMs` and `tz` decide the Cairo day
 * and month). A category is what its speech and desk rows say; transcription
 * rows count as transcription, whichever path the turn took. The last turn is
 * the voice turn (vt) with the latest row, all of its parts added up -- a
 * hand-off grows when its summary is spoken.
 */
function aggregate(rows, nowMs, tz) {
  const day = cairoDay(nowMs, tz);
  const month = cairoMonth(nowMs, tz);
  const today = emptyTotals();
  const mon = emptyTotals();
  const turnsToday = new Set();
  const turnsMonth = new Set();
  const byVt = new Map();
  for (const r of rows || []) {
    const rDay = cairoDay(r.ts, tz);
    const rMonth = rDay.slice(0, 7);
    const usd = Number(r.usd) || 0;
    const add = (t) => {
      t.total += usd;
      if (r.part === "transcription") t.transcription += usd;
      else if (r.cat && t.by[r.cat] != null) t.by[r.cat] += usd;
      else t.by.direct += usd; // speech without a category is the direct reader's
    };
    if (rMonth === month) {
      add(mon);
      if (r.vt) turnsMonth.add(r.vt);
      if (rDay === day) {
        add(today);
        if (r.vt) turnsToday.add(r.vt);
      }
    }
    if (r.vt) {
      const t = byVt.get(r.vt) || { vt: r.vt, at: 0, usd: 0, cat: null, parts: { transcription: 0, desk: 0, speech: 0, realtime: 0 } };
      t.usd += usd;
      t.parts[r.part] = (t.parts[r.part] || 0) + usd;
      t.at = Math.max(t.at, r.ts);
      if (r.part !== "transcription" && r.cat) t.cat = r.cat;
      byVt.set(r.vt, t);
    }
  }
  today.turns = turnsToday.size;
  mon.turns = turnsMonth.size;
  let last = null;
  for (const t of byVt.values()) if (!last || t.at > last.at) last = t;
  return {
    day,
    month,
    today,
    month_totals: mon,
    last: last ? { vt: last.vt, at: new Date(last.at).toISOString(), usd: last.usd, cat: last.cat || "direct", parts: last.parts } : null,
    prices: { read: PRICES_READ, source: PRICES_SOURCE },
  };
}

module.exports = {
  PRICES,
  PRICES_READ,
  PRICES_SOURCE,
  CATEGORIES,
  CATEGORY_LABELS,
  PARTS,
  TZ,
  realtimeTokens,
  ttsTokens,
  transcribeTokens,
  addTokens,
  costOf,
  billingCost,
  cairoDay,
  cairoMonth,
  cleanVt,
  cleanCat,
  createLedger,
  aggregate,
};
