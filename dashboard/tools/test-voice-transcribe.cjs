#!/usr/bin/env node
"use strict";
/**
 * The one transcription model (2026-10-30): lib/voice-transcribe.js --
 * gpt-4o-transcribe, whatever a stored setting names; no language unless a live
 * call's second try pins one -- the guards over transcripts, and the helper's
 * transcription model check (VOICE_TRANSCRIBE_RE) and its voice-whisper-*
 * commands (left installed, unused). No real OpenAI: a mock on 127.0.0.1.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-voice-transcribe.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const T = require(path.join(ROOT, "lib", "voice-transcribe.js"));
const voice = require(path.join(ROOT, "lib", "voice.js"));
const guard = require(path.join(ROOT, "lib", "voice-guard.js"));
const usage = require(path.join(ROOT, "lib", "voice-usage.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 500) : ""));
  }
}
function section(t) {
  console.log("\n" + t);
}

const KEY = "sk-proj-" + "T".repeat(40) + "fake";

/* A 1.5 s 440 Hz tone as a 24 kHz WAV (what a live call hands over). */
function tone(seconds, rate) {
  const r = rate || 24000;
  const n = Math.round(seconds * r);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / r) * 8000), i * 2);
  return voice.wav(pcm, r);
}

/* ------------------------------------------------------------ mocks -- */

const seen = { openai: [] };
const field = (txt, name) => (txt.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`)) || [])[1];
const openai = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const txt = Buffer.concat(chunks).toString("latin1");
    seen.openai.push({ url: req.url, model: field(txt, "model"), language: field(txt, "language"), auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "restart the dashboard please", usage: { type: "tokens", input_tokens: 32, input_token_details: { text_tokens: 0, audio_tokens: 32 }, output_tokens: 6 } }));
  });
});
(async () => {
  await new Promise((r) => openai.listen(0, "127.0.0.1", r));
  const httpBase = "http://127.0.0.1:" + openai.address().port + "/v1";
  const logs = [];
  const cfg = (x) => ({ key: KEY, httpBase, log: (m) => logs.push(m), ...(x || {}) });
  const clip = tone(1.5);

  section("one model: gpt-4o-transcribe");
  check("the list is one entry, gpt-4o-transcribe, the default", T.TRANSCRIBERS.map((t) => t.id).join() === "gpt-4o-transcribe" && T.DEFAULT_ID === "gpt-4o-transcribe" && T.MODEL === "gpt-4o-transcribe");
  check("no local model, no backends, no language list any more", T.BACKENDS === undefined && T.LANGUAGES === undefined && T.TRANSCRIBERS.every((t) => t.kind === "openai"));
  check("a stored setting naming any other model (or a language) reads as gpt-4o-transcribe, no language -- no error", ["gpt-4o-mini-transcribe", "gpt-transcribe", "whisper-small", "whisper-large-v3-turbo", "junk", null].every((m) => JSON.stringify(T.clean({ model: m, language: "ar" })) === '{"model":"gpt-4o-transcribe","language":"auto"}') && JSON.stringify(T.clean(null)) === '{"model":"gpt-4o-transcribe","language":"auto"}');
  check("the live session's own transcription model is gpt-4o-transcribe whatever is asked", T.sessionModelFor() === "gpt-4o-transcribe" && T.sessionModelFor("gpt-4o-mini-transcribe") === "gpt-4o-transcribe" && T.sessionModelFor("whisper-small") === "gpt-4o-transcribe");
  check("a hand-off waits the usual time (an OpenAI model)", T.heardWaitMs("whisper-small") === null && T.heardWaitMs() === null);
  check("lib/voice.js pairs every voice model with it", voice.LISTEN_MODEL === "gpt-4o-transcribe" && voice.listenModelFor("gpt-realtime-2.1-mini") === "gpt-4o-transcribe" && voice.listenModelFor("gpt-live-1") === "gpt-4o-transcribe" && voice.DEFAULTS.transcribe_model === "gpt-4o-transcribe");

  section("the call to OpenAI");
  seen.openai.length = 0;
  let r = await T.transcribeFull(clip, cfg({ transcriber: "gpt-4o-mini-transcribe" }), "audio/wav");
  check("posted to /audio/transcriptions with gpt-4o-transcribe even when an old choice is named; the result names it, with its usage and time", seen.openai[0] && seen.openai[0].model === "gpt-4o-transcribe" && r.transcriber === "gpt-4o-transcribe" && r.model === "gpt-4o-transcribe" && r.tokens && r.tokens.audio_in === 32 && typeof r.ms === "number", JSON.stringify([seen.openai[0], r]));
  check("  no language sent (the model detects Arabic, English and the two mixed)", seen.openai[0].language === undefined);
  await T.transcribeFull(clip, cfg({ transcribe_language: "ar" }), "audio/wav");
  check("  a live call's second try pins one: it goes with it", seen.openai[1] && seen.openai[1].language === "ar" && seen.openai[1].model === "gpt-4o-transcribe");
  await T.transcribeFull(clip, cfg({ transcribe_language: "auto" }), "audio/wav");
  check("  'auto' (an old stored language) sends none", seen.openai[2] && seen.openai[2].language === undefined);
  check("gpt-4o-transcribe is priced ($0.006 a minute; tokens at its list price)", Math.abs(usage.costOf({ seconds: 60 }, "gpt-4o-transcribe") - 0.006) < 1e-9 && usage.costOf({ audio_in: 1000, text_out: 100 }, "gpt-4o-transcribe") > 0);
  check("  the retired models stay priced, so older rows still read", usage.costOf({ audio_in: 600 }, "gpt-transcribe") > 0 && usage.costOf({ audio_in: 600 }, "gpt-4o-mini-transcribe") > 0);

  section("the settings Test and the live call");
  {
    let spokenTo = null;
    const fakeCheck = await voice
      .check({ key: KEY, httpBase: "http://127.0.0.1:1/v1", wsBase: "ws://127.0.0.1:1/v1" }, { transcribe: async (a, c) => ((spokenTo = c), { text: "x", transcriber: "gpt-4o-transcribe" }) })
      .catch((e) => ({ err: e.code }));
    check("voice.check takes the transcriber it is given (here the speaking half fails first: no transcription without audio)", fakeCheck.err === "network" && spokenTo === null, JSON.stringify(fakeCheck));
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    check("  the Test route names it: 'transcription by <model> … heard … in N ms'", /voice\.check\(\{ \.\.\.cfg, model: cfg\.live_model \}, \{ transcribe: voiceTranscribe\.transcribeFull \}\)/.test(server) && /transcription by \$\{out\.heard_by\}/.test(server) && /in \$\{out\.transcribe_ms\} ms/.test(server));
    check("a realtime call transcribes the full turn with it; a GPT-Live call gets no transcriber at all", /transcribe: Call === voiceGptLive\.GptLiveCall \? null : voiceTranscribe\.transcribeFull/.test(server));
    check("the Transcription route, its setting's migration and the local server's start are gone", !/settings\/voice\/transcription"/.test(server) && !/syncLocalTranscriber|voiceWhisperSet|migrateTranscriptionSetting/.test(server));
  }

  section("the transcript guard (noise labels, stock phrases)");
  for (const t of ["*thud*", "[BLANK_AUDIO]", "(static)", "♪", "♪ ♪", "<|nospeech|>"]) {
    const g = guard.checkTranscript(t, { audioSeconds: 4 });
    check(`dropped: ${JSON.stringify(t)} (noise-label)`, !g.ok && g.rule === "noise-label", JSON.stringify(g));
  }
  for (const t of ["you", "Thank you.", "Thanks for watching!"]) {
    const g = guard.checkTranscript(t, { audioSeconds: 0.8 });
    check(`dropped on a short clip: ${JSON.stringify(t)}`, !g.ok, JSON.stringify(g));
  }
  for (const t of ["عايزك تعمل ريستارت للداشبورد بعد ما تشيك على الديسك يوزج", "اعمل ريستارت للداشبورد دلوقتي", "Restart it (now), please."]) {
    const g = guard.checkTranscript(t, { audioSeconds: 5 });
    check(`kept: ${t}`, g.ok, JSON.stringify(g));
  }
  check("stripMarkers leaves words alone", guard.stripMarkers("Restart the dashboard.") === "Restart the dashboard." && guard.stripMarkers("[Music] hi *cough* there ♪") === "hi there");

  section("helper: voice-whisper-status / voice-whisper-set (systemctl stubbed)");
  helperTests();

  openai.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("CRASH " + e.stack);
  process.exit(1);
});

function helperTests() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voice-whisper-test-"));
  const driver = `
import importlib.machinery, importlib.util, io, json, os, sys, contextlib, types
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp = sys.argv[2]
H.WHISPER_DIR = os.path.join(tmp, "w")
H.WHISPER_MODELS_DIR = os.path.join(H.WHISPER_DIR, "models")
H.WHISPER_BIN = os.path.join(H.WHISPER_DIR, "bin", "whisper-server")
H.WHISPER_ENV = os.path.join(H.WHISPER_DIR, "server.env")
H.WHISPER_VAD = os.path.join(H.WHISPER_MODELS_DIR, "ggml-silero-v5.1.2.bin")
H.AUDIT_LOG = os.path.join(tmp, "audit.log")
H.VOICE_DIR = os.path.join(tmp, "joya-voice")
H.VOICE_FILE = os.path.join(H.VOICE_DIR, "openai-voice.env")
state = {"active": "inactive", "enabled": "disabled"}
calls = []
def fake_run(argv, **kw):
    calls.append(" ".join(argv))
    out = ""
    if argv[:2] == ["systemctl", "is-active"]: out = state["active"]
    elif argv[:2] == ["systemctl", "is-enabled"]: out = state["enabled"]
    elif argv[:2] == ["systemctl", "enable"]: state["enabled"] = "enabled"
    elif argv[:2] == ["systemctl", "restart"]: state["active"] = "active"
    elif argv[:3] == ["systemctl", "disable", "--now"]: state.update(active="inactive", enabled="disabled")
    return types.SimpleNamespace(returncode=0, stdout=out + "\\n", stderr="")
H.run = fake_run
def call(name, args=()):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            H.COMMANDS[name](list(args))
        except SystemExit:
            pass
    return json.loads(out.getvalue().strip().splitlines()[-1])
res = {}
res["status0"] = call("voice-whisper-status")
res["set_uninstalled"] = call("voice-whisper-set", ["small-q8_0"])
os.makedirs(os.path.join(H.WHISPER_DIR, "bin")); os.makedirs(H.WHISPER_MODELS_DIR)
open(H.WHISPER_BIN, "w").write("x"); open(H.WHISPER_VAD, "w").write("x")
open(os.path.join(H.WHISPER_MODELS_DIR, "ggml-small-q8_0.bin"), "w").write("x" * 10)
res["status1"] = call("voice-whisper-status")
res["set_missing_model"] = call("voice-whisper-set", ["large-v3-turbo-q8_0"])
res["set_bad"] = call("voice-whisper-set", ["../../etc/passwd"])
res["set_vad"] = call("voice-whisper-set", ["silero-v5.1.2"])
n0 = len(calls)
res["set_ok"] = call("voice-whisper-set", ["small-q8_0"])
res["env"] = open(H.WHISPER_ENV).read()
res["env_mode"] = oct(os.stat(H.WHISPER_ENV).st_mode & 0o777)
res["calls_set"] = calls[n0:]
n1 = len(calls)
res["set_again"] = call("voice-whisper-set", ["small-q8_0"])
res["calls_again"] = calls[n1:]
n2 = len(calls)
res["off"] = call("voice-whisper-set", ["off"])
res["calls_off"] = calls[n2:]
res["opt_4o"] = call("voice-options-set", ["gpt-realtime-2.1-mini", "marin", "gpt-4o-transcribe"])
res["opt_4o_snap"] = call("voice-options-set", ["gpt-live-1", "quartz", "gpt-4o-transcribe-2026-03-20"])
res["opt_gpt_transcribe"] = call("voice-options-set", ["gpt-realtime-2.1-mini", "marin", "gpt-transcribe"])
res["opt_mini"] = call("voice-options-set", ["gpt-realtime-2.1-mini", "marin", "gpt-4o-mini-transcribe"])
res["opt_whisper"] = call("voice-options-set", ["gpt-realtime-2.1-mini", "marin", "whisper-small"])
res["defaults"] = H.VOICE_DEFAULTS
res["audit"] = open(H.AUDIT_LOG).read()
print(json.dumps(res))
`;
  const run = spawnSync("python3", ["-c", driver, path.join(ROOT, "deploy", "joya-helper"), TMP], { encoding: "utf8" });
  let res;
  try {
    res = JSON.parse(run.stdout.trim().split("\n").pop());
  } catch (e) {
    check("the helper driver ran", false, run.stderr || run.stdout);
    return;
  }
  check("status with nothing installed: not installed, no models, the install command named", res.status0.ok && res.status0.data.installed === false && res.status0.data.models.length === 0 && /install-voice-whisper\.sh/.test(res.status0.data.install));
  check("set refused while not installed, naming the install script", !res.set_uninstalled.ok && /not installed.*install-voice-whisper\.sh/.test(res.set_uninstalled.error), JSON.stringify(res.set_uninstalled));
  check("status lists installed models (not the VAD model)", res.status1.data.installed === true && res.status1.data.models.map((m) => m.model).join() === "small-q8_0");
  check("a model that is not installed is refused; a path or the VAD model is not a model id", !res.set_missing_model.ok && /large-v3-turbo-q8_0 is not installed/.test(res.set_missing_model.error) && !res.set_bad.ok && /not a local model id/.test(res.set_bad.error) && !res.set_vad.ok);
  check("set <model>: writes the environment file (root-readable 0644) and enables + starts the unit", res.set_ok.ok && res.set_ok.data.active === "active" && res.set_ok.data.selected === "small-q8_0" && /WHISPER_MODEL=.*\/models\/ggml-small-q8_0\.bin/.test(res.env) && res.env_mode === "0o644" && res.calls_set.includes("systemctl enable joya-voice-whisper.service") && res.calls_set.includes("systemctl restart joya-voice-whisper.service"), JSON.stringify(res.calls_set));
  check("  the same model again while it runs: not restarted", res.set_again.ok && !res.calls_again.some((c) => /restart|enable /.test(c)), JSON.stringify(res.calls_again));
  check("set off: disabled and stopped", res.off.ok && res.off.data.active === "inactive" && res.calls_off.includes("systemctl disable --now joya-voice-whisper.service"));
  check("the live session's model is gpt-4o-transcribe only (VOICE_TRANSCRIBE_RE): it and a dated snapshot pass; gpt-transcribe, gpt-4o-mini-transcribe and a local id are refused", res.opt_4o.ok && res.opt_4o_snap.ok && !res.opt_gpt_transcribe.ok && !res.opt_mini.ok && !res.opt_whisper.ok, JSON.stringify([res.opt_4o, res.opt_gpt_transcribe]));
  check("  a GPT-Live voice name (quartz) is stored like any other", res.opt_4o_snap.ok);
  check("  a fresh file's default is gpt-4o-transcribe", res.defaults.OPENAI_TRANSCRIBE_MODEL === "gpt-4o-transcribe");
  check("audited", /voice-whisper-set/.test(res.audit) && /"small-q8_0"/.test(res.audit) && /"off"/.test(res.audit));
  fs.rmSync(TMP, { recursive: true, force: true });
}
