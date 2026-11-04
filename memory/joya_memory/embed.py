"""Local text embeddings.

Deliberately local-only: an agent's memory is the most sensitive thing it holds,
so it is never sent to a third party to be embedded. fastembed runs a small
quantised ONNX model on CPU -- roughly 40ms for a query on this box, and the
model (~130MB) is downloaded once into a cache shared by every agent.
"""

from __future__ import annotations

import os
import threading
from typing import Iterable, List

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_DIM = 384

# fastembed loads the ONNX session lazily and is not thread safe during that
# load, so the first call is serialised.
_lock = threading.Lock()
_model = None
_model_name = None


def model_name() -> str:
    return os.environ.get("JOYA_EMBED_MODEL", DEFAULT_MODEL)


def dimensions() -> int:
    return int(os.environ.get("JOYA_EMBED_DIM", DEFAULT_DIM))


def _load():
    global _model, _model_name
    with _lock:
        if _model is not None and _model_name == model_name():
            return _model
        from fastembed import TextEmbedding  # imported late: ~2s and 200MB RSS

        cache = os.environ.get("JOYA_MODEL_CACHE") or None
        _model = TextEmbedding(model_name=model_name(), cache_dir=cache)
        _model_name = model_name()
        return _model


def embed_documents(texts: Iterable[str]) -> List[List[float]]:
    """Embed passages for storage."""
    texts = list(texts)
    if not texts:
        return []
    model = _load()
    return [vec.tolist() for vec in model.embed(texts)]


def embed_query(text: str) -> List[float]:
    """Embed a search query.

    bge models want an instruction prefix on the query side only; skipping it
    on documents is intentional, not an oversight.
    """
    model = _load()
    prefixed = "Represent this sentence for searching relevant passages: " + text
    return next(iter(model.embed([prefixed]))).tolist()


def warm() -> str:
    """Force the model download/load. Called by the installer so the first real
    query does not pay a 20 second download."""
    embed_query("warmup")
    return model_name()
