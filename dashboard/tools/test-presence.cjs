#!/usr/bin/env node
"use strict";
/**
 * Eye contact (2026-10-20, mockups/eye-contact/DESIGN.md): camera presence.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-presence.cjs [--shots DIR]
 *
 * 1. The pure logic (public/joya-presence-logic.js) on synthetic landmark streams: the model's output reduced
 *    (no landmarks kept), head pose, "at the screen" / "at the bot", the presence / attention state machine and
 *    its hysteresis, the eyes' direction, the person among other faces, look and speak's gate, a reply's pause,
 *    the held notes and their summary, the frame rate / release rules, the switches' defaults; core E's doze.
 * 2. The wiring: assets on the page, the worker's own CSP, Settings off by default, the app's half (settings,
 *    capability: the page may switch it off, never on; presence.rs tested in core-tests).
 * 3. Headless Chromium with a fake camera (--use-fake-device-for-media-stream): off by default (the camera is
 *    never asked for), on -> the vendored face model runs in its worker on the frames, the indicator shows, and
 *    NO request leaves for anywhere but this site's own static files (every request and every request body is
 *    watched), the camera is let go of (locked, off from Settings, the indicator's Off, hidden); then the page
 *    side driven by a stand-in camera module: the bot's eyes and doze, the glance cards, held toasts / sounds /
 *    Windows toasts and the one summary, the catch-up, look and speak, a reply's pause. Zero CSP violations.
 *    --shots DIR writes the Settings screen.
 * 4. Which camera (2026-10-21): Automatic's ranking and the fallbacks on realistic Windows camera lists (pure);
 *    then Chromium with three fake cameras renamed like a laptop's (a phone through Phone Link, the integrated
 *    webcam, its IR camera): Automatic opens the webcam (deviceId exact), the pill names it, the Settings
 *    selector lists them and switches the open Command Center at once, a stale id with the same name, a removed
 *    camera (devicechange) and a camera that is gone fall back to Automatic and say so; the names only after
 *    "Allow the camera once" (released at once); in the app's render mode too; no request carries a camera's
 *    name or id. --shots DIR also writes the selector (browser + app, dark + light).
 * 5. The indications (2026-10-21): the pure indication(); then the real module on a synthetic face stream (a stand-in
 *    face model in place of the worker, the microphone meter fed a level): Watching / You're here / Looking at me,
 *    the ring filling over the 0.6 s hold, the "Listening — you looked and spoke" caption, "Paused — look back to
 *    continue", the reasons look and speak waits (hover / tap), in Floating S / M / L, Desktop layer, Peek, Companion
 *    and the browser; hit regions, reduced motion, nothing sent. --shots DIR also writes
 *    mockups/eye-contact/indicators (and its GIF, with ffmpeg). MP_IND_ONLY=1 runs only the pure parts and this.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const D = path.join(ROOT, "..", "desktop");
const L = require(path.join(ROOT, "public", "joya-presence-logic.js"));
const BOT = require(path.join(ROOT, "public", "joya-core-bot.js"));
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.12";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 900) : "")); }
}
const section = (t) => console.log("\n" + t);

/* ------------------------------------------------------------------ synthetic landmark streams */
/**
 * One face as FaceLandmarker returns it: 478 landmarks filling a box (cx, cy, w; the camera's own unmirrored
 * image, fractions), the head's facial transformation matrix for (yaw, pitch), the jawOpen blendshape.
 */
function face(o) {
  const w = o.w || 0.24, h = w * 1.3, pts = [];
  for (let i = 0; i < 478; i++) { const a = (i * 2.399) % (2 * Math.PI), r = Math.sqrt((i + 0.5) / 478); pts.push({ x: o.cx + Math.cos(a) * r * w / 2, y: o.cy + Math.sin(a) * r * h / 2, z: 0 }); }
  // the extremes, so the box is exactly the one asked for
  pts.push({ x: o.cx - w / 2, y: o.cy, z: 0 }, { x: o.cx + w / 2, y: o.cy, z: 0 }, { x: o.cx, y: o.cy - h / 2, z: 0 }, { x: o.cx, y: o.cy + h / 2, z: 0 });
  return { pts, m: L.matrixOf(o.yaw || 0, o.pitch || 0), jaw: o.jaw == null ? 0.02 : o.jaw, eyeDown: o.eyeDown, eyeUp: o.eyeUp };
}
function result(faces) {
  return {
    faceLandmarks: faces.map((f) => f.pts),
    facialTransformationMatrixes: faces.map((f) => ({ rows: 4, columns: 4, data: f.m })),
    faceBlendshapes: faces.map((f) => ({ categories: [{ categoryName: "eyeBlinkLeft", score: 0.1 }, { categoryName: "jawOpen", score: f.jaw }].concat(
      f.eyeDown != null || f.eyeUp != null ? ["Left", "Right"].flatMap((k) => [{ categoryName: "eyeLookDown" + k, score: f.eyeDown || 0 }, { categoryName: "eyeLookUp" + k, score: f.eyeUp || 0 }]) : []) })),
  };
}
/** A stream: [{ ms, faces: [face opts] }...] at fps -> the tracker's snapshots. */
function run(tr, segs, fps, t0) {
  let t = t0 || 0;
  const out = [];
  const dt = 1000 / (fps || 5);
  segs.forEach((s) => {
    const end = t + s.ms;
    for (; t < end; t += dt) {
      const fs_ = (typeof s.faces === "function" ? s.faces(t) : s.faces || []).map(face);
      out.push(Object.assign({ t }, tr.push(L.summarize(result(fs_)), t)));
    }
  });
  return { out, t, last: out[out.length - 1] };
}
const BOTPOS = { x: 0.85, y: 0.85 };
// Looking at the screen's middle from the middle of the camera's view; at the bot (bottom right); away.
const AT_SCREEN = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 0, pitch: -8 };
const AT_BOT = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 11, pitch: -16 };
const SIDEWAYS = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 55, pitch: -5 };

(async () => {
  section("the model's output, reduced (synthetic landmark streams)");
  {
    const r = result([face({ cx: 0.4, cy: 0.55, w: 0.2, yaw: 20, pitch: -10, jaw: 0.3 })]);
    const s = L.summarize(r);
    check("one face -> one record: box centre / width, yaw / pitch, jawOpen", s.length === 1 && Math.abs(s[0].cx - 0.4) < 1e-6 && Math.abs(s[0].cy - 0.55) < 1e-6 && Math.abs(s[0].w - 0.2) < 1e-6 && Math.abs(s[0].yaw - 20) < 1e-6 && Math.abs(s[0].pitch + 10) < 1e-6 && s[0].jaw === 0.3, JSON.stringify(s));
    check("  the landmarks stop there: only those numbers (ey: the eyes' up/down, null without eye blendshapes; mouth: the lips' numbers, null without mouth blendshapes)", JSON.stringify(Object.keys(s[0]).sort()) === JSON.stringify(["cx", "cy", "ey", "jaw", "mouth", "pitch", "w", "yaw"]) && s[0].ey === null && s[0].mouth === null);
    const se = L.summarize(result([face({ cx: 0.5, cy: 0.5, w: 0.24, eyeDown: 0.4 })]))[0];
    check("  the eyes looking down 0.4 -> about 10 degrees down (eyeLookDown, no left/right ambiguity)", Math.abs(se.ey + 10) < 1e-9, se.ey);
    check("  nothing seen -> []; a face with no pose matrix is skipped", L.summarize({ faceLandmarks: [] }).length === 0 && L.summarize({ faceLandmarks: [r.faceLandmarks[0]], facialTransformationMatrixes: [] }).length === 0);
    let worst = 0;
    for (let y = -60; y <= 60; y += 15) for (let p = -40; p <= 40; p += 10) { const q = L.poseOf(L.matrixOf(y, p)); worst = Math.max(worst, Math.abs(q.yaw - y), Math.abs(q.pitch - p)); }
    check("head pose from the transformation matrix: yaw / pitch back within 1e-9 over +-60 / +-40 degrees", worst < 1e-9, worst);
  }

  section("where they look");
  {
    const c = (f) => L.classify(f, BOTPOS);
    check("frontal, at the screen's middle -> at the screen, not at the bot (bottom right)", c(AT_SCREEN).screen && !c(AT_SCREEN).bot, JSON.stringify(c(AT_SCREEN)));
    check("  turned toward the bot -> at the screen and at the bot, frontal enough to speak", c(AT_BOT).screen && c(AT_BOT).bot && c(AT_BOT).speak, JSON.stringify(c(AT_BOT)));
    check("  turned 55 degrees aside -> neither", !c(SIDEWAYS).screen && !c(SIDEWAYS).bot);
    check("  looking up over the screen / far down at the desk -> not at the screen", !c({ ...AT_SCREEN, pitch: 25 }).screen && !c({ ...AT_SCREEN, pitch: -45 }).screen);
    check("  a bot at the top left: the same head turned to the bottom right is no longer at it", !L.classify(AT_BOT, { x: 0.1, y: 0.1 }).bot);
    const a = L.aim(AT_SCREEN, BOTPOS);
    check("  the geometry: a face 0.24 of the frame wide sits about 54 cm away; the bot is 12 deg right, 18 deg down", Math.abs(a.at.D - 54) < 1 && Math.abs(a.bot.yaw - 12.4) < 0.5 && Math.abs(a.bot.pitch + 18.3) < 0.5, JSON.stringify(a));
  }

  section("the eyes: where the person is, seen from the bot");
  {
    const g = (f, b) => L.gazeFor(f, b || BOTPOS);
    const mid = g(AT_SCREEN), right = g({ ...AT_SCREEN, cx: 0.2 }), left = g({ ...AT_SCREEN, cx: 0.8 });
    check("in the middle, the bot at the bottom right -> it looks up and to the left", mid.x < 0 && mid.y < 0, JSON.stringify(mid));
    check("  they move to their right (the camera's image left) -> the eyes follow to the screen's right", right.x > mid.x && left.x < mid.x, JSON.stringify({ left, mid, right }));
    check("  they lean down / sit up -> the eyes follow down / up", g({ ...AT_SCREEN, cy: 0.8 }).y > mid.y && g({ ...AT_SCREEN, cy: 0.2 }).y < mid.y);
    check("  coarse: quarters only, inside -1..1", [mid, right, left, g({ ...AT_SCREEN, cx: 0 }), g({ ...AT_SCREEN, cy: 1, w: 0.6 })].every((v) => Math.abs(v.x * 4 - Math.round(v.x * 4)) < 1e-9 && Math.abs(v.y * 4 - Math.round(v.y * 4)) < 1e-9 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1));
    const top = g(AT_SCREEN, { x: 0.5, y: 0.02 });
    check("  a bot right under the camera looks straight out (about 0, 0)", Math.abs(top.x) <= 0.25 && Math.abs(top.y) <= 0.25, JSON.stringify(top));
  }

  section("the presence / attention state machine (5 fps)");
  {
    const tr = L.createTracker({ bot: BOTPOS });
    let r = run(tr, [{ ms: 3000, faces: [] }]);
    check("the camera has just opened on an empty desk: unknown (null) for the first seconds", r.out.every((s) => s.state === null));
    r = run(tr, [{ ms: 6000, faces: [] }], 5, r.t);
    check("  ...then away once it has watched the empty desk for 8 s", r.last.state === "away");
    const sit = run(tr, [{ ms: 1400, faces: [AT_SCREEN] }], 5, r.t);
    const firstPresent = sit.out.find((s) => s.state && s.state !== "away");
    check("someone sits down facing the screen: here within half a second, looking right after", firstPresent && firstPresent.t - r.t <= 600 && sit.last.state === "looking", JSON.stringify(sit.out.map((s) => s.state)));
    check("  the change is flagged once", sit.out.filter((s) => s.changed).length <= 2);
    let k = run(tr, [{ ms: 800, faces: [SIDEWAYS] }, { ms: 600, faces: [AT_SCREEN] }], 5, sit.t);
    check("a glance aside under 1.2 s (the keyboard, a note) keeps them 'looking': no flicker", k.out.every((s) => s.state === "looking"), JSON.stringify(k.out.map((s) => s.state)));
    k = run(tr, [{ ms: 2400, faces: [SIDEWAYS] }], 5, k.t);
    check("  turned away for longer -> 'present' (here, not looking)", k.last.state === "present" && k.last.turnedAwayMs >= 2000, JSON.stringify(k.last));
    k = run(tr, [{ ms: 600, faces: [AT_SCREEN] }], 5, k.t);
    check("  back to the screen -> looking within 0.3-0.6 s", k.last.state === "looking");
    const flick = run(tr, [{ ms: 4000, faces: (t) => (Math.floor(t / 200) % 2 ? [AT_SCREEN] : []) }], 5, k.t);
    check("the model missing every other frame does not flap the state", flick.out.every((s) => s.state === "looking"), JSON.stringify(flick.out.map((s) => s.state)));
    let w = run(tr, [{ ms: 5000, faces: [] }], 5, flick.t);
    check("they step out: still 'present' (not looking) for the first 5 s -- a lean out of the frame is not leaving", w.last.state === "present", w.last.state);
    w = run(tr, [{ ms: 3600, faces: [] }], 5, w.t);
    check("  gone 8 s -> away; the eyes have nowhere to look (gaze null)", w.last.state === "away" && w.last.gaze === null);
    const back = run(tr, [{ ms: 1000, faces: [{ ...AT_SCREEN, cx: 0.3 }] }], 5, w.t);
    check("  back -> looking, with the eyes on them again", back.last.state === "looking" && back.last.gaze && back.last.gaze.x > -0.5, JSON.stringify(back.last));
    const tr2 = L.createTracker({ bot: BOTPOS });
    const fast = run(tr2, [{ ms: 1000, faces: [AT_SCREEN] }], 2);
    check("at 2 fps (battery) the same: here and looking within a second", fast.last.state === "looking", JSON.stringify(fast.out.map((s) => s.state)));
    const tr3 = L.createTracker({ bot: BOTPOS });
    const blip = run(tr3, [{ ms: 9000, faces: [] }, { ms: 200, faces: [AT_SCREEN] }, { ms: 3000, faces: [] }], 5);
    check("one stray detection on an empty desk is not someone sitting down", blip.out.every((s) => s.state !== "present" && s.state !== "looking"), JSON.stringify(blip.out.map((s) => s.state).filter(Boolean).slice(-20)));
  }

  section("the person among other faces");
  {
    const me = { cx: 0.5, cy: 0.5, w: 0.26 }, far = { cx: 0.85, cy: 0.3, w: 0.07 }, near = { cx: 0.15, cy: 0.5, w: 0.2 };
    const p = L.pickPrimary([far, me]);
    check("the biggest (nearest) face is the person; a small one far behind is not counted", p.face === me && p.others === 0);
    check("  someone as close beside them is counted (look and speak stands down)", L.pickPrimary([me, near]).others === 1);
    const prev = { cx: 0.15, cy: 0.5 };
    check("  the one being tracked stays the person while about as big (no hopping between two people)", L.pickPrimary([me, near], prev).face === near && L.pickPrimary([me, { ...near, w: 0.1 }], prev).face === me);
  }

  section("look and speak: conservative");
  {
    function scene(o) {
      const tr = L.createTracker({ bot: BOTPOS }), gate = L.createSpeakGate();
      let t = 0, start = null;
      const look = o.look || AT_BOT;
      for (; t < 4000; t += 50) {
        if (t % 200 === 0) {
          const jaw = o.mouth === false ? 0.03 : 0.03 + (t > 2000 ? 0.25 * (Math.floor(t / 200) % 2) : 0);
          const faces = [{ ...look, jaw }].concat(o.extra ? [o.extra] : []);
          gate.vision(tr.push(L.summarize(result(faces.map(face))), t), t);
        }
        const loud = o.level ? o.level(t) : t >= 2200 && t < 3200 ? 0.08 : 0.003;
        if (gate.audio(loud, t, !!o.busy) === "start" && start === null) start = t;
      }
      return start;
    }
    const ok = scene({});
    check("they face the bot, their mouth moves, speech starts -> listening starts at the onset (~160 ms in)", ok !== null && ok >= 2200 && ok <= 2450, ok);
    check("  looking at the screen but not at the bot -> no", scene({ look: AT_SCREEN }) === null);
    check("  turned aside -> no", scene({ look: SIDEWAYS }) === null);
    check("  someone else as close in view -> no", scene({ extra: { cx: 0.15, cy: 0.5, w: 0.22, yaw: -30 } }) === null);
    check("  their mouth still (someone else talking off camera) -> no", scene({ mouth: false }) === null);
    check("  a call already held / the voice speaking -> no", scene({ busy: true }) === null);
    check("  a click (under 160 ms) -> no", scene({ level: (t) => (t >= 2500 && t < 2600 ? 0.2 : 0.003) }) === null);
    check("  a steady fan (the floor follows the room) -> no", scene({ level: () => 0.03 }) === null);
    const g = L.createSpeakGate();
    const lk = { state: "looking", atBot: true, speak: true, others: 0, mouth: true };
    g.vision(lk, 0); g.vision(lk, 700);
    let n = 0;
    for (let t = 700; t < 5000; t += 50) { g.vision(lk, t); if (g.audio(t % 1000 < 600 ? 0.1 : 0.002, t, false) === "start") n++; }
    check("  one turn, then 3 s cool-down: 2 starts in 4.3 s of on-and-off talk", n === 2, n);
    // 2026-10-21 ("slow, inaccurate"): speech dips between sounds; a dip under 120 ms no longer restarts the onset
    const dippy = (t) => (t >= 2200 && t < 3600 ? ((t - 2200) % 150 < 100 ? 0.08 : 0.003) : 0.003); // 100 ms sound, 50 ms dip
    const dS = scene({ level: dippy });
    check("  real speech dips between its sounds (100 ms on, 50 ms off): it still starts at the onset (0.1.12 restarted the 160 ms at every dip, so it started words later or never)", dS !== null && dS <= 2450, dS);
    const old = (() => { const tr = L.createTracker({ bot: BOTPOS }), gate = L.createSpeakGate({ dipMs: 0 }); let start = null; for (let t = 0; t < 4000; t += 50) { if (t % 200 === 0) gate.vision(tr.push(L.summarize(result([face({ ...AT_BOT, jaw: 0.03 + (t > 2000 ? 0.25 * (Math.floor(t / 200) % 2) : 0) })])), t), t); if (gate.audio(dippy(t), t, false) === "start" && start === null) start = t; } return start; })();
    check("  (the same speech with no dip allowance never starts: the cause)", old === null, old);
    check("  typing (a click every 100 ms) while looking at the bot -> no (sound only half the time; speech needs 65 %)", scene({ level: (t) => (t >= 2200 && t < 3600 && t % 100 === 0 ? 0.2 : 0.003) }) === null);
    check("  two clicks 150 ms apart (each 50 ms) -> still no", scene({ level: (t) => ((t >= 2500 && t < 2550) || (t >= 2700 && t < 2750) ? 0.2 : 0.003) }) === null);
    // the pre-roll reaches back to where the spell of talking began, not the last word
    const g2 = L.createSpeakGate();
    g2.vision(lk, 0); g2.vision(lk, 700);
    let st2 = null;
    for (let t = 700; t < 3000; t += 50) { g2.vision(lk, t); const talk = t >= 300 + 700 && (t % 500 < 350); if (g2.audio(talk ? 0.1 : 0.002, t, false) === "start" && st2 === null) st2 = t; }
    check("  onset(): where the spell of talking began (words 150 ms apart are one spell), for the pre-roll", st2 !== null && g2.onset() === 1000, JSON.stringify({ st2, onset: g2.onset() }));
    const tr2 = L.createTracker({ bot: BOTPOS });
    const f0 = tr2.push(L.summarize(result([face(AT_BOT)])), 0);
    check("  facingNow: turned to the bot this frame (the microphone opens then, before atBot's 0.5 s), atBot not yet", f0.facingNow === true && f0.atBot === false, JSON.stringify(f0));
  }

  section("look and speak with a real face's numbers (2026-10-21: it never started on a laptop)");
  {
    // A real person 55 cm from a laptop camera looks at a bot 12 deg right / 18 deg down mostly with their eyes: the head
    // turns ~4 deg, tips ~8 deg, the eyes look down; MediaPipe's head pose jitters +-3 deg frame to frame.
    const REAL = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 4, pitch: -8, eyeDown: 0.4 };
    const jit = (f, t) => ({ ...f, yaw: f.yaw + [0, 3, -3, 2, -2, 3.5][Math.floor(t / 200) % 6], pitch: f.pitch + [0, -2, 2, -3, 3, 1][Math.floor(t / 200) % 6] });
    function scene2(o) {
      const tr = L.createTracker({ bot: BOTPOS }), gate = L.createSpeakGate(), old = o.old;
      let start = null, armedAt = null;
      for (let t = 0; t < 5000; t += 50) {
        if (t % 200 === 0) {
          const jaw = o.mouth === false ? 0.03 : 0.03 + (t > 2400 ? 0.25 * (Math.floor(t / 200) % 2) : 0);
          const me = { ...(o.look ? o.look(t) : jit(REAL, t)), jaw };
          const faces = [me].concat(o.extra ? [o.extra] : []);
          gate.vision(tr.push(L.summarize(result(faces.map(face))), t), t);
          if (gate.armed() && armedAt === null) armedAt = t;
        }
        const loud = o.level ? o.level(t) : t >= 2600 && t < 3600 ? 0.08 : 0.003;
        if (gate.audio(loud, t, false) === "start" && start === null) start = t;
      }
      return { start, armedAt, st: gate.status() };
    }
    const r = scene2({});
    check("a real look at the bot (head 4 deg, eyes down, +-3 deg jitter) arms within a second and a sentence starts listening", r.armedAt !== null && r.armedAt <= 1200 && r.start !== null && r.start >= 2600 && r.start <= 2900, JSON.stringify(r));
    const head = L.classify({ ...REAL, ey: null }, BOTPOS);
    check("  (the cause: 0.1.12 judged the head alone, within 7 deg sideways / 10 up -- this look is " + Math.abs(head.dy).toFixed(1) + " deg sideways and " + head.dp.toFixed(1) + " up off the bot)", Math.abs(head.dy) > 7 && head.dp > 10, JSON.stringify(head));
    const screenMid = scene2({ look: (t) => jit({ cx: 0.5, cy: 0.5, w: 0.24, yaw: 0, pitch: -6, eyeDown: 0.1 }, t) });
    check("  reading the middle of the screen, then talking (on the phone) -> no", screenMid.start === null, JSON.stringify(screenMid));
    const glance = scene2({ look: (t) => (t >= 2000 && t < 2400 ? REAL : { ...SIDEWAYS, eyeDown: 0 }) , level: (t) => (t >= 2200 && t < 3200 ? 0.08 : 0.003) });
    check("  a side glance at the bot (0.4 s) while someone talks -> no", glance.start === null, JSON.stringify(glance));
    check("  someone else talking off camera (their mouth still) -> no", scene2({ mouth: false }).start === null);
    const tv = scene2({ mouth: false, extra: { cx: 0.8, cy: 0.3, w: 0.08, yaw: 0, pitch: 0, jaw: 0.4 } });
    check("  a TV behind them (a small face talking, theirs still) -> no", tv.start === null, JSON.stringify(tv));
    check("  someone as close beside them -> no", scene2({ extra: { cx: 0.15, cy: 0.5, w: 0.22, yaw: -30 } }).start === null);
    const st = r.st;
    check("the checklist ('Show what it sees'): numbers only -- face, facing (degrees off, held), mouth, level vs needed, busy, cool-down", ["face", "facing", "dy", "dp", "held", "mouth", "level", "need", "busy", "coolLeft"].every((k) => k in st) && Object.values(st).every((v) => v === null || ["number", "boolean"].includes(typeof v)), JSON.stringify(st));
    const tr = L.createTracker({ bot: BOTPOS });
    let flips = 0, prev = null;
    for (let t = 0; t < 3000; t += 200) { const sn = tr.push(L.summarize(result([face(jit(REAL, t))])), t); if (prev !== null && sn.atBot !== prev) flips++; prev = sn.atBot; }
    check("  jitter does not flap 'at the bot' (median of three frames)", flips <= 1, flips);
  }

  section("a reply pauses while you look away");
  {
    const rp = L.createReplyPause();
    check("speaking, looked away 1.4 s -> goes on", rp.feed(1400, false, true) === null);
    check("  1.5 s -> pause", rp.feed(1500, false, true) === "pause" && rp.paused());
    check("  still away -> stays paused (nothing repeated)", rp.feed(4000, false, true) === null);
    check("  looks back -> resume", rp.feed(0, true, true) === "resume" && !rp.paused());
    check("  not speaking -> never pauses", rp.feed(9000, false, false) === null);
    rp.feed(2000, false, true);
    check("  the camera let go meanwhile -> resumed", rp.reset() === "resume");
  }

  section("what the page shows (the indications, pure)");
  {
    const I = (o) => L.indication(Object.assign({ camera: true, state: "looking", atBot: true, speakOn: true, voice: true, busy: false, others: 0, coolLeft: 0, held: 0, armMs: 600, armed: false, paused: false, listening: false }, o));
    check("camera off -> nothing; nobody / away -> 'Watching'; at the screen -> 'You're here'; at the bot -> 'Looking at me' + the noticed ring", L.indication({ camera: false }) === null && I({ state: null }).word === "Watching" && I({ state: "away" }).look === "watching" && I({ atBot: false }).word === "You're here" && I({ state: "present", atBot: false }).look === "here" && I({}).word === "Looking at me" && I({}).ring === "noticed");
    const h = I({ held: 300 });
    check("  the hold: arming, half full, 300 ms to go; held -> ready (full)", h.ring === "arming" && h.arm === 0.5 && h.armLeft === 300 && I({ held: 650, armed: true }).ring === "ready" && I({ armed: true, held: 650 }).arm === 1);
    check("  blocked (voice off / someone else / busy / cool-down): never arming, the reason named; look and speak off: no reason at all", ["voice", "others", "busy", "cool"].every((k, i) => { const x = I([{ voice: false }, { others: 1 }, { busy: true }, { coolLeft: 900 }][i]); return x.blocked === k && x.ring === "noticed" && x.armLeft === 0; }) && I({ speakOn: false, voice: false, held: 300 }).blocked === null && I({ speakOn: false, held: 300 }).ring === "noticed");
    check("  listening (a turn it started): the caption, no ring, not blocked by its own busy; paused: the caption", I({ listening: true, busy: true, held: 700 }).caption === "listening" && I({ listening: true, busy: true }).ring === null && I({ listening: true, busy: true }).blocked === null && I({ paused: true, state: "present", atBot: false }).caption === "paused" && I({ paused: true }).word === "Paused");
    check("  the hint's words", L.speakHint(I({ voice: false }), true) === "Look and speak waits: voice is off" && L.speakHint(I({}), false) === "Look and speak is off" && L.CAPTION_TEXT.listening === "Listening — you looked and spoke" && L.CAPTION_TEXT.paused === "Paused — look back to continue");
  }

  section("held while away, one summary when back");
  {
    const h = L.createHolder();
    check("here (or the camera off): nothing is held", h.offer("toast", "x") === false && h.setState(null) === null && h.offer("sound", "job") === false);
    h.setState("away");
    ["Reconnected.", "Planning engine finished", "Reconnected."].forEach((t) => h.offer("toast", t));
    h.offer("native", { title: "Planning engine needs you", body: "A step waits for your approval." });
    ["done", "approval", "job"].forEach((s) => h.offer("sound", s));
    check("away: toasts, the app's Windows toasts and sounds are held", h.held() === 7);
    const sum = h.setState("looking");
    check("back: ONE summary -- the notes once each, and one sound, the most important (approval)", sum && sum.notes === 3 && sum.lines[0] === "Reconnected." && sum.lines[2] === "Planning engine needs you: A step waits for your approval." && sum.sound === "approval" && /^While you were away: Reconnected\. — and 2 more$/.test(sum.text), JSON.stringify(sum));
    check("  then nothing is held any more", h.held() === 0 && h.offer("toast", "y") === false);
    h.setState("away");
    check("  away with nothing happening -> no summary", h.setState("present") === null);
    h.setState("away"); h.offer("sound", "wake");
    check("  only a sound -> a summary with no notes, just the sound", (() => { const s = h.setState("present"); return s && s.notes === 0 && s.sound === "wake"; })());
  }

  section("the camera's frame rate, or none");
  {
    const R = (o) => L.rate(Object.assign({ on: true }, o));
    check("off -> 0 (let go)", L.rate({ on: false }).fps === 0 && L.rate({}).why === "off");
    check("  hidden / locked / another app's meeting -> 0", R({ hidden: true }).fps === 0 && R({ locked: true }).why === "locked" && R({ meeting: true }).why === "meeting");
    check("  energy saver: 0 when 'release in energy saver' (the default), else 2", R({ saver: true, releaseOnSaver: true }).fps === 0 && R({ saver: true, releaseOnSaver: false }).fps === 2);
    check("  on battery 2, nobody there 2, else 5", R({ battery: true }).fps === 2 && R({ state: "away" }).fps === 2 && R({ state: "looking" }).fps === 5 && R({}).fps === 5);
    check("  facing the bot with look and speak on (2026-10-22): 12 fps so the lips are seen moving, 8 on battery; still 0 when hidden / locked", R({ facing: true }).fps === 12 && R({ facing: true, battery: true }).fps === 8 && R({ facing: true, hidden: true }).fps === 0 && R({ facing: true, saver: true, releaseOnSaver: true }).fps === 0);
    const d = L.normPrefs(null);
    check("the switches: all off by default; 'release in energy saver' on; look and speak needs the camera", !d.cam && !d.speak && d.saver && !L.normPrefs({ speak: true }).speak && L.normPrefs('{"cam":true,"speak":true}').speak && L.normPrefs("garbage").cam === false);
  }

  section("is it the person speaking? lips and voice (2026-10-22: 'it does not always catch it right')");
  {
    const S = require("./look-speak-scenes.cjs");
    // a voice, frame by frame
    const F = (x, sr) => { const out = []; const n = Math.round(sr * 0.0427); for (let e = n; e <= x.length; e += n) out.push(L.vadFrame(x.subarray(e - n, e), sr)); return out; };
    const med = (a) => { const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
    const CL = S.clips(2), voice = (CL.en[0] && CL.en[0].pcm) || S.synthVoice(3, 3);
    const vf = F(S.scaleTo(voice, 0.05), 24000).filter((f) => f.level > 0.02), tf = F(S.typing(1, 6), 24000).filter((f) => f.level > 0.01), nf = F(S.roomNoise(2, 3, 0.03), 24000);
    check("vadFrame: a voice is periodic at its pitch and harmonic (voiced ~0.9, flatness ~0); typing's clicks and a fan are not", med(vf.map((f) => f.voiced)) > 0.7 && med(vf.map((f) => f.flat)) < 0.05 && med(tf.map((f) => f.voiced)) < 0.45 && med(nf.map((f) => f.flat)) > 0.3,
      JSON.stringify({ v: med(vf.map((f) => f.voiced)), vf: med(vf.map((f) => f.flat)), t: med(tf.map((f) => f.voiced)), n: med(nf.map((f) => f.flat)) }));
    check("  speechiness: voice frames mostly speech-like, typing and fan frames not", med(vf.map(L.speechiness)) >= 0.6 && med(tf.map(L.speechiness)) <= 0.1 && med(nf.map(L.speechiness)) === 0, JSON.stringify([med(vf.map(L.speechiness)), med(tf.map(L.speechiness))]));
    const up = new Float32Array(voice.length * 2); for (let i = 0; i < up.length; i++) up[i] = voice[i >> 1] * 0.05 / (S.rms(voice, 0, voice.length) || 1);
    const t48 = Date.now(), v48 = F(up, 48000).filter((f) => f.level > 0.02), ms48 = (Date.now() - t48) / Math.max(1, F(up, 48000).length);
    check("  the same at 48 kHz (a 2048-sample analyser), well under a millisecond a frame", med(v48.map((f) => f.voiced)) > 0.7 && ms48 < 2, ms48.toFixed(3) + " ms");
    check("  silence -> nothing", L.vadFrame(new Float32Array(1024), 24000).voiced === 0 && L.vadFrame(null, 24000).level === 0);
    // the mouth, as the model reports it
    const one = (o) => L.summarize(S.faceResult([{ ...S.LOOK, m: L.matrixOf(4, -8), jaw: 0.1, mc: 0.05, sm: 0.1, pk: 0.2, ...o }]))[0];
    const m0 = one({ lip: 0.3 });
    check("summarize: the mouth's numbers -- the inner lips' gap in nose lengths, mouthClose, smile, pucker -- and nothing more", m0.mouth && Math.abs(m0.mouth.lip - 0.3) < 0.02 && m0.mouth.mc === 0.05 && m0.mouth.sm === 0.1 && m0.mouth.pk === 0.2 && JSON.stringify(Object.keys(m0.mouth).sort()) === '["lip","mc","pk","sm"]', JSON.stringify(m0.mouth));
    check("  the gap is the same nearer / farther from the camera (a face twice as wide)", Math.abs(one({ lip: 0.3, w: 0.48 }).mouth.lip - 0.3) < 0.02);
    // the lips moving: talking, or not
    function lips(mouth, fps, ms) {
      const lm = L.createLipMotion(), r = S.rng(5); const out = [];
      for (let t = 0; t < (ms || 3000); t += 1000 / fps) {
        const m = mouth(t), g = () => (r() - 0.5) * 0.02;
        lm.push({ jaw: m.jaw + g(), mouth: { lip: Math.max(0, m.lip + g()), mc: m.mc || 0.05, sm: m.sm || 0.04, pk: m.pk || 0.06 } }, t);
        const sc = lm.score(t); if (t > 1000 && sc) out.push(sc.score);
      }
      return out;
    }
    const talk = (amp) => (t) => { const v = Math.abs(Math.sin((2 * Math.PI * 4 * t) / 1000 + Math.sin(t / 300))); return { lip: 0.01 + amp * v, jaw: 0.04 + amp * 0.7 * v }; };
    const mn = (a) => Math.min.apply(null, a), mx = (a) => Math.max.apply(null, a);
    check("lipMotion: talking (4 Hz) scores 'moving' with a small mouth and 'clearly' with a normal one, at 12 fps and at 5 fps", med(lips(talk(0.09), 12)) >= L.LIP.WEAK && med(lips(talk(0.09), 5)) >= L.LIP.WEAK && med(lips(talk(0.2), 12)) >= L.LIP.STRONG && med(lips(talk(0.2), 5)) >= L.LIP.STRONG,
      JSON.stringify([med(lips(talk(0.09), 12)), med(lips(talk(0.09), 5)), med(lips(talk(0.2), 12)), med(lips(talk(0.2), 5))]));
    check("  a still open mouth -> 0; a still closed one -> 0", mx(lips(() => ({ lip: 0.2, jaw: 0.3 }), 12)) < 0.25 && mx(lips(() => ({ lip: 0.01, jaw: 0.04 }), 12)) < 0.25);
    check("  chewing with the lips together (the jaw moves, mouthClose with it) -> under 'moving'", mx(lips((t) => { const c = 0.5 + 0.5 * Math.sin((2 * Math.PI * 1.5 * t) / 1000); return { lip: 0.012, jaw: 0.04 + 0.22 * c, mc: 0.05 + 0.35 * c }; }, 12)) < 0.25);
    const smile = lips((t) => { const s = Math.min(1, Math.max(0, (t - 1500) / 300)); return { lip: 0.012 + 0.06 * s, jaw: 0.04 + 0.05 * s, sm: 0.04 + 0.65 * s }; }, 12);
    check("  a smile (the lips part, the corners rise) -> under 'moving'", mx(smile) < 0.25, JSON.stringify(smile));
    const tr = L.createTracker({ bot: BOTPOS });
    let sn = null; for (let t = 0; t < 1500; t += 83) sn = tr.push(L.summarize(S.faceResult([{ ...S.LOOK, m: L.matrixOf(4, -8), ...talk(0.2)(t), mc: 0.05, sm: 0.04, pk: 0.06 }])), t);
    check("  the tracker's snapshot: lip (0..1), mouth (moving?), the learnt rest jitter", sn.lip >= 0.55 && sn.mouth === true && sn.lipRest > 0 && sn.lipRest < 0.05, JSON.stringify({ lip: sn.lip, mouth: sn.mouth, rest: sn.lipRest }));
    // the gate, fused, on whole scenes (the module's way: frames at its fps, the meter every 50 ms)
    const impl = (battery) => ({ L, fps: (s) => L.rate({ on: true, battery, state: s ? s.state : null, facing: !!(s && (s.facingNow || s.atBot)) }).fps, meter: (x, sr) => L.vadFrame(x, sr), procMs: 25 });
    const go = (kind, o, battery) => { const sc = S.scene(kind, Object.assign({ clip: voice, sec: 8, seed: 7 }, o), L); const r = S.simulate(sc, Object.assign(impl(battery), { seed: (o && o.seed) || 7 })); return { sc, r, on: sc.speech[0] && sc.speech[0].onMs, first: r.starts[0] }; };
    const sp = go("speak", { artic: "small" });
    check("they look and speak (a small mouth): a turn starts within ~0.4 s of their voice, at ~12 fps", sp.first != null && sp.first - sp.on <= 400 && sp.first - sp.on >= -150 && sp.r.fps > 10, JSON.stringify({ lat: sp.first - sp.on, fps: sp.r.fps }));
    const soft = go("speak", { level: 0.012 });
    check("  softly (a voice just over the room): it starts -- the lips clearly move", soft.first != null && soft.first - soft.on <= 600, soft.first - soft.on);
    const bat = go("speak", { artic: "small" }, true);
    check("  on battery (8 fps while facing): it starts", bat.first != null && bat.first - bat.on <= 600, bat.first - bat.on);
    const ot = go("speak-over-typing", {});
    check("  over their own typing: it starts at their voice, not at the keys", ot.first != null && ot.first >= ot.on - 150 && ot.first - ot.on <= 600, JSON.stringify(ot.r.starts) + " on " + ot.on);
    const tv = go("speak-over-tv", { otherLevel: 0.025, other: S.synthVoice(77, 8) });
    check("  over a TV that was already talking: it starts at THEIR voice (the lips and the sound move together), not before", tv.first != null && tv.first >= tv.on - 150 && tv.first - tv.on <= 900, JSON.stringify(tv.r.starts) + " on " + tv.on);
    ["typing", "typing-fast", "music", "tv", "tv-open", "tv-chew", "tv-smile", "tv-nod", "cough", "fan", "chew-open-typing"].forEach((k) => {
      const runs = [1, 2, 3].map((seed) => S.simulate(S.scene(k, { seed, sec: 10, other: S.synthVoice(40 + seed, 10) }, L), Object.assign(impl(false), { seed })).starts.length);
      check("  not speaking -- " + k + " -> no turn", runs.every((n) => n === 0), JSON.stringify(runs));
    });
    // no mouth in view (a face model without blendshapes): a clear voice alone, as before
    const g = L.createSpeakGate(), lk = { state: "looking", atBot: true, speak: true, others: 0, mouth: null };
    let st = null; g.vision(lk, 0); g.vision(lk, 700);
    const x = S.scaleTo(voice, 0.05);
    for (let t = 700, i = 0; t < 3000; t += 50) { g.vision(lk, t); const e = Math.round(((t - 700) / 1000) * 24000); if (e >= 1024 && e <= x.length && g.audio(L.vadFrame(x.subarray(e - 1024, e), 24000), t, false) === "start" && st === null) st = t; }
    check("  no mouth in view (no blendshapes): a clear voice alone starts it, as before", st !== null, st);
    const g2 = L.createSpeakGate(), still = { state: "looking", atBot: true, speak: true, others: 0, mouth: false, lip: 0 };
    let st2 = null; g2.vision(still, 0); g2.vision(still, 700);
    for (let t = 700; t < 3000; t += 50) { g2.vision(still, t); const e = Math.round(((t - 700) / 1000) * 24000); if (e >= 1024 && e <= x.length && g2.audio(L.vadFrame(x.subarray(e - 1024, e), 24000), t, false) === "start") st2 = t; }
    check("  their mouth in view and still: a voice alone never starts it (a TV, someone off camera)", st2 === null, st2);
    const s3 = g.status();
    check("'Show what it sees' gets the new numbers: lip score, voice (VAD), voiced, the two in step, the fused decision -- numbers and booleans only",
      ["lip", "lipNeed", "vad", "voiced", "speechy", "sync", "syncNeed", "fused", "level", "need"].every((k) => k in s3) && Object.values(s3).every((v) => v === null || ["number", "boolean"].includes(typeof v)), JSON.stringify(s3));
  }

  section("core E: dozing follows presence while the camera is on");
  {
    const dz = (o) => BOT.dozeWanted(Object.assign({ state: "idle", quietMs: 0, hour: 14 }, o));
    check("camera off (no presence): the 10-minute timer as before", !dz({ quietMs: 9 * 60000 }) && dz({ quietMs: 10 * 60000 }));
    check("  away -> dozes at once (the state machine already waited 8 s)", dz({ presence: "away" }));
    check("  looking -> never, even after an hour or at night", !dz({ presence: "looking", quietMs: 3600000 }) && !dz({ presence: "looking", quietMs: 3600000, hour: 2 }));
    check("  here, not looking: no timer by day; the night rule (a quiet minute) still holds", !dz({ presence: "present", quietMs: 3600000 }) && dz({ presence: "present", quietMs: 61000, hour: 23 }) && !dz({ presence: "present", quietMs: 30000, hour: 23 }));
    check("  never while working, offline, or the pointer near", !dz({ presence: "away", state: "thinking" }) && !dz({ presence: "away", offline: true }) && !dz({ presence: "away", near: true }));
  }

  section("which camera: Automatic and the fallbacks (realistic Windows lists)");
  {
    const v = (id, label) => ({ kind: "videoinput", deviceId: id, label, groupId: "g" + id });
    const mic = { kind: "audioinput", deviceId: "m1", label: "Microphone Array (Realtek(R) Audio)" };
    const phone = [mic, v("p", "Connected Camera (Phone Link)"), v("w", "Integrated Webcam (0c45:6a1d)")];
    check("Phone Link first in the list + the Integrated Webcam -> the webcam", L.pickCamera(phone, null).id === "w" && L.pickCamera(phone, null).how === "auto");
    const ltw = [v("l", "Link to Windows Camera"), v("h", "HD User Facing (04f2:b6dd)")];
    check("  'Link to Windows' + 'HD User Facing' -> HD User Facing", L.pickCamera(ltw, null).id === "h");
    const ir = [v("i", "Integrated IR Camera"), v("r", "Integrated Camera (04f2:b71a)")];
    check("an IR camera listed first + the RGB one -> the RGB one", L.pickCamera(ir, null).id === "r");
    check("  only an IR camera -> it (nothing else)", L.pickCamera([v("i", "Integrated IR Camera")], null).id === "i");
    check("  IR and a phone -> the IR camera before the phone", L.pickCamera([v("p", "Phone Link"), v("i", "Integrated IR Camera")], null).id === "i");
    const virt = [v("o", "OBS Virtual Camera")];
    check("only a virtual camera -> it (better than nothing)", L.pickCamera(virt, null).id === "o" && L.pickCamera(virt, null).how === "auto");
    const many = [v("o", "OBS Virtual Camera"), v("n", "NVIDIA Broadcast"), v("d", "DroidCam Source 3"), v("c", "Camo"), v("e", "EpocCam"), v("u", "Iriun Webcam"), v("s", "Snap Camera"), v("x", "Windows Virtual Camera"), v("k", "Continuity Camera"), v("g", "Logitech BRIO")];
    check("  every phone / virtual name avoided: OBS, NVIDIA Broadcast, DroidCam, Camo, EpocCam, Iriun, Snap, Windows Virtual, Continuity -> the Logitech", L.pickCamera(many, null).id === "g" && many.slice(0, 9).every((d) => L.cameraKind(d.label) === "virtual"), many.map((d) => d.label + ":" + L.cameraKind(d.label)).join(", "));
    check("  'Iriun' is not an IR camera, 'firmware' words are not IR", L.cameraKind("Iriun Webcam") === "virtual" && L.cameraKind("USB Camera Firmware IRIS") !== "ir" && L.cameraKind("Integrated IR Camera") === "ir");
    check("a built-in camera first, another real one next (a USB webcam plugged in keeps the built-in)", L.pickCamera([v("g", "Logitech C920"), v("w", "Integrated Webcam")], null).id === "w" && L.pickCamera([v("p", "Phone Link"), v("g", "Logitech C920")], null).id === "g");
    check("a stored choice wins, even a phone", L.pickCamera(phone, { id: "p", label: "Connected Camera (Phone Link)" }).id === "p" && L.pickCamera(phone, { id: "p", label: "x" }).how === "chosen");
    const re = [v("new-id", "Integrated Webcam (0c45:6a1d)"), v("p", "Connected Camera (Phone Link)")];
    const cl = L.pickCamera(re, { id: "old-id", label: "Integrated Webcam (0c45:6a1d)" });
    check("  the same camera under a new deviceId: found by its name", cl.id === "new-id" && cl.how === "chosen-label" && !cl.note, JSON.stringify(cl));
    check("  ... the name without Windows' USB ids matches too", L.pickCamera(re, { id: "old", label: "Integrated Webcam" }).id === "new-id");
    const gone = L.pickCamera(phone, { id: "c920", label: "Logitech C920" });
    check("a removed camera: Automatic (the webcam), and the note says so", gone.id === "w" && gone.how === "auto" && gone.note === "Logitech C920 is not connected — using Automatic", JSON.stringify(gone));
    const fail = L.pickCamera(phone, { id: "w", label: "Integrated Webcam (0c45:6a1d)" }, { avoid: ["w"] });
    check("  the chosen camera failed to open: the next best, and the note says it could not be opened", fail.id === "p" && /could not be opened — using Automatic/.test(fail.note), JSON.stringify(fail));
    const nolab = [v("", ""), { kind: "audioinput", deviceId: "", label: "" }];
    const nl = L.pickCamera(nolab, null);
    check("before the camera was ever allowed (no names, no ids): no deviceId -- the browser's default, decided again once the names show", nl.id === null && nl.how === "default");
    check("no camera at all: the default (the camera module then says 'no camera')", L.pickCamera([mic], null).id === null);
    check("the pill's short name: no USB ids, at most 26 characters", L.shortCam("Integrated Webcam (0c45:6a1d)") === "Integrated Webcam" && L.shortCam("Microsoft® LifeCam HD-3000 Very Long Model Name").length <= 26);
    check("the stored choice is checked: {id,label} only, junk -> Automatic", JSON.stringify(L.normCamChoice('{"id":"a","label":"b","x":1}')) === '{"id":"a","label":"b"}' && L.normCamChoice("nope") === null && L.normCamChoice({}) === null && L.normCamChoice(null) === null);
  }

  section("the wiring");
  {
    const views = fs.readFileSync(path.join(ROOT, "lib", "views-joyaai.js"), "utf8");
    const lists = views.match(/\["(?:joya-desktop-webauthn|voice-live\.css)[^\]]+\]/g) || [];
    check("both Command Center pages load the logic, the camera module, its binding and CSS (desktop render mode and browser)", lists.length === 2 && lists.every((l) => /"joya-presence\.css", "joya-presence-logic\.js", "joya-presence\.js", "joya-presence-bind\.js"/.test(l)), lists.length);
    const vend = path.join(ROOT, "public", "vendor", "mediapipe");
    const need = ["tasks-vision-0.10.21/vision_bundle.js", "tasks-vision-0.10.21/wasm/vision_wasm_internal.js", "tasks-vision-0.10.21/wasm/vision_wasm_internal.wasm", "models/face_landmarker-float16-v1.task", "LICENSE-Apache-2.0.txt", "README.md"];
    check("the face model and its runtime are vendored, pinned, with the licence and checksums", need.every((f) => fs.existsSync(path.join(vend, f))), need.filter((f) => !fs.existsSync(path.join(vend, f))));
    const readme = fs.existsSync(path.join(vend, "README.md")) ? fs.readFileSync(path.join(vend, "README.md"), "utf8") : "";
    const crypto = require("crypto");
    const sums = need.slice(0, 4).map((f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(vend, f))).digest("hex"));
    check("  README's sha256 match the files", sums.every((h) => readme.includes(h)));
    const pres = fs.readFileSync(path.join(ROOT, "public", "joya-presence.js"), "utf8"), wk = fs.readFileSync(path.join(ROOT, "public", "joya-presence-worker.js"), "utf8"), lg = fs.readFileSync(path.join(ROOT, "public", "joya-presence-logic.js"), "utf8");
    check("  the camera module, its worker and its logic (the lips, the voice) make no request of their own (no fetch / XHR / WebSocket / beacon)", ![pres, wk, lg].some((s) => /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))));
    const sett = fs.readFileSync(path.join(D, "src-tauri", "src", "settings.rs"), "utf8"), lib = fs.readFileSync(path.join(D, "src-tauri", "src", "lib.rs"), "utf8");
    const remote = JSON.parse(fs.readFileSync(path.join(D, "src-tauri", "capabilities", "remote.json"), "utf8"));
    check("the app: a presence setting (off by default, presence.rs); the site may say it holds the camera and switch it off -- no command switches it on", /pub presence: crate::presence::Presence/.test(sett) && remote.permissions.includes("allow-presence-off") && remote.permissions.includes("allow-presence-status") && !remote.permissions.some((p) => /presence-on|settings-set/.test(p)));
    check("  the camera request goes through presence::permission; the profile's stored permission follows the setting; a request is never saved", /presence::permission\(ask, ours, camera_on\)/.test(lib) && /SetPermissionState\(COREWEBVIEW2_PERMISSION_KIND_CAMERA/.test(lib) && /SetSavesInProfile\(false\)/.test(lib));
    check("  the tray has the 'Camera presence' switch", /CheckMenuItem::with_id\(app, "presence"/.test(lib));
  }

  section("in the browser (a fake camera)");
  {
    let chromium;
    try { ({ chromium } = require(process.env.PLAYWRIGHT || "playwright")); } catch (e) { chromium = null; }
    if (!chromium) { check("playwright is available (set PLAYWRIGHT)", false); }
    else {
      const s = await scratch.startScratch({});
      let browser = null;
      try {
        await s.makeUser("eyes", "administrator");
        const { cookie } = await s.signIn("eyes");
        const ORIGIN = "http://127.0.0.1:" + s.port;
        const wr = await s.req("GET", "/static/joya-presence-worker.js", { cookie });
        const wcsp = String((wr.headers && wr.headers["content-security-policy"]) || "");
        const pg = await s.req("GET", "/joya-ai", { cookie });
        const pcsp = String((pg.headers && pg.headers["content-security-policy"]) || "");
        check("the worker has its own policy: WebAssembly yes, eval of JavaScript no, this site only", /script-src 'self' 'wasm-unsafe-eval'/.test(wcsp) && /connect-src 'self'/.test(wcsp) && !/unsafe-eval'(?!.*wasm)/.test(wcsp.replace("'wasm-unsafe-eval'", "")), wcsp);
        check("  the pages keep theirs (no wasm, no eval)", /script-src 'self'/.test(pcsp) && !/unsafe-eval/.test(pcsp), pcsp);
        browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream=device-count=3", "--use-fake-ui-for-media-stream", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
        async function open(o) {
          o = o || {};
          const ctx = o.ctx || await browser.newContext({ viewport: { width: o.W || 1280, height: o.H || 800 }, screen: o.screen, reducedMotion: o.reduce ? "reduce" : "no-preference", colorScheme: o.scheme || "light", userAgent: o.ua, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, permissions: ["camera", "microphone"] });
          if (!o.ctx) await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
          const reqs = [];
          ctx.on("request", (r) => { const b = r.postDataBuffer(); reqs.push({ url: r.url(), method: r.method(), type: r.resourceType(), body: b ? b.length : 0, txt: b ? b.toString("latin1") : "", hdr: JSON.stringify(r.headers()), img: b ? /data:image|\x89PNG|\xff\xd8\xff|JFIF|RIFF....WEBP/.test(b.toString("latin1")) : false }); });
          const page = await ctx.newPage();
          const errs = [];
          page.on("pageerror", (e) => errs.push(e.message));
          page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource|^INFO: Created TensorFlow Lite/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
          page.on("worker", (w) => { w.on("console", (m) => { if (m.type() === "error" && !/^INFO: Created TensorFlow Lite/.test(m.text())) errs.push("worker: " + m.text()); }); });
          await page.addInitScript((a) => {
            window.__csp = [];
            document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
            // The camera asks and what became of each track (stopped = let go).
            window.__gum = [];
            const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
            if (a.cams) {
              // The fake cameras renamed like a laptop's (a.cams[i] for fake_device_i); a.hide: ids not listed (unplugged);
              // a.noLabels: names and ids hidden until the camera has been allowed once in this page (as before a first permission).
              const en = md.enumerateDevices.bind(md);
              window.__hide = a.hide || [];
              md.enumerateDevices = () => en().then((l) => l.map((d) => {
                if (d.kind !== "videoinput") return d;
                const m = /fake_device_(\d+)/.exec(d.label), lab = m && a.cams[+m[1]] != null ? a.cams[+m[1]] : d.label;
                const blind = a.noLabels && !window.__gum.some((g) => g.video);
                return { kind: d.kind, deviceId: blind ? "" : d.deviceId, groupId: d.groupId, label: blind ? "" : lab, toJSON() { return this; } };
              }).filter((d) => !window.__hide.includes(d.deviceId)));
            }
            md.getUserMedia = (c) => orig(c).then((st) => { const vt = st.getVideoTracks()[0]; const rec = { c: JSON.parse(JSON.stringify(c)), dev: vt && vt.getSettings ? vt.getSettings().deviceId : "", video: !!c.video, audio: !!c.audio, tracks: st.getTracks().map((t) => ({ kind: t.kind, on: true })) }; st.getTracks().forEach((t, i) => { const stop = t.stop.bind(t); t.stop = () => { rec.tracks[i].on = false; stop(); }; }); window.__gum.push(rec); return st; });
            window.__camOpen = () => window.__gum.filter((g) => g.video && g.tracks.some((t) => t.on)).length;
            if (a.prefs) try { localStorage.setItem("joya-presence", JSON.stringify(a.prefs)); } catch (e) { /* no storage */ }
            if (a.fake) {
              // A stand-in camera module: the page's side driven with chosen states (the real one needs a face).
              const subs = [];
              let hooks = {};
              window.JoyaPresence = { configure: (c) => { window.__mpCfg = c; }, on: (f) => subs.push(f), snapshot: () => ({}), hooks: (h) => { hooks = h; }, release: () => {}, turnEnded: () => {}, diag: () => ({}) };
              window.__mp = { emit: (s) => subs.forEach((f) => f(s)), hooks: () => hooks };
            }
            if (a.fakeWorker) {
              // The real camera module on the fake camera, with a stand-in face model: each frame answers what the test
              // puts in window.__faces (the worker's own summary records), and the microphone meter reads window.__level.
              const RW = window.Worker;
              window.__faces = [];
              window.Worker = function (url, opts) {
                if (!/joya-presence-worker/.test(String(url))) return new RW(url, opts);
                const w = { onmessage: null, onerror: null, dead: false, terminate() { w.dead = true; }, postMessage(m) {
                  if (w.dead || !m) return;
                  if (m.type === "init") setTimeout(() => { if (!w.dead && w.onmessage) w.onmessage({ data: { type: "ready" } }); }, 10);
                  else if (m.type === "frame") { if (m.bmp && m.bmp.close) m.bmp.close(); const f = typeof window.__faces === "function" ? window.__faces() : window.__faces; setTimeout(() => { if (!w.dead && w.onmessage) w.onmessage({ data: { type: "faces", faces: f, ms: 3 } }); }, 5); }
                } };
                return w;
              };
              window.__level = 0;
              // a voice at window.__level: a 140 Hz tone with its harmonics (the meter checks it is voiced, not just loud)
              AnalyserNode.prototype.getFloatTimeDomainData = function (buf) { const sr = this.context.sampleRate; for (let i = 0; i < buf.length; i++) { let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * 140 * h * i) / sr) / h; buf[i] = v * 0.8 * window.__level; } };
            }
            if (a.tauri) {
              window.__calls = [];
              const Lz = (window.__listeners = {});
              window.__TAURI__ = { core: { invoke: (cmd, args) => { window.__calls.push([cmd, args || {}]); return Promise.resolve(cmd === "get_state" ? a.tauri : null); } }, event: { listen: (n, f) => { (Lz[n] = Lz[n] || []).push(f); return Promise.resolve(() => {}); } } };
              window.__emit = (n, p) => (Lz[n] || []).forEach((f) => f({ payload: p }));
            }
          }, o);
          if (o.camChoice !== undefined) await page.addInitScript((v) => { try { if (v) localStorage.setItem("joya-presence-camera", JSON.stringify(v)); else localStorage.removeItem("joya-presence-camera"); } catch (e) { /* no storage */ } }, o.camChoice);
          await page.goto(ORIGIN + (o.path || "/joya-ai"), { waitUntil: "load" });
          await page.waitForTimeout(o.wait || 1500);
          return { ctx, page, errs, reqs };
        }
        const isStaticOk = (u) => { const x = new URL(u); return x.origin === ORIGIN; };

        before: { if (process.env.MP_IND_ONLY) break before; // (MP_IND_ONLY=1: only the indications, while working on them)
        // 1. Off by default: the camera is never asked for.
        const a = await open({ wait: 3000 });
        const off = await a.page.evaluate(() => ({ gum: window.__gum.length, pill: !!document.getElementById("mp-cam"), snap: window.JoyaPresence && window.JoyaPresence.snapshot(), worker: window.JoyaPresence.diag().worker }));
        check("off by default: the camera is never asked for, no worker, no indicator, the state unknown (null)", off.gum === 0 && !off.pill && !off.worker && off.snap.state === null && off.snap.camera === false, JSON.stringify(off));
        const offPaths = new Set(a.reqs.map((r) => new URL(r.url).pathname));
        check("  nothing of the face model is even downloaded", ![...offPaths].some((p) => /vendor\/mediapipe|joya-presence-worker/.test(p)), [...offPaths].filter((p) => /presence|mediapipe/.test(p)).join(", "));
        await a.ctx.close();

        // 2. Switched on in this browser: the model runs on the camera's frames, in its worker.
        const b = await open({ prefs: { cam: true }, wait: 500 });
        let d = null;
        for (let i = 0; i < 60; i++) { await b.page.waitForTimeout(500); d = await b.page.evaluate(() => window.JoyaPresence.diag()); if (d.frames >= 8) break; }
        const st1 = await b.page.evaluate(() => ({ gum: window.__gum.map((g) => ({ v: g.video, a: g.audio })), open: window.__camOpen(), pill: !!document.getElementById("mp-cam"), cls: document.documentElement.classList.contains("mp-cam-on"), snap: window.JoyaPresence.snapshot() }));
        check("switched on: the camera opens (video only), the face model loads in its worker and reads frames", st1.open === 1 && st1.gum.length === 1 && st1.gum[0].v && !st1.gum[0].a && d && d.ready && d.frames >= 8, JSON.stringify({ st1, d }));
        check("  the 'Camera on' indicator shows while it is open", st1.pill && st1.cls);
        check("  small and slow: about 5 frames a second, each read in the worker (" + (d && d.ms) + " ms for the last one)", d && d.fps === 5 && d.ms >= 0, JSON.stringify(d));
        check("  only the state leaves the module: the snapshot is { state, gaze, camera, why }", JSON.stringify(Object.keys(st1.snap).sort()) === JSON.stringify(["camera", "gaze", "state", "why"]) && st1.snap.camera === true);
        await b.page.waitForTimeout(9000);
        const awaySnap = await b.page.evaluate(() => window.JoyaPresence.snapshot());
        check("  the fake camera shows no one: after 8 s 'away'", awaySnap.state === "away", JSON.stringify(awaySnap));
        const tcam = b.reqs.length;
        await b.page.waitForTimeout(6000); // six more seconds of frames: what goes out meanwhile?
        const during = b.reqs.slice(tcam);
        check("no frame leaves: every request goes to this site; the model's files are GETs of its own static files", b.reqs.every((r) => isStaticOk(r.url)) && b.reqs.filter((r) => /presence|mediapipe/.test(r.url)).every((r) => r.method === "GET" && /^\/static\//.test(new URL(r.url).pathname)), JSON.stringify(b.reqs.filter((r) => !isStaticOk(r.url)).map((r) => r.url)));
        check("  ~30 frames read meanwhile and nothing sent for them: no request but the page's usual polling (GETs), no upload", during.every((r) => r.method === "GET" && /^\/joya-ai\/api\//.test(new URL(r.url).pathname)), JSON.stringify(during.map((r) => r.method + " " + new URL(r.url).pathname)));
        check("  no request body ever carries an image, and none is larger than a few kB", b.reqs.every((r) => !r.img && r.body < 4096), JSON.stringify(b.reqs.filter((r) => r.body).map((r) => [new URL(r.url).pathname, r.body])));
        await b.page.click("#mp-cam .mp-off");
        await b.page.waitForTimeout(300);
        const pk = await b.page.evaluate(() => ({ open: window.__camOpen(), pill: !!document.getElementById("mp-cam"), snap: window.JoyaPresence.snapshot(), d: window.JoyaPresence.diag(), ls: JSON.parse(localStorage.getItem("joya-presence") || "{}") }));
        check("the indicator's Off: the camera let go of at once (its track stopped), the worker ended, the indicator gone, the state null; off for this browser", pk.open === 0 && !pk.pill && pk.snap.state === null && !pk.d.worker && pk.ls.cam === false, JSON.stringify(pk));
        // on again, then off from Settings in another tab: the storage event
        await b.page.evaluate(() => { localStorage.setItem("joya-presence", JSON.stringify({ cam: true })); window.dispatchEvent(new StorageEvent("storage", { key: "joya-presence" })); });
        await b.page.waitForTimeout(1500);
        const tabs = await b.ctx.newPage();
        await tabs.goto(ORIGIN + "/joya-ai/settings/appearance", { waitUntil: "load" });
        await tabs.waitForTimeout(500);
        const before = await b.page.evaluate(() => window.__camOpen());
        await tabs.click("#mp-cam-row label.sw");
        await b.page.waitForTimeout(600);
        const after = await b.page.evaluate(() => window.__camOpen());
        check("  switched off in Settings (another tab): the open Command Center lets go of it at once", before === 1 && after === 0, before + " -> " + after);
        await tabs.click("#mp-cam-row label.sw"); // on again
        await b.page.waitForTimeout(1500);
        const again = await b.page.evaluate(() => window.__camOpen());
        await b.page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
        await b.page.waitForTimeout(3000);
        const brief = await b.page.evaluate(() => window.__camOpen());
        await b.page.waitForTimeout(7600);
        const hid = await b.page.evaluate(() => ({ open: window.__camOpen(), why: window.JoyaPresence.diag().why }));
        check("  on again, then the page hidden: kept through a quick switch away (3 s), let go after 10 s", again === 1 && brief === 1 && hid.open === 0 && hid.why === "hidden", JSON.stringify({ again, brief, hid }));
        const csp1 = await b.page.evaluate(() => window.__csp);
        check("no page errors, no CSP violations (the WebAssembly ran under the worker's own policy)", b.errs.length === 0 && csp1.length === 0, JSON.stringify(b.errs.concat(csp1)));
        await b.ctx.close();

        // the desktop app's render mode, the real module: the app's lock / meeting / energy saver let go of it
        const AH = { mode: "floating", peekOpen: true, presence: { camera: true, speak: false, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
        const ap = await open({ path: "/joya-ai?shell=desktop", ua: APP_UA, tauri: AH, W: 480, H: 860, wait: 3000 });
        const pv = (o) => Object.assign({}, AH.presence, o);
        const cam = () => ap.page.evaluate(() => ({ open: window.__camOpen(), why: window.JoyaPresence.diag().why, st: window.__calls.filter((c) => c[0] === "presence_status").map((c) => c[1].inUse) }));
        const a0 = await cam();
        check("in the app, on: the camera opens; the page tells the app (presence_status inUse)", a0.open === 1 && a0.st.includes(true), JSON.stringify(a0));
        const res = {};
        for (const [k, o] of [["locked", { locked: true }], ["meeting", { meeting: true }], ["energy saver", { energySaver: true }], ["off", { camera: false }]]) {
          await ap.page.evaluate((p) => window.__emit("joya://state", { presence: p }), pv(o));
          await ap.page.waitForTimeout(300);
          res[k] = await cam();
          await ap.page.evaluate((p) => window.__emit("joya://state", { presence: p }), pv({}));
          await ap.page.waitForTimeout(1800);
          res[k].back = (await cam()).open;
        }
        check("  the screen locked / another app's meeting / energy saver / switched off in the app: let go at once, and back after", ["locked", "meeting", "energy saver", "off"].every((k) => res[k].open === 0 && res[k].back === 1) && res.locked.why === "locked" && res.meeting.why === "meeting" && res["energy saver"].why === "energy saver" && res.off.why === "off", JSON.stringify(res));
        await ap.page.evaluate((p) => window.__emit("joya://state", { presence: p }), pv({ energySaver: true }));
        await ap.page.evaluate(() => window.__emit("joya://state", { presence: { camera: true, speak: false, releaseOnSaver: false, onBattery: true, energySaver: false, locked: false, meeting: false } }));
        await ap.page.waitForTimeout(1500);
        const bat = await ap.page.evaluate(() => window.JoyaPresence.diag());
        check("  on battery: kept, at 2 frames a second", bat.fps === 2, JSON.stringify(bat));
        check("  the app's last word was 'let go' -> it was told (presence_status false)", (await cam()).st.includes(false));
        // the "Camera on" pill in the app: its Off button shows and is a hit region (joya-desktop.js HIT), so a click reaches it
        await ap.page.evaluate((p) => window.__emit("joya://state", { presence: p }), pv({}));
        await ap.page.waitForTimeout(1800);
        const pl = await ap.page.evaluate(async () => {
          const pill = document.getElementById("mp-cam"), b = pill && pill.querySelector(".mp-off");
          if (!b) return { pill: !!pill };
          await new Promise((r) => setTimeout(r, 300));
          const q = b.getBoundingClientRect(), x = q.left + q.width / 2, y = q.top + q.height / 2;
          const regs = window.JoyaDesktop.regions();
          return { pill: true, shown: q.width > 0 && q.height > 0 && getComputedStyle(b).display !== "none", hit: regs.some((g) => x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h), top: document.elementFromPoint(x, y) === b };
        });
        check("  the \"Camera on\" pill in the app: its Off button shows and catches the mouse (a hit region, on top)", pl.pill && pl.shown && pl.hit && pl.top, JSON.stringify(pl));
        if (pl.shown) {
          await ap.page.evaluate(() => { window.__calls.length = 0; });
          await ap.page.click("#mp-cam .mp-off");
          await ap.page.waitForTimeout(200);
          const pc = await ap.page.evaluate(() => ({ off: window.__calls.some((c) => c[0] === "presence_off"), open: window.__camOpen() }));
          check("  a click on Off: the camera is let go and the app is told (presence_off)", pc.off && pc.open === 0, JSON.stringify(pc));
        }
        const csp3 = await ap.page.evaluate(() => window.__csp);
        check("  no page errors, no CSP violations", ap.errs.length === 0 && csp3.length === 0, JSON.stringify(ap.errs.concat(csp3)));
        await ap.ctx.close();

        // 3. Settings: the opt-in screen.
        const so = await open({ path: "/joya-ai/settings/appearance", wait: 800 });
        const set0 = await so.page.evaluate(() => { const b = document.getElementById("mp-set"); const q = (k) => b.querySelector('[data-mp="' + k + '"]'); return { has: !!b, text: b.textContent, cam: q("cam").checked, speak: q("speak").checked, saver: q("saver").checked, speakDis: q("speak").disabled }; });
        check("Settings > Appearance > Eye contact: a plain explanation, everything off (release in energy saver on), look and speak waits for the camera", set0.has && /No picture, video or face data is stored or sent anywhere/.test(set0.text) && !set0.cam && !set0.speak && set0.saver && set0.speakDis, JSON.stringify(set0).slice(0, 300));
        await so.page.click("#mp-cam-row label.sw");
        await so.page.waitForTimeout(150);
        const set1 = await so.page.evaluate(() => ({ ls: JSON.parse(localStorage.getItem("joya-presence")), note: document.getElementById("mp-note").textContent, gum: window.__gum.length }));
        check("  switched on: this browser's switch only (never sent), and the Settings page itself never opens the camera", set1.ls.cam === true && /browser asks you once/.test(set1.note) && set1.gum === 0, JSON.stringify(set1));
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await so.page.evaluate(() => { document.getElementById("mp-set").scrollIntoView({ block: "start" }); });
          await so.page.waitForTimeout(200);
          const el = await so.page.$("#mp-set");
          await el.screenshot({ path: path.join(SHOTS, "settings-opt-in.png") });
        }
        check("  no page errors on Settings", so.errs.length === 0, JSON.stringify(so.errs));
        await so.ctx.close();

        // 3b. Which camera: three fake cameras named like a laptop's (Phone Link first, as Windows lists it).
        const CAMS = ["Connected Camera (Phone Link)", "Integrated Webcam (0c45:6a1d)", "Integrated IR Camera"];
        const cc = await open({ prefs: { cam: true }, cams: CAMS, wait: 2500 });
        const ids = await cc.page.evaluate(() => navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind === "videoinput").map((d) => d.deviceId)));
        const camNow = (pg) => pg.page.evaluate(() => { const live = window.__gum.filter((g) => g.video && g.tracks.some((t) => t.on)); return { open: live.length, dev: live.length ? live[live.length - 1].dev : null, exact: live.length ? JSON.stringify(live[live.length - 1].c.video.deviceId || null) : null, pill: (document.querySelector("#mp-cam .mp-t") || {}).textContent || null, device: window.JoyaPresence.device(), why: window.JoyaPresence.snapshot().why }; });
        const c0 = await camNow(cc);
        check("which camera: three cameras, Phone Link listed first -> Automatic opens the Integrated Webcam, by deviceId exact", ids.length === 3 && c0.open === 1 && c0.dev === ids[1] && /"exact"/.test(c0.exact) && c0.device && c0.device.how === "auto", JSON.stringify({ ids, c0 }));
        check("  the pill names it: 'Camera on · Integrated Webcam'", c0.pill === "Camera on · Integrated Webcam", c0.pill);
        const st = (await open({ ctx: cc.ctx, path: "/joya-ai/settings/appearance", cams: CAMS, wait: 700 })).page;
        const sl = await st.evaluate(() => { const s = document.querySelector("[data-mp-camsel]"); return { opts: [...s.options].map((o) => o.textContent), val: s.value, hint: document.querySelector("[data-mp-camhint]").hidden, used: document.querySelector("[data-mp-camused]").textContent, gum: window.__gum ? window.__gum.length : 0, named: !!s.closest("form"), name: s.getAttribute("name") }; });
        check("the selector in Settings > Appearance > Eye contact: Automatic (naming its pick) + each camera by name, phone / IR marked; no hint (names known)", sl.opts[0] === "Automatic — Integrated Webcam" && sl.opts.slice(1).join("|") === "Connected Camera (Phone Link) (phone / virtual)|Integrated Webcam|Integrated IR Camera (infrared)" && sl.val === "" && sl.hint, JSON.stringify(sl));
        check("  it shows the camera in use; it is in no form and has no name (nothing to submit)", /Last used: Integrated Webcam \(automatic\)/.test(sl.used) && !sl.named && !sl.name, JSON.stringify(sl));
        // (Headless Chromium gives every page its own device ids -- the name fallback is what carries the choice over here.)
        await st.selectOption("[data-mp-camsel]", { label: "Connected Camera (Phone Link) (phone / virtual)" });
        await cc.page.waitForTimeout(2000);
        const c1 = await camNow(cc);
        const ls1 = await st.evaluate(() => JSON.parse(localStorage.getItem("joya-presence-camera")));
        check("choosing the phone: stored here (id + name), the open Command Center switches at once, the old camera let go", ls1.id && ls1.label === CAMS[0] && c1.open === 1 && c1.dev === ids[0] && /^chosen/.test(c1.device.how) && /^Camera on · Connected Camera/.test(c1.pill), JSON.stringify({ ls1, c1 }));
        await st.selectOption("[data-mp-camsel]", "");
        await cc.page.waitForTimeout(2000);
        const c2 = await camNow(cc);
        check("  back to Automatic: the choice forgotten, the webcam again", c2.open === 1 && c2.dev === ids[1] && (await st.evaluate(() => localStorage.getItem("joya-presence-camera"))) === null, JSON.stringify(c2));
        // unplugged: the webcam leaves the list (devicechange) -> the next best
        await cc.page.evaluate((id) => { window.__hide.push(id); navigator.mediaDevices.dispatchEvent(new Event("devicechange")); }, ids[1]);
        await cc.page.waitForTimeout(2000);
        const c3 = await camNow(cc);
        check("the camera in use unplugged (devicechange): the next best at once (the IR camera before the phone)", c3.open === 1 && c3.dev === ids[2], JSON.stringify(c3));
        await cc.page.evaluate(() => { window.__hide.length = 0; navigator.mediaDevices.dispatchEvent(new Event("devicechange")); });
        await cc.page.waitForTimeout(2000);
        check("  plugged back in: the webcam again", (await camNow(cc)).dev === ids[1]);
        const leak = cc.reqs.concat([]).filter((r) => ids.some((id) => (r.url + r.txt + r.hdr).includes(id)) || /Integrated|Phone Link|Connected Camera|joya-presence-camera|cam-used/.test(r.url + r.txt + r.hdr));
        check("no request carries a camera's name or id (URLs, bodies, headers of every request of both tabs)", leak.length === 0 && cc.reqs.length > 5, JSON.stringify(leak.map((r) => r.method + " " + r.url)));
        await cc.ctx.close();

        // a stale id with the same name; a camera that is gone; the names before the camera was ever allowed
        const sa = await open({ prefs: { cam: true }, cams: CAMS, camChoice: { id: "stale-id-from-last-week", label: "Integrated IR Camera" }, wait: 2500 });
        const ids2 = await sa.page.evaluate(() => navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind === "videoinput").map((d) => d.deviceId)));
        const s1 = await camNow(sa);
        check("a stored choice whose id changed: found by its name (the IR camera, as chosen)", s1.dev === ids2[2] && s1.device.how === "chosen-label" && !s1.why, JSON.stringify(s1));
        await sa.ctx.close();
        const gn = await open({ prefs: { cam: true }, cams: CAMS, camChoice: { id: "c920-id", label: "Logitech C920 (046d:082d)" }, wait: 2500 });
        const g1 = await camNow(gn);
        check("the chosen camera is gone: Automatic (the webcam); the state's why says so", g1.open === 1 && /Integrated Webcam/.test(g1.pill) && g1.why === "Logitech C920 is not connected — using Automatic", JSON.stringify(g1));
        const gs = (await open({ ctx: gn.ctx, path: "/joya-ai/settings/appearance", cams: CAMS, wait: 700 })).page;
        const gsv = await gs.evaluate(() => { const s = document.querySelector("[data-mp-camsel]"); const u = document.querySelector("[data-mp-camused]"); return { sel: s.options[s.selectedIndex].textContent, used: u.textContent, warn: u.classList.contains("warn") }; });
        check("  ... and Settings says so: 'Logitech C920 — not connected' selected, the note under it", gsv.sel === "Logitech C920 — not connected" && /Logitech C920 is not connected — using Automatic\. Last used: Integrated Webcam/.test(gsv.used) && gsv.warn, JSON.stringify(gsv));
        await gn.ctx.close();
        const nl = await open({ path: "/joya-ai/settings/appearance", cams: CAMS, noLabels: true, wait: 800 });
        const n0 = await nl.page.evaluate(() => ({ hint: !document.querySelector("[data-mp-camhint]").hidden, opts: document.querySelector("[data-mp-camsel]").options.length, gum: window.__gum.length }));
        check("names not known yet (never allowed), eye contact off: 'Allow the camera once to see the camera names', and the camera is NOT asked for", n0.hint && n0.opts === 1 && n0.gum === 0, JSON.stringify(n0));
        await nl.page.click("[data-mp-allow]");
        await nl.page.waitForTimeout(800);
        const n1 = await nl.page.evaluate(() => ({ hint: !document.querySelector("[data-mp-camhint]").hidden, opts: [...document.querySelector("[data-mp-camsel]").options].map((o) => o.textContent), gum: window.__gum.length, open: window.__camOpen() }));
        check("  the button: the camera asked for once and let go at once; the names listed", n1.gum === 1 && n1.open === 0 && !n1.hint && n1.opts.length === 4 && n1.opts[0] === "Automatic — Integrated Webcam", JSON.stringify(n1));
        await nl.ctx.close();
        const nl2 = await open({ path: "/joya-ai/settings/appearance", prefs: { cam: true }, cams: CAMS, noLabels: true, wait: 1200 });
        const n2 = await nl2.page.evaluate(() => ({ opts: document.querySelector("[data-mp-camsel]").options.length, gum: window.__gum.length, open: window.__camOpen() }));
        check("  eye contact on: asked by itself, released at once, names listed", n2.gum === 1 && n2.open === 0 && n2.opts === 4, JSON.stringify(n2));
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          for (const scheme of ["dark", "light"]) {
            const sh = await open({ path: "/joya-ai/settings/appearance", prefs: { cam: true }, cams: CAMS, scheme, W: 1100, H: 900, wait: 900 });
            await sh.page.evaluate(() => { localStorage.setItem("joya-presence-cam-used", JSON.stringify({ label: "Integrated Webcam", how: "auto", note: "", t: Date.now() })); document.getElementById("mp-camera-row").scrollIntoView({ block: "center" }); });
            await sh.page.waitForTimeout(3200);
            await (await sh.page.$("#mp-set")).screenshot({ path: path.join(SHOTS, "camera-selector-browser-" + scheme + ".png") });
            await sh.ctx.close();
          }
        }

        // look and speak with voice off (this scratch server has no voice key): said plainly, the mic never opened for it
        const vo = await open({ prefs: { cam: true, speak: true }, cams: CAMS, wait: 2500 });
        const v0 = await vo.page.evaluate(() => ({ pill: (document.querySelector("#mp-cam .mp-t") || {}).textContent, why: (document.querySelector("#mp-cam .mp-why") || {}).textContent, blocked: document.getElementById("mp-cam").classList.contains("mp-blocked"), look: window.JoyaPresence.look(), mics: window.__gum.filter((g) => g.audio).length, ok: window.__joyaLive.ok() }));
        check("voice off: the pill's hint says 'Look and speak waits: voice is off' (a quiet i on the pill, no nag); no microphone opened for it", v0.ok === false && v0.pill === "Camera on · Integrated Webcam" && /Look and speak waits: voice is off/.test(v0.why) && v0.blocked && v0.look.voice === false && v0.mics === 0, JSON.stringify(v0));
        const vs = (await open({ ctx: vo.ctx, path: "/joya-ai/settings/appearance", cams: CAMS, wait: 800 })).page;
        const vs0 = await vs.evaluate(() => ({ off: (document.querySelector("[data-mp-voiceoff]") || {}).textContent || "", link: (document.querySelector("[data-mp-voiceoff] a") || {}).href || "", gum: window.__gum.length }));
        check("  ... and Settings says so under Look and speak, with the way to switch voice on", /Look and speak needs voice, and voice is off/.test(vs0.off) && /\/joya-ai\/settings\/voice$/.test(vs0.link) && vs0.gum === 0, JSON.stringify(vs0));
        await vs.click("#mp-more > summary"); // "Show what it sees" sits under More since 2026-10-25
        await vs.click("[data-mp-show] summary");
        await vs.waitForTimeout(3500);
        const sw0 = await vs.evaluate(() => ({ rows: [...document.querySelectorAll("[data-mp-checks] li")].map((l) => l.className + ":" + l.querySelector("b").textContent + "=" + l.querySelector(".v").textContent), open: window.__camOpen(), note: document.querySelector("[data-mp-show-note]").textContent }));
        check("'Show what it sees': opened, the camera runs on that page and the checklist reads -- no face (the fake camera), voice ready ✗", sw0.open === 1 && sw0.rows.length === 8 && sw0.rows.some((r) => /^na:Lips moving=not seen yet/.test(r)) && sw0.rows.some((r) => /^na:Lips and voice together/.test(r)) && /^no:Face found=no face/.test(sw0.rows[0]) && sw0.rows.some((r) => /^no:Voice ready=voice is off/.test(r)) && sw0.rows.some((r) => /^ok:Cool-down=ready/.test(r)), JSON.stringify(sw0));
        if (SHOTS) {
          await vs.evaluate(() => document.getElementById("mp-show-row").scrollIntoView({ block: "center" }));
          await vs.waitForTimeout(300);
          await (await vs.$("#mp-speak-row")).screenshot({ path: path.join(SHOTS, "look-and-speak-voice-off.png") });
          await (await vs.$("#mp-show-row")).screenshot({ path: path.join(SHOTS, "show-what-it-sees.png") });
        }
        await vs.click("[data-mp-show] summary");
        await vs.waitForTimeout(500);
        check("  closed: the camera let go at once", (await vs.evaluate(() => window.__camOpen())) === 0);
        const vleak = vo.reqs.filter((r) => r.method !== "GET" && /presence|camera|look|level|face|lip|mouth|vad|voiced|sync/i.test(r.url + r.txt));
        check("  nothing of it is sent: no request names the camera, a level or a face", vleak.length === 0, JSON.stringify(vleak.map((r) => r.method + " " + r.url)));
        await vo.ctx.close();

        // the app's render mode, the real module: the choice made in the page's Settings is followed there too
        const AP2 = { mode: "floating", peekOpen: true, presence: { camera: true, speak: false, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
        const dsk = await open({ path: "/joya-ai?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, W: 480, H: 860, wait: 3000 });
        const d0 = await camNow(dsk);
        check("in the app (?shell=desktop): Automatic opens the webcam, the pill says so", d0.open === 1 && /Integrated Webcam/.test(d0.pill) && d0.device.how === "auto", JSON.stringify(d0));
        const dset = await open({ ctx: dsk.ctx, path: "/joya-ai/settings/appearance?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, wait: 1000 });
        const ds = await dset.page.evaluate(() => { const s = document.querySelector("[data-mp-camsel]"); return { app: document.getElementById("mp-set").classList.contains("mp-app"), dis: s.disabled, opts: s.options.length, scope: document.querySelector("#mp-camera-row .scope") ? document.querySelector("#mp-camera-row .scope").textContent : "" }; });
        check("  the app's Settings page: the selector works there too (not read-only like the switches), 'this computer'", ds.app && !ds.dis && ds.opts === 4 && /this computer/.test(ds.scope), JSON.stringify(ds));
        const pid = await dsk.page.evaluate(() => navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind === "videoinput")[0].deviceId));
        await dset.page.selectOption("[data-mp-camsel]", { label: "Connected Camera (Phone Link) (phone / virtual)" });
        await dsk.page.waitForTimeout(2000);
        const d1 = await camNow(dsk);
        check("  chosen there: the app's Command Center switches at once", d1.open === 1 && d1.dev === pid && /^chosen/.test(d1.device.how) && /Connected Camera/.test(d1.pill), JSON.stringify(d1));
        if (SHOTS) {
          await dset.page.selectOption("[data-mp-camsel]", "");
          await dset.page.close();
          for (const scheme of ["dark", "light"]) {
            const sh = await open({ path: "/joya-ai/settings/appearance?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, scheme, W: 760, H: 900, wait: 900 });
            await sh.page.evaluate(() => { localStorage.setItem("joya-presence-cam-used", JSON.stringify({ label: "Integrated Webcam", how: "auto", note: "", t: Date.now() })); document.getElementById("mp-camera-row").scrollIntoView({ block: "center" }); });
            await sh.page.waitForTimeout(3200);
            await sh.page.screenshot({ path: path.join(SHOTS, "camera-selector-app-" + scheme + ".png") });
            await sh.ctx.close();
            const pc = await open({ path: "/joya-ai?shell=desktop", ua: APP_UA, tauri: AP2, cams: CAMS, scheme, W: 480, H: 300, wait: 3000 });
            await pc.page.screenshot({ path: path.join(SHOTS, "camera-pill-app-" + scheme + ".png"), clip: { x: 0, y: 0, width: 300, height: 40 } });
            await pc.ctx.close();
          }
        }
        check("  no page errors (the app's pages)", dsk.errs.length === 0 && dset.errs.length === 0, JSON.stringify(dsk.errs.concat(dset.errs)));
        await dsk.ctx.close();

        // 4. The desktop app's render mode with a stand-in camera module: what the page does with the state.
        const HOST = { mode: "floating", peekOpen: true, glance: true, presence: { camera: true, speak: true, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
        const dk = await open({ path: "/joya-ai?shell=desktop", ua: APP_UA, fake: true, tauri: HOST, W: 480, H: 860, wait: 1500 });
        const cfg = await dk.page.evaluate(() => window.__mpCfg);
        check("the app's setting reaches the module (camera + look and speak on, the app's power / lock state)", cfg && cfg.prefs.cam === true && cfg.prefs.speak === true && cfg.host.locked === false && cfg.bot && isFinite(cfg.bot.x), JSON.stringify(cfg));
        await dk.page.evaluate(() => window.__emit("joya://state", { presence: { camera: true, speak: false, releaseOnSaver: true, onBattery: true, energySaver: true, locked: true, meeting: false } }));
        const cfg2 = await dk.page.evaluate(() => window.__mpCfg);
        check("  the app's lock / battery / energy saver follow (joya://state)", cfg2.host.locked && cfg2.host.battery && cfg2.host.saver && !cfg2.prefs.speak, JSON.stringify(cfg2));
        await dk.page.evaluate(() => { window.__joyaCC.orbit.setConcept("E"); });
        await dk.page.waitForTimeout(400);
        const eyes = await dk.page.evaluate(async () => {
          const k = window.__joyaCC.core;
          window.__mp.emit({ state: "looking", gaze: { x: 0.75, y: -0.5 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          const a = { presence: k.S.presence, contact: k.S.contact, gx: k._anim().gx, gy: k._anim().gy, cls: document.documentElement.className };
          window.__mp.emit({ state: "looking", gaze: { x: -0.75, y: -0.5 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          a.gx2 = k._anim().gx;
          return a;
        });
        check("the bot meets your eyes: core E gets the state and the direction; its eyes go there and follow when you move", eyes.presence === "looking" && eyes.contact && eyes.gx > 1 && Math.round(eyes.gy) === -1 && eyes.gx2 < -1, JSON.stringify(eyes));
        check("  html says 'looking' (the glance cards come forward)", /\bmp-looking\b/.test(eyes.cls));
        const away = await dk.page.evaluate(async () => {
          const k = window.__joyaCC.core;
          k.setOffline(false); k.setOffline = () => {}; k.setState("idle"); // (no supervisor here: the page would show the core offline, and an offline bot never dozes)
          window.__mp.emit({ state: "away", gaze: null, camera: true });
          await new Promise((r) => setTimeout(r, 1500));
          const r = { dozeT: k.S.dozeT, contact: k.S.contact, cls: document.documentElement.className };
          // held while away
          const st0 = window.__calls.filter((c) => c[0] === "presence_status" && c[1].inUse === true).length; // told once that the camera is in use (only changes are sent)
          window.__calls.length = 0;
          const held1 = window.JoyaPresenceHold.toast("Planning engine finished");
          const held2 = window.JoyaPresenceHold.native({ title: "Invoice audit needs you", body: "A step waits." });
          const snd = window.JoyaSound ? window.JoyaSound.play("approval", { role: "core" }) : null;
          r.held = [held1, held2, snd && snd.why];
          r.toasts = document.querySelectorAll(".cc-toast").length;
          window.__mp.emit({ state: "looking", gaze: { x: 0, y: -0.25 }, camera: true });
          await new Promise((r2) => setTimeout(r2, 250));
          r.awake = k.S.dozeT; r.lookUp = k.S.lookUpUntil > k.S.t;
          const sum = document.getElementById("mp-sum");
          r.sum = sum ? sum.textContent : null;
          r.native = window.__calls.filter((c) => c[0] === "needs_you").map((c) => c[1].title);
          r.status = st0 + window.__calls.filter((c) => c[0] === "presence_status").length;
          return r;
        });
        check("you walk away: the bot dozes (presence instead of the timer), its eyes have nowhere to go", away.dozeT === 1 && away.contact === null && /\bmp-away\b/.test(away.cls), JSON.stringify(away));
        check("  meanwhile a toast, a Windows toast and a sound are held (nothing shown or played)", away.held[0] === true && away.held[1] === true && away.held[2] === "away" && away.toasts === 0, JSON.stringify(away.held));
        check("  back: it wakes and looks up; ONE summary with both notes, one Windows toast for it", away.awake === 0 && away.lookUp && away.sum && /While you were away · 2/.test(away.sum) && /Planning engine finished/.test(away.sum) && /Invoice audit needs you/.test(away.sum) && away.native.length === 1 && away.native[0] === "While you were away", JSON.stringify(away));
        // the glance cards: dimmed while not looking
        const gl = await dk.page.evaluate(async () => {
          const g = document.getElementById("dk-glance");
          if (!g) return null;
          document.documentElement.classList.add("mp-cam-on");
          window.__mp.emit({ state: "present", gaze: { x: 0, y: 0 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          const dim = getComputedStyle(g).opacity;
          window.__mp.emit({ state: "looking", gaze: { x: 0, y: 0 }, camera: true });
          await new Promise((r) => setTimeout(r, 700));
          return { dim: Number(dim), full: Number(getComputedStyle(g).opacity) };
        });
        check("the glance cards step back while you look elsewhere and come forward when you look at this screen", gl && gl.dim < 0.5 && gl.full === 1, JSON.stringify(gl));
        // look and speak + a reply's pause, through the hooks
        const hk = await dk.page.evaluate(() => {
          const h = window.__mp.hooks();
          const lv = window.__joyaLive;
          const r = { hooks: Object.keys(h).sort().join(","), busy: h.busy(), speaking: h.speaking() };
          let called = 0; const orig = lv.lookTalk; lv.lookTalk = () => { called++; return true; };
          h.speak(); r.speak = called; lv.lookTalk = orig;
          let paused = []; const cc = window.__joyaCC, op = cc.pauseSpeaking; cc.pauseSpeaking = (on) => { paused.push(on); return true; };
          h.pause(true); h.pause(false); cc.pauseSpeaking = op; r.paused = paused;
          r.lookTalk = typeof lv.lookTalk === "function" && typeof lv.busy === "function";
          r.vl = typeof window.VoiceLive.pause === "function";
          return r;
        });
        check("look and speak and a reply's pause are wired to the voice: lookTalk on the hold-to-talk path (+ feed, warm), VoiceLive.pause, the read-aloud pause", hk.hooks === "busy,feed,ind,listening,off,pause,ready,speak,speaking,warm" && hk.speak === 1 && JSON.stringify(hk.paused) === "[true,false]" && hk.lookTalk && hk.vl && hk.busy === false, JSON.stringify(hk));
        const offc = await dk.page.evaluate(() => { window.__calls.length = 0; window.__mp.hooks().off(); return window.__calls.map((c) => c[0]); });
        check("  in the app the page's Off asks the app (presence_off); camera use is reported (presence_status)", offc.includes("presence_off") && away.status >= 1, JSON.stringify(offc));
        const csp2 = await dk.page.evaluate(() => window.__csp);
        check("  no page errors, no CSP violations", dk.errs.length === 0 && csp2.length === 0, JSON.stringify(dk.errs.concat(csp2)));
        await dk.ctx.close();

        } // before
        // 4b. The indications (2026-10-21): the real module on a synthetic face stream, in the app's every layout and in a browser.
        {
          const LAYM = require(path.join(ROOT, "public", "joya-desktop-layout.js"));
          const SCREEN = { width: 1920, height: 1080 };
          const IH = { mode: "floating", size: "M", peekOpen: true, glance: false, presence: { camera: true, speak: true, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
          // In the page: faces that look at the bot / at the screen away from it / aside; two people; the voice stand-ins.
          const SETUP = () => {
            const Lg = window.JoyaPresenceLogic;
            window.__look = (where) => {
              window.__faces = () => {
                const b = window.JoyaPresenceBind.botAt(), f = { cx: 0.5, cy: 0.5, w: 0.24, jaw: window.__level > 0.01 && (Math.floor(Date.now() / 180) % 2) ? 0.36 : 0.04, ey: null };
                const tgt = where === "bot" || where === "two" ? b : { x: b.x < 0.5 ? 0.92 : 0.08, y: 0.45 };
                const a = Lg.aim(f, tgt);
                f.yaw = where === "aside" ? 55 : a.bot.yaw; f.pitch = where === "aside" ? -5 : a.bot.pitch;
                if (where === "none") return [];
                return where === "two" ? [f, { cx: 0.15, cy: 0.5, w: 0.16, yaw: 20, pitch: -5, jaw: 0.04, ey: null }] : [f];
              };
            };
            window.__look("none");
            const lv = window.__joyaLive;
            window.__latched = false; window.__busy = false; window.__speaking = false; window.__voice = true; window.__talks = 0;
            lv.ok = () => window.__voice; lv.busy = () => !!(window.__busy || window.__latched || window.__speaking);
            lv.lookTalk = () => { window.__talks++; window.__latched = true; return true; }; lv.latched = () => window.__latched;
            const cc = window.__joyaCC; cc.speaking = () => window.__speaking; cc.pauseSpeaking = () => true;
            if (window.VoiceLive) window.VoiceLive.speaking = () => false;
            window.__seq = [];
            window.__trace = setInterval(() => { const i = window.JoyaPresence.indication(); const k = i ? [i.look, i.ring, i.caption, i.blocked].join("/") : "null"; if (window.__seq[window.__seq.length - 1] !== k) window.__seq.push(k); }, 40);
          };
          const IND = () => {
            const pill = document.getElementById("mp-cam");
            const comp = document.documentElement.classList.contains("dk-comp-out");
            const k = comp ? window.JoyaDesktop.companion().debug.core() : window.__joyaCC.core, I = k && k.S ? k.S.ind : null;
            const regs = window.JoyaDesktop && window.JoyaDesktop.regions ? window.JoyaDesktop.regions() : [];
            return {
              ind: window.JoyaPresence.indication(), seq: window.__seq.slice(),
              // on the bot itself (core.indicate): the visible core's phase / fill, a nod; no added element at all
              ph: I ? I.phase : null, arm: I ? Math.round(I.arm * 100) / 100 : 0, rk: k && k.S ? k.S.rk : "", still: !!(k && k.S && k.S.still), comp,
              added: !!(document.getElementById("mp-ring") || document.getElementById("mp-caption") || document.querySelector(".mp-ind")),
              word: pill ? pill.querySelector(".mp-s").textContent : null, blocked: pill ? pill.classList.contains("mp-blocked") : null, why: pill ? pill.querySelector(".mp-why").textContent : "",
              whyShown: pill ? getComputedStyle(pill.querySelector(".mp-why")).display !== "none" : false,
              pillHit: pill ? (() => { const q = pill.getBoundingClientRect(); return regs.some((g) => q.left + q.width / 2 >= g.x && q.left + q.width / 2 <= g.x + g.w && q.top + q.height / 2 >= g.y && q.top + q.height / 2 <= g.y + g.h); })() : false,
            };
          };
          const waitFor = async (pg, fn, arg, ms) => { const t0 = Date.now(); let v; while (Date.now() - t0 < (ms || 4000)) { v = await pg.evaluate(IND); if (fn(v, arg)) return v; await pg.waitForTimeout(60); } return v; };
          const shot = async (pg, name, clip) => { if (!SHOTS) return; const dir = path.join(ROOT, "..", "mockups", "eye-contact", "indicators"); fs.mkdirSync(dir, { recursive: true }); await pg.screenshot({ path: path.join(dir, name), clip }); };

          const ia = await open({ path: "/joya-ai?shell=desktop", ua: APP_UA, tauri: IH, fakeWorker: true, screen: SCREEN, W: 480, H: 860, scheme: "dark", wait: 2500 });
          const pgI = ia.page;
          await pgI.evaluate(() => { window.__joyaCC.orbit.setConcept("E"); document.documentElement.setAttribute("data-theme", "dark"); });
          await pgI.waitForTimeout(300);
          await pgI.evaluate(() => { const k = window.__joyaCC.core; if (k && k.setHead) k.setHead("headphones"); }); // (the screenshots: the user's head)
          await pgI.evaluate(SETUP);
          const t0 = ia.reqs.length;
          let v = await waitFor(pgI, (x) => x.ind && x.word === "Watching");
          check("indications: the camera on, nobody there -> the pill says 'Watching'; nothing on the bot, no ring, no caption (no element added at all)", v.ind && v.ind.look === "watching" && v.word === "Watching" && !v.ph && !v.added, JSON.stringify(v));
          await pgI.evaluate(() => window.__look("screen"));
          v = await waitFor(pgI, (x) => x.word === "You're here", null, 3000);
          check("  you look at the screen (not the bot) -> 'You're here'; still nothing on the bot", v.word === "You're here" && !v.ph, JSON.stringify(v));
          // voice off: blocked, said quietly; looking at the bot -> its eyes meet yours, nothing more
          await pgI.evaluate(() => { window.__voice = false; window.__look("bot"); });
          v = await waitFor(pgI, (x) => x.word === "Looking at me", null, 3000);
          check("you look at the bot -> 'Looking at me'; nothing is drawn on it (its eyes meet yours), no ring", v.word === "Looking at me" && !v.ph && !v.added, JSON.stringify(v));
          check("  voice off: look and speak cannot start -> no arming, a quiet 'i' on the pill, the reason only in its hint (hidden until hover / tap)", v.blocked && /Look and speak waits: voice is off/.test(v.why) && !v.whyShown && v.ind.ring === "noticed", JSON.stringify(v));
          await pgI.hover("#mp-cam .mp-s");
          await pgI.waitForTimeout(150);
          const hv = await pgI.evaluate(IND);
          await shot(pgI, "blocked-hint.png", { x: 0, y: 0, width: 320, height: 110 });
          await pgI.mouse.move(240, 600);
          await pgI.waitForTimeout(150);
          const hv2 = await pgI.evaluate(IND);
          check("  hover the pill: the hint shows ('voice is off'); off it: gone", hv.whyShown && !hv2.whyShown, JSON.stringify([hv.whyShown, hv2.whyShown]));
          await pgI.click("#mp-cam .mp-s");
          const tp = await pgI.evaluate(() => getComputedStyle(document.querySelector("#mp-cam .mp-why")).display !== "none");
          await pgI.click("#mp-cam .mp-s");
          const tp2 = await pgI.evaluate(() => getComputedStyle(document.querySelector("#mp-cam .mp-why")).display !== "none" && document.getElementById("mp-cam").classList.contains("mp-open"));
          await pgI.mouse.move(240, 600);
          check("  a tap opens it, another closes it (the pill is a hit region: it reaches the page in the app)", tp && !tp2 && v.pillHit, JSON.stringify({ tp, tp2, hit: v.pillHit }));
          // voice on: the hold fills, then ready
          await pgI.evaluate(() => { window.__look("aside"); });
          await waitFor(pgI, (x) => x.ind && x.ind.look !== "me", null, 4000);
          await pgI.evaluate(() => { window.__voice = true; window.__seq.length = 0; window.__look("bot"); });
          const arming = await waitFor(pgI, (x) => x.ph === "arming", null, 3000);
          const tArm = Date.now();
          await pgI.waitForTimeout(120);
          const arming2 = await pgI.evaluate(IND);
          await shot(pgI, "arming.png", { x: 40, y: 40, width: 400, height: 520 });
          const ready = await waitFor(pgI, (x) => x.ph === "ready", null, 3000);
          const tReady = Date.now() - tArm;
          await shot(pgI, "ready.png", { x: 40, y: 40, width: 400, height: 520 });
          const nodded = ready.rk === "nod" || (await waitFor(pgI, (x) => x.rk === "nod", null, 400)).rk === "nod";
          await pgI.waitForTimeout(150);
          ready.seq = await pgI.evaluate(() => window.__seq.slice());
          check("look and speak on, you hold your look: the bot's own edge nodes fill over the 0.6 s hold (arming, the fill growing), then all of them (ready), with a nod", arming.ph === "arming" && arming2.arm > arming.arm && ready.ph === "ready" && ready.arm === 1 && nodded && tReady < 1200 && !ready.added, JSON.stringify({ a: arming.arm, a2: arming2.arm, r: ready.ph, nodded, tReady }));
          check("  in order: arming -> ready (never ready first)", (() => { const q = ready.seq.map((k) => k.split("/")[1]); const i = q.indexOf("arming"), j = q.indexOf("ready"); return i >= 0 && j > i; })(), JSON.stringify(ready.seq));
          // speech starts: a turn, the bot listens (no caption)
          await pgI.evaluate(() => { window.__level = 0.25; });
          const lis = await waitFor(pgI, (x) => x.ph === "listening", null, 3000);
          await pgI.evaluate(() => { window.__level = 0; });
          await shot(pgI, "listening.png", { x: 40, y: 40, width: 400, height: 560 });
          check("you speak while looking: a turn opens (lookTalk), the bot shows it listens (its edge pulses with your voice), the pill 'Listening'; no caption", lis.ph === "listening" && lis.word === "Listening" && !lis.added && (await pgI.evaluate(() => window.__talks)) === 1, JSON.stringify(lis));
          await pgI.evaluate(() => { window.__latched = false; });
          const lis2 = await waitFor(pgI, (x) => x.ph !== "listening", null, 2000);
          check("  the turn is sent (no longer listening): the bot lets go of it", lis2.ph !== "listening" && lis2.word !== "Listening", JSON.stringify(lis2));
          check("  then the cool-down: look and speak waits a moment, said only in the hint", lis2.ind.blocked === "cool" && /it just answered/.test(lis2.why), JSON.stringify(lis2.ind));
          const cool = await waitFor(pgI, (x) => x.ind && !x.ind.blocked, null, 4500);
          check("  ...and after it, nothing in the way again", cool.ind && !cool.ind.blocked && !cool.blocked, JSON.stringify(cool.ind));
          await pgI.evaluate(() => { window.__busy = true; });
          const busy = await waitFor(pgI, (x) => x.ind && x.ind.blocked === "busy", null, 1500);
          await pgI.evaluate(() => { window.__busy = false; window.__look("two"); });
          const two = await waitFor(pgI, (x) => x.ind && x.ind.blocked === "others", null, 2500);
          check("  busy (a call or a reply on) / someone else in view: no arming, the reason in the hint", busy.ind.blocked === "busy" && /a turn or a reply is on/.test(busy.why) && busy.ph !== "arming" && two.ind.blocked === "others" && /someone else is in view/.test(two.why) && two.ph !== "arming", JSON.stringify([busy.ind, two.ind]));
          // a reply playing; you look away -> paused; back -> resumes
          await pgI.evaluate(() => { window.__look("bot"); window.__speaking = true; });
          await pgI.waitForTimeout(600);
          await pgI.evaluate(() => { window.__look("aside"); });
          const pz = await waitFor(pgI, (x) => x.ph === "paused", null, 4500);
          await shot(pgI, "paused.png", { x: 0, y: 0, width: 480, height: 600 });
          check("a reply playing, you look away: the bot shows it paused (looks at you, its edge blinking slowly) and the pill says 'Paused'; no caption", pz.ph === "paused" && pz.word === "Paused" && !pz.added, JSON.stringify(pz));
          await pgI.evaluate(() => { window.__look("bot"); });
          const rs = await waitFor(pgI, (x) => x.ph !== "paused", null, 3000);
          check("  you look back: it resumes, the bot lets go of it", rs.ph !== "paused" && rs.word !== "Paused", JSON.stringify(rs));
          await pgI.evaluate(() => { window.__speaking = false; });
          // the voice not recognised: a short note in the pill, a headshake
          await pgI.evaluate(() => { window.JoyaPresence.note("Didn't recognise your voice, try again", 1500); window.__joyaCC.core.shake(); });
          const nr = await pgI.evaluate(() => ({ IND: 0, word: document.querySelector("#mp-cam .mp-s").textContent, noted: document.getElementById("mp-cam").classList.contains("mp-noted"), role: document.getElementById("mp-cam").getAttribute("role"), rk: window.__joyaCC.core.S.rk }));
          await pgI.waitForTimeout(250);
          await shot(pgI, "not-recognised.png", { x: 0, y: 0, width: 480, height: 600 });
          await pgI.waitForTimeout(1450);
          const nr2 = await pgI.evaluate(() => document.querySelector("#mp-cam .mp-s").textContent);
          check("a voice not recognised: the pill says 'Didn't recognise your voice, try again' (a status: read politely), the bot shakes its head; then its own word again", nr.word === "Didn't recognise your voice, try again" && nr.noted && nr.role === "status" && nr.rk === "shake" && nr2 !== nr.word, JSON.stringify([nr, nr2]));

          // every layout: on the bot that shows (the companion bot when it is out)
          const LAYOUTS = [
            ["Floating S", { mode: "floating", size: "S", peekOpen: true }, LAYM.windowSize({ mode: "floating", size: "S" })],
            ["Floating M", { mode: "floating", size: "M", peekOpen: true }, LAYM.windowSize({ mode: "floating", size: "M" })],
            ["Floating L", { mode: "floating", size: "L", peekOpen: true }, LAYM.windowSize({ mode: "floating", size: "L" })],
            ["Desktop layer", { mode: "desktop", peekOpen: true, pos: "right" }, { w: 1440, h: 900 }],
            ["Peek", { mode: "peek", peekOpen: true }, { w: 1440, h: 900 }],
            ["Companion", { mode: "companion", peekOpen: false, companion: { stayOnMonitor: false, ducked: false } }, { w: 176, h: 160 }],
          ];
          const lay = {};
          for (const [name, stt, sz] of LAYOUTS) {
            await pgI.setViewportSize({ width: sz.w, height: sz.h });
            await pgI.evaluate((x) => window.__emit("joya://state", x), Object.assign({ presence: IH.presence }, stt));
            await pgI.waitForTimeout(700);
            await pgI.evaluate(() => { window.__look("aside"); });
            await pgI.waitForTimeout(400);
            await pgI.evaluate(() => { window.__look("bot"); });
            const n = await waitFor(pgI, (x) => x.ph === "ready", null, 4000);
            if (name === "Companion") { await pgI.waitForTimeout(350); await shot(pgI, "companion-ready.png"); }
            await pgI.evaluate(() => { window.__level = 0.25; });
            const c = await waitFor(pgI, (x) => x.ph === "listening", null, 3000);
            await pgI.evaluate(() => { window.__level = 0; });
            if (name === "Companion") await shot(pgI, "companion-listening.png");
            await pgI.evaluate(() => { window.__latched = false; });
            await waitFor(pgI, (x) => x.ph !== "listening", null, 2000);
            await pgI.waitForTimeout(3100); // the cool-down, before the next layout
            lay[name] = { ready: n.ph === "ready", listening: c.ph === "listening", comp: n.comp, pill: n.pillHit, added: n.added || c.added };
          }
          check("every layout (Floating S / M / L, Desktop layer, Peek, Companion): ready and listening shown on the bot itself, nothing added, the pill a hit region", Object.values(lay).every((x) => x.ready && x.listening && x.pill && !x.added), JSON.stringify(lay));
          check("  in Companion it is the companion bot (out on the desk) that shows it", lay.Companion && lay.Companion.comp && lay.Companion.ready && lay.Companion.listening, JSON.stringify(lay.Companion));
          const src = fs.readFileSync(path.join(ROOT, "public", "joya-desktop.js"), "utf8");
          check("  the old ring and caption are gone from the hit regions and glass lists too", !/mp-ring|mp-caption|mp-ind/.test(src), "");
          const during = ia.reqs.slice(t0);
          const words = /Watching|You're here|Looking at me|Listening|Paused|look back|voice is off|in view|arming|noticed|recognise|indication/i;
          check("no network leakage: during all of it only the page's usual GETs (no POST, no body), and no request names an indication", during.every((r) => r.method === "GET" && r.body === 0 && new URL(r.url).origin === ORIGIN && !words.test(decodeURIComponent(r.url))), JSON.stringify(during.filter((r) => r.method !== "GET" || r.body || words.test(r.url)).map((r) => r.method + " " + r.url)));
          check("  no page errors, no CSP violations", ia.errs.length === 0 && (await pgI.evaluate(() => window.__csp)).length === 0, JSON.stringify(ia.errs));
          await ia.ctx.close();

          // reduced motion: still states, no nod
          const rm = await open({ path: "/joya-ai?shell=desktop", ua: APP_UA, tauri: IH, fakeWorker: true, screen: SCREEN, reduce: true, W: 480, H: 860, wait: 2500 });
          await rm.page.evaluate(() => { window.__joyaCC.orbit.setConcept("E"); });
          await rm.page.evaluate(SETUP);
          await rm.page.evaluate(() => { window.__look("bot"); });
          const rma = await waitFor(rm.page, (x) => x.ph === "arming", null, 3000);
          await rm.page.waitForTimeout(100);
          const rma2 = await rm.page.evaluate(IND);
          const rmr = await waitFor(rm.page, (x) => x.ph === "ready", null, 3000);
          await rm.page.waitForTimeout(200);
          const rmr2 = await rm.page.evaluate(IND);
          check("reduced motion: still states -- arming is drawn where the hold is (it does not run ahead by itself), ready is all of it, no nod", rma.still && rma.ph === "arming" && rma2.arm <= Math.max(rma.arm, 0.6) + 0.35 && rmr.ph === "ready" && rmr2.rk !== "nod", JSON.stringify([rma, rma2.arm, rmr.ph, rmr2.rk]));
          await rm.ctx.close();

          // the browser Command Center
          const br = await open({ prefs: { cam: true, speak: true }, fakeWorker: true, screen: SCREEN, W: 1280, H: 800, wait: 2500 });
          await br.page.evaluate(() => { if (window.__joyaCC.orbit && window.__joyaCC.orbit.setConcept) window.__joyaCC.orbit.setConcept("E"); });
          await br.page.evaluate(SETUP);
          await br.page.evaluate(() => { window.__look("bot"); });
          const bn = await waitFor(br.page, (x) => x.ph === "ready", null, 4000);
          await br.page.evaluate(() => { window.__level = 0.25; });
          const bc = await waitFor(br.page, (x) => x.ph === "listening", null, 3000);
          await br.page.evaluate(() => { window.__level = 0; window.__latched = false; window.__voice = false; });
          await br.page.hover("#mp-cam .mp-s");
          const bh = await waitFor(br.page, (x) => x.whyShown && /voice is off/.test(x.why), null, 2000);
          check("in the browser Command Center too: ready and listening on the core itself, the pill's hint (above it)", bn.ph === "ready" && bc.ph === "listening" && !bn.added && bh.whyShown, JSON.stringify({ r: bn.ph, l: bc.ph, w: bh.whyShown }));
          const bw = /Watching|You're here|Looking at me|Listening|Paused|look back|voice is off|in view|arming|noticed|recognise|indication/i;
          check("  nothing of it sent from the browser either (no request names an indication), no page errors", br.reqs.every((r) => !bw.test(decodeURIComponent(r.url) + r.txt)) && br.errs.length === 0, JSON.stringify(br.errs.concat(br.reqs.filter((r) => bw.test(r.url + r.txt)).map((r) => r.url))));
          await br.ctx.close();
        }

        // 5. The read-aloud pause really stops the speaker's clock.
        const ra = await open({ wait: 800 });
        const rr = await ra.page.evaluate(async () => {
          const AC = window.AudioContext;
          const c = new AC();
          // what joya-ai.js's Voice.pause does with its own context
          await c.suspend(); const s1 = c.state; await c.resume(); return { s1, s2: c.state, has: typeof window.__joyaCC.pauseSpeaking === "function" };
        });
        check("the read-aloud pause: suspend / resume of the speaker's context (pauseSpeaking exposed)", rr.s1 === "suspended" && rr.has, JSON.stringify(rr));
        await ra.ctx.close();
      } finally {
        if (browser) await browser.close();
        s.stop();
      }
    }
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
