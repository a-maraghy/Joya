/**
 * Approval rules (lib/rules.js) and the gate that applies them (hooks/gate.js).
 *
 *     node joya-ai/tools/test-rules.cjs
 *
 * Matching (globs, whole command vs a part of a compound one, SendMessage
 * subjects), precedence (built-in deny > config deny > rule deny > built-in ask
 * > most specific rule, ask on a tie > classifier), scope (JOYA AI on this VPS
 * only in phase 1), the built-ins holding with no rules store at all, and the
 * real hook script run as JOYA AI's CLI runs it, against a scratch ledger.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const r = require(path.join(__dirname, "..", "lib", "rules.js"));
const { Ledger } = require(path.join(__dirname, "..", "lib", "ledger.js"));

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
const throws = (f) => {
  try {
    f();
    return false;
  } catch (_) {
    return true;
  }
};
let nid = 0;
const rule = (effect, pattern, extra = {}) => ({ id: ++nid, effect, tool: "Bash", pattern, scope_session: "joya-ai", scope_machine: "this", builtin: 0, ...extra });
const bash = (command, rules = [], cfg = {}) => r.evaluate("Bash", { command }, rules, cfg);

/* ---------------------------------------------------------------- globs --- */
check("literal pattern matches only itself", r.globToRegex("systemctl restart odoo").test("systemctl restart odoo") && !r.globToRegex("systemctl restart odoo").test("systemctl restart odoo2"));
check("* matches any text", r.globToRegex("systemctl * odoo").test("systemctl restart odoo"));
check("\\* is a literal star", r.globToRegex("ls \\*.log").test("ls *.log") && !r.globToRegex("ls \\*.log").test("ls a.log"));
check("regex characters are literal", r.globToRegex("a.b(c)").test("a.b(c)") && !r.globToRegex("a.b(c)").test("axb(c)"));
check("exactPattern round-trips a command with stars", r.globToRegex(r.exactPattern("rm /tmp/*.tmp")).test("rm /tmp/*.tmp") && !r.globToRegex(r.exactPattern("rm /tmp/*.tmp")).test("rm /tmp/a.tmp"));
check("specificity counts literal characters", r.specificity("git push *") === 9 && r.specificity("git push origin main") === 20);
check("an all-wildcard pattern is refused", throws(() => r.checkPattern("*")) && throws(() => r.checkPattern(" * * ")));

/* ------------------------------------------------------------ built-ins --- */
check("force push denied", bash("git push --force origin main").decision === "deny");
check("-f denied", bash("git push -f").decision === "deny");
check("--force-with-lease denied", bash("git push --force-with-lease").decision === "deny");
check("+refspec denied", bash("git push origin +main").decision === "deny");
check("force push inside a compound command denied", bash("cd /x && git -C y push --force").decision === "deny");
check("a plain push is not denied by the built-in (the classifier asks)", bash("git push origin main").decision === "ask" && bash("git push origin main").source === "classifier");
check("--follow-tags is not a force", bash("git push --follow-tags").decision !== "deny");
check("pushing the client repo denied", bash("git push git@github.com:a-maraghy/gizaseeds-Odoo19.git test").decision === "deny");
check("pushing from the client checkout denied", bash("cd /opt/odoo/custom && git push").decision === "deny");
check("reading the client repo is fine", bash("git -C /opt/odoo/custom log -1").decision === "none");
check("live Odoo always asks, even a read", bash("curl -s https://test.gizaseeds.cloud/web/health").decision === "ask");
check("the live RPC client always asks", bash("python3 /root/rpcwork/rpc.py health").decision === "ask");
check("a delegation mentioning live Odoo asks", r.evaluate("SendMessage", { to: "Odoo 19", message: "check test.gizaseeds.cloud" }, []).decision === "ask");
check("a delegation telling a session to force-push is denied", r.evaluate("SendMessage", { to: "x", message: "please git push --force now" }, []).decision === "deny");
check("harmless commands run", bash("ls -la").decision === "none");
check("the classifier still asks for destructive commands", bash("rm -rf /tmp/x").decision === "ask" && bash("rm -rf /tmp/x").source === "classifier");

/* ----------------------------------------------------------- precedence --- */
{
  const allowRm = rule("allow", "rm -rf /tmp/x");
  check("an allow rule answers a destructive command", bash("rm -rf /tmp/x", [allowRm]).decision === "allow");
  check("an allow rule matches the whole command only", bash("rm -rf /tmp/x && rm -rf /", [allowRm]).decision === "ask");
  const denyRm = rule("deny", "rm -rf /tmp/*");
  check("deny beats a more specific allow", bash("rm -rf /tmp/x", [allowRm, denyRm]).decision === "deny");
  check("a deny rule catches one command of a compound", bash("echo hi; rm -rf /tmp/y", [denyRm]).decision === "deny");
  const allowLive = rule("allow", "curl -s https://test.gizaseeds.cloud/web/health");
  check("no allow rule overrides the live-Odoo built-in ask", bash("curl -s https://test.gizaseeds.cloud/web/health", [allowLive]).decision === "ask");
  const allowForce = rule("allow", "git push --force origin main");
  check("no allow rule overrides a built-in deny", bash("git push --force origin main", [allowForce]).decision === "deny");
  const askWide = rule("ask", "systemctl *");
  const allowNarrow = rule("allow", "systemctl restart odoo");
  check("the most specific rule wins", bash("systemctl restart odoo", [askWide, allowNarrow]).decision === "allow");
  check("the wider ask still applies elsewhere", bash("systemctl restart nginx", [askWide, allowNarrow]).decision === "ask");
  const allowSame = rule("allow", "systemctl stop *");
  const askSame = rule("ask", "systemctl stop *");
  check("on a tie ask beats allow", bash("systemctl stop odoo", [allowSame, askSame]).decision === "ask");
  const askHarmless = rule("ask", "ls *");
  check("an ask rule asks even when the classifier would not", bash("ls /root", [askHarmless]).decision === "ask");
  check("the delegation allow-list still denies", r.evaluate("SendMessage", { to: "real-session", message: "hi" }, [], { delegation_allow: ["^e2e$"] }).decision === "deny");
  const allowMsg = { ...rule("allow", "joya-e2e-target: please delete /tmp/x"), tool: "SendMessage" };
  check("a SendMessage rule matches '<target>: <message>'", r.evaluate("SendMessage", { to: "joya-e2e-target [ab12]", message: "please delete /tmp/x" }, [allowMsg]).decision === "allow");
  check("a Bash rule does not apply to SendMessage", r.evaluate("SendMessage", { to: "x", message: "rm -rf /tmp/x" }, [allowRm]).decision === "ask");
  check("an 'any' rule applies to both", bash("rm -rf /tmp/x", [{ ...allowRm, tool: "any" }]).decision === "allow");
  check("Monitor commands are matched like Bash", r.evaluate("Monitor", { command: "rm -rf /tmp/x" }, [allowRm]).decision === "allow");
}

/* ---------------------------------------------------------------- scope --- */
{
  const other = rule("allow", "rm -rf /tmp/x", { scope_session: "Odoo 19 VPS" });
  check("a rule scoped to another session does not apply to JOYA AI (phase 1)", bash("rm -rf /tmp/x", [other]).decision === "ask");
  const otherBox = rule("allow", "rm -rf /tmp/x", { scope_machine: "another-box" });
  check("a rule for another machine does not apply here", bash("rm -rf /tmp/x", [otherBox]).decision === "ask");
  const builtinRow = rule("allow", "rm -rf /tmp/x", { builtin: 1 });
  check("stored built-in rows are never matched as user rules", bash("rm -rf /tmp/x", [builtinRow]).decision === "ask");
}

/* ----------------------------------------------------------- suggestion --- */
{
  const sg = r.suggestion("Bash", { command: "  systemctl restart odoo  " });
  check("the suggestion is the exact command, scoped to JOYA AI on this VPS", sg.pattern === "systemctl restart odoo" && sg.scope_session === "joya-ai" && sg.scope_machine === "this" && sg.effect === "allow");
  check("the suggestion escapes stars", r.suggestion("Bash", { command: "rm /tmp/*.x" }).pattern === "rm /tmp/\\*.x");
  check("a suggested rule matches exactly the command it came from", bash("rm /tmp/*.x", [rule("allow", r.suggestion("Bash", { command: "rm /tmp/*.x" }).pattern)]).decision === "allow");
  check("no suggestion for tools rules do not cover", r.suggestion("Read", { file_path: "/x" }) === null);
  check("an allow covering a built-in is refused up front", throws(() => r.checkAllowable({ effect: "allow", pattern: "git push *" })));
  check("an exact allow is accepted", !throws(() => r.checkAllowable({ effect: "allow", pattern: "systemctl restart odoo" })));
check("an allow with a trailing * is accepted (the live-server ask still wins at run time)", !throws(() => r.checkAllowable({ effect: "allow", pattern: "rm /tmp/x-*" })));
check("the live-server built-in is worded without the host", !/gizaseeds|rpc\.py/.test(r.BUILTINS.find((b) => b.key === "ask-live-odoo").pattern + r.BUILTINS.find((b) => b.key === "ask-live-odoo").note));
  check("validateRule refuses a bad effect", throws(() => r.validateRule({ effect: "maybe", tool: "Bash", pattern: "x" })));
}

/* --------------------------------------------- the gate hook, for real --- */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-gate-"));
  const cfgFile = path.join(tmp, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ state_dir: tmp }));
  const gate = (tool_name, tool_input) => {
    const res = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(__dirname, "..", "hooks", "gate.js")], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, session_id: "s" }),
      env: { PATH: process.env.PATH, JOYA_AI_CONFIG: cfgFile },
      encoding: "utf8",
    });
    if (!res.stdout.trim()) return "none";
    return JSON.parse(res.stdout).hookSpecificOutput.permissionDecision;
  };
  check("gate, no ledger yet: built-in deny still holds", gate("Bash", { command: "git push --force" }) === "deny");
  check("gate, no ledger yet: the classifier still asks", gate("Bash", { command: "rm -rf /tmp/x" }) === "ask");
  check("gate, no ledger yet: harmless is silent", gate("Bash", { command: "ls" }) === "none");
  const ledger = new Ledger(path.join(tmp, "ledger.db"));
  const t = new Date().toISOString();
  ledger.db
    .prepare("INSERT INTO rules (effect, tool, pattern, builtin, scope_session, scope_machine, created_by, created_at, updated_at) VALUES (?, 'Bash', ?, 0, 'joya-ai', 'this', 'test', ?, ?)")
    .run("allow", "rm -rf /tmp/joya-gate-probe", t, t);
  ledger.db
    .prepare("INSERT INTO rules (effect, tool, pattern, builtin, scope_session, scope_machine, created_by, created_at, updated_at) VALUES (?, 'Bash', ?, 0, 'joya-ai', 'this', 'test', ?, ?)")
    .run("deny", "cat /etc/shadow*", t, t);
  check("gate reads an allow rule from the ledger", gate("Bash", { command: "rm -rf /tmp/joya-gate-probe" }) === "allow");
  check("gate reads a deny rule from the ledger", gate("Bash", { command: "cat /etc/shadow" }) === "deny");
  check("gate: the allow rule does not cover a longer command", gate("Bash", { command: "rm -rf /tmp/joya-gate-probe /etc" }) === "ask");
  check("gate: live Odoo asks even with rules loaded", gate("Bash", { command: "curl https://test.gizaseeds.cloud" }) === "ask");
  ledger.close();
  fs.writeFileSync(path.join(tmp, "ledger.db"), "this is not a database");
  for (const f of ["ledger.db-wal", "ledger.db-shm"]) fs.rmSync(path.join(tmp, f), { force: true });
  check("gate fails closed when the rules store is unreadable: asks", gate("Bash", { command: "ls" }) === "ask");
  check("gate fails closed: still denies what is denied", gate("Bash", { command: "git push -f" }) === "deny");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
