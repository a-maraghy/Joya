#!/usr/bin/env bash
#
# Install (or update) joya-voiceprint: the local speaker-embedding service the
# live voice's voiceprint uses (voiceprint/server.py, Unix socket only).
#
#   sudo bash deploy/install-voiceprint.sh            (from the Joya checkout)
#
# Run by deploy/deploy-dashboard.sh on every deploy (JOYA_VOICEPRINT_SKIP=1
# skips it). Idempotent and quick when nothing changed: the venv is rebuilt
# only when requirements.txt changes, the model only when its checksum is not
# the one below, the service restarted only when its code or unit changed.
#
# What it does:
#   - the account joyavoiceprint (system, no login) and its group; joyaadmin
#     (the dashboard) joins the group, which is what lets it open the socket --
#     effective at the dashboard's next restart;
#   - /opt/joya-voiceprint: server.py, fbank.py, the tests, and a venv with
#     numpy + onnxruntime only (no torch; about 90 MB);
#   - /var/lib/joya-voiceprint/models/voxceleb_resnet34_LM.onnx (27 MB),
#     WeSpeaker ResNet34-LM, CC-BY-4.0, from its official Hugging Face
#     repository (or copied from the voiceprint trial's download when that
#     file has the same SHA-256); checked against the SHA-256 below;
#   - joya-voiceprint.service, enabled and (re)started; then /health on the socket.
#
# Memory while running: ~150 MB. Nothing here stores audio or voiceprints.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/voiceprint"
UNIT_SRC="$REPO_DIR/dashboard/deploy/joya-voiceprint.service"
OPT=/opt/joya-voiceprint
DATA=/var/lib/joya-voiceprint
USER_NAME=joyavoiceprint
MODEL_FILE=voxceleb_resnet34_LM.onnx
MODEL_SHA=7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068
MODEL_URL=https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/$MODEL_FILE
MODEL_FROM="${JOYA_VOICEPRINT_MODEL_FROM:-/root/.local/joya-voiceprint/models/wespeaker-voxceleb-resnet34-LM/$MODEL_FILE}"
SOCK=/run/joya-voiceprint/voiceprint.sock

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { echo "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run this with sudo"
[[ -f "$SRC/server.py" && -f "$UNIT_SRC" ]] || die "no voiceprint/ or unit in $REPO_DIR"

say "voiceprint: account $USER_NAME"
getent group "$USER_NAME" >/dev/null || groupadd --system "$USER_NAME"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin -g "$USER_NAME" "$USER_NAME"
if id -u joyaadmin >/dev/null 2>&1; then usermod -aG "$USER_NAME" joyaadmin; fi

say "voiceprint: code in $OPT"
install -d -m 0755 -o root -g root "$OPT" "$DATA" "$DATA/models"
CHANGED=0
for f in server.py fbank.py test_voiceprint.py requirements.txt; do
  if ! cmp -s "$SRC/$f" "$OPT/$f"; then install -m 0644 -o root -g root "$SRC/$f" "$OPT/$f"; CHANGED=1; fi
done

REQ_SHA=$(sha256sum "$OPT/requirements.txt" | cut -d' ' -f1)
if [[ ! -x "$OPT/venv/bin/python" || "$(cat "$OPT/venv/.requirements" 2>/dev/null || true)" != "$REQ_SHA" ]]; then
  say "voiceprint: venv (numpy + onnxruntime)"
  rm -rf "$OPT/venv"
  python3 -m venv "$OPT/venv"
  "$OPT/venv/bin/pip" install -q --upgrade pip
  "$OPT/venv/bin/pip" install -q -r "$OPT/requirements.txt"
  echo "$REQ_SHA" > "$OPT/venv/.requirements"
  chown -R root:root "$OPT/venv"
  CHANGED=1
fi

DEST="$DATA/models/$MODEL_FILE"
if [[ -f "$DEST" ]] && echo "$MODEL_SHA  $DEST" | sha256sum -c --status; then
  echo "   model in place ($MODEL_FILE)"
else
  say "voiceprint: model $MODEL_FILE"
  TMP=$(mktemp "$DATA/models/.dl.XXXXXX")
  if [[ -f "$MODEL_FROM" ]] && echo "$MODEL_SHA  $MODEL_FROM" | sha256sum -c --status; then
    cp "$MODEL_FROM" "$TMP"
    echo "   copied from $MODEL_FROM (same SHA-256 as the official file)"
  else
    curl -fsSL --retry 3 -o "$TMP" "$MODEL_URL" || { rm -f "$TMP"; die "could not download $MODEL_URL"; }
  fi
  echo "$MODEL_SHA  $TMP" | sha256sum -c --status || { rm -f "$TMP"; die "the model's SHA-256 is not $MODEL_SHA"; }
  chmod 0644 "$TMP"
  mv "$TMP" "$DEST"
  CHANGED=1
fi
cat > "$DATA/models/NOTICE" <<'EOF'
voxceleb_resnet34_LM.onnx -- WeSpeaker ResNet34-LM speaker embedding model (VoxCeleb2),
by the WeSpeaker project (https://github.com/wenet-e2e/wespeaker), from
https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM, licensed CC-BY-4.0
(https://creativecommons.org/licenses/by/4.0/). Used unmodified.
EOF
chown -R root:root "$DATA"

if ! cmp -s "$UNIT_SRC" /etc/systemd/system/joya-voiceprint.service; then
  install -m 0644 "$UNIT_SRC" /etc/systemd/system/joya-voiceprint.service
  systemctl daemon-reload
  CHANGED=1
fi
systemctl enable joya-voiceprint >/dev/null 2>&1 || true
if [[ $CHANGED -eq 1 ]] || ! systemctl is-active --quiet joya-voiceprint; then
  say "voiceprint: (re)starting joya-voiceprint"
  systemctl restart joya-voiceprint
fi
for _ in $(seq 1 50); do [[ -S "$SOCK" ]] && break; sleep 0.2; done
if curl -fsS --max-time 5 --unix-socket "$SOCK" http://x/health >/dev/null; then
  say "voiceprint: up ($(curl -fsS --unix-socket "$SOCK" http://x/health | head -c 160))"
else
  echo "voiceprint: the service did not answer on $SOCK -- the voice keeps working without it (fail-open):" >&2
  journalctl -u joya-voiceprint -n 20 --no-pager >&2 || true
fi
