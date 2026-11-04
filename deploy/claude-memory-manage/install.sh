#!/usr/bin/env bash
# Memory management (Agents & sessions > Memory > Sessions) for claude-memory.
#
# /opt/claude-memory is not a git repository, so the change ships as a patch:
#   claude-memory.patch  hide-aware reads in app.py (/search), mcp_server.py (keyword
#                        fallback), memlib/facts.py (memory_session, fact extraction,
#                        pending sessions); ingest.py skips excluded sessions and
#                        tombstoned chunks; hooklib.py / mcp_server.py take an optional
#                        CLAUDE_MEMORY_SERVICE (and hooklib CLAUDE_MEMORY_HOOK_LOG) so the
#                        tests can point them at a scratch service; schema.sql documents it.
#   migrate.sql          chunks.hidden, excluded_sessions, memory_tombstones (idempotent).
#
# Steps: back up the code and the database, migrate (additive; the old code keeps working),
# patch, compile-check, restart claude-memory and wait for /health. Run as root:
#   bash deploy/claude-memory-manage/install.sh            # do it
#   bash deploy/claude-memory-manage/install.sh --check    # only say what would happen
# Rollback: the script prints the exact commands (restore the code tarball, restart).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The overrides exist for the installer's own test (a scratch copy and a scratch database).
ROOT="${CM_ROOT:-/opt/claude-memory}"
DBENV="${CM_DBENV:-/root/.claude-memory/db.env}"
PGDB_OVERRIDE="${CM_PGDATABASE:-}"
PATCH="$HERE/claude-memory.patch"
STAMP="$(date +%Y%m%d_%H%M%S)"
BK="${CM_BACKUPS:-/root/backups}/claude-memory_pre_manage_$STAMP"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$PATCH" ] && [ -f "$HERE/migrate.sql" ] || { echo "patch or migration missing next to this script" >&2; exit 1; }

applied=0
if grep -q "memory_tombstones" "$ROOT/ingest.py" 2>/dev/null; then
  applied=1
  echo "code: already patched"
else
  (cd "$ROOT" && patch -p1 --dry-run --forward -s < "$PATCH") || { echo "the patch does not apply cleanly to $ROOT; nothing changed" >&2; exit 1; }
  echo "code: patch applies cleanly"
fi
if [ "${1:-}" = "--check" ]; then echo "check only: nothing changed"; exit 0; fi

mkdir -p "$BK"
chmod 700 "$BK"
tar czf "$BK/opt-claude-memory.tgz" --exclude="$(basename "$ROOT")/venv" --exclude="$(basename "$ROOT")/models" \
  --exclude='__pycache__' -C "$(dirname "$ROOT")" "$(basename "$ROOT")"
db() { ( set -a; . "$DBENV"; [ -z "$PGDB_OVERRIDE" ] || PGDATABASE="$PGDB_OVERRIDE"; set +a; "$@" ); }
db pg_dump -Fc -f "$BK/claude_memory.dump"
echo "backup: $BK (code tarball + pg_dump)"

db psql -v ON_ERROR_STOP=1 -q -f "$HERE/migrate.sql"
echo "database: migrated (chunks.hidden, excluded_sessions, memory_tombstones)"

if [ "$applied" -eq 0 ]; then
  (cd "$ROOT" && patch -p1 --forward -s --no-backup-if-mismatch < "$PATCH")
  echo "code: patched"
fi
PY="$ROOT/venv/bin/python"; [ -x "$PY" ] || PY=/opt/claude-memory/venv/bin/python
"$PY" -m py_compile "$ROOT/app.py" "$ROOT/ingest.py" "$ROOT/mcp_server.py" \
  "$ROOT/memlib/facts.py" "$ROOT/hooks/hooklib.py" "$ROOT/hooks/memhook.py"

if [ -n "${CM_NO_RESTART:-}" ]; then echo "restart skipped (CM_NO_RESTART)"; exit 0; fi
systemctl restart claude-memory
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8765/health | grep -q '"ok":true'; then
    echo "claude-memory: healthy"
    break
  fi
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:8765/health | grep -q '"ok":true' || {
  echo "claude-memory did not come back healthy; roll back with the commands below" >&2
}
cat <<MSG
Done. Claude Code sessions that are already open keep their old MCP server (memory_session
and the keyword fallback) until they restart; /search and every hook use the new code now.
Rollback (the database additions are harmless to the old code and can stay):
  tar xzf $BK/opt-claude-memory.tgz -C $(dirname "$ROOT") && systemctl restart claude-memory
MSG
