#!/usr/bin/env node
"use strict";
/**
 * JOYA AI ▸ Settings ▸ Voice, and what the one switch does, over HTTP and
 * the live WebSocket (voice is live conversation only since 2026-09-30).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-voice-settings.cjs
 *
 * The real server.js from a scratch copy that cannot reach the privileged
 * helper (tools/scratch-server.cjs, with fakeVoiceOptions: saving the voice
 * options writes a file in the scratch data dir, never the helper), on a
 * scratch database, and a mock realtime server standing in for OpenAI.
 *
 *   - the old values of the switch: "live" is rewritten to "on" at start,
 *     "0" reads as off and "1" as on;
 *   - off: /joya-ai/api/speak 409 voice-off, the live upgrade 403, open calls
 *     closed, no mic (the Command Center and the dock), the token still set;
 *     on again: all back;
 *   - voice.use: joyaai.use alone gets no live (403), no mic, no read-aloud;
 *   - the voice model: it writes the live model (the panel) and the reader's
 *     model (2.1 mini unless the model passed the verbatim check) plus the
 *     transcription model (the helper's options); gpt-realtime-mini is a choice
 *     again (2026-10-01), GPT-4o Mini Realtime only when the key's model list
 *     shows it (tools/test-voice-models.cjs); unknown values (gpt-realtime,
 *     junk) are migrated once at start and refused after; gpt-live-1 is a
 *     choice again (2026-10-29), gated on the key's model list like 4o; no
 *     listening-model row;
 *   - Transcription: gone from Settings (2026-10-30): one model,
 *     gpt-4o-transcribe, in the helper's options; a stored value of the old
 *     setting is ignored (no error, no rewrite); its route, the Arabic persona
 *     row and Read replies aloud are gone;
 *   - the voice cards name their gender and follow the voice model; each has
 *     a play button whose sample route is refused off, without a voice the
 *     model has, without voice.manage or a CSRF token, and makes a clip once
 *     (kept on disk; billed once); the old URLs redirect;
 *   - signing a device out ends its live call (endLiveCallsForSession), and
 *     only that device's.
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const { WebSocketServer, WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");
let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 2000)) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !!(await fn());
}

/* A mock realtime: accepts the scratch copy's fake key and answers session.update. */
const sessions = [];
const mockHttp = http.createServer((q, s) => (s.writeHead(404), s.end()));
const wss = new WebSocketServer({ noServer: true });
mockHttp.on("upgrade", (req, sock, head) => {
  if (req.headers.authorization !== "Bearer " + scratch.FAKE_KEY) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    const s = { url: req.url, closed: false };
    sessions.push(s);
    ws.on("close", () => (s.closed = true));
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      if (ev.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: ev.session }));
      // An out-of-band reading (the voice cards' sample): its words, a little audio, the usage.
      if (ev.type === "response.create") {
        const rid = "resp_" + sessions.length;
        const pcm = Buffer.alloc(24000).fill(40);
        ws.send(JSON.stringify({ type: "response.created", response: { id: rid } }));
        ws.send(JSON.stringify({ type: "response.output_audio_transcript.delta", response_id: rid, delta: "Hi, I'm JOYA AI." }));
        ws.send(JSON.stringify({ type: "response.output_audio.delta", response_id: rid, delta: pcm.toString("base64") }));
        ws.send(JSON.stringify({ type: "response.output_audio_transcript.done", response_id: rid, transcript: "Hi, I'm JOYA AI." }));
        ws.send(JSON.stringify({ type: "response.done", response: { id: rid, status: "completed", usage: { input_token_details: { text_tokens: 120 }, output_token_details: { text_tokens: 10, audio_tokens: 40 } } } }));
        s.readings = (s.readings || 0) + 1;
      }
    });
  });
});

(async () => {
  await new Promise((r) => mockHttp.listen(0, "127.0.0.1", r));
  const WS = "ws://127.0.0.1:" + mockHttp.address().port + "/v1";
  const db = require(path.join(ROOT, "lib", "db.js"));
  // The front desk's old value, before the server starts: the start rewrites it once.
  db.setSetting("voice_desk", "live", "before");
  // The old voice model choice (and, in the fake helper file, gpt-realtime-mini as the reader).
  db.setSetting("voice_model", "gpt-realtime", "before");
  // The retired Transcription setting, naming a model that is gone: ignored, left alone.
  const OLD_TR = JSON.stringify({ model: "whisper-small", language: "fr" });
  db.setSetting("voice_transcription", OLD_TR, "before");
  const s = await scratch.startScratch({ env: { JOYA_OPENAI_WS: WS }, fakeVoiceOptions: true });
  const SET = "/joya-ai/settings/voice";
  const form = (o) => new URLSearchParams(o).toString();
  const origin = "http://127.0.0.1:" + s.port;
  const open = (cookie, csrf) =>
    new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:" + s.port + "/joya-ai/api/live?csrf=" + encodeURIComponent(csrf || ""), { headers: { Cookie: cookie || "", Origin: origin } });
      const out = { status: null, ws: null, got: [], closed: null };
      ws.on("message", (d, bin) => !bin && out.got.push(JSON.parse(String(d))));
      ws.on("close", (code) => (out.closed = code));
      ws.on("unexpected-response", (q, res) => resolve({ ...out, status: res.statusCode }));
      ws.on("open", () => ((out.status = 101), (out.ws = ws), resolve(out)));
      ws.on("error", () => resolve({ ...out, status: out.status || "error" }));
    });
  try {
    check("migration: the old 'live' was rewritten to 'on' at start, once, and said so", db.getSetting("voice_desk") === "on" && db.settingRow("voice_desk").updated_by === "migration" && /the voice setting "live" became "on"/.test(s.out()));

    const opts = () => JSON.parse(fs.readFileSync(path.join(s.data, "fake-voice-options.json"), "utf8"));
    check("migration: the old voice model gpt-realtime became gpt-realtime-2.1-mini at start, and said so", db.getSetting("voice_model") === "gpt-realtime-2.1-mini" && db.settingRow("voice_model").updated_by === "migration" && /the voice model "gpt-realtime" is not offered; it became "gpt-realtime-2\.1-mini"/.test(s.out()));
    check("migration: the helper's reader and listening models became 2.1-mini / gpt-4o-transcribe (the one transcription model), the voice kept", (await until(() => fs.existsSync(path.join(s.data, "fake-voice-options.json")), 3000)) && opts().model === "gpt-realtime-2.1-mini" && opts().transcribe_model === "gpt-4o-transcribe" && opts().voice === "marin" && /the helper's voice options became gpt-realtime-2\.1-mini \/ marin \/ gpt-4o-transcribe \(were gpt-realtime-mini \/ gpt-4o-mini-transcribe\)/.test(s.out()), s.out().slice(-600));
    check("the retired Transcription setting is ignored: left as stored, no rewrite, nothing logged about it", db.getSetting("voice_transcription") === OLD_TR && db.settingRow("voice_transcription").updated_by === "before" && !/transcription setting|local transcription server/.test(s.out()));

    await s.makeUser("vadmin", "administrator");
    await s.makeUser("vadmin2", "administrator");
    await s.makeUser("vadmin3", "administrator");
    await s.makeUser("vop", "operator-voice", ["joyaai.use", "os.view"]);
    const A = await s.signIn("vadmin");
    const A2 = await s.signIn("vadmin2"); // another signed-in browser (a TOTP code cannot be reused for a second sign-in of the same user here)
    const O = await s.signIn("vop");
    let cc = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    const tok = s.csrfOf(cc.body);
    check("voice on: the Command Center has the mic and may go live", /id="cc-c-mic"/.test(cc.body) && /data-voice-live="1"/.test(cc.body));
    let osPage = await s.req("GET", "/os", { cookie: A.cookie });
    check("  and the dock on another page has its mic", /id="md-mic"/.test(osPage.body));

    // voice.use
    const ccO = await s.req("GET", "/joya-ai", { cookie: O.cookie });
    const otok = s.csrfOf(ccO.body);
    check("voice.use: joyaai.use alone gets no mic, no read-aloud, no live", ccO.status === 200 && !/id="cc-c-mic"/.test(ccO.body) && !/id="cc-speak-toggle"/.test(ccO.body) && /data-voice-live=""/.test(ccO.body));
    check("  nor the dock's mic on another page", !/id="md-mic"/.test((await s.req("GET", "/os", { cookie: O.cookie })).body));
    check("  its live upgrade is refused (403)", (await open(O.cookie, otok)).status === 403);
    let r = await s.req("POST", "/joya-ai/api/speak", { cookie: O.cookie, headers: { "X-CSRF-Token": otok }, body: { text: "Hello." } });
    check("  and read-aloud (403)", r.status === 403, r.status);
    check("  and it cannot open Settings ▸ Voice", (await s.req("GET", SET, { cookie: O.cookie })).status === 403);
    const rbac = require(path.join(ROOT, "lib", "rbac.js"));
    check("voice.use: 'Talk with JOYA AI by voice', in JOYA AI's group, implies joyaai.use; the administrator has it, the stock roles do not", rbac.PERMISSION_SET.has("voice.use") && rbac.PERMISSION_GROUPS.find((g) => g.key === "joyaai").perms.some((p) => p.key === "voice.use" && p.label === "Talk with JOYA AI by voice") && rbac.closure(["voice.use"]).includes("joyaai.use") && rbac.actor({ permissions: ["*"] }).can("voice.use") && rbac.SYSTEM_ROLES.filter((x) => x.name !== "administrator").every((x) => !x.permissions.includes("voice.use")));

    // The section
    let set = await s.req("GET", SET, { cookie: A.cookie });
    const stok = s.csrfOf(set.body);
    check("Settings ▸ Voice: 200, enabled, the sub-nav says on", set.status === 200 && /Voice is on</.test(set.body) && /class="set-sec"/.test(set.body) && /href="\/joya-ai\/settings\/voice" class="on"[^>]*>[\s\S]{0,800}?Voice<span class="st">on<\/span>/.test(set.body));
    check("  the rows' anchors are there: v-model, v-token, v-test, v-voice, v-live-audio (Voice spend moved to Usage)", ["v-model", "v-token", "v-test", "v-voice", "v-live-audio"].every((a) => set.body.includes(`id="${a}"`)) && !/id="v-spend"/.test(set.body));
    check("  gone (2026-10-30): Transcription, its language, the Arabic persona row, Read replies aloud, the 'More: test, language' collapse", !/id="v-transcribe"|id="v-transcribe-lang"|id="v-persona"|id="v-read"|id="v-more"/.test(set.body) && !/<select name="transcriber"|<select name="language"|<select name="preset"|data-read-aloud|Read replies aloud|Transcription language/.test(set.body));
    check("  Test sits in the main group, right after the key; noise reduction still under More", /id="v-token"[\s\S]*?id="v-test"[\s\S]*?id="voice-test"/.test(set.body) && /<details class="set-more"><summary>More: noise reduction<\/summary>[\s\S]*?id="v-noise"/.test(set.body));
    check("  the voice evaluation and voiceprint trial links are gone", !/voice-eval|voiceprint-trial|from-trial/.test(set.body));
    const mSel = (set.body.match(/<select name="model"[\s\S]*?<\/select>/) || [""])[0];
    check("  the voice model selector: 2.1 mini (current), GPT Realtime mini, GPT-4o Mini Realtime and GPT-Live (both disabled: OpenAI not reachable here, so not checked)", (set.body.match(/<select name="model"/g) || []).length === 1 && (mSel.match(/<option value="gpt-/g) || []).length === 4 && /<option value="gpt-live-1" data-hint="[^"]*" disabled>GPT-Live \+ JOYA AI \(not checked yet\)<\/option>/.test(mSel) && /<option value="gpt-realtime-2\.1-mini" data-hint="[^"]*" selected>GPT Realtime 2\.1 mini \(current\)<\/option>/.test(mSel) && /<option value="gpt-realtime-mini" data-hint="[^"]*">GPT Realtime mini<\/option>/.test(mSel) && /<option value="gpt-4o-mini-realtime-preview" data-hint="[^"]*" disabled>GPT-4o Mini Realtime \(not checked yet\)<\/option>/.test(mSel) && /id="voice-retire-note">GPT Realtime mini retires on 20 January 2027\./.test(set.body), mSel);
    check("  no old listening-model field; the voice model's help points at the transcription row", !/id="v-listen"/.test(set.body) && !/name="transcribe_model"/.test(set.body) && !/Listening model/.test(set.body) && !/not a setting/.test(set.body));
    check("  the hidden note says the rest is hidden while voice is off", /The rest of the voice settings are hidden while voice is off/.test(set.body));
    check("  every voice card names its gender, alloy neutral", ["Marin", "Cedar", "Alloy", "Ash", "Ballad", "Coral", "Echo", "Sage", "Shimmer", "Verse"].every((n) => new RegExp(n + "</b><span class=\"g\"[^>]*><i aria-hidden=\"true\">[♀♂◌]</i>(Female|Male|Neutral)</span>").test(set.body)) && /Alloy<\/b><span class="g"[^>]*><i aria-hidden="true">◌<\/i>Neutral/.test(set.body));
    check("  on 2.1 mini: its ten voices only (no GPT-Live voice offered)", (set.body.match(/name="voice" value=/g) || []).length === 10 && !/value="quartz"/.test(set.body) && !/id="voice-live-note"/.test(set.body));
    check("  each card has a play button beside its radio label (not in it), named for the voice, hidden until the script shows it", (set.body.match(/<button type="button" class="voice-play" data-sample="[a-z]+" aria-label="Play a sample of [A-Z][a-z]+" title="Play a sample of [A-Z][a-z]+" hidden>/g) || []).length === 10 && /<\/label><button type="button" class="voice-play" data-sample="marin"/.test(set.body) && /id="voice-sample-msg"/.test(set.body));
    check("  the key is masked, set, with Replace (a dialog) and Remove (a confirm)", /class="kv-mask"/.test(set.body) && /<span class="state ok">[\s\S]{0,200}?Set<\/span>/.test(set.body) && /data-modal-open="m-voice-token"/.test(set.body) && /data-confirm-dlg="Remove the OpenAI key\?"/.test(set.body) && !set.body.includes(scratch.FAKE_KEY));
    check("  its own stylesheet and script, no inline style or script", /joya-settings-voice\.css\?v=/.test(set.body) && /joya-settings-voice\.js\?v=/.test(set.body) && !/\sstyle\s*=/.test(set.body) && !/<script(?![^>]*\bsrc=)[^>]*>/.test(set.body));
    const ids = [...set.body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    check("  ids stay unique", ids.length === new Set(ids).size, ids.filter((x, i) => ids.indexOf(x) !== i).join());

    // The voice model: the live model (panel) and the reader's (helper options), each row its own field.
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: "gpt-realtime-2.1-mini" }) });
    check("model gpt-realtime-2.1-mini: live AND read-aloud on it, listening on gpt-4o-transcribe", r.status === 303 && db.getSetting("voice_model") === "gpt-realtime-2.1-mini" && opts().model === "gpt-realtime-2.1-mini" && opts().transcribe_model === "gpt-4o-transcribe" && opts().voice === "marin", r.status + " " + JSON.stringify(opts()));
    for (const old of ["gpt-realtime", "gpt-live-1", "gpt-4o-mini-transcribe"]) {
      r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: old }) });
      check(`${old} is refused (${old === "gpt-live-1" ? "not on this key here" : "not in the list"})`, /err=/.test(r.headers.location || "") && /#v-model$/.test(r.headers.location || "") && db.getSetting("voice_model") === "gpt-realtime-2.1-mini" && opts().model === "gpt-realtime-2.1-mini");
    }
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: "gpt-4o-mini-realtime-preview" }) });
    check("gpt-4o-mini-realtime-preview is refused while the key's model list does not show it", /err=/.test(r.headers.location || "") && /not%20available%20on%20this%20OpenAI%20key|not\+available\+on\+this\+OpenAI\+key/.test(r.headers.location || "") && db.getSetting("voice_model") === "gpt-realtime-2.1-mini", r.headers.location);
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: "gpt-realtime-mini" }) });
    check("gpt-realtime-mini is accepted again: the live model; read-aloud stays on 2.1 mini (the helper's reader)", r.status === 303 && !/err=/.test(r.headers.location || "") && db.getSetting("voice_model") === "gpt-realtime-mini" && opts().model === "gpt-realtime-2.1-mini" && opts().transcribe_model === "gpt-4o-transcribe", r.headers.location + " " + JSON.stringify(opts()));
    set = await s.req("GET", SET, { cookie: A.cookie });
    check("  Settings shows it current, its hint under the selector", /<option value="gpt-realtime-mini" data-hint="[^"]*" selected>GPT Realtime mini \(current\)/.test(set.body) && /id="voice-model-hint">Same list price as 2\.1 mini/.test(set.body));
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, model: "gpt-realtime-2.1-mini" }) });
    check("  and back to 2.1 mini", db.getSetting("voice_model") === "gpt-realtime-2.1-mini" && opts().model === "gpt-realtime-2.1-mini");
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: stok, voice: "cedar" }) });
    check("the voice row posts only the voice; the model and its pair are kept", opts().voice === "cedar" && opts().model === "gpt-realtime-2.1-mini" && opts().transcribe_model === "gpt-4o-transcribe" && db.getSetting("voice_model") === "gpt-realtime-2.1-mini");
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, headers: { Accept: "application/json", "X-Requested-With": "fetch" }, body: form({ _csrf: stok, transcribe_model: "gpt-4o-mini-transcribe", transcriber: "gpt-transcribe" }) });
    const j = JSON.parse(r.body);
    check("an old page's listening-model / transcriber post is ignored: saved as before, gpt-4o-transcribe kept", r.status === 200 && j.ok && !/Listening model/.test(j.flash) && opts().transcribe_model === "gpt-4o-transcribe" && opts().voice === "cedar");
    // The Transcription and persona-reset routes are gone; the persona route stays for a confirmed persona.set.
    const JS = { Accept: "application/json", "X-Requested-With": "fetch" };
    r = await s.req("POST", SET + "/transcription", { cookie: A.cookie, headers: JS, body: form({ _csrf: stok, transcriber: "gpt-4o-mini-transcribe" }) });
    check("POST /transcription is gone (404); nothing saved, the pair unchanged", r.status === 404 && db.getSetting("voice_transcription") === OLD_TR && opts().transcribe_model === "gpt-4o-transcribe", r.status);
    r = await s.req("POST", SET + "/persona/reset", { cookie: A.cookie, headers: JS, body: form({ _csrf: stok }) });
    check("POST /persona/reset is gone (404)", r.status === 404, r.status);
    r = await s.req("POST", SET + "/persona", { cookie: A.cookie, headers: JS, body: form({ _csrf: stok, preset: "learned" }) });
    check("POST /persona (a confirmed persona.set) still answers", r.status === 200 && JSON.parse(r.body).ok, r.body);

    // The voice cards' samples.
    const SMP = SET + "/sample";
    r = await s.req("POST", SMP, { cookie: A.cookie, headers: JS, body: form({ _csrf: stok, voice: "quartz" }) });
    check("sample: a GPT-Live-only voice on 2.1 mini is refused (400)", r.status === 400 && JSON.parse(r.body).code === "invalid", r.status + " " + r.body);
    r = await s.req("POST", SMP, { cookie: O.cookie, headers: { "X-CSRF-Token": otok, ...JS }, body: form({ _csrf: otok, voice: "ash" }) });
    check("  needs voice.manage (403)", r.status === 403, r.status);
    r = await s.req("POST", SMP, { cookie: A.cookie, headers: JS, body: form({ _csrf: "bad", voice: "ash" }) });
    check("  and the CSRF token", r.status === 403, r.status);
    const usageRows = () => db.voiceUsageSince(0).filter((x) => x.cat === "sample");
    const readings0 = sessions.reduce((n, x) => n + (x.readings || 0), 0);
    r = await s.req("POST", SMP, { cookie: A.cookie, headers: JS, body: form({ _csrf: stok, voice: "ash" }) });
    const smpDir = path.join(s.data, "voice-samples");
    const smpFiles = () => (fs.existsSync(smpDir) ? fs.readdirSync(smpDir) : []);
    check("  ash: a WAV in that voice, spoken by the voice model (one reading)", r.status === 200 && /^audio\/wav/.test(r.headers["content-type"] || "") && r.body.startsWith("RIFF") && sessions.reduce((n, x) => n + (x.readings || 0), 0) === readings0 + 1, r.status + " " + (r.headers["content-type"] || "") + " " + String(r.body).slice(0, 80));
    check("  kept on disk (0600), and its spend recorded once (voice usage, category sample)", smpFiles().length === 1 && /^gpt-realtime-2\.1-mini__ash__[0-9a-f]{10}\.wav$/.test(smpFiles()[0]) && (fs.statSync(path.join(smpDir, smpFiles()[0])).mode & 0o777) === 0o600 && usageRows().length === 1 && usageRows()[0].usd > 0, JSON.stringify([smpFiles(), usageRows()]));
    r = await s.req("POST", SMP, { cookie: A.cookie, headers: JS, body: form({ _csrf: stok, voice: "ash" }) });
    check("  played again: from disk -- no new reading, nothing billed", r.status === 200 && r.body.startsWith("RIFF") && sessions.reduce((n, x) => n + (x.readings || 0), 0) === readings0 + 1 && usageRows().length === 1);
    check("  it selects nothing: the voice is still cedar", opts().voice === "cedar");
    // The voices follow the model (GPT-Live is gated: allow it in the model list by hand here).
    const voiceLib = require(path.join(ROOT, "lib", "voice.js"));
    check("voices per model: GPT-Live 31 (the ten realtime + 21 of its own), the realtime models 10; a GPT-Live voice stands in on a realtime model", voiceLib.voicesFor("gpt-live-1").length === 31 && voiceLib.voicesFor("gpt-realtime-2.1-mini").length === 10 && voiceLib.voicesFor("gpt-realtime-mini").length === 10 && voiceLib.standInFor("quartz", "gpt-realtime-2.1-mini") === "marin" && voiceLib.standInFor("vesper", "gpt-realtime-2.1-mini") === "cedar" && voiceLib.standInFor("quartz", "gpt-live-1") === "quartz" && voiceLib.standInFor("cedar", "gpt-realtime-2.1-mini") === "cedar");
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, headers: JS, body: form({ _csrf: stok, voice: "vesper" }) });
    check("  a GPT-Live voice posted while the model is 2.1 mini: refused, the voice unchanged", r.status === 400 && /GPT-Live's own/.test(JSON.parse(r.body).error) && opts().voice === "cedar", r.body);

    check("the start-time migration ran once (no second rewrite after the saves)", (s.out().match(/the helper's voice options became/g) || []).length === 1 && (s.out().match(/the voice model "gpt-realtime" is not offered/g) || []).length === 1);
    r = await s.req("POST", SET + "/options", { cookie: A.cookie, body: form({ _csrf: "bad", voice: "marin" }) });
    check("the forms need the CSRF token", r.status === 403);

    // A live call, bound to device A's session.
    cc = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    const call = await open(A.cookie, s.csrfOf(cc.body));
    check("a live call opens (voice on, an administrator)", call.status === 101 && (await until(() => call.got.some((m) => m.type === "ready"), 3000)), JSON.stringify(call.got));
    check("  on the selected voice model", call.got.some((m) => m.type === "ready" && m.model === "gpt-realtime-2.1-mini" && m.voice === "cedar"));

    // Off
    r = await s.req("POST", SET + "/enabled", { cookie: A.cookie, headers: { Accept: "application/json", "X-Requested-With": "fetch" }, body: form({ _csrf: stok }) });
    const off = JSON.parse(r.body);
    check("switching off (in place): stored 'off', the page is told to reload", off.ok && off.reload === true && db.getSetting("voice_desk") === "off" && /Voice is off for everyone/.test(off.flash));
    check("  the open call is closed", await until(() => call.closed != null, 3000), call.closed);
    check("  audited, with the calls it ended", db.recentLogins(20).some((x) => /voice disabled for everyone \(1 live call\(s\) ended\)/.test(x.detail || "")));
    cc = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    check("  no mic, no read-aloud, no live on the Command Center", !/id="cc-c-mic"/.test(cc.body) && !/id="cc-speak-toggle"/.test(cc.body) && !/id="cc-reply-read"/.test(cc.body) && /data-voice-live=""/.test(cc.body));
    osPage = await s.req("GET", "/os", { cookie: A.cookie });
    check("  nor on the dock", !/id="md-mic"/.test(osPage.body));
    r = await open(A.cookie, s.csrfOf(cc.body));
    check("  the live upgrade is refused (403)", r.status === 403, r.status);
    r = await s.req("POST", "/joya-ai/api/speak", { cookie: A.cookie, headers: { "X-CSRF-Token": s.csrfOf(cc.body) }, body: { text: "Hello." } });
    check("  /joya-ai/api/speak: 409 voice-off", r.status === 409 && JSON.parse(r.body).code === "voice-off", r.status + " " + r.body);
    set = await s.req("GET", SET, { cookie: A.cookie });
    check("  Settings: off, the section dims (voice-off), the sub-nav says off", /Voice is off</.test(set.body) && /class="set-sec voice-off"/.test(set.body) && /<span class="st off">off<\/span>/.test(set.body));
    check("  the key is kept and its row stays usable", /<span class="state ok">[\s\S]{0,200}?Set<\/span>/.test(set.body) && /id="voice-token-replace"/.test(set.body) && /id="voice-remove"/.test(set.body));
    check("  the voice model and Test are disabled while off", /<select name="model" id="voice-model" aria-label="Voice model" disabled>/.test(set.body) && /id="voice-test" disabled/.test(set.body));
    const creds = await s.req("GET", "/credentials", { cookie: A.cookie });
    check("Credentials: the OpenAI voice row is a status line linking to Settings ▸ Voice; no voice entry in the list", /id="openai-voice"/.test(creds.body) && /token set/.test(creds.body) && /voice off/.test(creds.body) && /href="\/joya-ai\/settings\/voice#v-token"/.test(creds.body) && !/href="\/credentials\/openai-voice"/.test(creds.body));

    // Read-time mapping of the old values.
    db.setSetting("voice_desk", "1", "test");
    cc = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    check("an old '1' reads as on", /id="cc-c-mic"/.test(cc.body));
    db.setSetting("voice_desk", "0", "test");
    cc = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    check("an old '0' reads as off", !/id="cc-c-mic"/.test(cc.body));

    // On again, through the switch (no JavaScript).
    r = await s.req("POST", SET + "/enabled", { cookie: A.cookie, body: form({ _csrf: stok, enabled: "1" }) });
    check("switching on again (no JavaScript: a redirect back)", r.status === 303 && /^\/joya-ai\/settings\/voice\?msg=/.test(r.headers.location) && db.getSetting("voice_desk") === "on");
    cc = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    check("  the mic is back", /id="cc-c-mic"/.test(cc.body));

    // Sign-out ends that device's call, and only that one's.
    const cc2 = await s.req("GET", "/joya-ai", { cookie: A2.cookie });
    const c1 = await open(A.cookie, s.csrfOf(cc.body));
    await until(() => c1.got.some((m) => m.type === "ready"), 3000);
    check("device A has a live call again", c1.status === 101);
    r = await s.req("POST", "/logout", { cookie: A2.cookie, body: form({ _csrf: s.csrfOf(cc2.body) }) });
    await new Promise((res) => setTimeout(res, 300));
    check("signing out another browser leaves device A's call alone", r.status === 302 && c1.closed == null);
    r = await s.req("POST", "/logout", { cookie: A.cookie, body: form({ _csrf: s.csrfOf(cc.body) }) });
    check("signing out device A ends its call (endLiveCallsForSession)", r.status === 302 && (await until(() => c1.closed != null, 3000)));
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    check("  endLiveCallsForSession(sid, reason) is a top-level function returning how many it ended", /^function endLiveCallsForSession\(sid, reason\) \{[\s\S]*?return n;\n\}/m.test(src));

    // The old URLs.
    const B = await s.signIn("vadmin3");
    r = await s.req("GET", "/credentials/openai-voice", { cookie: B.cookie });
    check("GET /credentials/openai-voice -> 302 to Settings ▸ Voice", r.status === 302 && r.headers.location === SET);
    r = await s.req("POST", "/credentials/openai-voice/options", { cookie: B.cookie, body: form({ _csrf: "x", voice: "marin" }) });
    check("POST /credentials/openai-voice/options -> 308 to the new route (method and body kept)", r.status === 308 && r.headers.location === SET + "/options");
    r = await s.req("POST", "/credentials/openai-voice/desk", { cookie: B.cookie, body: form({ _csrf: "x", mode: "live" }) });
    check("the old desk switch changes nothing and says the desk is gone", r.status === 303 && /front%20desk%20is%20gone/.test(r.headers.location) && db.getSetting("voice_desk") === "on");
    for (const p of ["/joya-ai/api/desk/turn", "/joya-ai/api/desk/summary", "/joya-ai/api/transcribe"]) {
      r = await s.req("POST", p, { cookie: B.cookie, body: { text: "hi" } });
      check(`${p} is gone (404)`, r.status === 404, r.status);
    }
  } catch (e) {
    check("the HTTP run completed", false, e.stack + "\n" + s.out());
  } finally {
    s.stop();
    mockHttp.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
