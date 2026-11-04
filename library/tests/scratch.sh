#!/bin/bash
# A throwaway JOYA Library for tests: its own site folder, manifest, store, database, service and
# nginx, on http://localhost:18790 (web) and 127.0.0.1:18795 (service). Never touches production.
#
#   bash library/tests/scratch.sh up   <dir>    build test videos, start the service and nginx
#   bash library/tests/scratch.sh down <dir>    stop them
#   bash library/tests/scratch.sh seed <dir>    wipe the scratch data and add the 4 test videos + user "tester"
#   bash library/tests/scratch.sh env  <dir>    print the environment for running the tools against it
set -euo pipefail
cmd=${1:?up|down|env}
SCR=$(realpath -m "${2:?scratch dir}")
REPO=$(cd "$(dirname "$0")/../.." && pwd)
WEB=${JOYA_SCRATCH_WEB:-18790}
API=${JOYA_SCRATCH_API:-18795}

envs() {
  cat <<EOF
export JOYA_LIBRARY_ROOT=$SCR/site
export JOYA_LIBRARY_MANIFEST=$SCR/state/library.json
export JOYA_LIBRARY_URL=http://localhost:$WEB
export JOYA_LIBRARY_PORT=$API
export JOYA_LIBRARY_COOKIE_SECURE=1
export JOYA_LIBRARY_OWNER=nobody-scratch
EOF
}

case $cmd in
  env) envs ;;
  seed)
    eval "$(envs)"
    [ -f "$SCR/api.pid" ] && kill "$(cat "$SCR/api.pid")" 2>/dev/null || true
    rm -rf "$SCR/site" "$SCR/state"
    mkdir -p "$SCR/site" "$SCR/state" "$SCR/tmp"
    A="$REPO/library/add.py"
    python3 "$A" --folder pre-read --title "Allocation walkthrough" --date 2026-10-20 --desc "A first look at the allocation screen: what each column means, how a lot is reserved, and where the purchase plan comes from.

A second paragraph with more detail, so the description needs Show more on the watch page. It goes on for a while to make sure the clamp to three lines is needed on a wide screen and on a phone." "$SCR/media/a.mp4" >/dev/null
    python3 "$A" --folder demos --folder-title Demos --title "Board demo" --desc "Short demo." --date 2026-10-25 "$SCR/media/b.mp4" >/dev/null
    python3 "$A" --folder pre-read --title "Draft pre-read" --visibility unlisted --desc "Draft for review." "$SCR/media/c.mp4" >/dev/null
    python3 "$A" --folder pre-read --title "Secret cut" --visibility private "$SCR/media/d.mp4" >/dev/null
    python3 - "$REPO" "$SCR" <<'PY'
import os, secrets, sys, time
sys.path.insert(0, os.path.join(sys.argv[1], 'library'))
import joyalib as L
assert L.DB_PATH.startswith(sys.argv[2]), 'not a scratch database: ' + L.DB_PATH
import server as S
S.init_db()
pw = secrets.token_urlsafe(18)
S.db().execute('INSERT INTO users (name, pw, created) VALUES (?,?,?)', ('tester', S.hash_password(pw), int(time.time())))
p = os.path.join(sys.argv[2], 'test-pass.txt')
open(p, 'w').write(pw)
os.chmod(p, 0o600)
PY
    python3 "$A" --list
    ;;
  down)
    [ -f "$SCR/api.pid" ] && kill "$(cat "$SCR/api.pid")" 2>/dev/null || true
    [ -f "$SCR/nginx.pid" ] && nginx -c "$SCR/nginx.conf" -p "$SCR" -s stop 2>/dev/null || true
    rm -f "$SCR/api.pid"
    ;;
  up)
    mkdir -p "$SCR"/{site,state,logs,media,tmp}
    eval "$(envs)"
    # Test videos: colour bars with a tone and a burned-in clock, so frames differ.
    mk() { [ -f "$SCR/media/$1" ] || ffmpeg -v error -y -f lavfi -i "testsrc2=size=$2:rate=25:duration=$3" \
        -f lavfi -i "sine=frequency=$4:duration=$3" -c:v libx264 -preset ultrafast -c:a aac -shortest "$SCR/media/$1"; }
    mk a.mp4 1280x720 70 440
    mk b.mp4 960x540 40 550
    mk c.mp4 854x480 20 660
    mk d.mp4 640x360 12 770
    sed -e "s#@SCR@#$SCR#g" -e "s#@REPO@#$REPO#g" -e "s#@WEB@#$WEB#g" -e "s#@API@#$API#g" \
      "$REPO/library/tests/nginx-scratch.conf.in" > "$SCR/nginx.conf"
    nginx -t -c "$SCR/nginx.conf" -p "$SCR" -q
    [ -f "$SCR/api.pid" ] && kill "$(cat "$SCR/api.pid")" 2>/dev/null || true
    nohup python3 "$REPO/library/server.py" > "$SCR/logs/api.log" 2>&1 &
    echo $! > "$SCR/api.pid"
    if [ -f "$SCR/nginx.pid" ] && kill -0 "$(cat "$SCR/nginx.pid")" 2>/dev/null; then
      nginx -c "$SCR/nginx.conf" -p "$SCR" -s reload
    else
      nginx -c "$SCR/nginx.conf" -p "$SCR"
    fi
    for i in $(seq 1 40); do curl -sf "http://localhost:$WEB/api/health" >/dev/null && break; sleep 0.25; done
    curl -sf "http://localhost:$WEB/api/health" && echo " scratch up at http://localhost:$WEB"
    ;;
esac
