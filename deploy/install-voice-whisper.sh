#!/usr/bin/env bash
#
# Install local transcription for the panel's voice (whisper.cpp on this
# server), the backend behind the "on this server" options of JOYA AI >
# Settings > Voice > Transcription (dashboard/lib/voice-transcribe.js).
#
#   sudo bash deploy/install-voice-whisper.sh [turbo] [small]     (from the Joya checkout)
#
# With no arguments both models are installed. Idempotent: a file already in
# place with the right checksum is left alone, so it is safe to run again.
#
# What it does:
#   - copies whisper-server and its libraries from the existing whisper.cpp
#     build (WHISPER_SRC, default /opt/joya-agents/shared/whisper.cpp -- the
#     Telegram agents' build, which is only READ here) into
#     /var/lib/joya-voice-whisper/bin, so a later rebuild of that tree cannot
#     change what the panel runs;
#   - puts the model files and the Silero VAD model in
#     /var/lib/joya-voice-whisper/models (root-owned, world-readable), copied
#     from JOYA_WHISPER_MODELS_FROM when that directory has them, otherwise
#     downloaded from Hugging Face; every file is checked against its SHA-256;
#   - installs joya-voice-whisper.service and reloads systemd. It does NOT
#     enable or start it: the panel does that (through joya-helper
#     voice-whisper-set) when a local model is selected, and stops it when an
#     OpenAI model is.
#
# Disk: large-v3-turbo q8_0 834 MB, small q8_0 252 MB, Silero 0.9 MB.
# Memory while selected: ~1.1 GB (turbo) or ~0.4 GB (small).

set -euo pipefail

WHISPER_SRC="${WHISPER_SRC:-/opt/joya-agents/shared/whisper.cpp}"
DIR="${JOYA_VOICE_WHISPER_DIR:-/var/lib/joya-voice-whisper}" # overridable only to test this script
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_DIR/dashboard/deploy/joya-voice-whisper.service"
SPEECH_USER=joyaspeech
HF=https://huggingface.co

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { echo "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run this with sudo"
[[ -f "$UNIT_SRC" ]] || die "no $UNIT_SRC"
command -v ffmpeg >/dev/null || die "ffmpeg is missing (apt-get install ffmpeg): the panel converts each recording with it"

# name|file|sha256|url -- the checksums are those of the files measured in the
# benchmark of 2026-09-30.
declare -A MODELS=(
  [turbo]="ggml-large-v3-turbo-q8_0.bin|317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1|$HF/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin"
  [small]="ggml-small-q8_0.bin|49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f|$HF/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin"
  [vad]="ggml-silero-v5.1.2.bin|29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf|$HF/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
)
WANT=("$@")
[[ ${#WANT[@]} -gt 0 ]] || WANT=(turbo small)
for w in "${WANT[@]}"; do [[ -n "${MODELS[$w]:-}" && "$w" != vad ]] || die "unknown model '$w' (turbo, small)"; done
WANT+=(vad)

say "Account $SPEECH_USER"
id -u "$SPEECH_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SPEECH_USER"

install -d -m 0755 -o root -g root "$DIR" "$DIR/bin" "$DIR/models" "$DIR/public"

say "whisper-server from $WHISPER_SRC (read only)"
BIN="$WHISPER_SRC/build/bin"
[[ -x "$BIN/whisper-server" ]] || die "no whisper-server in $BIN (build whisper.cpp first: deploy/install-whisper.sh)"
install -m 0755 -o root -g root "$BIN/whisper-server" "$DIR/bin/whisper-server"
for lib in "$BIN"/lib*.so*; do
  [[ -e "$lib" ]] || continue
  cp -P --preserve=mode "$lib" "$DIR/bin/"
done
chown -R root:root "$DIR/bin"
chmod -R a+rX "$DIR/bin"
git -C "$WHISPER_SRC" rev-parse --short HEAD > "$DIR/bin/SOURCE" 2>/dev/null || echo unknown > "$DIR/bin/SOURCE"
LD_LIBRARY_PATH="$DIR/bin" "$DIR/bin/whisper-server" --help >/dev/null 2>&1 || die "the copied whisper-server does not run"
echo "   built from whisper.cpp $(cat "$DIR/bin/SOURCE")"

for w in "${WANT[@]}"; do
  IFS='|' read -r file sum url <<<"${MODELS[$w]}"
  dest="$DIR/models/$file"
  if [[ -f "$dest" ]] && echo "$sum  $dest" | sha256sum -c --status; then
    echo "   $file: in place"
    continue
  fi
  tmp="$dest.part"
  if [[ -n "${JOYA_WHISPER_MODELS_FROM:-}" && -f "$JOYA_WHISPER_MODELS_FROM/$file" ]]; then
    say "$file: copying from $JOYA_WHISPER_MODELS_FROM"
    cp "$JOYA_WHISPER_MODELS_FROM/$file" "$tmp"
  else
    say "$file: downloading"
    curl -fL --retry 3 -o "$tmp" "$url"
  fi
  echo "$sum  $tmp" | sha256sum -c --status || { rm -f "$tmp"; die "$file: checksum mismatch -- not installed"; }
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dest"
done

if [[ "${JOYA_VOICE_WHISPER_NO_UNIT:-0}" == "1" ]]; then
  du -sh "$DIR"
  exit 0
fi
say "Unit joya-voice-whisper.service (installed, not started: the panel starts it when a local model is chosen)"
install -m 0644 "$UNIT_SRC" /etc/systemd/system/joya-voice-whisper.service
systemctl daemon-reload
# The model it runs with after a restart of the unit, if one is already selected.
if systemctl is-active --quiet joya-voice-whisper.service; then
  systemctl restart joya-voice-whisper.service
  echo "   it was running: restarted on the new files"
fi

du -sh "$DIR" | awk '{print "   " $1 " in '"$DIR"'"}'
say "Done. Choose a model under JOYA AI > Settings > Voice > Transcription."
