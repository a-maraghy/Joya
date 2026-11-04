"use strict";
/**
 * The brief's wording by the model JOYA AI already uses for its summaries
 * (lib/voice-shared.js SUMMARY_MODEL, a text-only realtime response, the same
 * key, through this server only). It is given the template's lines -- written
 * from the facts -- and asked to word them better; what comes back must pass
 * proactive.grounded() (every number one of the facts', nothing that needs the
 * person left out) or the template is used. Its tokens are priced and recorded
 * like the summaries' (usage part "desk").
 *
 *   write({ key, model, wsBase, lines, timeoutMs }) -> { text, usage }  (rejects on any failure)
 */

const WebSocket = require("ws");
const P = require("./proactive");

function write({ key, model, wsBase, text, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (!key) return reject(new Error("no key"));
    const ws = new WebSocket((wsBase || "wss://api.openai.com/v1") + "/realtime?model=" + encodeURIComponent(model), {
      headers: { Authorization: "Bearer " + key },
      handshakeTimeout: 8000,
      perMessageDeflate: false,
    });
    let out = "", done = false, opened = false;
    const finish = (err, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch (_) {
        /* closed */
      }
      if (err) reject(err);
      else resolve(v);
    };
    const timer = setTimeout(() => finish(new Error("the model took too long")), timeoutMs || 20000);
    ws.on("unexpected-response", (req, res) => finish(new Error("the model refused the session (" + res.statusCode + ")")));
    ws.on("error", (e) => finish(new Error("could not reach the model: " + String(e.message).slice(0, 80))));
    ws.on("close", () => finish(new Error("the model closed the connection")));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", instructions: P.WRITER_INSTRUCTIONS, output_modalities: ["text"], tools: [], tool_choice: "none", max_output_tokens: 500 } }));
    });
    ws.on("message", (data) => {
      let ev;
      try {
        ev = JSON.parse(String(data));
      } catch (_) {
        return;
      }
      if (ev.type === "error") return finish(new Error("the model said: " + String((ev.error && ev.error.message) || "error").slice(0, 120)));
      if (!opened) {
        if (ev.type !== "session.updated") return;
        opened = true;
        // Out of band, no conversation of its own: one response over the facts.
        return ws.send(
          JSON.stringify({
            type: "response.create",
            response: { conversation: "none", output_modalities: ["text"], tool_choice: "none", tools: [], max_output_tokens: 500, metadata: { purpose: "brief" }, instructions: P.WRITER_INSTRUCTIONS, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Facts:\n" + text }] }] },
          })
        );
      }
      if (ev.type === "response.output_text.delta") out += ev.delta || "";
      if (ev.type === "response.done") {
        const r = ev.response || {};
        for (const o of r.output || []) if (o.type === "message") out = (o.content || []).map((p) => p.text || p.transcript || "").join("") || out;
        if (r.status && r.status !== "completed") return finish(new Error("the model did not finish (" + r.status + ")"));
        finish(null, { text: out.trim(), usage: r.usage || null });
      }
    });
  });
}

module.exports = { write };
