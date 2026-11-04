"""The agent's memory vault: a plain folder of Markdown files.

The vault is deliberately not a database. It is an Obsidian vault, which means
every memory an agent writes is a file a human can open, read, correct and link
by hand -- and the vector index is a derived artefact that can be thrown away
and rebuilt at any time. Files are the source of truth; vectors are a cache.

Layout (created from deploy/vault-template):

    CLAUDE.md      identity and standing instructions
    MEMORY.md      the index, injected into the system prompt every request
    WORKLOG.md     dated narrative of work done
    memory/        one durable fact per file, linked with [[wikilinks]], filed by kind:
                   people/ projects/ decisions/ preferences/ lessons/ facts/
    outbox/ drawings/ chatgpt/ attachments/inbox/ mail/ topics/
                   written by the runtime's tools; superseded versions go to
                   an archive/ folder inside each, never away
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

MAX_CHUNK_CHARS = 1000
CHUNK_OVERLAP_CHARS = 150
# Low on purpose. A one-line fact ("the prod DB password rotates on the 1st") is
# exactly the kind of memory worth retrieving, and a higher floor silently drops
# it.
MIN_CHUNK_CHARS = 20
SKIP_DIRS = {".obsidian", ".git", ".trash", "node_modules", "__pycache__", ".venv"}
INDEX_MARKER = "## Memory index"

# The runtime injects these two into the system prompt on every single request,
# so they are already in front of the agent when it searches. Indexing them
# means a search spends result slots re-surfacing context the agent is currently
# reading -- and MEMORY.md is the worst offender, because its one-line pointers
# are short, topical, and outrank the notes they point at.
ALWAYS_IN_PROMPT = {"CLAUDE.md", "MEMORY.md"}
# Folder guides (memory/README.md, outbox/README.md ...) say what a folder is for;
# they are not memories and would only crowd search results.
FOLDER_GUIDES = {"README.md"}


# memory_write(kind=...) -> the folder under memory/ it files the note in, and the
# heading of MEMORY.md's index it is listed under. Anything unknown is a fact.
KINDS = {
    "person": ("people", "People"), "people": ("people", "People"),
    "project": ("projects", "Projects"), "projects": ("projects", "Projects"),
    "decision": ("decisions", "Decisions"), "decisions": ("decisions", "Decisions"),
    "preference": ("preferences", "Preferences"), "preferences": ("preferences", "Preferences"),
    "lesson": ("lessons", "Lessons learned"), "lessons": ("lessons", "Lessons learned"),
    "trap": ("lessons", "Lessons learned"), "gotcha": ("lessons", "Lessons learned"),
    "fact": ("facts", "Facts"), "facts": ("facts", "Facts"),
}
KIND_TYPE = {"people": "person", "projects": "project", "decisions": "decision",
             "preferences": "preference", "lessons": "lesson", "facts": "fact"}


def kind_folder(kind: Optional[str]):
    """(folder, index heading, type) for a kind; unknown or empty -> facts."""
    folder, heading = KINDS.get(str(kind or "fact").strip().lower(), KINDS["fact"])
    return folder, heading, KIND_TYPE[folder]


def slugify(title: str) -> str:
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return (text or "note")[:60]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Vault:
    def __init__(self, root):
        self.root = Path(root).resolve()

    # ------------------------------------------------------------- reading --

    def iter_markdown(self) -> Iterator[Path]:
        for path in sorted(self.root.rglob("*.md")):
            rel_parts = path.relative_to(self.root).parts
            if any(part in SKIP_DIRS or part.startswith(".") for part in rel_parts[:-1]):
                continue
            if len(rel_parts) == 1 and rel_parts[0] in ALWAYS_IN_PROMPT:
                continue
            if rel_parts[-1] in FOLDER_GUIDES:
                continue
            if path.is_file():
                yield path

    def rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    def resolve(self, relpath: str) -> Path:
        """Resolve a vault-relative path, refusing anything that escapes.

        The MCP tools take paths from the model, so this is a trust boundary,
        not a convenience.
        """
        candidate = (self.root / relpath).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ValueError("path escapes the vault: " + relpath)
        return candidate

    def find_note(self, relpath: str) -> Path:
        """resolve(), and if a memory note is not where the path says, find it by name.

        Notes are filed by kind (memory/people/, memory/decisions/, ...) and may be
        moved between folders when the vault is tidied; an old path such as
        'memory/x.md' still reaches memory/decisions/x.md when exactly one note has
        that name.
        """
        target = self.resolve(relpath)
        if target.exists() or target.suffix.lower() != ".md":
            return target
        rel = Path(relpath)
        if not rel.parts or rel.parts[0] != "memory":
            return target
        found = [p for p in (self.root / "memory").rglob(rel.name)
                 if p.is_file() and not any(part.startswith(".") for part in p.relative_to(self.root).parts)]
        return found[0] if len(found) == 1 else target

    @staticmethod
    def sha(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]

    # ------------------------------------------------------------ chunking --

    def chunk_file(self, path: Path) -> List[Dict[str, Any]]:
        text = path.read_text(encoding="utf-8", errors="replace")
        rel = self.rel(path)
        return self.chunk_text(text, rel)

    @classmethod
    def chunk_text(cls, text: str, rel: str) -> List[Dict[str, Any]]:
        """Split Markdown into heading-scoped chunks.

        Headings are the author's own segmentation of the document, so they beat
        any fixed window: a chunk that stops at a heading boundary is a chunk
        about one thing.
        """
        sections = cls._split_headings(text)
        chunks: List[Dict[str, Any]] = []
        for heading, body in sections:
            for piece in cls._split_long(body):
                if len(piece.strip()) < MIN_CHUNK_CHARS:
                    continue
                # The embedding sees where the text came from; the stored text
                # stays clean so the UI and the model read the original words.
                context = rel if not heading else rel + " > " + heading
                chunks.append(
                    {
                        "heading": heading,
                        "text": piece.strip(),
                        "embed_text": context + "\n\n" + piece.strip(),
                        "index": len(chunks),
                    }
                )
        return chunks

    @staticmethod
    def _split_headings(text: str):
        sections = []
        stack: List[str] = []
        current: List[str] = []
        heading = ""

        def flush():
            body = "\n".join(current).strip()
            if body:
                sections.append((heading, body))

        for line in text.splitlines():
            match = re.match(r"^(#{1,6})\s+(.*)$", line)
            if match:
                flush()
                current = []
                level = len(match.group(1))
                title = match.group(2).strip()
                stack = stack[: level - 1]
                while len(stack) < level - 1:
                    stack.append("")
                stack.append(title)
                heading = " > ".join(p for p in stack if p)
            else:
                current.append(line)
        flush()
        if not sections:
            body = text.strip()
            return [("", body)] if body else []
        return sections

    @staticmethod
    def _split_long(body: str) -> List[str]:
        if len(body) <= MAX_CHUNK_CHARS:
            return [body]
        paragraphs = re.split(r"\n\s*\n", body)
        pieces: List[str] = []
        buf = ""
        for para in paragraphs:
            if len(para) > MAX_CHUNK_CHARS:
                # A single huge paragraph (a pasted log, a table). Hard-wrap it
                # with overlap so a fact split across the seam is still found.
                if buf:
                    pieces.append(buf)
                    buf = ""
                step = MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS
                for start in range(0, len(para), step):
                    pieces.append(para[start : start + MAX_CHUNK_CHARS])
                continue
            if len(buf) + len(para) + 2 > MAX_CHUNK_CHARS:
                pieces.append(buf)
                buf = para
            else:
                buf = buf + "\n\n" + para if buf else para
        if buf:
            pieces.append(buf)
        return pieces

    # ------------------------------------------------------------- writing --

    def write_note(
        self,
        title: str,
        content: str,
        tags: Optional[List[str]] = None,
        links: Optional[List[str]] = None,
        overwrite: bool = False,
        kind: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create (or replace) one fact under memory/<kind folder>/ and index it in MEMORY.md.

        The file name must be unique across all of memory/ (wikilinks resolve by name),
        so an existing note of that name in another folder counts as taken.
        """
        folder, heading, ntype = kind_folder(kind)
        memory_root = self.root / "memory"
        memory_dir = memory_root / folder
        memory_dir.mkdir(parents=True, exist_ok=True)

        def taken(name: str):
            return [p for p in memory_root.rglob(name + ".md") if p.is_file()]

        slug = slugify(title)
        path = memory_dir / (slug + ".md")
        existing = taken(slug)
        if existing and overwrite:
            path = existing[0]
        elif existing:
            suffix = 2
            while taken(slug + "-" + str(suffix)):
                suffix += 1
            slug = slug + "-" + str(suffix)
            path = memory_dir / (slug + ".md")

        front = ["---", "name: " + slug, "title: " + title.replace("\n", " "), "type: " + ntype]
        if tags:
            front.append("tags: [" + ", ".join(sorted(set(tags))) + "]")
        front.append("created: " + _now())
        front.append("---")

        body = content.strip()
        if links:
            wiki = ", ".join("[[" + slugify(x) + "]]" for x in links)
            body += "\n\nRelated: " + wiki
        path.write_text("\n".join(front) + "\n\n# " + title.strip() + "\n\n" + body + "\n", encoding="utf-8")

        summary = self._first_sentence(content)
        self.add_index_line(slug, summary, heading)
        return {"path": self.rel(path), "slug": slug, "kind": ntype, "created": True}

    def update_note(self, relpath: str, content: str) -> Dict[str, Any]:
        path = self.find_note(relpath)
        if path.suffix.lower() != ".md":
            raise ValueError("only .md files can be written")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return {"path": self.rel(path), "bytes": len(content)}

    def delete_note(self, relpath: str) -> Dict[str, Any]:
        """Move a note to .trash/ rather than unlinking it.

        Memory is expensive to recreate and an agent deleting its own past is
        exactly the mistake worth making reversible.
        """
        path = self.find_note(relpath)
        if not path.is_file():
            raise ValueError("no such note: " + relpath)
        trash = self.root / ".trash"
        trash.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        target = trash / (stamp + "-" + path.name)
        path.replace(target)
        return {"trashed": self.rel(path), "as": target.name}

    @staticmethod
    def _first_sentence(text: str) -> str:
        flat = " ".join(text.strip().split())
        match = re.match(r"^(.{0,160}?[.!?])(\s|$)", flat)
        line = match.group(1) if match else flat[:160]
        return line.strip()

    def add_index_line(self, slug: str, summary: str, section: Optional[str] = None) -> None:
        """Append a pointer under MEMORY.md's index heading.

        MEMORY.md is what gets injected into the system prompt, so a note that
        is not listed here is a note the agent will not know exists. When the
        index is organised in "### <Kind>" subsections and one matches `section`,
        the pointer goes at the top of that subsection; otherwise at the top of
        the index, as before.
        """
        memory_md = self.root / "MEMORY.md"
        line = "- [[" + slug + "]] — " + summary
        if not memory_md.exists():
            memory_md.write_text("# MEMORY\n\n" + INDEX_MARKER + "\n\n" + line + "\n", encoding="utf-8")
            return
        text = memory_md.read_text(encoding="utf-8", errors="replace")
        if "[[" + slug + "]]" in text:
            return
        lines = text.splitlines()
        try:
            at = next(i for i, ln in enumerate(lines) if ln.strip() == INDEX_MARKER)
        except StopIteration:
            memory_md.write_text(text.rstrip() + "\n\n" + INDEX_MARKER + "\n\n" + line + "\n", encoding="utf-8")
            return
        if section:
            # Only inside the index: from its marker to the next "## " heading.
            end = next((i for i in range(at + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
            want = "### " + section.strip().lower()
            sub = next((i for i in range(at + 1, end) if lines[i].strip().lower() == want), None)
            if sub is not None:
                at = sub
        insert = at + 1
        # Skip the italic explainer and any blank lines directly under the
        # heading, then land above the existing pointers.
        while insert < len(lines) and (
            not lines[insert].strip() or lines[insert].lstrip().startswith("_")
        ):
            insert += 1
        block = [line]
        # Keep a blank line before whatever follows. Without it the first
        # pointer ends up flush against the section's --- rule, and MEMORY.md is
        # read by a human as often as by the agent.
        if insert < len(lines) and lines[insert].strip() and not lines[insert].lstrip().startswith("- [["):
            block.append("")
        lines[insert:insert] = block
        memory_md.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def append_worklog(self, entry: str) -> Dict[str, Any]:
        path = self.root / "WORKLOG.md"
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        block = "\n## " + stamp + "\n\n" + entry.strip() + "\n"
        if path.exists():
            path.write_text(path.read_text(encoding="utf-8", errors="replace").rstrip() + "\n" + block, encoding="utf-8")
        else:
            path.write_text("# WORKLOG\n" + block, encoding="utf-8")
        return {"path": "WORKLOG.md", "date": stamp}
