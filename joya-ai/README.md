# JOYA AI

JOYA AI is the CEO of every Claude Code session on this machine. It takes a
command from the administrator, finds the session that owns the work and hands
the command over through Claude Code's own peer messaging (`ListAgents` /
`SendMessage`), so the command shows up in that session's chat. Replies and
"finished" notices come back to JOYA AI, which relays them.

**The name.** It was JOYA AI until 2026-09-29 (and JOYA Bot before that); the
dashboard is now Joya. Only what people see and hear changed: the service,
socket, paths, actor id `joya-ai`,
`joya-ai-ctl`, the `joyaai` group and the `JOYA_*` variables keep their names.
JOYA AI's own MCP server is registered as `joya-ai` (tools `mcp__joya-ai__*`)
since 2026-09-30; it was `joya-ai`. The rename makes a resumed session discover
the tools fresh (a resumed CLI reuses the schema it recorded for a tool it
already loaded). The server file is still `bin/joya-ai-mcp`.
`lib/names.js` holds the names: anything that asks "is this name us?" (a send
or order target, a mission step, the session list's self fallback) accepts
JOYA AI, JOYA AI, JOYA Bot and `joya-ai`, so sessions still using the old name
keep working. A config whose `name` is still an old name is shown as JOYA AI.

It is one long-lived headless Claude Code session, run by a supervisor:

```
 dashboard (joyaadmin)            Claude Desktop / claude.ai
   /joya-ai/api/*  JSON + SSE            │  Remote Control
        │                                │
        │ unix socket, group joyaai      │
        ▼                                ▼
  joya-ai.service  (root)  ──stdin/stdout stream-json──▶  claude -p … -n "JOYA AI"
   supervisor.js                                          cwd /root/joya-ai, HOME=/root
   ├─ ledger.db  (turns, delegations, inbound,             │ ListAgents / SendMessage
   │              approvals, audit)                        ▼
   ├─ ring buffer → event stream                   every other Claude Code session
   └─ hook.sock (root only) ◀── hooks/ledger.js    on the box (Desktop over SSH,
                              ◀── hooks/gate.js     terminals, headless)
```

| Path | What |
|---|---|
| `/opt/joya-ai/` | supervisor, `lib/`, `hooks/`, `bin/joya-ai-ctl`, pinned CLI in `cli/` |
| `/etc/joya-ai/config.json` | model, effort, CLI pin, approval timeout, delegation allow-list |
| `/root/joya-ai/CLAUDE.md` | the CEO charter JOYA AI reads |
| `/root/joya-ai/.claude/settings.json` | the gate and ledger hooks |
| `/var/lib/joya-ai/ledger.db` | the ledger (SQLite, 0600) |
| `/var/lib/joya-ai/state.json` | fixed session id, Remote Control session (0600) |
| `/run/joya-ai/joya-ai.sock` | control socket, `root:joyaai 0660` |
| `/run/joya-ai/hook.sock` | hook socket, root only |
| `/var/log/joya-ai/audit.log` | every action through the socket, with the panel user |

Source of truth is `Joya/joya-ai/`; `deploy/deploy-joya-ai.sh` installs
all of the above. Do not edit the installed copies.

## How a command travels

1. The administrator types in the Command Center (`POST /joya-ai/api/send`).
   The panel checks it, then the supervisor checks it again, queues it, and
   when JOYA AI is free writes it to JOYA AI's stdin as a stream-json user
   message with its own uuid (see *the turn queue* below).
2. JOYA AI calls `ListAgents`, picks the session by name and working
   directory, and calls `SendMessage` with `notify_when_idle: true`.
3. The PreToolUse hook (`hooks/gate.js`) reads the message. Harmless: it goes.
   Destructive: see *the approval gate* below.
4. The PostToolUse hook posts the `msg_id` to the supervisor: the delegation is
   **sent**.
5. The supervisor polls `claude agents --json` every 5 s. The target busy:
   **working**. A `<cross-session-message>` back from it (seen by the
   UserPromptSubmit hook, sender pid from its socket path): **ack**, with the
   reply stored. The `[Cross-session idle notice]`, or the target idle again:
   **done**. The target gone: **failed**. A delivery notice saying the target
   holds messages for its user: **held**. Denied at the gate: **denied**.
6. The reply also wakes JOYA AI (a peer message starts a turn on its own), and
   it relays the answer. Every event goes out on the stream.

## The turn queue

The supervisor holds the queue and hands the CLI **one turn at a time** (the
CLI itself would run whatever it was given strictly in arrival order).
`lib/turnqueue.js` picks the next one:

- **user turns first** -- typed or spoken in the Command Center, the voice
  desk's hand-offs, mission requests, decision approvals and questions, a
  standing order run by hand;
- **background turns** -- watcher investigations, scheduled standing orders,
  and what other sessions send (peer messages, idle / delivery notices, a peer
  message held at the token cap; one held from Remote Control is the user's)
  -- only when no user turn is waiting (2026-09-30: peer turns counted as the
  administrator's and a spoken request waited behind them);
- first in, first out within each class; nothing is dropped. A background turn
  that has waited `queue_background_max_wait_s` (600) ranks with user turns by
  arrival, so it cannot starve.

A running turn is never interrupted for a waiting one (it may hold an approval
card, and an interrupted investigation starts over); the user turn goes next.
Turns the CLI starts on its own (peer messages, idle notices, Remote Control)
are not ours to hold; the queue waits for them to end. A turn handed over that
has not started within `queue_start_timeout_s` (120) while nothing is running
frees the queue. `status.queued` lists the queue in run order with each turn's
`priority`; `send` returns `queued_behind`, the turns ahead of it.

**A live call's repeats are one turn.** A `voice-desk` send carries the live
call's id (`call`). Said again while its first is still waiting in the queue
(not handed to the CLI yet), within `voice_merge_s` (20 s) of the last, it is
folded into that turn (`[Said again while this was waiting:] ...`); `send`
answers with the same turn and `merged: true`, and JOYA AI answers once.

**A live call's requests run in its own small sessions (voice lanes, 2026-10-30).** A `voice-desk`
send carrying a call id no longer waits in this queue: `lib/voiceroute.js` sends it to one of the
call's own fresh CLI sessions (`lib/voicelane.js`, named `joya-internal-voice-<call>-<kind><n>`, hidden
from the session list, their ids kept as JOYA AI's own in `state.json` `lane_sessions`):

| lane | model | what it has | for |
|---|---|---|---|
| quick | `voice_quick_model` (claude-haiku-5-5) | its own short prompt, the `weather` tool (Open-Meteo, `lib/weather.js`), WebSearch / WebFetch, memory search; no charter, no machine | the weather, time and date, conversions, general knowledge; answers `ESCALATE` when it needs more, and the same row goes to a work lane |
| work | `voice_lane_model` (claude-sonnet-5) at `voice_lane_effort` (medium) | JOYA AI's charter, hooks (the gate, the ledger), MCP (`JOYA_AI_LANE` names the lane on every call), memory, `--permission-prompt-tool stdio` | everything else; up to `voice_lane_max_work` (3) per call in parallel |
| agent | a work lane | the same, told to hand the request straight to the named session with `SendMessage` (the gate, approvals and delegation ledger as ever) and relay its reply | "ask JOYA Pace ...", «اسأل Planning Automation ...»: live sessions and hires by name, plus `voice_agent_aliases` |

The dashboard starts a call's quick and work lanes when the call starts (op `voice-warm`), so the
first request does not wait for a CLI. A lane's turns are ledger rows like any (`call_id`, `lane`;
`follows` and `voice_actor` for an agent's reply, which arrives as the lane's own peer turn and is
read out on the call), its events carry the row id, its approvals are cards answered on its stdin,
its hook events are attributed to its running turn, `ui_do` reaches the call's tab through the
request's ui token, and its cost is a chain of its own (`proc_start` `lane:<session>#new`,
`lib/cost.js` `chainOf`). A follow-up said while the call's request is younger than `voice_fold_s`
(45 s) and has written nothing, held no card and run nothing that changes anything is **folded**: the
running turn is interrupted and asked once with both parts under the same row (`send` answers
`merged: true`); otherwise it runs in parallel in another lane, which is told what this call asked so
far. Lanes close after `voice_lane_idle_s` (900 s) idle unless a delegation they made is still open;
at most `voice_lanes_max` (12) on the box. `voice_lanes: false`, the token cap, or a lane that cannot
start: the request goes to this queue as before. `status.voice_lanes` lists them. Tests:
`tools/test-voicelanes.cjs` (end to end, fake CLI) and `tools/test-voiceroute.cjs`.

**Restarts are told.** At start the supervisor notes its own (re)start, with
the commit and time `deploy/deploy-joya-ai.sh` stamped in `/opt/joya-ai/DEPLOYED`,
and the dashboard sends `deploy-event` when it starts; the next turn handed to
the CLI carries, after its own words, a one-time system note of both ("check
the journal before you say what changed"), and `snapshot` lists the last few
under `restarts`. `snapshot.clock` gives the time in UTC, the administrator's
zone (`tz`, Africa/Cairo) and the server's, with their offsets.

The queue survives a supervisor restart: a turn still queued and never handed
over (`turns.sent_at` empty) is re-queued in its old place if younger than
`queue_requeue_max_age_s` (6 h); one that was handed over or running is marked
lost, as before, since replaying it could run it twice.

## The approval gate

The administrator's rule: **ask before anything destructive** — deleting
files or records, stopping or restarting services, `git push` and force
operations, database writes and drops, killing processes, changing
permissions or credentials, and telling another session to do any of these.

It is enforced, not only asked for in the charter:

- `hooks/gate.js` runs before every `Bash`, `Monitor`, `SendMessage`,
  `memory_forget`, `CronCreate` and `RemoteTrigger` call and classifies it with
  `lib/classifier.js` (conservative: it asks when it cannot tell — SQL on stdin,
  inline scripts, heredocs, `ssh host cmd`, `bash -c`, `claude -p`).
- Destructive → the hook answers `permissionDecision: "ask"`. JOYA AI runs with
  `--permission-prompt-tool stdio`, so the CLI sends the supervisor a
  `can_use_tool` control request and waits.
- The supervisor records it and pushes an `approval` event: the dashboard shows
  an Approve / Deny card. Approve → `allow`; Deny → `deny` with a message telling
  JOYA AI who denied it and not to retry or route around it.
- **Nobody answers within `approval_timeout_s` (300 s) → denied.** A restart of
  the process cancels whatever was pending.
- The `ask` rules in root's own `settings.json` (`rm -rf`, `git push`,
  `systemctl restart`, …) reach the same path, as does anything auto mode
  decides to ask about. Every `can_use_tool` becomes a card.
- `delegation_allow` in the config, when non-empty, is a list of regexes a
  `SendMessage` target must match, else it is denied outright. Empty in
  production; used by the end-to-end test so JOYA AI cannot reach a real session.

It is a tripwire, not a sandbox. A model that writes a script file and then
runs `python3 script.py` gets past a classifier that never sees the script.
That is why the charter asks as well, and why the gate fails closed.

### Remote Control

Remote Control is switched on at every start (control request
`remote_control`), and its session URL is served by `rc-url` so the page can
offer *Open in Claude Desktop*. The URL is a live door into a root session:
keep it out of commits, docs and chat.

A turn typed through Remote Control runs in the same process, so the same
hooks and the same gate apply: the hook answers `ask`, the CLI sends its
`can_use_tool` request to the supervisor on stdout whatever the turn's source,
and a card appears **in the dashboard**, timing out to deny.

What the Remote Control client itself shows was **not verified** (it needs a
person signed in to claude.ai). The 2.1.283 binary carries bridge code that
relays permission requests to a remote client and a `control_cancel_request`
path, so claude.ai may show the same prompt. If it is answered there first,
the CLI withdraws the dashboard's copy and the supervisor records the card as
`cancelled` ("answered elsewhere"). Either way nothing runs unanswered: the
dashboard card still times out to deny. Check this by hand the first time the
administrator uses Remote Control, and record what happened here.

## Traps

- **Never `--resume` JOYA AI's session id from a second process.** Claude Code
  does not stop it: the second process silently forks the transcript. The
  supervisor holds a lock, resumes only after the old process has exited, and
  refuses to start (state `blocked`) while any live registry entry or process
  command line holds the id. Desktop reaches JOYA AI through Remote Control only.
- **It must run as root, `HOME=/root`, default config dir.** Peer discovery goes
  through `/root/.claude/sessions/<pid>.json`. The old console's account
  (`joyaconsole`, `CLAUDE_CONFIG_DIR=/var/lib/joya-console`) is a separate
  registry that cannot see root's sessions. The supervisor builds the child's
  environment from nothing so no `CLAUDE_CODE_*` variable leaks in.
- **Auto mode depends on the model.** With Haiku, `--permission-mode auto`
  silently runs as `default`; with Opus 5.5 it is `auto`. The gate works in both.
- **The CLI is pinned.** `/opt/joya-ai/cli/claude-<version>` is a copy, not a
  link, because `claude update` or a desktop update would change the binary
  under a running JOYA AI. The supervisor refuses to start on a version that
  does not match `cli_version`. **After any Claude Code update, re-verify before
  moving the pin:** peer registration and `SendMessage` from a headless session,
  replayed peer turns (`origin.kind = "peer"`), `remote_control` returning a
  `session_url`, and a `can_use_tool` request after a hook answers `ask`. The
  end-to-end steps below do exactly that.
- **Idle notices need `notify_when_idle: true`.** Without it the supervisor
  still closes a delegation when it sees the target go idle, from the poll.
- The ledger hooks never write the database: one writer, the supervisor. If its
  socket is down they spool to `/var/lib/joya-ai/hook-spool.jsonl`, read back at
  start.

## Operations

```bash
systemctl status joya-ai
journalctl -u joya-ai -f
joya-ai-ctl status                      # process, current turn, approvals, vitals
joya-ai-ctl sessions                    # claude agents --json + the ledger
joya-ai-ctl ledger '{"table":"delegations","limit":10}'
joya-ai-ctl events                      # live stream, Ctrl-C to stop
joya-ai-ctl send '{"text":"What is every session doing?"}'
joya-ai-ctl approve '{"approval_id":7}'
joya-ai-ctl restart                     # graceful: stdin closed, transcript kept, resumed
joya-ai-ctl fresh '{"reason":"…"}'      # NEW conversation: new session id, old transcript kept
sudo bash /root/joya/Joya/deploy/deploy-joya-ai.sh
```

`systemctl stop joya-ai` closes JOYA AI's stdin and waits for it to write its
transcript before killing anything. Starting again resumes the same session.

### Fresh start (a new conversation)

When JOYA AI's context has grown large enough to slow every reply, start it in
a new conversation instead of resuming. Its memory (long-term memory, the
ledger's missions, rules, orders, decisions and costs) is untouched; only the
chat history is left behind.

- `joya-ai-ctl fresh '{"reason":"context too large"}'` -- stops the CLI
  gracefully, retires the session id, and starts with `--session-id <new>`.
  Refused while a turn is running or handed over, turns are queued or
  approvals are pending (add `"force":true` to override), and refused for
  JOYA AI itself (actor `joya-ai`) and the supervisor's internal actors. The
  dashboard has no route for it.
- Or, one-shot: `echo "reason" > /var/lib/joya-ai/fresh-start`, then
  `systemctl restart joya-ai`. The supervisor honours the file at its next
  start and deletes it.

Either way `state.json` gets the new `session_id`, `previous_session_id`, and a
`session_history` entry (old id, created/retired time, who, why, next id); the
audit log gets `fresh` and `session-rotate` lines with both ids. The old
transcript stays in `~/.claude/projects/`; a retired id is never resumed
(the supervisor refuses to), and the cost scanner keeps excluding it, since
JOYA AI's own cost comes from its ledger. `joya-ai-ctl status` shows the
`session_id`, `previous_session_id` and the new process's `init` (model, CLI
version, MCP tools and servers).

### Socket protocol

One JSON object per line, `{"id", "op", "actor", …params}` in, one
`{"id", "ok", "data" | "error"}` out. `actor` (the panel user) is required on
every call; unknown fields are refused. `lib/protocol.js` is the definition.

| op | params | |
|---|---|---|
| `ping`, `status`, `sessions`, `rc-url` | – | read |
| `events` | `since?` | reply, then `{"event": …}` lines until closed |
| `ledger` | `table` (delegations, inbound, approvals, turns, audit), `limit?`, `before_id?`, `status?` | read |
| `send` | `text`, `target?` (a live session's name, or `auto`), `via?` (`voice-desk`: recorded as the turn's source), `call?` (the live call's id: the request runs in the call's voice lanes; a repeat is folded in) | audited |
| `voice-warm` | `call` | read: start the call's quick and work lanes ahead of its first request |
| (any op, JOYA AI's MCP only) | `lane?` beside `actor` (`^v[a-z0-9-]+$`, actor `joya-ai`) | the voice lane the call comes from: its running turn is "the" turn for `ui-action`, `ui-widget`, missions and take-overs |
| `deploy-event` | `component` (`dashboard`), `started_at?`, `commit?`, `deployed_at?` | audited |
| `snapshot` | `turns?` (the voice front desk's own earlier turns) | read: counts, titles and human-unit figures for the voice front desk, never a command (`lib/snapshot.js`) |
| `interrupt` | – | audited |
| `approve`, `deny` | `approval_id`, `note?`; approve also `verified?` (`hello`/`totp`), `verified_with?` | audited; the panel requires Windows Hello or the code for every approve (dashboard `lib/stepup.js`) and says which -- stored on the approval row (`verified`, `verified_with`). The same two optional fields ride on `decision-approve`, `budget-resume`, `rule-create/update/delete`, `session-retire` (audit only) |
| `approval-hold` | `approval_id`, `seconds` (10-120) | the panel, while Windows Hello runs: the card's expiry moves to at least `seconds` from now, never past its own window + 120 s (a hired session's runner gives up 150 s after its window) |
| `rc` | `enabled` | audited |
| `restart` | – | audited |
| `fresh` | `reason?`, `force?` | audited; a new conversation (see *Fresh start*) |

Events: `proc`, `init`, `rc`, `turn` (queued / start / source / end), `text`
(streamed deltas, not buffered), `assistant`, `tool`, `tool_result`, `steps`,
`result`, `approval`, `delegation`, `inbound`, `sessions`, `vitals`, `notice`.

Command Center v3, phase 1 (all re-validated in `lib/protocol.js`, writes audited):

| op | params | |
|---|---|---|
| `machine`, `watchers`, `orders`, `rules`, `cost` | – | read |
| `missions` / `mission` | `status?` / `mission_id` (`M-12`) | read |
| `decisions` | `status?` (open, all) | read |
| `order-runs` | `order_id` | read |
| `rule-test`, `rule-suggest` | `command, tool?` / `approval_id` | read |
| `session-mirror` | `session_id` (uuid) | read: the transcript's last turns, tools today, delegations, cost |
| `mission-create`, `mission-step-add`, `mission-step-update`, `mission-update` | see the protocol | JOYA AI's MCP tools call these as actor `joya-ai` |
| `mission-request` | `goal` | "New mission": a queued turn asking JOYA AI to plan it |
| `decision-propose`, `decision-update` | `decision_id, summary, evidence?, fix_command?` / `status, result?` | JOYA AI |
| `decision-approve`, `decision-dismiss`, `decision-ask` | `decision_id, note?` / `text` | administrator |
| `watcher-set` | `key, enabled` | persisted |
| `watcher-inject` | `watcher, subject, detail?, evidence?` | fault injection; refused unless `watcher_inject` is true in the config (tests only) |
| `order-create`, `order-update`, `order-delete`, `order-run`, `order-pause` | name, schedule, target, prompt, delivery, paused | standing orders |
| `rule-create`, `rule-update`, `rule-delete` | effect, tool, pattern, note | built-ins refused |
| `approve` | + `rule_pattern, rule_tool` | "Always allow this": saves the rule, then approves |
| `cost-budget` | `daily_usd` (or null), `warn_pct` | kept for the API; the panel no longer shows a dollar budget |
| `usage` | `plan_only?`, `cached?` | read: Claude plan usage exactly as `/usage` shows it, and this box's token counts (below) |

**Plan usage (`usage`, lib/usage.js, 2026-09-30).** The supervisor sends JOYA AI's
running CLI the `get_usage` control request (stream-json, 2.1.283; answered out of
band in ~0.1 s even mid-turn, it does not touch the turn). The CLI answers from the
claude.ai usage endpoint with its own login: the same data as its `/usage` dialog.
No credential is read, held or passed by the supervisor. When JOYA AI is not running,
a throwaway CLI is started for the question (initialize + get_usage, no prompt, no
model turn, no transcript) with the `JOYA_AI_*` variables stripped. Like any
Claude Code process it registers in root's session registry for its few seconds;
unnamed, it got a name derived from its cwd ("tmp-9c") and flashed up as a working
sphere. It is now named `joya-internal-usage-probe` (`-n` and
`CLAUDE_CODE_SESSION_NAME`, plus `JOYA_INTERNAL=1`), and the supervisor drops
every registry entry whose name starts `joya-internal-` (`targets.isInternal`, the
one narrow rule; hires may not use the prefix). Only `/usage`'s
rows go on, with its labels and order: Current session (five_hour), Current week (all
models) (seven_day), Current week (Sonnet only) for max/team plans, Current week
(<model>) per `model_scoped`; a window with no utilization is skipped. Answers are
reused for 50 s (a probe's for 2 min); a failure keeps the last answer marked stale.
Verified 2026-09-30 against `claude -p /usage` at the same minute: identical, three rounds.
Token counts: the cost scanner now reads JOYA AI's own transcripts too (money queries
leave its session ids out, its dollars still come from the ledger), and `usage` sums
input / output / cache read / cache write per day and per session name. Each
session in `sessions` (and JOYA AI's own in `status`) carries `tokens_today`
from the same counts. A mission's `metrics.tokens` is JOYA AI's tokens over the
turns that worked on it: each result's `usage` is the CLI process's running
total (like `total_cost_usd`), so every turn stores its difference
(`turns.tok_*`, `lib/cost.js` `turnTokenDelta`; a new process starts from zero).

New events: `mission`, `decision`, `watcher`, `order`, `order_run`, `rule`, `machine`.

Joya reorganisation (2026-09-30): editable settings, kept in the ledger's
`settings` table (`lib/settings.js`). Every write is the administrator's only
(a human actor: never `joya-ai`, a hired `session.*` or the supervisor's own
jobs) and audited; reads are open to the panel.

| op | params | returns |
|---|---|---|
| `hire-limits` | – | `{max_live, per_hour, perm_mode, defaults:{max_live, per_hour, perm_mode}, bounds:{max_live:[1,12], per_hour:[0,10]}, modes:[auto, default, plan], live, hired, updated_by, updated_at}` (`live` / `hired` counted as a hire is checked) |
| `hire-limits-set` | any of `max_live` (1..12), `per_hour` (0..10; 0 = no hiring), `perm_mode` (auto, default, plan; bypassPermissions refused); `null` = back to the default | the same as `hire-limits`. Keys `hire_max_live`, `hire_per_hour`, `hire_perm_mode`, read at every hire; the mode is written into the hire's record and `bin/joya-session` starts with it |
| `approval-timeout` | – | `{seconds, default, bounds:[30,3600], updated_by, updated_at}` |
| `approval-timeout-set` | `seconds` (30..3600, or `null` = the config's) | the same. Key `approval_timeout_s`: every card (JOYA AI's and a hired session's) and `status.approval_timeout_s` use it |
| `token-caps` | – | `{day, warn_pct, default:{cap, at} or null, sessions:[{key, name, kind (self, hired, kept, yours), session_id, cap, at, today:{input, output, cache_read, cache_write, total}, state (none, ok, near, warned, paused, resumed), paused, resumed, warned, can_pause}], held, updated_by, updated_at}` |
| `token-caps-set` | `key` (`<self>`, `default`, a hire slug, a session id) with `cap` (tokens, or `null` to remove) and/or `at` (warn, pause); and/or `warn_pct` (50..100, the same `budget.warn_pct` as `cost-budget`) | the same as `token-caps`. `at: pause` on a "yours" session is refused |
| `budget-resume` | `key` or `decision_id` (a cap card) | `{resumed, was_paused, session}`: resumed for the rest of the day |
| `ui-pages` | – / `pages` (≤ 500 `{key, parent?, kind, label, url, perm?}`) / `reset: true` | `{pages, count, applied, stored, updated_by, updated_at}`; see *The page map*. A read is not audited |
| `charter` | – | `{path, text, bytes, truncated, modified_at}`: JOYA AI's CLAUDE.md (in `cfg.cwd`), at most 64 KB, read-only |
| `session-link` | `slug` | a hired session's runner only (actor `session.<slug>`): reply `{linked, paused, approval_timeout_s}`, then `{"control": {"op": "budget-pause" or "budget-resume", "reason"}}` lines |

`status` also carries `paused_at_cap` (JOYA AI held at its daily token cap) and
`process.cwd` / `process.tz`. Decisions gain kind `cap` (below). New event:
`cap` (`{key, state: warned, paused or released}`).

**Token caps per session (build spec §6).** `token_caps` in the ledger:
`{default:{cap, at}, sessions:{"<self>" | slug | session id: {cap, at}}}`; a new
hire copies `default`. The cap counts **total** tokens including cache, the
same figure as "N tok today" (`features.tokensToday`; for JOYA AI the per-turn
figure when a transcript scan has not caught up). Check points: every JOYA AI
turn end and every cost scan tick (`cost_scan_s`), so another session's cap acts
within that. Past the warn line (`budget.warn_pct`) a session is only `near`.
Past a `warn` cap: one Decision card per session per Cairo day ("Demo Own
passed its daily cap", `actions: ["dismiss"]`) and a `notice`. Past a `pause`
cap: a card "… passed its daily cap — paused" (`actions: ["resume",
"dismiss"]`: resume = `budget-resume {decision_id}`, dismiss = leave paused) and:
- **JOYA AI:** the supervisor hands the CLI no queued turn (orders, watchers,
  decisions, the administrator's own messages) until Resume or the day turns; a
  running turn finishes. A turn the CLI starts on its own (a peer's message,
  Remote Control) is interrupted; a message is kept and queued (source
  `cap-held`) when it is released; a cross-session notice is only interrupted.
- **Hired / kept:** `budget-pause` down the runner's `session-link`.
  `bin/joya-session` lets the running tool call finish, sends the CLI an
  `interrupt`, interrupts any turn that starts while paused and holds its own
  first prompt; a peer's message goes to the CLI directly, so it cannot be held
  -- it is interrupted and stays in the transcript. Backstop: `hooks/gate.js`
  denies every tool call ("daily token cap reached") while `token_caps_state`
  records the session paused today (a catch-all `--cap-only` hook, plus the
  normal gate).
- **Yours** (the administrator's own sessions): warn only, never paused.

`token_caps_state` (`{day, sessions:{key:{warned_at, paused_at, resumed_at,
resumed_by}}, held}`) survives a restart; the first check point of a new day
clears it, releases what it paused and closes its cards. Resume, raising the cap
above today's use, removing it or switching it to warn lifts a pause; a
resumed session is not paused again that day. Cap cards (decisions columns
`cap_at`, `cap_day`; `subject` = the cap key, also given as `cap_key`) refuse
`decision-ask` and `decision-approve`. Tests: `tools/test-caps.cjs`.

**The page map (build spec §5).** The dashboard pushes JOYA AI's allowed page
registry with `ui-pages {pages}`; it is stored (`ui_pages`) and handed to
`UiActions.setPages(pages)` when lib/ui-actions.js has it (`applied`), and
re-applied at every supervisor start. `reset` removes it (`setPages(null)`).
Keys `^[a-z0-9][a-z0-9._-]{0,63}$`, unique; `url` site-relative (one leading
`/`, no scheme, no `//`, no spaces or quotes), labels ≤ 120 characters. The
`ui_do` / `ui_actions_list` schemas do not change. Keep a push under the
socket's 64 KB line limit (roughly 400-500 short entries).

## The user's own computers (laptop control, Path A, 2026-10-08)

`lib/machines.js` + `lib/machine-gate.js`; the dashboard holds the registry and the app's link
(`dashboard/lib/machines.js`). A take-over hires a session that runs ON the computer: a
`hired_sessions` row with `machine_id` (new column) and `cwd` `machine:<id>`, no systemd unit; the
desktop app runs Claude Code there under a lease. It counts against the live limit, shows in the
spheres, can never be kept, and `session_retire` / `machine_release` end it at once.

- **Who may take over** (`machine-take-over`): the administrator (the Computers page), or JOYA AI
  (`machine_take_over`) during a turn the administrator started — typed in the Command Center
  (`dashboard`), or a live-call turn (`voice-desk`) whose `send` carried `vp: "command"` (the
  voiceprint named the speaker and they may give commands). Never a watcher, an order, a peer, a
  hired session or a laptop report.
- **Ops:** `machines-sync` (actor `machines`), `machines`, `machine-take-over`, `machine-tell`,
  `machine-release`; from the dashboard for one computer (actor `machine.<id>`): `machine-ask`,
  `machine-ask-cancel`, `machine-report`, `machine-state`. Event `machine` {what: start | tell | stop}.
- **Gate** (`machine-ask` → `machine-gate.decide`): allow at once (reads and writes in the user's own
  files, ordinary commands), a card (delete, install, send over the network, change the system,
  outside the user's files, WebFetch, every `mcp__joya-hands__*` approval), deny (disk wipes,
  switching off security, obfuscated or downloaded-and-run code, credential dumps, elevation). Cards
  are the hired sessions' own (`origin session:<slug>`, `origin_name` the session's name).
  Paused at a token cap: denied.
- **Reports:** each laptop turn's final text → a background turn for JOYA AI (source `machine`),
  marked as the laptop session's words. The end of a lease retires the hire and tells JOYA AI.
- Tests: `node joya-ai/tools/test-machines.cjs` (56 checks, scratch supervisor).

## Command Center v3, phase 1

`lib/features.js` holds everything below and is wired into the supervisor at
a few points (a turn's result and end, a delegation, an approval, a hook
event). All of its state is in the ledger, so a restart loses nothing.

- **Missions** (`lib/missions.js`, tables `missions`, `steps`, `mission_turns`).
  JOYA AI plans a multi-step goal with its own MCP tools (`bin/joya-ai-mcp`,
  passed with `--mcp-config` and allowed with `--allowedTools mcp__joya-ai`):
  `mission_create`, `mission_step_add`, `mission_step_update`,
  `mission_update`, `mission_list`, `mission_get`. A delegation whose first line
  carries `M-<id> step <n>` is linked to that step (or, untagged, to the one
  step marked delegated to that target), and its lifecycle then drives the
  step: sent → delegated, working/ack → working, held or a pending card →
  waiting approval, done → done, failed/denied → failed. A mission is done when
  every step is done or skipped. Chosen over a CLI because typed tools need no
  shell quoting and do not go through the Bash gate; `joya-ai-ctl` speaks the
  same ops for a human.
- **Status snapshot for JOYA AI.** The same server has `status_snapshot`: the
  supervisor's read-only `snapshot` op (the voice desk's view, `lib/snapshot.js`)
  asked for as actor `joya-ai`, with no arguments. It answers from the caches the
  supervisor keeps anyway -- no helper call, no subprocess, no model round spent on
  Bash -- and holds counts, titles and figures, never a command, fix or evidence;
  the server drops the forbidden keys again and the desk's own request list. The
  charter tells JOYA AI to use it first for status questions.
- **Hired sessions (M-6).** JOYA AI may hire a worker session on its own and
  may retire one only with the administrator's consent (fact #779). Tools
  `session_hire` {name, cwd, purpose, model?} → op `session-hire`, and
  `session_retire` {name | ref | session_id, note?} → op `session-retire`
  (schemas frozen by test-mcp; no enums). A hire (`lib/hire.js`: at most 7 live
  sessions, cwd under /root/joya or /root and never hidden, a unique normalised
  name, a sanitised slug, 3 hires an hour; the limits and the permission mode
  are settings since 2026-09-30, op `hire-limits-set`) is recorded in the ledger's
  `hired_sessions`, written to `<state_dir>/sessions/<slug>.json` and started as
  its own systemd unit `joya-session@<slug>.service` (`deploy/joya-session@.service`,
  `enable --now`: it outlives dashboard and JOYA AI restarts and reboots).
  `bin/joya-session` runs the same CLI as JOYA AI, as root with HOME=/root (root's
  registry, memory MCP and hooks; ListAgents lists it, SendMessage reaches it),
  `-n <name>`, `--session-id` then `--resume`, the permission mode set at hire
  time (the record's `permission_mode`; else `auto` or `hired_permission_mode`; never bypassPermissions, never
  --dangerously-skip-permissions), the gate added with `--settings` under
  `JOYA_GATE_SESSION=hired.<slug>` (built-in rules, classifier, deny / ask rules
  -- never JOYA AI's always-allow rules), and `--permission-prompt-tool stdio`:
  each question goes to op `session-approval` (actor `session.<slug>`) and is a
  card in the Command Center from that session, with no "Always allow"; no answer
  or no supervisor is a deny. Its first message is the purpose, marked as from
  JOYA AI. `session_retire` from JOYA AI never ends anything: it raises a
  SessionRetire card (Retire / Keep); only on Retire is the unit disabled and
  stopped (SIGTERM, stdin closed, transcript kept). Kept sessions and sessions
  not hired here are refused. The administrator keeps / unkeeps (`session-keep`)
  or retires (`session-retire`, a human actor) from a sphere's right-click menu
  or the sessions sheet. Everything is audited. Tests: `tools/test-hire.cjs`
  (fake systemctl, fake CLI, scratch registry).
- **Screen actions for JOYA AI (UI control Phase 2; stable since M-5).** Two
  tools: `ui_actions_list` (read-only, answered here from `UiActions.catalog()`:
  every action, what it does, its tier, `needs_confirm`, `once_per_request`, its
  arguments and allowed values -- page.open's page keys with the permission each
  needs) and `ui_do` (args: `action` plus, as the action needs, `key` / `mode` /
  `name` / `core` / `page` / `on` / `theme` / `preset` / `voice`, flat, from the
  shared allowlist `lib/ui-actions.js` -- a byte-identical copy of
  `dashboard/public/ui-actions.js`, tested) → op `ui-action`. `ui_do`'s schema
  is fixed (`UiActions.stableSchema()`, held by a snapshot test): `action` is a
  plain string, no enums, because a resumed claude CLI keeps the schema it first
  loaded for a tool (its deferred_tools_record) -- the earlier `ui_action`
  carried an enum, so a CLI that loaded it before page.open existed never saw
  page.open. `ui_action` is gone from this server; the new name is discovered
  fresh. Validation is unchanged: the supervisor and the page both run
  `validate()`. The supervisor
  accepts it only from actor `joya-ai`, only while a turn runs that the
  administrator sent from the Command Center with a one-time ui token (`send.ut`,
  minted by the dashboard; kept in memory with the turn, never in the ledger,
  events or audit -- the audit writes `(set)` -- and dropped when the turn ends),
  within 6 a turn / 20 a minute. It then emits a live-only `ui` event (seq 0,
  never in the ring, so never replayed) carrying `ut_tag` = sha256(token)[0:16],
  not the token; the dashboard delivers it only to the tab whose send minted the
  token, and that tab answers with `ui-ack` (only the same user, once). The tool
  returns `ok`, `refused` (with why) or `no-screen` after 5 s -- or `confirm`
  for a Tier-2 preference (theme.set, persona.set, voice.set; `ui-ack` with
  `pending`): nothing changed until the administrator confirms (Phase 3, see
  dashboard/README.md). Needs a joya-ai restart to load (new ops, new MCP tool).
- **Decisions and watchers** (`lib/watchers.js`, tables `decisions`,
  `watchers`). Every 30 s: the helper's `service-list` (a unit failed) and
  `pulse-feed` (fail2ban bans > 20 in 10 min; an agent started 3 times in 10
  min), statfs (root filesystem ≥ 85 %), and a read-only tail of the TRIAL
  box's `/var/log/odoo/odoo.log` (≥ 5 ERROR lines in 5 min). Live Odoo is not
  watched. A firing raises a decision card and queues (never interrupts) a
  JOYA AI turn to investigate read-only and call `decision_propose`. Approve
  queues a turn to run exactly the proposed fix, which still goes through the
  gate (a destructive fix raises its own card; that is deliberate, not a
  bypass); Ask more queues a follow-up; Dismiss closes it. One open card per
  (watcher, subject) — repeats bump its count; a closed subject is quiet for
  `watcher_cooldown_s` (1800); at most `watcher_max_investigations_per_hour`
  (4) investigations, past that the card is raised "rate-limited" with an
  Investigate button. Switches persist in `watchers`.
- **Standing orders** (`lib/schedule.js`, tables `orders`, `order_runs`).
  Five-field cron in `Africa/Cairo` (DST-aware: a doubled time runs once, a
  skipped one just after the jump). The editor's kinds compile to cron: daily,
  Sunday–Thursday (Egypt's working week), weekly, every N hours, cron. A 15 s
  tick moves `next_run_at` on BEFORE starting a run, so a crash or a supervisor
  that was down across several runs runs a missed order once, never a burst; a
  run still going is not stacked. Seeded: **Morning briefing, 07:30 daily**,
  THIS VPS only (services, disk, sign-ins and bans, JOYA AI's activity,
  missions), no live Odoo, no live credential. The result is the turn's reply,
  shown as a card in the Conversation. **Delivery is the Command Center only**:
  the Telegram agents keep their bot tokens to themselves and offer no
  supported way to post on JOYA AI's behalf.
- **Approval rules** (`lib/rules.js`, table `rules`). allow / ask / deny, a glob
  pattern over the whole Bash command (deny and ask also match one command of a
  compound) or `"<target>: <message>"` for SendMessage, scope JOYA AI on this
  VPS. Order: built-in deny (force push; pushing `a-maraghy/gizaseeds-Odoo19` or
  from `/opt/odoo/custom`) > config deny (the delegation allow-list) > a deny
  rule > built-in ask (anything touching live Odoo — no allow overrides it) >
  the most specific allow/ask rule (ask on a tie) > the classifier. `hooks/gate.js`
  reads the rules read-only from the ledger (built-ins are in code, so they hold
  without it; an unreadable store asks) and reports a matched rule's use to the
  hook socket. The supervisor applies the same rules to `can_use_tool`, so a
  rule answers there too (recorded as an approval `decided_by rule:<id>`).
  "Always allow this" saves an exact-command rule that must match the card's
  own call. Built-ins cannot be edited or deleted. Rules for other sessions
  (their settings) are a phase 2 question; phase 1 never writes other sessions'
  settings.
- **Cost** (`lib/cost.js`, tables `cost_daily`, `cost_files`, `cost_names`,
  `settings`). **Trap:** `turns.cost_usd` is the CLI's running total for the
  process — and a restarted process that RESUMES the session carries the
  session's total on (2026-09-30: the first turn after a restart recorded
  $51.75, of which $0.52 was its own). Each result stores `proc_start` and
  `cost_delta_usd`, the difference from the previous turn; only a process that
  started a new session (stamp ending `#new`) or a total that went down starts
  from its own total. Every row is recomputed at start
  (`cost.recomputeTurnDeltas`, idempotent; it also corrected the rows the old
  rule inflated: 11 rows, $343.29 -> $9.77 on the live ledger's copy). Other sessions: token usage from their transcripts (sub-agents
  included, once per message id) × list prices, scanned incrementally with
  offsets in the ledger — "estimated API-equivalent". Optional daily budget with
  a warn percentage.
- **Machine**: this VPS only — vitals and the tracked units from `service-list`.
- **Session mirror**: a read-only view of any session's transcript tail.


## Tests

```bash
node joya-ai/tools/test-classifier.cjs        # the gate's classifier
node joya-ai/tools/test-rules.cjs             # approval rules + the real gate hook
node joya-ai/tools/test-schedule.cjs          # cron, Cairo DST, missed runs
node joya-ai/tools/test-watchers.cjs          # thresholds, dedup, cooldown, rate limit
node joya-ai/tools/test-missions-cost.cjs     # missions store, cost deltas, transcript scan
node joya-ai/tools/test-usage.cjs             # plan usage (get_usage shaping, cache, probe) and token counts
sudo node joya-ai/tools/test-features.cjs     # all of phase 1 through a real supervisor
node joya-ai/tools/test-protocol.cjs          # socket validation, peer-text parsing
node joya-ai/tools/test-mcp.cjs               # the MCP server's status_snapshot, ui_actions_list, ui_do, session_hire and session_retire tools
node joya-ai/tools/test-hire.cjs              # hire / keep / retire end to end (fake systemctl + fake CLI)
node joya-ai/tools/test-caps.cjs              # hire limits, approval timeout, token caps, page map, charter
sudo node joya-ai/tools/test-ui-action.cjs    # ui-action / ui-ack through a real supervisor
node joya-ai/tools/test-turnqueue.cjs         # queue order: users first, FIFO, no starvation
sudo node joya-ai/tools/test-queue.cjs        # the queue + status_snapshot through a real supervisor
sudo node joya-ai/tools/test-supervisor.cjs   # the whole supervisor against a fake CLI
node dashboard/tools/test-joyaai.cjs          # the panel's client and permission
```

### End-to-end against the real CLI (2026-09-27, CLI 2.1.283)

Run with `delegation_allow` set to `^joya-e2e-target( \[[0-9a-f]+\])?$` so
JOYA AI could not reach any real session, and reset to `[]` afterwards. The
target was a throwaway headless Haiku session named `joya-e2e-target` in a
scratch directory, stopped at the end.

- `claude agents --json` lists `JOYA AI`, cwd `/root/joya-ai`, idle.
- A harmless turn through the socket answered ("JOYA AI online, running on
  Claude Opus 5.5"); the init event reported `permissionMode: auto`.
- Delegation: JOYA AI called `ListAgents`, then `SendMessage` with
  `notify_when_idle`. Ledger: **sent → working → ack** (reply `PONG-E2E`, sender
  pid from its socket path) **→ done** (idle notice). The reply started a
  `peer` turn on its own and JOYA AI relayed it.
- Gate: `rm` of a scratch file raised card #1 (category *delete*); **denied** —
  the file stayed and JOYA AI said it would not retry. A delegation telling the
  target to delete a file raised card #2 (*delegation*); **approved** and sent.
  A second direct `rm` raised card #3; **approved** — the file was deleted.
- Remote Control returned a `session_url` at start and after every restart.
- `systemctl restart joya-ai` resumed the same session id (one transcript
  file); asked what came before, JOYA AI named the previous request.
- Through the panel (a scratch instance of the dashboard as `joyaadmin`, with a
  throwaway admin): login, `/overview`, `/rc`, ledger, CSRF refusals, SSE with
  `X-Accel-Buffering: no`, and a send whose reply streamed back over SSE,
  audited under the panel user.
- The socket answered `joyaadmin` and refused `joyaconsole`, `joyaagent` and
  `nobody` (EACCES).
