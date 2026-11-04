"""
Prove that what joya-helper writes for Telegram Topics is accepted by the REAL
agent runtime, and that the runtime really starts in topic mode on it.

    <runtime>/venv/bin/python -B topics-runtime-check.py <dir-holding-a-copy-of-src> <case.json>

Run by dashboard/tools/test-topics.cjs with a scratch COPY of the runtime's
src/ (never the installed tree: no __pycache__ lands in /opt) and the venv's
interpreter. case.json names an env file (the helper's own agent.env output)
and what to do:

  {"op": "registry", "projects": path, "approved": dir}
      load_project_registry() -> {"ok", "slugs"} or {"ok": false, "error"}
  {"op": "config", "env": path}
      load_config() with exactly that environment -> the topic settings
  {"op": "start", "env": path, "forum": bool, "seconds": n}
      run src.main against a FAKE Telegram Bot API on 127.0.0.1 (the token is
      fake too; nothing leaves the machine), stop it after "Starting bot" or
      when it exits, and return its log lines and exit code.

Prints one JSON object on the last line.
"""
import asyncio
import json
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

COPY, CASE = sys.argv[1], sys.argv[2]
case = json.load(open(CASE))
# The parent of the copied src/, never src/ itself: the runtime has a
# subpackage called mcp that would shadow the real mcp library. Placed first,
# so the copy wins over the identical src package installed in the venv.
sys.path.insert(0, COPY)
os.chdir(COPY)  # the loader looks for a .env in the working directory; there is none here


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k] = v
    return env


def apply_env(env):
    for k in list(os.environ):
        if k.startswith(("ENABLE_", "PROJECT", "TELEGRAM_", "APPROVED_", "CLAUDE_", "ANTHROPIC_")):
            del os.environ[k]
    os.environ.update(env)


def out(obj):
    sys.stdout.write("\n" + json.dumps(obj) + "\n")
    sys.stdout.flush()


op = case["op"]

if op == "registry":
    from pathlib import Path
    from src.projects.registry import load_project_registry
    try:
        reg = load_project_registry(Path(case["projects"]), Path(case["approved"]))
        out({"ok": True, "slugs": [p.slug for p in reg.list_enabled()],
             "paths": [str(p.absolute_path) for p in reg.projects]})
    except Exception as e:
        out({"ok": False, "error": str(e)})
    sys.exit(0)

if op == "config":
    apply_env(load_env(case["env"]))
    from src.config import load_config
    try:
        s = load_config()
        out({"ok": True, "enable_project_threads": s.enable_project_threads,
             "mode": s.project_threads_mode, "chat_id": s.project_threads_chat_id,
             "projects_config_path": str(s.projects_config_path) if s.projects_config_path else None})
    except Exception as e:
        out({"ok": False, "error": str(e)})
    sys.exit(0)

# ---------------------------------------------------------------- start ------
FORUM = bool(case.get("forum", True))
CALLS = []
TOPIC_ID = [100]


class FakeTelegram(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        try:
            params = json.loads(raw) if raw.startswith("{") else {k: v[0] for k, v in parse_qs(raw).items()}
        except ValueError:
            params = {}
        method = self.path.rsplit("/", 1)[-1]
        CALLS.append(method)
        ok, result, desc = True, True, ""
        if method == "getMe":
            result = {"id": 4242, "is_bot": True, "first_name": "Scratch", "username": "scratch_topics_bot",
                      "can_join_groups": True, "can_read_all_group_messages": False,
                      "supports_inline_queries": False}
        elif method == "getUpdates":
            import time
            time.sleep(min(float(params.get("timeout") or 0), 1.0))
            result = []
        elif method == "createForumTopic":
            if FORUM:
                TOPIC_ID[0] += 1
                result = {"message_thread_id": TOPIC_ID[0], "name": params.get("name", ""), "icon_color": 7322096}
            else:
                ok, desc = False, "Bad Request: the chat is not a forum"
        elif method == "getChat":
            result = {"id": int(params.get("chat_id", 0) or 0), "type": "supergroup", "title": "Scratch", "is_forum": FORUM}
        body = {"ok": True, "result": result} if ok else {"ok": False, "error_code": 400, "description": desc}
        data = json.dumps(body).encode()
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeTelegram)
threading.Thread(target=srv.serve_forever, daemon=True).start()
FAKE = "http://127.0.0.1:%d" % srv.server_address[1]

env = load_env(case["env"])
apply_env(env)

from telegram.ext import ApplicationBuilder  # noqa: E402

_orig_token = ApplicationBuilder.token


def _token(self, t):
    r = _orig_token(self, t)
    self.base_url(FAKE + "/bot")
    self.base_file_url(FAKE + "/file/bot")
    return r


ApplicationBuilder.token = _token

# Capture the runtime's own log lines (structlog JSON on stdout).
import io  # noqa: E402

LOG = io.StringIO()


class Tee(io.TextIOBase):
    def write(self, s):
        LOG.write(s)
        if "Starting bot" in s:
            # Started: give it a moment to begin polling, then stop it.
            threading.Timer(1.5, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
        return len(s)

    def flush(self):
        pass


real_stdout = sys.stdout
sys.stdout = Tee()
import logging  # noqa: E402

code = 0
try:
    from src import main as M
    threading.Timer(float(case.get("seconds", 30)), lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    sys.argv = ["claude-telegram-bot"]
    try:
        M.run()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
finally:
    logging.shutdown()
    sys.stdout = real_stdout
lines = [l for l in LOG.getvalue().splitlines() if l.strip()]
out({"code": code, "calls": CALLS, "lines": lines})
os._exit(0)
