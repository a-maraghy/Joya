"""Command line front end -- what the dashboard's privileged helper shells out to.

Everything prints a single JSON object on stdout so the caller never has to
parse prose. Exit status is 0 on success, 1 on a handled error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .indexer import sync
from .store import MemoryStore
from .vault import Vault


def _paths(args):
    vault = args.vault or os.environ.get("JOYA_VAULT")
    db = args.db or os.environ.get("JOYA_VECTOR_DB")
    if not vault or not db:
        raise SystemExit("--vault and --db (or JOYA_VAULT / JOYA_VECTOR_DB) required")
    return Vault(vault), MemoryStore(db)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="joya-memory", description=__doc__)
    parser.add_argument("--vault")
    parser.add_argument("--db")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_index = sub.add_parser("index", help="sync the vector index with the vault")
    p_index.add_argument("--force", action="store_true", help="re-embed everything")

    p_search = sub.add_parser("search", help="hybrid search over the vault")
    p_search.add_argument("query", nargs="+")
    p_search.add_argument("--limit", type=int, default=8)

    sub.add_parser("stats", help="index size and model")
    sub.add_parser("warm", help="download and load the embedding model")

    args = parser.parse_args(argv)

    try:
        if args.cmd == "warm":
            from . import embed

            print(json.dumps({"ok": True, "data": {"model": embed.warm()}}))
            return 0

        vault, store = _paths(args)

        if args.cmd == "index":
            result = sync(vault, store, force=args.force)
            result.update(store.stats())
            print(json.dumps({"ok": True, "data": result}))
        elif args.cmd == "search":
            sync(vault, store)
            hits = store.search(" ".join(args.query), args.limit)
            print(json.dumps({"ok": True, "data": [h.to_dict() for h in hits]}))
        elif args.cmd == "stats":
            print(json.dumps({"ok": True, "data": store.stats()}))
        return 0
    except Exception as exc:  # surfaced to the dashboard, so keep it structured
        print(json.dumps({"ok": False, "error": type(exc).__name__ + ": " + str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
