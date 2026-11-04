#!/usr/bin/env python3
"""joya-helper: the agent avatar spec (2026-10-25, dashboard lib/agent-avatar.js).

agent.json is written as root, so validate_avatar accepts exactly the seven
keys with values from fixed lists; agent-avatar writes only that key (no
environment rewrite, no restart); agent-update keeps a stored avatar.
Run: python3 tools/test-agent-avatar-helper.py
"""
import importlib.machinery, importlib.util, io, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("helper", os.path.join(HERE, "..", "deploy", "joya-helper"))
spec = importlib.util.spec_from_loader("helper", loader)
h = importlib.util.module_from_spec(spec)
loader.exec_module(h)

passed = failed = 0
def check(name, cond, detail=""):
    global passed, failed
    passed += bool(cond); failed += not cond
    print(("ok   " if cond else "FAIL ") + name + (("  " + detail) if detail and not cond else ""))

class Failed(Exception):
    pass
def fake_fail(msg, code=2):
    raise Failed(msg)
h.fail = fake_fail

GOOD = {"v": 1, "theme": "mail", "head": "headset", "face": "minimal", "hue": "teal", "turn": "r", "seed": 694072099}

def refused(raw):
    try:
        h.validate_avatar(raw)
    except Failed:
        return True
    return False

check("a made spec is accepted as it is", h.validate_avatar(dict(GOOD)) == GOOD)
check("no avatar is None (optional)", h.validate_avatar(None) is None and h.validate_avatar("") is None)
for name, raw in (
    ("a string", json.dumps(GOOD)),
    ("a list", [GOOD]),
    ("an extra key", dict(GOOD, extra="x")),
    ("a missing key", {k: v for k, v in GOOD.items() if k != "seed"}),
    ("JOYA AI's cap", dict(GOOD, head="cap")),
    ("a path as a head", dict(GOOD, head="../../etc")),
    ("a colour value", dict(GOOD, hue="#00E6A5")),
    ("markup", dict(GOOD, face="<b>")),
    ("an unknown theme", dict(GOOD, theme="garden")),
    ("turn 'x'", dict(GOOD, turn="x")),
    ("version True", dict(GOOD, v=True)),
    ("version 1.0", dict(GOOD, v=1.0)),
    ("version 2", dict(GOOD, v=2)),
    ("seed as a string", dict(GOOD, seed="1")),
    ("seed True", dict(GOOD, seed=True)),
    ("a negative seed", dict(GOOD, seed=-1)),
    ("a seed too big", dict(GOOD, seed=2 ** 31)),
):
    check("refuses " + name, refused(raw))

# validate_config: the avatar rides along (create and update); a bad one refuses the save.
base = {"slug": "joya-pace", "name": "JOYA Pace", "role": "email", "model": "claude-opus-5-5"}
cfg = h.validate_config(dict(base, avatar=GOOD), creating=True)
check("validate_config keeps a good avatar", cfg.get("avatar") == GOOD)
check("validate_config without one has no avatar key", "avatar" not in h.validate_config(dict(base), creating=False))
try:
    h.validate_config(dict(base, avatar=dict(GOOD, head="cap")), creating=False)
    check("validate_config refuses a bad avatar", False)
except Failed:
    check("validate_config refuses a bad avatar", True)

# agent-avatar: only the avatar (and updated_at) change in agent.json; nothing restarts.
root = tempfile.mkdtemp()
h.AGENTS_DIR = root
h.agent_dir = lambda s: os.path.join(root, s)
os.makedirs(os.path.join(root, "joya-pace"))
before = {"slug": "joya-pace", "name": "JOYA Pace", "role": "email", "model": "claude-opus-5-5", "addon_env": {"API_SERVER_PORT": "8091"}, "created_at": "2026-10-25T08:00:00Z"}
with open(os.path.join(root, "joya-pace", "agent.json"), "w") as fh:
    json.dump(before, fh)
env_text = "ENABLE_API_SERVER=true\nAPI_SERVER_PORT=8091\n"
with open(os.path.join(root, "joya-pace", "agent.env"), "w") as fh:
    fh.write(env_text)
calls = []
h.run = lambda argv, **kw: calls.append(argv)
h.agent_ids = lambda: (os.getuid(), os.getgid())
h.audit = lambda *a, **k: None
out = {}
h.ok = lambda data: out.update(data) or (_ for _ in ()).throw(SystemExit(0))
h.read_stdin_json = lambda: {"slug": "joya-pace", "avatar": GOOD}
try:
    h.cmd_agent_avatar([])
except SystemExit:
    pass
after = json.load(open(os.path.join(root, "joya-pace", "agent.json")))
check("agent-avatar stores the avatar", after.get("avatar") == GOOD)
check("agent-avatar leaves every other key as it was", {k: v for k, v in after.items() if k not in ("avatar", "updated_at")} == before)
check("agent-avatar does not touch agent.env (the port stays 8091)", open(os.path.join(root, "joya-pace", "agent.env")).read() == env_text)
check("agent-avatar restarts nothing (no systemctl)", not any("systemctl" in " ".join(c) for c in calls))
h.read_stdin_json = lambda: {"slug": "joya-pace", "avatar": dict(GOOD, hue="red")}
try:
    h.cmd_agent_avatar([])
    check("agent-avatar refuses a bad spec", False)
except Failed:
    check("agent-avatar refuses a bad spec", json.load(open(os.path.join(root, "joya-pace", "agent.json"))).get("avatar") == GOOD)
h.read_stdin_json = lambda: {"slug": "joya-pace"}
try:
    h.cmd_agent_avatar([])
    check("agent-avatar needs an avatar", False)
except Failed:
    check("agent-avatar needs an avatar", True)
check("agent-avatar is a helper subcommand", h.COMMANDS.get("agent-avatar") is h.cmd_agent_avatar)

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
