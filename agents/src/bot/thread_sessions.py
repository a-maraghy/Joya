"""Per-topic Claude session ids that survive a restart (JOYA addition).

The runtime keeps each topic's session id in ``context.user_data``, which lives
in memory only. After a restart the first message in a topic auto-resumes the
most recent session *in the same folder* -- harmless while every topic has a
folder of its own, wrong once the General topic shares a folder with another
topic (General -> the agent's own folder, as is the MAVIX topic). This small
JSON file, keyed "<chat>:<thread|general>:<user>", keeps them apart.
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Dict, Optional

import structlog

logger = structlog.get_logger()

MAX_ENTRIES = 2000


class ThreadSessionStore:
    """A tiny persistent map from (topic state key, user) to Claude session id."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._data: Optional[Dict[str, str]] = None

    def _load(self) -> Dict[str, str]:
        if self._data is None:
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self._data = {
                    str(k): str(v)
                    for k, v in (raw.items() if isinstance(raw, dict) else [])
                    if isinstance(v, str)
                }
            except FileNotFoundError:
                self._data = {}
            except (OSError, ValueError) as e:
                logger.warning("Thread sessions file unreadable", error=str(e))
                self._data = {}
        return self._data

    @staticmethod
    def _key(state_key: str, user_id: Optional[int]) -> str:
        return f"{state_key}:{user_id}"

    def get(self, state_key: str, user_id: Optional[int]) -> Optional[str]:
        return self._load().get(self._key(state_key, user_id))

    def set(
        self, state_key: str, user_id: Optional[int], session_id: Optional[str]
    ) -> None:
        data = self._load()
        key = self._key(state_key, user_id)
        if session_id:
            if data.get(key) == session_id:
                return
            data.pop(key, None)
            data[key] = session_id
            while len(data) > MAX_ENTRIES:
                data.pop(next(iter(data)))
        elif key in data:
            del data[key]
        else:
            return
        self._save(data)

    def _save(self, data: Dict[str, str]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(
                dir=str(self.path.parent), prefix=".thread-sessions-"
            )
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except OSError as e:
            logger.warning("Could not save thread sessions", error=str(e))
