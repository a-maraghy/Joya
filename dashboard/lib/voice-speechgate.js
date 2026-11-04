"use strict";
/**
 * The voiceprint in front of GPT-Live (2026-11-01; the administrator: "the voice print does not gate
 * speaking to gpt live"). GPT-Live hears the microphone and answers by itself, so the turn-level gate
 * (LiveCall.vpHold: nothing handed to JOYA AI) came too late -- call lv1m3r7 rejected eleven turns of
 * another voice and GPT-Live still talked with it. Here the speech is checked BEFORE GPT-Live hears it:
 *
 *   idle       audio passes as it is; the room's floor is learned from quiet frames.
 *   holding    a frame of speech starts a segment: the audio is held until HOLD_SPEECH_MS of speech, a
 *              pause of END_GAP_MS, or MAX_HOLD_MS of audio. GPT-Live hears silence meanwhile, frame by
 *              frame: it only talks while it hears, so a gap in its input stalls its voice and the page
 *              runs dry (2026-11-01: "the voice keeps cutting" -- every segment while it talked was a gap).
 *   checking   the held audio goes to the voiceprint (lib/voiceprint.js check); still holding.
 *   open       a stored voice (accept, sticky), too short to tell (unverified), nothing stored or the
 *              service failing (fail open): the held audio is relayed at once, then the segment live.
 *              GPT-Live hears that speech up to MAX_HOLD_MS late, its input that much ahead of the clock.
 *   closed     an unknown voice (reject), two voices too close (uncertain), JOYA AI's own (echo): GPT-Live
 *              goes on hearing silence, live, until the segment ends.
 *
 * A segment ends after END_GAP_MS without speech; the next speech is checked again.
 */
const RATE = 24000;
const BYTES_PER_MS = (RATE * 2) / 1000;
const HOLD_SPEECH_MS = 1000; // speech checked before GPT-Live hears any of it (the service needs 0.8 s to name anyone)
const MAX_HOLD_MS = 1800; // audio held at most before the check starts anyway
const END_GAP_MS = 700; // a pause this long ends a segment
const CHECK_WAIT_MS = 900; // the check answers in ~20-300 ms; past this it fails open
const SPEECH_RMS = 300; // as voice-gptlive's SPEECH_RMS: speech at a headset, or 3x the room's floor
const PASS = new Set(["accept", "sticky", "unverified", "none", "error"]);

function rmsOf(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    s += v * v;
  }
  return Math.sqrt(s / n);
}

class SpeechGate {
  /**
   * o: { check(pcm, {overVoice}) -> Promise<verdict>, emit(buf, real) relays to GPT-Live,
   *      on(event) a segment's outcome { verdict, passed, heldMs, ms, r }, now?, timer? }
   */
  constructor(o) {
    this.o = o;
    this.now = o.now || Date.now;
    this.state = "idle";
    this.floor = null;
    this.held = [];
    this.heldBytes = 0;
    this.speechMs = 0;
    this.quietMs = 0;
    this.seg = 0;
    this.checkSeq = 0;
  }

  get idle() {
    return this.state === "idle";
  }

  voiced(rms) {
    return rms >= Math.max(SPEECH_RMS, (this.floor || 0) * 3);
  }

  /** One microphone frame (already silence when it must not be heard). overVoice: the voice is audible now. */
  push(buf, overVoice) {
    const rms = rmsOf(buf);
    const ms = buf.length / BYTES_PER_MS;
    const v = this.voiced(rms);
    if (!v) {
      const f = this.floor == null ? rms : this.floor;
      this.floor = rms < f ? f * 0.9 + rms * 0.1 : rms < f * 2.5 ? f * 0.98 + rms * 0.02 : f;
    }
    if (this.state === "idle") {
      if (!v) return this.o.emit(buf, true);
      this.state = "holding";
      this.seg++;
      this.segAt = this.now();
      this.overVoice = !!overVoice;
      this.held = [];
      this.heldBytes = 0;
      this.speechMs = 0;
      this.quietMs = 0;
    }
    if (this.state === "holding" || this.state === "checking") {
      this.held.push(buf);
      this.heldBytes += buf.length;
      if (v) {
        this.speechMs += ms;
        this.quietMs = 0;
      } else this.quietMs += ms;
      if (overVoice) this.overVoice = true;
      this.o.emit(Buffer.alloc(buf.length), false); // GPT-Live's input never stops (see holding above)
      if (this.state === "holding" && (this.speechMs >= HOLD_SPEECH_MS || this.quietMs >= END_GAP_MS || this.heldBytes / BYTES_PER_MS >= MAX_HOLD_MS)) this.startCheck();
      return;
    }
    // open or closed: the segment goes on until a pause
    if (v) this.quietMs = 0;
    else this.quietMs += ms;
    this.o.emit(this.state === "open" ? buf : Buffer.alloc(buf.length), this.state === "open");
    if (this.quietMs >= END_GAP_MS) this.state = "idle";
  }

  startCheck() {
    this.state = "checking";
    const seq = ++this.checkSeq;
    const pcm = Buffer.concat(this.held);
    const t0 = this.now();
    let done = false;
    const finish = (r) => {
      if (done || seq !== this.checkSeq || this.state !== "checking") return;
      done = true;
      clearTimeout(timer);
      this.decide(r || { verdict: "error", error: "no answer" }, this.now() - t0);
    };
    const timer = (this.o.timer || setTimeout)(() => finish({ verdict: "error", error: "the check took too long" }), CHECK_WAIT_MS);
    if (timer && timer.unref) timer.unref();
    Promise.resolve()
      .then(() => this.o.check(pcm, { overVoice: this.overVoice }))
      .catch((e) => ({ verdict: "error", error: String((e && e.message) || e).slice(0, 120) }))
      .then(finish);
  }

  decide(r, ms) {
    const passed = PASS.has(r.verdict);
    const held = this.held;
    const heldMs = Math.round(this.heldBytes / BYTES_PER_MS);
    this.held = [];
    this.heldBytes = 0;
    // A pause already ended the segment while it was held: the next speech is a new one.
    this.state = this.quietMs >= END_GAP_MS ? "idle" : passed ? "open" : "closed";
    if (passed) for (const b of held) this.o.emit(b, true); // a failed segment's silence was sent while held
    if (this.o.on) this.o.on({ seg: this.seg, verdict: r.verdict, passed, heldMs, ms, r, overVoice: this.overVoice });
  }

  /** The gate is switched off mid-segment: whatever is held goes through, and audio passes from now on. */
  release() {
    if (this.state === "holding" || this.state === "checking") {
      this.checkSeq++;
      for (const b of this.held) this.o.emit(b, true);
      this.held = [];
      this.heldBytes = 0;
    }
    this.state = "idle";
  }
}

module.exports = { SpeechGate, rmsOf, HOLD_SPEECH_MS, MAX_HOLD_MS, END_GAP_MS, CHECK_WAIT_MS, PASS };
