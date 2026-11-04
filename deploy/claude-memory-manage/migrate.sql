-- claude-memory: memory management from the dashboard (Agents & sessions > Memory > Sessions).
-- Idempotent: safe to run again. Run as the tables' owner (claude_mem), e.g. through install.sh.
--
--   chunks.hidden       a hidden chunk is kept but never searched (/search, the memory_search
--                       fallback), injected (hooks), shown by memory_session, extracted into
--                       facts or drawn in the dashboard graph. Facts need no column: a hidden
--                       fact is a retracted one (superseded_by = id), as memory_forget does it.
--   excluded_sessions   sessions deleted from the dashboard; ingest.py never indexes them again.
--   memory_tombstones   content_hash of chunks deleted one by one; ingest.py never re-creates them.
--
-- ADD COLUMN with a constant default is a catalogue change in Postgres 16 (no table rewrite);
-- lock_timeout keeps it from queueing behind a long ingest transaction.

SET lock_timeout = '10s';

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS chunks_hidden ON chunks (session_id) WHERE hidden;

CREATE TABLE IF NOT EXISTS excluded_sessions (
    session_id    text PRIMARY KEY,
    excluded_at   timestamptz NOT NULL DEFAULT now(),
    excluded_by   text,
    reason        text,
    files_deleted boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS memory_tombstones (
    content_hash text PRIMARY KEY,
    session_id   text,
    deleted_at   timestamptz NOT NULL DEFAULT now(),
    deleted_by   text
);
