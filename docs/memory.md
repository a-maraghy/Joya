# Memory

## The problem

A Telegram session ends on timeout, on restart, or on `/new`. Nothing in the
conversation survives it. An agent that keeps everything in context therefore
starts every session blank, which a user experiences as the bot forgetting who it
is and what was already agreed.

Only files survive. So memory is files.

## The shape

```
vault/
├── CLAUDE.md      identity and standing rules   → system prompt, every request
├── MEMORY.md      current state + note index    → system prompt, every request
├── WORKLOG.md     dated narrative of work done
├── memory/*.md    one durable fact per file, linked with [[wikilinks]]
├── attachments/   images and files pasted into notes
└── .obsidian/     vault config — this is a real Obsidian vault
```

`CLAUDE.md` and `MEMORY.md` are injected into the system prompt on every request
by the agent runtime, capped at `CONTEXT_FILE_MAX_CHARS` (24000 each) so an
oversized file cannot blow up the prompt.

That cap is the whole reason the vector index exists. `MEMORY.md` has a budget,
so it holds the current state and an index — the map. The notes it points at hold
the territory, and those are retrieved on demand.

`CLAUDE.md` and `MEMORY.md` are therefore **not indexed**. They are already in
front of the agent when it searches, so retrieving them again spends result slots
on text it is currently reading — and `MEMORY.md` is the worst offender, because
its one-line pointers are short and topical enough to outrank the notes they
point at. This is not a micro-optimisation: before it was fixed, a search for
"how do we put code live" returned the index line about the release procedure
instead of the release procedure.

## Retrieval

`joya_memory` indexes the vault into a per-agent SQLite database:

| Table | Holds |
|---|---|
| `files` | one row per Markdown file, with a content SHA |
| `chunks` | heading-scoped pieces of text |
| `chunks_vec` | `sqlite-vec` virtual table, 384-dim float vectors |
| `chunks_fts` | FTS5 index over the same text |

**Chunking** splits on Markdown headings before falling back to a fixed window.
Headings are the author's own segmentation of the document, so a chunk that stops
at a heading boundary is a chunk about one thing. Sections longer than 1000
characters are split on paragraph breaks, and a single oversized paragraph (a
pasted log, a table) is hard-wrapped with 150 characters of overlap so a fact
straddling the seam is still findable.

**Embedding** uses `BAAI/bge-small-en-v1.5` through `fastembed` — a quantised
ONNX model, ~130MB, CPU only, roughly 40ms for a query. It runs on this machine.
The model is downloaded once into `/opt/joya-agents/shared/models` and shared by
every agent. Documents are embedded with their path and heading prefixed, so the
vector knows where the text came from; the stored text stays clean so what is
read back is what the human wrote.

**Search is hybrid.** Dense vectors catch paraphrase — "how do we deploy" finding
"release procedure". FTS5 catches the exact tokens embeddings routinely lose:
error codes, flag names, IDs, filenames. Neither alone is good enough. The two
rankings are merged with reciprocal rank fusion:

```
score(chunk) = Σ  1 / (60 + rank_in_that_ranking)
```

RRF needs no calibration between the two scoring scales, which is why it is used
here instead of a weighted sum of a cosine distance and a BM25 score — those two
numbers are not comparable and any weighting between them is a guess.

**Indexing is incremental and content-addressed.** A file whose SHA has not
changed is skipped without embedding anything, so the common case — a search
after a small edit — costs one stat per file. There is no daemon and no file
watcher: the MCP server syncs on startup and before a search, which is cheap
enough to do inline and removes a whole class of "the index is stale" bugs.

## Two properties worth stating plainly

**Files are the source of truth; the index is a cache.** Delete
`vectors/memory.db` and press Reindex — nothing is lost. Edit a note by hand in
Obsidian and the agent picks it up on its next search, with nothing to tell it.
This is why the vault is Markdown in a folder rather than rows in a database: a
memory a human cannot open, read and correct is a memory that stays wrong.

**Nothing leaves the machine to be embedded.** An agent's memory is the most
sensitive thing it holds. A few points of retrieval quality is not worth shipping
it to a third party.

## The tools the agent sees

An MCP server is launched over stdio per agent, pointed at that agent's vault and
database by environment variables. An agent therefore has no way to address
another agent's memory: the isolation is in the process, not in a parameter the
model could get wrong.

| Tool | Purpose |
|---|---|
| `memory_search(query, limit)` | Hybrid search. The agent is instructed to call this before answering anything that depends on prior work |
| `memory_write(title, content, tags, links)` | Create one note and index it in MEMORY.md |
| `memory_read(path)` / `memory_update(path, content)` | Read and correct notes |
| `memory_delete(path)` | Moves to `.trash/`, never unlinks |
| `memory_worklog(entry)` | Append a dated line to WORKLOG.md |
| `memory_list`, `memory_stats`, `memory_reindex` | Housekeeping |

## Curating it

Memory rots if nobody prunes it. The highest-value maintenance action by a wide
margin is **correcting a wrong note**: an agent that keeps repeating a mistake is
usually reading a stale memory, and fixing that one file fixes the behaviour
permanently. Do it in the panel under Memory, or in Obsidian.

The instructions that shape what gets written live in the vault's `CLAUDE.md` and
are editable per agent in the panel. If an agent is not writing memories, that is
the file to tighten — specifically the rule that says a task is not done until
the memory is written.

## Command line

```bash
sudo -u joyaagent \
  JOYA_VAULT=/opt/joya-agents/agents/<slug>/vault \
  JOYA_VECTOR_DB=/opt/joya-agents/agents/<slug>/vectors/memory.db \
  JOYA_MODEL_CACHE=/opt/joya-agents/shared/models \
  /opt/joya-agents/runtime/venv/bin/python -m joya_memory.cli stats
```

Subcommands: `index [--force]`, `search <query> [--limit N]`, `stats`, `warm`.
Everything prints a single JSON object, so the caller never has to parse prose.
