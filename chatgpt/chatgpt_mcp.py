#!/usr/bin/env python3
"""ask_chatgpt: a stdio MCP server that hands a task to ChatGPT via the joya-chatgpt broker.

Loaded by every agent kind on this server (the Telegram agents' runtime, JOYA AI,
its hired sessions and the dashboard console). Standard library only, so it runs
under any python3 and needs nothing installed into an agent's venv.

It runs as the calling agent's own account and inside its sandbox, so:
  - context files are read with the agent's own rights, and, when
    JOYA_CHATGPT_FILES_ROOT is set (Telegram agents: their vault), only from there;
  - files ChatGPT made are written to JOYA_CHATGPT_OUT/<task id>/ (default
    $HOME/chatgpt), where the agent can read them and send them on.

Environment:
  JOYA_CHATGPT_SOCKET      broker socket (default /run/joya-chatgpt/sock)
  JOYA_CHATGPT_CALLER      who is asking, for the broker's log (e.g. agent:mavix-bot)
  JOYA_CHATGPT_OUT         where returned files go
  JOYA_CHATGPT_FILES_ROOT  if set, context files must lie under it
  JOYA_CHATGPT_TIMEOUT_S   how long to wait for the broker (default 1800)
"""

import base64
import json
import os
import socket
import sys
import threading

SERVER_NAME = "chatgpt"
VERSION = "1.0.0"
TOOL = "ask_chatgpt"
SOCKET = os.environ.get("JOYA_CHATGPT_SOCKET", "/run/joya-chatgpt/sock")
MAX_IN_FILES = 20
MAX_IN_BYTES = 10 * 1024 * 1024

DESCRIPTION = (
    "Delegate a task to ChatGPT (OpenAI, via the user's ChatGPT account). Use ONLY when "
    "the user explicitly asks to use, ask or delegate to ChatGPT or GPT (e.g. \"ask "
    "ChatGPT\", \"get GPT's opinion\", \"let ChatGPT write it\"); never call it on your "
    "own initiative, not even for a second opinion. Pass the full task and all the context "
    "it needs: ChatGPT cannot see this conversation, this server or your files except the "
    "ones you list in `files`. It works in a private scratch folder, has no access to the "
    "server and no internet for commands. Returns ChatGPT's answer, plus the paths of any "
    "files it created (copied where you can read them, so you can send them on). Takes from "
    "seconds to several minutes; tell the user it is ChatGPT's answer."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "task": {
            "type": "string",
            "description": "The complete task for ChatGPT, with every detail and the context it needs.",
        },
        "files": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Optional absolute paths of files to give ChatGPT as context (max 20, 10 MB in total).",
        },
        "model": {
            "type": "string",
            "description": "Optional ChatGPT model name; leave empty for the account's default.",
        },
    },
    "required": ["task"],
    "additionalProperties": False,
}

_write_lock = threading.Lock()


def send(msg):
    data = json.dumps(msg, ensure_ascii=False)
    with _write_lock:
        sys.stdout.write(data + "\n")
        sys.stdout.flush()


def _within(path, root):
    root = os.path.realpath(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def read_context_files(paths):
    root = os.environ.get("JOYA_CHATGPT_FILES_ROOT") or ""
    out, total = [], 0
    if len(paths) > MAX_IN_FILES:
        raise ValueError(f"at most {MAX_IN_FILES} files")
    for raw in paths:
        p = str(raw or "").strip()
        if not p:
            continue
        if not os.path.isabs(p):
            p = os.path.join(root or os.getcwd(), p)
        real = os.path.realpath(p)
        if root and not _within(real, root):
            raise ValueError(f"{raw}: only files under {root} can be given to ChatGPT")
        if not os.path.isfile(real):
            raise ValueError(f"{raw}: no such file")
        size = os.path.getsize(real)
        total += size
        if total > MAX_IN_BYTES:
            raise ValueError("the files are more than 10 MB in total")
        with open(real, "rb") as fh:
            out.append({"name": os.path.basename(real), "b64": base64.b64encode(fh.read()).decode()})
    return out


def broker_call(req, timeout):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(SOCKET)
    except (FileNotFoundError, ConnectionRefusedError) as e:
        raise RuntimeError("the ChatGPT service (joya-chatgpt) is not running on this server") from e
    try:
        s.sendall((json.dumps(req) + "\n").encode())
        buf = bytearray()
        while not buf.endswith(b"\n"):
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            buf += chunk
    finally:
        s.close()
    if not buf:
        raise RuntimeError("the ChatGPT service closed the connection without an answer")
    return json.loads(buf.decode("utf-8"))


def safe_rel(name):
    parts = [p for p in str(name).replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return os.path.join(*parts) if parts else "file"


def save_files(task_id, files):
    out_root = os.environ.get("JOYA_CHATGPT_OUT") or os.path.join(os.path.expanduser("~"), "chatgpt")
    dest = os.path.join(out_root, safe_rel(task_id or "task").replace(os.sep, "_"))
    saved = []
    for f in files:
        # safe_rel drops "..", and dest is a fresh folder named by the task id
        p = os.path.join(dest, safe_rel(f.get("name")))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(base64.b64decode(f.get("b64") or ""))
        saved.append((p, f.get("size", 0)))
    return saved


def ask(args):
    task = str(args.get("task") or "").strip()
    if not task:
        return "The task is empty: pass the full task for ChatGPT.", True
    try:
        files = read_context_files(args.get("files") or [])
    except ValueError as e:
        return f"Not sent to ChatGPT: {e}", True
    req = {
        "op": "ask",
        "task": task,
        "files": files,
        "model": str(args.get("model") or "").strip(),
        "caller": os.environ.get("JOYA_CHATGPT_CALLER") or f"uid:{os.getuid()}",
    }
    timeout = float(os.environ.get("JOYA_CHATGPT_TIMEOUT_S") or 1800)
    try:
        resp = broker_call(req, timeout)
    except socket.timeout:
        return "ChatGPT did not answer in time.", True
    except (RuntimeError, OSError, ValueError) as e:
        return f"ChatGPT is not available: {e}", True
    if not resp.get("ok"):
        return resp.get("error") or "ChatGPT failed.", True
    lines = [resp.get("answer") or ""]
    try:
        saved = save_files(resp.get("id"), resp.get("files") or [])
    except OSError as e:
        saved = []
        lines.append(f"\n[ChatGPT made files but they could not be saved here: {e}]")
    if saved:
        lines.append("\n---\nFiles ChatGPT created (readable by you; send them with your file tool if the user wants them):")
        lines += [f"- {p} ({size} bytes)" for p, size in saved]
    if resp.get("notes"):
        lines.append("\nNotes: " + "; ".join(resp["notes"]))
    lines.append(f"\n[ChatGPT ({resp.get('model') or 'default'}), {resp.get('duration_s')} s]")
    return "\n".join(lines), False


def handle(msg):
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        pv = (msg.get("params") or {}).get("protocolVersion") or "2025-06-18"
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": pv,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": VERSION},
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": TOOL, "description": DESCRIPTION, "inputSchema": SCHEMA},
        ]}})
    elif method == "tools/call":
        params = msg.get("params") or {}
        if params.get("name") != TOOL:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown tool"}})
            return

        def work():
            try:
                text, is_err = ask(params.get("arguments") or {})
            except Exception as e:  # report, never crash the server
                text, is_err = f"ask_chatgpt failed: {type(e).__name__}: {e}", True
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": text}], "isError": is_err}})

        threading.Thread(target=work, daemon=True).start()
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif mid is not None and method:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})
    # notifications (initialized, cancelled, ...) need no reply


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg, list):
            for m in msg:
                if isinstance(m, dict):
                    handle(m)
        elif isinstance(msg, dict):
            handle(msg)


if __name__ == "__main__":
    main()
