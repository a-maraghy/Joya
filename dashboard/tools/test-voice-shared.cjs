#!/usr/bin/env node
"use strict";
/**
 * Tests for what the live voice shares (lib/voice-shared.js, which was
 * lib/voice-desk.js until the front desk was removed on 2026-09-30): the
 * supervisor door, the read_status payload, the output guard, the sentence
 * releaser and the guarded summary of JOYA AI's replies -- against a mock
 * OpenAI Realtime server and a fake supervisor. No real key, no real JOYA AI.
 *
 *   NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-voice-shared.cjs
 *
 * The guard cases are the desk's (tools/test-voice-desk.cjs, removed with it),
 * unchanged: the live call judges its speech with the same judge().
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "shared-test-"));
process.env.JOYA_DATA_DIR = TMP;
const shared = require(path.join(ROOT, "lib", "voice-shared.js"));
const desk = shared; // the guard cases below were written against the desk's module; the names are the same
const { buildSnapshot, FORBIDDEN_KEYS } = require(path.join(ROOT, "..", "joya-ai", "lib", "snapshot.js"));

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


/* ------------------------------------------------------ fake supervisor --- */

const APPROVAL_CMD = "rm -rf /srv/important && git push --force origin main";
const SECRET = "sk-proj-" + "S".repeat(40);
function fixedSnapshot(extra) {
  return buildSnapshot({
    now: "2026-09-29T10:15:00.000Z",
    host: "vmi3567127",
    vitals: { cpu_pct: 12, cpus: 8, load: [0.42, 0.5, 0.61], mem: { total: 25 * 2 ** 30, available: 9.5 * 2 ** 30, pct: 62 }, disk: { total: 400 * 2 ** 30, free: 156.2 * 2 ** 30, pct: 61 }, uptime_s: 3 * 86400 },
    services: [
      { unit: "nginx", active: "active" },
      { unit: "odoo", active: "active" },
      { unit: "postgresql@16-main", active: "active" },
      { unit: "joya-agent@admin", active: "failed" },
    ],
    servicesAt: "2026-09-29T10:14:40.000Z",
    sessions: [{ name: "JOYA AI", status: "idle", self: true }, { name: "Odoo 19 VPS setup customizations", status: "busy" }, { name: "JOYA Agent OS", status: "idle" }],
    process: { state: "ready", busy: false, queued: 0 },
    missions: [
      { ref: "M-7", title: "Prepare the weekly ops review", status: "active", metrics: { steps_done: 1, steps_total: 3 }, steps: [{ n: 1, title: "Collect uptime", status: "done" }, { n: 2, title: "Summarise sign-ins", status: "working" }, { n: 3, title: "Draft the page", status: "planned" }] },
    ],
    decisions: [{ title: "Service failed: joya-agent@admin", status: "proposed", fix_command: "systemctl restart joya-agent@admin", evidence: "journal lines " + SECRET }],
    approvals: [{ tool: "Bash", label: "Deletes files", summary: APPROVAL_CMD, input_json: JSON.stringify({ command: APPROVAL_CMD }) }],
    ...(extra || {}),
  });
}

const sup = {
  calls: [], // every call that reached the "supervisor": [op, params, actor]
  nextTurn: 500,
  replies: new Map(), // turn id -> reply text once "answered"
  call(op, params, actor) {
    sup.calls.push([op, params, actor]);
    if (op === "snapshot") {
      const s = fixedSnapshot();
      if (params && params.turns) {
        s.requests_to_joya_ai = params.turns.map((id) => ({ id, answered: sup.replies.has(id), status: sup.replies.has(id) ? "done" : "queued", reply: sup.replies.get(id) }));
      }
      return Promise.resolve(s);
    }
    if (op === "send") {
      const id = ++sup.nextTurn;
      return Promise.resolve({ turn: { id, source: params.via, actor, text: params.text, status: "queued" }, queued_behind: 0 });
    }
    return Promise.reject(new Error("the fake supervisor refuses " + op));
  },
};

/* ------------------------------------------------------- mock realtime --- */

const mock = { sessions: [], brain: null };
let idn = 0;
const nid = (p) => p + "_" + (++idn).toString(36).padStart(8, "0");

function pcmFor(text) {
  // 10 ms of "speech" per character: enough to be non-empty and checkable.
  const b = Buffer.alloc(Math.max(480, text.length * 480));
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 === 0 ? 5000 : -5000, i);
  return b;
}

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  if (!/^\/v1\/realtime\?model=/.test(req.url) || req.headers.authorization !== "Bearer " + GOOD) {
    sock.write("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n" + JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    return sock.destroy();
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const s = { url: req.url, session: null, items: [], events: [], cancelled: false, live: null, oob: [], doneAt: [], lastInput: 0 };
    mock.sessions.push(s);
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: nid("event"), ...o }));
    send({ type: "session.created", session: { type: "realtime", model: "gpt-realtime-mini", output_modalities: ["audio"] } });
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d));
      s.events.push(ev);
      switch (ev.type) {
        case "session.update":
          s.session = ev.session;
          send({ type: "session.updated", session: ev.session });
          break;
        case "conversation.item.create": {
          const item = { id: nid("item"), status: "completed", ...ev.item };
          s.items.push(item);
          send({ type: "conversation.item.added", previous_item_id: null, item });
          send({ type: "conversation.item.done", previous_item_id: null, item });
          break;
        }
        case "conversation.item.delete":
          s.items = s.items.filter((i) => i.id !== ev.item_id);
          send({ type: "conversation.item.deleted", item_id: ev.item_id });
          break;
        case "response.cancel":
          if (s.live) s.live.cancelled = true;
          else send({ type: "error", error: { type: "invalid_request_error", code: "response_cancel_not_active", message: "Cancellation failed: no active response found" } });
          break;
        case "response.create":
          respond(s, send, ev.response || null);
          break;
        default:
          break;
      }
    });
  });
});

/** Play the brain's outputs as the real server would, a delta at a time. */
async function respond(s, send, params) {
  // An out-of-band response (conversation "none") sees only its own input and
  // its own instructions, and adds nothing to the conversation -- as the real
  // server does (checked on gpt-realtime-mini, 2026-09-29).
  const oob = !!(params && params.conversation === "none");
  const items = oob ? params.input || [] : s.items;
  if (oob) s.oob.push(params);
  const audio = ((params && params.output_modalities) || s.session.output_modalities || ["audio"])[0] === "audio";
  const rid = nid("resp");
  const live = (s.live = { cancelled: false });
  const outputs = (oob ? mock.summaryBrain || brains.summaryGood : mock.brain || brains.good)(items, s, params) || [];
  const inputTokens = Math.ceil((JSON.stringify(items).length + String((params && params.instructions) || s.session.instructions || "").length) / 4);
  let outChars = 0;
  const done = [];
  send({ type: "response.created", response: { id: rid, status: "in_progress", output: [], output_modalities: [audio ? "audio" : "text"] } });
  if (outputs[0] && outputs[0].fail) {
    s.live = null;
    return send({ type: "response.done", response: { id: rid, status: "failed", status_details: { type: "failed", error: { type: "server_error", message: outputs[0].fail } }, output: [] } });
  }
  const tick = () => new Promise((r) => setImmediate(r));
  let idx = 0;
  for (const o of outputs) {
    if (live.cancelled) break;
    if (o.call) {
      const item = { id: nid("item"), type: "function_call", status: "in_progress", name: o.call, call_id: nid("call"), arguments: "" };
      send({ type: "response.output_item.added", response_id: rid, output_index: idx, item });
      const args = JSON.stringify(o.args || {});
      send({ type: "response.function_call_arguments.delta", response_id: rid, item_id: item.id, call_id: item.call_id, delta: args });
      send({ type: "response.function_call_arguments.done", response_id: rid, item_id: item.id, call_id: item.call_id, name: o.call, arguments: args });
      const fin = { ...item, status: "completed", arguments: args };
      if (!oob) s.items.push(fin);
      send({ type: "response.output_item.done", response_id: rid, output_index: idx, item: fin });
      done.push(fin);
      outChars += args.length;
    } else {
      const item = { id: nid("item"), type: "message", status: "in_progress", role: "assistant", content: [] };
      send({ type: "response.output_item.added", response_id: rid, output_index: idx, item });
      send({ type: "response.content_part.added", response_id: rid, item_id: item.id, part: audio ? { type: "audio", transcript: "" } : { type: "text", text: "" } });
      let said = "";
      for (const w of o.say.match(/\S+\s*/g) || []) {
        await (o.slow ? new Promise((r) => setTimeout(r, 4)) : tick()); // slow: a word every few ms, like the real stream
        if (live.cancelled) break;
        said += w;
        if (audio) {
          send({ type: "response.output_audio.delta", response_id: rid, item_id: item.id, delta: pcmFor(w).toString("base64") });
          send({ type: "response.output_audio_transcript.delta", response_id: rid, item_id: item.id, delta: w });
        } else send({ type: "response.output_text.delta", response_id: rid, item_id: item.id, delta: w });
      }
      const part = audio ? { type: "output_audio", transcript: said } : { type: "output_text", text: said };
      if (!live.cancelled) {
        if (audio) send({ type: "response.output_audio_transcript.done", response_id: rid, item_id: item.id, transcript: said });
        else send({ type: "response.output_text.done", response_id: rid, item_id: item.id, text: said });
      }
      const fin = { ...item, status: live.cancelled ? "incomplete" : "completed", content: [part] };
      if (!oob) s.items.push(fin);
      outChars += said.length;
      send({ type: "response.output_item.done", response_id: rid, output_index: idx, item: fin });
      done.push(fin);
    }
    idx++;
  }
  await tick();
  s.live = null;
  // usage in the real shape; the conversation's earlier part counts as cached.
  const cached = oob ? 0 : Math.min(s.lastInput || 0, inputTokens);
  s.lastInput = inputTokens;
  const outTokens = Math.ceil(outChars / 4);
  const usage = {
    total_tokens: inputTokens + outTokens, input_tokens: inputTokens, output_tokens: outTokens,
    input_token_details: { text_tokens: inputTokens, audio_tokens: 0, image_tokens: 0, cached_tokens: cached, cached_tokens_details: { text_tokens: cached, audio_tokens: 0, image_tokens: 0 } },
    output_token_details: { text_tokens: outTokens, audio_tokens: 0 },
  };
  s.doneAt.push(process.hrtime.bigint());
  send({ type: "response.done", response: { id: rid, status: live.cancelled ? "cancelled" : "completed", status_details: live.cancelled ? { type: "cancelled", reason: "client_cancelled" } : null, output: done, conversation_id: oob ? null : "conv_1", usage } });
  send({ type: "rate_limits.updated", rate_limits: [{ name: "tokens", limit: 15000000, remaining: 14999000 }] });
}

const brains = {};
/** The summariser: what an out-of-band summary response says, by test. */
const replyIn = (items) => {
  const t = (items[0] && items[0].content && items[0].content[0] && items[0].content[0].text) || "";
  const m = /"""\n([\s\S]*?)\n"""/.exec(t);
  return m ? m[1] : "";
};
brains.summaryGood = () => [{ say: mock.summaryText || "Here is what I found." }];

const GOOD = "sk-proj-" + "T".repeat(40) + "good";
let WS_BASE;
function newSummariser(actor) {
  return new shared.Summariser({ key: GOOD, voice: "marin", ops: shared.voiceOps(sup.call, actor || "amaraghy"), wsBase: WS_BASE, log: () => {} });
}
/** A request JOYA AI is working on (what the live call's look_into makes). */
async function ask(text) {
  const r = await shared.voiceOps(sup.call, "amaraghy").ask(text);
  return { asked: [r.turn] };
}
const lastSession = () => mock.sessions[mock.sessions.length - 1];

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  WS_BASE = "ws://127.0.0.1:" + server.address().port + "/v1";

  section("the supervisor door: send and snapshot, nothing else");
  {
    const calls = [];
    const ops = shared.voiceOps((op, p, a) => (calls.push([op, p, a]), Promise.resolve({ turn: { id: 1 } })), "amaraghy");
    for (const op of ["approve", "deny", "interrupt", "restart", "rc", "rule-create", "rule-update", "rule-delete", "decision-approve", "decision-dismiss", "decision-ask", "mission-create", "order-run", "watcher-set", "ledger", "session-mirror"]) {
      let threw = false;
      try {
        ops.gate(op, {});
      } catch (e) {
        threw = e.code === "refused";
      }
      check(`refuses ${op}`, threw && calls.length === 0);
    }
    await ops.ask("restart odoo please");
    check("a hand-off maps to send, marked via voice-desk (the supervisor's name for it), as the panel user", calls.length === 1 && calls[0][0] === "send" && calls[0][1].via === "voice-desk" && calls[0][1].text === "restart odoo please" && calls[0][2] === "amaraghy", JSON.stringify(calls));
    check("send carries no target (JOYA AI routes it)", !("target" in calls[0][1]));
    await ops.snapshot();
    check("read_status maps to snapshot, a read", calls[1][0] === "snapshot" && JSON.stringify(calls[1][1]) === "{}");
    check("VOICE_OPS is exactly snapshot:read, send:write and voice-warm:read (the call's own sessions started ahead)", JSON.stringify(shared.VOICE_OPS) === '{"snapshot":"read","send":"write","voice-warm":"read"}' && Object.isFrozen(shared.VOICE_OPS));
    let echo = null;
    try {
      ops.ask(require(path.join(ROOT, "lib", "voice.js")).TRANSCRIBE_PROMPT);
    } catch (e) {
      echo = e;
    }
    check("a hand-off that reads as the transcription prompt is refused at the door", echo && echo.code === "refused");
    const protocol = require(path.join(ROOT, "..", "joya-ai", "lib", "protocol.js"));
    check("the supervisor's own protocol calls snapshot a read", protocol.OPS.snapshot.mutating === false);
  }

  section("read_status: no secrets, no commands");
  {
    const raw = fixedSnapshot();
    const json = JSON.stringify(raw);
    check("the supervisor's snapshot never carries the approval's command", !json.includes("rm -rf") && !json.includes("push --force"));
    check("nor a decision's fix command or evidence", !json.includes("systemctl restart joya-agent") && !json.includes("journal lines"));
    const keys = [];
    (function walk(v) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    })(raw);
    check("and none of the forbidden keys", !keys.some((k) => FORBIDDEN_KEYS.includes(k)), keys.filter((k) => FORBIDDEN_KEYS.includes(k)).join());
    const leaky = { ...raw, services: { ...raw.services, list: [{ name: "odoo " + SECRET, state: "running", command: "systemctl restart odoo" }] }, decisions: { open: 1, titles: [{ title: "x", fix_command: APPROVAL_CMD, evidence: SECRET }] }, requests_to_joya_ai: [{ id: 9, answered: true, reply: "I ran " + APPROVAL_CMD }] };
    const m = JSON.stringify(shared.forModel(leaky));
    check("forModel drops command-like fields a supervisor might leak", !m.includes("rm -rf") && !m.includes("systemctl restart") && !m.includes("fix_command"), m.slice(0, 300));
    check("forModel redacts secrets", !m.includes(SECRET) && m.includes("«openai-key»"));
    check("forModel gives the voice's requests as answered or not, never the reply", /"your_requests_in_progress":\[\{"request":9,"result_ready":true\}\]/.test(m) && !m.includes("I ran"));
  }

  section("the output guard: unit cases");
  {
    const snap = desk.forModel(fixedSnapshot());
    const ctx = (extra) => ({ numbers: desk.numberSet([JSON.stringify(snap), ...(extra && extra.more ? extra.more : [])]), snapshotText: JSON.stringify(snap).toLowerCase(), grounded: true, replied: false, replyText: "", ...(extra || {}) });
    const trips = [
      ["Done, I've restarted Odoo.", "action-claim"],
      ["I have deleted the file.", "action-claim"],
      ["I've pushed the branch to GitHub.", "action-claim"],
      ["Okay, I approved the pending card.", "action-claim"],
      ["The card has been approved.", "action-claim"],
      ["Odoo was restarted a moment ago.", "action-claim"],
      ["It's done.", "action-claim"],
      ["The first step is done, and the cache has been deleted.", "action-claim"],
      ["All set!", "action-claim"],
      ["No problem, I've taken care of it.", "action-claim"],
      ["Give me a moment, I'm checking, and the file has been deleted.", "action-claim"],
      ["I've passed that to JOYA AI.", "third-person"],
      ["JOYA AI will restart Odoo in a minute.", "third-person"],
      ["I will restart Odoo in a minute.", "promise"],
      ["I'll delete it now.", "promise"],
      ["It should be fixed shortly.", "promise"],
      ["JOYA AI said the backups are fine.", "third-person"],
      ["I found that the backups are fine.", "invented-finding"],
      ["I checked the logs and they're clean.", "invented-finding"],
      ["Its answer is that nothing is wrong.", "invented-reply"],
      ["The nightly backups are fine.", "not-in-snapshot"],
      ["The disk is 73% full.", "figure"],
      ["There are 5 live sessions.", "figure"],
      ["Memory is at seventy percent.", "figure"],
    ];
    for (const [t, rule] of trips) {
      const g = desk.guard(t, ctx());
      check(`trips (${rule}): ${t}`, !g.ok && g.rule === rule, JSON.stringify(g));
    }
    const passes = [
      "Give me a moment, I'm checking. I'll tell you what I find.",
      "I'm checking the restart for you.",
      "Let me look into that.",
      "I'll check whether the backups ran.",
      "I can't approve anything myself, but I'm looking into it.",
      "I don't have a result yet.",
      "I'm still checking; I'll update you as soon as I know.",
      "While I look into it, what should the report cover first?",
      "I'm JOYA AI. How can I help?",
      "Nothing has been restarted.",
      "The disk is 61% full, with 156.2 GB free.",
      "Memory is 62 percent used.",
      "3 of 4 services are running. joya-agent@admin has failed.",
      "Mission M-7 has 1 of 3 steps done.",
      "The mission M-7 has completed 1 out of 3 steps.",
      "Mission M-7 is active. The first step, \"Collect uptime,\" is done.",
      "Hello! What would you like to know?",
      "There is 1 pending approval: Deletes files.",
      "I don't know that one. Want me to look into it?",
    ];
    for (const t of passes) {
      const g = desk.guard(t, ctx());
      check(`passes: ${t}`, g.ok, JSON.stringify(g));
    }
    const noSnap = desk.guard("Odoo is running fine.", ctx({ grounded: false }));
    check("a status claim with no snapshot read trips (ungrounded)", !noSnap.ok && noSnap.rule === "ungrounded");
    const replied = ctx({ replied: true, replyText: "I restarted Odoo; it came back in 12 seconds.", more: ["I restarted Odoo; it came back in 12 seconds."] });
    check("after a result arrived, the voice may say what it found, in the first person", desk.guard("I found that Odoo was restarted and came back in 12 seconds.", replied).ok, JSON.stringify(desk.guard("I found that Odoo was restarted and came back in 12 seconds.", replied)));
    check("  and what it did, when the result says so", desk.guard("I restarted Odoo.", replied).ok && desk.guard("I deleted the old logs.", replied).rule === "action-claim");
    check("but not a figure the result did not give", desk.guard("I found that Odoo came back in 20 seconds.", replied).rule === "figure");
    check("  nor speak of JOYA AI as someone else", desk.guard("JOYA AI said Odoo was restarted.", replied).rule === "third-person");
    check("figures the administrator said are fine to repeat", desk.guard("You want 3 backups kept; I'm checking.", ctx({ more: ["keep 3 backups"] })).ok);
    check("numbersIn reads digits and words", JSON.stringify(desk.numbersIn("1,234.5 GB and twenty-one sessions, 61%")) === "[1234.5,61,21]", JSON.stringify(desk.numbersIn("1,234.5 GB and twenty-one sessions, 61%")));
    check("settled() holds back a word still arriving", desk.settled("The disk is 6") === "The disk is");
  }


  section("sentence by sentence: released as soon as the guard has checked it, never ahead of it");
  {
    const snap = desk.forModel(fixedSnapshot());
    const baseCtx = (extra) => ({ numbers: desk.numberSet([JSON.stringify(snap)]), snapshotText: JSON.stringify(snap).toLowerCase(), grounded: true, replied: false, replyText: "", ...(extra || {}) });
    const NO = { askedNow: () => false, pending: () => false };
    const YES = { askedNow: () => true, pending: () => false };
    /** Stream `text` a word at a time through a Releaser; note how much had arrived at each release. */
    function stream(text, ctx, info, opts) {
      const got = [];
      let acc = "";
      const rel = new desk.Releaser(() => ctx, (t) => got.push({ t, at: acc.length }), opts);
      for (const w of text.match(/\S+\s*/g) || []) {
        acc += w;
        rel.update(acc, false, info);
        if (rel.trip) break;
      }
      if (!rel.trip) rel.update(text, true, info);
      return { got, rel, len: text.length, said: got.map((g) => g.t) };
    }
    const two = stream("The disk is 61% full. Memory is 62 percent used.", baseCtx(), NO);
    check("a plain first sentence is released while the second is still arriving", two.got.length === 2 && two.got[0].t === "The disk is 61% full." && two.got[0].at < two.len, JSON.stringify(two.got));
    const rd = stream("Restarting Odoo now. Done.", baseCtx(), NO);
    check('"Restarting Odoo now." ... "Done.": nothing is released, the guard cuts', rd.got.length === 0 && rd.rel.trip && rd.rel.trip.rule === "action-claim", JSON.stringify(rd));
    const rd2 = stream("Odoo restart is under way. Done.", baseCtx(), NO);
    check('an action sentence waits for the next; "Done." after it cuts both (the pair is the claim)', rd2.got.length === 0 && rd2.rel.trip && rd2.rel.trip.at === 0, JSON.stringify(rd2.rel.trip));
    const asked = stream("I'm checking the restart for you. Done.", baseCtx(), YES);
    check('"I\'m checking the restart for you." is held, and "Done." after it cuts it too', asked.got.length === 0 && asked.rel.trip && asked.rel.trip.at === 0, JSON.stringify(asked));
    const okAsk = stream("I'm checking the restart for you. I'll tell you what I find.", baseCtx(), YES);
    check("the same sentence followed by an honest one is released, both", okAsk.said.length === 2 && okAsk.got[0].at > "I'm checking the restart for you.".length, JSON.stringify(okAsk.got));
    // Guard false positives seen live (fact #1322): the tail was judged on a last word "joya" / "\"joya" that was
    // really the start of "Joya AI OS" (a separate session), and summaries naming JOYA AI OS were cut.
    const mo = stream("Let me look into Joya AI OS for you.", baseCtx(), YES);
    check("streaming: \"let me look into joya\" is not judged until the next word; \"Let me look into Joya AI OS for you.\" is released whole", !mo.rel.trip && mo.said.join(" ") === "Let me look into Joya AI OS for you.", JSON.stringify(mo.rel.trip));
    const mq = stream('That is a question for "Joya AI OS", the session that builds this dashboard.', baseCtx(), NO);
    check('streaming: a tail ending on \'"joya\' waits; the sentence naming "Joya AI OS" is released', !mq.rel.trip && mq.said.length === 1, JSON.stringify(mq.rel.trip));
    check("  endsOnJoya: \"joya, \"joya, JOYA AI (waits); not joya. or minty", desk.endsOnJoya("let me look into joya") && desk.endsOnJoya('the session "joya') && desk.endsOnJoya("ok. JOYA AI") && !desk.endsOnJoya("joya.") && !desk.endsOnJoya("minty fresh"));
    const mself = stream("Let me look into Joya AI for you.", baseCtx(), YES);
    check("  but the voice naming itself as someone else is still cut once the next word shows it (\"into Joya AI for you\")", !!mself.rel.trip && mself.rel.trip.rule === "third-person", JSON.stringify(mself.rel.trip));
    for (const line of ["I've passed this to JOYA AI OS.", "I asked JOYA AI OS to rebuild the dock.", "JOYA AI OS is working on the dock now."]) {
      const sm = stream(line, baseCtx(), NO, { summary: true });
      check(`summary naming JOYA AI OS (a separate session) is not third-person: ${line}`, !(sm.rel.trip && sm.rel.trip.rule === "third-person"), JSON.stringify(sm.rel.trip));
    }
    check("  the voice passing work to JOYA AI (itself) is still third-person", desk.judge(desk.sentencesOf("I've passed this to JOYA AI.", true), {}).rule === "third-person" && desk.judge(desk.sentencesOf("هبعت ده لـ JOYA AI", true), {}).rule === "third-person");
    const alone = stream("I'm checking the restart for you.", baseCtx(), YES);
    check("an action sentence with nothing after it is released only at the end", alone.got.length === 1 && alone.got[0].at === alone.len);
    const pron = stream("Odoo? It's running.", baseCtx({ grounded: false }), NO);
    check('"Odoo? It\'s running." with no snapshot read: "it" borrows its subject, nothing is released', pron.got.length === 0 && pron.rel.trip && pron.rel.trip.rule === "ungrounded", JSON.stringify(pron));
    const later = stream("The disk is 61% full. I restarted Odoo.", baseCtx(), NO);
    check("a later sentence cut: the earlier, true one was already heard, and only it", later.said.join("|") === "The disk is 61% full." && later.rel.trip.rule === "action-claim" && later.rel.trip.at === 1, JSON.stringify(later));
    const ho = stream("Let me look into that.", baseCtx(), NO);
    check("\"let me look into that\" with no ask_joya call behind it is never released", ho.got.length === 0 && ho.rel.trip && ho.rel.trip.rule === "unbacked-checking");
    let calls = false;
    const ho2 = stream("Let me look into that.", baseCtx(), { askedNow: () => calls, pending: () => false });
    check("it is held while its call is unknown", ho2.got.length === 0 || ho2.rel.trip);
    {
      const got = [];
      const rel = new desk.Releaser(() => baseCtx(), (t) => got.push(t));
      const info = { askedNow: () => calls, pending: () => false };
      rel.update("Let me look into that. ", false, info);
      const heldWhileUnknown = got.length === 0;
      calls = true; // the response's function call arrives
      rel.update("Let me look into that.", true, info);
      check("and released once the response's ask_joya call is known", heldWhileUnknown && got.length === 1 && !rel.trip);
    }
    check("needsNext: fragments, colons and action sentences wait; plain statements do not", desk.needsNext("Odoo.") && desk.needsNext("About the disk:") && desk.needsNext("I'm checking the restart for you.") && !desk.needsNext("The disk is 61% full.") && !desk.needsNext("How can I help you today?"));
    check("sentencesOf keeps a figure whole while it streams (61. may be 61.5)", desk.sentencesOf("The disk is 61.", false).length === 0 && desk.sentencesOf("The disk is 61. It", false).join() === "The disk is 61.");

    // The property, over every pair and a sample of triples of these sentences:
    // whatever the guard cuts in the whole text, nothing it implicates was
    // released first, and what was released passes the guard on its own.
    const pool = [
      "The disk is 61% full.", "Memory is 62 percent used.", "Restarting Odoo now.", "Done.", "It's running.", "Odoo?", "I restarted Odoo.",
      "I'm checking the restart for you.", "I'll tell you what I find.", "Okay.", "All set!", "The disk is 73% full.",
      "Everything is fine.", "joya-agent@admin has failed.", "Odoo restart is under way.", "It worked.", "Nothing was restarted.",
      "Hello!", "I can't restart anything myself.", "It is down.",
    ];
    const texts = [];
    for (const a of pool) for (const b of pool) texts.push(a + " " + b);
    for (let i = 0; i < pool.length; i++) for (let j = 0; j < pool.length; j += 3) for (let k = 1; k < pool.length; k += 5) texts.push(pool[i] + " " + pool[j] + " " + pool[k]);
    let cut = 0;
    let bad = [];
    for (const ctx of [baseCtx(), baseCtx({ grounded: false })]) {
      for (const t of texts) {
        const r = stream(t, ctx, YES);
        const full = desk.judge(desk.sentencesOf(t, true), ctx);
        const releasedOk = desk.judge(r.said, ctx).ok;
        if (!full.ok) {
          cut++;
          if (r.said.length > full.at || !releasedOk) bad.push([t, r.said, full]);
        } else if (!releasedOk || r.said.length !== desk.sentencesOf(t, true).length) bad.push([t, r.said, "not all released"]);
      }
    }
    check(`property over ${texts.length * 2} streamed texts (${cut} cut): nothing implicated by a later cut was ever released`, bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  }

  section("summaries: held to JOYA AI's reply");
  {
    // Real replies from JOYA AI's ledger (2026-09-28/29), lightly trimmed.
    const R_DENIED =
      'The approval gate worked, and the delete was denied. The card showed in the dashboard and e2e-tester denied it with the note "e2e: deny the first one."\n\n' +
      "Nothing was deleted: `victim1.txt` is still in place. I won't retry it or pass it to another session. If you want it removed, ask again and approve the new card.";
    const R_ODOO =
      'For the VPS Odoo, everything I reported still stands. It\'s running and fast, but the stock scheduler fails about four times a second because the "Product Unit" precision record is missing. ' +
      "The fix is waiting for you as decision #1 in the Decisions inbox: it backs up the database first, then puts the record back.\n\n" +
      "If you approve it, you'll also get an approval card for the database write itself before it runs. Once it's fixed, I'd also set up rotation for the Odoo log, which has grown to 3.6 GB.";
    const R_STATUS =
      "The server is healthy and lightly loaded. `joya-whisper` is not running, as intended.\n\n- **Memory:** 42 GB of 47 GB is free; 2.7 GB of swap is used.\n- **Reboot:** still flagged as needed. " +
      "It needs your go-ahead, ideally at a quiet time.\n\nI'll ask you before restarting anything.";
    const sctx = (reply) => ({ summary: true, replyText: reply, numbers: desk.strictNumberSet([reply]), replied: true, grounded: true, snapshotText: "" });
    const trips = [
      [R_STATUS, "Memory has 43 GB free.", "figure", "a number changed"],
      [R_STATUS, "About 2 GB of swap is used.", "figure", "a number rounded wrongly (2.7 is not 2)"],
      [R_STATUS, "joya-whisper is running.", "negation-flipped", "not running -> running"],
      [R_DENIED, "The file was deleted.", "negation-flipped", "nothing was deleted -> deleted"],
      [R_ODOO, "Odoo is not running.", "negation-flipped", "running -> not running"],
      [R_STATUS, "I suggest upgrading the kernel tonight.", "added-recommendation", "a recommendation the reply did not make"],
      [R_ODOO, "I recommend deleting the Odoo log.", "added-recommendation", "a recommendation about something else"],
      [R_STATUS, "JOYA AI says the server is healthy.", "third-person", "speaking of JOYA AI as someone else"],
      [R_STATUS, "The server was restarted.", "pending-as-done", "\"I'll ask you before restarting\" -> done"],
      [R_ODOO, "I fixed the scheduler.", "pending-as-done", "a fix waiting for approval -> \"I fixed it\""],
      [R_STATUS, "It's done.", "added-claim", "\"done\" out of nowhere"],
      [R_ODOO, "The fix touches PMO9045 too.", "added-name", "a name the reply never gave"],
      [R_STATUS, "Details are in /var/log/syslog.", "unspeakable", "a path read aloud"],
      [R_STATUS, "I restarted the server.", "pending-as-done", "\"I restarted\" when the reply only says it will ask first"],
    ];
    for (const [reply, said, rule, why] of trips) {
      const g = desk.guard(said, sctx(reply));
      check(`summary cut (${rule}): ${why}`, !g.ok && g.rule === rule, JSON.stringify(g));
    }
    const passes = [
      [R_DENIED, "The delete was denied, so nothing was deleted. I won't retry it; to remove the file, ask again and approve the new card."],
      [R_ODOO, "Odoo is running, but the stock scheduler keeps failing because a precision record is missing. The fix is waiting for your decision in the Decisions inbox."],
      [R_ODOO, "The Odoo log has grown to 4 GB."],
      [R_STATUS, "The server is healthy. joya-whisper is stopped, as intended, and 42 GB of memory is free."],
      [R_STATUS, "About 3 GB of swap is used, and the reboot needs your go-ahead."],
      [R_STATUS, "I'll ask you before restarting anything."],
      [R_ODOO, "I found that Odoo is running, but the stock scheduler keeps failing."],
      // found on the real model's summaries (eval, 2026-09-29):
      ["Nothing was sent, so victim-ui2.txt wasn't touched. If you still want the file deleted, ask again and approve the new card.", "The file wasn't deleted, and you can ask again and approve a new card."],
      ["It will make a mockup of the key pages first and wait for your approval.", "I'll create mockups first and wait for your approval."],
      [R_ODOO, "Once it's fixed, I suggest setting up rotation for the Odoo log."],
      ["My recommendation is one maintenance window: install the 23 updates, then reboot. Both steps go through approval cards.", "I recommend installing the 23 updates and rebooting, both through approval cards."],
      [R_STATUS, "The **server** is healthy."],
      ["The approval gate stopped this one. Nothing was sent to joya-ui-test, so the file wasn't touched. If you still want the file deleted, ask again and approve the new card.", "The approval gate stopped it, and nothing was sent to delete the file."],
      ["The server needs a reboot to finish the ones already installed.\n\n- **Not installed yet:** 23 more package updates. Both steps go through approval cards.", "A reboot is needed, and 23 updates are not installed yet."],
      ["This is your own repository, so pushing is allowed. Say yes and I'll push it.", "The administrator needs to approve the push."],
    ];
    for (const [reply, said] of passes) {
      const g = desk.guard(said, sctx(reply));
      check(`summary passes: ${said}`, g.ok, JSON.stringify(g));
    }
    // The call of 2026-10-30 (lv1jz4g, request 400): the summary's «عملنا نسخه من اللايف الساعه 8 بالليل بتوقيت
    // القاهره» restates the reply's «خلّينا نسخة من اللايف ... الساعة 8 بالليل بتوقيت القاهرة» and was cut (action-claim).
    const R_ODOO_AR =
      "آخر شغل في أودو كان امبارح، 29 أكتوبر، على أودو بتاع السيرفر:\n\n" +
      "1. **خلّينا نسخة من اللايف هي أودو بتاعنا الأساسي:** الساعة 8 بالليل بتوقيت القاهرة. بقى gizaseeds_test فيه نسخة من بيانات اللايف بتاعة الساعة 6 المغرب. الداتابيز القديمة لسه محفوظة، ونقدر نرجع لها.\n" +
      "   - 22 مهمة أوتوماتيك اتقفلت، زي الفواتير الإلكترونية والإيميلات والـ SMS، علشان مفيش حاجة تطلع برّه.\n" +
      "2. **شغل على شاشة الأوردر في محرّك التخطيط:** بين 7:40 و8:35 بالليل اتعملت كذا نسخة، من 4.40 لـ 4.44.\n\n" +
      "تحب أعرف من جلسة \"[GSH] Planning Automation\" إيه الخطوة الجاية؟";
    const arCtx = { ...sctx(R_ODOO_AR), heardText: "ممكن تقولي آخر حاجة اشتغلنا عليها في أودو كانت ايه", numbers: desk.strictNumberSet([R_ODOO_AR, "ممكن تقولي آخر حاجة اشتغلنا عليها في أودو كانت ايه"]) };
    for (const said of ["عملنا نسخه من اللايف الساعه 8 بالليل بتوقيت القاهره", "عملنا نسخة من اللايف الساعة 8 بالليل بتوقيت القاهرة.", "آخر شغل في أودو كان امبارح، 29 أكتوبر. عملنا نسخة من اللايف الساعة 8 بالليل."])
      check(`summary restating the reply in other words passes (lv1jz4g): ${said}`, desk.guard(said, arCtx).ok, JSON.stringify(desk.guard(said, arCtx)));
    const arTrips = [
      ["عملنا نسخة من الداتابيز بتاعة العميل الساعة 8.", "a fact the reply never states (the client's database)"],
      ["عملت restart لأودو الساعة 8 بالليل.", "an action the reply never says was done"],
      ["عملنا نسخة من اللايف الساعة 9 بالليل بتوقيت القاهرة.", "a time changed"],
      ["معملناش نسخة من اللايف الساعة 8 بالليل بتوقيت القاهرة.", "the negation flipped"],
    ];
    for (const [said, why] of arTrips) check(`summary still cut: ${why}`, !desk.guard(said, arCtx).ok, JSON.stringify(desk.guard(said, arCtx)));
    const offer = "ممكن نعمل نسخة من اللايف الساعة 8 بالليل لو تحب.";
    check("a reply that only OFFERS the thing does not ground «عملنا ...»", !desk.guard("عملنا نسخة من اللايف الساعة 8 بالليل.", { ...sctx(offer), numbers: desk.strictNumberSet([offer]) }).ok);
    const enReply = "We did not make a copy of live at 8 pm Cairo time; the old database is still the main one.";
    check("English: a negated reply sentence never grounds the same words said as done", !desk.restatesReply("we made a copy of live at 8 pm cairo time", desk.replyModel(enReply)));
    check("restOfReply: the reply's sentences after the last one a summary line covered", desk.restOfReply("Odoo is up. The disk is 6% used. Backups ran at 3:05. Nothing needs you.", ["Odoo is up and the disk is 6% used."]).lines.join(" ") === "Backups ran at 3:05. Nothing needs you.", JSON.stringify(desk.restOfReply("Odoo is up. The disk is 6% used. Backups ran at 3:05. Nothing needs you.", ["Odoo is up and the disk is 6% used."])));
    check("strictNumberSet: exact or correctly rounded only", desk.strictNumberSet(["2.7 GB"]).has(3) && !desk.strictNumberSet(["2.7 GB"]).has(2) && desk.numberSet(["2.7 GB"]).has(2));
    check("replyShape spots lists, code and paths", desk.replyShape(R_STATUS).list && desk.replyShape(R_STATUS).code && !desk.replyShape("Odoo is up.").list && desk.replyShape("Odoo is up.").plain);
  }
  {
    const d = newSummariser();
    const r0 = await ask("Ask JOYA AI about Odoo");
    const id = r0.asked[0].id;
    const R_ODOO2 =
      "Odoo is running, but the stock scheduler fails about four times a second because a precision record is missing. The fix is waiting for you as decision #1 in the Decisions inbox. " +
      "If you approve it, you'll also get an approval card for the database write itself.";
    sup.replies.set(id, R_ODOO2);
    mock.summaryText = "Odoo is running, but the stock scheduler keeps failing because a precision record is missing.";
    const heard = [];
    const r = await d.summarise(id, { onLine: (l) => heard.push(l.text) });
    await new Promise((res) => setTimeout(res, 50));
    const s = lastSession();
    const oob = s.oob[s.oob.length - 1];
    check("the summary is an out-of-band response: no conversation, no tools, the summary instructions", oob && oob.conversation === "none" && oob.tool_choice === "none" && Array.isArray(oob.tools) && oob.tools.length === 0 && oob.instructions === desk.SUMMARY_INSTRUCTIONS);
    check("it is given JOYA AI's reply, quoted", replyIn(oob.input) === R_ODOO2);
    check("the summary is spoken, and the pending approval it left out is said anyway", heard.join("|") === mock.summaryText + "|" + desk.APPROVAL_LINE && r.trip && r.trip.rule === "approval-dropped", JSON.stringify({ heard, trip: r.trip }));
    check("the summariser keeps no conversation: nothing is added to it", s.items.length === 0 && !s.events.some((e) => e.type === "conversation.item.create"));
    check("its session answers in text, with no tools", JSON.stringify(s.session.output_modalities) === '["text"]' && Array.isArray(s.session.tools) && s.session.tools.length === 0 && s.session.instructions === shared.SUMMARY_INSTRUCTIONS);
    check("the summariser is told the reply is its own work, to be spoken in the first person", /You are JOYA AI\. The text below is your own finished work/.test(desk.SUMMARY_INSTRUCTIONS) && /first person/.test(desk.SUMMARY_INSTRUCTIONS) && !/third person/.test(desk.SUMMARY_INSTRUCTIONS));
    check("its tokens are counted", r.tokens.text_in > 0 && r.tokens.text_out > 0 && r.cost_usd > 0, JSON.stringify(r.tokens));

    const r1 = await ask("Ask JOYA AI to restart Odoo");
    sup.replies.set(r1.asked[0].id, "Odoo restarted cleanly in 12 seconds.");
    const nOob = s.oob.length;
    const v = await d.summarise(r1.asked[0].id, {});
    check("a short, plain reply is read word for word: no summary is made", v.fallback === "verbatim" && s.oob.length === nOob && v.lines.length === 0);

    const r2 = await ask("Ask JOYA AI to delete victim1");
    const R_DENIED2 =
      "The approval gate worked, and the delete was denied. Nothing was deleted: `victim1.txt` is still in place. I won't retry it or pass it to another session. If you want it removed, ask again and approve the new card.";
    sup.replies.set(r2.asked[0].id, R_DENIED2);
    mock.summaryText = "The file was deleted. I won't retry it.";
    const heard2 = [];
    const f = await d.summarise(r2.asked[0].id, { onLine: (l) => heard2.push(l.text) });
    check("a summary that flips a negation is cut before a word of it is heard", f.trip && f.trip.rule === "negation-flipped" && !heard2.some((h) => /deleted/.test(h)), JSON.stringify({ heard2, trip: f.trip }));
    check("and, nothing of it heard, the reply is read word for word instead (fallback verbatim), not \"it's on screen\"", heard2.length === 0 && f.fallback === "verbatim", JSON.stringify({ heard2, fallback: f.fallback }));

    const r3 = await ask("Ask JOYA AI how the server is");
    const R_LIST = "The server is healthy and lightly loaded.\n\n- **Load:** very light.\n- **Disk:** 6% used.\n- **Services:** everything that should be running is running.\n\nNothing needs doing right now.";
    sup.replies.set(r3.asked[0].id, R_LIST);
    mock.summaryText = "The server is healthy and lightly loaded. I suggest a reboot tonight.";
    const heard3 = [];
    const c = await d.summarise(r3.asked[0].id, { onLine: (l) => heard3.push(l.text) });
    // Since 2026-10-30 (call lv1jz4g): the rest of the reply is read word for word, not "the rest is on screen".
    const rest3 = c.lines.filter((l) => l.verbatim).map((l) => l.text);
    check("a first sentence heard, a later one adding a recommendation cut: the REST OF THE REPLY is read word for word (marked verbatim), not \"the rest is on screen\"",
      heard3[0] === "The server is healthy and lightly loaded." && !heard3.includes(desk.SUMMARY_CUT_LINE) && c.trip.rule === "added-recommendation" && rest3.join(" ") === "Load: very light. Disk: 6% used. Services: everything that should be running is running. Nothing needs doing right now.", JSON.stringify({ heard3, rest3 }));
    mock.summaryText = "The server is healthy and lightly loaded, and nothing needs doing right now.";
    const r4 = await ask("Ask JOYA AI how the server is again");
    sup.replies.set(r4.asked[0].id, R_LIST);
    const heard4 = [];
    await d.summarise(r4.asked[0].id, { onLine: (l) => heard4.push(l.text) });
    check("a reply with a list is summed up in words: no \"the details are on screen\" after the detailed summary (2026-10-30)", heard4.join("|") === mock.summaryText, JSON.stringify(heard4));
    const oob4 = lastSession().oob[lastSession().oob.length - 1];
    check("  the summariser is asked for a detailed summary: every key fact and figure, lists in words, 3 to 6 sentences", /detailed spoken summary/.test(desk.SUMMARY_INSTRUCTIONS) && /every key fact/.test(desk.SUMMARY_INSTRUCTIONS) && /Three to six/.test(desk.SUMMARY_INSTRUCTIONS) && /list or a table into words/.test(desk.SUMMARY_INSTRUCTIONS) && oob4.max_output_tokens >= 600 && !/do not read them, say the details are on screen/.test(replyIn(oob4.input) + JSON.stringify(oob4.input)), JSON.stringify(oob4.max_output_tokens));
    const R_CODE = "I restarted nothing; the dashboard was already up.\n\n```\nsystemctl status joya-dashboard\n```\n\nIt has been up for 9 hours.";
    const r4b = await ask("Ask JOYA AI to check the dashboard");
    sup.replies.set(r4b.asked[0].id, R_CODE);
    mock.summaryText = "The dashboard was already up, for 9 hours, so I restarted nothing.";
    const heard4b = [];
    await d.summarise(r4b.asked[0].id, { onLine: (l) => heard4b.push(l.text) });
    check("  only what cannot be spoken (code, commands, paths) is left to the screen", heard4b[heard4b.length - 1] === desk.DETAILS_LINE, JSON.stringify(heard4b));
    const r4c = await ask("Ask JOYA AI again");
    sup.replies.set(r4c.asked[0].id, "Odoo restarted cleanly in 12 seconds.");
    mock.summaryText = "It took 12 seconds.";
    const n4c = lastSession().oob.length;
    const heard4c = [];
    const v4c = await d.summarise(r4c.asked[0].id, { onLine: (l) => heard4c.push(l.text), alreadySaid: ["Odoo restarted cleanly."] });
    const oob4c = lastSession().oob[lastSession().oob.length - 1];
    check("  alreadySaid: a summary is made even for a short reply, told what was already heard", v4c.fallback === null && lastSession().oob.length === n4c + 1 && /already heard these sentences of it read aloud: "Odoo restarted cleanly\."/.test(oob4c.input[0].content[0].text), JSON.stringify(oob4c && oob4c.input).slice(0, 300));

    const r6 = await ask("Ask JOYA AI about the updates");
    sup.replies.set(r6.asked[0].id, "The server has 23 updates waiting, and it needs a reboot to finish the ones already installed. My recommendation is one maintenance window. Both steps go through approval cards. Tell me when, and I'll set it up.");
    mock.summaryText = "The server has 23 updates waiting and needs a reboot.";
    const heard6 = [];
    await d.summarise(r6.asked[0].id, { onLine: (l) => heard6.push(l.text) });
    check("\"approval cards\" / \"tell me when\" is a pending decision: the summary gets the approval line", heard6[heard6.length - 1] === desk.APPROVAL_LINE, JSON.stringify(heard6));
    const r7 = await ask("Ask JOYA AI about the Odoo job");
    sup.replies.set(r7.asked[0].id, "Odoo is up, but one scheduled job has been failing for five days. Do you want me to send the details to the Odoo team? I can also check the planning engine work first.");
    mock.summaryText = "Odoo is up, but a scheduled job has been failing for five days. Do you want me to send the details to the Odoo team?";
    const heard7 = [];
    const s7 = await d.summarise(r7.asked[0].id, { onLine: (l) => heard7.push(l.text) });
    check("a summary that keeps the question in its own words needs no extra line", heard7.join(" ") === mock.summaryText + " " + desk.DETAILS_LINE || heard7.join(" ") === mock.summaryText, JSON.stringify({ heard7, trip: s7.trip }));
    const r5 = await ask("Ask JOYA AI something slow");
    const p = await d.summarise(r5.asked[0].id, {});
    check("a request JOYA AI has not answered yet: pending, nothing said", p.pending === true && p.lines.length === 0);
    let err = null;
    await d.summarise("abc", {}).catch((e) => (err = e));
    check("a bad request id is refused", err && err.code === "invalid");
    mock.summaryText = null;
    d.close();
  }


  section("2026-10-30 (call lv1g84s, the weather said twice): a forecast's \"should\" restating the result is not advice; after a cut, only what was not heard");
  {
    const wx = "It is mainly clear in 6th of October City right now, about 25 degrees, feeling like 23. Tonight it will drop to around 14 degrees, and tomorrow will be overcast with a high of 25.";
    const wxAr = "الجو صافي دلوقتي في مدينة 6 أكتوبر، حوالي 25 درجة. بالليل هتنزل لحوالي 14 درجة، وبكرة هيبقى غايم.";
    const wctx = (reply) => ({ summary: true, replyText: reply, replyModel: desk.replyModel(reply), numbers: desk.strictNumberSet([reply]), replied: true, grounded: true, snapshotText: "" });
    const pass = [
      [wx, "and tomorrow it should be overcast"],
      [wx, "Tonight it should drop to around 14 degrees, and tomorrow it should be overcast with a high of 25."],
      [wx, "Tomorrow is expected to be overcast."],
      ["The backup will finish at 9 tonight.", "The backup should finish at 9 tonight."],
      [wxAr, "والمفروض بكرة يبقى غايم."],
      [wxAr, "المفروض بالليل تنزل لحوالي 14 درجة."],
    ];
    for (const [reply, line] of pass) {
      const g = desk.judge(desk.sentencesOf(line, true), wctx(reply));
      check("a forecast restating the reply passes: " + line, g.ok, JSON.stringify(g));
    }
    const cut = [
      [wx, "You should take an umbrella tomorrow."],
      [wx, "Tomorrow it should be sunny."],
      [wx, "Tomorrow it should be overcast with a high of 30."],
      [wx, "It should be overcast so we should stay inside."],
      ["The backup will finish at 9 tonight. Odoo was restarted at 2.", "Odoo should be restarted."],
      [wxAr, "المفروض تاخد شمسية بكرة."],
      [wxAr, "المفروض بكرة يبقى مشمس."],
    ];
    for (const [reply, line] of cut) {
      const g = desk.judge(desk.sentencesOf(line, true), wctx(reply));
      check("real advice (or another forecast) is still cut: " + line, !g.ok && /recommendation|figure|negation|claim/.test(g.rule), JSON.stringify(g));
    }
    const sum = ["Sure.", "It's mainly clear in 6th of October City right now, about 25 degrees.", "It feels like 23, with light wind and no rain today or tomorrow.", "Tonight it will drop to around 14 degrees, and tomorrow will be overcast with a high of 25.", "Let me know if you need anything else."];
    const heard = "Sure, it's mainly clear in 6th of October City right now, about 25 degrees, feeling like 23, with light wind and no rain today or tomorrow.";
    const u = desk.unheardLines(sum, heard, wx);
    check("unheardLines: two summary sentences said as one are both heard; pleasantries are nothing to add", JSON.stringify(u.lines.map((l) => l.i)) === "[3]" && JSON.stringify(u.heard) === "[1,2]" && JSON.stringify(u.trivial) === "[0,4]", JSON.stringify(u));
    const u2 = desk.unheardLines(sum, "It's mainly clear right now, about 52 degrees.", wx);
    check("unheardLines: a sentence whose figure was not heard (52 for 25) is read", u2.lines.some((l) => l.i === 1), JSON.stringify(u2));
    const u3 = desk.unheardLines(sum, heard + " Tonight it'll drop to around 14 degrees, and tomorrow will be overcast with a high of 25.", wx);
    check("unheardLines: all of it heard -> nothing to read", u3.lines.length === 0, JSON.stringify(u3));
  }

  section("the Arabic report of a screen action that returned ok (seen on the real model, 2026-09-29)");
  {
    const J = (x, c) => desk.judge([x], c || {});
    const OK = ["خلاص، قفّلت المهام.", "عملت اللي طلبته، قفلت المهام.", "أقفلت الميشنز.", "أنا قفّلت لك الـ Missions.", "تمام، قفلتلك المهام."];
    check("after an ok ui_action: «خلاص، قفّلت المهام», «عملت اللي طلبته، قفلت المهام», «أقفلت الميشنز» pass", OK.every((x) => J(x, { uiOk: true }).ok), OK.filter((x) => !J(x, { uiOk: true }).ok).join(" | "));
    check("  without one, every one of them is cut", OK.every((x) => !J(x).ok));
    const BAD = ["خلاص، عملت restart لأودو.", "عملت restart لأودو وقفلت المهام.", "خلاص، قفلت المهام وعملت restart لأودو."];
    check("  another action in the same sentence is still cut, ok ui_action or not", BAD.every((x) => !J(x, { uiOk: true }).ok), BAD.filter((x) => J(x, { uiOk: true }).ok).join(" | "));
  }


  section("what is left of the desk: nothing");
  check("no desk session, tools or instructions are exported", !("DeskSession" in shared) && !("TOOLS" in shared) && !("INSTRUCTIONS" in shared) && !("deskFor" in shared) && !("createSpeaker" in shared));
  check("lib/voice-desk.js is gone", !fs.existsSync(path.join(ROOT, "lib", "voice-desk.js")));

  section("everything that reached the supervisor");
  check("only snapshot and send, ever", sup.calls.every((c) => c[0] === "snapshot" || c[0] === "send"), [...new Set(sup.calls.map((c) => c[0]))].join());

  shared.closeAll();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
