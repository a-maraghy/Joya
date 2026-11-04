#!/usr/bin/env bash
#
# Copy the agent runtime from this checkout and put the new code into the venv the agents actually
# run from.
#
#   sudo bash /opt/joya/deploy/update-runtime.sh
#
# The step that is easy to miss: the runtime is pip-installed into the venv as a
# *copy*, not as an editable install, so `git pull` alone changes nothing that
# is running. The agents keep executing the old code out of site-packages, the
# unit restarts cleanly, the logs look healthy, and the change simply is not
# there. Reinstalling is what makes a pull take effect.
#
# Restarting every agent is part of this rather than left to the operator, for
# the same reason: an agent that is still up is still running the old code.
#
# Options:
#   --only <agent-slug>   restart only joya-agent@<agent-slug> (if it is running);
#                         the others keep the old code until their next restart
#   --no-restart          restart nothing; every agent picks the new code up at
#                         its next restart (e.g. a channel save in the panel)
# Without either, every running agent is restarted, as before.

set -euo pipefail

ONLY=""
RESTART=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ $# -ge 2 ]] || { echo "--only needs an agent's short name" >&2; exit 2; }
      ONLY="$2"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;/^set -euo/d'; exit 0 ;;
    *) echo "unknown option: $1 (use --only <agent-slug> or --no-restart)" >&2; exit 2 ;;
  esac
done
if [[ -n "$ONLY" && ! "$ONLY" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "not an agent's short name: $ONLY" >&2; exit 2
fi
if [[ -n "$ONLY" && $RESTART -eq 0 ]]; then
  echo "--only and --no-restart do not go together" >&2; exit 2
fi

RUNTIME=${JOYA_RUNTIME:-/opt/joya-agents/runtime}
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }
[[ -x "$RUNTIME/venv/bin/pip" ]] || { echo "no runtime venv at $RUNTIME" >&2; exit 1; }

say "Copying the runtime from this checkout"
rsync -a --delete --exclude venv --exclude data --exclude .env "$REPO_DIR/agents/" "$RUNTIME/"

say "Installing it into the venv the agents run from"
"$RUNTIME/venv/bin/pip" install --quiet --no-deps "$RUNTIME"
if [[ -d "$REPO_DIR/memory" ]]; then
  "$RUNTIME/venv/bin/pip" install --quiet --no-deps "$REPO_DIR/memory"
fi

# --no-deps above keeps a deploy from upgrading or downgrading anything that is
# already installed. The flip side is that a dependency the runtime newly
# declares (python-docx, openpyxl, reportlab ... for the files the agents send)
# would never arrive. So: install exactly the declared requirements that are
# MISSING from the venv, at the declared version range, and leave every
# installed package as it is. A missing one that will not install fails the
# deploy here, before anything restarts.
say "Adding any dependency the runtime declares and the venv lacks"
missing="$(cd /tmp && "$RUNTIME/venv/bin/python" - <<'PY'
import importlib.metadata as md
from packaging.requirements import Requirement
for raw in md.requires("joya-agents") or []:
    req = Requirement(raw)
    if req.marker is not None and not req.marker.evaluate({"extra": ""}):
        continue  # an optional extra (voice ...)
    try:
        md.version(req.name)
    except md.PackageNotFoundError:
        print(str(req))
PY
)"
if [[ -n "$missing" ]]; then
  echo "$missing" | sed 's/^/  + /'
  mapfile -t reqs <<<"$missing"
  "$RUNTIME/venv/bin/pip" install --quiet "${reqs[@]}"
else
  echo "  none missing"
fi

say "Checking it imports"
(cd /tmp && "$RUNTIME/venv/bin/python" -c "import src.main")
(cd /tmp && "$RUNTIME/venv/bin/python" -c "import docx, openpyxl, reportlab, arabic_reshaper, bidi, pypdf" 2>/dev/null) \
  && echo "  document libraries: ok" \
  || echo "  document libraries: not all importable (agents can still send files, but cannot make Word/Excel/PDF)"
(cd /tmp && "$RUNTIME/venv/bin/python" -c "import resvg_py; resvg_py.svg_to_bytes(svg_string='<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 8 8\"/>', width=8)" >/dev/null 2>&1) \
  && echo "  SVG renderer (resvg-py): ok" \
  || echo "  SVG renderer (resvg-py): missing (agents still send SVG files, but cannot render, preview or look at their drawings)"

if [[ $RESTART -eq 0 ]]; then
  say "Not restarting any agent (--no-restart): each runs the new code from its next restart."
  say "Done."
  exit 0
fi

if [[ -n "$ONLY" ]]; then
  unit="joya-agent@$ONLY.service"
  say "Restarting $unit only"
  if [[ "$(systemctl is-active "$unit" || true)" == "active" ]]; then
    systemctl restart "$unit"
    printf '  %-32s %s\n' "$unit" "$(systemctl is-active "$unit" || true)"
  else
    echo "  $unit is not running; nothing restarted"
  fi
  say "Done."
  exit 0
fi

say "Restarting agents"
# Only the ones that were running. list-units also reports units that are
# loaded but deliberately stopped -- a WhatsApp agent has no Telegram token, so
# its joya-agent@ unit is disabled on purpose, and restarting it every deploy
# started something that could only fail and then left it in a failed state.
mapfile -t units < <(
  systemctl list-units --plain --no-legend --state=active 'joya-agent@*' | awk '{print $1}'
)
if [[ ${#units[@]} -eq 0 ]]; then
  echo "  none running"
else
  for unit in "${units[@]}"; do
    systemctl restart "$unit"
    printf '  %-32s %s\n' "$unit" "$(systemctl is-active "$unit")"
  done
fi

say "Done."
