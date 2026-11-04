"""MCP server exposing one agent's memory vault to Claude.

Launched over stdio by the agent runtime, one process per agent, pointed at that
agent's vault and vector database by environment variables. An agent therefore
has no way to address another agent's memory: the isolation is in the process,
not in a parameter the model could get wrong.

    JOYA_VAULT      path to the agent's Obsidian vault
    JOYA_VECTOR_DB  path to that agent's vectors/memory.db

MEMORY.md is already injected into the system prompt on every request, so these
tools exist for what does not fit there: searching the long tail of notes, and
writing new ones durably.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import List, Optional

try:
    # mcp >= 2.0 renamed FastMCP to MCPServer. The surface we use -- the
    # constructor, the .tool() decorator and .run(transport=...) -- is identical
    # in both, so one import is the whole compatibility story.
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server

from .indexer import sync
from .store import MemoryStore
from .vault import Vault

VAULT_PATH = os.environ.get("JOYA_VAULT", "")
DB_PATH = os.environ.get("JOYA_VECTOR_DB", "")

mcp = _Server("memory")

_vault: Optional[Vault] = None
_store: Optional[MemoryStore] = None
_lock = asyncio.Lock()
_synced = False


def _require_paths() -> None:
    if not VAULT_PATH or not DB_PATH:
        raise RuntimeError(
            "JOYA_VAULT and JOYA_VECTOR_DB must be set; this server is started "
            "per agent by the JOYA agent runtime."
        )


def _components():
    global _vault, _store
    _require_paths()
    if _vault is None:
        _vault = Vault(VAULT_PATH)
    if _store is None:
        _store = MemoryStore(DB_PATH)
    return _vault, _store


async def _ensure_current(force: bool = False):
    """Bring the index up to date before reading from it.

    Held under a lock because two concurrent tool calls re-embedding the same
    file would race on the same rows.
    """
    global _synced
    async with _lock:
        vault, store = _components()
        if _synced and not force:
            return vault, store
        await asyncio.to_thread(sync, vault, store, force)
        _synced = True
        return vault, store


def _dirty() -> None:
    """Mark the index stale after a write so the next read re-syncs."""
    global _synced
    _synced = False


# ------------------------------------------------------------------ tools ---


@mcp.tool()
async def memory_search(query: str, limit: int = 6) -> str:
    """Search this agent's long-term memory vault.

    Use it before answering anything that depends on earlier work, decisions,
    credentials-free environment details, or preferences -- MEMORY.md holds only
    the index, and the detail lives in the notes this searches.

    Args:
        query: What you are trying to recall, in natural language.
        limit: Maximum notes to return (1-20).

    Returns:
        JSON array of {path, heading, score, text}, most relevant first.
    """
    limit = max(1, min(20, int(limit)))
    vault, store = await _ensure_current()
    hits = await asyncio.to_thread(store.search, query, limit)
    return json.dumps([h.to_dict() for h in hits], ensure_ascii=False, indent=2)


@mcp.tool()
async def memory_write(
    title: str,
    content: str,
    tags: Optional[List[str]] = None,
    links: Optional[List[str]] = None,
    kind: str = "fact",
) -> str:
    """Record one durable fact as its own note, and index it in MEMORY.md.

    Write when you finish a piece of work, make or receive a decision, learn
    something that cost you time, or change the environment. One fact per note.
    If a fact is now wrong, correct its note rather than adding a contradicting
    one.

    Args:
        title: Short noun phrase naming the fact. Becomes the filename.
        content: The fact itself, in Markdown. Include why, not just what.
        tags: Optional tags for Obsidian.
        links: Optional titles of related notes; rendered as [[wikilinks]].
        kind: What the note is about, which decides its folder: "person",
            "project", "decision", "preference", "lesson" (a gotcha and its fix)
            or "fact" (the default) -> memory/people/, memory/projects/,
            memory/decisions/, memory/preferences/, memory/lessons/, memory/facts/.

    Returns:
        JSON with the created path.
    """
    vault, store = _components()
    result = await asyncio.to_thread(vault.write_note, title, content, tags, links, False, kind)
    _dirty()
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def memory_read(path: str) -> str:
    """Read one note from the vault verbatim.

    Args:
        path: Vault-relative path, e.g. 'memory/decisions/billing-policy.md'.
            A note moved to another kind folder is still found by its name.
    """
    vault, _ = _components()
    target = vault.find_note(path)
    if not target.is_file():
        return "Error: no such note: " + path
    return target.read_text(encoding="utf-8", errors="replace")


@mcp.tool()
async def memory_update(path: str, content: str) -> str:
    """Replace the full contents of an existing note.

    Prefer this over writing a second note when a fact has changed: stacked
    contradictions are how a memory becomes useless.

    Args:
        path: Vault-relative path to the note.
        content: The complete new Markdown content.
    """
    vault, _ = _components()
    result = await asyncio.to_thread(vault.update_note, path, content)
    _dirty()
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def memory_delete(path: str) -> str:
    """Move a note to the vault's .trash/ folder. Reversible by hand.

    Args:
        path: Vault-relative path to the note.
    """
    vault, _ = _components()
    result = await asyncio.to_thread(vault.delete_note, path)
    _dirty()
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def memory_list(subdir: str = "memory") -> str:
    """List the notes in the vault with their sizes.

    Args:
        subdir: Vault-relative folder to list. Use '.' for the whole vault.
    """
    vault, _ = _components()
    root = vault.resolve(subdir)
    if not root.is_dir():
        return "Error: no such folder: " + subdir
    out = []
    for path in sorted(root.rglob("*.md")):
        out.append({"path": vault.rel(path), "bytes": path.stat().st_size})
    return json.dumps(out, ensure_ascii=False, indent=2)


@mcp.tool()
async def memory_worklog(entry: str) -> str:
    """Append a short dated entry to WORKLOG.md -- the narrative of what you did.

    Args:
        entry: One or two sentences describing the work just completed.
    """
    vault, _ = _components()
    result = await asyncio.to_thread(vault.append_worklog, entry)
    _dirty()
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def memory_stats() -> str:
    """Report index size, embedding model, and when the vault was last indexed."""
    _, store = await _ensure_current()
    stats = await asyncio.to_thread(store.stats)
    return json.dumps(stats, ensure_ascii=False, indent=2)


@mcp.tool()
async def memory_reindex() -> str:
    """Rebuild the vector index from the vault files. Files always win."""
    _, store = await _ensure_current(force=True)
    stats = await asyncio.to_thread(store.stats)
    return json.dumps(stats, ensure_ascii=False, indent=2)


def main() -> None:
    _require_paths()
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
