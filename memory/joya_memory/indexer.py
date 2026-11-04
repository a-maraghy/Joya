"""Keep the vector index in step with the vault.

Indexing is incremental and content-addressed: a file whose SHA has not changed
is skipped without embedding anything, so the common case (search after a small
edit) costs one stat per file. There is no daemon and no file watcher -- the MCP
server syncs on startup and before a search, which is cheap enough to do inline
and removes a whole class of "the index is stale" bugs.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .store import MemoryStore
from .vault import Vault


def sync(
    vault: Vault,
    store: MemoryStore,
    force: bool = False,
    progress: Optional[Any] = None,
) -> Dict[str, Any]:
    seen = set()
    indexed = 0
    skipped = 0
    chunks_written = 0

    for path in vault.iter_markdown():
        rel = vault.rel(path)
        seen.add(rel)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        sha = vault.sha(text)
        state = store.file_state(rel)
        if state is not None and state["sha"] == sha and not force:
            skipped += 1
            continue
        chunks = vault.chunk_text(text, rel)
        mtime = path.stat().st_mtime
        chunks_written += store.put_file(rel, sha, mtime, chunks)
        indexed += 1
        if progress:
            progress(rel, len(chunks))

    removed = 0
    for rel in store.known_paths():
        if rel not in seen:
            store.drop_file(rel)
            removed += 1

    return {
        "indexed": indexed,
        "skipped": skipped,
        "removed": removed,
        "chunks": chunks_written,
    }
