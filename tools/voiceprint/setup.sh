#!/usr/bin/env bash
# The voiceprint trial's local environment (Phase 1), as it was built on the
# VPS on 2026-10-07. Everything under $JOYA_VOICEPRINT_HOME (default
# /root/.local/joya-voiceprint), never in the repository. Re-runnable: each
# step skips what is already there. About 2.1 GB in all (venv 1.5 GB, models
# 250 MB, public data ~0.5 GB). Downloads only from the official sources:
# pytorch.org / PyPI, Hugging Face (speechbrain, Wespeaker, the Common Voice
# 17 parquet mirror fixie-ai/common_voice_17_0) and openslr.org.
set -euo pipefail
H="${JOYA_VOICEPRINT_HOME:-/root/.local/joya-voiceprint}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$H/models" "$H/data/cv17" "$H/cache" "$H/results"
chmod 700 "$H/cache" "$H/results"

if [ ! -x "$H/venv/bin/python" ]; then
  python3 -m venv "$H/venv"
  "$H/venv/bin/pip" install -q --upgrade pip
  "$H/venv/bin/pip" install -q --index-url https://download.pytorch.org/whl/cpu torch torchaudio
  "$H/venv/bin/pip" install -q speechbrain onnxruntime numpy scipy soundfile huggingface_hub psutil pyarrow
fi
PY="$H/venv/bin/python"

"$PY" - "$H" <<'EOF'
import sys
from huggingface_hub import hf_hub_download, snapshot_download
H = sys.argv[1]; M = H + "/models"
snapshot_download("speechbrain/spkrec-ecapa-voxceleb", local_dir=M + "/spkrec-ecapa-voxceleb", allow_patterns=["*.ckpt", "*.yaml", "*.txt", "README.md", "config.json"])
for repo, f in [("Wespeaker/wespeaker-voxceleb-resnet34-LM", "voxceleb_resnet34_LM.onnx"),
                ("Wespeaker/wespeaker-voxceleb-campplus-LM", "voxceleb_CAM++_LM.onnx"),
                ("Wespeaker/wespeaker-voxceleb-resnet293-LM", "voxceleb_resnet293_LM.onnx")]:
    for ff in (f, "config.yaml", "README.md"):
        hf_hub_download(repo, ff, local_dir=M + "/" + repo.split("/")[1])
for f in ["ar/test-00000-of-00008.parquet", "ar/test-00001-of-00008.parquet", "en/test-00000-of-00019.parquet"]:
    hf_hub_download("fixie-ai/common_voice_17_0", f, repo_type="dataset", local_dir=H + "/data/cv17")
EOF

if [ ! -d "$H/data/LibriSpeech/test-clean" ]; then
  curl -sS -o "$H/data/test-clean.tar.gz" https://www.openslr.org/resources/12/test-clean.tar.gz
  tar xzf "$H/data/test-clean.tar.gz" -C "$H/data" && rm "$H/data/test-clean.tar.gz"
fi

[ -f "$H/data/public/manifest.json" ] || "$PY" "$HERE/prep_public.py"
# JOYA AI's own voice as an impostor: ~$0.02 of gpt-4o-mini-tts, key via the helper.
[ -f "$H/data/echo/manifest.json" ] || "$PY" "$HERE/make_echo.py"
echo "ready: $PY $HERE/evaluate.py --standin   |   --user /var/lib/joya-dashboard/voiceprint-trial/<username>"
