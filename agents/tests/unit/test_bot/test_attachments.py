"""Tests for chat attachment storage.

The filename cases matter more than they look: the name arrives in a Telegram
message and is used to build a path on disk, so it is attacker-controlled input
at a filesystem boundary.
"""

from pathlib import Path

import pytest

from src.bot.features.attachments import AttachmentStore, kind_of, safe_name


class TestSafeName:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("../../etc/passwd", "passwd"),
            ("/etc/shadow", "shadow"),
            ("..\\..\\windows\\system32\\cfg.ini", "cfg.ini"),
            ("", "upload"),
            ("..", "upload"),
            (".", "upload"),
            ("...", "upload"),
            ("report .xlsx", "report.xlsx"),
            ("Q3 Résumé (final).docx", "Q3-Resume-final.docx"),
            ("no-extension", "no-extension"),
        ],
    )
    def test_sanitises(self, raw, expected):
        assert safe_name(raw) == expected

    def test_never_escapes_a_directory(self):
        for raw in ["../x.txt", "a/../../b.txt", "/abs/path.txt", "..%2Fetc.txt"]:
            assert "/" not in safe_name(raw)
            assert "\\" not in safe_name(raw)
            assert not safe_name(raw).startswith(".")

    def test_caps_length_but_keeps_extension(self):
        name = safe_name("a" * 500 + ".pdf")
        assert len(name) <= 96
        assert name.endswith(".pdf")

    def test_none_is_handled(self):
        assert safe_name(None) == "upload"


class TestKindOf:
    @pytest.mark.parametrize(
        "name,kind",
        [
            ("book.xlsx", "spreadsheet"),
            ("data.csv", "spreadsheet"),
            ("contract.pdf", "document"),
            ("notes.docx", "document"),
            ("deck.pptx", "slides"),
            ("photo.JPG", "image"),
            ("bundle.zip", "archive"),
            ("clip.mp3", "audio"),
            ("clip.mp4", "video"),
            ("rows.parquet", "data"),
            ("main.py", "file"),
        ],
    )
    def test_classifies(self, name, kind):
        assert kind_of(Path(name)) == kind


class TestAttachmentStore:
    def test_saves_inside_the_workspace(self, tmp_path):
        store = AttachmentStore(tmp_path)
        saved = store.save_bytes(b"a,b\n1,2\n", "data.csv")
        assert saved.is_file()
        assert tmp_path in saved.parents
        assert saved.read_bytes() == b"a,b\n1,2\n"

    def test_a_hostile_name_still_lands_inside(self, tmp_path):
        store = AttachmentStore(tmp_path)
        saved = store.save_bytes(b"x", "../../../../etc/passwd")
        assert tmp_path in saved.parents
        assert saved.name == "passwd"

    def test_does_not_overwrite(self, tmp_path):
        store = AttachmentStore(tmp_path)
        first = store.save_bytes(b"first", "notes.txt")
        second = store.save_bytes(b"second", "notes.txt")
        assert first != second
        assert first.read_bytes() == b"first"
        assert second.name == "notes-2.txt"

    def test_relative_path_is_workspace_relative(self, tmp_path):
        store = AttachmentStore(tmp_path)
        saved = store.save_bytes(b"x", "a.txt")
        rel = store.relative(saved)
        assert rel.startswith("attachments/inbox/")
        assert not rel.startswith("/")

    def test_prompt_names_the_path_and_the_kind(self, tmp_path):
        store = AttachmentStore(tmp_path)
        saved = store.save_bytes(b"a,b\n1,2\n", "sales.csv")
        prompt = store.build_prompt(saved, "what is in here?")
        assert "what is in here?" in prompt
        assert str(saved) in prompt
        assert "pandas" in prompt  # the spreadsheet hint

    def test_small_text_is_inlined_binary_is_not(self, tmp_path):
        store = AttachmentStore(tmp_path)
        text = store.save_bytes(b"hello world", "readme")
        assert "hello world" in store.build_prompt(text)

        # A PDF must never be inlined -- that was the old bug, and decoding it
        # as text is what used to reject the upload outright.
        pdf = store.save_bytes(b"%PDF-1.4\x00\x01binary", "doc.pdf")
        body = store.build_prompt(pdf)
        assert "binary" not in body
        assert "Extract the text" in body

    def test_empty_caption_still_produces_a_usable_prompt(self, tmp_path):
        store = AttachmentStore(tmp_path)
        saved = store.save_bytes(b"x", "a.pdf")
        assert "The user sent you a file." in store.build_prompt(saved, "")
