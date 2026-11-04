/*
 * The live conversation's audio, in the audio thread (AudioWorklet): see
 * public/voice-live.js. Loaded with audioWorklet.addModule from this same
 * origin (the CSP allows only 'self' scripts), never inline.
 *
 *   joya-live-capture  the microphone, resampled to 24 kHz mono PCM16, posted
 *                      in 20 ms frames with their level
 *   joya-live-player   what the server sends, per segment, played gap-free at
 *                      the context's rate; flushed at once on a barge-in, and
 *                      it says how many milliseconds of each segment were played
 */
/* global sampleRate, registerProcessor, AudioWorkletProcessor */
var OUT_RATE = 24000;
var FRAME = 480; // 20 ms at 24 kHz

class JoyaLiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE; // input samples per output sample
    this.pos = 0; // fractional read position into `buf`
    this.buf = new Float32Array(0);
    this.out = new Int16Array(FRAME);
    this.n = 0;
    this.sum = 0;
    this.muted = false;
    var self = this;
    this.port.onmessage = function (e) {
      if (e.data && e.data.type === "mute") self.muted = !!e.data.on;
    };
  }
  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    // Append the new block to what is left over.
    var rest = this.buf.length - Math.floor(this.pos);
    var b = new Float32Array(Math.max(0, rest) + ch.length);
    if (rest > 0) b.set(this.buf.subarray(Math.floor(this.pos)), 0);
    b.set(ch, Math.max(0, rest));
    this.pos -= Math.floor(this.pos);
    this.buf = b;
    // Average the input samples each output sample stands for (a crude low-pass).
    while (this.pos + this.step <= this.buf.length) {
      var a = Math.floor(this.pos), z = Math.min(this.buf.length, Math.floor(this.pos + this.step));
      var s = 0, k = 0;
      for (var i = a; i < Math.max(z, a + 1); i++) { s += this.buf[i]; k++; }
      var v = s / k;
      this.sum += v * v;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      this.out[this.n++] = this.muted ? 0 : v < 0 ? v * 0x8000 : v * 0x7fff;
      this.pos += this.step;
      if (this.n === FRAME) {
        var level = Math.sqrt(this.sum / FRAME);
        var frame = this.out.slice(0).buffer;
        this.port.postMessage({ type: "frame", pcm: frame, level: this.muted ? 0 : level }, [frame]);
        this.n = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}

class JoyaLivePlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; // [{seg, data: Float32Array at 24 kHz, at: read position}]
    this.step = OUT_RATE / sampleRate; // 24 kHz samples per output sample
    this.played = {}; // seg -> 24 kHz samples played
    this.cur = 0;
    this.sinceReport = 0;
    this.level = 0;
    this.wasPlaying = false;
    this.held = false; // eye contact: the reply paused while the person looks away (nothing is dropped)
    var self = this;
    this.port.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === "push") {
        var i16 = new Int16Array(m.pcm);
        var f = new Float32Array(i16.length);
        for (var i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
        self.q.push({ seg: m.seg, data: f, at: 0 });
      } else if (m.type === "flush") {
        var seg = self.q.length ? self.q[0].seg : self.cur;
        self.q = [];
        self.held = false; // a barge-in ends a paused reply too
        self.port.postMessage({ type: "flushed", seg: seg, ms: self.ms(seg), at: m.at || 0 });
      } else if (m.type === "hold") {
        self.held = !!m.on;
      } else if (m.type === "drop") {
        // A segment the server cut: what was not played yet is dropped.
        self.q = self.q.filter(function (c) { return c.seg !== m.seg; });
      }
    };
  }
  ms(seg) {
    return Math.round(((this.played[seg] || 0) / OUT_RATE) * 1000);
  }
  queuedMs() {
    var n = 0;
    for (var i = 0; i < this.q.length; i++) n += this.q[i].data.length - this.q[i].at;
    return Math.round((n / OUT_RATE) * 1000);
  }
  process(inputs, outputs) {
    var out = outputs[0][0];
    var sum = 0;
    for (var i = 0; i < out.length; i++) {
      if (this.held) { out[i] = 0; continue; } // paused: silence, the queue keeps its place
      var c = this.q[0];
      while (c && c.at >= c.data.length - 1) {
        this.q.shift();
        c = this.q[0];
      }
      if (!c) { out[i] = 0; continue; }
      var p = Math.floor(c.at), fr = c.at - p;
      var v = c.data[p] * (1 - fr) + c.data[Math.min(p + 1, c.data.length - 1)] * fr;
      out[i] = v;
      sum += v * v;
      c.at += this.step;
      this.played[c.seg] = (this.played[c.seg] || 0) + this.step;
      this.cur = c.seg;
    }
    for (var o = 1; o < outputs[0].length; o++) outputs[0][o].set(out);
    this.level = Math.sqrt(sum / out.length);
    var playing = this.q.length > 0;
    this.sinceReport += out.length;
    if (this.sinceReport >= sampleRate / 10 || playing !== this.wasPlaying) {
      this.sinceReport = 0;
      this.port.postMessage({ type: "pos", seg: this.cur, ms: this.ms(this.cur), queuedMs: this.queuedMs(), playing: playing, level: this.level });
    }
    this.wasPlaying = playing;
    return true;
  }
}

registerProcessor("joya-live-capture", JoyaLiveCapture);
registerProcessor("joya-live-player", JoyaLivePlayer);
