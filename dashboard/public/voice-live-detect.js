/*
 * Live conversation: is the administrator REALLY talking over the
 * voice, or is the microphone only hearing the speaker? Pure, no DOM, no
 * audio APIs: public/voice-live.js feeds it the microphone's level (20 ms
 * frames, after the browser's echo cancelling) and the player's output level,
 * and it says "on" once there has been sustained voice above what the
 * speaker's leak explains, "off" when that voice has stopped. The server
 * (lib/voice-live.js) interrupts only when this AND its own VAD agree.
 *
 *   var d = JoyaLiveDetect.create(opts?)
 *   d.out(level, playing, tMs)   the player's level (every ~100 ms and on changes)
 *   d.mic(level, tMs) -> "on" | "off" | null
 *   d.snapshot()                 { floor, leak, threshold, voiced, playing, sincePlay }
 *
 * The rule, while the voice is audible (and for `tailMs` after):
 *   threshold = max(floorK x noise floor + floorAdd, outK x output level x leak)
 *   "on" once the microphone has been above it for `holdMs` in total within the
 *   last `windowMs` (people barge in choppily: "wait, stop, never mind" is
 *   250 ms, a pause, 300 ms...), never in the first `warmMs` of a playback
 *   segment -- that is when the leak
 *   (microphone level / output level) is measured, for the rest of the call.
 * The noise floor is learned while nothing plays. Same idea as the hands-free
 * mode's guard in joya-ai.js (ignore the start, several times the floor, held).
 *
 * Works in the page (window.JoyaLiveDetect) and in node (module.exports), so
 * tools/test-voice-live.cjs drives the very same code.
 */
(function (root) {
  "use strict";
  var DEFAULTS = { holdMs: 400, windowMs: 800, releaseMs: 300, warmMs: 600, tailMs: 300, floorK: 6, floorAdd: 0.01, outK: 2, leak0: 0.5, outDecayPer100: 0.6 };

  function create(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = opts && opts[k] != null ? opts[k] : DEFAULTS[k];
    var floor = 0.003;
    var leak = null; // mic / out while the voice plays and nobody talks (measured)
    var outLvl = 0, outAt = 0;
    var playing = false, segStart = null, playEnd = null;
    var above = [], lastAbove = null, lastT = null, voiced = false, lastThr = 0;

    function outNow(t) {
      if (!outAt) return 0;
      return outLvl * Math.pow(o.outDecayPer100, Math.max(0, t - outAt) / 100);
    }
    function audible(t) {
      return playing || (playEnd != null && t - playEnd < o.tailMs);
    }

    return {
      out: function (level, isPlaying, t) {
        level = +level || 0;
        // A peak envelope: the echo arrives a little late and rings a little.
        if (level >= outNow(t)) { outLvl = level; outAt = t; }
        if (isPlaying && !playing) segStart = t;
        if (!isPlaying && playing) playEnd = t;
        playing = !!isPlaying;
      },
      mic: function (level, t) {
        level = +level || 0;
        if (!audible(t)) {
          // Nothing playing: learn the room -- down fast, up slowly, and never from speech
          // (a level well above the floor is someone talking, not the room).
          if (level < floor) floor = floor * 0.9 + level * 0.1;
          else if (level < floor * 2.5) floor = floor * 0.98 + level * 0.02;
          floor = Math.min(0.02, Math.max(0.0005, floor));
          above = [];
          lastT = t;
          if (voiced) { voiced = false; return "off"; }
          return null;
        }
        var out = outNow(t);
        var warm = segStart != null && t - segStart < o.warmMs && playing;
        if (warm) {
          if (out > 0.005) {
            // The leak, measured while (presumably) nobody talks. A sample far above what
            // was measured before is the administrator talking, not the leak: not learned.
            var s = Math.min(3, Math.max(0.02, level / out));
            if (leak == null) leak = s;
            else if (s < leak * 2) leak = leak * 0.8 + s * 0.2;
          }
          above = [];
          lastT = t;
          return null;
        }
        var thr = Math.max(o.floorK * floor + o.floorAdd, o.outK * out * (leak == null ? o.leak0 : leak));
        lastThr = thr;
        var dt = lastT == null ? 20 : Math.min(60, Math.max(1, t - lastT));
        lastT = t;
        if (level > thr) {
          above.push([t, dt]);
          lastAbove = t;
        }
        while (above.length && above[0][0] <= t - o.windowMs) above.shift();
        var sum = 0;
        for (var i = 0; i < above.length; i++) sum += above[i][1];
        if (!voiced && sum >= o.holdMs) {
          voiced = true;
          return "on";
        }
        if (voiced && (lastAbove == null || t - lastAbove > o.releaseMs)) {
          voiced = false;
          return "off";
        }
        return null;
      },
      snapshot: function (t) {
        return { floor: floor, leak: leak, threshold: lastThr, voiced: voiced, playing: playing, sincePlay: segStart != null && t != null ? t - segStart : null };
      },
    };
  }

  var api = { create: create, DEFAULTS: DEFAULTS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JoyaLiveDetect = api;
})(typeof self !== "undefined" ? self : this);
