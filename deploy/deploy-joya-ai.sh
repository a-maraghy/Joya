#!/usr/bin/env bash
#
# Install or update JOYA AI: the supervisor, its hooks, the pinned Claude Code
# CLI, JOYA AI's home (charter + hook settings) and the systemd unit.
#
#   sudo bash deploy/deploy-joya-ai.sh               # install / update and restart
#   sudo bash deploy/deploy-joya-ai.sh --no-restart  # install, leave it running as is
#
# Restarting ends JOYA AI's current turn (the conversation is kept and resumed).
# Tests first, always:  node joya-ai/tools/test-classifier.cjs,
# test-protocol.cjs and (as root) test-supervisor.cjs.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/joya-ai"
TARGET=/opt/joya-ai
HOME_DIR=/root/joya-ai
CONF_DIR=/etc/joya-ai
RESTART=1
[[ "${1:-}" == "--no-restart" ]] && RESTART=0

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
[[ -f "$SRC/supervisor.js" ]] || { echo "no joya-ai/ in $REPO_DIR" >&2; exit 1; }

# Live calls (dashboard/server.js keeps the count in live-calls.json): a restart of
# the dashboard ends them (the pages are told and reconnect by themselves), and a
# restart of joya-ai drops the requests JOYA AI is working on. Say so before
# anything changes; JOYA_DEPLOY_NOWAIT=1 skips the pause.
LIVE_STATUS=/var/lib/joya-dashboard/live-calls.json
if [[ -f "$LIVE_STATUS" && $RESTART -eq 1 ]]; then
  LIVE_N=$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Number(s.count)||0))}catch(e){process.stdout.write("0")}' "$LIVE_STATUS" 2>/dev/null || echo 0)
  if [[ "${LIVE_N:-0}" -gt 0 ]]; then
    printf '\n\033[1;33m!!\033[0m %s live call(s) open right now:\n' "$LIVE_N" >&2
    node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const c of s.calls||[])console.error("   "+c.call+"  "+c.actor+"  since "+c.since+"  ("+c.state+")")' "$LIVE_STATUS" 2>/dev/null || true
    echo "   A joya-ai restart keeps the calls open but drops what JOYA AI is working on for them; --no-restart avoids that." >&2
    if [[ "${JOYA_DEPLOY_NOWAIT:-0}" != "1" ]]; then
      echo "   Continuing in 10 s -- Ctrl-C to stop (JOYA_DEPLOY_NOWAIT=1 skips this pause)." >&2
      sleep 10
    fi
  fi
fi

say "Checking syntax"
for f in "$SRC"/supervisor.js "$SRC"/lib/*.js "$SRC"/hooks/*.js "$SRC"/bin/joya-ai-ctl "$SRC"/bin/joya-ai-mcp "$SRC"/bin/joya-session; do
  node --check "$f"
done

say "The joyaai group (who may open the control socket)"
getent group joyaai >/dev/null || groupadd --system joyaai
# The panel is the one client. Group membership takes effect when the panel
# restarts, which deploy-dashboard.sh does.
id -u joyaadmin >/dev/null 2>&1 && usermod -aG joyaai joyaadmin

say "Installing the supervisor to $TARGET"
install -d -m 0755 "$TARGET" "$TARGET/cli"
rsync -a --delete --exclude cli --exclude home --exclude deploy "$SRC/" "$TARGET/"
# What is deployed, for JOYA AI and anyone checking: the commit and when (read at start).
COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)
{ [[ -n "$COMMIT" ]] && echo "commit=$COMMIT"; echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; [[ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]] && echo "dirty=1"; } > "$TARGET/DEPLOYED" || true
chmod 0755 "$TARGET/hooks/"*.js "$TARGET/bin/joya-ai-ctl" "$TARGET/bin/joya-ai-mcp" "$TARGET/bin/joya-session"
ln -sf "$TARGET/bin/joya-ai-ctl" /usr/local/bin/joya-ai-ctl

say "Configuration"
install -d -m 0755 "$CONF_DIR"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
  install -m 0644 "$SRC/deploy/config.json" "$CONF_DIR/config.json"
else
  echo "  keeping the existing $CONF_DIR/config.json"
fi
PIN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).cli_version)' "$CONF_DIR/config.json")

say "Pinning Claude Code $PIN"
# A copy, not a link to /usr/bin/claude: `claude update` or a desktop-app update
# would otherwise change the CLI under a running JOYA AI. Peer messaging,
# Remote Control in headless mode and can_use_tool are undocumented enough to
# re-verify on every new version before moving the pin (see the README).
PINNED="$TARGET/cli/claude-$PIN"
if [[ ! -x "$PINNED" ]]; then
  SOURCE="${CLAUDE_PIN_SOURCE:-$(readlink -f /usr/bin/claude)}"
  GOT=$("$SOURCE" --version | awk '{print $1}')
  [[ "$GOT" == "$PIN" ]] || { echo "$SOURCE is $GOT, config pins $PIN. Set CLAUDE_PIN_SOURCE to a $PIN binary." >&2; exit 1; }
  install -m 0755 "$SOURCE" "$PINNED"
fi
ln -sfn "claude-$PIN" "$TARGET/cli/claude"
"$TARGET/cli/claude" --version

say "JOYA AI's home, $HOME_DIR"
install -d -m 0700 "$HOME_DIR" "$HOME_DIR/.claude"
install -m 0644 "$SRC/home/CLAUDE.md" "$HOME_DIR/CLAUDE.md"
install -m 0644 "$SRC/README.md" "$HOME_DIR/README.md"
install -m 0644 "$SRC/home/.claude/settings.json" "$HOME_DIR/.claude/settings.json"

say "systemd unit"
install -m 0644 "$SRC/deploy/joya-ai.service" /etc/systemd/system/joya-ai.service
# Hired sessions (M-6): one template unit, instantiated per hire by the supervisor (joya-session@<slug>).
install -m 0644 "$SRC/deploy/joya-session@.service" /etc/systemd/system/joya-session@.service
systemctl daemon-reload
systemctl enable joya-ai >/dev/null 2>&1

if [[ $RESTART -eq 1 ]]; then
  say "Restarting joya-ai"
  systemctl restart joya-ai
else
  systemctl is-active --quiet joya-ai || systemctl start joya-ai
fi
sleep 3
systemctl is-active --quiet joya-ai && say "joya-ai is up" || {
  echo "joya-ai failed to start:" >&2
  journalctl -u joya-ai -n 40 --no-pager >&2
  exit 1
}
