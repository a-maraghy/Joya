/**
 * UI control Phase 3: Tier-2 preferences (theme.set, persona.set, voice.set)
 * wait for the administrator's confirm, which the server checks.
 *
 *     node dashboard/tools/test-ui-confirm.cjs
 *
 * lib/ui-confirm.js (one pending confirm per user, 30 s; a click, or the next
 * utterance this server heard being a whole "yes"; anything else drops it),
 * and the wiring in server.js, the live call and the page:
 * nothing is changed by the model, the page applies it through the existing
 * CSRF'd routes, voice.set never with a call open.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { createConfirms } = require(path.join(ROOT, "lib", "ui-confirm.js"));
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

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

console.log("expiry is not silent, and the window starts when the voice has finished asking");
{
  let t = 0;
  const timers = [];
  const expired = [];
  const C = createConfirms({ now: () => t, setTimer: (fn, ms) => timers.push({ at: t + ms, fn }), onExpire: (actor, e) => expired.push({ actor, e }) });
  const run = () => { for (const x of timers.splice(0)) if (x.at <= t) x.fn(); else timers.push(x); };
  const a = C.open({ actor: "admin", action: "theme.set", args: { theme: "dark" }, tab: "tabAAAAAAAA1", ip: "203.0.113.7" });
  t = 20000;
  check("arm(): the voice finished asking at 20 s -- the 30 s start now", C.arm("admin", a.id) === true && !C.arm("admin", "000000000000000000"));
  t = 31000; run();
  check("  so at 31 s it still waits (30 s from the ask would have expired it)", !!C.pending("admin") && expired.length === 0);
  t = 50100; run();
  check("  at 50 s it expires, once, and onExpire is told who, what and the ip for the audit", !C.pending("admin") && expired.length === 1 && expired[0].actor === "admin" && expired[0].e.id === a.id && expired[0].e.action === "theme.set" && expired[0].e.ip === "203.0.113.7");
  run();
  check("  never twice", expired.length === 1);
  const b = C.open({ actor: "admin", action: "theme.set", args: { theme: "light" } });
  C.take("admin", b.id, "cancel");
  t = 90000; run();
  check("an answered confirm does not 'expire'", expired.length === 1);
  const d = C.open({ actor: "bob", action: "theme.set", args: { theme: "light" } });
  t = 130000;
  check("a lazy read after the time also reports the expiry", C.pending("bob") === null && expired.length === 2 && expired[1].e.id === d.id);
}
{
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  check("server: an expiry is audited \"expired, nothing changed\", the chip is told on the event stream, and the live call too", /createConfirms\(\{ onExpire: \(actor, e\) => uiConfirmExpired\(actor, e\) \}\)/.test(src) && /expired, nothing changed/.test(src) && /event: ui-confirm/.test(src) && /call\.confirmExpired\(e\)/.test(src));
  check("  the live call arms the window and may answer a whole yes/no just after the voice", /armConfirm: \(id\) => uiConfirms\.arm\(actor, id\)/.test(src) && /isYesNo: \(text\) => voiceStop\.yes\(text\) \|\| voiceStop\.no\(text\)/.test(src));
  const page = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("page: the chip shows 'Expired: nothing was changed.' (event stream or live call; the live call says it)", /function uiConfirmExpired\(id, line\)/.test(page) && /Expired: nothing was changed\./.test(page) && /"ui-confirm-expired"/.test(page));
  check("  a Tier-2 ask while a page is up in the shell: Confirm / Cancel on the dock, no pulling back", /v\.tier !== 2 && \["call\.end"/.test(page) && /window\.JoyaShell\.confirm\(question/.test(page));
}

console.log("the pending confirm");
{
  let t = 0;
  const C = createConfirms({ now: () => t });
  const a = C.open({ actor: "admin", action: "voice.set", args: { voice: "cedar" }, tab: "tabAAAAAAAA1" });
  check("open: an id", /^[0-9a-f]{18}$/.test(a.id));
  check("one at a time per user", !!C.open({ actor: "admin", action: "theme.set", args: { theme: "dark" } }).error && !C.open({ actor: "bob", action: "theme.set", args: { theme: "dark" } }).error);
  check("another user cannot take it", C.take("bob", a.id, "confirm") === null);
  check("a wrong id cannot take it", C.take("admin", "000000000000000000", "confirm") === null);
  check("a heard yes marks it (not applied, not consumed)", C.heard("admin", "Yes, please.", VoiceStop).confirmed.id === a.id && C.pending("admin").heardYes === true);
  check("  a second utterance does not change it", C.heard("admin", "no", VoiceStop) === null);
  const took = C.take("admin", a.id, "confirm");
  check("the page takes it once: action, args, spoken", took && took.action === "voice.set" && took.args.voice === "cedar" && took.spoken === true && C.take("admin", a.id, "confirm") === null);
  const b = C.open({ actor: "admin", action: "theme.set", args: { theme: "dark" } });
  check("a heard no cancels it", C.heard("admin", "لأ", VoiceStop).cancelled.id === b.id && C.pending("admin") === null);
  const c = C.open({ actor: "admin", action: "theme.set", args: { theme: "dark" } });
  check("anything else drops it (the next turn has moved on), and goes on as a turn", C.heard("admin", "what's the disk usage?", VoiceStop).dropped.id === c.id && C.pending("admin") === null);
  const d = C.open({ actor: "admin", action: "theme.set", args: { theme: "light" } });
  t += 31000;
  check("30 s: expired, nothing to take or hear", C.take("admin", d.id, "confirm") === null && C.heard("admin", "yes", VoiceStop) === null);
  const e = C.open({ actor: "admin", action: "theme.set", args: { theme: "light" } });
  check("a click cancels", C.take("admin", e.id, "cancel").cancelled === true && C.pending("admin") === null);
  check("nothing pending: a yes is an ordinary turn (null)", C.heard("admin", "yes", VoiceStop) === null);
  const f = C.open({ actor: "admin", action: "theme.set", args: { theme: "light" } });
  check("a click confirms without a spoken yes", C.take("admin", f.id, "confirm").spoken === false);
}

console.log("\nserver.js");
const s = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const open = s.slice(s.indexOf("function uiConfirmOpen("), s.indexOf("function uiConfirmHeard("));
check("open: persona/voice need voice.manage; one voice.set confirm at a time (the voice is global); audited; no call-open refusal", /!who\.canVoice\) return \{ error/.test(open) && /v\.action === "voice\.set" && uiConfirms\.anyPending\("voice\.set"\)\) return \{ error/.test(open) && /waiting for the administrator's confirm/.test(open) && !/activeCount/.test(open));
const route = s.slice(s.indexOf('app.post("/joya-ai/api/ui/confirm"'), s.indexOf('app.post("/joya-ai/api/ui/ack"'));
check("/ui/confirm: CSRF'd, strict body, only the user's pending id, re-checks the permission; a voice.set marks this user's call to greet in the new voice", /\.\.\.joyaAiWrite/.test(route) && /uiConfirms\.take\(req\.me\.username, b\.id, b\.decision\)/.test(route) && /req\.perm\.can\("voice\.manage"\)/.test(route) && /voiceGreet\.set\(req\.me\.username, Date\.now\(\) \+ 20000\)/.test(route) && !/activeCount/.test(route));
{
  const opt = s.slice(s.indexOf('app.post("/joya-ai/settings/voice/options"'), s.indexOf('app.post("/joya-ai/settings/voice/persona"'));
  check("the options route: locked while a voice.set waits for a confirm; after saving, open calls RECONNECT (voiceForget(\"reconnect\") + voiceReconnect), greeting only the confirmer", /const lock = uiConfirmsVoicePending\(\);/.test(opt) && /voiceForget\("reconnect"\);/.test(opt) && /voiceReconnect\(greet\)/.test(opt) && !/voiceForget\(\);/.test(opt));
  const fg = s.slice(s.indexOf("function voiceForget("), s.indexOf("async function voiceReconnect("));
  check("voiceForget closes live calls only when told to (the key was removed); the key test keeps them; a new key reconnects them", /if \(live === "close"\) voiceLive\.closeAll/.test(fg) && /voiceKeyClear\(\);\s*voiceForget\("close"\);/.test(s) && /voiceForget\("keep"\); \/\/ test/.test(s) && /voiceKeySet\(value\);\s*voiceForget\("reconnect"\);\s*voiceReconnect\(null\)/.test(s) && !/voiceForget\(\)/.test(s.replace(/function voiceForget\(live\)/, "")));
}
check("  it writes no setting itself: it hands the page the form for the existing route", !/setVoicePersona|voiceOptionsSet|setSetting/.test(route) && /form = \{ voice: t\.args\.voice \}/.test(route));
const send = s.slice(s.indexOf('app.post("/joya-ai/api/send"'), s.indexOf('app.post("/joya-ai/api/interrupt"'));
check("/send: a whole yes/no answers a pending confirm and goes nowhere else", /const conf = (files\.length \? null : )?uiConfirmHeard\(/.test(send) && send.indexOf("uiConfirmHeard") < send.indexOf('joyaai.call("send"') && /return res\.json\(\{ confirm:/.test(send));
check("the front desk and its routes are gone", !/\/joya-ai\/api\/desk\//.test(s.replace(/\/\*[\s\S]*?\*\//g, "")));
check("voice.set and call.* are refused while voice is off: opening a confirm, JOYA AI's own, and the confirm itself", /if \(uiVoiceOff\(v\.action\)\) return \{ error: "voice is off" \};/.test(s) && /if \(uiVoiceOff\(v\.action\)\) return void ack\(false, "voice is off"\);/.test(s) && /if \(uiVoiceOff\(t\.action\)\) return res\.status\(409\)/.test(s));
check("the live call: openConfirm and confirmHeard", /openConfirm: \(v\) => uiConfirmOpen\(\{ username: actor, ip, canVoice \}, v, tab, "the live voice"\)/.test(s) && /confirmHeard: \(text\) => uiConfirmHeard\(/.test(s));
const del = s.slice(s.indexOf("function uiDeliver("), s.indexOf('app.post("/joya-ai/api/ui/confirm"'));
check("JOYA AI's own (Phase 2): tier 2 opens a confirm, tells the tab, answers pending", /if \(v\.tier === 2\) \{[\s\S]*?uiConfirmOpen\([\s\S]*?confirm: o\.id[\s\S]*?pending: true/.test(del));

console.log("\nthe voice never says it is done");
for (const f of ["voice-live.js"]) { // (the front desk, voice-desk.js, is gone)
  const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
  check(`lib/${f}: tier 2 returns status confirm and never sets uiOk`, /if \(v\.tier === 2\) \{[\s\S]*?status: "confirm"[\s\S]*?\}\n/.test(src) && !/if \(v\.tier === 2\) \{[^}]*uiOk = true/.test(src));
}

console.log("\nthe page");
const pg = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
check("tier 2 only asks (Confirm / Cancel chip); applied after the server's /ui/confirm", /if \(v\.tier === 2\) return uiConfirmAsk\(ev, v\);/.test(pg) && /api\("ui\/confirm", \{ body: \{ id: id, decision: decision \} \}\)/.test(pg));
check("  through the existing CSRF'd routes (persona, options) or the theme switch itself", /"\/joya-ai\/settings\/voice\/persona"/.test(pg) && /"\/joya-ai\/settings\/voice\/options"/.test(pg) && /body\.set\("_csrf", CSRF\)/.test(pg) && /\.topbar \[data-theme-opt="' \+ r\.args\.theme/.test(pg));
check("  the server's heard yes/no reaches it from the live call and /send", /m\.type === "ui-confirmed" \|\| m\.type === "ui-confirm-cancelled"/.test(pg) && /if \(r && r\.confirm && typeof uiConfirmAnswer === "function"\)/.test(pg));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
