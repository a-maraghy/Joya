#!/usr/bin/env bash
#
# Joya -- installs Mint OS in a few minutes, asking only what it must.
#
#   curl -fsSL https://raw.githubusercontent.com/a-maraghy/Joya/main/install.sh | sudo bash
#
# Every question can be answered ahead of time, for a run with no questions at all
# (this is what the AI install prompt in PROMPT.md does):
#
#   JOYA_WHERE=local|cloud   where Mint OS runs: this computer, or a cloud server
#   JOYA_PORT=3000           local: the port the panel listens on
#   JOYA_DOMAIN=mint.example.com   cloud: the domain (empty = the server's IP address)
#   JOYA_EMAIL=you@example.com     cloud: email for certificate reminders (optional)
#   JOYA_YES=1               do not ask "Install now?"
#
# Advanced: JOYA_REPO / JOYA_REF (the Mint OS repository and branch), JOYA_DIR (where
# its code is kept, /opt/moni-ai-os), JOYA_HTTPS_PORT (cloud, 443).
#
# Safe to run again: it updates what is there and keeps your data and settings.

set -euo pipefail

JOYA_URL="https://github.com/a-maraghy/Joya"
REPO="${JOYA_REPO:-https://github.com/a-maraghy/MONI_AI_OS.git}"
REF="${JOYA_REF:-main}"
DIR="${JOYA_DIR:-/opt/moni-ai-os}"
ANSWERS=/etc/joya/answers.env
DATA=/var/lib/moni-dashboard
LOG=/var/log/joya-install.log

# ------------------------------------------------------------------ output --

if [[ -t 1 ]]; then B=$'\033[1m'; G=$'\033[1;32m'; Y=$'\033[1;33m'; C=$'\033[1;36m'; R=$'\033[1;31m'; N=$'\033[0m'
else B=; G=; Y=; C=; R=; N=; fi
step() { printf '\n%s==>%s %s\n' "$C" "$N" "$*"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
note() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die() { printf '\n%sJoya stopped:%s %s\n' "$R" "$N" "$*" >&2; [[ -f $LOG ]] && printf 'Details: %s\n' "$LOG" >&2; exit 1; }
# A long step's own chatter goes to the log; the screen shows one line per step.
quiet() { "$@" >>"$LOG" 2>&1 || die "this step failed: $*"; }

# Questions come from the keyboard even when the script itself arrives through a pipe.
TTY=/dev/tty
[[ -r $TTY ]] && { : <"$TTY"; } 2>/dev/null || TTY=
ask() { # ask VAR "Question" "default"
  local var=$1 q=$2 def=${3-} a=
  if [[ -n ${!var+x} ]]; then return; fi
  # No keyboard on a re-run: the earlier answer stands.
  if [[ -z $TTY && $HAVE_PREV == 1 ]]; then printf -v "$var" '%s' "$def"; return; fi
  [[ -n $TTY ]] || die "no keyboard to ask \"$q\" -- set $var=... (see the top of install.sh)."
  if [[ -n $def ]]; then printf '%s%s%s [%s]: ' "$B" "$q" "$N" "$def" >"$TTY"; else printf '%s%s%s: ' "$B" "$q" "$N" >"$TTY"; fi
  IFS= read -r a <"$TTY" || true
  printf -v "$var" '%s' "${a:-$def}"
}
choose() { # choose VAR "Question" default value1 "Label 1" value2 "Label 2"
  local var=$1 q=$2 def=$3 a= d=1; shift 3
  if [[ -n ${!var+x} ]]; then return; fi
  if [[ -z $TTY && -n $def ]]; then printf -v "$var" '%s' "$def"; return; fi
  [[ -n $TTY ]] || die "no keyboard to ask \"$q\" -- set $var=... (see the top of install.sh)."
  printf '\n%s%s%s\n' "$B" "$q" "$N" >"$TTY"
  local i=1 vals=()
  while (($#)); do vals+=("$1"); [[ $1 == "$def" ]] && d=$i; printf '  %d) %s\n' "$i" "$2" >"$TTY"; shift 2; i=$((i + 1)); done
  while :; do
    printf 'Type a number [%d]: ' "$d" >"$TTY"; IFS= read -r a <"$TTY" || true; a=${a:-$d}
    if [[ $a =~ ^[0-9]+$ ]] && ((a >= 1 && a <= ${#vals[@]})); then printf -v "$var" '%s' "${vals[a - 1]}"; return; fi
    printf '  Please type a number from the list.\n' >"$TTY"
  done
}

# ------------------------------------------------------------ the machine --

[[ $(uname -s) == Linux ]] || die "Mint OS runs on Linux. On a Mac, install it on a cloud server instead; on Windows, use Ubuntu in WSL (see $JOYA_URL#windows)."
if [[ $EUID -ne 0 ]]; then
  [[ -f $0 ]] && command -v sudo >/dev/null || die "Joya needs administrator rights: run it with sudo (curl -fsSL .../install.sh | sudo bash)."
  printf 'Joya needs administrator rights; sudo may ask for your password.\n'
  exec sudo -E bash "$0" "$@"
fi
. /etc/os-release 2>/dev/null || true
[[ ${ID:-} == ubuntu || ${ID:-} == debian || ${ID_LIKE:-} == *ubuntu* || ${ID_LIKE:-} == *debian* ]] ||
  die "Joya supports Ubuntu and Debian (this is ${PRETTY_NAME:-unknown}). Ubuntu 24.04 is the tested one."
[[ -d /run/systemd/system ]] ||
  die "systemd is not running. On Windows (WSL) add [boot] systemd=true to /etc/wsl.conf, run 'wsl --shutdown', then try again."
WSL=0; grep -qi microsoft /proc/version 2>/dev/null && WSL=1
install -d -m 0700 /etc/joya
: >>"$LOG"; chmod 0600 "$LOG"

# The answers of an earlier run are the defaults of this one.
HAVE_PREV=0
# shellcheck disable=SC1090
if [[ -f $ANSWERS ]]; then . "$ANSWERS"; HAVE_PREV=1; fi

# ---------------------------------------------------------------- questions --

printf '\n%sJoya%s -- installing %sMint OS%s\n' "$G" "$N" "$B" "$N"
printf 'A few short questions, then Joya does the rest. Press Enter to take the answer in [brackets].\n'

choose JOYA_WHERE "Where are you installing Mint OS?" "${PREV_WHERE:-}" \
  local "This computer -- just for me, opened in the browser here" \
  cloud "A cloud server -- reachable from anywhere, with HTTPS"
[[ $JOYA_WHERE == local || $JOYA_WHERE == cloud ]] || die "JOYA_WHERE must be local or cloud."

if [[ $JOYA_WHERE == local ]]; then
  ask JOYA_PORT "Which port should Mint OS use?" "${PREV_PORT:-3000}"
  [[ $JOYA_PORT =~ ^[0-9]+$ ]] && ((JOYA_PORT >= 1024 && JOYA_PORT <= 65535)) || die "the port must be a number from 1024 to 65535."
  HOST=localhost
  URL="http://localhost:$JOYA_PORT"
else
  IP=$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  printf '\nIf you have a domain for Mint OS, point it at this server (%s) first.\n' "${IP:-its address}"
  ask JOYA_DOMAIN "Your domain (example: mint.mycompany.com) -- or press Enter to use the IP address" "${PREV_DOMAIN:-}"
  JOYA_DOMAIN=$(printf '%s' "$JOYA_DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##')
  if [[ -n $JOYA_DOMAIN ]]; then
    [[ $JOYA_DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "\"$JOYA_DOMAIN\" does not look like a domain name."
    ask JOYA_EMAIL "Your email, for certificate reminders (optional)" "${PREV_EMAIL:-}"
    HOST=$JOYA_DOMAIN
  else
    [[ -n ${IP:-} ]] || die "could not find this server's IP address; give a domain instead (JOYA_DOMAIN=...)."
    JOYA_EMAIL=
    HOST=$IP
  fi
  HTTPS_PORT=${JOYA_HTTPS_PORT:-443}
  JOYA_PORT=${JOYA_PORT:-${PREV_PORT:-3000}}
  URL="https://$HOST$([[ $HTTPS_PORT == 443 ]] || printf ':%s' "$HTTPS_PORT")"
fi

printf '\n%sReady to install:%s\n' "$B" "$N"
if [[ $JOYA_WHERE == local ]]; then
  printf '  Where:   this computer\n  Address: %s\n' "$URL"
else
  printf '  Where:   this cloud server\n  Address: %s\n' "$URL"
  [[ -n $JOYA_DOMAIN ]] && printf '  HTTPS:   a free Let'"'"'s Encrypt certificate\n' ||
    printf '  HTTPS:   a self-made certificate (your browser will warn once -- a domain avoids this)\n'
fi
printf '  Takes:   about 5-10 minutes\n'
if [[ ${JOYA_YES:-0} != 1 && ! ( -z $TTY && $HAVE_PREV == 1 ) ]]; then
  ask GO "Install now? (yes/no)" "yes"
  [[ ${GO,,} == y || ${GO,,} == yes ]] || { printf 'Nothing was changed.\n'; exit 0; }
fi

{
  printf 'PREV_WHERE=%q\nPREV_PORT=%q\nPREV_DOMAIN=%q\nPREV_EMAIL=%q\n' "$JOYA_WHERE" "$JOYA_PORT" "${JOYA_DOMAIN:-}" "${JOYA_EMAIL:-}"
} >"$ANSWERS"
chmod 0600 "$ANSWERS"
printf '\n--- Joya %s ---\n' "$(date -u +%FT%TZ)" >>"$LOG"

# ----------------------------------------------------------------- install --

step "Installing the basics (git, Node.js, Python)"
export DEBIAN_FRONTEND=noninteractive
quiet apt-get update
quiet apt-get install -y git curl ca-certificates rsync build-essential python3 python3-venv openssl
ok "done"

step "Getting Mint OS"
if [[ -d $DIR/.git ]]; then
  quiet git -C "$DIR" fetch --quiet origin "$REF"
  quiet git -C "$DIR" checkout --quiet "$REF"
  quiet git -C "$DIR" reset --quiet --hard "origin/$REF"
else
  quiet git clone --quiet --branch "$REF" "$REPO" "$DIR"
fi
ok "$(git -C "$DIR" log -1 --format='%h %s' | cut -c1-70)"

step "Setting up the agent stack (this is the long step)"
# The agent runtime is a private repository: without access, the panel installs and
# agents wait for it. BatchMode: never stop to ask for an SSH password or host key.
quiet env MONI_RUNTIME_OPTIONAL=1 GIT_TERMINAL_PROMPT=0 \
  GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' \
  bash "$DIR/deploy/bootstrap.sh"
if [[ -f /opt/moni-agents/runtime/pyproject.toml || -f /opt/moni-agents/runtime/setup.py ]]; then
  ok "agents ready"; RUNTIME=1
else
  note "installed without the agent runtime (no access to it) -- the panel works; agents come later"; RUNTIME=0
fi

step "Setting up the Mint OS panel"
install -d /etc/systemd/system/moni-dashboard.service.d
{
  echo "# Written by Joya ($JOYA_URL); re-run the installer to change it."
  echo "[Service]"
  echo "Environment=MONI_BIND=127.0.0.1"
  echo "Environment=MONI_PORT=$JOYA_PORT"
  echo "Environment=MONI_PUBLIC_HOST=$HOST"
  if [[ $JOYA_WHERE == local ]]; then
    echo "Environment=MONI_PUBLIC_PORT=$JOYA_PORT"
    echo "Environment=MONI_LOCAL_HTTP=1"
  else
    echo "Environment=MONI_PUBLIC_PORT=$HTTPS_PORT"
  fi
} >/etc/systemd/system/moni-dashboard.service.d/joya.conf
systemctl daemon-reload
quiet env MONI_DEPLOY_NOWAIT=1 bash "$DIR/deploy/deploy-dashboard.sh"
quiet systemctl enable moni-dashboard
ok "running on 127.0.0.1:$JOYA_PORT"

if [[ $JOYA_WHERE == cloud ]]; then
  step "Putting HTTPS in front of it"
  quiet apt-get install -y nginx fail2ban
  install -d /var/www/certbot
  install -m 0644 "$DIR/dashboard/deploy/moni-proxy-params" /etc/nginx/moni-proxy-params
  SITE=/etc/nginx/sites-available/mint-os
  # Port 80 first: it answers the certificate check and sends everyone else to HTTPS.
  cat >"$SITE" <<EOF
# Written by Joya ($JOYA_URL).
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host$([[ $HTTPS_PORT == 443 ]] || printf ':%s' "$HTTPS_PORT")\$request_uri; }
}
EOF
  ln -sf "$SITE" /etc/nginx/sites-enabled/mint-os
  rm -f /etc/nginx/sites-enabled/default
  quiet nginx -t
  quiet systemctl reload-or-restart nginx
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    quiet ufw allow 80/tcp; quiet ufw allow "$HTTPS_PORT/tcp"; ok "firewall: opened 80 and $HTTPS_PORT"
  fi

  STAPLE=off
  if [[ -n $JOYA_DOMAIN ]]; then
    quiet apt-get install -y certbot
    if [[ -f /etc/letsencrypt/live/$HOST/fullchain.pem ]]; then
      ok "certificate already there"
    elif certbot certonly --webroot -w /var/www/certbot -d "$HOST" --non-interactive --agree-tos \
      $([[ -n $JOYA_EMAIL ]] && printf -- '--email %s' "$JOYA_EMAIL" || printf -- '--register-unsafely-without-email') >>"$LOG" 2>&1; then
      ok "free certificate for $HOST"
    else
      die "the certificate for $HOST could not be issued. Check that $HOST points at this server (${IP:-}) and that port 80 is open, then run Joya again."
    fi
    CERT=/etc/letsencrypt/live/$HOST/fullchain.pem; KEY=/etc/letsencrypt/live/$HOST/privkey.pem; STAPLE=on
    install -d /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/joya-reload-nginx.sh
    chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/joya-reload-nginx.sh
  else
    install -d -m 0700 /etc/joya/tls
    CERT=/etc/joya/tls/mint-os.crt; KEY=/etc/joya/tls/mint-os.key
    if [[ ! -f $CERT ]]; then
      quiet openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$HOST" \
        -addext "subjectAltName=IP:$HOST" -keyout "$KEY" -out "$CERT"
    fi
    ok "self-made certificate for $HOST"
  fi

  cat >>"$SITE" <<EOF

limit_req_zone \$binary_remote_addr zone=mint_login:10m rate=20r/m;

server {
    listen $HTTPS_PORT ssl http2;
    listen [::]:$HTTPS_PORT ssl http2;
    server_name $HOST;

    ssl_certificate     $CERT;
    ssl_certificate_key $KEY;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MintSSL:10m;
    ssl_session_tickets off;
    ssl_stapling $STAPLE;
    ssl_stapling_verify $STAPLE;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "same-origin" always;
    server_tokens off;
    client_max_body_size 48m;

    access_log /var/log/nginx/mint-os-access.log;
    error_log  /var/log/nginx/mint-os-error.log;

    location = /login { limit_req zone=mint_login burst=10 nodelay; proxy_pass http://127.0.0.1:$JOYA_PORT; include /etc/nginx/moni-proxy-params; }
    location = /pair  { limit_req zone=mint_login burst=10 nodelay; proxy_pass http://127.0.0.1:$JOYA_PORT; include /etc/nginx/moni-proxy-params; }
    location /        { proxy_pass http://127.0.0.1:$JOYA_PORT; include /etc/nginx/moni-proxy-params; }
}
EOF
  quiet nginx -t
  quiet systemctl reload nginx
  ok "HTTPS on port $HTTPS_PORT"

  install -m 0644 "$DIR/dashboard/deploy/fail2ban-filter.conf" /etc/fail2ban/filter.d/moni-dashboard.conf
  sed "s/^port .*/port     = $HTTPS_PORT/" "$DIR/dashboard/deploy/fail2ban-jail.conf" >/etc/fail2ban/jail.d/moni-dashboard.conf
  touch /var/log/moni-dashboard/auth.log
  quiet systemctl enable fail2ban
  quiet systemctl restart fail2ban
  ok "repeated wrong passwords are blocked (fail2ban)"
fi

# ------------------------------------------------------------------ finish --

step "Checking it answers"
TOKEN=
for _ in $(seq 1 30); do
  [[ -s $DATA/setup.token ]] && TOKEN=$(tr -d '\n' <"$DATA/setup.token") && break
  sleep 1
done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$JOYA_PORT/login" || true)
[[ $code =~ ^(200|302)$ ]] || die "the panel does not answer (HTTP ${code:-none}). See: journalctl -u moni-dashboard -n 50"
ok "Mint OS is up"

printf '\n%sMint OS is installed.%s\n\n' "$G" "$N"
# /login sends to /setup only while there is no admin yet; after that the link is dead.
if [[ -n $TOKEN && $code == 302 ]]; then
  printf 'Open this link to create your admin account (it works once):\n\n  %s%s/setup?token=%s%s\n\n' "$B" "$URL" "$TOKEN" "$N"
  [[ $JOYA_WHERE == cloud && -z $JOYA_DOMAIN ]] && printf 'Your browser will warn about the certificate once: choose Advanced, then Continue.\n'
  printf 'You will need an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password...) for the 6-digit code.\n'
else
  printf 'Open %s and sign in with your admin account.\n' "$URL"
fi
if [[ $JOYA_WHERE == local ]]; then
  printf 'Only this computer can open it. Mint OS starts by itself when the computer starts.\n'
fi
printf '\n%sNext:%s give the agents a Claude credential -- the panel'"'"'s Guide page shows how.\n' "$B" "$N"
((RUNTIME)) || printf 'Agents (Telegram, WhatsApp) also need the agent runtime: ask the Mint OS owner for access, then run Joya again.\n'
printf 'Run Joya again any time to update; your data stays. Help: %s\n' "$JOYA_URL"
