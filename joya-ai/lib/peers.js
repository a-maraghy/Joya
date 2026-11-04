"use strict";
/**
 * Reading what other sessions send JOYA AI.
 *
 * Peer traffic reaches the model as ordinary prompt text, and the
 * UserPromptSubmit hook sees exactly that text. Three shapes, as emitted by
 * Claude Code 2.1.28x (verified by experiment -- re-check after a CLI update):
 *
 *   <cross-session-message from="uds:/run/user/0/cc-socks/2781306.sock"
 *       from-name="joya-e2e-target" from-mode="prompting">
 *   PONG-7
 *   </cross-session-message>
 *
 *   [Cross-session idle notice] "peertest-B", which you asked to be notified
 *   about, is idle now — it finished a turn at 14:05. Its harness reports: «…».
 *
 *   [Cross-session delivery notice] …  (a session held or refused a message)
 *
 * The pid in the socket path is the sending process; together with the name
 * it is how a reply is matched to the delegation it answers.
 */

const MSG_RE = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/g;
const ATTR_RE = /([a-z-]+)="([^"]*)"/g;

function attrs(s) {
  const out = {};
  for (const m of String(s).matchAll(ATTR_RE)) out[m[1]] = m[2];
  return out;
}

function pidFromAddress(from) {
  const m = /\/(\d+)\.sock$/.exec(String(from || ""));
  return m ? Number(m[1]) : null;
}

/** Strip the " [ref]" suffix ListAgents adds to a name. */
function bareName(to) {
  return String(to || "")
    .replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "")
    .trim();
}

/**
 * Parse one prompt into the peer events it carries.
 * Returns [{ kind: 'message'|'idle'|'delivery', from_name, from_pid, text, state? }].
 */
function parsePrompt(prompt) {
  const text = String(prompt == null ? "" : prompt);
  const out = [];
  for (const m of text.matchAll(MSG_RE)) {
    const a = attrs(m[1]);
    out.push({
      kind: "message",
      from_name: a["from-name"] || null,
      from_pid: pidFromAddress(a.from),
      from_mode: a["from-mode"] || null,
      text: m[2].trim(),
    });
  }
  const idle = text.indexOf("[Cross-session idle notice]");
  if (idle !== -1) {
    const body = text.slice(idle);
    const name = /\[Cross-session idle notice\]\s*[“"]([^”"]+)[”"]/.exec(body);
    const report = /«([\s\S]*?)»/.exec(body);
    const expired = /\bexpired\b|\bnever (signalled|signaled)\b/i.test(body.slice(0, 400));
    const exited = /\bexited\b|\bhas ended\b/i.test(body.slice(0, 400));
    out.push({
      kind: "idle",
      from_name: name ? name[1] : null,
      from_pid: null,
      text: (report ? report[1] : body).trim().slice(0, 4000),
      state: expired ? "expired" : exited ? "exited" : "idle",
    });
  }
  const del = text.indexOf("[Cross-session delivery notice]");
  if (del !== -1) {
    const body = text.slice(del, del + 2000);
    const name = /[“"]([^”"]+)[”"]/.exec(body);
    const held = /\b(held|holds|holding|awaiting|approv)/i.test(body);
    const refused = /\b(refus|declin|reject|expired|dropped|not delivered)/i.test(body);
    out.push({
      kind: "delivery",
      from_name: name ? name[1] : null,
      from_pid: null,
      text: body.trim(),
      state: refused ? "refused" : held ? "held" : "notice",
    });
  }
  return out;
}

module.exports = { parsePrompt, pidFromAddress, bareName };
