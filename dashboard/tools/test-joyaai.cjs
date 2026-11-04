/**
 * Tests for the panel's side of JOYA AI: lib/joyaai.js and the permission.
 *
 *     node dashboard/tools/test-joyaai.cjs
 *
 * The client is driven against a stand-in supervisor on a scratch unix socket,
 * so nothing reaches the real one. Covers the request checks (which mirror the
 * supervisor's), what goes over the wire -- the actor always, never an unknown
 * field -- how refusals, a missing supervisor and a silent one come back, the
 * event subscription, and that joyaai.use is in no stock role.
 *
 * .cjs because it uses require, and some directories it may be run from declare
 * "type": "module".
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const m = require(path.join(__dirname, "..", "lib", "joyaai.js"));
const rbac = require(path.join(__dirname, "..", "lib", "rbac.js"));

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
const throwsCode = (fn, code) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e.code === code;
  }
};

/* ------------------------------------------------------------ the checks --- */

check("send: text is trimmed", m.cleanSend({ text: "  hi  " }).text === "hi");
check("send: a target is kept", m.cleanSend({ text: "hi", target: "Odoo 19 VPS setup customizations" }).target === "Odoo 19 VPS setup customizations");
check("send: an empty target is dropped", !("target" in m.cleanSend({ text: "hi", target: "" })));
check("send: only text and target go through", Object.keys(m.cleanSend({ text: "hi", _csrf: "x", op: "restart", actor: "root" })).join() === "text");
check("send: blank text refused", throwsCode(() => m.cleanSend({ text: "   " }), "invalid"));
check("send: missing text refused", throwsCode(() => m.cleanSend({}), "invalid"));
check("send: non-string text refused", throwsCode(() => m.cleanSend({ text: ["a"] }), "invalid"));
check("send: oversize text refused", throwsCode(() => m.cleanSend({ text: "x".repeat(m.MAX_TEXT + 1) }), "invalid"));
check("send: NUL refused", throwsCode(() => m.cleanSend({ text: "a\u0000b" }), "invalid"));
check("send: a target with a newline refused", throwsCode(() => m.cleanSend({ text: "hi", target: "a\nb" }), "invalid"));
check("send: a non-string target refused", throwsCode(() => m.cleanSend({ text: "hi", target: { $ne: 1 } }), "invalid"));
check("approval id: digits accepted", m.cleanApprovalId("42") === 42);
check("approval id: zero refused", throwsCode(() => m.cleanApprovalId("0"), "invalid"));
check("approval id: path tricks refused", throwsCode(() => m.cleanApprovalId("1/../2"), "invalid"));
check("approval id: negative refused", throwsCode(() => m.cleanApprovalId("-1"), "invalid"));
check("note: blank becomes nothing", m.cleanNote("  ") === undefined);
check("note: oversize refused", throwsCode(() => m.cleanNote("n".repeat(501)), "invalid"));
{
  const l = m.cleanLedger("delegations", { limit: "20", status: "done", junk: "1" });
  check("ledger: known table with limit and status", l.table === "delegations" && l.limit === 20 && l.status === "done" && !("junk" in l));
}
check("ledger: unknown table refused", throwsCode(() => m.cleanLedger("sqlite_master", {}), "invalid"));
check("ledger: bad limit refused", throwsCode(() => m.cleanLedger("turns", { limit: "9999" }), "invalid"));
check("ledger: injected status refused", throwsCode(() => m.cleanLedger("turns", { status: "done' or 1=1" }), "invalid"));
check("since: digits", m.cleanSince("15") === 15);
check("since: junk is zero", m.cleanSince("abc") === 0);
check("actor: kept when valid", m.actorOf("amaraghy") === "amaraghy");
check("actor: spaces replaced", m.actorOf("a b") === "a_b");
check("actor: empty becomes unknown", m.actorOf("") === "unknown");

/* ---------------------------------------------------------- over a socket --- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joyaai-client-"));
const SOCK = path.join(tmp, "s.sock");
const seen = [];
const server = net.createServer((s) => {
  s.setEncoding("utf8");
  let buf = "";
  s.on("data", (c) => {
    buf += c;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const req = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    seen.push(req);
    if (req.op === "status") s.write(JSON.stringify({ id: req.id, ok: true, data: { state: "ready", leak: "sk-ant-abcdefghijklmnopqrstuvwxyz0123" } }) + "\n");
    else if (req.op === "approve") s.write(JSON.stringify({ id: req.id, ok: false, error: "that approval is already denied" }) + "\n");
    else if (req.op === "slow") {
      /* never answers */
    } else if (req.op === "events") {
      s.write(JSON.stringify({ id: req.id, ok: true, data: { subscribed: true } }) + "\n");
      s.write(JSON.stringify({ event: { seq: 1, type: "turn", text: "one" } }) + "\n");
      s.write(JSON.stringify({ event: { seq: 2, type: "assistant", text: "Bearer abcdefghijklmnopqrstuvwxyz" } }) + "\n");
      setTimeout(() => s.end(), 50);
    }
  });
});

(async () => {
  await new Promise((r) => server.listen(SOCK, r));
  const st = await m.call("status", {}, "amaraghy", { socket: SOCK });
  check("call: returns the data", st.state === "ready");
  check("call: sends the actor", seen[0].actor === "amaraghy" && seen[0].op === "status");
  check("call: redacts on the way in", !/sk-ant-/.test(st.leak));
  try {
    await m.call("approve", { approval_id: 1 }, "amaraghy", { socket: SOCK });
    check("call: a refusal rejects", false);
  } catch (e) {
    check("call: a refusal rejects with code refused", e.code === "refused" && /already denied/.test(e.message));
  }
  try {
    await m.call("status", {}, "x", { socket: path.join(tmp, "missing.sock") });
    check("call: no supervisor rejects", false);
  } catch (e) {
    check("call: no supervisor rejects with code offline", e.code === "offline", e.code);
  }
  try {
    await m.call("slow", {}, "x", { socket: SOCK, timeout: 300 });
    check("call: silence times out", false);
  } catch (e) {
    check("call: silence times out", e.code === "timeout");
  }
  const events = [];
  await new Promise((resolve) => m.subscribe(0, "amaraghy", (ev) => events.push(ev), resolve, { socket: SOCK }));
  check("subscribe: delivers events in order", events.length === 2 && events[0].seq === 1 && events[1].seq === 2);
  check("subscribe: redacts events", !/abcdefghijklmnop/.test(events[1].text));
  check("subscribe: omits since when zero", !("since" in seen.find((r) => r.op === "events")));

  /* ------------------------------------------------------------- the perm --- */
  check("joyaai.use is a known permission", rbac.PERMISSION_SET.has("joyaai.use"));
  check("the administrator has it", rbac.actor(rbac.SYSTEM_ROLES[0]).can("joyaai.use"));
  check("no other stock role has it", rbac.SYSTEM_ROLES.filter((r) => r.name !== "administrator").every((r) => !r.permissions.includes("joyaai.use")));
  check("a role-less actor does not", !rbac.actor(null).can("joyaai.use"));

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
