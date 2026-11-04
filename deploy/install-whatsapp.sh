#!/usr/bin/env bash
#
# Install the WhatsApp bridge runtime.
#
#   sudo bash /opt/joya/deploy/install-whatsapp.sh
#
# Separate from bootstrap.sh on purpose. WhatsApp support pulls in a large
# dependency tree and rests on an unofficial library; installing it should be a
# decision, not something that happens to every box by default.
#
# The caveat, stated once more where it cannot be missed: linking a number this
# way is against WhatsApp's terms of service, and the number can be banned
# without warning. Use one you can afford to lose.

set -euo pipefail

ROOT=/opt/joya-agents
TARGET="$ROOT/whatsapp"
AGENT_USER=joyaagent
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
[[ -d "$REPO_DIR/whatsapp" ]] || { echo "no whatsapp/ in $REPO_DIR" >&2; exit 1; }

command -v node >/dev/null || { echo "node is not installed; run bootstrap.sh first" >&2; exit 1; }

say "Installing the bridge into $TARGET"
mkdir -p "$TARGET"
install -m 0644 "$REPO_DIR/whatsapp/bridge.mjs" "$TARGET/bridge.mjs"
install -m 0644 "$REPO_DIR/whatsapp/package.json" "$TARGET/package.json"

say "Installing dependencies (this pulls a large tree)"
(cd "$TARGET" && npm install --omit=dev --no-audit --no-fund) >/dev/null

say "Checking the bridge parses"
node --check "$TARGET/bridge.mjs"

chown -R "$AGENT_USER:$AGENT_USER" "$TARGET"
chmod 0755 "$TARGET"

say "Installing the systemd template"
install -m 0644 "$REPO_DIR/dashboard/deploy/joya-whatsapp@.service" \
        /etc/systemd/system/joya-whatsapp@.service
systemctl daemon-reload

say "Done."
echo
echo "  Bridge:  $TARGET"
echo "  Unit:    joya-whatsapp@<channel>.service"
echo
echo "  Next: create a WhatsApp channel in the panel, connect it to an agent,"
echo "        then press 'Start linking' and scan the QR code with your phone."
echo
warn "Linking a number with an unofficial library breaks WhatsApp's terms of"
warn "service. The number can be banned. Use one you can afford to lose."
