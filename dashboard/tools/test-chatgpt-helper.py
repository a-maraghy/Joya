#!/usr/bin/env python3
"""joya-helper, JOYA AI Settings > ChatGPT: chatgpt-status / -calls / -login-* and agent-chatgpt.

No root, no broker, no Codex: the helper is loaded as a module and its pieces are
tested with fakes. Run: python3 tools/test-chatgpt-helper.py
"""
import importlib.machinery, importlib.util, io, json, os, sys, tempfile, contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("helper", os.path.join(HERE, "..", "deploy", "joya-helper"))
spec = importlib.util.spec_from_loader("helper", loader)
h = importlib.util.module_from_spec(spec)
loader.exec_module(h)

passed = failed = 0
def check(name, cond, detail=""):
    global passed, failed
    passed += bool(cond); failed += not cond
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(detail)[:300]))

def run_cmd(fn, args):
    """A cmd_* prints one JSON line and exits; return it."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            fn(args)
        except SystemExit:
            pass
    return json.loads(buf.getvalue().strip().splitlines()[-1])

print("login status, in words")
check("`Logged in using ChatGPT` is signed in", h.chatgpt_login_state("Logged in using ChatGPT", 0) == "signed_in")
check("`Not logged in` is signed out", h.chatgpt_login_state("Not logged in", 1) == "signed_out")
check("a refresh failure is expired", h.chatgpt_login_state("Error: your refresh token has expired; please log in again", 1) == "expired")
check("the account type comes from the CLI's own words", h.chatgpt_account("Logged in using ChatGPT") == "ChatGPT account" and h.chatgpt_account("Logged in using an API key - sk-***") == "API key" and h.chatgpt_account("Not logged in") is None)
tok = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"
check("a token that strays into CLI text never leaves", tok not in h.chatgpt_clean("error " + tok) and "[…]" in h.chatgpt_clean("error " + tok))
check("terminal escapes are stripped", h.chatgpt_clean("\x1b[32mLogged in\x1b[0m") == "Logged in")

print("the device-code prompt")
out = "Welcome to Codex\n\nFollow these steps to sign in:\n1. Open this link in your browser\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code \x1b[94mK3PQ-7ZB2X\x1b[0m\n(expires in 15 minutes)\n"
url, code = h.chatgpt_device_prompt(h.ANSI_RE.sub("", out))
check("the link and the code are read off the CLI's output", url == "https://auth.openai.com/codex/device" and code == "K3PQ-7ZB2X", (url, code))
raw = "2. Enter this one-time code (expires in 15 minutes)\n   \x1b[94mGIDR-0IKNI\x1b[0m\n"  # as the real CLI 0.164.0 printed it
check("a coloured code straight from the CLI is read", h.chatgpt_device_prompt(raw)[1] == "GIDR-0IKNI")
check("a link to anywhere but OpenAI is not offered", h.chatgpt_device_prompt("open https://evil.example/x code ABCD-12345")[0] is None)

print("the call log")
d = tempfile.mkdtemp()
log = os.path.join(d, "calls.jsonl")
with open(log, "w") as fh:
    for i in range(5):
        fh.write(json.dumps({"ts": "2026-10-25T10:0%d:00+00:00" % i, "event": "call", "op": "ask", "caller": "agent:a%d" % i, "user": "joyaagent", "pid": 1,
                             "task": "SECRET TASK TEXT", "answer": "SECRET ANSWER", "task_chars": 10, "answer_chars": 5,
                             "ok": i != 3, "kind": "timeout" if i == 3 else None, "error": ("took too long " + tok) if i == 3 else None,
                             "seconds": 1.5 * i, "out_files": i, "in_files": 0, "model": "default"}) + "\n")
    fh.write("not json\n")
    fh.write(json.dumps({"ts": "x", "event": "call", "op": "status", "ok": False}) + "\n")
calls = h.chatgpt_calls(log, 3)
check("newest first, at most N", [c["caller"] for c in calls] == ["agent:a4", "agent:a3", "agent:a2"], calls)
check("only whitelisted fields leave (no task text, no answer, no pid or account)", all(set(c) == set(h.CHATGPT_CALL_FIELDS) | {"error"} for c in calls) and "SECRET" not in json.dumps(calls))
check("a failure carries its short error, cleaned of tokens", calls[1]["ok"] is False and calls[1]["error"].startswith("took too long") and tok not in calls[1]["error"])
check("a success has no error", calls[0]["error"] is None and calls[0]["out_files"] == 4)
check("status probes are not calls", all(c["ts"] != "x" for c in h.chatgpt_calls(log, 50)))
check("a missing log is no calls", h.chatgpt_calls(os.path.join(d, "none.jsonl"), 5) == [])

print("the limits")
h.CHATGPT_CONFIG = os.path.join(d, "config.json")
with open(h.CHATGPT_CONFIG, "w") as fh:
    json.dump({"max_running": 3, "max_queued": "lots", "timeout_s": 300}, fh)
cfg = h.chatgpt_config()
check("read from the broker's config, bad values fall back", cfg == {"max_running": 3, "max_queued": 8, "timeout_s": 300}, cfg)

print("chatgpt-status, the broker answering")
h.run = lambda argv, **k: type("R", (), {"stdout": "active\n", "stderr": "", "returncode": 0})()
h.chatgpt_broker_status = lambda timeout=40: {"ok": True, "logged_in": True, "login_status": "Logged in using ChatGPT", "running": 1, "queued": 0, "max_running": 2, "max_queued": 8, "timeout_s": 600}
h.CHATGPT_LOGIN_DIR = os.path.join(d, "login")
r = run_cmd(h.cmd_chatgpt_status, [])
check("running, signed in with a ChatGPT account, 1 running of 2", r["ok"] and r["data"]["service"] == "active" and r["data"]["login"] == "signed_in" and r["data"]["account"] == "ChatGPT account" and r["data"]["running"] == 1 and r["data"]["max_queued"] == 8, r)
check("  no auth.json or token anywhere in it", "auth.json" not in json.dumps(r) and "token" not in json.dumps(r).lower().replace("login", ""))

print("chatgpt-login-poll")
r = run_cmd(h.cmd_chatgpt_login_poll, ["../../etc"])
check("an id that is not 16 hex is refused", r["ok"] is False)
os.makedirs(h.CHATGPT_LOGIN_DIR, exist_ok=True)
lid = "0123456789abcdef"
with open(os.path.join(h.CHATGPT_LOGIN_DIR, lid + ".json"), "w") as fh:
    json.dump({"pid": os.getpid(), "started": __import__("time").time()}, fh)
with open(os.path.join(h.CHATGPT_LOGIN_DIR, lid + ".out"), "w") as fh:
    fh.write(out)
r = run_cmd(h.cmd_chatgpt_login_poll, [lid])
check("while the CLI waits: pending, with the link and the code", r["data"]["state"] == "pending" and r["data"]["code"] == "K3PQ-7ZB2X", r)
check("  the waiting sign-in is the current one", h.chatgpt_login_current() == lid)
with open(os.path.join(h.CHATGPT_LOGIN_DIR, lid + ".json"), "w") as fh:
    json.dump({"pid": 999999999, "started": __import__("time").time()}, fh)
h.chatgpt_codex_status = lambda: ("signed_in", "ChatGPT account", "Logged in using ChatGPT")
h.audit = lambda *a, **k: None
r = run_cmd(h.cmd_chatgpt_login_poll, [lid])
check("when the CLI has finished and the sign-in is valid: done", r["data"]["state"] == "done" and r["data"]["login"] == "signed_in", r)
h.chatgpt_codex_status = lambda: ("signed_out", None, "Not logged in")
r = run_cmd(h.cmd_chatgpt_login_poll, [lid])
check("when it finished without a valid sign-in: failed", r["data"]["state"] == "failed", r)

with open(os.path.join(h.CHATGPT_LOGIN_DIR, lid + ".json"), "w") as fh:
    json.dump({"pid": 999999999, "started": __import__("time").time()}, fh)
r = run_cmd(h.cmd_chatgpt_login_cancel, [lid])
check("cancel answers for a finished sign-in too, and marks it cancelled", r["ok"] and r["data"]["cancelled"] and json.load(open(os.path.join(h.CHATGPT_LOGIN_DIR, lid + ".json")))["reported"] == "cancelled")
check("cancel refuses an id that is not 16 hex", run_cmd(h.cmd_chatgpt_login_cancel, ["x;rm"])["ok"] is False)

print("the per-agent switch (ALLOW_CHATGPT)")
base = h.validate_config({"slug": "odoo-dev", "name": "Odoo Dev"}, creating=False)
check("on by default", base["chatgpt"] is True)
check("off when switched off", h.validate_config({"slug": "odoo-dev", "chatgpt": False}, creating=False)["chatgpt"] is False)
root = tempfile.mkdtemp()
h.AGENTS_DIR = root
h.agent_dir = lambda s: os.path.join(root, s)
os.makedirs(os.path.join(root, "odoo-dev"))
h.topic_plan = lambda cfg, channel=None: {"enabled": False}
env_on = h.render_env(base, None, {"enabled": False})
env_off = h.render_env(dict(base, chatgpt=False), None, {"enabled": False})
check("rendered by the panel: ALLOW_CHATGPT=true / false", "\nALLOW_CHATGPT=true\n" in env_on and "\nALLOW_CHATGPT=false\n" in env_off)
p = os.path.join(root, "odoo-dev", "agent.env")
with open(p, "w") as fh:
    fh.write("ALLOW_CHATGPT=false\nWEBHOOK_API_SECRET=abc\n")
kept = h.kept_env_lines(p, env_on)
check("a hand-set ALLOW_CHATGPT is no longer kept over the panel's value (it is managed now)", "ALLOW_CHATGPT" not in kept and "WEBHOOK_API_SECRET=abc" in kept, kept)
check("an agent saved before the switch keeps what its environment said", h.chatgpt_seed("odoo-dev") is False)
os.unlink(p)
check("  and is on when its environment said nothing", h.chatgpt_seed("odoo-dev") is True)

calls_made = []
h.check_slug = lambda s: s
h.existing_agent = lambda s: None
h.read_agent_json = lambda s: {"slug": s, "name": "Odoo Dev", "created_at": "2026-10-01"}
h.agent_ids = lambda: (0, 0)
h.channel_bound_to = lambda s: None
h.write_agent_files = lambda cfg, uid, gid, ch=None: calls_made.append(("files", cfg["chatgpt"])) or {"enabled": False}
h.write_agent_json = lambda s, meta, uid, gid: calls_made.append(("json", meta["chatgpt"]))
h.chown_tree = lambda *a, **k: None
h.seal_agent_files = lambda *a, **k: None
h.unit_state = lambda s: {"active": "active"}
h.run = lambda *a, **k: calls_made.append(("run", a)) or type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
r = run_cmd(h.cmd_agent_chatgpt, ["odoo-dev", "off"])
check("agent-chatgpt off writes the switch to agent.json and re-renders agent.env", r["ok"] and r["data"]["chatgpt"] is False and ("files", False) in calls_made and ("json", False) in calls_made, (r, calls_made))
check("  it does not restart the agent; it says a restart is needed", r["data"]["restart_needed"] is True and not any(c[0] == "run" and "restart" in str(c) for c in calls_made))
r = run_cmd(h.cmd_agent_chatgpt, ["odoo-dev", "maybe"])
check("anything but on / off is refused", r["ok"] is False)
check("the six subcommands are registered", all(k in h.COMMANDS for k in ("chatgpt-status", "chatgpt-calls", "chatgpt-login-start", "chatgpt-login-poll", "chatgpt-login-cancel", "agent-chatgpt")))

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
