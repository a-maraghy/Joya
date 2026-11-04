#!/bin/bash
# Build the signed Windows installer from Linux (Tauri's documented path: cargo-xwin + NSIS).
#
#   desktop/tools/build-windows.sh            -> src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
#   desktop/tools/build-windows.sh --feed DIR -> also the update feed in DIR (latest.json + files/), for /desktop/
#
# Needs, all in user space (no system packages): rustup with the x86_64-pc-windows-msvc target,
# cargo-xwin and tauri-cli (cargo install), clang/lld/llvm-rc and NSIS (makensis) and osslsigncode
# (extracted from Ubuntu packages into ~/.local/wintools; see desktop/README.md), and the keys in
# JOYA_DESKTOP_KEYS (default ~/.local/joya-desktop-keys): updater.key + updater.password (the
# updater's minisign key), codesign.pfx + codesign.password (the code-signing certificate).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# --feed DIR is taken relative to where the script was started (it cds into src-tauri below).
FEED=""
if [ "${1:-}" = "--feed" ]; then FEED="$(mkdir -p "$2" && cd "$2" && pwd)"; fi
KEYS="${JOYA_DESKTOP_KEYS:-$HOME/.local/joya-desktop-keys}"
TOOLS="${JOYA_WINTOOLS:-$HOME/.local/wintools}"
export PATH="$TOOLS/bin:$HOME/.cargo/bin:$PATH"
export XWIN_ACCEPT_LICENSE=1 XWIN_CACHE_DIR="$TOOLS/xwin-cache"
for f in updater.key updater.password codesign.pfx codesign.password; do
  [ -r "$KEYS/$f" ] || { echo "missing $KEYS/$f" >&2; exit 1; }
done
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYS/updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$KEYS/updater.password")"
export JOYA_SIGN_PFX="$KEYS/codesign.pfx" JOYA_SIGN_PASS_FILE="$KEYS/codesign.password"
# tauri-cli on a Linux host looks up the Linux tray library (appindicator) even for a Windows target,
# to list Linux package dependencies it then does not use. A stand-in .pc answers that lookup.
mkdir -p "$TOOLS/pkgconfig"
printf 'libdir=/nonexistent\nName: ayatana-appindicator3-0.1\nDescription: stand-in for a Windows cross build\nVersion: 0.5\nLibs: -L/nonexistent\n' > "$TOOLS/pkgconfig/ayatana-appindicator3-0.1.pc"
export NSIS_PATH="$TOOLS/root/usr/share/nsis"
export PKG_CONFIG_PATH="$TOOLS/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" TAURI_LINUX_AYATANA_APPINDICATOR=1
cd "$HERE/src-tauri"
cfg=$(printf '{"bundle":{"windows":{"signCommand":{"cmd":"%s","args":["%%1"]}}}}' "$HERE/tools/sign.sh")
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis --config "$cfg"
out="$HERE/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
ls -la "$out"
if [ -n "$FEED" ]; then
  node "$HERE/tools/make-feed.cjs" --bundle "$out" --cert "$KEYS/joya-desktop-codesign.cer" --out "$FEED"
fi
