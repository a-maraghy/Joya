/**
 * Tests for the supervisor's socket protocol validation (lib/protocol.js) and
 * the peer-message parser (lib/peers.js).
 *
 *     node joya-ai/tools/test-protocol.cjs
 *
 * The socket is the line between a web-facing process and a root one, so the
 * cases that matter are the refusals: unknown ops, missing or forged actors,
 * fields nobody asked for, wrong types, oversize text, NUL bytes.
 */
const path = require("path");
const p = require(path.join(__dirname, "..", "lib", "protocol.js"));
const peers = require(path.join(__dirname, "..", "lib", "peers.js"));

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}
const req = (o) => p.parseRequest(JSON.stringify(o));
const good = (o) => req({ id: "r1", actor: "amaraghy", ...o });
const refuseLater = [];

/* ------------------------------------------------------------- accepted --- */

check("status", good({ op: "status" }).ok);
check("ping", good({ op: "ping" }).ok);
check("sessions", good({ op: "sessions" }).ok);
check("rc-url", good({ op: "rc-url" }).ok);
check("events with since", good({ op: "events", since: 10 }).ok);
check("events without since", good({ op: "events" }).ok);
check("numeric id is accepted and stringified", req({ id: 7, op: "status", actor: "a" }).req.id === "7");
{
  const r = good({ op: "send", text: "  restart nothing, just say hi  " });
  check("send trims its text", r.ok && r.req.params.text === "restart nothing, just say hi");
  check("send is marked mutating", r.ok && r.req.mutating === true);
}
check("send with a target", good({ op: "send", text: "hi", target: "Odoo 19 VPS setup customizations" }).ok);
check("send with target auto", good({ op: "send", text: "hi", target: "auto" }).ok);
check("send via the voice front desk", good({ op: "send", text: "hi", via: "voice-desk" }).ok && good({ op: "send", text: "hi", via: "voice-desk" }).req.params.via === "voice-desk");
refuseLater.push(["send via anything else", { op: "send", text: "hi", via: "telegram" }, "via must be one of"]);
check("send carries the live call's id (a repeat still queued is folded into its turn)", good({ op: "send", text: "hi", via: "voice-desk", call: "lv1abc2" }).ok && good({ op: "send", text: "hi", via: "voice-desk", call: "lv1abc2" }).req.params.call === "lv1abc2");
refuseLater.push(["send with a call id that is not one", { op: "send", text: "hi", via: "voice-desk", call: "../etc" }, "call"]);
{
  const r = good({ op: "deploy-event", component: "dashboard", started_at: "2026-09-30T14:00:02.123Z", commit: "e03b037", deployed_at: "2026-09-30T13:59:40Z" });
  check("deploy-event (the dashboard started, with what was deployed) is accepted and audited as a write", r.ok && r.req.mutating === true && r.req.params.commit === "e03b037");
  refuseLater.push(["deploy-event for anything but the dashboard", { op: "deploy-event", component: "odoo" }, "component must be one of"]);
  refuseLater.push(["deploy-event with a commit that is not one", { op: "deploy-event", component: "dashboard", commit: "HEAD; rm -rf /" }, "commit"]);
}
{
  const r = good({ op: "snapshot" });
  check("snapshot is a read", r.ok && r.req.mutating === false);
  check("snapshot with the desk's own turns", good({ op: "snapshot", turns: [3, 4, 4] }).ok && good({ op: "snapshot", turns: [3, 4, 4] }).req.params.turns.length === 2);
  refuseLater.push(["snapshot turns that are not integers", { op: "snapshot", turns: ["3"] }, "list of at most"]);
  refuseLater.push(["snapshot with too many turns", { op: "snapshot", turns: Array.from({ length: 21 }, (_, i) => i + 1) }, "list of at most"]);
  refuseLater.push(["snapshot with an unexpected field", { op: "snapshot", command: "rm -rf /" }, "unexpected field"]);
}
check("approve", good({ op: "approve", approval_id: 3 }).ok);
check("deny with a note", good({ op: "deny", approval_id: 3, note: "not today" }).ok);
check("ledger delegations", good({ op: "ledger", table: "delegations", limit: 20, status: "done" }).ok);
check("ledger approvals by status", good({ op: "ledger", table: "approvals", status: "pending" }).ok);
check("ledger audit", good({ op: "ledger", table: "audit", before_id: 100 }).ok);
check("rc on", good({ op: "rc", enabled: true }).ok);
check("restart", good({ op: "restart" }).ok);
check("fresh", good({ op: "fresh" }).ok);
check("fresh with a reason and force", (() => { const r = good({ op: "fresh", reason: "  context too large ", force: true }); return r.ok && r.req.params.reason === "context too large" && r.req.params.force === true && r.req.mutating === true; })());
check("fresh refuses a non-boolean force", !good({ op: "fresh", force: "yes" }).ok);
check("fresh refuses an unexpected field", !good({ op: "fresh", session_id: "x" }).ok);
check("interrupt", good({ op: "interrupt" }).ok);
check("status is not mutating", good({ op: "status" }).req.mutating === false);
check("an email-style actor", req({ id: "x", op: "status", actor: "amaraghy@gizaseeds.com" }).ok);

/* ------------------------------------------------------------- refused --- */

const refuse = (name, line, want) => {
  const r = typeof line === "string" ? p.parseRequest(line) : req(line);
  check("refuses " + name, !r.ok && (!want || new RegExp(want).test(r.error)), r.ok ? "accepted" : r.error);
};
for (const [name, o, want] of refuseLater) refuse(name, { id: "r1", actor: "amaraghy", ...o }, want);
refuse("non-JSON", "hello", "JSON");
refuse("a JSON array", "[1,2]", "object");
refuse("null", "null", "object");
refuse("a missing id", { op: "status", actor: "a" }, "id");
refuse("an id with spaces", { id: "a b", op: "status", actor: "a" }, "id");
refuse("an unknown op", { id: "1", op: "shell", actor: "a" }, "unknown op");
refuse("an op from the prototype", { id: "1", op: "constructor", actor: "a" }, "unknown op");
refuse("__proto__ as op", { id: "1", op: "__proto__", actor: "a" }, "unknown op");
refuse("a missing actor", { id: "1", op: "status" }, "actor");
refuse("an actor with a space", { id: "1", op: "status", actor: "a b" }, "actor");
refuse("an actor with a newline", { id: "1", op: "status", actor: "a\nb" }, "actor");
refuse("an over-long actor", { id: "1", op: "status", actor: "a".repeat(65) }, "actor");
refuse("an extra field", { id: "1", op: "status", actor: "a", cmd: "rm -rf /" }, "unexpected");
refuse("send without text", { id: "1", op: "send", actor: "a" }, "text is required");
refuse("send with blank text", { id: "1", op: "send", actor: "a", text: "   " }, "empty");
refuse("send with numeric text", { id: "1", op: "send", actor: "a", text: 5 }, "string");
refuse("send with a NUL", { id: "1", op: "send", actor: "a", text: "hi\u0000there" }, "NUL");
refuse("send with oversize text", { id: "1", op: "send", actor: "a", text: "x".repeat(p.MAX_TEXT + 1) }, "longer");
refuse("send with a newline in the target", { id: "1", op: "send", actor: "a", text: "hi", target: "a\nb" }, "target");
refuse("send with an oversize target", { id: "1", op: "send", actor: "a", text: "hi", target: "t".repeat(301) }, "target");
refuse("approve with a string id", { id: "1", op: "approve", actor: "a", approval_id: "3" }, "integer");
refuse("approve with zero", { id: "1", op: "approve", actor: "a", approval_id: 0 }, "integer");
refuse("approve with a float", { id: "1", op: "approve", actor: "a", approval_id: 1.5 }, "integer");
refuse("approve without an id", { id: "1", op: "approve", actor: "a" }, "required");
refuse("deny with an oversize note", { id: "1", op: "deny", actor: "a", approval_id: 1, note: "n".repeat(501) }, "longer");
refuse("ledger of an unknown table", { id: "1", op: "ledger", actor: "a", table: "sqlite_master" }, "table");
refuse("ledger with a status from another table", { id: "1", op: "ledger", actor: "a", table: "delegations", status: "pending" }, "status");
refuse("ledger with an injected status", { id: "1", op: "ledger", actor: "a", table: "turns", status: "done' OR 1=1" }, "status");
refuse("ledger with limit 0", { id: "1", op: "ledger", actor: "a", table: "turns", limit: 0 }, "limit");
refuse("ledger with limit 10000", { id: "1", op: "ledger", actor: "a", table: "turns", limit: 10000 }, "limit");
refuse("events with a negative since", { id: "1", op: "events", actor: "a", since: -1 }, "since");
refuse("rc with a string", { id: "1", op: "rc", actor: "a", enabled: "yes" }, "true or false");
refuse("an oversize line", JSON.stringify({ id: "1", op: "send", actor: "a", text: "x".repeat(70000) }), "too large");
check("a refusal keeps the request id when it could be read", req({ id: "abc", op: "nope", actor: "a" }).id === "abc");

/* --------------------------------------------------------------- replies --- */

{
  const ok = JSON.parse(p.reply("r1", { a: 1 }));
  const bad = JSON.parse(p.replyError("r1", "x".repeat(900)));
  check("reply shape", ok.id === "r1" && ok.ok === true && ok.data.a === 1);
  check("error shape and length cap", bad.ok === false && bad.error.length === 500);
  check("replies are one line", !p.reply("r", { t: "a\nb" }).trim().includes("\n"));
}

/* ------------------------------------------------------------ peer text --- */

{
  const msg = `<cross-session-message from="uds:/run/user/0/cc-socks/2781306.sock" from-name="joya-e2e-target" from-mode="prompting">\nPONG-7\n</cross-session-message>`;
  const r = peers.parsePrompt(msg);
  check("parses a cross-session message", r.length === 1 && r[0].kind === "message" && r[0].from_name === "joya-e2e-target" && r[0].from_pid === 2781306 && r[0].text === "PONG-7", JSON.stringify(r));
  const two = peers.parsePrompt(msg + "\n" + msg.replace("PONG-7", "second"));
  check("parses two batched messages", two.length === 2 && two[1].text === "second");
  const idle = peers.parsePrompt(
    `[Cross-session idle notice] "peertest-B", which you asked to be notified about, is idle now — it finished a turn at 14:05. Its harness reports: «Done. I've sent PONG-42.». This is an automated notice from that session's harness.`
  );
  check("parses an idle notice", idle.length === 1 && idle[0].kind === "idle" && idle[0].from_name === "peertest-B" && idle[0].state === "idle" && /PONG-42/.test(idle[0].text), JSON.stringify(idle));
  const exp = peers.parsePrompt(`[Cross-session idle notice] "w", which you asked to be notified about, never signalled: the subscription expired.`);
  check("reads an expired idle subscription", exp[0] && exp[0].state === "expired");
  const held = peers.parsePrompt(`[Cross-session delivery notice] Your message to "w" is held for its user's approval.`);
  check("reads a held delivery notice", held[0] && held[0].kind === "delivery" && held[0].state === "held" && held[0].from_name === "w");
  const ref = peers.parsePrompt(`[Cross-session delivery notice] "w" refused your message.`);
  check("reads a refused delivery notice", ref[0] && ref[0].state === "refused");
  check("ordinary prompts carry no peer events", peers.parsePrompt("restart the tests please").length === 0);
  check("bareName strips the ref", peers.bareName("joya-e2e-target [3157c9]") === "joya-e2e-target");
  check("bareName keeps a plain name", peers.bareName("Odoo 19 VPS setup customizations") === "Odoo 19 VPS setup customizations");
  check("pid from a socket address", peers.pidFromAddress("uds:/run/user/0/cc-socks/42.sock") === 42);
  check("no pid from nonsense", peers.pidFromAddress("bridge:xyz") === null);
}

/* ------------------------------------------- UI control Phase 2 --- */
{
  const UT = "AbCdEfGhIjKlMnOpQrStUvWx";
  check("send takes a ui token", good({ op: "send", text: "hi", ut: UT }).ok && good({ op: "send", text: "hi", ut: UT }).req.params.ut === UT);
  check("  but not a malformed one (short, odd characters, too long)", !good({ op: "send", text: "hi", ut: "short" }).ok && !good({ op: "send", text: "hi", ut: "a b c d e f g h i j k l m" }).ok && !good({ op: "send", text: "hi", ut: "x".repeat(41) }).ok);
  const ua = good({ op: "ui-action", action: "sheet.open", args: { key: "missions" } });
  check("ui-action: an action name and flat args; mutating (audited)", ua.ok && ua.req.mutating === true && ua.req.params.args.key === "missions");
  check("  args are optional", good({ op: "ui-action", action: "sheet.close" }).ok);
  check("  refuses an unknown arg key, a nested value, a long value, a URL-ish value", !good({ op: "ui-action", action: "sheet.open", args: { url: "x" } }).ok && !good({ op: "ui-action", action: "sheet.open", args: { key: { a: 1 } } }).ok &&
    !good({ op: "ui-action", action: "sheet.open", args: { key: "x".repeat(41) } }).ok && !good({ op: "ui-action", action: "settings.open", args: { page: "https://evil/x" } }).ok);
  check("  refuses an action name that is not a.b form", !good({ op: "ui-action", action: "rm -rf /" }).ok && !good({ op: "ui-action", action: "" }).ok);
  check("  refuses extra top-level fields (a token smuggled in)", !good({ op: "ui-action", action: "sheet.close", ut: UT }).ok);
  check("ui-ack: nonce, ok, optional why", good({ op: "ui-ack", nonce: "abcdef012345", ok: true }).ok && good({ op: "ui-ack", nonce: "abcdef012345", ok: false, why: "no panel is open" }).ok);
  check("  refuses a bad nonce or a non-boolean ok", !good({ op: "ui-ack", nonce: "../x", ok: true }).ok && !good({ op: "ui-ack", nonce: "abcdef012345", ok: "yes" }).ok);
}

// Voice lanes (2026-10-30): voice-warm, and the lane JOYA AI's MCP names beside the actor.
{
  const P = require("../lib/protocol.js");
  const pr = (o) => P.parseRequest(JSON.stringify({ id: "x", ...o }));
  check("voice-warm takes a call id, a read", pr({ op: "voice-warm", actor: "amaraghy", call: "lvab12" }).ok && pr({ op: "voice-warm", actor: "amaraghy", call: "lvab12" }).req.mutating === false);
  check("  refuses anything that is not a call id", !pr({ op: "voice-warm", actor: "amaraghy", call: "../x" }).ok && !pr({ op: "voice-warm", actor: "amaraghy" }).ok);
  const ln = pr({ op: "ui-action", actor: "joya-ai", lane: "v3-ab12", action: "sheet.close" });
  check("lane: JOYA AI's actor may name its voice lane on any op (kept out of the params)", ln.ok && ln.req.lane === "v3-ab12" && !("lane" in ln.req.params), JSON.stringify(ln));
  check("  nobody else may", !pr({ op: "status", actor: "amaraghy", lane: "v3-ab12" }).ok);
  check("  and it must look like a lane id", !pr({ op: "status", actor: "joya-ai", lane: "x y" }).ok && !pr({ op: "status", actor: "joya-ai", lane: 5 }).ok);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
