"""SQLite-backed vector + keyword store for one agent's memory vault.

One file per agent (``vectors/memory.db``). Nothing here is shared between
agents -- an agent can only ever search its own memory.

Retrieval is hybrid: dense vectors catch paraphrase ("what did we decide about
billing" finds "invoice policy"), FTS5 catches exact tokens that embeddings
routinely miss (error codes, flag names, IDs). The two rankings are merged with
reciprocal rank fusion, which needs no score calibration between them.
"""

from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from . import embed

RRF_K = 60  # rank-fusion damping; 60 is the value from the original RRF paper


@dataclass
class Hit:
    path: str
    heading: str
    text: str
    score: float
    chunk_index: int

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class MemoryStore:
    def __init__(self, db_path, dim: Optional[int] = None):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.dim = dim or embed.dimensions()
        self._conn: Optional[sqlite3.Connection] = None

    # ------------------------------------------------------------ plumbing --

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = self._open()
        return self._conn

    def _open(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.enable_load_extension(True)
        try:
            import sqlite_vec

            sqlite_vec.load(conn)
        finally:
            # Leaving extension loading enabled would let any later SQL string
            # load an arbitrary shared object. Close the door again immediately.
            conn.enable_load_extension(False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        self._migrate(conn)
        return conn

    def _migrate(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS files (
              path       TEXT PRIMARY KEY,
              sha        TEXT NOT NULL,
              mtime      REAL,
              chunks     INTEGER NOT NULL DEFAULT 0,
              indexed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chunks (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              path        TEXT NOT NULL,
              heading     TEXT NOT NULL DEFAULT '',
              chunk_index INTEGER NOT NULL DEFAULT 0,
              text        TEXT NOT NULL,
              indexed_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);

            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
              USING fts5(text, chunk_id UNINDEXED, tokenize='porter unicode61');

            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            """
        )
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec "
            "USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[%d])" % self.dim
        )
        conn.execute(
            "INSERT INTO meta(k, v) VALUES('embed_model', ?) "
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            (embed.model_name(),),
        )
        conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------- writing --

    def file_state(self, path: str) -> Optional[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM files WHERE path = ?", (path,)
        ).fetchone()

    def known_paths(self) -> List[str]:
        return [r["path"] for r in self.conn.execute("SELECT path FROM files")]

    def drop_file(self, path: str) -> None:
        cur = self.conn
        ids = [
            r["id"] for r in cur.execute("SELECT id FROM chunks WHERE path = ?", (path,))
        ]
        for cid in ids:
            cur.execute("DELETE FROM chunks_vec WHERE chunk_id = ?", (cid,))
            cur.execute("DELETE FROM chunks_fts WHERE chunk_id = ?", (cid,))
        cur.execute("DELETE FROM chunks WHERE path = ?", (path,))
        cur.execute("DELETE FROM files WHERE path = ?", (path,))
        cur.commit()

    def put_file(
        self,
        path: str,
        sha: str,
        mtime: float,
        chunks: Sequence[Dict[str, Any]],
    ) -> int:
        """Replace everything stored for one file. Embeds in a single batch."""
        import sqlite_vec

        # Embed the context-prefixed form (path > heading > text) but store and
        # display the original words -- a chunk read back should look like what
        # the human wrote, not like what the retriever needed.
        texts = [c.get("embed_text") or c["text"] for c in chunks]
        vectors = embed.embed_documents(texts) if texts else []

        cur = self.conn
        self.drop_file(path)
        for chunk, vector in zip(chunks, vectors):
            cursor = cur.execute(
                "INSERT INTO chunks(path, heading, chunk_index, text, indexed_at) "
                "VALUES(?,?,?,?,?)",
                (
                    path,
                    chunk.get("heading", ""),
                    chunk.get("index", 0),
                    chunk["text"],
                    _now(),
                ),
            )
            cid = cursor.lastrowid
            cur.execute(
                "INSERT INTO chunks_vec(chunk_id, embedding) VALUES(?, ?)",
                (cid, sqlite_vec.serialize_float32(vector)),
            )
            cur.execute(
                "INSERT INTO chunks_fts(text, chunk_id) VALUES(?, ?)",
                (chunk["text"], cid),
            )
        cur.execute(
            "INSERT INTO files(path, sha, mtime, chunks, indexed_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(path) DO UPDATE SET sha=excluded.sha, mtime=excluded.mtime, "
            "chunks=excluded.chunks, indexed_at=excluded.indexed_at",
            (path, sha, mtime, len(chunks), _now()),
        )
        cur.commit()
        return len(chunks)

    # ----------------------------------------------------------- searching --

    @staticmethod
    def _fts_query(raw: str) -> str:
        """Turn free text into an FTS5 expression.

        User text cannot go straight into MATCH: a stray quote, or the bare word
        NEAR, is a syntax error rather than a search.
        """
        tokens = re.findall(r"[A-Za-z0-9_./-]{2,}", raw)
        if not tokens:
            return ""
        quoted = []
        for token in tokens[:24]:
            quoted.append(chr(34) + token.replace(chr(34), "") + chr(34))
        return " OR ".join(quoted)

    def search(self, query: str, limit: int = 8, candidates: int = 40) -> List[Hit]:
        if not query.strip():
            return []
        if not self.conn.execute("SELECT 1 FROM chunks LIMIT 1").fetchone():
            return []

        import sqlite_vec

        ranks: Dict[int, float] = {}

        vector = embed.embed_query(query)
        rows = self.conn.execute(
            "SELECT chunk_id FROM chunks_vec WHERE embedding MATCH ? AND k = ? "
            "ORDER BY distance",
            (sqlite_vec.serialize_float32(vector), candidates),
        ).fetchall()
        for rank, row in enumerate(rows):
            cid = row["chunk_id"]
            ranks[cid] = ranks.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)

        expr = self._fts_query(query)
        if expr:
            try:
                rows = self.conn.execute(
                    "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? "
                    "ORDER BY bm25(chunks_fts) LIMIT ?",
                    (expr, candidates),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            for rank, row in enumerate(rows):
                cid = row["chunk_id"]
                ranks[cid] = ranks.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)

        if not ranks:
            return []
        top = sorted(ranks.items(), key=lambda kv: kv[1], reverse=True)[:limit]
        placeholders = ",".join("?" for _ in top)
        rows = self.conn.execute(
            "SELECT id, path, heading, chunk_index, text FROM chunks "
            "WHERE id IN (%s)" % placeholders,
            [cid for cid, _ in top],
        ).fetchall()
        by_id = {r["id"]: r for r in rows}
        hits = []
        for cid, score in top:
            row = by_id.get(cid)
            if row is None:
                continue
            hits.append(
                Hit(
                    path=row["path"],
                    heading=row["heading"],
                    text=row["text"],
                    score=round(score, 6),
                    chunk_index=row["chunk_index"],
                )
            )
        return hits

    # --------------------------------------------------------------- stats --

    def stats(self) -> Dict[str, Any]:
        files = self.conn.execute("SELECT COUNT(*) n FROM files").fetchone()["n"]
        chunks = self.conn.execute("SELECT COUNT(*) n FROM chunks").fetchone()["n"]
        last = self.conn.execute("SELECT MAX(indexed_at) t FROM files").fetchone()["t"]
        model = self.conn.execute(
            "SELECT v FROM meta WHERE k='embed_model'"
        ).fetchone()
        size = self.db_path.stat().st_size if self.db_path.exists() else 0
        return {
            "files": files,
            "chunks": chunks,
            "last_indexed": last,
            "model": model["v"] if model else embed.model_name(),
            "dimensions": self.dim,
            "db_bytes": size,
            "db_path": str(self.db_path),
        }
