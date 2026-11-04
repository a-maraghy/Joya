# ChatGPT for every agent (`ask_chatgpt`)

Any agent on this server can hand a task to ChatGPT when the user asks for it
("ask ChatGPT…", "delegate this to GPT"). Never on its own initiative: the tool
description and each agent's prompt say so.

```
agent (Claude Code) --stdio--> chatgpt_mcp.py --unix socket--> broker.py --> codex exec
  runs as the agent's account     /run/joya-chatgpt/sock       joya-chatgpt.service (root, fenced)
```

- **One sign-in, one broker.** The user's ChatGPT login is `/root/.codex/auth.json`
  (Codex CLI, `codex login --device-auth`). Only the broker runs Codex with it; no
  copies (Codex rotates the refresh token, so copies would invalidate each other).
  Re-login: `joya-chatgpt login` as root. Check: `joya-chatgpt status`.
- **What ChatGPT can touch.** `codex exec --sandbox workspace-write` in a fresh
  `/var/lib/joya-chatgpt/tasks/<id>/work` (no network for its commands), inside the
  unit's systemd sandbox: system read-only, `/root` empty except `.codex`, `/opt`,
  logs, Odoo/JOYA AI/dashboard data and `/etc` secrets inaccessible. Root rather than
  a dedicated account because Codex's bubblewrap needs a user namespace, which this
  Ubuntu's AppArmor only grants unprivileged accounts with an extra profile.
  Answers and files are checked for the sign-in's tokens before they leave.
- **Limits** (`/etc/joya-chatgpt/config.json`): 2 tasks at a time, 8 queued, 10 min
  per task, answer cut at 60,000 characters, 20 files / 10 MB in, 20 files / 25 MB
  out, task folders kept 7 days, callers limited to root / joyaagent / joyaconsole
  (SO_PEERCRED). One log line per call: journal (`journalctl -u joya-chatgpt`) and
  `/var/lib/joya-chatgpt/calls.jsonl` (who, when, how long, outcome; never the task
  text). `joya-chatgpt log`.
- **Errors** come back as the tool's text: sign-in expired (run `joya-chatgpt login`),
  usage limit reached, timeout, busy, service not running.

## Who gets the tool

| Agent | Where it is wired | Context files from | Files ChatGPT made go to |
|---|---|---|---|
| Telegram agents (every slug, new ones too) | runtime `src/claude/chatgpt_tool.py` (agents/), `ALLOW_CHATGPT` | its vault only | `<vault>/chatgpt/<id>/` (send_file can post them) |
| JOYA AI | `joya-ai/supervisor.js` `mcpArgs()` + `lib/chatgpt.js` | anywhere (root) | `/root/joya-ai/chatgpt/<id>/` |
| Hired sessions | `joya-ai/bin/joya-session` | anywhere (root) | `/var/lib/joya-ai/chatgpt/<slug>/<id>/` |
| Console chats | `dashboard/deploy/joya-helper` `console_chatgpt_args` | full: anywhere; workspace: `/opt/joya-agents/agents` | the console account's `~/chatgpt/<id>/` |

Each loads `/usr/local/lib/joya-chatgpt/chatgpt_mcp.py` only if it exists, and
allows `mcp__chatgpt__ask_chatgpt` outright. Each reads its MCP config at start,
so a change here reaches a running agent at its next restart.

## Install / update

`sudo bash deploy/install-chatgpt.sh` (idempotent; restarts the broker only when
its code changed and nothing is running). Tests: `python3 chatgpt/test_chatgpt.py`
(fake Codex, no ChatGPT usage) and `node joya-ai/tools/test-chatgpt.cjs`.
