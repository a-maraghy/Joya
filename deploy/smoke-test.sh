#!/usr/bin/env bash
#
# End-to-end check of the memory stack against a throwaway vault.
#
#   sudo bash /opt/joya/deploy/smoke-test.sh
#
# Proves the four things that actually break: sqlite-vec loads, the embedding
# model runs, indexing produces chunks, and hybrid search returns the right note
# for a query that shares no words with it.

set -euo pipefail

RUNTIME=/opt/joya-agents/runtime
SHARED=/opt/joya-agents/shared
PY="$RUNTIME/venv/bin/python"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
pass() { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m FAIL\033[0m %s\n' "$*"; exit 1; }

[[ -x "$PY" ]] || fail "no runtime venv at $PY -- run bootstrap.sh first"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
chmod 0777 "$TMP"
VAULT="$TMP/vault"
mkdir -p "$VAULT/memory"

cat > "$VAULT/MEMORY.md" <<'EOF'
# MEMORY

## Memory index

- [[release-procedure]] — how we ship
EOF

cat > "$VAULT/memory/release-procedure.md" <<'EOF'
---
name: release-procedure
---
# Release procedure

## Steps

We ship on Thursdays. Tag the commit, wait for the pipeline to go green, then
promote the build to production. Never promote on a Friday: nobody is around to
roll it back over the weekend.

## Rollback

Rollback is `promote --to previous`, which takes about ninety seconds.
EOF

cat > "$VAULT/memory/error-codes.md" <<'EOF'
---
name: error-codes
---
# Error codes

`ERR_TIMEOUT_4471` means the upstream inventory service did not answer within
the eight second budget. It is almost always the warehouse VPN flapping.
EOF

chmod -R 0777 "$TMP"

RUN() {
  runuser -u joyaagent -- env \
    JOYA_VAULT="$VAULT" \
    JOYA_VECTOR_DB="$TMP/vectors/memory.db" \
    JOYA_MODEL_CACHE="$SHARED/models" \
    HOME="$SHARED/home" \
    "$PY" -m joya_memory.cli "$@"
}

say "Indexing the vault (MEMORY.md is prompt-injected, so it is not indexed)"
OUT=$(RUN index) || fail "index crashed: $OUT"
echo "$OUT" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
assert d["ok"], d
data=d["data"]
assert data["chunks"] > 0, "no chunks were produced"
assert data["files"] == 2, "expected 2 indexed files (MEMORY.md is prompt-injected, not indexed), got %s" % data["files"]
print("  indexed %d files into %d chunks with %s" % (data["files"], data["chunks"], data["model"]))
' || fail "index result was wrong"
pass "indexing"

say "Semantic search: a query sharing no words with the answer"
# "how do we put code live" has no term in common with "release procedure".
# Only the embeddings can connect them, so this fails if the vector half is dead.
OUT=$(RUN search --limit 3 how do we put code live) || fail "search crashed: $OUT"
echo "$OUT" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
assert d["ok"], d
hits=d["data"]
assert hits, "no hits at all"
top=hits[0]["path"]
assert "release-procedure" in top, "top hit was %s, expected release-procedure" % top
print("  top hit: %s (score %.4f)" % (top, hits[0]["score"]))
' || fail "semantic search did not find the right note"
pass "vector search"

say "Keyword search: an exact token embeddings would lose"
OUT=$(RUN search --limit 3 ERR_TIMEOUT_4471) || fail "search crashed: $OUT"
echo "$OUT" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)
assert d["ok"], d
hits=d["data"]
assert hits, "no hits at all"
assert "error-codes" in hits[0]["path"], "top hit was %s" % hits[0]["path"]
print("  top hit: %s" % hits[0]["path"])
' || fail "keyword search did not find the exact token"
pass "keyword search"

say "Incremental reindex skips unchanged files"
OUT=$(RUN index) || fail "reindex crashed"
echo "$OUT" | "$PY" -c '
import json,sys
d=json.load(sys.stdin)["data"]
assert d["indexed"] == 0, "re-indexed %d unchanged files" % d["indexed"]
assert d["skipped"] == 2, "skipped %d, expected 2" % d["skipped"]
print("  skipped all 2 unchanged files")
' || fail "incremental indexing re-embedded unchanged files"
pass "incremental indexing"

say "All checks passed."
