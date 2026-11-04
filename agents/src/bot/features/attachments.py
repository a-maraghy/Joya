"""Durable storage for files sent to an agent over chat.

Uploads used to be decoded as UTF-8 and pasted into the prompt. That had two
consequences worth naming, because they are the reason this module exists:

  1. Anything not valid UTF-8 was rejected outright -- a spreadsheet, a PDF, a
     Word document, a photo sent as a file. The three formats people most often
     want an assistant to look at were the three it could not accept.
  2. Even an accepted file existed for exactly one turn. Ask a follow-up question
     and the file was gone, because nothing had written it anywhere.

Claude Code can open files itself. So the useful thing to do with an upload is
not to transcribe it into the prompt, but to put it somewhere the agent can
reach and hand over the path. Then a spreadsheet is a pandas call away, a PDF is
readable, and the file is still there tomorrow.

Files land in ``<workspace>/attachments/inbox/<YYYY-MM-DD>/`` which is inside the
agent's own directory -- the only place it is allowed to read and write.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import structlog

logger = structlog.get_logger()

INBOX = "attachments/inbox"
MAX_NAME_LEN = 96

# Small text files are still worth inlining: it costs little, and it saves the
# agent a tool call to see something it was always going to read in full.
INLINE_TEXT_MAX_BYTES = 32 * 1024

SPREADSHEET_EXT = {".xlsx", ".xls", ".xlsm", ".csv", ".tsv", ".ods"}
DOCUMENT_EXT = {".pdf", ".doc", ".docx", ".odt", ".rtf", ".epub"}
SLIDES_EXT = {".ppt", ".pptx", ".odp"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".tiff"}
ARCHIVE_EXT = {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar"}
AUDIO_EXT = {".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".aac", ".opus"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
DATA_EXT = {".json", ".ndjson", ".parquet", ".db", ".sqlite", ".sqlite3"}


def kind_of(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in SPREADSHEET_EXT:
        return "spreadsheet"
    if ext in DOCUMENT_EXT:
        return "document"
    if ext in SLIDES_EXT:
        return "slides"
    if ext in IMAGE_EXT:
        return "image"
    if ext in ARCHIVE_EXT:
        return "archive"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in VIDEO_EXT:
        return "video"
    if ext in DATA_EXT:
        return "data"
    return "file"


# What to tell the agent about a file it has just been handed. Specific beats
# generic here: "read it with pandas" is a nudge that saves a turn of the model
# working out how to open an .xlsx.
_HINTS = {
    "spreadsheet": (
        "Read it with pandas (`pd.read_excel` / `pd.read_csv`). List the sheets and "
        "columns before drawing conclusions, and say which sheet you used."
    ),
    "document": (
        "Extract the text before answering. Quote the parts you rely on so the "
        "reader can check them."
    ),
    "slides": "Extract the text per slide, and say which slide each point came from.",
    "image": (
        "You can also see this image directly in the message. The saved copy is "
        "there if you need to refer to it again later."
    ),
    "archive": (
        "Unpack it into a subfolder next to the archive before reading, and list "
        "what it contained."
    ),
    "audio": "Transcribe it if you need the contents.",
    "video": "Inspect it with ffprobe/ffmpeg if you need details.",
    "data": "Open it with the appropriate library rather than reading it as text.",
    "file": "Open it with whatever tool suits the format.",
}


def safe_name(raw: Optional[str], fallback: str = "upload") -> str:
    """Reduce a user-supplied filename to something safe to write.

    The name comes from a chat message, so it is untrusted: it has to lose any
    path structure, any leading dot, and anything the shell or the filesystem
    would find interesting. The extension is preserved because it is how both
    the agent and its tools decide what the file is.
    """
    name = (raw or "").strip().replace("\\", "/").split("/")[-1]
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-._")
    if not name:
        name = fallback
    stem, dot, ext = name.rpartition(".")
    if not dot:
        return name[:MAX_NAME_LEN]
    ext = re.sub(r"[^A-Za-z0-9]+", "", ext)[:12]
    stem = (stem or fallback)[: MAX_NAME_LEN - len(ext) - 1].strip("-._") or fallback
    return stem + "." + ext if ext else stem


class AttachmentStore:
    """Writes chat uploads into the agent's workspace."""

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)

    def inbox(self) -> Path:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        path = self.workspace / INBOX / day
        path.mkdir(parents=True, exist_ok=True)
        return path

    def target_for(self, filename: Optional[str], fallback: str = "upload") -> Path:
        """Pick a free path in today's inbox, never overwriting an existing file."""
        directory = self.inbox()
        name = safe_name(filename, fallback)
        candidate = directory / name
        if not candidate.exists():
            return candidate
        stem = candidate.stem
        suffix = candidate.suffix
        for n in range(2, 1000):
            candidate = directory / f"{stem}-{n}{suffix}"
            if not candidate.exists():
                return candidate
        # A thousand collisions in one day means something is wrong; fall back to
        # a timestamp rather than looping forever.
        stamp = datetime.now(timezone.utc).strftime("%H%M%S%f")
        return directory / f"{stem}-{stamp}{suffix}"

    def save_bytes(self, data: bytes, filename: Optional[str]) -> Path:
        path = self.target_for(filename)
        path.write_bytes(data)
        logger.info("Saved attachment", path=str(path), bytes=len(data))
        return path

    def relative(self, path: Path) -> str:
        try:
            return str(Path(path).relative_to(self.workspace))
        except ValueError:
            return str(path)

    def build_prompt(self, path: Path, caption: str = "") -> str:
        """Describe a saved file to the agent, with a hint for its kind.

        The absolute path is given because that is what the agent's tools take;
        the relative one because that is what a human reading the transcript
        will recognise.
        """
        kind = kind_of(path)
        size = path.stat().st_size if path.exists() else 0
        rel = self.relative(path)

        lines = [
            (caption or "").strip() or "The user sent you a file.",
            "",
            f"**File saved to your workspace:** `{path}`",
            f"(relative to your working directory: `{rel}`, {_fmt_size(size)}, {kind})",
            "",
            _HINTS.get(kind, _HINTS["file"]),
        ]

        # For a small text or code file, include the content as well: it is
        # cheap and spares a round trip for something the agent would read
        # immediately anyway.
        if kind in {"file", "data"} and 0 < size <= INLINE_TEXT_MAX_BYTES:
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                text = None
            if text is not None:
                lines += ["", "Contents:", "", "```", text, "```"]

        lines += [
            "",
            "The file stays in your workspace, so you can come back to it in a "
            "later message without the user re-sending it.",
        ]
        return "\n".join(lines)


def _fmt_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024:
            return f"{value:.0f}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value /= 1024
    return f"{value:.1f}TB"
