#!/opt/claude-memory/venv/bin/python
"""End-to-end test of memory management against a SCRATCH copy of claude_memory.

    /opt/claude-memory/venv/bin/python dashboard/tools/test-memory-manage-db.py [--db NAME] [--make] [--drop]

  --db NAME   the scratch database (default claude_memory_test). Never "claude_memory".
  --make      create it first: pg_dump of the live database | psql (read-only on live)
  --drop      drop it at the end

What runs, and against what:
  * the claude-memory code is a temporary copy of /opt/claude-memory with this repo's
    deploy/claude-memory-manage/claude-memory.patch applied (paths rewritten to the copy);
    its /search service runs on 127.0.0.1:8766 against the scratch database;
  * the scratch database gets deploy/claude-memory-manage/migrate.sql (twice: idempotent);
  * hide / unhide / delete go through the dashboard's real helper (dashboard/deploy/joya-helper,
    loaded as a module) with its bridge pointed at the scratch database, and its Claude homes,
    JOYA AI state, audit log and caches pointed at temp files;
  * every read path is then asked whether it still sees what was hidden or deleted:
    /search, the UserPromptSubmit / SessionStart / PreToolUse hooks, the MCP server's
    memory_search (and its keyword fallback) and memory_session, the dashboard graph,
    pending fact extraction, and ingest.py (exclusions and tombstones).

Needs root (db.env, sudo to postgres for --make/--drop) and the claude-memory venv. The live
database is only read (by --make) and its signature is compared before and after.
"""
import argparse
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
HELPER = os.path.join(REPO, "dashboard", "deploy", "joya-helper")
PATCH = os.path.join(REPO, "deploy", "claude-memory-manage", "claude-memory.patch")
MIGRATE = os.path.join(REPO, "deploy", "claude-memory-manage", "migrate.sql")
LIVE_ROOT = "/opt/claude-memory"
DBENV = "/root/.claude-memory/db.env"
PY = LIVE_ROOT + "/venv/bin/python"

ap = argparse.ArgumentParser()
ap.add_argument("--db", default="claude_memory_test")
ap.add_argument("--port", type=int, default=8766)
ap.add_argument("--make", action="store_true")
ap.add_argument("--drop", action="store_true")
ARGS = ap.parse_args()
DB = ARGS.db
if DB == "claude_memory" or not re.match(r"^claude_memory_[a-z0-9_]{1,40}$", DB):
    sys.exit("refusing: --db must be a scratch copy named claude_memory_<something>, never claude_memory")
if os.geteuid() != 0:
    sys.exit("run as root")

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + ("\n       " + str(detail)[:400] if detail else ""))


def dbenv(dbname):
    env = {}
    for line in open(DBENV):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip().removeprefix("export ").strip()] = v.strip().strip('"').strip("'")
    env["PGDATABASE"] = dbname
    return env


def pg(dbname):
    import psycopg
    e = dbenv(dbname)
    return psycopg.connect(host=e.get("PGHOST"), port=e.get("PGPORT"), dbname=dbname, user=e.get("PGUSER"),
                           password=e.get("PGPASSWORD"), autocommit=True)


def as_postgres(argv, **kw):
    return subprocess.run(["runuser", "-u", "postgres", "--"] + argv, check=True, **kw)


def live_signature():
    with pg("claude_memory") as c:
        r = c.execute("SELECT count(*) FILTER (WHERE superseded_by = id), "
                      "to_regclass('excluded_sessions') IS NOT NULL, to_regclass('memory_tombstones') IS NOT NULL, "
                      "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chunks' "
                      "AND column_name = 'hidden') FROM facts").fetchone()
        tomb = c.execute("SELECT count(*) FROM memory_tombstones").fetchone()[0] if r[2] else None
        excl = c.execute("SELECT count(*) FROM excluded_sessions").fetchone()[0] if r[1] else None
        hidden = c.execute("SELECT count(*) FROM chunks WHERE hidden").fetchone()[0] if r[3] else None
    return {"forgotten": r[0], "tombstones": tomb, "excluded": excl, "hidden_chunks": hidden}


# ------------------------------------------------------------------ setup
print("setup")
LIVE_BEFORE = live_signature()
if ARGS.make:
    exists = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-Atc",
                             "SELECT 1 FROM pg_database WHERE datname = '%s'" % DB],
                            capture_output=True, text=True).stdout.strip()
    if exists:
        sys.exit("--make: %s already exists; drop it or leave out --make" % DB)
    as_postgres(["createdb", "-O", "claude_mem", DB])
    dump = subprocess.Popen(["runuser", "-u", "postgres", "--", "pg_dump", "--no-owner", "claude_memory"],
                            stdout=subprocess.PIPE)
    as_postgres(["psql", "-q", "-d", DB], stdin=dump.stdout, stdout=subprocess.DEVNULL)
    dump.wait()
    stmts = ["ALTER TABLE %s OWNER TO claude_mem" % t for t in ("chunks", "facts", "ingest_state")] + [
        "ALTER SEQUENCE chunks_id_seq OWNER TO claude_mem", "ALTER SEQUENCE facts_id_seq OWNER TO claude_mem",
        "ALTER SCHEMA public OWNER TO claude_mem"]
    for s in stmts:
        as_postgres(["psql", "-q", "-d", DB, "-c", s])
with pg(DB) as c:
    check("connected to the scratch database, not live", c.execute("SELECT current_database()").fetchone()[0] == DB)
for _ in range(2):
    r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-q", "-f", MIGRATE], env={**os.environ, **dbenv(DB)},
                       capture_output=True, text=True)
check("migrate.sql runs twice on the scratch copy (idempotent)", r.returncode == 0, r.stderr)

TMP = tempfile.mkdtemp(prefix="mm-db-test-")
CM = os.path.join(TMP, "claude-memory")
os.makedirs(CM)
for name in ("app.py", "ingest.py", "mcp_server.py", "schema.sql", "extract_facts.py", "config.json", "embedder.py", "README.md"):
    shutil.copy2(os.path.join(LIVE_ROOT, name), CM)
for sub in ("memlib", "hooks"):
    os.makedirs(os.path.join(CM, sub))
    for name in os.listdir(os.path.join(LIVE_ROOT, sub)):
        if name.endswith(".py"):
            shutil.copy2(os.path.join(LIVE_ROOT, sub, name), os.path.join(CM, sub))
os.symlink(LIVE_ROOT + "/venv", os.path.join(CM, "venv"))
r = subprocess.run(["patch", "-p1", "-s", "--forward"], cwd=CM, stdin=open(PATCH), capture_output=True, text=True)
check("the repo's patch applies to a copy of /opt/claude-memory", r.returncode == 0, r.stdout + r.stderr)
# Point the copy at itself (the hooks and the MCP server hard-code /opt/claude-memory).
for rel in ("hooks/memhook.py", "hooks/hooklib.py", "mcp_server.py"):
    p = os.path.join(CM, rel)
    s = open(p, newline="").read().replace('"/opt/claude-memory', '"' + CM)
    open(p, "w", newline="").write(s)
SERVICE = "http://127.0.0.1:%d" % ARGS.port
APP_ENV = {**os.environ, **dbenv(DB), "CLAUDE_MEMORY_CONFIG": os.path.join(CM, "config.json"),
           "HF_HUB_OFFLINE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
APP_ENV.pop("CLAUDE_MEMORY_INTERNAL", None)
app = subprocess.Popen([LIVE_ROOT + "/venv/bin/uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(ARGS.port),
                        "--workers", "1", "--no-access-log"], cwd=CM, env=APP_ENV,
                       stdout=subprocess.DEVNULL, stderr=open(os.path.join(TMP, "app.log"), "w"))


def http(path, payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(SERVICE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


up = False
for _ in range(90):
    try:
        if http("/health", timeout=2).get("ok"):
            up = True
            break
    except Exception:
        time.sleep(1)
check("the patched /search service runs on the scratch copy", up, open(os.path.join(TMP, "app.log")).read()[-500:])
if not up:
    app.kill()
    sys.exit(1)


def search(q, k=30):
    return http("/search", {"query": q, "k": k})["results"]


def has(results, kind, rid):
    return any(h["kind"] == kind and h["id"] == rid for h in results)


# The helper, as a module, pointed at the scratch database and temp files.
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", HELPER))
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)
H.CC_BRIDGE_ENV = {"PGDATABASE": DB}
H.AUDIT_LOG = os.path.join(TMP, "audit.log")
H.CC_CACHE = os.path.join(TMP, "cache")
H.CC_GRAPH_SEM = os.path.join(H.CC_CACHE, "graph-sem.json")
H.CC_INGEST_PY = os.path.join(CM, "ingest.py")
H.CC_JOYA_STATE = os.path.join(TMP, "joya-state.json")
H.CC_JOYA_LEDGER = os.path.join(TMP, "no-ledger.db")
HOMES = os.path.join(TMP, "homes")
H.CC_HOMES = {
    "root": {"label": "Desktop / CLI (root)", "base": os.path.join(HOMES, "root"),
             "projects": os.path.join(HOMES, "root", "projects"), "writable": True},
    "winarchive": {"label": "Windows archive", "base": None,
                   "projects": os.path.join(HOMES, "win"), "writable": False},
}
for p in (H.CC_HOMES["root"]["projects"], H.CC_HOMES["winarchive"]["projects"], os.path.join(HOMES, "root", "sessions")):
    os.makedirs(p)


def helper(fn, payload):
    """Call a helper core function; (True, data) or (False, error text)."""
    try:
        return True, fn(payload)
    except SystemExit:
        return False, "fail()"
    except H.CCError as exc:
        return False, str(exc)


def bridge(op, **kw):
    return H.cc_bridge(op, **kw)


# ------------------------------------------------------- pick real targets
print("targets")
with pg(DB) as c:
    sessions = c.execute(
        "SELECT ch.session_id FROM chunks ch JOIN facts f ON f.source_session = ch.session_id "
        "WHERE ch.source = 'transcript' GROUP BY ch.session_id "
        "HAVING count(DISTINCT ch.id) BETWEEN 15 AND 400 AND count(DISTINCT f.id) FILTER (WHERE f.superseded_by IS NULL) >= 5 "
        "ORDER BY count(DISTINCT f.id) DESC").fetchall()
inject = json.load(open(os.path.join(CM, "config.json"))).get("inject", {})
EXCL_S = set(inject.get("exclude_sessions", []))
EXCL_KW = [k.lower() for k in inject.get("exclude_keywords", [])]
EXCL_T = tuple(inject.get("exclude_topic_prefixes", []))
SID = next(s[0] for s in sessions if s[0] not in EXCL_S)
print("  session", SID[:8])


def clean(text):
    low = (text or "").lower()
    return not any(k in low for k in EXCL_KW)


CHUNK = FACT = None
with pg(DB) as c:
    for cid, content in c.execute(
            "SELECT id, content FROM chunks WHERE session_id = %s AND NOT hidden AND length(content) > 400 "
            "ORDER BY id DESC LIMIT 60", (SID,)).fetchall():
        q = content[:300]
        if clean(content) and has(search(q, 14), "chunk", cid):
            CHUNK = (cid, q)
            break
    for fid, content, topic in c.execute(
            "SELECT id, content, topic FROM facts WHERE source_session = %s AND superseded_by IS NULL "
            "ORDER BY ts DESC LIMIT 60", (SID,)).fetchall():
        if clean(content) and not (topic or "").startswith(EXCL_T) and has(search(content, 14), "fact", fid):
            FACT = (fid, content)
            break
check("a real chunk of the session is found by /search before hiding", CHUNK is not None)
check("a real fact of the session is found by /search before hiding", FACT is not None)
if not (CHUNK and FACT):
    app.kill()
    sys.exit(1)
CID, CQ = CHUNK
FID, FQ = FACT
CMARK = " ".join(CQ.split())[:120]


# -------------------------------------------------------------- the hooks
def hook(event, payload):
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_")}
    env.update(dbenv(DB))
    env.update({"CLAUDE_MEMORY_SERVICE": SERVICE, "CLAUDE_MEMORY_HOOK_LOG": os.path.join(TMP, "hooks.log")})
    r = subprocess.run([PY, os.path.join(CM, "hooks", "memhook.py"), event], input=json.dumps(payload),
                       capture_output=True, text=True, env=env, timeout=60)
    try:
        return json.loads(r.stdout or "{}").get("hookSpecificOutput", {})
    except ValueError:
        return {}


def hook_text(event, payload):
    out = hook(event, payload)
    if "additionalContext" in out:
        return out["additionalContext"]
    if "updatedInput" in out:
        return out["updatedInput"].get("prompt", "")
    return ""


OTHER = str(uuid.uuid4())   # the hooks drop hits from the asking session itself
PROMPT_C = "Tell me again about this: " + CQ
PROMPT_F = "Remind me what we decided here: " + FQ
# The hook's own timeouts (0.4 s / 0.5 s) are tight; the first call warms the embedding cache.
for p in (PROMPT_C, PROMPT_F, CQ, FQ):
    try:
        search(p[:4000], 14)
    except Exception:
        pass


def in_hooks(fact_mark, chunk_mark):
    ups_c = hook_text("UserPromptSubmit", {"prompt": PROMPT_C, "session_id": OTHER, "cwd": "/root/joya"})
    ups_f = hook_text("UserPromptSubmit", {"prompt": PROMPT_F, "session_id": OTHER, "cwd": "/root/joya"})
    pre = hook_text("PreToolUse", {"tool_name": "Agent", "session_id": OTHER, "cwd": "/root/joya",
                                   "tool_input": {"description": "check", "prompt": PROMPT_F + "\n" + CQ}})
    pre = pre.split("## Memory for this task", 1)[1] if "## Memory for this task" in pre else ""   # the injected block only
    # A fact hit is a line "- [fact #N | ..."; chunk text is collapsed onto its own line, so a
    # chunk that merely quotes an old search result cannot look like one.
    fact_re = re.compile(r"^- " + re.escape(fact_mark), re.M)
    return {"ups_chunk": chunk_mark in " ".join(ups_c.split()), "ups_fact": bool(fact_re.search(ups_f)),
            "pre_fact": bool(fact_re.search(pre)), "pre_chunk": chunk_mark in " ".join(pre.split())}


FMARK = "[fact #%d |" % FID   # the header of an injected or returned fact, not a mention in a chunk
before_hooks = in_hooks(FMARK, CMARK[:80])
print("  hooks before hiding:", before_hooks)
check("the hooks inject the target before it is hidden (at least one path)", any(before_hooks.values()), before_hooks)


# SessionStart: the most recent current facts of the project.
def session_start_ids():
    txt = hook_text("SessionStart", {"session_id": OTHER, "source": "resume", "cwd": "/root/joya"})
    return [int(x) for x in re.findall(r"\[#(\d+) \|", txt)]


ss_before = session_start_ids()
check("SessionStart injects recent facts from the scratch copy", len(ss_before) > 0)
SS_FID = ss_before[0] if ss_before else None
with pg(DB) as c:
    SS_SID = c.execute("SELECT source_session FROM facts WHERE id = %s", (SS_FID,)).fetchone()[0] if SS_FID else None


# The MCP server, imported from the patched copy (FastMCP's tool decorator returns the function).
os.environ.update(dbenv(DB))
os.environ["CLAUDE_MEMORY_SERVICE"] = SERVICE
sys.path.insert(0, CM)
for m in [m for m in sys.modules if m == "memlib" or m.startswith("memlib.")]:
    del sys.modules[m]
mcp_spec = importlib.util.spec_from_file_location("mm_mcp_server", os.path.join(CM, "mcp_server.py"))
MCP = importlib.util.module_from_spec(mcp_spec)
mcp_spec.loader.exec_module(MCP)
F = MCP.F
check("the MCP server under test loads the patched memlib", F.__file__.startswith(CM), F.__file__)


def mcp_view():
    # Judge memory_search by its hit headers only: this copy of live holds transcripts that quote
    # earlier search results, so a chunk's text may contain "[fact #N | ...".
    clip = MCP._clip
    MCP._clip = lambda s_, n: ""
    try:
        ms_f = MCP.memory_search(FQ, k=20)
        ms_c = MCP.memory_search(CQ, k=20)
    finally:
        MCP._clip = clip
    fb = MCP._fts_fallback(" ".join(sorted(set(re.findall(r"[A-Za-z]{6,}", CQ)), key=len)[-3:]), 200)
    sess = MCP.memory_session(SID)
    sid, rows, _ = F.session_chunks(SID, None, max_chars=10 ** 9)
    return {"search_fact": ("[fact #%d |" % FID) in ms_f, "search_chunk": ("[chunk #%d |" % CID) in ms_c,
            "fallback_chunk": any(h["kind"] == "chunk" and h["id"] == CID for h in fb),
            "session_chunk": CMARK[:80] in " ".join(sess.split()) or any(CMARK[:80] in " ".join(r["content"].split()) for r in rows)}


mcp_before = mcp_view()
print("  mcp before hiding:", mcp_before)
check("memory_search sees the fact before hiding", mcp_before["search_fact"])
check("memory_search sees the chunk before hiding", mcp_before["search_chunk"])
check("memory_session sees the chunk before hiding", mcp_before["session_chunk"])
check("the MCP keyword fallback sees the chunk before hiding", mcp_before["fallback_chunk"])


def graph_view():
    g = bridge("graph", want_sem=False, limit_f=5000, limit_c=5000)
    return {"fact": any(f["id"] == FID for f in g["facts"]), "chunk": any(ch["id"] == CID for ch in g["chunks"]),
            "alive": FID in g["alive"]}


check("the graph draws both before hiding", all(graph_view().values()))

# ---------------------------------------------------------------- hide
print("hide")
H.CC_JOYA_STATE = os.path.join(TMP, "joya-state.json")
json.dump({"session_id": str(uuid.uuid4())}, open(H.CC_JOYA_STATE, "w"))
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "hide", "scope": "items",
                                  "facts": [FID], "chunks": [CID]})
check("hide one fact and one chunk", ok and out["facts"] == 1 and out["chunks"] == 1, out)
check("/search no longer returns the hidden chunk", not has(search(CQ), "chunk", CID))
check("/search no longer returns the hidden fact", not has(search(FQ), "fact", FID))
after = in_hooks(FMARK, CMARK[:80])
check("UserPromptSubmit and PreToolUse inject neither", not any(after.values()), after)
mv = mcp_view()
check("memory_search (MCP) returns neither", not mv["search_fact"] and not mv["search_chunk"], mv)
check("the MCP keyword fallback skips the hidden chunk", not mv["fallback_chunk"], mv)
check("memory_session skips the hidden chunk", not mv["session_chunk"], mv)
gv = graph_view()
check("the graph draws neither", not gv["fact"] and not gv["chunk"] and not gv["alive"], gv)
with pg(DB) as c:
    h = c.execute("SELECT hidden FROM chunks WHERE id = %s", (CID,)).fetchone()[0]
    fr = c.execute("SELECT superseded_by, meta FROM facts WHERE id = %s", (FID,)).fetchone()
check("the chunk is kept, flagged hidden", h is True)
check("the fact is kept, retracted the way memory_forget does it", fr[0] == FID and fr[1].get("forgotten_via") == "dashboard")
pend = F.pending_sessions(min_new=1)
check("pending fact extraction still runs with hidden chunks", isinstance(pend, list))
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "hide", "scope": "items",
                                  "facts": [FID], "chunks": [CID]})
check("hiding again changes nothing", ok and out["facts"] == 0 and out["chunks"] == 0, out)

if SS_FID:
    ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SS_SID, "action": "hide", "scope": "items",
                                      "facts": [SS_FID]})
    ss_after = session_start_ids()
    check("SessionStart no longer injects a hidden fact", ok and SS_FID not in ss_after, (ss_before[:5], ss_after[:5]))
    helper(H.cc_mm_apply, {"actor": "tester", "session": SS_SID, "action": "unhide", "scope": "items", "facts": [SS_FID]})
    check("…and injects it again once unhidden", SS_FID in session_start_ids())

# ---------------------------------------------------------------- unhide
print("unhide")
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "unhide", "scope": "items",
                                  "facts": [FID], "chunks": [CID]})
check("unhide both", ok and out["facts"] == 1 and out["chunks"] == 1, out)
check("/search finds the chunk again", has(search(CQ), "chunk", CID))
check("/search finds the fact again", has(search(FQ), "fact", FID))
mv = mcp_view()
check("memory_search and memory_session see them again", mv["search_fact"] and mv["search_chunk"] and mv["session_chunk"], mv)
check("the graph draws them again", all(graph_view().values()))
with pg(DB) as c:
    meta = c.execute("SELECT meta FROM facts WHERE id = %s", (FID,)).fetchone()[0]
check("unhide clears the retraction note and records who", "forgotten" not in meta and meta.get("unhidden_by") == "tester", meta)
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": str(uuid.uuid4()), "action": "hide", "scope": "items",
                                  "facts": [FID], "chunks": [CID]})
check("ids from another session are never acted on", (not ok) or (out["facts"] == 0 and out["chunks"] == 0), out)

# ---------------------------------------------------------------- bulk: filtered
print("bulk")
word = sorted(re.findall(r"[a-z]{6,}", CQ.lower()), key=len)[-1]
ok, prev = helper(H.cc_mm_preview, {"session": SID, "action": "hide", "scope": "filtered", "q": word})
check("preview counts what a filter matches", ok and prev["chunks"] >= 1, prev)
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "hide", "scope": "filtered", "q": word})
check("hide all filtered hides exactly that many",
      ok and out["chunks"] == prev["chunks_active"] and out["facts"] == prev["facts_active"], (prev, out))
with pg(DB) as c:
    n = c.execute("SELECT count(*) FROM chunks WHERE session_id = %s AND hidden", (SID,)).fetchone()[0]
check("only the filtered chunks are hidden", n == prev["chunks"])
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "unhide", "scope": "session"})
check("unhide whole session brings them all back", ok and out["chunks"] == prev["chunks"], out)

# whole-session hide of a live session is refused; a quiet one is allowed
json.dump({"session_id": SID}, open(H.CC_JOYA_STATE, "w"))
ok, err = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "hide", "scope": "session"})
check("whole-session hide of a live session (JOYA AI's current) is refused", not ok and "live" in err, err)
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "hide", "scope": "items", "facts": [FID]})
check("…but single items in it can still be hidden", ok and out["facts"] == 1, out)
helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "unhide", "scope": "items", "facts": [FID]})
json.dump({"session_id": str(uuid.uuid4())}, open(H.CC_JOYA_STATE, "w"))

# ---------------------------------------------------------------- delete items
print("delete")
ok, err = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "delete", "scope": "items",
                                  "facts": [FID], "chunks": [CID]})
check("a delete without confirmed counts is refused", not ok and "counts" in err, err)
ok, err = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "delete", "scope": "items",
                                  "facts": [FID], "chunks": [CID], "expect": {"facts": 2, "chunks": 1}})
check("a delete whose selection changed since it was confirmed is refused", not ok and "changed" in err, err)
with pg(DB) as c:
    chash = c.execute("SELECT content_hash FROM chunks WHERE id = %s", (CID,)).fetchone()[0]
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "delete", "scope": "items",
                                  "facts": [FID], "chunks": [CID], "expect": {"facts": 1, "chunks": 1}})
check("delete one fact and one chunk", ok and out["facts"] == 1 and out["chunks"] == 1, out)
with pg(DB) as c:
    gone_c = c.execute("SELECT count(*) FROM chunks WHERE id = %s", (CID,)).fetchone()[0]
    gone_f = c.execute("SELECT count(*) FROM facts WHERE id = %s", (FID,)).fetchone()[0]
    tomb = c.execute("SELECT count(*) FROM memory_tombstones WHERE content_hash = %s", (chash,)).fetchone()[0]
check("rows and their embeddings are gone", gone_c == 0 and gone_f == 0)
check("the deleted chunk leaves a tombstone", tomb == 1)
check("/search cannot find them", not has(search(CQ), "chunk", CID) and not has(search(FQ), "fact", FID))

# supersession chains: delete a newer version
with pg(DB) as c:
    def ins(content, sid, sup=None):
        return c.execute("INSERT INTO facts (content, topic, source_session, superseded_by, meta) VALUES "
                         "(%s, 'test.mm', %s, %s, '{}'::jsonb) RETURNING id", (content, sid, sup)).fetchone()[0]
    S2 = str(uuid.uuid4())
    newest = ins("mm test newest", S2)
    mid = ins("mm test middle", SID, newest)
    old = ins("mm test oldest", SID, mid)
    lone_new = ins("mm test lone newer", S2)
    lone_old = ins("mm test lone older", SID, lone_new)
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": SID, "action": "delete", "scope": "items",
                                  "facts": [mid], "expect": {"facts": 1, "chunks": 0}})
with pg(DB) as c:
    o = c.execute("SELECT superseded_by FROM facts WHERE id = %s", (old,)).fetchone()[0]
check("deleting a middle version re-points the older one at the surviving newest", ok and o == newest, (out, o))
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": S2, "action": "delete", "scope": "items",
                                  "facts": [lone_new], "expect": {"facts": 1, "chunks": 0}})
with pg(DB) as c:
    o = c.execute("SELECT superseded_by, meta FROM facts WHERE id = %s", (lone_old,)).fetchone()
check("deleting the newest version hides the older one instead of reviving it",
      ok and o[0] == lone_old and "was deleted" in o[1].get("forgotten", ""), (out, o))

# ------------------------------------------------- ingest: tombstones and exclusions
print("ingest")
FX = str(uuid.uuid4())
pdir = os.path.join(H.CC_HOMES["root"]["projects"], "-mm-fixture")
os.makedirs(pdir)
TP = os.path.join(pdir, FX + ".jsonl")
WIN = os.path.join(H.CC_HOMES["winarchive"]["projects"], "-mm-fixture")
os.makedirs(WIN)
recs = []
for i in range(4):
    u = str(uuid.uuid4())
    recs.append({"type": "user", "uuid": u, "sessionId": FX, "cwd": "/root/joya", "timestamp": "2026-10-04T10:0%d:00Z" % i,
                 "message": {"role": "user", "content": "mm fixture question %d about the purple walrus ledger %s" % (i, "x" * i)}})
    recs.append({"type": "assistant", "uuid": str(uuid.uuid4()), "sessionId": FX, "cwd": "/root/joya",
                 "timestamp": "2026-10-04T10:0%d:30Z" % i,
                 "message": {"role": "assistant", "content": [{"type": "text", "text": "mm fixture answer %d: walrus %d" % (i, i)}]}})
recs.append({"type": "custom-title", "customTitle": "MM Fixture", "sessionId": FX})
with open(TP, "w") as fh:
    fh.write("".join(json.dumps(r) + "\n" for r in recs))
shutil.copy2(TP, os.path.join(WIN, FX + ".jsonl"))
OLD = time.time() - 3600


def settle():
    """Back-date the fixture's files: a transcript written in the last 2 minutes counts as live."""
    for p in (TP, os.path.join(WIN, FX + ".jsonl")):
        if os.path.exists(p):
            os.utime(p, (OLD, OLD))
os.makedirs(os.path.join(pdir, FX, "subagents"))
open(os.path.join(pdir, FX, "custom-title.json"), "w").write('{"customTitle": "MM Fixture"}')

INGEST_ENV = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_")}
INGEST_ENV.update(dbenv(DB))


def ingest(path):
    r = subprocess.run([PY, os.path.join(CM, "ingest.py"), path], env=INGEST_ENV, capture_output=True, text=True, timeout=300)
    return r.returncode, r.stderr


def fixture_chunks():
    with pg(DB) as c:
        return c.execute("SELECT id, content_hash FROM chunks WHERE session_id = %s ORDER BY id", (FX,)).fetchall()


rc, err = ingest(TP)
first = fixture_chunks()
check("the patched ingest indexes a fixture transcript", rc == 0 and len(first) >= 3, (rc, err[-300:], len(first)))
victim = first[0]
ok, out = helper(H.cc_mm_apply, {"actor": "tester", "session": FX, "action": "delete", "scope": "items",
                                  "chunks": [victim[0]], "expect": {"facts": 0, "chunks": 1}})
with pg(DB) as c:
    c.execute("DELETE FROM ingest_state WHERE file_path = %s", (TP,))   # force a full re-read
rc, err = ingest(TP)
again = fixture_chunks()
check("re-reading the transcript never re-creates a tombstoned chunk",
      rc == 0 and victim[1] not in [h for _, h in again] and len(again) == len(first) - 1, (rc, err[-300:], len(again)))
# hide survives a re-read of the still-growing last exchange
last = again[-1][0]
helper(H.cc_mm_apply, {"actor": "tester", "session": FX, "action": "hide", "scope": "items", "chunks": [last]})
with open(TP, "a") as fh:
    fh.write(json.dumps({"type": "assistant", "uuid": str(uuid.uuid4()), "sessionId": FX, "cwd": "/root/joya",
                         "timestamp": "2026-10-04T10:09:00Z",
                         "message": {"role": "assistant", "content": [{"type": "text", "text": "and one more walrus line"}]}}) + "\n")
rc, err = ingest(TP)
with pg(DB) as c:
    hl = c.execute("SELECT hidden, content FROM chunks WHERE id = %s", (last,)).fetchone()
check("a hidden chunk stays hidden when ingest updates it", rc == 0 and hl[0] is True and "one more walrus" in hl[1], (rc, hl))

# ------------------------------------------------- whole-session delete
print("delete session")
settle()
ok, list_ = helper(H.cc_mm_sessions, {})
row = next((s for s in list_["sessions"] if s["session_id"] == FX), None) if ok else None
check("the session list names the fixture from its title and finds both transcripts",
      row and row["name"] == "MM Fixture" and row["transcripts"] == 2 and row["transcripts_writable"] == 1, row)
check("the list reports the update as installed", ok and list_["ready"] is True)
json.dump({"session_id": FX}, open(H.CC_JOYA_STATE, "w"))
ok, err = helper(H.cc_mm_delete_session, {"actor": "tester", "session": FX, "confirm": "MM Fixture"})
check("deleting a live session is refused", not ok and "live" in err, err)
json.dump({"session_id": str(uuid.uuid4())}, open(H.CC_JOYA_STATE, "w"))
ok, err = helper(H.cc_mm_delete_session, {"actor": "tester", "session": FX, "confirm": "mm fixture"})
check("deleting needs the name typed exactly", not ok and "name" in err, err)
saved = H.CC_INGEST_PY
H.CC_INGEST_PY = os.path.join(LIVE_ROOT, "app.py")      # any file without the exclusion code
ok, err = helper(H.cc_mm_delete_session, {"actor": "tester", "session": FX, "confirm": "MM Fixture"})
check("deleting is refused while ingest.py does not honour exclusions", not ok and "ingest.py" in err, err)
H.CC_INGEST_PY = saved
ok, out = helper(H.cc_mm_delete_session, {"actor": "tester", "session": FX, "confirm": "MM Fixture", "delete_files": True})
check("delete the whole session", ok and out["chunks"] >= 2 and out["ingest_state"] >= 1, out)
check("…its writable transcript and folder are deleted, the read-only archive copy kept",
      ok and not os.path.exists(TP) and not os.path.exists(os.path.join(pdir, FX)) and out["files_kept_readonly"] == 1
      and os.path.exists(os.path.join(WIN, FX + ".jsonl")), out)
with pg(DB) as c:
    left = c.execute("SELECT count(*) FROM chunks WHERE session_id = %s", (FX,)).fetchone()[0]
    st = c.execute("SELECT count(*) FROM ingest_state WHERE file_path LIKE %s", ("%" + FX + "%",)).fetchone()[0]
    ex = c.execute("SELECT files_deleted FROM excluded_sessions WHERE session_id = %s", (FX,)).fetchone()
check("no chunk and no ingest state is left; the session is excluded", left == 0 and st == 0 and ex and ex[0] is True, (left, st, ex))
rc, err = ingest(os.path.join(WIN, FX + ".jsonl"))
check("ingest skips the excluded session's remaining transcript", rc == 0 and not fixture_chunks() and "excluded" in err, err[-300:])
ok, out = helper(H.cc_mm_reindex, {"actor": "tester", "session": FX})
rc, err = ingest(os.path.join(WIN, FX + ".jsonl"))
check("after Allow re-indexing, ingest brings it back", ok and out["lifted"] == 1 and rc == 0 and len(fixture_chunks()) >= 3, (out, err[-200:]))

audit = open(H.AUDIT_LOG).read()
check("every write is audited", audit.count('"cc-memory-') >= 8)
check("the audit log holds counts, never content", "walrus" not in audit and CMARK[:40] not in audit and FQ[:40] not in audit)

# ---------------------------------------------------------------- teardown
app.send_signal(signal.SIGTERM)
try:
    app.wait(10)
except subprocess.TimeoutExpired:
    app.kill()
shutil.rmtree(TMP, ignore_errors=True)
check("the live database is unchanged (forgotten facts, no new tables or rows)", live_signature() == LIVE_BEFORE,
      (LIVE_BEFORE, live_signature()))
if ARGS.drop:
    as_postgres(["dropdb", DB])
    print("dropped", DB)
print("%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
