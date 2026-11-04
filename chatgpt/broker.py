#!/usr/bin/env python3
"""joya-chatgpt broker: hands a task to ChatGPT through the OpenAI Codex CLI.

One login, one broker. The user's ChatGPT sign-in lives in one place
(CODEX_HOME, /root/.codex) and only this service runs `codex exec` with it, so
the refresh token Codex rotates is never held in two copies that would
invalidate each other. Agents reach ChatGPT through the Unix socket only, via
the stdio MCP server chatgpt_mcp.py, which every agent kind loads.

Protocol: one JSON object per line in each direction, one request per
connection.

    {"op": "status"}
        -> {"ok": true, "logged_in": true, "running": 0, "queued": 0, ...}
    {"op": "ask", "task": "...", "caller": "agent:mavix-bot", "model": "",
     "files": [{"name": "notes.md", "b64": "..."}]}
        -> {"ok": true, "id": "...", "answer": "...", "files": [{"name", "b64",
            "size"}], "notes": [...], "duration_s": 12.3}
        or {"ok": false, "error": "...", "kind": "login|limit|timeout|busy|..."}

What ChatGPT may touch: `codex exec --sandbox workspace-write -C <task dir>`
(writes only in a fresh per-task directory, no network for the commands it
runs), inside this unit's systemd sandbox (read-only system, an empty /root
except .codex, and the server's data, logs and secrets made inaccessible: see
joya-chatgpt.service). The answer and the files it made are checked for the
sign-in's own tokens before they leave; a hit is redacted or the file dropped.

Peers are identified by SO_PEERCRED; only the accounts in `allowed_users`
(config) may ask. Every call is logged (who, when, how long, outcome) to the
journal and to calls.jsonl; never the task text, never the credentials.
"""

import asyncio
import base64
import datetime as dt
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import socket
import struct
import sys
import time
import uuid

CONFIG_FILE = os.environ.get("JOYA_CHATGPT_CONFIG", "/etc/joya-chatgpt/config.json")

DEFAULTS = {
    "socket": "/run/joya-chatgpt/sock",
    "state_dir": "/var/lib/joya-chatgpt",
    "codex": "/usr/bin/codex",
    "codex_home": "/root/.codex",
    "allowed_users": ["root", "joyaagent", "joyaconsole"],
    "max_running": 2,
    "max_queued": 8,
    "timeout_s": 600,
    "queue_wait_s": 900,
    "max_task_chars": 100_000,
    "max_in_files": 20,
    "max_in_bytes": 10 * 1024 * 1024,
    "max_answer_chars": 60_000,
    "max_out_files": 20,
    "max_out_bytes": 25 * 1024 * 1024,
    "keep_tasks_days": 7,
    "model": "",
}

MODEL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
NAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")

PREAMBLE = (
    "You are ChatGPT, asked to do a task by an AI assistant on behalf of its user. "
    "You cannot see their conversation: everything you have is below. "
    "Work only inside the current directory. {ctx}"
    "If the task asks for files (documents, code, data, images), write them into "
    "the current directory (not under context/); they are handed back to the "
    "assistant. Reply with your complete answer as your final message.\n\n"
    "TASK:\n"
)


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_FILE, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    except FileNotFoundError:
        pass
    return cfg


def log(event):
    """One line per event to the journal (stdout); never task text or secrets."""
    event = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), **event}
    print(json.dumps(event, ensure_ascii=False), flush=True)
    return event


def safe_name(name, fallback="file"):
    base = os.path.basename(str(name or "")).strip()
    base = NAME_RE.sub("_", base).strip(" .")
    return (base or fallback)[:120]


def classify_error(text):
    """Turn Codex's error text into a clear message and a kind."""
    t = (text or "").strip()
    low = t.lower()
    if re.search(r"usage limit|rate limit|too many requests|\b429\b|quota|try again (at|in)", low):
        return "limit", "ChatGPT usage limit reached" + (": " + t[:400] if t else ".")
    if re.search(r"\b401\b|unauthori[sz]ed|refresh token|not logged in|log ?in again|sign ?in again|"
                 r"token (has )?expired|login|authentication", low):
        return "login", ("ChatGPT sign-in expired: run `joya-chatgpt login` on the VPS (as root). "
                         + ("Codex said: " + t[:300] if t else ""))
    return "codex", "ChatGPT (Codex) failed: " + (t[:600] or "no detail")


def secret_strings(codex_home):
    """The sign-in's token strings, so nothing that leaves can carry them."""
    out = set()
    try:
        with open(os.path.join(codex_home, "auth.json"), encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return out

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str) and len(v) >= 16:
            out.add(v)

    walk(data)
    return out


def redact(text, secrets):
    hit = False
    for s in secrets:
        if s in text:
            text = text.replace(s, "[redacted]")
            hit = True
    return text, hit


def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def peer_user(sock):
    try:
        creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid, uid, _gid = struct.unpack("3i", creds)
    except OSError:
        return None, None, None
    try:
        name = pwd.getpwuid(uid).pw_name
    except KeyError:
        name = str(uid)
    return pid, uid, name


class Broker:
    def __init__(self, cfg):
        self.cfg = cfg
        self.sem = asyncio.Semaphore(int(cfg["max_running"]))
        self.running = 0
        self.queued = 0
        self.tasks_dir = os.path.join(cfg["state_dir"], "tasks")
        self.calls_log = os.path.join(cfg["state_dir"], "calls.jsonl")
        os.makedirs(self.tasks_dir, mode=0o700, exist_ok=True)

    # ------------------------------------------------------------- helpers ---
    def record(self, event):
        event = log(event)
        try:
            with open(self.calls_log, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def cleanup(self):
        cutoff = time.time() - float(self.cfg["keep_tasks_days"]) * 86400
        try:
            for d in os.listdir(self.tasks_dir):
                p = os.path.join(self.tasks_dir, d)
                if os.path.isdir(p) and os.path.getmtime(p) < cutoff:
                    shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass

    def codex_env(self):
        env = {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": os.path.dirname(self.cfg["codex_home"].rstrip("/")) or "/root",
            "CODEX_HOME": self.cfg["codex_home"],
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "TERM": "dumb",
            "NO_COLOR": "1",
        }
        for k in os.environ:
            if k.startswith("FAKE_CODEX"):  # the tests' fake CLI
                env[k] = os.environ[k]
        return env

    async def run_cmd(self, argv, cwd=None, stdin=None, timeout=30):
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd, env=self.codex_env(),
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(stdin.encode() if stdin is not None else None), timeout)
        except asyncio.TimeoutError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await proc.wait()
            raise
        return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

    async def logged_in(self):
        try:
            rc, out, err = await self.run_cmd([self.cfg["codex"], "login", "status"], timeout=30)
        except (asyncio.TimeoutError, OSError) as e:
            return False, str(e)
        text = (out + err).strip()
        return rc == 0 and "logged in" in text.lower() and "not logged in" not in text.lower(), text

    # ----------------------------------------------------------------- ask ---
    async def ask(self, req, who):
        cfg = self.cfg
        task = str(req.get("task") or "").strip()
        if not task:
            return {"ok": False, "kind": "bad_request", "error": "task is empty"}
        if len(task) > int(cfg["max_task_chars"]):
            return {"ok": False, "kind": "bad_request",
                    "error": f"task is longer than {cfg['max_task_chars']} characters"}
        model = str(req.get("model") or cfg.get("model") or "").strip()
        if model and not MODEL_RE.match(model):
            return {"ok": False, "kind": "bad_request", "error": "model name is not valid"}
        files = req.get("files") or []
        if not isinstance(files, list) or len(files) > int(cfg["max_in_files"]):
            return {"ok": False, "kind": "bad_request",
                    "error": f"at most {cfg['max_in_files']} context files"}
        decoded = []
        total = 0
        for f in files:
            try:
                raw = base64.b64decode(str(f.get("b64") or ""), validate=True)
            except Exception:
                return {"ok": False, "kind": "bad_request", "error": "a context file is not valid base64"}
            total += len(raw)
            if total > int(cfg["max_in_bytes"]):
                return {"ok": False, "kind": "bad_request",
                        "error": f"context files exceed {cfg['max_in_bytes'] // (1024 * 1024)} MB"}
            decoded.append((safe_name(f.get("name")), raw))

        if self.queued >= int(cfg["max_queued"]):
            return {"ok": False, "kind": "busy",
                    "error": "ChatGPT is busy with other tasks and the queue is full; try again later"}
        self.queued += 1
        try:
            await asyncio.wait_for(self.sem.acquire(), float(cfg["queue_wait_s"]))
        except asyncio.TimeoutError:
            return {"ok": False, "kind": "busy", "error": "waited too long for a free ChatGPT slot"}
        finally:
            self.queued -= 1
        self.running += 1
        try:
            return await self._run(task, model, decoded, who)
        finally:
            self.running -= 1
            self.sem.release()

    async def _run(self, task, model, decoded, who):
        cfg = self.cfg
        ok, status = await self.logged_in()
        if not ok:
            kind, msg = classify_error(status or "not logged in")
            if kind != "login":
                kind, msg = "login", "ChatGPT sign-in expired: run `joya-chatgpt login` on the VPS (as root)."
            return {"ok": False, "kind": kind, "error": msg}

        tid = dt.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        base = os.path.join(self.tasks_dir, tid)
        work = os.path.join(base, "work")
        os.makedirs(work, mode=0o700)
        before = {}
        if decoded:
            ctx = os.path.join(work, "context")
            os.makedirs(ctx)
            used = set()
            for name, raw in decoded:
                n, i = name, 1
                while n in used:
                    stem, ext = os.path.splitext(name)
                    n, i = f"{stem}-{i}{ext}", i + 1
                used.add(n)
                p = os.path.join(ctx, n)
                with open(p, "wb") as fh:
                    fh.write(raw)
                before[os.path.relpath(p, work)] = file_digest(p)
        ctx_note = ("The files you were given are in ./context/ (" + ", ".join(sorted(os.path.basename(k) for k in before)) + "). ") if before else ""
        prompt = PREAMBLE.format(ctx=ctx_note) + task

        last = os.path.join(base, "last-message.txt")
        argv = [
            cfg["codex"], "exec",
            "--sandbox", "workspace-write",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color", "never",
            "--json",
            "-c", 'approval_policy="never"',
            "-C", work,
            "-o", last,
        ]
        if model:
            argv += ["-m", model]
        argv.append("-")

        t0 = time.monotonic()
        try:
            rc, out, err = await self.run_cmd(argv, cwd=work, stdin=prompt, timeout=float(cfg["timeout_s"]))
        except asyncio.TimeoutError:
            return {"ok": False, "kind": "timeout", "id": tid,
                    "error": f"ChatGPT did not finish within {int(cfg['timeout_s'])} seconds; the task was stopped"}
        except OSError as e:
            return {"ok": False, "kind": "codex", "id": tid, "error": f"could not start Codex: {e}"}
        duration = time.monotonic() - t0

        errors = []
        for line in out.splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            typ = str(ev.get("type") or "")
            if typ == "error" or typ.endswith(".failed"):
                e = ev.get("error")
                msg = ev.get("message") or (e.get("message") if isinstance(e, dict) else e)
                if msg:
                    errors.append(str(msg))
        answer = ""
        try:
            with open(last, encoding="utf-8", errors="replace") as fh:
                answer = fh.read().strip()
        except FileNotFoundError:
            pass

        if rc != 0 or (not answer and errors):
            detail = "; ".join(errors[-3:]) or err.strip()[-600:] or f"exit code {rc}"
            kind, msg = classify_error(detail)
            return {"ok": False, "kind": kind, "id": tid, "error": msg, "duration_s": round(duration, 1)}

        secrets = secret_strings(cfg["codex_home"])
        notes = []
        answer, hit = redact(answer, secrets)
        if hit:
            notes.append("a credential-like string was removed from the answer")
        limit = int(cfg["max_answer_chars"])
        if len(answer) > limit:
            answer = answer[:limit] + f"\n\n[answer cut at {limit} characters]"
            notes.append(f"answer cut at {limit} characters")

        candidates = []
        for root, dirs, names in os.walk(work):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for n in sorted(names):
                p = os.path.join(root, n)
                rel = os.path.relpath(p, work)
                if n.startswith(".") or os.path.islink(p) or not os.path.isfile(p):
                    continue
                if rel in before and before[rel] == file_digest(p):
                    continue  # a context file it did not change
                candidates.append((rel, p))
        out_files = []
        total = 0
        for idx, (rel, p) in enumerate(candidates):
            if len(out_files) >= int(cfg["max_out_files"]):
                notes.append(f"{len(candidates) - idx} more file(s) not returned (limit {cfg['max_out_files']})")
                break
            size = os.path.getsize(p)
            if total + size > int(cfg["max_out_bytes"]):
                notes.append(f"{rel} not returned: files over {int(cfg['max_out_bytes']) // (1024 * 1024)} MB in total")
                continue
            with open(p, "rb") as fh:
                raw = fh.read()
            if any(s.encode() in raw for s in secrets):
                notes.append(f"{rel} not returned: it contains a credential-like string")
                continue
            total += size
            out_files.append({"name": rel, "size": size, "b64": base64.b64encode(raw).decode()})

        return {"ok": True, "id": tid, "answer": answer or "(ChatGPT returned no text)",
                "files": out_files, "notes": notes, "duration_s": round(duration, 1),
                "model": model or "default"}

    # ------------------------------------------------------------- serving ---
    async def handle(self, reader, writer):
        sock = writer.get_extra_info("socket")
        pid, uid, user = peer_user(sock)
        t0 = time.monotonic()
        resp = None
        req = {}
        try:
            if user not in set(self.cfg["allowed_users"]):
                resp = {"ok": False, "kind": "denied", "error": f"account {user} may not use ChatGPT"}
            else:
                line = await asyncio.wait_for(reader.readline(), 60)
                try:
                    req = json.loads(line or b"{}")
                    if not isinstance(req, dict):
                        raise ValueError
                except ValueError:
                    resp = {"ok": False, "kind": "bad_request", "error": "request is not a JSON object"}
                else:
                    op = req.get("op")
                    if op == "status":
                        ok, text = await self.logged_in()
                        resp = {"ok": True, "logged_in": ok, "login_status": text[:200],
                                "running": self.running, "queued": self.queued,
                                "max_running": self.cfg["max_running"], "max_queued": self.cfg["max_queued"],
                                "timeout_s": self.cfg["timeout_s"]}
                    elif op == "ask":
                        resp = await self.ask(req, user)
                    else:
                        resp = {"ok": False, "kind": "bad_request", "error": "unknown op"}
        except Exception as e:  # never leave a caller hanging
            resp = {"ok": False, "kind": "internal", "error": f"broker error: {type(e).__name__}: {e}"}
        try:
            writer.write((json.dumps(resp, ensure_ascii=False) + "\n").encode())
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
        if req.get("op") == "ask" or not resp.get("ok"):
            self.record({
                "event": "call", "op": req.get("op"), "id": resp.get("id"),
                "caller": str(req.get("caller") or "")[:80], "user": user, "pid": pid,
                "model": req.get("model") or self.cfg.get("model") or "default",
                "task_chars": len(str(req.get("task") or "")), "in_files": len(req.get("files") or []),
                "out_files": len(resp.get("files") or []), "answer_chars": len(resp.get("answer") or ""),
                "ok": bool(resp.get("ok")), "kind": resp.get("kind"),
                "error": (resp.get("error") or "")[:200] or None,
                "seconds": round(time.monotonic() - t0, 1),
            })


async def main():
    cfg = load_config()
    broker = Broker(cfg)
    broker.cleanup()
    path = cfg["socket"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    server = await asyncio.start_unix_server(broker.handle, path=path, limit=64 * 1024 * 1024)
    # Anyone may connect; the broker itself checks who (SO_PEERCRED).
    os.chmod(path, 0o666)
    log({"event": "start", "socket": path, "allowed_users": cfg["allowed_users"],
         "max_running": cfg["max_running"], "timeout_s": cfg["timeout_s"]})

    async def janitor():
        while True:
            await asyncio.sleep(6 * 3600)
            broker.cleanup()

    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
    jt = asyncio.create_task(janitor())
    async with server:
        await stop
    jt.cancel()
    log({"event": "stop"})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
