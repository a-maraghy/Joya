"use strict";
/**
 * The voiceprint's routes (lib/voiceprint.js): the Settings ▸ Voice ▸
 * Voiceprint forms, and the guided enrolment page with its two calls.
 *
 *   POST /joya-ai/settings/voice/voiceprint             enabled=1|absent   On / Off
 *   POST /joya-ai/settings/voice/voiceprint/gate        gate=1|absent      Only respond to stored voices
 *   POST /joya-ai/settings/voice/voiceprint/strictness  preset=relaxed|strict|very_strict, or
 *                                                       accept, reject, stickyMin, echo (Advanced),
 *                                                       or reset=1 (all four back to the defaults);
 *                                                       merged into voiceprint_thresholds, other keys kept
 *   POST /joya-ai/settings/voice/voiceprint/people      name, spoken, me   add a person (a plain form: 303
 *                                                                          to their enrolment page)
 *   POST .../voiceprint/people/<id>/rename              name, spoken
 *   POST .../voiceprint/people/<id>/command             may=1|absent       May give commands
 *   POST .../voiceprint/people/<id>/remove-mic          mic
 *   POST .../voiceprint/people/<id>/delete                                 that person's voiceprint only
 *   POST /joya-ai/settings/voice/voiceprint/forget-all                     every voiceprint, the key, my trial
 *                                                                          clips, results, the ledger
 *   GET  /joya-ai/voiceprint/enrol?person=<id>                             the page
 *   POST /joya-ai/api/voiceprint/enrol-clip?person=&mic=&id=  audio/wav    embedded at once, never stored
 *   POST /joya-ai/api/voiceprint/enrol-save             {person, mic}
 *   GET  /joya-ai/api/voiceprint/enrol-status?person=&mic=
 *
 * All of it needs joyaai.use + voice.manage (the voice section's own rule) and
 * the CSRF token; every change is audited (login_log, outcome "voice"), counts
 * and names of microphones only.
 */
const vpLib = require("./voiceprint");

const SET = "/joya-ai/settings/voice/voiceprint";
const MAX_WAV = 44 + 40 * 24000 * 2 + 1024;

function mount(app, deps) {
  const { vprint, trial, settingsGuard, reply, requireAuth, requirePerm, requireApiPerm, requireApiCsrf, rateLimit, express, db, ctx, views, asset } = deps;
  const audit = (req, line) => {
    try {
      db.logLogin(req.ip, req.me.username, "voice", line);
    } catch (_) {
      /* best effort */
    }
  };
  const on = (v) => v === "1" || v === "on" || v === true;

  app.post(SET, ...settingsGuard, (req, res) => {
    const want = on(req.body && req.body.enabled);
    const was = vprint.enabled();
    vprint.setEnabled(want, req.me.username);
    audit(req, `voiceprint ${want ? "on (watching; the gate is " + (vprint.gate() ? "on" : "off") + ")" : "off: no turn is checked"}${was === want ? " (unchanged)" : ""}`);
    reply(req, res, { msg: want ? "Voiceprint on. Turns are checked from the next one" + (vprint.gate() ? ", and only stored voices are answered." : "; nothing is blocked (watching only).") : "Voiceprint off. Nothing is checked; the stored voiceprints are kept.", anchor: "v-voiceprint", reload: true });
  });

  app.post(SET + "/gate", ...settingsGuard, async (req, res) => {
    const want = on(req.body && req.body.gate);
    if (want && !vprint.enabled()) return reply(req, res, { err: "Switch the voiceprint on first.", anchor: "v-vp-gate" });
    await vprint.openAll().catch(() => {});
    if (want && !vprint.hasPrints()) return reply(req, res, { err: "Store a voiceprint first.", anchor: "v-vp-gate" });
    const was = vprint.gate();
    vprint.setGate(want, req.me.username);
    audit(req, `voiceprint: only respond to stored voices ${want ? "on" : "off"}${was === want ? " (unchanged)" : ""}`);
    reply(req, res, { msg: want ? "Only stored voices are answered from the next turn. Unknown voices and unsure turns are not; the screen says why, JOYA AI never speaks about it." : "Back to watching only: every turn is answered, and the speaker named when recognised.", anchor: "v-vp-gate", reload: true });
  });

  app.post(SET + "/strictness", ...settingsGuard, (req, res) => {
    const b = req.body || {};
    const was = vprint.thresholds();
    const fmt = (t) => `accept ${t.accept}, reject ${t.reject}, call's voice ${t.stickyMin}, echo ${t.echo}`;
    let now;
    let what;
    if (b.reset === "1") {
      now = vprint.setThresholds(Object.fromEntries(vpLib.TUNABLE.map((k) => [k, null])), req.me.username);
      what = "reset to the defaults";
    } else if (b.preset !== undefined && b.preset !== "custom") {
      const p = vpLib.PRESETS.find((x) => x.id === String(b.preset));
      if (!p) return reply(req, res, { err: "Choose Relaxed, Strict or Very strict.", anchor: "v-vp-strict" });
      // A preset sets the call's-voice minimum and puts the other three back to their defaults.
      now = vprint.setThresholds({ accept: null, reject: null, echo: null, stickyMin: p.stickyMin }, req.me.username);
      what = p.label.replace(/ \(recommended\)$/, "");
    } else {
      const v = vpLib.validateThresholds({ accept: b.accept, reject: b.reject, stickyMin: b.stickyMin, echo: b.echo });
      if (!v.ok) return reply(req, res, { err: v.error, anchor: "v-vp-strict" });
      now = vprint.setThresholds(v.values, req.me.username);
      what = "advanced";
    }
    audit(req, `voiceprint strictness: ${what} (${fmt(now)}; was ${fmt(was)})`);
    reply(req, res, { msg: `Strictness saved: ${what}. It applies from the next turn.`, anchor: "v-vp-strict", reload: true });
  });

  /* ---- the stored voiceprints, by name ---- */

  // Add a person: a plain form (not sent in place), so the browser follows the 303 to their enrolment page.
  app.post(SET + "/people", ...settingsGuard, (req, res) => {
    const b = req.body || {};
    try {
      const me = on(b.me) ? req.me : null;
      const p = vprint.addPerson({ name: b.name, spoken: b.spoken, user_id: me ? me.id : null, may_command: me ? true : false });
      audit(req, `voiceprint: added ${p.name}${p.user_id ? " (linked to " + req.me.username + ")" : ""}, may give commands ${p.may_command ? "on" : "off"}`);
      if (/json/.test(String(req.get("accept") || ""))) return res.json({ ok: true, person: p, next: "/joya-ai/voiceprint/enrol?person=" + p.id });
      return res.redirect(303, "/joya-ai/voiceprint/enrol?person=" + encodeURIComponent(p.id));
    } catch (e) {
      return reply(req, res, { err: e.status ? e.message : "Could not add it: " + String(e.message).slice(0, 160), anchor: "v-vp-people" });
    }
  });
  const withPerson = (fn) => async (req, res) => {
    const p = vprint.person(String(req.params.id || ""));
    if (!p) return reply(req, res, { err: "No such voiceprint.", anchor: "v-vp-people" });
    try {
      await fn(req, res, p);
    } catch (e) {
      reply(req, res, { err: e.status ? e.message : "Could not change it: " + String(e.message).slice(0, 160), anchor: "v-vp-people" });
    }
  };
  app.post(SET + "/people/:id/rename", ...settingsGuard, withPerson(async (req, res, p) => {
    const q = vprint.updatePerson(p.id, { name: (req.body || {}).name, spoken: (req.body || {}).spoken });
    audit(req, `voiceprint: renamed ${p.name} to ${q.name}${q.spoken !== p.spoken ? " (spoken name changed)" : ""}`);
    reply(req, res, { msg: `Saved: ${q.name}${q.spoken ? " («" + q.spoken + "»)" : ""}.`, anchor: "v-vp-people", reload: true });
  }));
  app.post(SET + "/people/:id/command", ...settingsGuard, withPerson(async (req, res, p) => {
    const want = on((req.body || {}).may);
    const q = vprint.updatePerson(p.id, { may_command: want });
    audit(req, `voiceprint: ${q.name} may give commands ${want ? "on" : "off"}${p.may_command === want ? " (unchanged)" : ""}`);
    reply(req, res, { msg: want ? `${q.name} may give commands by voice (approvals still need a click).` : `${q.name} is answered in conversation only.`, anchor: "v-vp-people" });
  }));
  app.post(SET + "/people/:id/remove-mic", ...settingsGuard, withPerson(async (req, res, p) => {
    const mic = String((req.body && req.body.mic) || "");
    if (!vpLib.MIC_RE.test(mic)) return reply(req, res, { err: "Which microphone?", anchor: "v-vp-people" });
    const done = await vprint.removeMic(p.id, mic);
    if (!vprint.hasPrints() && vprint.gate()) vprint.setGate(false, req.me.username);
    audit(req, `voiceprint: removed the ${mic} microphone from ${p.name}${done ? "" : " (it was not there)"}`);
    reply(req, res, { msg: done ? "Removed." : "That microphone was not in the voiceprint.", anchor: "v-vp-people", reload: true });
  }));
  app.post(SET + "/people/:id/delete", ...settingsGuard, withPerson(async (req, res, p) => {
    await vprint.removePerson(p.id);
    if (!vprint.hasPrints() && vprint.gate()) vprint.setGate(false, req.me.username);
    audit(req, `voiceprint: deleted ${p.name}'s voiceprint`);
    reply(req, res, { msg: `${p.name}'s voiceprint is deleted.`, anchor: "v-vp-people", reload: true });
  }));

  app.post(SET + "/forget-all", ...settingsGuard, async (req, res) => {
    try {
      const r = await vprint.forgetAll();
      if (vprint.gate()) vprint.setGate(false, req.me.username);
      audit(req, `voiceprint: deleted everything (${r.people} voiceprints, key ${r.key_deleted ? "deleted" : "kept"}, ${r.results_deleted} result folders, ${r.ledger_rows} check rows)`);
      reply(req, res, { msg: `Deleted: ${r.people} stored voiceprint${r.people === 1 ? "" : "s"}, ${r.results_deleted} evaluation results, ${r.ledger_rows} check log rows${r.key_deleted ? ", and the sealing key" : ""}.`, anchor: "v-vp", reload: true });
    } catch (e) {
      reply(req, res, { err: "Not everything could be deleted: " + String(e.message).slice(0, 160), anchor: "v-vp" });
    }
  });

  /* ---- the guided enrolment ---- */

  const guard = [requireApiPerm("joyaai.use"), requireApiPerm("voice.manage")];
  const uploads = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => "vpe-" + (req.me ? req.me.id : "anon"),
    validate: false,
    handler: (req, res) => res.status(429).json({ error: "Too many recordings at once. Wait a few minutes." }),
  });
  const raw = express.raw({ type: ["audio/wav", "audio/x-wav"], limit: MAX_WAV });

  app.get("/joya-ai/voiceprint/enrol", requireAuth, requirePerm("joyaai.use"), requirePerm("voice.manage"), (req, res) => {
    const p = vprint.person(String(req.query.person || ""));
    if (!p) return res.redirect(302, "/joya-ai/settings/voice#v-vp-people");
    res.set("Cache-Control", "no-store");
    res.send(views.page({ csrf: res.locals.csrf, user: ctx(req, "console"), person: p, isMe: p.user_id === req.me.id, paragraphs: trial.ENROL, slots: trial.SLOTS, worklet: asset("voice-live-worklet.js"), enabled: vprint.enabled(), minSeconds: vpLib.MIN_ENROL_MS / 1000 }));
  });

  const personQ = (v) => vprint.person(String(v || ""));
  app.get("/joya-ai/api/voiceprint/enrol-status", ...guard, (req, res) => {
    const mic = String(req.query.mic || "");
    const p = personQ(req.query.person);
    if (!p) return res.status(404).json({ error: "No such voiceprint." });
    if (!vpLib.MIC_RE.test(mic)) return res.status(400).json({ error: "Which microphone?" });
    res.set("Cache-Control", "no-store").json(vprint.pendingOf(p.id, mic));
  });

  app.post(
    "/joya-ai/api/voiceprint/enrol-clip",
    ...guard,
    requireApiCsrf,
    uploads,
    (req, res, next) => raw(req, res, (err) => (err ? res.status(err.status === 413 || err.type === "entity.too.large" ? 413 : 400).json({ error: "That recording is too long." }) : next())),
    async (req, res) => {
      const mic = String(req.query.mic || "");
      const id = String(req.query.id || "");
      const p = personQ(req.query.person);
      if (!p) return res.status(404).json({ error: "No such voiceprint." });
      if (!vpLib.MIC_RE.test(mic)) return res.status(400).json({ error: "Which microphone?" });
      if (!trial.ENROL.some((p) => p.id === id)) return res.status(400).json({ error: "Which paragraph?" });
      if (!vprint.enabled()) return res.status(409).json({ error: "The voiceprint is off. Switch it on in Settings ▸ Voice first." });
      let w;
      try {
        w = trial.parseWav(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const seconds = w.samples.length / w.rate;
      if (seconds < 3 || seconds > 40) return res.status(400).json({ error: "A paragraph must be between 3 and 40 seconds." });
      if (trial.peakDb(w.samples) < -50) return res.status(400).json({ error: "Nothing was heard. Check the microphone and record again." });
      try {
        const r = await vprint.enrolClip(p.id, mic, id, Buffer.from(w.samples.buffer, w.samples.byteOffset, w.samples.length * 2), w.rate);
        res.json({ ok: true, id, mic, speech_s: Math.round(r.speech_ms / 100) / 10, total_s: Math.round(r.total_ms / 100) / 10, need_s: vpLib.MIN_ENROL_MS / 1000 });
      } catch (e) {
        res.status(e.status === 422 ? 400 : 503).json({ error: e.status === 422 ? "Not enough speech in that recording. Record it again." : "The voiceprint service is not answering; try again in a minute." });
      }
    }
  );

  app.post("/joya-ai/api/voiceprint/enrol-save", ...guard, requireApiCsrf, express.json({ limit: "4kb" }), async (req, res) => {
    const mic = String((req.body && req.body.mic) || "");
    const p = personQ(req.body && req.body.person);
    if (!p) return res.status(404).json({ error: "No such voiceprint." });
    if (!vpLib.MIC_RE.test(mic)) return res.status(400).json({ error: "Which microphone?" });
    try {
      const r = await vprint.enrolSave(p.id, mic, "enrol");
      audit(req, `voiceprint of ${r.name} enrolled (${mic}, ${r.speech_s} s of speech; microphones: ${r.mics.join(", ")})`);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : "The voiceprint could not be saved: " + String(e.message).slice(0, 160) });
    }
  });

}

module.exports = { mount, SET };
