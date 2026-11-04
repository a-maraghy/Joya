# WhatsApp bridge

One process per WhatsApp channel, started by the panel as
`joya-whatsapp@<channel>.service`.

It owns a linked-device session — the same mechanism as WhatsApp Web — and hands
each incoming message to the Claude Agent SDK pointed at the agent's own vault.
The agent therefore has the same workspace, the same `CLAUDE.md`, the same
`MEMORY.md` and the same memory MCP server as its Telegram side. Gaining a
WhatsApp channel does not make it a different agent.

Voice notes go through the same ffmpeg → whisper.cpp pipeline as Telegram, and
files land in the same `attachments/inbox/<date>/` folder.

## The caveat

WhatsApp has no official API for this. Linking a number with an unofficial
library is against their terms of service and **the number can be banned without
warning**. Use a number you can afford to lose.

Baileys is also a release candidate and a moving target; pin the version, and
re-test after any upgrade.

## Configuration

Entirely from the environment, written by `joya-helper`:

| Variable | Meaning |
|---|---|
| `JOYA_CHANNEL_SLUG` / `JOYA_CHANNEL_DIR` | Which channel this process serves |
| `JOYA_AGENT_VAULT` | The agent's workspace — the SDK's `cwd` |
| `JOYA_MCP_CONFIG` | Path to the agent's `mcp.json`, giving it the memory tools |
| `JOYA_ALLOWED_NUMBERS` | Comma-separated. Empty means nobody, deliberately |
| `JOYA_MODEL`, `JOYA_MAX_TURNS`, `JOYA_AGENT_NAME` | Agent settings |
| `ENABLE_VOICE_MESSAGES`, `WHISPER_CPP_*` | Voice transcription |
| `ENABLE_FILE_UPLOADS`, `ATTACHMENT_MAX_SIZE_MB` | File capture |
| `CLAUDE_CODE_OAUTH_TOKEN` | Shared Claude credential |

## State

Written into the channel directory:

    session/        linked-device credentials (0600 — this is the account)
    runtime.json    status + current QR, read by the panel
    sessions.json   Claude session id per conversation
