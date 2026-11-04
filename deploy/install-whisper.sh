#!/usr/bin/env bash
#
# Install local voice transcription: ffmpeg + whisper.cpp + a model.
#
#   sudo bash /opt/joya/deploy/install-whisper.sh [model]
#
# Default model is `base` (~142MB) — good enough for voice notes and fast on
# CPU. `small` (~466MB) is noticeably better on accented speech and still runs
# comfortably; `tiny` is faster and worse.
#
# Kept out of bootstrap.sh because it compiles C++ and downloads a model, and
# not every deployment wants voice.

set -euo pipefail

MODEL="${1:-base}"
SHARED=/opt/joya-agents/shared
SRC="$SHARED/whisper.cpp"
AGENT_USER=joyaagent

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }

say "Installing build tools and ffmpeg"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg build-essential cmake git >/dev/null

if [[ -d "$SRC/.git" ]]; then
  say "Updating whisper.cpp"
  git -C "$SRC" pull --quiet --ff-only || warn "could not update; building what is there"
else
  say "Cloning whisper.cpp"
  mkdir -p "$SHARED"
  git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi

say "Building (this takes a couple of minutes)"
cd "$SRC"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF >/dev/null
cmake --build build --config Release -j"$(nproc)" >/dev/null

BIN="$SRC/build/bin/whisper-cli"
[[ -x "$BIN" ]] || { echo "build produced no whisper-cli at $BIN" >&2; exit 1; }

if [[ ! -f "$SRC/models/ggml-$MODEL.bin" ]]; then
  say "Downloading the '$MODEL' model"
  bash ./models/download-ggml-model.sh "$MODEL" >/dev/null
fi

# The agent account has to read the binary, the shared libraries and the model.
say "Setting permissions for $AGENT_USER"
chmod -R a+rX "$SRC/build" "$SRC/models"

say "Testing transcription end to end"
if [[ -f samples/jfk.wav ]]; then
  OUT=$(runuser -u "$AGENT_USER" -- "$BIN" -m "$SRC/models/ggml-$MODEL.bin" \
        -f samples/jfk.wav --no-timestamps -l auto 2>/dev/null | tr -d '\n' | xargs)
  if [[ -n "$OUT" ]]; then
    echo "  transcribed: ${OUT:0:70}..."
  else
    warn "transcription produced no output"
  fi
fi

say "Done."
echo
echo "  Binary: $BIN"
echo "  Model:  $SRC/models/ggml-$MODEL.bin"
echo
echo "  Voice notes can now be switched on per channel under Add-ons in the panel."
echo "  If a channel already has the add-on enabled, re-save it (or run"
echo "  deploy/resync-addons.js) so the new paths reach the agent."
