#!/usr/bin/env node
"use strict";
/**
 * Who a delegation went to (lib/targets.js, and the supervisor's use of it):
 * namesakes are never pinned by name, a Remote Control ref and a sub-agent id
 * are stamped as such and never "failed" for not being local, a renamed
 * session is found by its ListAgents ref, a restart (new pid, same session id)
 * keeps a session's delegations. DEMO names only.
 *
 *     node joya-ai/tools/test-delegation-targets.cjs
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const T = require(path.join(ROOT, "lib", "targets.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return console.log("ok   " + name); }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Joya's own throwaway CLIs (the usage probe) are hidden by one narrow rule: the joya-internal- name prefix.
check("isInternal: only the joya-internal- prefix; tmp-9c, a real session in /tmp, JOYA AI and near misses stay",
  T.isInternal({ name: "joya-internal-usage-probe" }) && !T.isInternal({ name: "tmp-9c" }) && !T.isInternal({ name: "JOYA AI" }) && !T.isInternal({ name: "Joya internal notes" }) &&
  !T.isInternal({ name: "my-joya-internal-x" }) && !T.isInternal({ name: null }) && !T.isInternal(null));

// The ListAgents text as Claude Code 2.1.28x prints it (demo names).
const LIST = [
  "This session is JOYA AI [9733c9] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).",
  "",
  "Subagents (2):",
  "  a75d0be7bd2df9a7f  ·  general-purpose  ·  completed  ·  started 4h ago",
  "  a6e57ebc50a62a486  ·  general-purpose  ·  running  ·  started 1h ago",
  "",
  "Peer sessions (4):",
  "  Demo Builder [2e985f]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 2h ago",
  "  Demo Odoo [8668d1]  ·  interactive  ·  busy  ·  Claude Desktop session  ·  started 7h ago",
  "  Demo Laptop [7931d9]  ·  Remote Control  ·  idle",
  "  Old Request [76d945]  ·  Remote Control  ·  offline",
].join("\n");

console.log("lib/targets.js");
{
  const p = T.parseListAgents(LIST);
  check("parseListAgents: self, sub-agents, peers with their ref and kind (interactive = local, Remote Control only = remote)",
    p.self && p.self.ref === "9733c9" && p.subagents.join() === "a75d0be7bd2df9a7f,a6e57ebc50a62a486" &&
    p.refs["2e985f"].name === "Demo Builder" && p.refs["2e985f"].kind === "local" && p.refs["7931d9"].kind === "remote" && p.refs["76d945"].state === "offline", JSON.stringify(p));
  check("refOf: the [ref] of a SendMessage target", T.refOf("Demo Builder [2e985f]") === "2e985f" && T.refOf("a75d0be7bd2df9a7f") === null);
  const list = [
    { pid: 1, session_id: "s1", name: "Twin" }, { pid: 2, session_id: "s2", name: "twin" },
    { pid: 3, session_id: "s3", name: "Demo Builder" }, { pid: 9, session_id: "s9", name: "JOYA AI", self: true },
  ];
  check("findTarget: namesakes (normalised) -> ambiguous, never the first", T.findTarget(list, { name: "Twin" }).session === null && T.findTarget(list, { name: "Twin" }).why === "ambiguous");
  check("  session id first, then pid, then a unique name; JOYA AI itself never", T.findTarget(list, { name: "Twin", sessionId: "s2" }).session.pid === 2 && T.findTarget(list, { pid: 3 }).session.session_id === "s3" && T.findTarget(list, { name: "demo_builder" }).session.pid === 3 && !T.findTarget(list, { name: "JOYA AI" }).session);
  check("kindFor: a sub-agent id, a Remote Control ref, a local session, or unknown",
    T.kindFor({ to: "a75d0be7bd2df9a7f", refs: p.refs, subagents: p.subagents }) === "subagent" &&
    T.kindFor({ to: "Demo Laptop [7931d9]", refs: p.refs }) === "remote" &&
    T.kindFor({ to: "Demo Builder [2e985f]", refs: p.refs, session: list[2] }) === "local" &&
    T.kindFor({ to: "Nobody [123456]", refs: p.refs }) === "unknown");
  check("mayFail: only a pinned LOCAL target; remote, sub-agent, unknown and unpinned ones wait for their ack / idle notice",
    T.mayFail({ target_kind: "local", target_pid: 5 }) && !T.mayFail({ target_kind: "remote", target_pid: 5 }) && !T.mayFail({ target_kind: "subagent" }) && !T.mayFail({ target_kind: "unknown" }) && !T.mayFail({ target_kind: "local" }) &&
    T.mayFail({ target_kind: null, target_pid: 5 }) && !T.mayFail({ target_kind: null, target_name: "x" }));
  check("openTarget: a restarted session (new pid, same session id) is still the target", T.openTarget({ target_pid: 77, target_session: "s3", target_name: "Demo Builder" }, list).pid === 3);
}

/* ------------------------------------------------ the supervisor, end to end (fake CLI) -- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-targets-"));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
const fake = path.join(__dirname, "fake-claude.cjs");
const cfgFile = path.join(tmp, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify({ cli: fake, cli_version: "2.1.283", cwd: tmp, home, runtime_dir: "", state_dir: path.join(tmp, "state"), log_dir: path.join(tmp, "log"), run_dir: path.join(tmp, "run"), socket_group: "root", approval_timeout_s: 3, sessions_poll_s: 1, backoff_min_s: 1, backoff_max_s: 2, cost_scan_s: 30 }));
const SOCK = path.join(tmp, "run", "joya-ai.sock");
function agents(list) {
  const f = path.join(home, "fake-agents.json");
  fs.writeFileSync(f + ".tmp", JSON.stringify(list.map((a) => ({ pid: a.pid, sessionId: a.sid, name: a.name, cwd: "/tmp/demo", kind: "interactive", status: a.status || "idle", startedAt: Date.now() }))));
  fs.renameSync(f + ".tmp", f);
}
let n = 0;
function call(op, params = {}, actor = "tester") {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify({ id: "t" + ++n, op, actor, ...params }) + "\n"));
    s.on("data", (c) => { buf += c; const nl = buf.indexOf("\n"); if (nl !== -1) { s.destroy(); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
}
async function idle() { for (let i = 0; i < 80; i++) { const st = await call("status"); if (st.ok && !st.data.busy) return; await sleep(100); } }
async function lastDelegation() { const r = await call("ledger", { table: "delegations", limit: 1 }); return r.ok ? r.data.rows[0] : null; }
async function send(text) { await idle(); await call("send", { text }); await sleep(300); await idle(); await sleep(300); }

(async () => {
  agents([
    { pid: 61001, sid: "demo-builder", name: "Demo Builder" },
    { pid: 61002, sid: "demo-twin-1", name: "Twin" },
    { pid: 61003, sid: "demo-twin-2", name: "Twin" },
  ]);
  fs.writeFileSync(path.join(home, "fake-listagents.txt"), LIST);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "supervisor.js")], { env: { ...process.env, JOYA_AI_CONFIG: cfgFile, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  try {
    for (let i = 0; i < 80 && !fs.existsSync(SOCK); i++) await sleep(100);
    for (let i = 0; i < 80; i++) { const st = await call("status").catch(() => null); if (st && st.ok && st.data.process.state === "ready") break; await sleep(150); }
    for (let i = 0; i < 40; i++) { const s = await call("sessions"); if (s.ok && s.data.sessions.length >= 3) break; await sleep(150); }
    await send("LISTAGENTS");

    await send('DELEGATE "Twin" QUIET');
    const tw = await lastDelegation();
    check("namesakes (two sessions named Twin): not pinned to either (no pid, no session id), kind unknown", tw && tw.target_name === "Twin" && !tw.target_pid && !tw.target_session && tw.target_kind === "unknown", JSON.stringify(tw));

    await send('DELEGATE "Demo Laptop [7931d9]" QUIET');
    const rm = await lastDelegation();
    check("a Remote Control ref: stamped remote, never pinned to a local process, the ref kept", rm && rm.target_kind === "remote" && !rm.target_pid && rm.target_ref === "7931d9", JSON.stringify(rm));

    await send('DELEGATE "a75d0be7bd2df9a7f" QUIET');
    const sa = await lastDelegation();
    check("a sub-agent id: stamped subagent, not pinned", sa && sa.target_kind === "subagent" && !sa.target_pid && !sa.target_session, JSON.stringify(sa));

    // Renamed: the session "Demo Builder" is now "Demo Builder v2" (same session id); JOYA AI still uses the old ref.
    agents([
      { pid: 61001, sid: "demo-builder", name: "Demo Builder v2" },
      { pid: 61002, sid: "demo-twin-1", name: "Twin" },
      { pid: 61003, sid: "demo-twin-2", name: "Twin" },
    ]);
    fs.writeFileSync(path.join(home, "fake-listagents.txt"), LIST.replace("Demo Builder [2e985f]", "Demo Builder v2 [2e985f]"));
    for (let i = 0; i < 30; i++) { const s = await call("sessions"); if (s.data.sessions.some((x) => x.name === "Demo Builder v2")) break; await sleep(150); }
    await send("LISTAGENTS");
    await send('DELEGATE "Demo Builder [2e985f]" QUIET');
    const rn = await lastDelegation();
    check("a renamed session, addressed by its old name with its ref: the ref finds it (same session id), local", rn && rn.target_session === "demo-builder" && rn.target_pid === 61001 && rn.target_kind === "local", JSON.stringify(rn));

    // Restart: a new pid, the same session id.
    agents([
      { pid: 61011, sid: "demo-builder", name: "Demo Builder v2" },
      { pid: 61002, sid: "demo-twin-1", name: "Twin" },
      { pid: 61003, sid: "demo-twin-2", name: "Twin" },
    ]);
    let after = null;
    for (let i = 0; i < 40; i++) { const s = await call("sessions"); after = s.data.sessions.find((x) => x.session_id === "demo-builder"); if (after && after.pid === 61011) break; await sleep(150); }
    check("after a restart (new pid, same session id) the session keeps its last delegation and its count", after && after.last_delegation && after.last_delegation.id === rn.id && after.delegations_today >= 1 && after.open_delegations >= 1, JSON.stringify(after && { pid: after.pid, last: after.last_delegation && after.last_delegation.id, today: after.delegations_today, open: after.open_delegations }));
    const still = (await call("ledger", { table: "delegations", limit: 10 })).data.rows.find((r) => r.id === rn.id);
    check("  and that delegation is not failed as 'no longer running' (found by session id)", still && still.status !== "failed", JSON.stringify(still));

    // A usage probe (named joya-internal-usage-probe) and a real session someone started in /tmp ("tmp-9c").
    agents([
      { pid: 61011, sid: "demo-builder", name: "Demo Builder v2" },
      { pid: 61002, sid: "demo-twin-1", name: "Twin" },
      { pid: 61003, sid: "demo-twin-2", name: "Twin" },
      { pid: 61020, sid: "demo-probe-1", name: "joya-internal-usage-probe", status: "busy" },
      { pid: 61021, sid: "demo-tmp-1", name: "tmp-9c", status: "busy" },
    ]);
    let seen = null;
    for (let i = 0; i < 40; i++) { const s = await call("sessions"); seen = s.data.sessions; if (seen.some((x) => x.name === "tmp-9c")) break; await sleep(150); }
    check("the usage probe is never listed (no sphere); a real session in /tmp still is", seen && !seen.some((x) => x.name === "joya-internal-usage-probe" || x.session_id === "demo-probe-1") && seen.some((x) => x.name === "tmp-9c"), JSON.stringify(seen && seen.map((x) => x.name)));

    await sleep(2500); // a few sessions polls
    const rows = (await call("ledger", { table: "delegations", limit: 10 })).data.rows;
    const byId = (d) => rows.find((r) => r.id === d.id);
    check("remote, sub-agent and ambiguous targets are not failed by the sessions poll: still sent", ["sent"].includes(byId(rm).status) && byId(sa).status === "sent" && byId(tw).status === "sent", JSON.stringify(rows.map((r) => [r.id, r.target_name, r.status])));
    const pub = (await call("sessions")).data.sessions;
    check("publicDelegation exposes target_kind (the page's edge marker labels it)", pub.some((s) => s.last_delegation && "target_kind" in s.last_delegation));
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + child.logs.slice(-1500));
  } finally {
    child.kill();
    await sleep(200);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
