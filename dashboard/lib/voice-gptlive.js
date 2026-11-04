"use strict";
/**
 * Live conversation on GPT-Live (gpt-live-1): a natural, full-duplex front
 * with Claude -- JOYA AI's supervisor -- doing all the real work.
 * Settings ▸ Voice ▸ Voice model "GPT-Live + JOYA AI" (2026-10-29).
 *
 *   browser mic ──PCM16 24 kHz──▶ this server ──▶ OpenAI {ws}/live/sessions (gpt-live-1)
 *   browser speaker ◀──held, guarded PCM── this server ◀── its audio + transcript
 *                                           │  session.delegation.created
 *                                           ▼
 *                     GPT-Live's own transcript of the turn ──▶ JOYA AI (Claude)
 *                     JOYA AI's reply ──▶ session.commentary.append ──▶ spoken by GPT-Live
 *
 * What GPT-Live is (read off OpenAI's docs and tested on the real API,
 * 2026-10-29): a speech model that listens while it speaks and DELEGATES
 * anything it should not answer itself. With client delegation it sends
 * `session.delegation.created` {delegation: {id}, offset_ms} -- metadata only,
 * never the words -- and the application does the work and sends the result
 * back with `session.commentary.append` {delegation_id, content}, which it
 * says in its own words (`session.thinking.append` adds quiet context,
 * `session.instructions.append` steers). It gives its own transcript of both
 * sides (`session.input_transcript.delta` / `session.output_transcript.delta`
 * with start_ms / end_ms on the session timeline), streams output audio
 * continuously, silence included (`session.output_audio.delta`, no timing,
 * no "done"), costs $0.05 a minute of session, and has no tools of its own, no
 * turn detection setting and no input transcription setting. Its prompt asks
 * for delegation with the literal `<|SpawnThinking|>`.
 *
 * So this class is LiveCall (lib/voice-live.js) with the upstream leg swapped:
 *
 *   - Hand-offs: on a delegation the turn's words are GPT-Live's OWN INPUT
 *     TRANSCRIPT of the turn (session.input_transcript.delta, joined across
 *     the turns of one request said in pieces: mergeBack) -- since
 *     2026-10-30, at the administrator's request ("remove the transcription
 *     for gpt live"). Until then they were this server's full-turn transcript
 *     (gpt-4o-transcribe) with GPT-Live's only a marked hint; on the real
 *     calls of 2026-10-29 GPT-Live's transcript read better (English 0 vs
 *     1.5 % word errors, Arabic 0 vs 2 meaning errors) and two requests it
 *     had understood were answered "I didn't catch that" while the other
 *     transcript was waited for. No transcription model is called on a
 *     GPT-Live call (nothing is billed for one), and no note about another
 *     transcript goes to JOYA AI. The text still passes every check:
 *     voiceGuard.checkTranscript (echo of a prompt, noise labels, stock
 *     silence phrases, more words than the audio holds) and refuseAtDoor
 *     before it is handed over; the voiceprint (on the turn's own audio,
 *     found by speechSpan), talk-only speakers, the stop / undo / yes-no
 *     commands and the persona run on the turn as before.
 *   - GPT-Live has no tools: screen actions and status questions are
 *     delegated like everything else, and JOYA AI does them (its own
 *     ui_action, through the call's ui ticket).
 *   - The output guard. GPT-Live's transcript leads its audio by only
 *     ~0.2 s (sometimes not at all), so every audio chunk is held HOLD_MS
 *     before it goes to the page, and the words so far go through the same
 *     Releaser (lib/voice-shared.js): an unfinished sentence that already
 *     breaks a rule ("I restarted it", a figure nobody gave) cuts the
 *     utterance before most of it is heard. A result being said (after a
 *     commentary) is held a WHOLE sentence -- released only once the summary
 *     rules (figures, negation, added advice or claims) have passed it --
 *     because a paraphrased result is where a wrong figure would hurt. A cut
 *     flushes the page, mutes GPT-Live until it is quiet, tells it to stop,
 *     and the safe line -- or the result itself, word for word -- is read by
 *     the verbatim reader (lib/voice.js), as the realtime call does.
 *   - Barge-in: GPT-Live hears the administrator and yields by itself (about
 *     a second, measured). In headphones mode the page's detector
 *     (public/voice-live-detect.js, sustained voice above the speaker's leak)
 *     makes it immediate: the page flushes and GPT-Live's audio is dropped
 *     until it has gone quiet. In speakers mode the microphone is replaced
 *     by silence while the voice is audible (GPT-Live needs a continuous
 *     stream: it only talks while it hears), and a tap interrupts.
 *   - Upstream events the realtime class still sends (conversation items,
 *     response.cancel, truncation, buffer clears) are translated or dropped
 *     in send(): notes become `session.thinking.append`.
 *
 *   - 2026-10-30 (call lv1jz4g): the prompt names the exact fillers ("One second." / «ثانية واحدة.») and
 *     forbids "I'll ask ..." of anyone (it said «ثواني وهسال joya ai» and was cut mid-word); it names the
 *     other agents (the supervisor's live sessions, read at call start: loadAgents) so "ask JOYA Pace"
 *     is delegated like any request -- the supervisor routes it to that session (joya-ai
 *     lib/voiceroute.js) and its later reply is said here (LiveCall.followUpEvent); quick facts
 *     (weather, time, general knowledge) are delegated too and answered in seconds by the call's quick
 *     lane, never from GPT-Live's memory. A summary cut part-way: the rest of the reply goes to the
 *     verbatim reader once GPT-Live has said the lines before it (afterResultSaid), not "the rest is on
 *     screen". "The details are on screen" only when the page showed the reply (LiveCall.screenLine).
 *
 * Pure of I/O except through what it is given, as LiveCall.
 */

const WebSocket = require("ws");
const live = require("./voice-live");
const desk = require("./voice-shared");
// Guard rules that mean what was heard was WRONG (afterCut says that sentence again, correctly); any other cut
// (added advice, a promise, an Arabic clause the parser cannot read) re-says nothing the administrator heard.
const FACT_RULES = new Set(["figure", "negation-flipped", "not-in-reply", "pending-as-done", "added-claim", "action-claim", "invented-reply"]);
const voiceGuard = require("./voice-guard");
const personaLib = require("./voice-persona");
const arabic = require("./voice-arabic");
const { SpeechGate } = require("./voice-speechgate");

const { LiveCall, speakableSentences, RATE } = live;

const GPT_LIVE_MODEL = "gpt-live-1";
const BYTES_PER_MS = (RATE * 2) / 1000;
const FRAME_MS = 100; // the silence the server sends itself when the page sends nothing
const CLOCK_MS = 100;
const HOLD_MS = 250; // conversation: how long each output chunk waits for its words
// A result being said: "words" = the same short hold, with every figure checked on the words so far and the
// summary rules on each whole sentence (a cut then stops the rest and reads it word for word); "sentence" =
// each sentence held until the summary rules passed it (nothing wrong is ever heard, but the first words
// of a result wait a whole sentence: +3-4 s, measured). opts.resultHold overrides.
const RESULT_HOLD = "words";
// GPT-Live sends its audio in real time (100 ms chunks, unevenly), and the page plays what it has with no
// buffer of its own: an utterance's first chunks are held LEAD_MS longer so the page starts with that much
// in hand and does not run dry between chunks (browser run, 2026-10-29: with it, the page's played time
// kept pace with the wall clock through every reply).
const LEAD_MS = 150;
const LOUD_RMS = 250; // an output chunk this loud is speech (GPT-Live's silence is ~0)
const BARGE_RMS = 600; // ~-35 dBFS: speech close to a headset microphone, well above a quiet room
const BARGE_VOICED_MS = 240; // "Wait," alone is ~250 ms of speech (measured on the barge-in clip)
const BARGE_WINDOW_MS = 800;
const QUIET_END_MS = 700; // an utterance ends after this much quiet output with no new words
const TURN_GAP_MS = 1200; // input words this far apart on the session timeline are two turns
// A turn is complete when no new input words arrive for this long. GPT-Live's input transcript comes in
// bursts up to ~1.3 s apart within one sentence (measured 2026-10-29), so less splits a sentence in three.
const INPUT_QUIET_MS = 1500;
const MERGE_GAP_MS = 3000;
const TURN_PAD_MS = 300;
const RAW_MIC_MS = 3000; // the raw microphone kept for checking a barge-in
const BARGE_CHECK_MS = 1500; // the microphone's last this-much is checked when a voice talks over the voice
const BARGE_CHECK_WAIT_MS = 600; // the check answers in ~20-60 ms; past this the voice stops (fail open)
const BARGE_RECHECK_MS = 700; // an unknown voice over the voice: checked again at most this often
const SPEECH_RMS = 300; // relayed audio this loud (or 3x the room's floor) is speech, for finding a turn in it
const SPAN_GAP_MS = 900; // a pause this long before the speech is where the turn began
const SPAN_LOOKBACK_MS = 4000;
const SPAN_MAX_MS = 30000; // turns this close (session timeline), with nothing said between, are one request
const DELEG_WAIT_MS = 2500; // a delegation waits this long at most for its turn's words
const RESULT_WINDOW_MS = 20000; // a result's commentary is "being said" for at most this long
const SUPPRESS_MAX_MS = 2500; // after a barge-in or a cut, GPT-Live's audio is dropped until it is quiet (or this)
const SUPPRESS_QUIET_MS = 300;
const APPEND_CHARS = 1200; // each append is limited to 500 tokens; Arabic runs ~2.5 characters a token
const STUCK_MS = 30000;
const UNBACKED_WAIT_MS = 1500; // a delegation with no result after this: one quiet progress note
const AGENTS_WAIT_MS = 600; // the session start waits this long at most for the agents' names
const RESULT_SAID_MAX_MS = 25000; // the rest of a cut summary waits this long at most for GPT-Live to say the lines before it
const LIVE_EVENTS = new Set([
  "session.start",
  "session.close",
  "session.input_audio.append",
  "session.input_audio.mute",
  "session.input_audio.unmute",
  "session.commentary.append",
  "session.thinking.append",
  "session.instructions.append",
]);

/*
 * The conversation prompt, in the shape OpenAI's GPT-Live guide asks for
 * (Backchannel / Interruption / Delegation policy, `<|SpawnThinking|>`). Short
 * on purpose: the rules that matter are enforced here (the guard, the
 * transcript, the approval gate), not trusted to the prompt.
 */
const INSTRUCTIONS = [
  "You are JOYA AI, the assistant that runs this VPS (a server) for its administrator, in a live spoken conversation. Speak in the first person, warmly and naturally, in short spoken sentences, like a capable colleague on a call. One identity: never speak of JOYA AI as someone else, and never say you passed, sent, forwarded or delegated anything.",
  "",
  "While a result is on its way, say only one of these fillers, nothing else: \"One second.\", \"Just a second.\", \"Let me see.\" -- in Arabic «ثانية واحدة.» or «ثانية بس.». Never say you will ask, check with, consult or hear back from anyone (not JOYA AI, not \"the system\", not another agent): the work is yours.",
  "",
  "Backchannel policy: Use few backchannels. A short \"mm-hmm\" at most while the administrator is mid-thought.",
  "",
  "Interruption policy: When the administrator interrupts, stop speaking right away, even in the middle of a sentence. Listen until they finish, then respond to what they said.",
  "",
  "Delegation policy:",
  "Backend tools:",
  "- Your own deeper work: it reads the machine's live state (services, disk, memory, CPU, logs, Claude sessions, missions, approvals, Odoo, backups, files), reasons about it, and acts on the machine (restart, deploy, fix, delete, push, send).",
  "- This screen: open or close panels and pages, dark or light mode, the voice, the Arabic voice persona, ending or muting this call.",
  "- Quick facts: the weather, the time and date, conversions, general knowledge. They are looked up for you in a second or two; never answer them from memory.",
  "- The other agents on this machine, by name (AGENTS). When the administrator asks you to ask, tell or check something with one of them, that request goes straight to that agent and its answer comes back to you as a result.",
  "",
  "Generate <|SpawnThinking|> when:",
  "- The administrator asks anything about the machine or its work that you would have to look up.",
  "- The administrator asks you to do, change, check, open, close, switch, restart, fix, send or approve anything, on the machine or on this screen.",
  "- The administrator asks for a fact you would have to know: the weather, the time or date, a conversion, a number, a name, news.",
  "- The administrator names one of the agents above and wants something from it.",
  "- A correction changes something already asked for.",
  "- You are not sure.",
  "",
  "Do not generate <|SpawnThinking|> when:",
  "- The administrator greets you, thanks you, asks how you are or whether you can hear them.",
  "- They ask you to repeat a result you already gave.",
  "- You need one short clarifying question to understand the request.",
  "",
  "Generate <|SpawnThinking|> before giving an answer that depends on backend work. Do not guess the result while waiting.",
  "",
  "Hard rules:",
  "- Never state a fact, figure or status about the machine unless it came to you as a result.",
  "- Never say that anything was done, restarted, deleted, fixed, approved, opened or changed, and never promise that it will be, unless a result says so.",
  "- Approvals and decisions are the administrator's to make on the Command Center screen; you cannot approve or deny anything.",
  "- While a result is on its way you may acknowledge briefly (\"On it.\"), make small talk or ask a clarifying question. Never invent progress or findings.",
  "- When a result arrives, say all of it -- every point, in order, not a shorter version -- in your own words, but keep every number, name, time, unit and every \"not\" or \"no\" exactly as given, in the language of the conversation. Add no advice, next steps or offers the result does not contain. If it says the rest is on the screen, say so.",
].join("\n");

// The agents the prompt names when the supervisor's list cannot be read (call start, lib/voice-gptlive.js loadAgents).
const DEFAULT_AGENTS = ["JOYA Pace", "[GSH] Planning Automation", "Joya Builder", "Joya Convener"];

/** The prompt with this call's agent names (the supervisor's live sessions; DEFAULT_AGENTS if unknown). */
function instructionsFor(persona, agents) {
  const list = (agents && agents.length ? agents : DEFAULT_AGENTS).slice(0, 12).map((n) => String(n).replace(/[\n\r"]/g, " ").slice(0, 60));
  return INSTRUCTIONS.replace("(AGENTS)", "(" + list.join(", ") + ")") + "\n" + personaLib.liveNote(persona);
}

function rmsOf(buf) {
  let ss = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    ss += v * v;
  }
  return n ? Math.sqrt(ss / n) : 0;
}

/** Split a result into appends of at most APPEND_CHARS, on sentence boundaries. */
function chunksOf(text) {
  const out = [];
  let cur = "";
  for (const s of desk.sentencesOf(String(text || ""), true)) {
    if (cur && (cur + " " + s).length > APPEND_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? cur + " " + s : s.slice(0, APPEND_CHARS);
  }
  if (cur) out.push(cur);
  return out;
}

class GptLiveCall extends LiveCall {
  constructor(deps) {
    super(deps);
    this.kind = "gpt-live";
    this.model = GPT_LIVE_MODEL;
    this.liveReady = false;
    this.lastInAt = 0;
    this.clockT = null;
    this.evSeq = 0;
    this.inTurn = null; // the turn whose words are arriving: { t, startTl, endTl, text, at }
    this.delegs = new Map(); // delegation id -> { id, offset, at, turn, requestId, done }
    this.utt = null; // GPT-Live's current utterance (see audioOut)
    this.uttSeq = 0;
    this.outQ = []; // [{ buf, at, loud, r }]: output audio waiting HOLD_MS for its words
    this.quiet = { since: 0 }; // when GPT-Live's output last went quiet
    this.suppress = null; // { at }: GPT-Live's audio is dropped until it goes quiet
    this.resultWin = null; // the result being said: { id, content, request, reply, at, openedAt, closed }
    this.pendingResults = new Map(); // append event id -> result window (opened by its acknowledgement)
    this.splitNext = false; // the next words GPT-Live says start a new utterance (a result was injected)
    this.liveSecs = 0; // the session's cumulative billed seconds (session.usage.updated)
    this.lastLang = null;
    this.uttStarts = []; // when the voice began each utterance (wall), for merging turns
    this.diag.gptlive = { delegations: 0, ungrounded: 0, results: 0, cuts: 0, suppressedMs: 0, uttFirst: [], bargeStops: [] };
  }

  /* ---- the upstream leg ---- */

  upstreamUrl() {
    return (this.cfg.wsBase || live.WS_BASE) + "/live/sessions";
  }

  sessionConfig() {
    const input = [];
    const recap = this.recapText();
    if (recap) input.push({ type: "message", role: "developer", content: [{ type: "input_text", text: "This conversation was reconnected." + recap }] });
    return {
      model: GPT_LIVE_MODEL,
      instructions: instructionsFor(this.persona, this.agents),
      ...(input.length ? { input } : {}),
      audio: { format: { type: "audio/pcm", rate: RATE }, output: { voice: this.cfg.voice || "marin" } },
      // Client delegation: this server owns the hand-off (and its transcript, permissions and approvals).
      delegation: { type: "client" },
    };
  }

  /**
   * The other agents JOYA AI can reach (the supervisor's live sessions, from the voice door's snapshot), for
   * the prompt and for the guard ("JOYA Pace replied" is another agent, not JOYA AI as someone else).
   */
  async loadAgents() {
    try {
      const snap = await this.d.ops.snapshot();
      const list = ((snap && snap.sessions && snap.sessions.list) || []).map((x) => String((x && x.name) || "")).filter((n) => n && !/^unnamed/i.test(n));
      this.agents = list.slice(0, 12);
      desk.setJoyaAgents(this.agents);
    } catch (e) {
      this.agents = null;
    }
    return this.agents;
  }

  /** Open the GPT-Live session: no Origin header, session.start, ready on session.started. */
  open() {
    if (this.ready) return this.ready;
    if (!this.agentsP) this.agentsP = this.loadAgents();
    this.ready = new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.upstreamUrl(), {
        headers: { Authorization: "Bearer " + this.cfg.key },
        handshakeTimeout: 10000,
        perMessageDeflate: false,
        ...(this.ipv4() ? { family: 4 } : {}),
      }));
      const up = { at: this.now(), heardAt: this.now(), last: "none", err: "" };
      let opened = false;
      let gone = false;
      const lost = (detail) => {
        if (gone) return;
        gone = true;
        if (ws === this.ws) this.stopKeepalive(), this.stopClock();
        if (ws !== this.ws || this.closed) return !opened && reject(new Error("replaced"));
        const secs = Math.round((this.now() - up.at) / 1000);
        this.log(`live: call ${this.id} gpt-live upstream ${opened ? "lost" : "failed"}: ${detail}${up.err ? ", " + up.err : ""}, after ${secs} s, last event ${up.last}`);
        const why = opened ? "OpenAI closed the live session (" + detail + ")" : /^HTTP (\d+)/.test(detail) ? "OpenAI refused the live session (" + detail.slice(5) + ")" : "Could not reach OpenAI (" + (up.err || detail) + ")";
        if (!opened) return reject(new Error(why));
        this.upstreamLost(why);
      };
      ws.on("unexpected-response", (req, res) => {
        lost("HTTP " + res.statusCode);
        try {
          req.destroy();
        } catch (_) {
          /* gone */
        }
      });
      ws.on("error", (e) => {
        up.err = ("error " + ((e && e.code) || "") + " " + live.scrub((e && e.message) || "").slice(0, 120)).replace(/\s+/g, " ").trim();
      });
      ws.on("close", (code, reason) => lost("code " + code + (reason && reason.length ? ' "' + live.scrub(String(reason)).slice(0, 120) + '"' : "")));
      ws.on("pong", () => (up.heardAt = this.now()));
      // The agents' names go into the prompt: waited for briefly (the supervisor answers in ~50 ms), never blocking the call.
      ws.on("open", () =>
        Promise.race([this.agentsP, new Promise((r) => setTimeout(r, AGENTS_WAIT_MS))]).then(() => {
          if (ws === this.ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "session.start", event_id: "start_" + this.id, session: this.sessionConfig() }));
        })
      );
      ws.on("message", (data) => {
        if (ws !== this.ws) return;
        up.heardAt = this.now();
        let ev;
        try {
          ev = JSON.parse(String(data));
        } catch (_) {
          return;
        }
        up.last = String(ev.type || "?").slice(0, 60);
        if (!opened) {
          if (ev.type === "session.started") {
            opened = true;
            this.sessionAt = this.now();
            this.liveReady = true;
            this.liveSecs = 0;
            this.upWs = ws;
            this.upBase = this.inputMs; // the session's timeline starts with the first audio sent to it
            if (!this.maxTimer) this.maxTimer = this.timer(() => this.close("max-length", "The live conversation reached its 20-minute limit."), this.opts.maxMs);
            if (this.turnMode === "ptt" && !this.pttIdleT) {
              const tick = () => {
                this.pttIdleCheck();
                if (!this.closed) this.pttIdleT = this.timer(tick, 15000);
              };
              this.pttIdleT = this.timer(tick, 15000);
            }
            this.startKeepalive(ws, up);
            this.startClock();
            this.setState("listening");
            return resolve(this);
          }
          if (ev.type === "error") {
            const msg = live.scrub((ev.error && (ev.error.message || ev.error.code)) || "OpenAI error");
            up.err = "OpenAI error " + msg;
            this.log(`live: call ${this.id} OpenAI refused the GPT-Live session: ${msg}`);
            gone = true;
            try {
              ws.close(1000, "refused");
            } catch (_) {
              /* closed */
            }
            return reject(new Error(msg));
          }
          return;
        }
        try {
          this.onUpstream(ev);
        } catch (e) {
          this.log("live: gpt-live event " + ev.type + " failed: " + e.message);
        }
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  /**
   * Only GPT-Live's own events go upstream. What the realtime class sends
   * for its conversation becomes quiet context; the rest (response.cancel,
   * truncation, buffer clears, deletes) has no GPT-Live equivalent and is dropped.
   */
  send(obj) {
    if (!obj || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.liveReady) return;
    let ev = obj;
    if (obj.type === "conversation.item.create" && obj.item && obj.item.type === "message") {
      const text = (obj.item.content || []).map((c) => c.text || "").join(" ").trim();
      if (!text) return;
      const said = obj.item.role === "assistant";
      ev = { type: "session.thinking.append", delegation_id: null, content: (said ? "(You just said to the administrator: " + JSON.stringify(text.slice(0, 600)) + ")" : text).slice(0, APPEND_CHARS) };
    } else if (obj.type === "session.update") {
      return; // instructions are fixed at start; a persona change goes as instructions.append (personaChanged)
    }
    if (!LIVE_EVENTS.has(ev.type)) return;
    if (!ev.event_id) ev = { ...ev, event_id: "e" + this.id + "_" + ++this.evSeq };
    this.ws.send(JSON.stringify(ev));
  }

  /** GPT-Live speaks only while it hears: the server keeps its timeline fed when the page sends nothing. */
  startClock() {
    this.stopClock();
    this.lastInAt = this.now();
    this.clockT = setInterval(() => {
      if (this.closed || !this.liveReady) return;
      const gap = this.now() - this.lastInAt;
      if (gap >= 2 * FRAME_MS) this.appendSilence(Math.min(gap, 1000));
      this.pumpOut();
      this.uttTick();
      this.inputTick();
    }, this.opts.clockMs || CLOCK_MS);
    if (this.clockT.unref) this.clockT.unref();
  }
  stopClock() {
    if (this.clockT) clearInterval(this.clockT);
    this.clockT = null;
  }
  appendSilence(ms) {
    const n = Math.floor(ms / FRAME_MS) * FRAME_MS * BYTES_PER_MS;
    if (n > 0) this.relay(Buffer.alloc(n));
  }

  /** What GPT-Live hears, also kept for the full-turn transcripts (a turn's audio is on the session's timeline). */
  relay(buf) {
    this.lastInAt = this.now();
    this.input.push({ at: this.inputMs, buf, rms: rmsOf(buf) });
    this.inputMs += buf.length / BYTES_PER_MS;
    while (this.input.length && this.input[0].at < this.inputMs - 90 * 1000) this.input.shift();
    this.send({ type: "session.input_audio.append", audio: buf.toString("base64") });
  }

  /** PCM16 mono 24 kHz from the page's microphone; silence in its place when it must not be heard. */
  audioIn(buf) {
    if (this.closed || !buf || !buf.length || buf.length % 2) return;
    if (!this.liveReady) return; // nothing is heard before the session is ready (as the realtime call)
    let heard = !this.muted;
    if (this.turnMode === "ptt" && !this.held) {
      this.idleFrames++;
      heard = false;
    } else if (this.press) {
      this.press.frames++;
      this.press.bytes += buf.length;
    }
    // Speakers mode: the voice must not hear itself. GPT-Live gets silence while it is audible (and the room's tail).
    if (heard && this.turnMode !== "ptt" && this.duplex === "speakers" && (this.audibleNow() || this.now() - this.lastAudibleAt < live.TAIL_MS)) {
      this.diag.gatedMs += buf.length / BYTES_PER_MS;
      heard = false;
    }
    this.lastInAt = this.now(); // the page is sending (while the gate holds speech, it relays silence in its place)
    if (heard) {
      // the raw microphone's last seconds: what a barge-in is checked on (the gate may hold or silence the relayed audio)
      this.rawMic = this.rawMic || [];
      this.rawMic.push({ at: this.now(), buf });
      while (this.rawMic.length && this.rawMic[0].at < this.now() - RAW_MIC_MS) this.rawMic.shift();
    }
    const out = heard ? buf : Buffer.alloc(buf.length);
    if (this.vpGating()) this.speechGate().push(out, this.anythingAudible());
    else {
      if (this.sgate && !this.sgate.idle) this.sgate.release();
      this.relay(out);
    }
    if (heard && this.duplex === "full") this.micBarge(buf);
  }

  /**
   * The voiceprint in front of GPT-Live (lib/voice-speechgate.js): each stretch of speech is checked
   * before GPT-Live hears it; a voice that is not stored is heard as silence. Only with "Only respond
   * to stored voices" on; the turn-level check (vpStart / vpHold) still guards the hand-off.
   */
  /**
   * A voice over the voice (the page's detector, or heard here in headphones mode). With "Only respond to
   * stored voices" on, the voice stops only for a RECOGNISED voice (the administrator, 2026-11-01: "do not
   * stop talking unless you recognize a recognized voice"): the microphone's last BARGE_CHECK_MS go to the
   * voiceprint; accept / sticky stop it, an unknown, unsure or echo voice does not, too short waits for more
   * speech (the next candidate). The service failing or slow: it stops (fail open, as the gate). A tap and
   * the hold-to-talk key always stop it.
   */
  bargeCandidate(how, why) {
    if (!this.vpGating()) return this.bargeAllowed(how, why);
    if (this.bargeCheck || this.now() < (this.bargeNextAt || 0)) return;
    const pcm = Buffer.concat((this.rawMic || []).filter((x) => x.at >= this.now() - BARGE_CHECK_MS).map((x) => x.buf));
    if (!pcm.length) return;
    const cur = this.vpSpeaker ? { id: this.vpSpeaker.id, at: this.vpSpeaker.at } : null;
    const t0 = this.now();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.bargeCheck = null;
      const v = (r && r.verdict) || "error";
      const named = (v === "accept" || v === "sticky") && r.speaker ? r.speaker : null;
      const sc = r && r.score != null ? r.score.toFixed(3) : "-";
      const took = this.now() - t0;
      this.diag.bargeChecks = this.diag.bargeChecks || [];
      this.diag.bargeChecks.push({ how, verdict: v, ms: took });
      if (named || v === "error" || v === "none") {
        if (named) this.vpSpeaker = { ...named, at: this.now() };
        if (this.anythingAudible()) this.bargeAllowed(how, `${why}; voiceprint ${v}${named ? ", " + named.name : ""}, ${sc}, ${took} ms`);
        return;
      }
      // unverified: too little speech yet -- the next candidate (more of it) is checked again
      this.bargeNextAt = this.now() + (v === "unverified" ? 0 : BARGE_RECHECK_MS);
      this.log(`live: call ${this.id} not a barge-in: ${why}; voiceprint ${v}, ${sc}, ${took} ms -> the voice keeps talking`);
    };
    const timer = setTimeout(() => finish({ verdict: "error", error: "slow" }), BARGE_CHECK_WAIT_MS);
    if (timer.unref) timer.unref();
    this.bargeCheck = Promise.resolve()
      .then(() => this.vp.check(pcm, { overVoice: true, voice: this.cfg.voice, current: cur }))
      .catch((e) => ({ verdict: "error", error: String((e && e.message) || e).slice(0, 120) }))
      .then(finish);
  }
  bargeAllowed(how, why) {
    this.log(`live: barge-in (${why})`);
    this.bargeIn(how);
    this.setState("talking");
  }

  speechGate() {
    if (this.sgate) return this.sgate;
    this.sgate = new SpeechGate({
      now: () => this.now(),
      emit: (b) => this.relay(b),
      check: (pcm, o) => {
        const cur = this.vpSpeaker ? { id: this.vpSpeaker.id, at: this.vpSpeaker.at } : null;
        return this.vp.check(pcm, { overVoice: o.overVoice, voice: this.cfg.voice, current: cur });
      },
      on: (e) => this.speechGated(e),
    });
    return this.sgate;
  }
  speechGated(e) {
    const r = e.r || {};
    const named = (r.verdict === "accept" || r.verdict === "sticky") && r.speaker ? r.speaker : null;
    if (named) this.vpSpeaker = { ...named, at: this.now() };
    if (named && this.anythingAudible()) this.bargeAllowed("gate", `${named.name}'s voice over the voice (speech gate)`);
    this.diag.speechGate = this.diag.speechGate || { passed: 0, blocked: 0, heldMs: [] };
    this.diag.speechGate[e.passed ? "passed" : "blocked"]++;
    this.diag.speechGate.heldMs.push(e.heldMs);
    const sc = r.score != null ? r.score.toFixed(3) : "-";
    const who = named ? named.name : r.verdict === "reject" ? "unknown voice" : "nobody named";
    this.log(`live: call ${this.id} speech gate, segment ${e.seg}: ${r.verdict}, ${who}, ${sc}, ${e.heldMs} ms held, checked in ${Math.round(e.ms)} ms${e.overVoice ? ", over the voice" : ""} -> ${e.passed ? "the live voice hears it" : "the live voice hears silence"}${r.error ? ": " + live.scrub(r.error) : ""}`);
    if (!e.passed) {
      const kind = { reject: "other", echo: "echo", uncertain: "unsure" }[r.verdict] || "other";
      this.toClient({ type: "voiceprint", verdict: r.verdict, kind, gated: true, name: null, talkOnly: false, turn: null });
      try {
        if (this.vp.record)
          this.vp.record({ call_id: this.id, turn: 0, mode: "vad", speech_ms: r.speech_ms, score: r.score, tts_score: r.tts_score, verdict: r.verdict || "error", gated: true, acted: "not heard by the live voice", over_voice: !!e.overVoice, ms: r.ms, error: r.error || null, speaker_id: null, speaker: null });
      } catch (_) {
        /* the ledger never stops the audio */
      }
    }
  }

  /**
   * Headphones mode: the administrator's own voice over the voice, heard here in the relayed microphone
   * (BARGE_VOICED_MS of speech within BARGE_WINDOW_MS, above the room's floor). The page's detector does the
   * same, but needs 400 ms of voice; a choppy "Wait, wait, hold on" (~250 ms bursts) took it 2.4 s in the
   * browser run of 2026-10-29, this one 0.35 s. With headphones there is no speaker's leak to allow for.
   */
  micBarge(buf) {
    const now = this.now();
    const rms = rmsOf(buf); // the microphone itself (the speech gate may still be holding what was relayed)
    const ms = buf.length / BYTES_PER_MS;
    if (!this.audibleNow()) {
      // the room's floor, learned while nothing plays (never from speech)
      const f = this.micFloor == null ? rms : this.micFloor;
      this.micFloor = rms < f ? f * 0.9 + rms * 0.1 : rms < f * 2.5 ? f * 0.98 + rms * 0.02 : f;
      this.micVoiced = [];
      return;
    }
    const thr = Math.max(BARGE_RMS, (this.micFloor || 0) * 6);
    this.micVoiced = (this.micVoiced || []).filter((x) => now - x.at < BARGE_WINDOW_MS);
    if (rms >= thr) this.micVoiced.push({ at: now, ms });
    const voiced = this.micVoiced.reduce((n, x) => n + x.ms, 0);
    if (voiced >= BARGE_VOICED_MS) {
      this.micVoiced = [];
      this.bargeCandidate("mic", `a voice over the voice, heard here, ${this.duplex} mode, +${this.sincePlay()} ms into playback`);
    }
  }

  /** Hold-to-talk on GPT-Live: the key decides what it hears; GPT-Live decides when the turn is over. */
  pttDown() {
    if (this.closed || this.turnMode !== "ptt" || this.held) return;
    this.held = true;
    this.pttSeenAt = this.now();
    if (this.audibleNow()) this.bargeIn("ptt");
    this.press = { n: ++this.pressN, at: this.now(), frames: 0, bytes: 0, upstream: this.liveReady, overVoice: false };
    this.setState("talking");
  }
  pttUp() {
    if (this.closed || this.turnMode !== "ptt" || !this.held) return;
    this.held = false;
    this.pttSeenAt = this.now();
    const pr = this.press;
    this.press = null;
    if (pr) this.log(`live: call ${this.id} press ${pr.n}: held ${this.now() - pr.at} ms, ${pr.frames} frames (${Math.round(pr.bytes / BYTES_PER_MS)} ms of audio)`);
    this.setState("thinking");
  }

  mute(on) {
    if (this.closed) return;
    this.muted = on;
    this.setState(on ? "muted" : "listening");
  }

  message(m) {
    if (m && m.type === "voice") {
      // The page's detector: sustained voice above the speaker's leak while the voice is audible is a barge-in.
      this.voiceOn = !!m.on;
      if (this.voiceOn) {
        this.voiceOnAt = this.now();
        if (this.audibleNow()) this.bargeCandidate("voice", `the page heard a voice over the voice, ${this.duplex} mode, +${this.sincePlay()} ms into playback`);
      }
      return;
    }
    if (m && m.type === "interrupt") {
      if (this.audibleNow() || this.utt) {
        this.log(`live: interrupted by the administrator (${this.duplex} mode, +${this.sincePlay()} ms into playback)`);
        this.bargeIn("tap");
        this.instruct("The administrator interrupted you. Stop talking now and listen.");
        this.setState("listening");
      }
      return;
    }
    return super.message(m);
  }

  /* ---- from GPT-Live ---- */

  onUpstream(ev) {
    switch (ev.type) {
      case "session.input_transcript.delta":
        return this.inputDelta(ev);
      case "session.output_transcript.delta":
        return this.outputDelta(ev);
      case "session.output_audio.delta":
        return this.audioOut(ev);
      case "session.delegation.created":
        return this.delegationCreated(ev);
      case "session.usage.updated":
        return this.usageUpdated(ev.usage);
      case "session.closed":
        return this.usageUpdated(ev.usage);
      case "session.commentary.appended":
        return this.resultInjected(ev);
      case "error": {
        const msg = String((ev.error && (ev.error.message || ev.error.code)) || "");
        this.log("live: gpt-live error: " + live.scrub(msg));
        return;
      }
      default:
        return; // the appends' acknowledgements, input_audio.appended, ...
    }
  }

  /** Billing: GPT-Live reports the session's cumulative seconds; each increase is priced (voice_usage, category live). */
  usageUpdated(u) {
    const secs = u && Number(u.seconds);
    if (!Number.isFinite(secs) || secs <= this.liveSecs) return;
    const d = secs - this.liveSecs;
    this.liveSecs = secs;
    this.record({ vt: this.id, part: "realtime", model: GPT_LIVE_MODEL, tokens: { seconds: d } });
  }

  /* ---- the administrator's turns, from GPT-Live's input transcript ---- */

  inputDelta(ev) {
    const text = String(ev.delta || "");
    if (!text) return;
    const s = Number(ev.start_ms);
    const e = Number(ev.end_ms);
    let cur = this.inTurn;
    if (cur && Number.isFinite(s) && s - cur.endTl > TURN_GAP_MS) {
      this.finishTurn(cur);
      cur = null;
    }
    if (!cur) {
      const t = this.turnFor("gl" + (this.turnSeq + 1) + "_" + this.id);
      const startTl = Number.isFinite(s) ? s : Math.max(0, this.inputMs - this.upBase - 1000);
      t.startMs = this.inputMs; // provisional: finishTurn finds the turn in the audio itself (speechSpan)
      t.startedAt = this.now();
      const audible = this.anythingAudible();
      t.overVoice = audible || (this.lastAudibleAt > 0 && t.startedAt - this.lastAudibleAt < 1500);
      t.bargeConfirmed = true; // GPT-Live heard it; a speaker's leak never reaches it in speakers mode
      if (this.resultWin && !this.resultWin.closed && !(this.utt && !this.utt.done)) this.resultWin.closed = true;
      cur = this.inTurn = { t, startTl, endTl: startTl, text: "", at: this.now() };
      t.startTl = startTl;
      if (!this.utt) this.setState("talking");
    }
    cur.text += text;
    this.languageCheck(cur);
    if (Number.isFinite(e)) cur.endTl = Math.max(cur.endTl, e);
    cur.at = this.now();
    cur.t.endTl = cur.endTl;
    cur.t.heardAtMs = this.inputMs; // our timeline when these words arrived (they are ~1 s behind the speech)
  }

  /**
   * GPT-Live keeps answering in the language it last spoke (tested 2026-10-29: an English question after
   * an Arabic exchange was answered in Arabic). As soon as three words of a turn are in another language
   * it is told so -- as quiet context: an instruction can cut off what it is saying.
   */
  languageCheck(cur) {
    const t = cur.t;
    if (t.langSaid) return;
    const words = String(cur.text || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 3 && !cur.final) return;
    const sc = arabic.scriptOf(cur.text);
    const lang = sc.arabic > sc.latin ? "ar" : sc.latin > 0 ? "en" : null;
    if (!lang) return;
    t.langSaid = true;
    if (this.lastLang && lang !== this.lastLang) {
      this.quietNote(null, lang === "ar" ? "The administrator is speaking Arabic now: answer in Egyptian Arabic." : "The administrator is speaking English now: answer in English.");
      this.log(`live: call ${this.id} the administrator switched to ${lang === "ar" ? "Arabic" : "English"}; the live voice is told`);
    }
    this.lastLang = lang;
  }

  inputTick() {
    const cur = this.inTurn;
    if (cur && this.now() - cur.at >= INPUT_QUIET_MS) this.finishTurn(cur);
  }

  /** A turn's words are complete: the checks the realtime call runs on its session transcript. */
  finishTurn(cur) {
    if (this.inTurn === cur) this.inTurn = null;
    const t = cur.t;
    if (t.finished) return;
    t.finished = true;
    t.stoppedAt = this.now();
    const text = cur.text.replace(/\s+/g, " ").trim();
    t.voiceText = text; // GPT-Live's own transcript of the turn: the request text (groundedText)
    const span = this.speechSpan(t.heardAtMs != null ? t.heardAtMs : this.inputMs, t.endTl != null && t.startTl != null ? t.endTl - t.startTl : 0);
    t.startMs = span.start;
    t.endMs = span.end;
    t.resolveSession(null); // no transcription model on GPT-Live: its own transcript is the turn's text
    this.vpStart(t); // the voiceprint checks the turn's audio
    this.checkTurn(t, text);
  }

  checkTurn(t, text) {
    if (this.vpHold(t, () => this.checkTurn(t, text))) return;
    const g = voiceGuard.checkTranscript(text, { audioSeconds: t.endMs != null && t.startMs != null ? (t.endMs - t.startMs) / 1000 : null, sources: live.liveSources() });
    this.diag.transcripts.push({ turn: t.n, kind: "live", ms: 0, ok: g.ok });
    if (!text) return;
    if (this.d.isStop && this.d.isStop(text)) {
      this.diag.stops++;
      return this.stopByVoice(t, text);
    }
    let conf = null;
    if (this.d.confirmHeard && !t.talkOnly && t.n > (this.confirmAfter || 0) && (!this.d.confirmPending || this.d.confirmPending())) conf = this.d.confirmHeard(text);
    if (conf && (conf.confirmed || conf.cancelled)) {
      const e = conf.confirmed || conf.cancelled;
      t.dropped = "confirm-answer";
      this.toClient({ type: conf.confirmed ? "ui-confirmed" : "ui-confirm-cancelled", id: e.id });
      this.toClient({ type: "caption", who: "you", text, final: true });
      return;
    }
    if (this.undoUntil > this.now() && this.d.isUndo && this.d.isUndo(text) && !t.talkOnly) {
      this.diag.undos = (this.diag.undos || 0) + 1;
      return this.undoByVoice(t, text);
    }
    if (this.d.hearPersona) {
      const before = JSON.stringify([this.persona.dialect, this.persona.gender]);
      this.persona = personaLib.clean(this.d.hearPersona(text));
      if (JSON.stringify([this.persona.dialect, this.persona.gender]) !== before) this.instruct(personaLib.liveNote(this.persona));
    }
    this.languageCheck({ text, t, final: true });
    this.heard.push(text);
    this.lastHeardN = t.n;
    this.addRecap("you", text);
    this.toClient({ type: "caption", who: "you", text, final: true });
    if (t.waiters) for (const fn of t.waiters.splice(0)) fn();
  }

  /**
   * Where a turn is in the audio this server relayed. GPT-Live's start_ms / end_ms run on its own clock,
   * which drifts from the audio sent (measured 2026-10-29: 0.6 s ahead at the start of a session, 2 s
   * after four minutes), so the words' times only say how long the turn was. The turn is found in the
   * audio: the last speech before its words arrived (they arrive ~1-2 s after it was said), back to a
   * pause of SPAN_GAP_MS, with TURN_PAD_MS either side.
   */
  speechSpan(heardAtMs, durMs) {
    const chunks = this.input.filter((c) => c.at <= heardAtMs + 200);
    if (!chunks.length) return { start: Math.max(0, heardAtMs - Math.max(durMs, 1000) - 1500), end: heardAtMs };
    const sorted = chunks.map((c) => c.rms).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
    const thr = Math.max(SPEECH_RMS, floor * 3);
    const voiced = (c) => c.rms >= thr;
    let i = chunks.length - 1;
    // The words arrive after the speech: look back up to SPAN_LOOKBACK_MS for where it ended.
    while (i >= 0 && !voiced(chunks[i]) && heardAtMs - chunks[i].at < SPAN_LOOKBACK_MS) i--;
    if (i < 0 || !voiced(chunks[i])) return { start: Math.max(0, heardAtMs - Math.max(durMs, 1000) - 1500), end: heardAtMs };
    const end = chunks[i].at + chunks[i].buf.length / BYTES_PER_MS;
    let start = chunks[i].at;
    let gapFrom = null;
    for (let j = i; j >= 0; j--) {
      const c = chunks[j];
      if (end - c.at > SPAN_MAX_MS) break;
      if (voiced(c)) {
        start = c.at;
        gapFrom = null;
      } else {
        if (gapFrom == null) gapFrom = c.at + c.buf.length / BYTES_PER_MS;
        if (gapFrom - c.at >= SPAN_GAP_MS) break;
      }
    }
    return { start: Math.max(0, start - TURN_PAD_MS), end: end + TURN_PAD_MS };
  }

  /** The turn ends when it ends: drop() is the realtime model's item delete; here only the mark. */
  drop(t, rule) {
    if (t.dropped) return;
    t.dropped = rule;
    this.log(`live: dropped a turn (${rule})`);
  }
  undoByVoice(t, text) {
    this.undoUntil = 0;
    this.drop(t, "undo-command");
    this.toClient({ type: "ui-undo" });
    this.toClient({ type: "caption", who: "you", text, final: true });
    try {
      if (this.d.audit) this.d.audit(`undo by the live voice ("${text.slice(0, 40)}")`);
    } catch (_) {
      /* best effort */
    }
  }
  stopByVoice(t, text) {
    t.dropped = "stop-command";
    this.toClient({ type: "flush", at: this.now() });
    this.toClient({ type: "stop", why: "voice-command", text });
    this.close("voice-command", undefined, JSON.stringify(String(text || "").slice(0, 60)));
  }

  /* ---- delegation: GPT-Live asks for the real work ---- */

  delegationCreated(ev) {
    const d = ev && ev.delegation;
    if (!d || !d.id) return;
    const dg = { id: String(d.id), offset: Number(ev.offset_ms), at: this.now(), turn: null, requestId: null, done: false };
    this.delegs.set(dg.id, dg);
    if (this.delegs.size > 40) this.delegs.delete(this.delegs.keys().next().value);
    this.diag.gptlive.delegations++;
    this.setState("thinking");
    this.handleDelegation(dg).catch((e) => this.log("live: a delegation failed: " + live.scrub(e.message)));
  }

  /** The turn a delegation is about: the one being heard, or the last one heard before it (not yet asked). */
  turnForDelegation(dg) {
    if (this.inTurn) return this.inTurn.t;
    const ts = [...this.turns.values()].filter((t) => t.finished && !t.dropped);
    for (let i = ts.length - 1; i >= 0; i--) {
      const t = ts[i];
      if (Number.isFinite(dg.offset) && t.startTl != null && t.startTl > dg.offset + 500) continue;
      return t;
    }
    return null;
  }

  /**
   * One request said in pieces (a pause mid-sentence makes two turns): the
   * finished, unasked turns just before this one, close together and with
   * nothing said by the voice between them, become one -- its audio, its
   * transcript, GPT-Live's words.
   */
  mergeBack(t) {
    const ts = [...this.turns.values()].filter((x) => x.finished && !x.dropped && !x.asked && x.n <= t.n);
    let i = ts.indexOf(t);
    if (i < 0) return t;
    let first = i;
    while (first > 0) {
      const a = ts[first - 1];
      const b = ts[first];
      const gap = b.startTl != null && a.endTl != null ? b.startTl - a.endTl : Infinity;
      const spokeBetween = this.uttStarts.some((at) => at > (a.stoppedAt || 0) && at < (b.startedAt || 0));
      if (gap > MERGE_GAP_MS || spokeBetween) break;
      first--;
    }
    if (first === i) return t;
    const base = ts[first];
    const parts = ts.slice(first, i + 1);
    base.endMs = t.endMs;
    base.endTl = t.endTl;
    base.voiceText = parts.map((x) => x.voiceText || "").join(" ").replace(/\s+/g, " ").trim();
    for (const x of parts.slice(1)) x.dropped = "merged";
    base.heardDone = null;
    this.diag.merged++;
    this.log(`live: call ${this.id} turns ${base.n}-${t.n} heard as one request`);
    return base;
  }

  async handleDelegation(dg) {
    let t = this.turnForDelegation(dg);
    dg.turn = t;
    const L = desk.linesFor(this.lang(), this.persona.gender);
    if (!t) {
      this.diag.gptlive.ungrounded++;
      return this.result(dg.id, L.notCaught || "I didn't catch that. Could you say it again?", { fixed: true });
    }
    // Its words first: the turn may still be arriving (the delegation can come before its last words).
    if (!t.finished) {
      await new Promise((res) => {
        (t.waiters = t.waiters || []).push(res);
        this.timer(res, DELEG_WAIT_MS);
      });
      if (!t.finished && this.inTurn && this.inTurn.t === t) this.finishTurn(this.inTurn);
    }
    if (this.closed) return;
    if (t.dropped) return this.quietNote(dg.id, "Nothing to do for that request: it was handled on the screen.");
    t = this.mergeBack(t);
    dg.turn = t;
    if (t.talkOnly) return this.result(dg.id, this.lang() === "ar" ? live.TALK_ONLY_LINE.ar : live.TALK_ONLY_LINE.en, { fixed: true });
    if (t.asked) {
      // GPT-Live asked twice for one turn: the same request, one answer.
      const req = [...this.requests.entries()].find(([, x]) => x.turnN === t.n);
      if (req) req[1].delegations = (req[1].delegations || []).concat([dg.id]);
      return this.quietNote(dg.id, "This request is already being worked on; its result will come.");
    }
    t.handing = true; // a cut or a "let me check" meanwhile is this request, not another one
    const request = await this.groundedText(t);
    if (this.closed) return;
    const why = !request ? "ungrounded" : voiceGuard.refuseAtDoor(request) ? "echo" : null;
    if (why) {
      t.handing = false;
      this.diag.gptlive.ungrounded++;
      this.diag.refused.push("delegation:" + why);
      this.log(`live: call ${this.id} turn ${t.n}: a delegation with nothing grounded to pass on (${why})`);
      return this.result(dg.id, L.notCaught || "I didn't catch that. Could you say it again?", { fixed: true });
    }
    if (t.asked) return this.quietNote(dg.id, "This request is already being worked on; its result will come.");
    try {
      const tt = await this.handOver(t, request);
      const mine = tt && tt.id ? this.requests.get(tt.id) : null;
      if (mine) mine.delegations = (mine.delegations || []).concat([dg.id]);
      dg.requestId = tt && tt.id;
      // A long wait: once, a quiet note so GPT-Live can say it is still on it if asked (never a result).
      this.timer(() => {
        const m = dg.requestId != null ? this.requests.get(dg.requestId) : null;
        if (m && !m.answered) this.quietNote(dg.id, "Still working on this request; no result yet.");
      }, STUCK_MS);
    } catch (e) {
      this.log("live: could not pass a delegation on: " + live.scrub(e.message));
      this.result(dg.id, L.unreachable || "I can't reach my own work right now. Please try again in a moment.", { fixed: true });
    }
  }

  /**
   * The hand-off's words: GPT-Live's own transcript of the turn (t.voiceText), or "" when there is none
   * or it fails the transcript guard (voiceGuard.checkTranscript, with the turn's length taken as the
   * longer of the audio span found for it and GPT-Live's own word timings, so a span found short never
   * makes a real request "too many words") or the door guard. No transcription model, no retry, and no
   * note about another transcript (LiveCall.groundedText's candidates are the realtime voice's).
   */
  async groundedText(t) {
    if (t.heardDone != null) return t.heardDone;
    if (t.dropped) return "";
    const text = String(t.voiceText || "").replace(/\s+/g, " ").trim();
    const spanS = t.endMs != null && t.startMs != null ? (t.endMs - t.startMs) / 1000 : 0;
    const wordsS = t.endTl != null && t.startTl != null ? (t.endTl - t.startTl) / 1000 : 0;
    const g = voiceGuard.checkTranscript(text, { audioSeconds: Math.max(spanS, wordsS) || null, sources: live.liveSources() });
    if (!g.ok || voiceGuard.refuseAtDoor(text)) {
      if (text) this.log(`live: call ${this.id} turn ${t.n} hand-off text refused by the transcript guard (${g.ok ? "echo" : g.rule})`);
      t.heardDone = "";
      return "";
    }
    t.heardNote = null;
    t.heardFrom = "gpt-live";
    t.heardDone = text.slice(0, 20000);
    return t.heardDone;
  }

  /** No transcription model on GPT-Live: nothing is transcribed (or billed) here. */
  async transcribeTurn() {
    return null;
  }

  /**
   * The turn to JOYA AI, once: a delegation, a guard cut and an unbacked "let me check" can each want to
   * hand the same turn over, sometimes at the same moment (seen 2026-10-29: two hand-offs of one request).
   */
  handOver(t, request) {
    if (!t.handP) t.handP = this.passOn(t, request);
    return t.handP;
  }

  /** Quiet context about a delegation (cancels GPT-Live's pending automatic acknowledgement). */
  quietNote(delegationId, text) {
    this.send({ type: "session.thinking.append", delegation_id: delegationId || null, content: String(text).slice(0, APPEND_CHARS) });
  }
  /** An instruction to the live voice (it may interrupt what it is saying). */
  instruct(text) {
    this.send({ type: "session.instructions.append", delegation_id: null, content: String(text).slice(0, APPEND_CHARS) });
  }

  /**
   * Something for GPT-Live to say, about a delegation (or the session, null).
   * A result opens the result window: what GPT-Live says next is judged with
   * the summary rules against exactly this text, a sentence at a time.
   */
  result(delegationId, content, o) {
    o = o || {};
    const text = String(content || "").trim();
    if (!text || this.closed) return;
    const win = { id: o.id || null, content: text, request: o.request || "", at: this.now(), openedAt: 0, delegationId: delegationId || null, fixed: !!o.fixed, continuation: !!o.continuation, reply: o.reply || text, source: o.source || o.reply || text, spoken: [], closed: false };
    this.diag.gptlive.results++;
    // Measured: GPT-Live can start saying a result before its append is acknowledged. With nothing being
    // said, it is the result from now; mid-utterance, the acknowledgement marks where the result starts.
    const speaking = !!(this.utt && !this.utt.done);
    let first = true;
    for (const c of chunksOf(text)) {
      const eid = "c" + this.id + "_" + ++this.evSeq;
      if (speaking || !first) this.pendingResults.set(eid, win);
      this.send({ type: "session.commentary.append", event_id: eid, delegation_id: delegationId || null, content: c });
      if (!speaking && first) this.resultInjected({ client_event_id: eid }, win);
      first = false;
    }
  }

  /**
   * GPT-Live has the result (its acknowledgement): what it says from now on
   * is the result, judged against it -- a new utterance starts with its next
   * words. A later part of the same reply joins the open window.
   */
  resultInjected(ev, direct) {
    const win = direct || this.pendingResults.get(ev.client_event_id);
    if (!win) return;
    this.pendingResults.delete(ev.client_event_id);
    const w = this.resultWin;
    if (w && !w.closed && w.id != null && w.id === win.id && w !== win) {
      w.content += " " + win.content;
      w.reply = win.reply || w.reply;
      w.source = win.source || w.source;
      w.at = this.now();
      return;
    }
    if (w === win) return;
    if (w && !w.closed) w.closed = true;
    win.openedAt = this.now();
    win.at = this.now();
    this.resultWin = win;
    if (this.utt && !this.utt.done && this.utt.result !== win) this.splitNext = true;
  }
  openResult() {
    const w = this.resultWin;
    if (!w || w.closed) return null;
    if (this.now() - w.at > RESULT_WINDOW_MS) {
      w.closed = true;
      return null;
    }
    return w;
  }

  /* ---- JOYA AI's answers, said by GPT-Live ---- */

  delegationFor(mine) {
    const ids = (mine && mine.delegations) || [];
    for (let i = ids.length - 1; i >= 0; i--) if (this.delegs.has(ids[i])) return ids[i];
    return null;
  }

  /**
   * JOYA AI's finished reply, to GPT-Live as commentary it says in its own words (each part judged against
   * exactly that text: newUtterance). Since 2026-10-30 a finished request always gets a DETAILED summary
   * ("always reading a detailed summary when a delegation is finished"): the Summariser
   * (lib/voice-shared.js: every key fact and figure in a few sentences, through the summary guard) writes
   * it and each released line is handed over at once, so GPT-Live starts on the first sentence while the
   * next is written (~1 s, measured). Not GPT-Live itself: told to summarise a long reply it would decide
   * what to drop, and its result guard can only check what it says against the text it was given. Kept:
   *   - a short plain reply is handed over whole (nothing to summarise);
   *   - part of the reply said while it was written, and the final text goes on the same way: the rest is
   *     handed over as written when that finishes it, else the summary covers the rest (told what was
   *     already heard, so it does not repeat it); a final text that differs gets the summary of all of it;
   *   - no summary (it failed, or there is no summariser): the reply's first sentences, then the details line.
   * A cut while GPT-Live says it: the verbatim reader reads the summary on from the cut sentence (afterCut).
   */
  async deliverReply(id, reply, request) {
    const mine = this.requests.get(id);
    if (!mine || mine.answered) return;
    mine.answered = true;
    mine.repliedAt = this.now();
    this.toClient({ type: "replied", turn: id });
    const st = mine.stream;
    if (st) this.closeStream(st);
    const clean = this.d.redact ? this.d.redact(reply) : reply;
    this.replies.push(reply);
    const asked = mine.text || request || "";
    this.firstSpokenFor = { id, at: mine.repliedAt, askedAt: mine.askedAt };
    let alreadySaid = [];
    if (st && st.read.length) {
      // Part of it was said while it was written: the rest, if the final text goes on the same way.
      const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const sents = speakableSentences(clean);
      const same = st.read.every((s, i) => norm(s) === norm(sents[i]));
      const listy = /```|\n\s*[-*|#]/.test(reply);
      if (same && !listy && sents.length <= live.STREAM_MAX_SENTENCES) {
        const rest = sents.slice(st.read.length).join(" ").trim();
        if (rest) this.result(this.delegationFor(mine), rest, { id, request: asked, reply: clean, source: clean });
        this.log(`live: call ${this.id} request ${id}: result handed to the live voice ${mine.askedAt ? mine.repliedAt - mine.askedAt + " ms after the ask" : ""} (the rest as written)`);
        return;
      }
      if (same) alreadySaid = st.read.slice();
      else this.log(`live: call ${this.id} request ${id}: the final reply differs from what was said as it was written; the summary of all of it follows`);
    }
    const parts = [];
    const give = (text) => {
      const t = String(text || "").trim();
      if (!t || this.closed) return;
      parts.push(t);
      // The window's `reply` is the summary so far: a cut is read on from it, word for word (afterCut).
      this.result(this.delegationFor(mine), t, { id, request: asked, reply: parts.join(" "), source: clean });
    };
    let fallback = !this.d.summarise;
    const t0 = this.now();
    const verbatim = [];
    if (this.d.summarise) {
      try {
        const out = await this.d.summarise(id, {
          onLine: (l) => {
            if (!parts.length) this.log(`live: call ${this.id} request ${id}: first summary line ${this.now() - t0} ms after the reply`);
            // The rest of the reply after a summary cut (Summariser restOfReply): word for word, by the reader,
            // once GPT-Live has said the lines before it -- never back to GPT-Live to paraphrase.
            if (l.verbatim) return verbatim.push(l);
            if (l.details) return (verbatim.length ? verbatim.push({ text: this.detailsLine(reply, id), safe: true }) : give(this.detailsLine(reply, id)));
            give(l.text);
          },
          persona: this.persona,
          request: String(asked),
          lastSaid: this.heard.length ? this.heard[this.heard.length - 1] : "",
          alreadySaid,
        });
        if (out && out.tokens) this.record({ vt: this.id + "r" + id, part: "desk", model: desk.SUMMARY_MODEL, tokens: out.tokens });
        if (out && (out.fallback === "verbatim" || out.pending) && !parts.length) fallback = true;
      } catch (e) {
        this.log("live: the summary failed: " + live.scrub(e.message));
        if (!parts.length) fallback = true;
      }
    }
    if (verbatim.length && !this.closed) {
      this.log(`live: call ${this.id} request ${id}: the summary was cut part-way; the rest of the reply (${verbatim.length} line${verbatim.length === 1 ? "" : "s"}) is read word for word`);
      await this.afterResultSaid(id);
      this.quietNote(null, "The rest of the result is being read to the administrator word for word: " + verbatim.map((l) => l.text).join(" ").slice(0, 800));
      this.say(verbatim, "joya", null, this.id + "r" + id);
    }
    if (fallback && !this.closed) {
      const sents = speakableSentences(clean).slice(alreadySaid.length);
      let content = sents.slice(0, live.VERBATIM_MAX_SENTENCES).join(" ");
      if (sents.length > live.VERBATIM_MAX_SENTENCES || /```|\n\s*[-*|#]/.test(reply)) content += " " + this.detailsLine(reply, id);
      if (!sents.length && !alreadySaid.length) content = this.detailsLine(reply, id);
      give(content);
    }
    this.log(`live: call ${this.id} request ${id}: result handed to the live voice ${mine.askedAt ? mine.repliedAt - mine.askedAt + " ms after the ask" : ""}${fallback ? " (as written)" : " (detailed summary)"}`);
  }

  /**
   * Wait (at most RESULT_SAID_MAX_MS) until GPT-Live has said the result it was given for request `id`:
   * its window opened, an utterance of it began and ended, and nothing is being said now.
   */
  async afterResultSaid(id) {
    const end = this.now() + RESULT_SAID_MAX_MS;
    while (!this.closed && this.now() < end) {
      const w = this.resultWin;
      const said = w && w.id === id && (w.utts || 0) > 0;
      if (said && (!this.utt || this.utt.done)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /** "The details are on screen" when the page showed reply `id`, else an offer to say the rest (LiveCall.screenLine). */
  detailsLine(reply, id) {
    return this.screenLine(arabic.isArabic(reply) ? "ar" : "en", id);
  }

  /** A sentence of JOYA AI's reply released while it is written: GPT-Live says it at once. */
  streamSay(st, line) {
    if (st.stopped || this.closed) return;
    if (st.gen !== this.speechGen) return this.streamStop(st, "talked over");
    if (st.read.length >= live.STREAM_MAX_SENTENCES) {
      st.more = true;
      return;
    }
    const mine = this.requests.get(st.id) || {};
    if (!st.read.length) {
      st.firstAt = this.now();
      this.log(`live: call ${this.id} request ${st.id}: first sentence of the reply handed to the live voice while it is written, ${st.firstAt - (mine.askedAt || st.at)} ms after the ask`);
      this.toClient({ type: "replying", turn: st.id }); // the page shows the reply as it is written (its reply card)
    }
    st.read.push(line);
    st.msgRead.push(line);
    this.result(this.delegationFor(mine), line, { id: st.id, request: mine.text || st.request, reply: st.raw });
  }

  /* ---- GPT-Live's speech: held, guarded, then played ---- */

  newUtterance() {
    const r = { n: ++this.uttSeq, seg: 0, text: "", at: this.now(), lastAt: this.now(), loudAt: 0, chunks: 0, sentBytes: 0, trip: null, cancelled: false, done: false, firstOut: null };
    const w = this.openResult();
    r.result = w;
    if (w) {
      w.utts = (w.utts || 0) + 1;
      r.ctx = () => ({ summary: true, replyText: w.content, replyModel: desk.replyModel(w.content), heardText: w.request, snapshotText: "", numbers: desk.strictNumberSet([w.content, w.request]), replied: true, grounded: true });
      r.rel = new desk.Releaser(r.ctx, (line) => this.onSaid(r, line), { summary: true });
      r.hold = this.opts.resultHold || RESULT_HOLD;
    } else {
      r.rel = new desk.Releaser(() => this.context(), (line) => this.onSaid(r, line));
      r.hold = "words";
    }
    const askedRecently = () => [...this.delegs.values()].some((d) => this.now() - d.at < 30000) || !!(this.lastTurn && this.lastTurn.asked);
    r.info = { askedNow: askedRecently, pending: () => this.anyPending(), lookedNow: () => false };
    this.utt = r;
    this.uttStarts.push(r.at);
    if (this.uttStarts.length > 50) this.uttStarts.shift();
    return r;
  }

  outputDelta(ev) {
    const text = String(ev.delta || "");
    if (!text) return;
    if (this.suppress) return; // what it says while being cut off is not heard, and not judged
    let r = this.utt;
    if (r && !r.done && this.splitNext) {
      this.splitNext = false;
      this.endUtterance(r, true);
      r = null;
    }
    if (!r || r.done) r = this.newUtterance();
    r.text += text;
    r.lastAt = this.now();
    this.judgeUtt(r, false);
    if (r.rel.trip && !r.trip) return this.cut(r);
    // A result in "words" mode: the figures of the words so far (but the last two, which may still be
    // part of a number: «واحد و...») are checked before they are heard; the rest of the rules at each sentence.
    if (r.result && r.hold === "words") {
      const words = r.text.trim().split(/\s+/);
      if (words.length > 2) {
        const part = words.slice(0, -2).join(" ");
        const g = desk.judge(desk.sentencesOf(part, true), r.ctx());
        if (!g.ok && /figure|number|script/.test(g.rule)) {
          r.rel.trip = { ...g, sentence: desk.sentencesOf(part, true)[g.at] || "" };
          return this.cut(r);
        }
      }
    }
  }

  audioOut(ev) {
    const buf = Buffer.from(ev.delta || "", "base64");
    if (!buf.length) return;
    const loud = rmsOf(buf) >= LOUD_RMS;
    if (this.suppress) {
      this.diag.gptlive.suppressedMs += buf.length / BYTES_PER_MS;
      if (loud) this.suppress.quietAt = 0;
      else if (!this.suppress.quietAt) this.suppress.quietAt = this.now();
      const quietFor = this.suppress.quietAt ? this.now() - this.suppress.quietAt : 0;
      if (quietFor >= SUPPRESS_QUIET_MS || this.now() - this.suppress.at > SUPPRESS_MAX_MS) {
        const s = this.suppress;
        this.suppress = null;
        const b = s.barge;
        if (b) b.upstreamQuietAt = this.now();
        this.log(`live: call ${this.id} the live voice is quiet again ${this.now() - s.at} ms after the ${s.why}`);
      }
      return;
    }
    // While the verbatim reader speaks (a safe line, a result read word for word), GPT-Live is not heard.
    if (this.speechBusy) return;
    let r = this.utt;
    if (loud) {
      if (!r || r.done) r = this.newUtterance();
      r.loudAt = this.now();
      if (!r.firstLoudIn) r.firstLoudIn = this.now();
    }
    if (!r || r.done || r.cancelled || r.trip) return; // silence between utterances is not sent
    r.lastAt = loud ? this.now() : r.lastAt;
    this.outQ.push({ buf, at: this.now(), r, tag: null });
    this.pumpOut();
  }

  /** Send every held chunk whose time (and, for a result, whose sentence) has come. */
  pumpOut() {
    const now = this.now();
    const hold = this.opts.holdMs != null ? this.opts.holdMs : HOLD_MS;
    while (this.outQ.length) {
      const c = this.outQ[0];
      const r = c.r;
      if (r.cancelled || r.trip) {
        this.outQ.shift();
        continue;
      }
      if (now - c.at < hold) break;
      if (!r.seg && r.leadUntil == null) r.leadUntil = c.at + hold + (this.opts.leadMs != null ? this.opts.leadMs : LEAD_MS);
      if (r.leadUntil != null && now < r.leadUntil) break;
      // The sentence this chunk belongs to: tagged when its words have had HOLD_MS to arrive.
      if (c.tag == null) c.tag = live.audioTag(r.text);
      if (r.hold === "sentence" && !r.done && c.tag >= r.rel.released) break;
      this.outQ.shift();
      this.playChunk(r, c.buf);
    }
  }

  playChunk(r, buf) {
    if (!r.seg) {
      r.seg = ++this.segSeq;
      this.segs.set(r.seg, { kind: r.result ? "joya" : "desk", itemId: null, sentBytes: 0 });
      this.toClient({ type: "seg", seg: r.seg, kind: r.result ? "joya" : "desk" });
    }
    const s = this.segs.get(r.seg);
    if (r.firstOut == null) {
      r.firstOut = this.now();
      this.diag.gptlive.uttFirst.push({ utt: r.n, result: !!r.result, heldMs: r.firstLoudIn ? r.firstOut - r.firstLoudIn : null });
      this.setState("speaking");
      const f = r.result && this.firstSpokenFor;
      if (f && r.result.id === f.id) {
        this.firstSpokenFor = null;
        this.log(`live: call ${this.id} request ${f.id}: asked→reply ${f.askedAt ? f.at - f.askedAt + " ms (JOYA AI)" : "-"}, reply→first word heard ${this.now() - f.at} ms (the live voice)`);
      }
    }
    this.sentAudio(s, buf.length);
    r.sentBytes += buf.length;
    this.d.client.audio(r.seg, buf);
  }

  /** The utterance has ended: its last sentence is judged as final, and released. */
  uttTick() {
    const r = this.utt;
    if (!r || r.done) return;
    const quietFor = this.now() - Math.max(r.loudAt || 0, r.lastAt || 0);
    if (quietFor < QUIET_END_MS) return;
    this.endUtterance(r);
  }

  endUtterance(r, split) {
    if (r.done) return;
    if (!r.trip && !r.cancelled) {
      this.judgeUtt(r, true);
      if (r.rel.trip && r.rel.trip.rule === "unbacked-checking") {
        // "Let me check" said before the delegation event arrived (measured: it can come a moment after the
        // words). Not cut: it is MADE true -- unless a delegation comes within UNBACKED_WAIT_MS, the turn
        // goes to JOYA AI as if GPT-Live had delegated it.
        r.rel.trip = null;
        r.rel.update(r.text, true, { ...r.info, askedNow: () => true });
        this.backCheck(r);
      }
      if (r.rel.trip) this.cut(r);
    }
    r.done = true;
    if (this.utt === r) this.utt = null;
    this.pumpOut();
    if (r.seg) this.toClient({ type: "segend", seg: r.seg });
    if (r.result) {
      r.result.spoken.push(r.rel.heardText());
      // Per result: what the live voice said of it (its own words, short), so a "said twice" can be traced.
      const w = r.result;
      const n = r.rel.sentences.length;
      this.log(
        `live: call ${this.id} request ${w.id != null ? w.id : "-"}: the live voice said ${n} sentence${n === 1 ? "" : "s"} of the result (utterance ${w.utts || 1} of it, ${r.rel.released} passed${r.trip ? ", cut: " + r.trip.rule : ""}${r.cancelled ? ", talked over" : ""}): ` +
          JSON.stringify(live.scrub(String(r.text || "").replace(/\s+/g, " ").trim()).slice(0, 240))
      );
      // Said: the window closes once an utterance of it has ended with nothing new appended for a while.
      if (!split && !r.trip && this.now() - r.result.at > 1500) r.result.closed = true;
    }
    if (!r.trip && !this.closed && !this.inTurn) this.setState(this.anyPending() ? "waiting" : "listening");
  }

  /**
   * The Releaser over what GPT-Live has said. One thing it reads differently here: "I'll check that right
   * now" («هشوف حالا») is a promise to the realtime rules, but with a delegation behind it, it is only
   * true -- such a sentence (it says it is checking, and passes without its "now") is waived: judged as a
   * neutral line, and captioned as said.
   */
  judgeUtt(r, final) {
    r.waived = r.waived || [];
    const PLACE = "One moment.";
    let text = r.text;
    for (const w of r.waived) text = text.replace(w, PLACE);
    r.rel.update(text, final, r.info);
    const tr = r.rel.trip;
    if (!tr || r.result || !/^(promise|unbacked-checking)$/.test(tr.rule)) return;
    const sentence = tr.sentence || "";
    const backed = r.info.askedNow() || r.info.pending();
    const plain = sentence.replace(/\b(?:right now|right away|now|immediately)\b|حالا|حالًا|دلوقتي|فورا|فورًا/giu, " ").replace(/\s+/g, " ").trim();
    if (!backed || !sentence || !desk.mentionsChecking(sentence) || !desk.judge(desk.sentencesOf(plain, true), { ...this.context(), askedNow: true }).ok) return;
    const orig = desk.sentencesOf(r.text, true).find((x) => x.replace(/[^\p{L}\p{N}]+/gu, "") === sentence.replace(/[^\p{L}\p{N}]+/gu, "")) || sentence;
    r.waived.push(orig);
    r.waivedOrig = (r.waivedOrig || []).concat([orig]);
    r.rel.trip = null;
    this.log(`live: call ${this.id} "checking" with a delegation behind it is not a promise: waived`);
    this.judgeUtt(r, final);
  }

  /** An unbacked "let me check": a delegation soon after makes it true; otherwise the turn is handed over here. */
  backCheck(r) {
    const t = this.lastTurn;
    const since = r.at - 3000;
    this.timer(async () => {
      if (this.closed) return;
      const delegated = [...this.delegs.values()].some((d) => d.at >= since);
      if (delegated || !t || t.asked || t.handing || t.dropped) return;
      this.log(`live: call ${this.id} turn ${t.n}: the live voice said it would check without delegating; handed to JOYA AI here`);
      this.diag.gptlive.madeTrue = (this.diag.gptlive.madeTrue || 0) + 1;
      try {
        const request = await this.groundedText(t);
        if (!request || voiceGuard.refuseAtDoor(request) || t.asked || t.handing || this.closed) return;
        await this.handOver(t, request);
      } catch (e) {
        this.log("live: could not hand the turn over: " + live.scrub(e.message));
      }
    }, UNBACKED_WAIT_MS);
  }

  onSaid(r, line) {
    if (line === "One moment." && r.waivedOrig && r.waivedOrig.length) line = r.waivedOrig.shift();
    this.spoken.push({ text: line, at: this.now() });
    if (this.spoken.length > 40) this.spoken.shift();
    this.addRecap("me", line);
    this.toClient({ type: "caption", who: r.result ? "joya" : "desk", text: line, final: true, seg: r.seg || undefined });
  }

  /**
   * The guard cut what GPT-Live was saying: the page drops it, GPT-Live is
   * told to stop and is not heard until it is quiet; then the safe line (or
   * the result, word for word) is read by the verbatim reader.
   */
  cut(r) {
    if (r.trip) return;
    r.trip = { ...r.rel.trip };
    this.diag.gptlive.cuts++;
    this.diag.trips.push({ rule: r.trip.rule, released: r.rel.released, result: !!r.result });
    this.log(`live: guard cut the live voice (${r.trip.rule}${r.result ? ", while saying a result" : ""}): ${JSON.stringify(String(r.trip.match || "")).slice(0, 160)}`);
    this.outQ = this.outQ.filter((c) => c.r !== r);
    if (r.seg) {
      const s = this.segs.get(r.seg);
      if (s) s.over = true;
      this.toClient({ type: "cut", seg: r.seg });
    }
    this.suppress = { at: this.now(), quietAt: 0, why: "guard cut" };
    this.instruct("Stop speaking now. Say nothing more about that; the administrator is being told the correct information.");
    this.afterCut(r).catch((e) => this.log("live: after a cut: " + live.scrub(e.message)));
  }

  /**
   * What the administrator heard of a cut utterance and the guard passed. Holding a result "by words", its
   * audio plays as it comes, ahead of the Releaser: a sentence is released only once the next one is
   * complete (needsNext), so at a cut the sentence before the cut one was HEARD but not yet released (call
   * lv1g84s: the reader then read it again). The judge passes every sentence before the one it cut at
   * (trip.at): those were heard. Held "by sentence", only released sentences were played.
   */
  heardBeforeCut(r) {
    const passed = r.rel.sentences.slice(0, r.rel.released);
    if (r.hold !== "words" || !r.trip || !Number.isInteger(r.trip.at)) return passed.join(" ");
    const list = desk.sentencesOf(r.text, true);
    return (list.length > passed.length && r.trip.at > passed.length ? list.slice(0, r.trip.at) : passed).join(" ");
  }

  async afterCut(r) {
    const said = r.rel.sentences.slice(0, r.rel.released).join(" ");
    if (r.result) {
      // A result GPT-Live was cut on. Its audio plays as the words arrive (RESULT_HOLD "words"), so the
      // administrator HEARD everything it said up to the cut, the cut sentence included. Heard = each of the
      // result's sentences matched by content (GPT-Live joins and splits them: call lv1g84s) OR at a position
      // GPT-Live already reached (it changes a word: «مش بقدر» for «مش هقدر» on call lv1m3r7, 2026-10-30, and
      // the content match alone read that sentence again). Only a cut for a wrong fact (FACT_RULES: a figure,
      // a flipped "not", a claim the result does not make) has its sentence said again, correctly; a cut on
      // style (added advice, an Arabic clause the parser cannot read) re-says nothing. What is left goes back
      // to GPT-Live itself, as a commentary, so it is said in the same voice ("then in another voice it is
      // said again": the reader is GPT Realtime 2.1 mini); only a cut on that continuation falls back to the
      // reader. Nothing left: nothing is said.
      const w = r.result;
      const sents = speakableSentences(w.reply || w.content);
      const saidText = (w.spoken || []).concat([r.text || this.heardBeforeCut(r)]).join(" ");
      const saidN = desk.sentencesOf(saidText, true).length;
      const left = desk.unheardLines(sents, saidText, w.source || w.reply || w.content);
      const heard = new Set(left.heard);
      for (let i = 0; i < Math.min(saidN, sents.length); i++) heard.add(i);
      const fact = FACT_RULES.has(r.trip.rule);
      let fix = -1;
      if (fact && sents.length) {
        const cutAt = desk.bestMatch(sents, r.trip.sentence || "");
        fix = cutAt >= 0 ? cutAt : Math.min(Math.max(saidN - 1, 0), sents.length - 1);
        heard.delete(fix);
      }
      const trivial = new Set(left.trivial);
      const todo = sents.map((text, i) => ({ i, text })).filter((x) => !heard.has(x.i) && !trivial.has(x.i));
      const pick = todo.slice(0, live.VERBATIM_MAX_SENTENCES);
      const byReader = !!w.continuation;
      w.cut = true; // (the window stays open: GPT-Live repeating the result is still judged against it)
      this.log(
        `live: call ${this.id} request ${w.id != null ? w.id : "-"}: after the cut ${byReader ? "the reader reads" : "the live voice is given"} ${pick.length} of the result's ${sents.length} sentence${sents.length === 1 ? "" : "s"}` +
          ` [${pick.map((l) => l.i).join(",")}] (heard [${[...heard].sort((a, b) => a - b).join(",")}], nothing to add [${left.trivial.join(",")}]${fact ? `, said again: ${fix}` : ""}; the live voice had said ${r.rel.sentences.length}, ${r.rel.released} passed, cut at ${r.trip.at != null ? r.trip.at : "-"}, ${r.trip.rule})`
      );
      if (!pick.length) return;
      const more = todo.length > pick.length ? " " + this.detailsLine(w.reply || "", w.id) : "";
      if (byReader) {
        const lines = pick.map((l) => ({ text: l.text, safe: false }));
        if (more) lines.push({ text: more.trim(), safe: true });
        this.quietNote(null, "The rest of the result was read to the administrator word for word: " + lines.map((l) => l.text).join(" ").slice(0, 800));
        await this.say(lines, "joya", null, this.id + "r" + (w.id || "x"));
        return;
      }
      // GPT-Live goes quiet first (the cut mutes it until then), then says only what is left.
      for (let i = 0; i < 80 && this.suppress && !this.closed; i++) await new Promise((res) => setTimeout(res, 50));
      if (this.closed) return;
      this.quietNote(null, "Do not repeat anything you already said of that result. Say only the next part, as given" + (fact ? ", which corrects what you said." : "."));
      w.closed = true; // the continuation opens its own window (merged into this one it would lose `continuation`)
      this.result(w.delegationId, pick.map((l) => l.text).join(" ") + more, { id: w.id, request: w.request, reply: w.reply, source: w.source, continuation: true });
      return;
    }
    // GPT-Live answered, so the administrator has finished the turn it answered: its words are complete.
    if (this.inTurn) this.finishTurn(this.inTurn);
    const t = this.lastTurn;
    const lang = desk.langOf(r.trip.sentence || "", t ? t.voiceText : "");
    const L = desk.linesFor(lang, this.persona.gender);
    let line = L.asked;
    const recentTurn = t && this.now() - (t.stoppedAt || t.startedAt || 0) < 15000;
    if (t && t.talkOnly) line = lang === "ar" ? live.TALK_ONLY_LINE.ar : live.TALK_ONLY_LINE.en;
    else if (!recentTurn || !t || t.dropped) {
      // Nothing new was said: no hand-off. A recent result -> "the details are on screen"; work pending -> still on it; else just stop.
      line = this.replies.length && this.resultWin && this.now() - this.resultWin.at < 60000 ? this.screenLine(lang, this.resultWin.id) : this.anyPending() ? L.asked : null;
      if (!line) return;
    } else if (t && !t.asked && !t.handing && !t.dropped) {
      // What it said needed real work it had not asked for: the turn goes to JOYA AI, so the safe line is true.
      const request = await this.groundedText(t);
      if (request && !voiceGuard.refuseAtDoor(request)) {
        try {
          await this.handOver(t, request);
          line = L.safe;
        } catch (_) {
          line = L.unreachable;
        }
      } else line = L.notCaught || L.safe;
    } else if (t && (t.asked || t.handing)) line = desk.mentionsChecking(said) ? L.tail : L.asked;
    this.quietNote(null, "Instead, the administrator was told: " + JSON.stringify(line));
    await this.say([{ text: line, safe: true }], "safe", t);
  }

  /** The administrator talked over the voice (the page's detector, a tap, a press). */
  bargeIn(how) {
    const at = this.now();
    const b = { at, flushedAt: null, how: how || "voice", sincePlay: this.sincePlay() };
    this.diag.bargeIns.push(b);
    this.diag.gptlive.bargeStops.push(b);
    this.toClient({ type: "flush", at });
    this.setState("interrupted");
    this.speechGen++; // the verbatim reader's lines stop too
    for (const s of this.segs.values()) s.over = true;
    this.playStartAt = null;
    this.lastAudibleAt = at;
    this.outQ = [];
    const r = this.utt;
    if (r && !r.done) {
      r.cancelled = true;
      r.done = true;
      this.utt = null;
      if (r.seg) this.toClient({ type: "segend", seg: r.seg });
      if (r.result) r.result.closed = true;
    }
    this.suppress = { at, quietAt: 0, why: "barge-in", barge: b };
  }

  /** The reader waits for GPT-Live to finish its utterance (not for a realtime response). */
  say(lines, kind, turn, vt) {
    const gen = this.speechGen;
    this.speechChain = this.speechChain.then(async () => {
      for (let i = 0; i < 100 && this.utt && !this.utt.done && !this.closed; i++) await new Promise((r) => setTimeout(r, 50));
      for (const line of lines) {
        if (this.closed || gen !== this.speechGen) return;
        await this.sayOne(line, kind, turn, vt, gen);
      }
      if (!this.closed && gen === this.speechGen && !this.utt) this.setState(this.anyPending() ? "waiting" : "listening");
    });
    return this.speechChain;
  }

  anythingAudible() {
    if (this.utt && !this.utt.done && !this.utt.cancelled && this.utt.sentBytes > 0) return true;
    return super.anythingAudible();
  }

  /** A voice change while the call is open: a call on another protocol cannot change its class; it ends. */
  async swapUpstream(patch, o) {
    const next = { ...this.cfg, ...(patch || {}) };
    if (patch && patch.live_model && !/^gpt-live/.test(String(next.live_model))) {
      this.close("voice-changed", "The voice model changed. Start the call again to use it.", "model " + next.live_model);
      return { ok: false, why: "the voice model changed" };
    }
    this.liveReady = false;
    this.stopClock();
    this.outQ = [];
    this.utt = null;
    this.inTurn = null;
    this.suppress = null;
    const res = await super.swapUpstream({ ...(patch || {}), live_model: GPT_LIVE_MODEL }, o);
    this.model = GPT_LIVE_MODEL;
    return res;
  }

  close(why, text, detail) {
    if (this.closed) return;
    const ws = this.ws;
    const ready = this.liveReady;
    this.stopClock();
    // End the session properly (its final usage is billed), then let the socket go.
    if (ws && ready && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "session.close", event_id: "close_" + this.id }));
      } catch (_) {
        /* closing */
      }
      this.ws = null;
      ws.on("message", (data) => {
        try {
          const ev = JSON.parse(String(data));
          if (ev.type === "session.closed") {
            this.usageUpdated(ev.usage);
            ws.close();
          }
        } catch (_) {
          /* ignore */
        }
      });
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch (_) {
          /* gone */
        }
      }, 3000);
      if (t.unref) t.unref();
    }
    this.liveReady = false;
    super.close(why, text, detail);
  }
}

module.exports = { GptLiveCall, GPT_LIVE_MODEL, INSTRUCTIONS, instructionsFor, HOLD_MS, LOUD_RMS, chunksOf, rmsOf };
