#!/usr/bin/env python3
"""Tests for the ChatGPT broker and the ask_chatgpt MCP server, with a fake Codex CLI.

    python3 chatgpt/test_chatgpt.py        (no network, no ChatGPT usage)
"""

import base64
import json
import os
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import broker  # noqa: E402
import chatgpt_mcp  # noqa: E402

FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, sys, time
args = sys.argv[1:]
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
log = os.environ.get("FAKE_CODEX_ARGS")
if log:
    with open(log, "a") as fh: fh.write(json.dumps(args) + "\n")
if args[:2] == ["login", "status"]:
    if mode == "logged_out":
        print("Not logged in", file=sys.stderr); sys.exit(1)
    print("Logged in using ChatGPT"); sys.exit(0)
if args[0] != "exec":
    sys.exit(2)
prompt = sys.stdin.read()
cwd = args[args.index("-C") + 1]
out = args[args.index("-o") + 1]
if mode == "slow":
    time.sleep(30)
if mode == "limit":
    print(json.dumps({"type": "error", "message": "You've hit your usage limit. Try again at 5pm."}))
    sys.exit(1)
if mode == "expired":
    print(json.dumps({"type": "turn.failed", "error": {"message": "401 Unauthorized: refresh token was already used"}}))
    sys.exit(1)
with open(os.path.join(cwd, "result.md"), "w") as fh:
    fh.write("# made by fake codex\n")
if mode == "leak":
    with open(os.path.join(cwd, "leak.txt"), "w") as fh:
        fh.write("token=SECRET-ACCESS-TOKEN-1234567890")
ctx = os.path.join(cwd, "context")
seen = sorted(os.listdir(ctx)) if os.path.isdir(ctx) else []
answer = "ok | context=" + ",".join(seen) + " | task=" + prompt.split("TASK:\n", 1)[-1][:40]
if mode == "leak":
    answer += " SECRET-ACCESS-TOKEN-1234567890"
with open(out, "w") as fh:
    fh.write(answer)
print(json.dumps({"type": "turn.completed"}))
'''


class BrokerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="joya-chatgpt-test-")
        cls.sock = os.path.join(cls.tmp, "sock")
        cls.codex = os.path.join(cls.tmp, "codex")
        with open(cls.codex, "w") as fh:
            fh.write(FAKE_CODEX)
        os.chmod(cls.codex, 0o755)
        home = os.path.join(cls.tmp, "codexhome")
        os.makedirs(home)
        with open(os.path.join(home, "auth.json"), "w") as fh:
            json.dump({"tokens": {"access_token": "SECRET-ACCESS-TOKEN-1234567890"}}, fh)
        cls.cfg = os.path.join(cls.tmp, "config.json")
        me = pwd.getpwuid(os.getuid()).pw_name
        with open(cls.cfg, "w") as fh:
            json.dump({"socket": cls.sock, "state_dir": os.path.join(cls.tmp, "state"), "codex": cls.codex,
                       "codex_home": home, "allowed_users": [me], "max_running": 1, "max_queued": 1,
                       "timeout_s": 3, "queue_wait_s": 20, "max_answer_chars": 500}, fh)
        cls.out = os.path.join(cls.tmp, "out")
        cls.vault = os.path.join(cls.tmp, "vault")
        os.makedirs(cls.vault)
        with open(os.path.join(cls.vault, "notes.md"), "w") as fh:
            fh.write("some notes")
        cls.args_log = os.path.join(cls.tmp, "args.log")
        cls.procs = {}

    @classmethod
    def tearDownClass(cls):
        for p in cls.procs.values():
            p.terminate()
            p.wait(5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def start(self, mode):
        for p in self.procs.values():
            p.terminate()
            p.wait(5)
        self.procs.clear()
        env = dict(os.environ, JOYA_CHATGPT_CONFIG=self.cfg, FAKE_CODEX_MODE=mode, FAKE_CODEX_ARGS=self.args_log)
        p = subprocess.Popen([sys.executable, os.path.join(HERE, "broker.py")], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs[mode] = p
        for _ in range(100):
            if os.path.exists(self.sock):
                with socket.socket(socket.AF_UNIX) as s:
                    try:
                        s.connect(self.sock)
                        break
                    except OSError:
                        pass
            time.sleep(0.05)
        os.environ.update(JOYA_CHATGPT_SOCKET=self.sock, JOYA_CHATGPT_OUT=self.out,
                          JOYA_CHATGPT_FILES_ROOT=self.vault, JOYA_CHATGPT_CALLER="test")
        chatgpt_mcp.SOCKET = self.sock

    def test_ask_ok_with_files(self):
        self.start("ok")
        text, err = chatgpt_mcp.ask({"task": "Reply with ok", "files": [os.path.join(self.vault, "notes.md")]})
        self.assertFalse(err, text)
        self.assertIn("ok | context=notes.md | task=Reply with ok", text)
        self.assertIn("result.md", text)
        made = [l for l in text.splitlines() if l.startswith("- ")][0][2:].split(" (")[0]
        self.assertTrue(made.startswith(self.out))
        with open(made) as fh:
            self.assertIn("fake codex", fh.read())
        self.assertNotIn("notes.md (", text)  # an unchanged context file is not returned
        last = json.loads(open(self.args_log).read().splitlines()[-1])
        self.assertIn("workspace-write", last)
        self.assertIn("--ephemeral", last)

    def test_file_outside_root_refused(self):
        self.start("ok")
        text, err = chatgpt_mcp.ask({"task": "x", "files": ["/etc/hostname"]})
        self.assertTrue(err)
        self.assertIn("only files under", text)

    def test_limit_and_login_errors(self):
        self.start("limit")
        text, err = chatgpt_mcp.ask({"task": "x"})
        self.assertTrue(err)
        self.assertIn("usage limit", text)
        self.start("expired")
        text, err = chatgpt_mcp.ask({"task": "x"})
        self.assertTrue(err)
        self.assertIn("joya-chatgpt login", text)
        self.start("logged_out")
        text, err = chatgpt_mcp.ask({"task": "x"})
        self.assertTrue(err)
        self.assertIn("sign-in expired", text)

    def test_timeout(self):
        self.start("slow")
        t0 = time.time()
        text, err = chatgpt_mcp.ask({"task": "x"})
        self.assertTrue(err)
        self.assertIn("did not finish within 3 seconds", text)
        self.assertLess(time.time() - t0, 15)

    def test_secret_redacted(self):
        self.start("leak")
        text, err = chatgpt_mcp.ask({"task": "x"})
        self.assertFalse(err, text)
        self.assertNotIn("SECRET-ACCESS-TOKEN", text)
        self.assertIn("[redacted]", text)
        self.assertIn("leak.txt not returned", text)

    def test_mcp_protocol(self):
        self.start("ok")
        env = dict(os.environ)
        p = subprocess.Popen([sys.executable, os.path.join(HERE, "chatgpt_mcp.py")], env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "ask_chatgpt", "arguments": {"task": "hi"}}},
        ]
        for m in msgs:
            p.stdin.write(json.dumps(m) + "\n")
        p.stdin.flush()
        got = {}
        while len(got) < 3:
            line = p.stdout.readline()
            if not line:
                break
            r = json.loads(line)
            got[r["id"]] = r
        p.stdin.close()
        p.wait(5)
        p.stdout.close()
        self.assertEqual(got[1]["result"]["serverInfo"]["name"], "chatgpt")
        tool = got[2]["result"]["tools"][0]
        self.assertEqual(tool["name"], "ask_chatgpt")
        self.assertIn("ONLY when the user explicitly asks", tool["description"])
        self.assertFalse(got[3]["result"]["isError"])
        self.assertIn("ok |", got[3]["result"]["content"][0]["text"])

    def test_bad_requests(self):
        self.start("ok")
        r = chatgpt_mcp.broker_call({"op": "ask", "task": "x", "model": "bad model!"}, 10)
        self.assertFalse(r["ok"])
        r = chatgpt_mcp.broker_call({"op": "ask", "task": "x", "files": [{"name": "a", "b64": "!!"}]}, 10)
        self.assertFalse(r["ok"])
        r = chatgpt_mcp.broker_call({"op": "status"}, 10)
        self.assertTrue(r["ok"] and r["logged_in"])

    def test_classify(self):
        self.assertEqual(broker.classify_error("429 Too Many Requests")[0], "limit")
        self.assertEqual(broker.classify_error("Not logged in")[0], "login")
        self.assertEqual(broker.classify_error("stream disconnected")[0], "codex")
        self.assertEqual(broker.safe_name("../../etc/passwd"), "passwd")
        self.assertEqual(chatgpt_mcp.safe_rel("../a/../../b.txt"), os.path.join("a", "b.txt"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
