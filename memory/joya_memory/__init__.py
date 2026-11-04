"""Local vector memory for JOYA agents.

An agent's memory is a folder of Markdown (an Obsidian vault); this package adds
retrieval on top of it without taking ownership of it. Files are the source of
truth, the index is a cache, and nothing leaves the machine.
"""

__version__ = "0.1.0"

__all__ = ["embed", "indexer", "store", "vault"]
