#!/bin/bash
# Authenticode-sign one Windows file in place (Tauri's bundle.windows.signCommand calls this
# for the app, the installer and the uninstaller). Linux: osslsigncode. The key and its
# password live outside the repo (JOYA_SIGN_PFX / JOYA_SIGN_PASS_FILE; tools/build-windows.sh
# sets them). A timestamp keeps the signature valid after the certificate expires; if the
# timestamp server cannot be reached the file is signed without one, and says so.
set -euo pipefail
f="$1"
: "${JOYA_SIGN_PFX:?JOYA_SIGN_PFX is not set}"
: "${JOYA_SIGN_PASS_FILE:?JOYA_SIGN_PASS_FILE is not set}"
tmp="$f.signing"
args=(sign -pkcs12 "$JOYA_SIGN_PFX" -readpass "$JOYA_SIGN_PASS_FILE" -n "JOYA AI" -i "https://joya.example.com/desktop/" -h sha256)
if osslsigncode "${args[@]}" -ts http://timestamp.digicert.com -in "$f" -out "$tmp" >/dev/null 2>&1; then
  :
else
  echo "sign.sh: no timestamp server reachable; signing $(basename "$f") without a timestamp" >&2
  rm -f "$tmp"
  osslsigncode "${args[@]}" -in "$f" -out "$tmp" >/dev/null
fi
mv -f "$tmp" "$f"
echo "signed $(basename "$f")" >&2
