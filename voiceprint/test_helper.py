#!/usr/bin/env python3
"""
The helper's voiceprint subcommands (dashboard/deploy/joya-helper:
voiceprint-seal / -open / -forget), loaded from the repository with their
paths pointed at a temporary folder -- the real key is never touched.

    sudo python3 voiceprint/test_helper.py
"""
import base64
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest

HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dashboard", "deploy", "joya-helper")


def load():
    loader = importlib.machinery.SourceFileLoader("joya_helper_under_test", HELPER)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class HelperVoiceprint(unittest.TestCase):
    def setUp(self):
        self.h = load()
        self.dir = tempfile.mkdtemp(prefix="vp-helper-")
        self.h.VOICE_DIR = self.dir
        self.h.VOICEPRINT_KEY = os.path.join(self.dir, "voiceprint.key")
        self.h.VOICEPRINT_RESULTS = os.path.join(self.dir, "results")
        self.h.AUDIT_LOG = os.path.join(self.dir, "audit.log")

    def call(self, name, stdin=None):
        out = io.StringIO()
        sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps(stdin or {}).encode()))
        with contextlib.redirect_stdout(out):
            try:
                self.h.COMMANDS[name]([])
            except SystemExit:
                pass
        return json.loads(out.getvalue())

    def test_seal_open_forget(self):
        plain = base64.b64encode(os.urandom(1024)).decode()
        r = self.call("voiceprint-open", {"sealed": base64.b64encode(b"x" * 40).decode()})
        self.assertFalse(r["ok"])
        self.assertIn("no voiceprint key", r["error"])
        s = self.call("voiceprint-seal", {"plain": plain})
        self.assertTrue(s["ok"])
        self.assertEqual(oct(os.stat(self.h.VOICEPRINT_KEY).st_mode & 0o777), "0o600")
        sealed = s["data"]["sealed"]
        self.assertNotIn(plain[:40], sealed)
        o = self.call("voiceprint-open", {"sealed": sealed})
        self.assertEqual(o["data"]["plain"], plain)
        raw = bytearray(base64.b64decode(sealed))
        raw[20] ^= 1
        bad = self.call("voiceprint-open", {"sealed": base64.b64encode(bytes(raw)).decode()})
        self.assertFalse(bad["ok"])
        self.assertIn("could not be opened", bad["error"])
        self.assertFalse(self.call("voiceprint-seal", {"plain": "not base64!"})["ok"])
        self.assertFalse(self.call("voiceprint-seal", {})["ok"])
        os.makedirs(os.path.join(self.h.VOICEPRINT_RESULTS, "user-20261007-1"))
        os.makedirs(os.path.join(self.h.VOICEPRINT_RESULTS, "standin"))
        f = self.call("voiceprint-forget")
        self.assertEqual(f["data"], {"key_deleted": True, "results_deleted": 1})
        self.assertFalse(os.path.exists(self.h.VOICEPRINT_KEY))
        self.assertTrue(os.path.isdir(os.path.join(self.h.VOICEPRINT_RESULTS, "standin")))
        self.assertFalse(self.call("voiceprint-open", {"sealed": sealed})["ok"])
        audit = open(self.h.AUDIT_LOG).read()
        self.assertNotIn(plain[:20], audit)
        self.assertIn("voiceprint-forget", audit)


if __name__ == "__main__":
    unittest.main(verbosity=1)
