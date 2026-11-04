"use strict";
/*
 * Eye contact (2026-10-20): the camera module's worker -- the only code that sees a camera frame.
 *
 * joya-presence.js hands it one small frame at a time (an ImageBitmap, transferred: the page keeps no copy);
 * the MediaPipe Face Landmarker (vendor/mediapipe, pinned, Apache-2.0; the model and its WebAssembly are
 * this site's own static files -- nothing is fetched from anywhere else) finds the faces, and
 * JoyaPresenceLogic.summarize() reduces each to a few numbers (box centre and width, head yaw / pitch, the eyes, how
 * open the jaw and the lips are, a smile). Those numbers go back; the frame is closed at once and the landmarks are dropped here.
 * Nothing is stored and nothing is sent: this worker makes no request of its own besides loading its files
 * (and its Content-Security-Policy, set by server.js for this file, allows nothing else).
 *
 *   in:  { type: "init" }                       -> { type: "ready" } | { type: "error", message }
 *        { type: "frame", bmp, t }              -> { type: "faces", faces, t, ms }
 *        { type: "close" }                      (the landmarker released)
 */
var MP_DIR = "vendor/mediapipe/tasks-vision-0.10.21/";
var MODEL = "vendor/mediapipe/models/face_landmarker-float16-v1.task";
// The logic first (it is a UMD file: with `module` defined it sets module.exports), then the CommonJS bundle.
var module = { exports: {} }, exports = module.exports;
importScripts("joya-presence-logic.js");
var Logic = module.exports;
module = { exports: {} }; exports = module.exports;
importScripts(MP_DIR + "vision_bundle.js"); // the package's vision_bundle.cjs (CommonJS), renamed to be served as JavaScript
var Vision = exports;

var lm = null, busy = false, lastTs = 0;
function abs(p) { return new URL(p, self.location.href).href; }
function init() {
  if (lm) return Promise.resolve();
  var fileset = { wasmLoaderPath: abs(MP_DIR + "wasm/vision_wasm_internal.js"), wasmBinaryPath: abs(MP_DIR + "wasm/vision_wasm_internal.wasm") };
  return Vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: abs(MODEL), delegate: "CPU" },
    runningMode: "VIDEO",
    numFaces: 3, // the person and anyone beside them (counted, so look and speak can stand down)
    outputFaceBlendshapes: true, // jawOpen: is it this person who is talking?
    outputFacialTransformationMatrixes: true, // the head's pose
    minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6, minTrackingConfidence: 0.5,
  }).then(function (x) { lm = x; });
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === "init") {
    init().then(function () { self.postMessage({ type: "ready" }); }, function (err) { self.postMessage({ type: "error", message: String((err && err.message) || err).slice(0, 200) }); });
    return;
  }
  if (m.type === "frame") {
    var bmp = m.bmp;
    if (!lm || busy || !bmp) { if (bmp && bmp.close) bmp.close(); self.postMessage({ type: "faces", faces: null, t: m.t, ms: 0 }); return; }
    busy = true;
    var t0 = performance.now(), faces = null;
    try {
      // detectForVideo wants a strictly increasing timestamp (ms)
      var ts = Math.max(lastTs + 1, Math.round(m.t || t0));
      lastTs = ts;
      faces = Logic.summarize(lm.detectForVideo(bmp, ts));
    } catch (err) {
      faces = null;
    } finally {
      if (bmp.close) bmp.close(); // the frame is gone
      busy = false;
    }
    self.postMessage({ type: "faces", faces: faces, t: m.t, ms: Math.round(performance.now() - t0) });
    return;
  }
  if (m.type === "close") {
    try { if (lm) lm.close(); } catch (err) { /* already gone */ }
    lm = null;
  }
};
