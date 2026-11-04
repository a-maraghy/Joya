"""
End to end: the REAL agent runtime against a FAKE Telegram Bot API on
127.0.0.1 (fake token, nothing leaves the machine) and a fake Claude, for the
three per-agent options added for mavix-bot:

  * General topic -> a project       (PROJECT_THREADS_GENERAL_PROJECT)
  * respond only when asked          (GROUP_RESPOND_MODE=mention, BOT_NAME_ALIASES)
  * new topics get their own folder  (PROJECT_THREADS_AUTO_MAP), and a deleted
    topic's folder goes to the trash (probe: editForumTopic -> TOPIC_ID_INVALID)

    <runtime venv python> -B topics-respond-check.py <dir-holding-a-copy-of-src> <case.json>

case.json: {"env": path-to-agent.env, "vault": dir, "auto_file": path, "seconds": n}

The bot is fed, in order, through getUpdates:
  1. General, not addressed                      -> must stay silent
  2. General, "@<bot> hello general"             -> answered, Claude runs in the General project
  3. a new topic "Client X" (forum_topic_created) -> folder topics/client-x, one "Linked to folder" line
  4. in that topic, "Mavix, list the files"       -> answered, Claude runs in topics/client-x, name stripped
  5. in that topic, not addressed                 -> silent
Then the topic is "deleted" (the fake answers TOPIC_ID_INVALID) and the probe
must move the folder to .trash/topics/ after two checks.

Prints one JSON object on the last line: what Telegram was sent, what Claude
was asked and where, and the auto file at the end.
"""
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

COPY, CASE = sys.argv[1], sys.argv[2]
case = json.load(open(CASE))
sys.path.insert(0, COPY)
os.chdir(COPY)

CHAT = int(case.get("chat_id", -1001234567890))
ADMIN = int(case.get("admin_id", 111))
BOT_ID = 4242
BOT_USERNAME = case.get("bot_username", "scratch_topics_bot")
NOW = int(time.time())


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k] = v
    return env


def out(obj):
    sys.stdout.write("\n" + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


FORUM_CHAT = {"id": CHAT, "type": "supergroup", "title": "Scratch", "is_forum": True}
ADMIN_USER = {"id": ADMIN, "is_bot": False, "first_name": "Admin"}
BOT_USER = {"id": BOT_ID, "is_bot": True, "first_name": "Scratch", "username": BOT_USERNAME}
ROOT_300 = {"message_id": 300, "date": NOW, "chat": FORUM_CHAT, "from": ADMIN_USER,
            "message_thread_id": 300, "is_topic_message": True,
            "forum_topic_created": {"name": "Client X", "icon_color": 7322096}}


def m(mid, **kw):
    msg = {"message_id": mid, "date": NOW, "chat": FORUM_CHAT, "from": ADMIN_USER}
    msg.update(kw)
    return msg


def topic(mid, text):
    return m(mid, text=text, message_thread_id=300, is_topic_message=True, reply_to_message=ROOT_300)


STEPS = [
    ("general-unaddressed", m(10, text="lunch at 2?")),
    ("general-mention", m(11, text="@" + BOT_USERNAME + " hello general")),
    ("topic-created", ROOT_300),
    ("topic-name", topic(301, "Mavix, list the files")),
    ("topic-unaddressed", topic(302, "just chatting here")),
]

STATE = {"next": 0, "update_id": 0, "deleted": set(), "sent": [], "calls": [], "mid": 5000,
         "step_of_send": [], "current": None, "probes": []}
LOCK = threading.Lock()


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
        ok, result, desc = True, True, ""
        with LOCK:
            STATE["calls"].append(method)
        if method == "getMe":
            result = dict(BOT_USER, can_join_groups=True, can_read_all_group_messages=True,
                          supports_inline_queries=False)
        elif method == "getUpdates":
            time.sleep(0.4)
            with LOCK:
                result = []
                started = STATE.get("started")
                # One update per poll, each after the previous one was handled.
                if started and STATE["next"] < len(STEPS) and time.time() >= STATE.get("not_before", 0):
                    name, msg = STEPS[STATE["next"]]
                    STATE["next"] += 1
                    STATE["update_id"] += 1
                    STATE["current"] = name
                    STATE["not_before"] = time.time() + 2.5
                    result = [{"update_id": STATE["update_id"], "message": msg}]
        elif method == "createForumTopic":
            with LOCK:
                STATE["mid"] += 1
                result = {"message_thread_id": STATE["mid"], "name": params.get("name", ""), "icon_color": 7322096}
        elif method == "editForumTopic":
            tid = int(params.get("message_thread_id") or 0)
            with LOCK:
                STATE["probes"].append(tid)
                gone = tid in STATE["deleted"]
            ok, desc = False, ("Bad Request: TOPIC_ID_INVALID" if gone else "Bad Request: TOPIC_NOT_MODIFIED")
        elif method in ("sendMessage", "editMessageText", "sendPhoto"):
            with LOCK:
                STATE["mid"] += 1
                mid = STATE["mid"]
                if method == "sendMessage":
                    STATE["sent"].append({"step": STATE["current"], "text": params.get("text", ""),
                                          "thread": params.get("message_thread_id")})
            result = {"message_id": mid, "date": NOW, "chat": FORUM_CHAT, "from": BOT_USER,
                      "text": params.get("text", "")}
        elif method == "getChat":
            result = FORUM_CHAT
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

for k in list(os.environ):
    if k.startswith(("ENABLE_", "PROJECT", "TELEGRAM_", "APPROVED_", "CLAUDE_", "ANTHROPIC_", "GROUP_", "BOT_")):
        del os.environ[k]
os.environ.update(load_env(case["env"]))

from telegram.ext import ApplicationBuilder  # noqa: E402

_orig_token = ApplicationBuilder.token


def _token(self, t):
    r = _orig_token(self, t)
    self.base_url(FAKE + "/bot")
    self.base_file_url(FAKE + "/file/bot")
    return r


ApplicationBuilder.token = _token

# Fake Claude: record what it was asked and where, answer at once.
ASKED = []
from src.claude import facade as F  # noqa: E402
from src.claude.sdk_integration import ClaudeResponse  # noqa: E402


async def fake_run_command(self, prompt, working_directory, user_id, session_id=None, on_stream=None,
                           force_new=False, interrupt_event=None, images=None, **_later):
    # **_later: arguments newer runtimes pass (file_sender=...), not used here.
    with LOCK:
        ASKED.append({"step": STATE["current"], "prompt": prompt, "cwd": str(working_directory),
                      "force_new": force_new, "session_in": session_id})
        n = len(ASKED)
    return ClaudeResponse(content="FAKE-ANSWER " + prompt, session_id="fake-session-%d" % n, cost=0.0,
                          duration_ms=1, num_turns=1)


F.ClaudeIntegration.run_command = fake_run_command

import io  # noqa: E402

LOG = io.StringIO()
AUTO = case["auto_file"]


def watcher():
    # After the last step was handled, "delete" the topic and wait for the trash.
    deadline = time.time() + float(case.get("seconds", 60))
    deleted_at = None
    while time.time() < deadline:
        time.sleep(0.5)
        with LOCK:
            done = STATE["next"] >= len(STEPS) and time.time() >= STATE.get("not_before", 0)
        if done and deleted_at is None:
            with LOCK:
                STATE["deleted"].add(300)
                STATE["current"] = "topic-deleted"
            deleted_at = time.time()
        if deleted_at is not None:
            try:
                data = json.load(open(AUTO))
            except Exception:
                data = {}
            if data.get("trash"):
                STATE["trash_after_s"] = round(time.time() - deleted_at, 1)
                time.sleep(0.5)
                break
    os.kill(os.getpid(), signal.SIGTERM)


class Tee(io.TextIOBase):
    def write(self, s):
        LOG.write(s)
        if "Starting bot" in s and not STATE.get("started"):
            STATE["started"] = True
            threading.Thread(target=watcher, daemon=True).start()
        return len(s)

    def flush(self):
        pass


real_stdout = sys.stdout
sys.stdout = Tee()
import logging  # noqa: E402

code = 0
try:
    from src import main as M
    threading.Timer(float(case.get("seconds", 60)) + 15, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    sys.argv = ["claude-telegram-bot", "--debug"] if case.get("debug") else ["claude-telegram-bot"]
    try:
        M.run()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
finally:
    logging.shutdown()
    sys.stdout = real_stdout
try:
    auto = json.load(open(AUTO))
except Exception:
    auto = None
lines = [l for l in LOG.getvalue().splitlines() if l.strip()]
out({"code": code, "sent": STATE["sent"], "asked": ASKED, "auto": auto, "probes": STATE["probes"],
     "trash_after_s": STATE.get("trash_after_s"), "steps_delivered": STATE["next"],
     "calls": sorted(set(STATE["calls"])), "log_tail": lines[-40:]})
os._exit(0)
