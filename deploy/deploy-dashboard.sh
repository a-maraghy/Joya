#!/usr/bin/env bash
#
# Push dashboard code from this repo checkout to the running service.
#
#   sudo bash /opt/joya/deploy/deploy-dashboard.sh
#
# Syntax-checks before restarting: a broken server.js otherwise leaves systemd
# in a restart loop with the panel down and no obvious way back in.

set -euo pipefail

TARGET=/opt/joya-dashboard
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/dashboard"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
[[ -d "$SRC" ]] || { echo "no dashboard/ in $REPO_DIR" >&2; exit 1; }

# Live calls (dashboard/server.js keeps the count in live-calls.json): a restart of
# the dashboard ends them (the pages are told and reconnect by themselves), and a
# restart of joya-ai drops the requests JOYA AI is working on. Say so before
# anything changes; JOYA_DEPLOY_NOWAIT=1 skips the pause.
LIVE_STATUS=/var/lib/joya-dashboard/live-calls.json
if [[ -f "$LIVE_STATUS" ]]; then
  LIVE_N=$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Number(s.count)||0))}catch(e){process.stdout.write("0")}' "$LIVE_STATUS" 2>/dev/null || echo 0)
  if [[ "${LIVE_N:-0}" -gt 0 ]]; then
    printf '\n\033[1;33m!!\033[0m %s live call(s) open right now:\n' "$LIVE_N" >&2
    node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const c of s.calls||[])console.error("   "+c.call+"  "+c.actor+"  since "+c.since+"  ("+c.state+")")' "$LIVE_STATUS" 2>/dev/null || true
    echo "   Restarting the dashboard ends them; each page is told and reconnects by itself, with backoff." >&2
    if [[ "${JOYA_DEPLOY_NOWAIT:-0}" != "1" ]]; then
      echo "   Continuing in 10 s -- Ctrl-C to stop (JOYA_DEPLOY_NOWAIT=1 skips this pause)." >&2
      sleep 10
    fi
  fi
fi

# The tree being replaced, kept so a bad deploy is one tar command from undone.
if [[ -d "$TARGET" ]]; then
  BACKUP_DIR=/root/backups
  install -d -m 0700 "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/joya-dashboard_$(date +%Y%m%d_%H%M%S).tgz"
  say "Backing up the current tree to $BACKUP"
  tar -czf "$BACKUP" -C "$(dirname "$TARGET")" --exclude "$(basename "$TARGET")/node_modules" "$(basename "$TARGET")"
fi

# A fresh box (Joya's installer): the panel's account, data and log directories.
if ! id -u joyaadmin >/dev/null 2>&1; then
  say "Creating the joyaadmin service account"
  useradd --system --no-create-home --home-dir /var/lib/joya-dashboard --shell /usr/sbin/nologin joyaadmin
fi
install -d -m 0750 -o joyaadmin -g joyaadmin /var/lib/joya-dashboard /var/log/joya-dashboard

say "Syncing application code"
mkdir -p "$TARGET"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude 'deploy' \
  "$SRC/" "$TARGET/"

# What is deployed, for JOYA AI and anyone checking: the commit and when (read at start).
COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)
{ [[ -n "$COMMIT" ]] && echo "commit=$COMMIT"; echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; [[ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]] && echo "dirty=1"; } > "$TARGET/DEPLOYED" || true

say "Installing dependencies if package.json changed"
if [[ ! -d "$TARGET/node_modules" ]] || \
   [[ "$SRC/package.json" -nt "$TARGET/node_modules" ]]; then
  (cd "$TARGET" && npm install --omit=dev --no-audit --no-fund)
fi

say "Checking syntax before restarting"
for f in "$TARGET"/server.js "$TARGET"/lib/*.js; do
  node --check "$f"
done

say "Installing the privileged helper and unit files"
install -m 0755 "$SRC/deploy/joya-helper" /usr/local/sbin/joya-helper
python3 -m py_compile /usr/local/sbin/joya-helper

# Speech to text is OpenAI's by default (lib/voice.js). The old joya-whisper
# (tiny.en, port 8081) is not installed or started from here; Telegram voice
# notes run whisper-cli directly. Since 2026-09-30 the panel can transcribe on
# this server instead (Settings > Voice > Transcription): its unit is
# joya-voice-whisper.service, installed here so edits to it land, but started
# only by the panel when a local model is chosen. Its binary and models come
# from deploy/install-voice-whisper.sh (run once; without it the local options
# show as not installed).
install -m 0644 "$SRC/deploy/joya-voice-whisper.service" /etc/systemd/system/joya-voice-whisper.service

# The account the panel's console runs as. Separate from joyaagent so the two
# entitlements can never be confused for one another: this one holds full sudo,
# and an agent must never inherit it.
if ! id -u joyaconsole >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/joya-console/home \
          --shell /bin/bash joyaconsole
fi
# A real shell, not nologin: the console's Bash tool runs commands through one,
# and nologin made every command trip over a profile it could not read.
usermod --shell /bin/bash joyaconsole
# Reading the journal is most of what "check why this is unhappy" means. These
# groups grant it directly, so ordinary log reading does not need sudo and does
# not fill the sudo log with noise that hides the escalations worth seeing.
usermod -aG adm,systemd-journal joyaconsole
# 0711: the console account must walk through this to reach its own config and
# attachments. Everything below it keeps 0700, so this opens the door without
# opening the cupboards.
install -d -m 0711 -o root -g root /var/lib/joya-console
install -d -m 0700 -o joyaconsole -g joyaconsole /var/lib/joya-console/home
install -m 0644 "$SRC/deploy/joya-agent@.service" /etc/systemd/system/joya-agent@.service
# The dashboard's own unit was installed by hand once and then never again, so
# edits to it in the repo silently did nothing. Installing it here makes the
# repo the source of truth for it, like every other unit.
install -m 0644 "$SRC/deploy/joya-dashboard.service" /etc/systemd/system/joya-dashboard.service
install -m 0644 "$SRC/deploy/joya-whatsapp@.service" /etc/systemd/system/joya-whatsapp@.service
# JOYA AI's supervisor listens on a socket only root and the joyaai group can
# open; the panel reaches it by being in that group. Takes effect at the
# restart below.
getent group joyaai >/dev/null || groupadd --system joyaai
usermod -aG joyaai joyaadmin
install -m 0440 "$SRC/deploy/joya-sudoers" /etc/sudoers.d/joya-dashboard
visudo -cf /etc/sudoers.d/joya-dashboard >/dev/null
systemctl daemon-reload

# The live voice's voiceprint (Settings > Voice > Voiceprint): its local
# embedding service, joya-voiceprint (Unix socket, own account). Installed or
# updated here, before the restart below, because the dashboard's account joins
# the service's group and that takes effect when the dashboard restarts. A
# failure here does not stop the deploy: the relay fails open without it.
if [[ "${JOYA_VOICEPRINT_SKIP:-0}" != "1" ]]; then
  say "The voiceprint service"
  bash "$REPO_DIR/deploy/install-voiceprint.sh" || echo "!! the voiceprint service did not install; the voice works without it (fail-open)" >&2
fi

# ChatGPT for every agent (chatgpt/README.md): the joya-chatgpt broker and the
# ask_chatgpt MCP server the agents load. Skipped where the Codex CLI is absent;
# never restarted while a task runs through it.
if [[ "${JOYA_CHATGPT_SKIP:-0}" != "1" ]] && command -v codex >/dev/null; then
  say "The ChatGPT broker"
  bash "$REPO_DIR/deploy/install-chatgpt.sh" || echo "!! the ChatGPT broker did not install; agents report ChatGPT as unavailable" >&2
fi

say "Restarting the dashboard"
systemctl restart joya-dashboard
sleep 2
systemctl is-active --quiet joya-dashboard && say "Dashboard is up" || {
  echo "Dashboard failed to start:" >&2
  journalctl -u joya-dashboard -n 30 --no-pager >&2
  exit 1
}
