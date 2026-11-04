/**
 * UI control Phase 2 in the dashboard: lib/ui-relay.js (the ui tokens this
 * server mints) and how server.js, the live call and the page
 * use it.
 *
 *     node dashboard/tools/test-ui-relay.cjs
 *
 * The rules: a token is minted here only for a send from a tab (never read
 * from a request); the supervisor's "ui" event carries only a tag of it; the
 * one stream of that user's tab acts on it, once; an event with a tag nobody
 * minted here (a send forged onto the supervisor's socket) is dropped and
 * audited once; an answer is taken only for a nonce delivered to that user.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const relayLib = require(path.join(ROOT, "lib", "ui-relay.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("  ok   " + name);
  }
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}

console.log("the relay");
{
  let t = 1000;
  const R = relayLib.createRelay({ now: () => t });
  const TAB = "tabAAAAAAAA1", TAB2 = "tabBBBBBBBB2";
  check("no token without a proper tab id", R.joya({ actor: "admin", tab: "x" }) === null && R.joya({ actor: "admin" }) === null && R.joya({ actor: "admin", tab: "<script>alert(1)</script>" }) === null);
  const ut = R.joya({ actor: "admin", tab: TAB, via: "page" });
  check("a token: 24 url-safe characters, fresh each time", /^[A-Za-z0-9_-]{24}$/.test(ut) && ut !== R.joya({ actor: "admin", tab: TAB, via: "page" }));
  const ev = { type: "ui", actor: "admin", ut_tag: relayLib.tag(ut), nonce: "n0000000001", action: "sheet.open", args: { key: "missions" }, turn_id: 7 };
  check("another user's stream: not for it", JSON.stringify(R.route(ev, "bob", TAB)) === "{}");
  check("the same user's other tab: not for it", JSON.stringify(R.route(ev, "admin", TAB2)) === "{}");
  const d = R.route(ev, "admin", TAB);
  check("the tab that asked: delivered", d.deliver && d.deliver.tab === TAB && d.deliver.actor === "admin");
  check("  once (a duplicated tab or a second stream gets nothing)", JSON.stringify(R.route(ev, "admin", TAB)) === "{}");
  check("the answer: only by that user, once", !R.takeAck("n0000000001", "bob") && R.takeAck("n0000000001", "admin") && !R.takeAck("n0000000001", "admin"));
  check("no answer for a nonce never delivered", !R.takeAck("n9999999999", "admin"));
  const ev2 = { ...ev, nonce: "n0000000002", turn_id: 8 };
  check("the token is bound to its first turn: an event from another turn is dropped as forged", R.route(ev2, "admin", TAB).forged === true);
  const forged = { ...ev, nonce: "n0000000003", ut_tag: "0123456789abcdef" };
  check("a tag never minted here: forged, reported once across streams", R.route(forged, "admin", TAB).forged === true && JSON.stringify(R.route(forged, "admin", TAB2)) === "{}" && JSON.stringify(R.route(forged, "bob", TAB)) === "{}");
  const other = { ...ev, nonce: "n0000000004", actor: "bob" };
  check("an event naming another user than the token's: forged", R.route(other, "admin", TAB).forged === true);
  const ut3 = R.joya({ actor: "admin", tab: TAB, via: "page" });
  t += 61 * 60 * 1000;
  check("a token expires after an hour", R.route({ ...ev, nonce: "n0000000005", ut_tag: relayLib.tag(ut3) }, "admin", TAB).forged === true);
  const ut4 = R.joya({ actor: "admin", tab: TAB, via: "page" });
  R.bind(ut4, 42);
  check("bound at send time: the same token on another turn (a stolen token replayed on a forged send) is dropped", R.route({ ...ev, nonce: "n0000000006", ut_tag: relayLib.tag(ut4), turn_id: 43 }, "admin", TAB).forged === true && !!R.route({ ...ev, nonce: "n0000000007", ut_tag: relayLib.tag(ut4), turn_id: 42 }, "admin", TAB).deliver);
    check("an event with no tag or nonce is ignored", JSON.stringify(R.route({ type: "ui", actor: "admin" }, "admin", TAB)) === "{}");
  check("the raw token is never in an event it builds (only the tag is compared)", !JSON.stringify(d).includes(ut));
}

console.log("\nthe live call hands the token on");
{
  const shared = require(path.join(ROOT, "lib", "voice-shared.js")); // the supervisor door (was voice-desk.js)
  const seen = [];
  const ops = shared.voiceOps(async (op, params, actor) => (seen.push({ op, params, actor }), { turn: { id: 1 } }), "admin");
  const run = async () => {
    await ops.ask("restart odoo please", { ut: "UtUtUtUtUtUtUtUtUtUtUt01" });
    await ops.ask("and the disk");
    return seen;
  };
  module.exports.run = run;
}

(async () => {
  const seen = await module.exports.run();
  check("voiceOps.ask(text, {ut}) sends the token with the voice's send (via voice-desk)", seen[0].op === "send" && seen[0].params.ut === "UtUtUtUtUtUtUtUtUtUtUt01" && seen[0].params.via === "voice-desk");
  check("  and without one sends none", seen[1].op === "send" && !("ut" in seen[1].params));
  const liveSrc = fs.readFileSync(path.join(ROOT, "lib", "voice-live.js"), "utf8");
  check("the live call's hand-off carries its ticket", /ut = this\.d\.uiTicket \? this\.d\.uiTicket\(\) : null;[\s\S]{0,700}this\.d\.ops\.ask\(request, \{ \.\.\.\(ut \? \{ ut \} : \{\}\), call: this\.id(, vp)? \}\)/.test(liveSrc));
  check("the live call does JOYA AI's call.* itself (deepUi), nothing else", /deepUi\(v\) \{[\s\S]*?else return \{ ok: false, why: "not a call action" \};/.test(liveSrc));

  console.log("\nserver.js");
  const s = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const send = s.slice(s.indexOf('app.post("/joya-ai/api/send"'), s.indexOf('app.post("/joya-ai/api/interrupt"'));
  check("/send mints the token itself for the body's tab (never takes one from the body)", /const ut = uiRelay\.joya\(\{ actor: req\.me\.username, tab: \(req\.body \|\| \{\}\)\.tab, via: "page" \}\);\s*if \(ut\) params\.ut = ut;/.test(send) && !/body\.ut|req\.body\.ut/.test(s));
  check("  after the voice-grounding refusal (a refused voice turn gets none)", send.indexOf("sendRefusal") < send.indexOf("uiRelay.joya"));
  const ev = s.slice(s.indexOf('app.get("/joya-ai/api/events"'), s.indexOf("function uiDeliver("));
  check("the event stream never writes a ui event as it came; uiDeliver decides", /if \(ev\.type === "ui"\) return uiDeliver\(ev, req, tab, res\);/.test(ev) && /uiTab\.test\(req\.query\.tab\)/.test(ev));
  const del = s.slice(s.indexOf("function uiDeliver("), s.indexOf('app.post("/joya-ai/api/ui/ack"'));
  check("uiDeliver: forged is audited and dropped; the page gets nonce/action/args/toast only (no tag, no turn)", /if \(r\.forged\) \{[\s\S]*?never minted[\s\S]*?return;/.test(del) && /JSON\.stringify\(\{ type: "ui", nonce: ev\.nonce, action: v\.action, args: v\.args, toast: UiActions\.toast\(v\.action, v\.args\), deep: true \}\)/.test(del));
  check("  re-validates against the allowlist; call.* go to the live call, else refused", /UiActions\.validate\(ev\.action, ev\.args \|\| \{\}\)/.test(del) && /voiceLive\.callFor\(actor\)[\s\S]*?"no voice call is open"[\s\S]*?call\.deepUi\(v\)/.test(del));
  const ack = s.slice(s.indexOf('app.post("/joya-ai/api/ui/ack"'), s.indexOf('app.post("/joya-ai/api/send"'));
  check("/ui/ack: CSRF'd, strict body, only a nonce delivered to this user", /\.\.\.joyaAiWrite/.test(ack) && /uiRelay\.takeAck\(b\.nonce, req\.me\.username\)/.test(ack) && /typeof b\.ok !== "boolean"/.test(ack));
  check("/send binds the token to the turn the supervisor started; the live call does too (joyaCall)", /if \(ut && sent && sent\.turn\) uiRelay\.bind\(ut, sent\.turn\.id\);/.test(send) && /if \(op === "send" && params && params\.ut && r && r\.turn\) uiRelay\.bind\(params\.ut, r\.turn\.id\);/.test(s) && /ops: voiceShared\.voiceOps\(joyaCall, actor\)/.test(s) && !/summariserFor\([^)]*joyaai\.call/.test(s));
  check("the live call gets tickets for its tab", /uiTicket: \(\) => uiRelay\.joya\(\{ actor, tab, via: "live", callId: call\.id \}\)/.test(s));

  console.log("\nthe page");
  const pg = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("a per-tab id in sessionStorage, sent with every send, live call and on the event stream", /sessionStorage\.getItem\("joya-tab"\)/.test(pg) && /var body = \{ text: text, tab: TAB_ID \};/.test(pg) && /csrf: CSRF,\s*tab: TAB_ID,/.test(pg) && /\/joya-ai\/api\/events\?tab=" \+ encodeURIComponent\(TAB_ID\)/.test(pg));
  check("\"ui\" is listened for, run through runUiAction and answered through ui/ack", /"machine", "ui", "ui-confirm"\]/.test(pg) && /if \(type === "ui"\) \{[\s\S]*?runUiAction\(ev\)[\s\S]*?api\("ui\/ack"/.test(pg));
  const vl = fs.readFileSync(path.join(ROOT, "public", "voice-live.js"), "utf8");
  check("the live socket carries the tab", /\(o\.tab \? "&tab=" \+ encodeURIComponent\(o\.tab\) : ""\)/.test(vl));

  console.log("\nthe two allowlists");
  const a = fs.readFileSync(path.join(ROOT, "public", "ui-actions.js"), "utf8");
  const b = fs.readFileSync(path.join(ROOT, "..", "joya-ai", "lib", "ui-actions.js"), "utf8");
  check("joya-ai/lib/ui-actions.js is byte-identical to dashboard/public/ui-actions.js", a === b);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
