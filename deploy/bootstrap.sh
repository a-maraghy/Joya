#!/usr/bin/env bash
#
# Provision the JOYA agent stack on a fresh VPS. Idempotent: safe to re-run
# after a change, and re-running is how you upgrade the runtime.
#
#   sudo bash /opt/joya/deploy/bootstrap.sh
#
# What it does NOT do: give the agents a Claude credential. That is a secret and
# only you should handle it -- the script creates the file and tells you what to
# put in it.

set -euo pipefail


ROOT=/opt/joya-agents
RUNTIME="$ROOT/runtime"
SHARED="$ROOT/shared"
AGENT_USER=joyaagent

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }

# ---------------------------------------------------------------- packages --

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  python3 python3-venv python3-pip git curl ca-certificates rsync sqlite3 \
  >/dev/null

if ! command -v node >/dev/null; then
  say "Installing Node.js 22 (needed by the Claude CLI)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v claude >/dev/null; then
  say "Installing the Claude Code CLI globally"
  npm install -g @anthropic-ai/claude-code >/dev/null
fi
say "Claude CLI: $(command -v claude) $(claude --version 2>/dev/null || echo '(version unknown)')"

# ------------------------------------------------------------------ account --

if ! id "$AGENT_USER" >/dev/null 2>&1; then
  say "Creating the $AGENT_USER service account"
  useradd --system --home-dir "$SHARED/home" --create-home \
          --shell /usr/sbin/nologin "$AGENT_USER"
else
  say "Service account $AGENT_USER already exists"
fi

# ------------------------------------------------------------------ layout --

say "Creating $ROOT"
mkdir -p "$ROOT" "$RUNTIME" "$SHARED/home" "$SHARED/models" \
         "$ROOT/agents" "$ROOT/archived" "$ROOT/workspaces" /opt/projects
chown root:root "$ROOT"
chmod 0755 "$ROOT"
chown -R "$AGENT_USER:$AGENT_USER" "$SHARED" "$ROOT/agents" "$ROOT/workspaces"
chmod 0750 "$ROOT/agents" "$ROOT/archived"

# ----------------------------------------------------------------- runtime --

# The runtime ships in this repository (agents/); copy it into place, keeping
# the venv that lives beside it.
say "Installing the agent runtime"
rsync -a --delete --exclude venv --exclude data --exclude .env "$REPO_DIR/agents/" "$RUNTIME/"
HAVE_RUNTIME=0
[[ -f "$RUNTIME/pyproject.toml" || -f "$RUNTIME/setup.py" ]] && HAVE_RUNTIME=1

if [[ ! -x "$RUNTIME/venv/bin/python" ]]; then
  say "Creating the runtime virtualenv"
  python3 -m venv "$RUNTIME/venv"
fi

say "Installing the runtime and the memory package"
"$RUNTIME/venv/bin/pip" install --quiet --upgrade pip wheel
if [[ $HAVE_RUNTIME == 1 ]]; then "$RUNTIME/venv/bin/pip" install --quiet "$RUNTIME"; fi
"$RUNTIME/venv/bin/pip" install --quiet "$REPO_DIR/memory"

# ------------------------------------------------------------ vault template --

say "Installing the vault template"
rsync -a --delete "$REPO_DIR/deploy/vault-template/" "$ROOT/vault-template/"
chown -R "$AGENT_USER:$AGENT_USER" "$ROOT/vault-template"

# -------------------------------------------------------------- embeddings --

say "Downloading the embedding model (once, ~130MB)"
# Done as the agent account so the cache is owned by the account that will read
# it; done now so the first memory search does not pay for a download.
runuser -u "$AGENT_USER" -- env \
  JOYA_MODEL_CACHE="$SHARED/models" HOME="$SHARED/home" \
  "$RUNTIME/venv/bin/python" -m joya_memory.cli warm || \
  warn "model warm-up failed -- the first search will download it instead"

# ------------------------------------------------------------ claude auth ---

AUTH="$SHARED/claude-auth.env"
if [[ ! -f "$AUTH" ]]; then
  say "Creating $AUTH (empty -- you must fill it in)"
  cat > "$AUTH" <<'EOF'
# Claude credential shared by every agent. Exactly one of these two lines.
#
# Subscription (recommended -- no per-token billing):
#   run `claude setup-token` as a user with a browser, then paste the result:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
#
# Or pay-as-you-go API billing:
# ANTHROPIC_API_KEY=sk-ant-api03-...
EOF
else
  say "Claude credential file already present"
fi
chown "root:$AGENT_USER" "$AUTH"
chmod 0640 "$AUTH"

if ! grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$AUTH"; then
  warn "No Claude credential set yet. Agents will start and then fail to answer."
  warn "Fix: put CLAUDE_CODE_OAUTH_TOKEN=... into $AUTH (see the comments in it)."
fi

# ------------------------------------------------------------ systemd unit --

say "Installing the agent systemd template"
install -m 0644 "$REPO_DIR/dashboard/deploy/joya-agent@.service" \
        /etc/systemd/system/joya-agent@.service
systemctl daemon-reload

# ---------------------------------------------------------------- helper ----

say "Installing the privileged helper"
install -m 0755 "$REPO_DIR/dashboard/deploy/joya-helper" /usr/local/sbin/joya-helper
python3 -m py_compile /usr/local/sbin/joya-helper
install -m 0440 "$REPO_DIR/dashboard/deploy/joya-sudoers" /etc/sudoers.d/joya-dashboard
visudo -cf /etc/sudoers.d/joya-dashboard >/dev/null

say "Done."
echo
echo "  Agent root:      $ROOT"
echo "  Runtime:         $RUNTIME  ($(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo 'from this checkout'))"
echo "  Service account: $AGENT_USER"
echo
if ! grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$AUTH"; then
  echo "  NEXT: add a Claude credential to $AUTH, then create an agent in the dashboard."
else
  echo "  NEXT: create an agent in the dashboard."
fi
