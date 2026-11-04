# Joya

Formerly JOYA; its assistant, JOYA AI, was JOYA AI. The repository, services,
paths and internal identifiers (`joya-ai`, `joya-dashboard`, `JOYA_*`) keep their old names.

Control panel for a fleet of Claude agents on a single VPS.

Two things, kept separate. An **agent** is a Claude session with its own
workspace and its own memory — an Obsidian vault plus a local vector index over
it. A **channel** is how people reach that agent: a Telegram bot, or a linked
WhatsApp number. You create both from a web panel and each comes up as a systemd
unit. Nothing is shared between agents.

Keeping them apart means you can swap the bot an agent answers on, or move it
from Telegram to WhatsApp, without rebuilding the agent or losing a word of its
memory.

```
You, on Telegram or WhatsApp
      │
      ▼
  channel                   credential + allow-list; connects outbound only
      │
      ▼
  joya-agent@<name>         systemd unit, runs as the joyaagent account
  or joya-whatsapp@<chan>
      │
      ├─ Claude Agent SDK ──▶ claude CLI ──▶ Anthropic
      ├─ vault/               the only directory it may read or write
      └─ memory MCP server ─▶ vault (Markdown) + vectors (local embeddings)
```

---

## What is in here

| Path | What it is |
|---|---|
| `dashboard/` | The web panel: Node, server-rendered, no client framework |
| `joya-ai/` | JOYA AI: the supervisor for the root CEO Claude Code session, its approval gate, ledger and hooks |
| `dashboard/deploy/` | Privileged helper, systemd units, nginx, fail2ban, sudoers |
| `memory/` | `joya-memory` — vector + keyword memory over an Obsidian vault, exposed to Claude over MCP |
| `whatsapp/` | The WhatsApp bridge — Baileys + Claude Agent SDK, one process per channel |
| `voiceprint/` | `joya-voiceprint` — local speaker embeddings for the live voice's voiceprint (Unix socket, ONNX Runtime, no torch) |
| `deploy/` | Bootstrap, deployment and migration scripts, the vault template |
| `docs/` | Setup, Telegram, memory internals, operations |

The agent runtime itself — the Telegram↔Claude bridge — lives in `agents/`
(Python, MIT licence); the bootstrap script copies it onto the server and builds
its virtualenv.

---

## Quick start

The fast way: **`install.sh`** installs Joya on this
computer or on a cloud server and asks only a few plain questions:

```bash
curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh | sudo bash
```

By hand, on a fresh Ubuntu 24.04 box, as root:

```bash
git clone https://github.com/a-maraghy/Joya.git /opt/joya
bash /opt/joya/deploy/bootstrap.sh
```

That installs the Claude CLI, creates the `joyaagent` service account, copies and
builds the agent runtime, downloads the embedding model, and installs the
privileged helper and systemd template.

Then give the agents a Claude credential — this is the one step the script
deliberately leaves to you, because it is a secret:

```bash
claude setup-token                     # run where you have a browser
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' \
  | sudo tee /opt/joya-agents/shared/claude-auth.env
sudo chown root:joyaagent /opt/joya-agents/shared/claude-auth.env
sudo chmod 640 /opt/joya-agents/shared/claude-auth.env
```

Deploy the panel, then create your first agent in it:

```bash
sudo bash /opt/joya/deploy/deploy-dashboard.sh
```

Optional extras:

```bash
# Obsidian on the desktop, to read and edit agent memory by hand
sudo bash /opt/joya/deploy/install-obsidian.sh

# whisper.cpp, for local voice-note transcription
sudo bash /opt/joya/deploy/install-whisper.sh

# The panel's voice transcribing on this server instead of OpenAI (needs the
# whisper.cpp build above); then pick a model in JOYA AI > Settings > Voice
sudo bash /opt/joya/deploy/install-voice-whisper.sh

# WhatsApp channels (unofficial library — see the caveat in whatsapp/README.md)
sudo bash /opt/joya/deploy/install-whatsapp.sh
```

Full walkthrough — including creating the Telegram bot — is on the panel's own
**Guide** page, and in [`docs/telegram.md`](docs/telegram.md).

---

## Memory

The interesting part. A Telegram session dies on timeout, restart, or `/new`;
nothing in the conversation survives it. Files do.

```
vault/
├── CLAUDE.md      identity and standing rules   → system prompt, every request
├── MEMORY.md      current state + note index    → system prompt, every request
├── WORKLOG.md     dated narrative
└── memory/*.md    one durable fact per file, linked with [[wikilinks]]
```

`MEMORY.md` is in the prompt, so it has a budget — it is the map, not the
territory. The notes it points at are indexed instead: chunked by heading,
embedded by a small ONNX model **running on the box**, stored in a per-agent
SQLite database with `sqlite-vec`. The agent calls `memory_search` before
answering anything that depends on prior work.

Search is hybrid. Dense vectors catch paraphrase ("how do we deploy" finding
"release procedure"); FTS5 catches the exact tokens embeddings lose (error
codes, flag names, IDs); the two rankings are merged with reciprocal rank
fusion, which needs no score calibration between them.

Two properties worth stating plainly:

- **Files are the source of truth, the index is a cache.** Delete
  `vectors/memory.db` and press Reindex; nothing is lost. Edit a note by hand in
  Obsidian and the agent picks it up on its next search, with nothing to tell it.
- **Nothing leaves the machine to be embedded.** An agent's memory is the most
  sensitive thing it holds, and it is not worth sending to a third party for a
  few points of retrieval quality.

See [`docs/memory.md`](docs/memory.md).

---

## Security model

The central assumption: **this panel can grant SSH access and create processes
that run model-authored commands, so compromising it means compromising the
server.** Everything below follows from that.

| Layer | What it does |
|---|---|
| TLS | Let's Encrypt, TLS 1.2/1.3 only, HSTS. nginx terminates. |
| Authentication | Username + Argon2id password + TOTP 2FA. All three required. (`JOYA_PASSWORD_ONLY=1`, which Joya sets: username + password only; approvals ask for the password.) |
| Session | httpOnly, secure, sameSite=strict, regenerated on login. |
| CSRF | Per-session token on every state-changing POST. |
| Rate limiting | nginx `limit_req` plus an in-app limiter. |
| Brute force | fail2ban on the app's own auth log: 5 fails / 10 min = 2h ban. |
| Privilege | Panel runs as `joyaadmin` (nologin). Can sudo exactly one binary. |
| Agent sandbox | Agents run as `joyaagent` under a systemd sandbox: read-only filesystem apart from their own directory, `NoNewPrivileges`, `PrivateTmp`. |

### The privilege boundary

The Node process is unprivileged and **has no ability to run root commands**. It
can only do this:

```
sudo /usr/local/sbin/joya-helper <subcommand> [args]
```

`/etc/sudoers.d/joya-dashboard` permits exactly that one binary — no wildcards,
no shell. The helper then validates every argument against a whitelist, never
invokes a shell, restricts SSH targets to `root` and `ubuntu`, restricts agent
names to a strict slug pattern, restricts project directories to three
permitted roots, confines vault file access to `.md`/`.json`/`.txt` inside the
agent's own vault, and appends every change to an audit log.

So even a full remote-code-execution bug in the web app does not directly yield
root — the attacker inherits only the validated operations.

**Bot tokens go over stdin, never argv.** Command lines are world-readable in
`/proc` for the lifetime of a call; a token passed as an argument is a token any
local user can read.

**Agent deletion archives, it does not erase.** A vault is months of accumulated
memory and there is no undo for `rm -rf`, so deletion moves the whole directory
to `/opt/joya-agents/archived/<slug>-<timestamp>`.

---

## Gotchas worth remembering

- **`NoNewPrivileges` must stay `false` in the *dashboard* unit** — the panel
  escalates via sudo. It is deliberately `true` in the *agent* unit, which does
  not.
- **No inline styles either.** The CSP is `style-src 'self'`, so a `style=""`
  attribute is blocked outright and shows up as a console violation. Use a class;
  for a value computed at render time (the meter fill) use a `data-` attribute
  with enumerated CSS rules.
- **Vertical rhythm is one rule, not per-page margins.** `--gap` in
  `style.css` is the single spacing value: `.content > *` gives every block that
  bottom margin, grids use it as their gutter, and the last child clears it. Do
  not add ad-hoc margins to space something out — it will disagree with the rest
  of the app the moment the layout changes.
- **No inline event handlers.** The CSP sets `script-src-attr 'none'`, so
  `onclick=` is dead. Use `data-confirm` and the delegated listener in
  `public/app.js`.
- **One poller per bot token.** Telegram allows exactly one; two agents sharing
  a token makes both drop messages at random.
- **nginx 1.24** wants `listen ... ssl http2`, not the standalone `http2 on;`
  from 1.25.1+.
- **`trust proxy` is `loopback` only.** Widening it lets a remote client spoof
  `X-Forwarded-For` and defeat the fail2ban jail.
- Port 80 is reserved for ACME renewal only.
- **`joya-agent@` is the Telegram runtime.** A WhatsApp-only agent is served by
  `joya-whatsapp@<channel>` instead; starting both would crash-loop on a bot
  token that does not exist.
- **Add-ons are configuration, not plugins.** The catalogue in
  `dashboard/lib/catalog.js` must only reference settings the runtime actually
  reads — `deploy/resync-addons.js` re-derives every environment from it.

---

## Recovering from a lockout

If you lose the TOTP device, SSH in and clear the admin row — the next visit to
`/setup` with a fresh token lets you re-enrol:

```bash
systemctl stop joya-dashboard
sqlite3 /var/lib/joya-dashboard/joya.db 'DELETE FROM admin;'
rm -f /var/lib/joya-dashboard/setup.token
systemctl start joya-dashboard
cat /var/lib/joya-dashboard/setup.token
```

Moving to a new laptop: [`docs/new-laptop.md`](docs/new-laptop.md).

---

## Third-party models

**Voiceprint** (`voiceprint/`, `deploy/install-voiceprint.sh`, JOYA AI ▸ Settings ▸ Voice ▸ Voiceprint):
the speaker-embedding model is **WeSpeaker ResNet34-LM** (trained on VoxCeleb2) by the
[WeSpeaker](https://github.com/wenet-e2e/wespeaker) project, file `voxceleb_resnet34_LM.onnx` from
<https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM>, used unmodified, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The install script checks its SHA-256
(`7bb2f06e…ec068`) and writes a NOTICE next to it in `/var/lib/joya-voiceprint/models/`.

