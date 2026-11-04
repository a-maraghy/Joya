"""
The candidate speaker-embedding models, all on CPU, all from local files under
$JOYA_VOICEPRINT_HOME/models (downloaded once by setup.sh from their official
Hugging Face repositories). Each turns 16 kHz mono float audio into one
L2-normalised embedding; the score of two embeddings is their cosine.

  ecapa      SpeechBrain ECAPA-TDNN, spkrec-ecapa-voxceleb       Apache-2.0   192-d  PyTorch
  wsp-r34    WeSpeaker ResNet34-LM (VoxCeleb2)                   CC-BY-4.0    256-d  ONNX
  wsp-campp  WeSpeaker CAM++-LM (VoxCeleb2)                      Apache-2.0   512-d  ONNX
  wsp-r293   WeSpeaker ResNet293-LM (VoxCeleb2) -- accuracy ceiling, slow   CC-BY-4.0   256-d  ONNX
"""
import os
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np

from common import MODELS_DIR

MODELS = {
    "ecapa": {"kind": "speechbrain", "dir": "spkrec-ecapa-voxceleb", "repo": "speechbrain/spkrec-ecapa-voxceleb", "licence": "Apache-2.0", "dim": 192},
    "wsp-r34": {"kind": "wespeaker", "dir": "wespeaker-voxceleb-resnet34-LM", "file": "voxceleb_resnet34_LM.onnx", "repo": "Wespeaker/wespeaker-voxceleb-resnet34-LM", "licence": "CC-BY-4.0", "dim": 256},
    "wsp-campp": {"kind": "wespeaker", "dir": "wespeaker-voxceleb-campplus-LM", "file": "voxceleb_CAM++_LM.onnx", "repo": "Wespeaker/wespeaker-voxceleb-campplus-LM", "licence": "Apache-2.0", "dim": 512},
    "wsp-r293": {"kind": "wespeaker", "dir": "wespeaker-voxceleb-resnet293-LM", "file": "voxceleb_resnet293_LM.onnx", "repo": "Wespeaker/wespeaker-voxceleb-resnet293-LM", "licence": "CC-BY-4.0", "dim": 256},
}
DEFAULT_MODELS = ["ecapa", "wsp-r34", "wsp-campp", "wsp-r293"]


def unit(v):
    v = np.asarray(v, dtype=np.float32).reshape(-1)
    return v / (np.linalg.norm(v) + 1e-9)


class Model:
    def __init__(self, name, threads=4):
        self.name = name
        self.spec = MODELS[name]
        self.threads = threads
        self.load_s = None

    def load(self):
        t = time.perf_counter()
        self._load()
        self.load_s = time.perf_counter() - t
        return self

    def size_mb(self):
        d = os.path.join(MODELS_DIR, self.spec["dir"])
        if "file" in self.spec:
            return os.path.getsize(os.path.join(d, self.spec["file"])) / 1e6
        return sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d) if f.endswith(".ckpt") and f != "classifier.ckpt") / 1e6


class SpeechBrainModel(Model):
    def _load(self):
        import torch
        from speechbrain.inference.speaker import EncoderClassifier

        torch.set_num_threads(self.threads)
        d = os.path.join(MODELS_DIR, self.spec["dir"])
        self.torch = torch
        self.m = EncoderClassifier.from_hparams(source=d, savedir=d, run_opts={"device": "cpu"}, overrides={"pretrained_path": d})
        self.m.eval()

    def embed(self, x):
        with self.torch.inference_mode():
            e = self.m.encode_batch(self.torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32)).unsqueeze(0))
        return unit(e.numpy())


class WeSpeakerModel(Model):
    def _load(self):
        import onnxruntime as ort
        import torch
        import torchaudio.compliance.kaldi as kaldi

        torch.set_num_threads(self.threads)
        so = ort.SessionOptions()
        so.intra_op_num_threads = self.threads
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.s = ort.InferenceSession(os.path.join(MODELS_DIR, self.spec["dir"], self.spec["file"]), sess_options=so, providers=["CPUExecutionProvider"])
        self.torch = torch
        self.kaldi = kaldi

    def feats(self, x):
        # As wespeaker's own inference: 80 log-mel fbank on int16-scaled audio, no dither, mean-normalised.
        w = self.torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32) * 32768.0).unsqueeze(0)
        f = self.kaldi.fbank(w, num_mel_bins=80, frame_length=25, frame_shift=10, dither=0.0, sample_frequency=16000, window_type="hamming", use_energy=False)
        f = f - f.mean(dim=0, keepdim=True)
        return f.numpy()[None, :, :].astype(np.float32)

    def embed(self, x):
        if len(x) < 16000 * 0.2:  # the fbank needs a few frames; pad very short audio
            x = np.pad(x, (0, int(16000 * 0.2) - len(x)))
        return unit(self.s.run(None, {"feats": self.feats(x)})[0])


def get(name, threads=4):
    kind = MODELS[name]["kind"]
    return (SpeechBrainModel if kind == "speechbrain" else WeSpeakerModel)(name, threads)
