"""
End to end: the REAL agent runtime (bot, orchestrator, facade, Claude Agent
SDK, send_file server) against a FAKE Telegram Bot API on 127.0.0.1 (fake
token, nothing leaves the machine) and a FAKE Claude Code CLI
(fake-claude-files.py, which writes real .docx/.xlsx/.pdf files and calls
send_file over the SDK's control protocol).

    <python> -B file-send-check.py <dir-holding-a-copy-of-src> <case.json>

case.json: {"env": agent.env path, "steps": "on" | "off", "out": dir for received
documents, "claude_log": path, "seconds": n}

"on" feeds, through getUpdates, one at a time (each after Claude finished the last):
  1. topic "Client X" is created           -> its own folder topics/client-x
  2. in it, "Mavix, make the reports"       -> report.docx, data.xlsx, arabic.pdf into topic 300
  3. General, "@<bot> make a csv"           -> summary.csv into General (no thread id)
  4. in the topic, "Mavix, try to escape"   -> only 5 small notes go out; outside/symlink/.sh refused
  5. in the topic, not addressed            -> nothing
"off" feeds only step 3 (with ALLOW_FILE_SEND=false the tool must not exist).

"draw" (pictures drawn in code, test-drawing.cjs):
  1. topic "Client X" is created
  2. in it, "Mavix, draw the logo"   -> render_svg x2 (images back to Claude), a contact
                                       sheet sent as a photo, the SVG + a PNG preview, all in topic 300
  3. General, "@<bot> draw something evil" -> unsafe SVGs refused, nothing sent
  4. in the topic, not addressed     -> nothing
"drawoff" feeds only "@<bot> draw the logo" with ALLOW_DRAWING=false.

Prints one JSON object on the last line.
"""
import json
import os
import signal
import sys
import threading
import time
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

COPY, CASE = sys.argv[1], sys.argv[2]
case = json.load(open(CASE))
sys.path.insert(0, COPY)
os.chdir(COPY)

CHAT = int(case.get("chat_id", -1001234567890))
ADMIN = int(case.get("admin_id", 111))
BOT_ID = 4242
BOT_USERNAME = case.get("bot_username", "scratch_files_bot")
NOW = int(time.time())
OUT = case["out"]
CLAUDE_LOG = case["claude_log"]
os.makedirs(OUT, exist_ok=True)


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


# (name, message, how many Claude runs must have finished before it is delivered)
ALL_STEPS = {
    "on": [
        ("topic-created", ROOT_300, 0),
        ("topic-reports", topic(301, "Mavix, make the reports"), 0),
        ("general-csv", m(12, text="@" + BOT_USERNAME + " make a csv"), 1),
        ("topic-escape", topic(302, "Mavix, try to escape"), 2),
        ("topic-unaddressed", topic(303, "just chatting here"), 3),
    ],
    "off": [
        ("general-csv", m(12, text="@" + BOT_USERNAME + " make a csv"), 0),
    ],
    "draw": [
        ("topic-created", ROOT_300, 0),
        ("topic-draw", topic(311, "Mavix, draw the logo"), 0),
        ("general-evil", m(13, text="@" + BOT_USERNAME + " draw something evil"), 1),
        ("topic-unaddressed", topic(312, "nice colours"), 2),
    ],
    "drawoff": [
        ("general-draw", m(14, text="@" + BOT_USERNAME + " draw the logo"), 0),
    ],
}
STEPS = ALL_STEPS[case.get("steps", "on")]
EXPECT_RUNS = {"on": 3, "off": 1, "draw": 2, "drawoff": 1}[case.get("steps", "on")]

STATE = {"next": 0, "update_id": 0, "sent": [], "docs": [], "calls": [], "mid": 5000, "current": None}
LOCK = threading.Lock()


def claude_runs():
    try:
        with open(CLAUDE_LOG, encoding="utf-8") as fh:
            return sum(1 for line in fh if line.strip())
    except FileNotFoundError:
        return 0


def parse_multipart(headers, raw):
    msg = BytesParser(policy=HTTP).parsebytes(
        b"Content-Type: " + headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
    fields, files = {}, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True)
        if filename is not None:
            files[name] = (filename, payload)
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


class FakeTelegram(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        ctype = self.headers.get("Content-Type", "")
        files = {}
        if ctype.startswith("multipart/form-data"):
            params, files = parse_multipart(self.headers, raw)
        else:
            text = raw.decode("utf-8", "replace")
            try:
                params = json.loads(text) if text.startswith("{") else {k: v[0] for k, v in parse_qs(text).items()}
            except ValueError:
                params = {}
        method = self.path.rsplit("/", 1)[-1]
        ok, result = True, True
        with LOCK:
            STATE["calls"].append(method)
        if method == "getMe":
            result = dict(BOT_USER, can_join_groups=True, can_read_all_group_messages=True,
                          supports_inline_queries=False)
        elif method == "getUpdates":
            time.sleep(0.3)
            with LOCK:
                result = []
                if (STATE.get("started") and STATE["next"] < len(STEPS)
                        and time.time() >= STATE.get("not_before", 0)
                        and claude_runs() >= STATE.get("need_runs", 0)):
                    name, msg, _ = STEPS[STATE["next"]]
                    STATE["next"] += 1
                    STATE["update_id"] += 1
                    STATE["current"] = name
                    STATE["not_before"] = time.time() + 1.5
                    # the next step waits for this many finished Claude runs
                    nxt = STEPS[STATE["next"]][2] if STATE["next"] < len(STEPS) else len(STEPS)
                    STATE["need_runs"] = nxt
                    result = [{"update_id": STATE["update_id"], "message": msg}]
        elif method == "createForumTopic":
            with LOCK:
                STATE["mid"] += 1
                result = {"message_thread_id": STATE["mid"], "name": params.get("name", ""), "icon_color": 7322096}
        elif method == "editForumTopic":
            ok = False
        elif method == "getChat":
            result = FORUM_CHAT
        elif method in ("sendMessage", "editMessageText", "sendDocument", "sendPhoto"):
            with LOCK:
                STATE["mid"] += 1
                mid = STATE["mid"]
                rec = {"step": STATE["current"], "chat": params.get("chat_id"),
                       "thread": params.get("message_thread_id")}
                if method == "sendMessage":
                    rec["text"] = params.get("text", "")
                    STATE["sent"].append(rec)
                elif method in ("sendDocument", "sendPhoto"):
                    field = "document" if method == "sendDocument" else "photo"
                    fname, data = files.get(field, (None, b""))
                    rec["kind"] = field
                    rec.update(filename=fname, caption=params.get("caption"), size=len(data),
                               reply_to=params.get("reply_parameters") or params.get("reply_to_message_id"))
                    if fname:
                        idx = len(STATE["docs"])
                        path = os.path.join(OUT, "%02d-%s" % (idx, os.path.basename(fname)))
                        with open(path, "wb") as fh:
                            fh.write(data)
                        rec["saved"] = path
                    STATE["docs"].append(rec)
            result = {"message_id": mid, "date": NOW, "chat": FORUM_CHAT, "from": BOT_USER,
                      "text": params.get("text", "")}
            if method == "sendDocument":
                result["document"] = {"file_id": "f%d" % mid, "file_unique_id": "u%d" % mid}
            if method == "sendPhoto":
                result["photo"] = [{"file_id": "p%d" % mid, "file_unique_id": "q%d" % mid,
                                    "width": 1, "height": 1}]
        body = {"ok": True, "result": result} if ok else {
            "ok": False, "error_code": 400, "description": "Bad Request: TOPIC_NOT_MODIFIED"}
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
    if k.startswith(("ENABLE_", "PROJECT", "TELEGRAM_", "APPROVED_", "CLAUDE_", "ANTHROPIC_", "GROUP_", "BOT_",
                     "ALLOW_FILE", "FILE_SEND", "MCP_", "ALLOW_DRAW", "DRAW_", "SVG_")):
        del os.environ[k]
os.environ.update(load_env(case["env"]))
os.environ["FAKE_CLAUDE_LOG"] = CLAUDE_LOG

from telegram.ext import ApplicationBuilder  # noqa: E402

_orig_token = ApplicationBuilder.token


def _token(self, t):
    r = _orig_token(self, t)
    self.base_url(FAKE + "/bot")
    self.base_file_url(FAKE + "/file/bot")
    return r


ApplicationBuilder.token = _token

import io  # noqa: E402

LOG = io.StringIO()


def watcher():
    deadline = time.time() + float(case.get("seconds", 90))
    while time.time() < deadline:
        time.sleep(0.5)
        with LOCK:
            done = STATE["next"] >= len(STEPS) and time.time() >= STATE.get("not_before", 0) + 1.5
        if done and claude_runs() >= EXPECT_RUNS:
            time.sleep(1.0)
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
    threading.Timer(float(case.get("seconds", 90)) + 20, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    sys.argv = ["claude-telegram-bot"]
    try:
        M.run()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
finally:
    logging.shutdown()
    sys.stdout = real_stdout

runs = []
try:
    with open(CLAUDE_LOG, encoding="utf-8") as fh:
        runs = [json.loads(line) for line in fh if line.strip()]
except FileNotFoundError:
    pass
lines = [l for l in LOG.getvalue().splitlines() if l.strip()]
out({"code": code, "sent": STATE["sent"], "docs": STATE["docs"], "runs": runs,
     "steps_delivered": STATE["next"], "calls": sorted(set(STATE["calls"])), "log_tail": lines[-40:]})
os._exit(0)
