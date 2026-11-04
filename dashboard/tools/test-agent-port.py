#!/usr/bin/env python3
"""joya-helper assign_api_port: two agents never share a webhook API port.

Regression for 2026-10-25: saving JOYA Pace in the panel wrote the catalogue
default 8080 over its hand-set 8091, mavix-bot already had 8080, and JOYA Pace
crashed at every start. Run: python3 tools/test-agent-port.py
"""
import importlib.machinery, importlib.util, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("helper", os.path.join(HERE, "..", "deploy", "joya-helper"))
spec = importlib.util.spec_from_loader("helper", loader)
h = importlib.util.module_from_spec(spec)
loader.exec_module(h)

root = tempfile.mkdtemp()
h.AGENTS_DIR = root
h.agent_dir = lambda s: os.path.join(root, s)
for slug, env in (("mavix-bot", "ENABLE_API_SERVER=true\nAPI_SERVER_PORT=8080\n"),
                  ("joya-pace", "ENABLE_API_SERVER=true\nAPI_SERVER_PORT=8091\n"),
                  ("quiet", "ENABLE_API_SERVER=false\nAPI_SERVER_PORT=8082\n")):
    os.makedirs(os.path.join(root, slug))
    with open(os.path.join(root, slug, "agent.env"), "w") as fh:
        fh.write(env)

passed = failed = 0
def check(name, slug, port, want_port, want_moved, on="true"):
    global passed, failed
    cfg = {"addon_env": {"ENABLE_API_SERVER": on, "API_SERVER_PORT": port}}
    moved = h.assign_api_port(slug, cfg)
    got = cfg["addon_env"]["API_SERVER_PORT"]
    ok = got == want_port and bool(moved) == want_moved
    passed += ok; failed += not ok
    print(("ok   " if ok else "FAIL ") + name + f" -> {got} moved={moved}")

check("an agent keeps its own port", "mavix-bot", "8080", "8080", False)
check("a save offering the default keeps the agent's current free port", "joya-pace", "8080", "8091", True)
check("a new agent asking for a taken port gets the first free one", "newbie", "8080", "8081", True)
check("a port held only by an agent with the API off is free", "newbie", "8082", "8082", False)
check("a free port asked for is kept", "newbie", "9000", "9000", False)
check("nothing changes when the API is off", "newbie", "8080", "8080", False, on="false")

# chown_tree keeps scripts executable (JOYA Pace's watcher, same day).
tree = os.path.join(root, "joya-pace", "pace")
os.makedirs(tree)
script, data = os.path.join(tree, "outlook"), os.path.join(tree, "token.json")
for path, mode in ((script, 0o755), (data, 0o644)):
    open(path, "w").close(); os.chmod(path, mode)
h.os.chown = lambda *a, **k: None   # not root in tests
h.chown_tree(os.path.join(root, "joya-pace"), 0, 0)
for name, path, want in (("a script stays executable", script, 0o770),
                         ("a data file is not made executable", data, 0o660)):
    got = os.stat(path).st_mode & 0o777
    ok = got == want
    passed += ok; failed += not ok
    print(("ok   " if ok else "FAIL ") + name + f" -> {oct(got)}")

# A save keeps settings added to agent.env by hand (JOYA Pace's webhook
# secret, same day); keys the panel writes and protected keys are not kept.
env_path = os.path.join(root, "joya-pace", "agent.env")
with open(env_path, "w") as fh:
    fh.write("API_SERVER_PORT=8091\nWEBHOOK_API_SECRET=s3cret\nNOTIFICATION_CHAT_IDS=1\n"
             "TELEGRAM_BOT_TOKEN=old\n# comment\n")
extra = h.kept_env_lines(env_path, "API_SERVER_PORT=8080\nTELEGRAM_BOT_TOKEN=new\n")
kept = h.read_env_text(extra)
for name, ok in (("a hand-added secret is kept", kept.get("WEBHOOK_API_SECRET") == "s3cret"),
                 ("a hand-added chat id is kept", kept.get("NOTIFICATION_CHAT_IDS") == "1"),
                 ("a key the panel writes is not duplicated", "API_SERVER_PORT" not in kept),
                 ("a protected key is never carried over", "TELEGRAM_BOT_TOKEN" not in kept),
                 ("nothing to keep gives nothing", h.kept_env_lines(env_path, open(env_path).read()) == "")):
    passed += ok; failed += not ok
    print(("ok   " if ok else "FAIL ") + name)
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
