# Vendored: MediaPipe Face Landmarker (eye contact)

Used only by `public/mint-presence-worker.js` (camera presence, off by default). Served from this site's own
`/static/vendor/mediapipe/` — nothing is fetched from a CDN at runtime, and the worker's own
Content-Security-Policy (server.js) allows only this site.

| File | From | Version | Licence | sha256 |
|---|---|---|---|---|
| `tasks-vision-0.10.21/vision_bundle.js` | npm `@mediapipe/tasks-vision` | 0.10.21 (2025-02-06) | Apache-2.0 | `bf58c9b3f592304422947b51e1f7de360c67d4dfeaa900064352da0c5a7c9115` |
| `tasks-vision-0.10.21/wasm/vision_wasm_internal.js` | the same package | 0.10.21 | Apache-2.0 | `4a97e2520ba506c680ecd6ba6acfb146888afa0e2746d57f205352bc6ebb82eb` |
| `tasks-vision-0.10.21/wasm/vision_wasm_internal.wasm` | the same package | 0.10.21 | Apache-2.0 | `f00ec4731faa23b3e714d00e88d4d10e2df5c0a427d3a2b4ae6e3526fdd14ef7` |
| `tasks-vision-0.10.21/package.json` | the same package | 0.10.21 | Apache-2.0 | (the package's manifest, for the record) |
| `models/face_landmarker-float16-v1.task` | `storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` | float16 / 1 | Apache-2.0 (MediaPipe model card) | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |

- Copied verbatim (fetched 2026-10-20). The SIMD build only: Chromium / WebView2 all have WebAssembly SIMD;
  the no-SIMD files of the package are not vendored.
- `vision_bundle.js` is the package's `vision_bundle.cjs`, byte for byte, renamed (a `.cjs` file is not served as JavaScript, which `importScripts` needs). It ends with a `sourceMappingURL` comment; the map is not vendored (DevTools only).
- `LICENSE-Apache-2.0.txt`: the Apache License 2.0 text. Copyright the MediaPipe Authors / Google LLC.
- To update: `npm pack @mediapipe/tasks-vision@<version>` (at least two weeks old), copy the same files,
  update this table and the paths in `mint-presence-worker.js`, run `dashboard/tools/test-presence.cjs`.
