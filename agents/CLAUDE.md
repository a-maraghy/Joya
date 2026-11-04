# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram bot providing remote access to Claude Code. Python 3.10+, built with Poetry, using `python-telegram-bot` for Telegram and `claude-agent-sdk` for Claude Code integration.

## Commands

```bash
make dev              # Install all deps (including dev)
make install          # Production deps only
make run              # Run the bot
make run-debug        # Run with debug logging
make test             # Run tests with coverage
make lint             # Black + isort + flake8 + mypy
make format           # Auto-format with black + isort

# Run a single test
poetry run pytest tests/unit/test_config.py -k test_name -v

# Type checking only
poetry run mypy src
```

## Architecture

### Claude SDK Integration

`ClaudeIntegration` (facade in `src/claude/facade.py`) wraps `ClaudeSDKManager` (`src/claude/sdk_integration.py`), which uses `claude-agent-sdk` with `ClaudeSDKClient` for async streaming. Session IDs come from Claude's `ResultMessage`, not generated locally.

Sessions auto-resume: per user+directory, persisted in SQLite.

### Request Flow

**Agentic mode** (default, `AGENTIC_MODE=true`):

```
Telegram message -> Security middleware (group -3) -> Auth middleware (group -2)
-> Rate limit (group -1) -> MessageOrchestrator.agentic_text() (group 10)
-> ClaudeIntegration.run_command() -> SDK
-> Response parsed -> Stored in SQLite -> Sent back to Telegram
```

**External triggers** (webhooks, scheduler):

```
Webhook POST /webhooks/{provider} -> Signature verification -> Deduplication
-> Publish WebhookEvent to EventBus -> AgentHandler.handle_webhook()
-> ClaudeIntegration.run_command() -> Publish AgentResponseEvent
-> NotificationService -> Rate-limited Telegram delivery
```

**Classic mode** (`AGENTIC_MODE=false`): Same middleware chain, but routes through full command/message handlers in `src/bot/handlers/` with 13 commands and inline keyboards.

### Dependency Injection

Bot handlers access dependencies via `context.bot_data`:
```python
context.bot_data["auth_manager"]
context.bot_data["claude_integration"]
context.bot_data["storage"]
context.bot_data["security_validator"]
```

### Key Directories

- `src/config/` -- Pydantic Settings v2 config with env detection, feature flags (`features.py`), YAML project loader (`loader.py`)
- `src/bot/handlers/` -- Telegram command, message, and callback handlers (classic mode + project thread commands)
- `src/bot/middleware/` -- Auth, rate limit, security input validation
- `src/bot/features/` -- Git integration, file handling, quick actions, session export
- `src/bot/orchestrator.py` -- MessageOrchestrator: routes to agentic or classic handlers, project-topic routing
- `src/claude/` -- Claude integration facade, SDK/CLI managers, session management, tool monitoring
- `src/projects/` -- Multi-project support: `registry.py` (YAML project config), `thread_manager.py` (Telegram topic sync/routing)
- `src/storage/` -- SQLite via aiosqlite, repository pattern (users, sessions, messages, tool_usage, audit_log, cost_tracking, project_threads)
- `src/security/` -- Multi-provider auth (whitelist + token), input validators (with optional `disable_security_patterns`), rate limiter, audit logging
- `src/events/` -- EventBus (async pub/sub), event types, AgentHandler, EventSecurityMiddleware
- `src/api/` -- FastAPI webhook server, GitHub HMAC-SHA256 + Bearer token auth
- `src/scheduler/` -- APScheduler cron jobs, persistent storage in SQLite
- `src/notifications/` -- NotificationService, rate-limited Telegram delivery

### Security Model

5-layer defense: authentication (whitelist/token) -> directory isolation (APPROVED_DIRECTORY + path traversal prevention) -> input validation (blocks `..`, `;`, `&&`, `$()`, etc.) -> rate limiting (token bucket) -> audit logging.

`SecurityValidator` blocks access to secrets (`.env`, `.ssh`, `id_rsa`, `.pem`) and dangerous shell patterns. Can be relaxed with `DISABLE_SECURITY_PATTERNS=true` (trusted environments only).

`ToolMonitor` validates Claude's tool calls against allowlist/disallowlist, file path boundaries, and dangerous bash patterns. Tool name validation can be bypassed with `DISABLE_TOOL_VALIDATION=true`.

Webhook authentication: GitHub HMAC-SHA256 signature verification, generic Bearer token for other providers, atomic deduplication via `webhook_events` table.

### Configuration

Settings loaded from environment variables via Pydantic Settings. Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `APPROVED_DIRECTORY`. Key optional: `ALLOWED_USERS` (comma-separated Telegram IDs), `ANTHROPIC_API_KEY`, `ENABLE_MCP`, `MCP_CONFIG_PATH`.

Agentic platform settings: `AGENTIC_MODE` (default true), `ENABLE_API_SERVER`, `API_SERVER_PORT` (default 8080), `GITHUB_WEBHOOK_SECRET`, `WEBHOOK_API_SECRET`, `ENABLE_SCHEDULER`, `NOTIFICATION_CHAT_IDS`. `WEBHOOK_FRESH_SESSION` (default false): run each webhook event in a new Claude session (`force_new`) instead of auto-resuming the user's session, so a stream of events does not keep re-reading a growing history. Chat messages keep their own session (`claude_session_id` in user_data), so an agent that must answer follow-ups about an event needs to record what it did somewhere it can look up (JOYA Pace keeps a mail ledger).

Security relaxation (trusted environments only): `DISABLE_SECURITY_PATTERNS` (default false), `DISABLE_TOOL_VALIDATION` (default false).

Multi-project topics: `ENABLE_PROJECT_THREADS` (default false), `PROJECT_THREADS_MODE` (`private`|`group`), `PROJECT_THREADS_CHAT_ID` (required for group mode), `PROJECTS_CONFIG_PATH` (path to YAML project registry), `PROJECT_THREADS_SYNC_ACTION_INTERVAL_SECONDS` (default `1.1`, set `0` to disable pacing). See `config/projects.example.yaml`.

JOYA group options (all default to the old behaviour): `PROJECT_THREADS_GENERAL_PROJECT` (route the forum's General topic to a project, with its own per-topic session kept in `thread_sessions.json` next to the DB), `GROUP_RESPOND_MODE` (`all`|`mention`) + `BOT_NAME_ALIASES` (respond-when-asked gate in group -4, `src/bot/addressing.py`: unaddressed group messages are dropped before any middleware, silently), `PROJECT_THREADS_AUTO_MAP` + `_AUTO_ANNOUNCE`/`_AUTO_MAX`/`_DELETED_TOPICS`/`_TRASH_DAYS`/`_PROBE_INTERVAL_SECONDS` (`src/projects/auto_topics.py`: new forum topics get `topics/<slug>` folders recorded in `projects.auto.json`, which this process owns and the JOYA panel only reads; deleted topics are found by probing `editForumTopic` because Telegram sends no deletion event, two definite not-founds in a row, then the folder moves to `.trash/topics/`).

Files back into the chat: `ALLOW_FILE_SEND` (default true), `FILE_SEND_MAX_MB` (default 20, max 50 = Telegram's bot limit), `FILE_SEND_MAX_PER_REPLY` (default 5). `src/claude/file_send.py`: the orchestrator builds a `ReplyFileSender` bound to `update.effective_message` and passes it as `file_sender=` through `run_command` -> `execute_command`, which adds an in-process MCP server `joya_files` (tool `send_file(path, caption)`, no chat argument) and a short how-to-make-documents guide to the system prompt. Posting is `message.reply_document`, so the file lands where the text reply does. Not `create_sdk_mcp_server`: that helper breaks on mcp 2.x; `_ToolServer` implements the two handlers the SDK's router calls, and a unit test runs the SDK's router against it. Scheduler/webhook runs pass no sender, so they have no tool.

Pictures drawn in code: `ALLOW_DRAWING` (default true, only with `ALLOW_FILE_SEND`), `DRAW_MAX_RENDER_PX` (2048), `DRAW_MAX_RENDERS_PER_REPLY` (12), `SVG_MAX_KB` (2048). `src/claude/drawing.py`: `check_svg` (deny-by-default: DOCTYPE/entities, script/foreignObject/HTML, on* handlers, any href/url() except `#id` and inline `data:image/png|jpeg|gif|webp`), resvg rendering in a child process (`python -I -c`, RLIMIT_AS/CPU, timeout, empty resources_dir), contact sheets and the 32/64 px strip composed as SVG and rendered again, and `DRAWING_GUIDE` (the playbook appended to the file guide). The sender's `drawing` policy adds `render_svg` and `contact_sheet` to `joya_files`; their results carry MCP `image` content, which the SDK forwards and the CLI shows to the model (verified against the real CLI 2.1.283). `send_file(preview=true)` posts the SVG as a document then a PNG photo via `reply_photo`; both count against `FILE_SEND_MAX_PER_REPLY`.

ChatGPT on request: `ALLOW_CHATGPT` (default true), `CHATGPT_MCP_SERVER` (default `/usr/local/lib/joya-chatgpt/chatgpt_mcp.py`). `src/claude/chatgpt_tool.py` adds the Joya ChatGPT broker's stdio MCP server `chatgpt` (tool `ask_chatgpt`, Joya `chatgpt/chatgpt_mcp.py`) to every run when that file exists, with `JOYA_CHATGPT_FILES_ROOT` = the approved directory (context files only from there) and `JOYA_CHATGPT_OUT` = `<approved>/chatgpt` (files ChatGPT made, sendable with send_file), plus a short prompt line: use it only when the user explicitly asks. The broker (`joya-chatgpt.service`, `/run/joya-chatgpt/sock`) holds the one ChatGPT sign-in; the runtime never sees it. Tests switch it off by default (`tests/conftest.py`).

Output verbosity: `VERBOSE_LEVEL` (default 1, range 0-2). Controls how much of Claude's background activity is shown to the user in real-time. 0 = quiet (only final response, typing indicator still active), 1 = normal (tool names + reasoning snippets shown during execution), 2 = detailed (tool names with input summaries + longer reasoning text). Users can override per-session via `/verbose 0|1|2`. A persistent typing indicator is refreshed every ~2 seconds at all levels.

Voice transcription: `ENABLE_VOICE_MESSAGES` (default true), `VOICE_PROVIDER` (`mistral`|`openai`|`local`, default `mistral`), `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `VOICE_TRANSCRIPTION_MODEL`. For local provider: `WHISPER_CPP_BINARY_PATH`, `WHISPER_CPP_MODEL_PATH` (requires ffmpeg + whisper.cpp installed). Provider implementation is in `src/bot/features/voice_handler.py`.

Feature flags in `src/config/features.py` control: MCP, git integration, file uploads, quick actions, session export, image uploads, voice messages, conversation mode, agentic mode, API server, scheduler.

### DateTime Convention

All datetimes use timezone-aware UTC: `datetime.now(UTC)` (not `datetime.utcnow()`). SQLite adapters auto-convert TIMESTAMP/DATETIME columns to `datetime` objects via `detect_types=PARSE_DECLTYPES`. Model `from_row()` methods must guard `fromisoformat()` calls with `isinstance(val, str)` checks.

## Code Style

- Black (88 char line length), isort (black profile), flake8, mypy strict, autoflake for unused imports
- pytest-asyncio with `asyncio_mode = "auto"`
- structlog for all logging (JSON in prod, console in dev)
- Type hints required on all functions (`disallow_untyped_defs = true`)
- Use `datetime.now(UTC)` not `datetime.utcnow()` (deprecated)

## Adding a New Bot Command

### Agentic mode

Agentic mode commands: `/start`, `/new`, `/status`, `/verbose`, `/repo`. If `ENABLE_PROJECT_THREADS=true`: `/sync_threads`. To add a new command:

1. Add handler function in `src/bot/orchestrator.py`
2. Register in `MessageOrchestrator._register_agentic_handlers()`
3. Add to `MessageOrchestrator.get_bot_commands()` for Telegram's command menu
4. Add audit logging for the command

### Classic mode

1. Add handler function in `src/bot/handlers/command.py`
2. Register in `MessageOrchestrator._register_classic_handlers()`
3. Add to `MessageOrchestrator.get_bot_commands()` for Telegram's command menu
4. Add audit logging for the command
