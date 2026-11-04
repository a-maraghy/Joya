"""Automatically mapped forum topics (JOYA addition).

With ``PROJECT_THREADS_AUTO_MAP=true`` (group thread mode), every new forum
topic in the agent's group gets a project of its own: a folder
``<vault>/topics/<slug>``, a row in the ``project_threads`` table and an entry
in ``projects.auto.json`` next to the panel's ``projects.yaml``.

One owner per file
------------------
``projects.yaml`` belongs to the panel (root-owned, read-only to the agent);
``projects.auto.json`` belongs to this process. The panel only reads the auto
file, except for two actions on the trash (restore, delete now), and every
read-modify-write on either side holds an exclusive ``flock`` on
``projects.auto.json.lock`` and re-reads the file under it. Neither can
clobber the other.

Deleted topics
--------------
The Bot API sends no update when a forum topic is deleted (there are only
created / edited / closed / reopened / hidden / unhidden service messages).
So deletion is detected by probing: ``editForumTopic`` with nothing to change
is a no-op on a topic that exists (Telegram answers TOPIC_NOT_MODIFIED) and
fails with TOPIC_ID_INVALID / "message thread not found" on one that does not.
Only such a definite answer counts, and only twice in a row; network errors,
flood waits and missing rights never do. Then the folder moves to
``<vault>/.trash/topics/<slug>-<UTC>`` (or is kept, by setting), the mapping
and the entry are dropped, and trash older than the retention is purged.

Never touched: projects from projects.yaml (including an auto entry the panel
has overridden), the General target, the agent's own folder, and anything that
does not resolve, without links, inside ``<vault>/topics``.
"""

import fcntl
import json
import os
import re
import shutil
import tempfile
import unicodedata
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Set, Tuple

import structlog

from .registry import ProjectDefinition

logger = structlog.get_logger()

AUTO_DIR = "topics"
TRASH_DIR = ".trash/topics"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
MAX_NAME = 128
FILE_VERSION = 1

# Errors that can only mean "this topic does not exist (any more)".
DELETED_MARKERS = (
    "topic_id_invalid",
    "message thread not found",
    "thread not found",
    "topic_deleted",
    "topic deleted",
    "topic was deleted",
    "forum topic not found",
)
ALIVE_MARKERS = ("topic_not_modified", "not modified")

_AR = {
    "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ٱ": "a", "ء": "", "ؤ": "w", "ئ": "y",
    "ب": "b", "ت": "t", "ث": "th", "ج": "g", "ح": "h", "خ": "kh", "د": "d",
    "ذ": "z", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s", "ض": "d",
    "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "q", "ك": "k",
    "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w", "ي": "y", "ى": "a",
    "ة": "a", "پ": "p", "چ": "ch", "ڤ": "v", "گ": "g",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
}  # fmt: skip


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def slugify(name: str, fallback: str = "topic") -> str:
    """A folder-safe ASCII slug: Arabic transliterated, accents dropped."""
    out = []
    for ch in name or "":
        if ch in _AR:
            out.append(_AR[ch])
            continue
        decomposed = unicodedata.normalize("NFKD", ch)
        out.append("".join(c for c in decomposed if ord(c) < 128))
    text = "".join(out).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    text = re.sub(r"-{2,}", "-", text)[:40].strip("-")
    if not text or not SLUG_RE.match(text):
        text = fallback
    return text


def unique_slug(base: str, taken: Set[str]) -> str:
    if base not in taken:
        return base
    n = 2
    while True:
        suffix = "-" + str(n)
        cand = base[: 40 - len(suffix)].rstrip("-") + suffix
        if cand not in taken:
            return cand
        n += 1


def unique_name(base: str, taken: Set[str]) -> str:
    base = " ".join((base or "").split())[:MAX_NAME] or "Topic"
    if base not in taken:
        return base
    n = 2
    while (base + " (" + str(n) + ")") in taken:
        n += 1
    return base + " (" + str(n) + ")"


def _empty() -> Dict[str, Any]:
    return {
        "version": FILE_VERSION,
        "chat_id": None,
        "projects": [],
        "unlinked": [],
        "trash": [],
    }


def read_auto_file(path: Path) -> Dict[str, Any]:
    """The auto file, shape-checked. A missing or unreadable file reads as empty."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _empty()
    except (OSError, ValueError) as e:
        logger.warning(
            "Auto topics file unreadable; treated as empty",
            path=str(path),
            error=str(e),
        )
        return _empty()
    data = _empty()
    if not isinstance(raw, dict):
        return data
    data["chat_id"] = (
        raw.get("chat_id") if isinstance(raw.get("chat_id"), int) else None
    )
    for key in ("projects", "unlinked", "trash"):
        items = raw.get(key)
        if isinstance(items, list):
            data[key] = [i for i in items if isinstance(i, dict)]
    return data


def inside(path: Path, root: Path) -> bool:
    """True when ``path`` resolves inside ``root`` and no part of it below root is a link."""
    try:
        rel = path.relative_to(root)
    except ValueError:
        return False
    cur = root
    for part in rel.parts:
        if part in ("", ".", ".."):
            return False
        cur = cur / part
        if cur.is_symlink():
            return False
    try:
        cur.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def auto_project_definitions(
    auto_path: Path, approved_root: Path, manual: List[ProjectDefinition]
) -> List[ProjectDefinition]:
    """Manual projects plus the valid auto ones (see registry.load_project_registry)."""
    data = read_auto_file(auto_path)
    by_slug = {p.slug: i for i, p in enumerate(manual)}
    out = list(manual)
    names = {p.name for p in manual}
    paths = {str(p.relative_path) for p in manual}
    threads: Set[int] = set()
    topics_root = approved_root / AUTO_DIR
    for entry in data["projects"]:
        slug = str(entry.get("slug") or "")
        name = str(entry.get("name") or "").strip()
        rel = str(entry.get("path") or "")
        thread_id = entry.get("thread_id")
        if (
            not SLUG_RE.match(slug)
            or not name
            or not isinstance(thread_id, int)
            or thread_id <= 1
        ):
            logger.warning("Auto topic entry skipped: malformed", slug=slug[:40])
            continue
        if slug in by_slug:
            # The panel has overridden it: projects.yaml wins, but keep the
            # topic it belongs to so a sync never makes a second one.
            i = by_slug[slug]
            out[i] = replace(out[i], thread_id=thread_id)
            continue
        if thread_id in threads:
            continue
        absolute = approved_root / rel
        if (
            not rel.startswith(AUTO_DIR + "/")
            or not inside(absolute, topics_root)
            or not absolute.is_dir()
        ):
            logger.warning(
                "Auto topic entry skipped: folder missing or outside topics/", slug=slug
            )
            continue
        if name in names or rel in paths:
            logger.warning(
                "Auto topic entry skipped: name or folder already used", slug=slug
            )
            continue
        names.add(name)
        paths.add(rel)
        threads.add(thread_id)
        out.append(
            ProjectDefinition(
                slug=slug,
                name=name,
                relative_path=Path(rel),
                absolute_path=absolute.resolve(),
                enabled=True,
                auto=True,
                thread_id=thread_id,
            )
        )
    return out


class AutoTopicFile:
    """projects.auto.json with its lock. Every change goes through ``edit()``."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.lock_path = self.path.with_name(self.path.name + ".lock")

    def read(self) -> Dict[str, Any]:
        return read_auto_file(self.path)

    def mtime(self) -> float:
        try:
            return self.path.stat().st_mtime
        except OSError:
            return 0.0

    @contextmanager
    def edit(self) -> Iterator[Dict[str, Any]]:
        """Lock, re-read, let the caller change the dict, write it back atomically."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o660)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            data = self.read()
            before = json.dumps(data, sort_keys=True)
            yield data
            if json.dumps(data, sort_keys=True) != before:
                self._write(data)
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    def _write(self, data: Dict[str, Any]) -> None:
        data["version"] = FILE_VERSION
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".projects-auto-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
            os.chmod(tmp, 0o660)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


class AutoTopicService:
    """Creates, renames and retires automatically mapped topic projects."""

    def __init__(
        self, settings: Any, manager: Any, bot_data: Optional[Dict[str, Any]] = None
    ) -> None:
        self.settings = settings
        self.manager = manager
        self.bot_data = bot_data if bot_data is not None else {}
        self.file = AutoTopicFile(settings.project_threads_auto_path)
        self.vault = Path(settings.approved_directory).resolve()
        self.strikes: Dict[int, int] = {}
        self._seen_mtime = self.file.mtime()

    # ------------------------------------------------------------ helpers --
    @property
    def chat_id(self) -> Optional[int]:
        return self.settings.project_threads_chat_id

    @property
    def enabled(self) -> bool:
        return bool(
            self.settings.enable_project_threads
            and self.settings.project_threads_mode == "group"
            and self.settings.project_threads_auto_map
            and self.chat_id is not None
        )

    def manual_registry(self) -> Any:
        from .registry import load_project_registry

        return load_project_registry(
            config_path=self.settings.projects_config_path,
            approved_directory=self.settings.approved_directory,
        )

    def reload_registry(self) -> Any:
        """Rebuild the registry from both files and hand it to the router."""
        from .registry import load_project_registry

        registry = load_project_registry(
            config_path=self.settings.projects_config_path,
            approved_directory=self.settings.approved_directory,
            auto_path=self.settings.project_threads_auto_path,
        )
        self.manager.registry = registry
        self.bot_data["project_registry"] = registry
        self._seen_mtime = self.file.mtime()
        return registry

    def reload_if_changed(self) -> None:
        if self.file.mtime() != self._seen_mtime:
            try:
                self.reload_registry()
            except Exception as e:  # projects.yaml broken: keep what we have
                logger.warning("Could not reload projects after a change", error=str(e))

    def _protected_slugs(self, manual: Any) -> Set[str]:
        slugs = {p.slug for p in manual.projects}
        if self.settings.project_threads_general_project:
            slugs.add(self.settings.project_threads_general_project)
        return slugs

    def _topics_root(self) -> Path:
        return self.vault / AUTO_DIR

    def _safe_auto_folder(self, rel: str) -> Optional[Path]:
        if not isinstance(rel, str) or not rel.startswith(AUTO_DIR + "/"):
            return None
        path = self.vault / rel
        if path.resolve() == self.vault or not inside(path, self._topics_root()):
            return None
        return path

    def _ensure_dir(self, rel_root: str) -> Path:
        root = self.vault
        for part in Path(rel_root).parts:
            root = root / part
            if root.is_symlink():
                raise RuntimeError(rel_root + " is a link; refusing to use it")
            root.mkdir(exist_ok=True)
        return root

    # ---------------------------------------------------------- mapping ---
    async def map_topic(
        self,
        chat_id: int,
        thread_id: int,
        name: Optional[str],
        created_by: Optional[int],
        bot: Any = None,
    ) -> Optional[Dict[str, Any]]:
        """Give a topic its own project. Returns the entry, or None if not mapped."""
        if (
            not self.enabled
            or chat_id != self.chat_id
            or not thread_id
            or thread_id <= 1
        ):
            return None
        existing = await self.manager.repository.get_any_by_chat_thread(
            chat_id, thread_id
        )
        manual = self.manual_registry()
        if existing and (
            existing.is_active
            or existing.project_slug in {p.slug for p in manual.projects}
        ):
            # Mapped already, or the (switched-off) topic of a panel project.
            return None
        cap = self.settings.project_threads_auto_max
        entry: Optional[Dict[str, Any]] = None
        capped = False
        with self.file.edit() as data:
            data["chat_id"] = chat_id
            for e in data["projects"]:
                if e.get("thread_id") == thread_id:
                    entry = e
            if entry is None:
                if len(data["projects"]) >= cap:
                    capped = True
                else:
                    entry = self._new_entry(data, manual, thread_id, name, created_by)
        if capped:
            logger.warning(
                "Auto topic not mapped: cap reached", thread_id=thread_id, cap=cap
            )
            if bot is not None and self.settings.project_threads_auto_announce:
                await self._post(
                    bot,
                    chat_id,
                    thread_id,
                    "Not linked to a folder: this agent already has "
                    + str(cap)
                    + " automatic topic folders. Remove some in Joya.",
                )
            return None
        if entry is None:
            return None
        await self.manager.repository.delete_thread(chat_id, thread_id)
        await self.manager.repository.upsert_mapping(
            project_slug=entry["slug"],
            chat_id=chat_id,
            message_thread_id=thread_id,
            topic_name=entry["name"],
            is_active=True,
        )
        self.reload_registry()
        self.strikes.pop(thread_id, None)
        logger.info(
            "Auto topic mapped",
            thread_id=thread_id,
            slug=entry["slug"],
            path=entry["path"],
        )
        if bot is not None and self.settings.project_threads_auto_announce:
            await self._post(
                bot, chat_id, thread_id, "Linked to folder " + entry["path"]
            )
        return entry

    def _new_entry(
        self,
        data: Dict[str, Any],
        manual: Any,
        thread_id: int,
        name: Optional[str],
        created_by: Optional[int],
    ) -> Dict[str, Any]:
        topic_name = " ".join((name or "").split())[:MAX_NAME] or (
            "Topic " + str(thread_id)
        )
        base = slugify(topic_name, fallback="topic-" + str(thread_id))
        # A folder restored from the trash (or kept when its topic went) is
        # linked again to a new topic of the same name.
        relink = None
        for u in data["unlinked"]:
            if u.get("slug") == base and self._safe_auto_folder(
                str(u.get("path") or "")
            ):
                relink = u
                break
        names = {p.name for p in manual.projects} | {
            str(e.get("name")) for e in data["projects"]
        }
        final_name = unique_name(topic_name, names)
        root = self._ensure_dir(AUTO_DIR)
        if relink is not None:
            data["unlinked"].remove(relink)
            slug = base
            rel = str(relink["path"])
            if slug in {p.slug for p in manual.projects} or slug in {
                e.get("slug") for e in data["projects"]
            }:
                slug = unique_slug(base, self._taken_slugs(data, manual, root))
        else:
            slug = unique_slug(base, self._taken_slugs(data, manual, root))
            rel = AUTO_DIR + "/" + slug
            folder = root / slug
            folder.mkdir(exist_ok=True)
            if not inside(folder, root):
                raise RuntimeError("topic folder escaped " + AUTO_DIR)
        entry = {
            "slug": slug,
            "name": final_name,
            "path": rel,
            "thread_id": thread_id,
            "created_at": now_iso(),
            "created_by": created_by,
            "closed": False,
        }
        data["projects"].append(entry)
        return entry

    def _taken_slugs(self, data: Dict[str, Any], manual: Any, root: Path) -> Set[str]:
        taken = {p.slug for p in manual.projects}
        for key in ("projects", "unlinked"):
            taken |= {str(e.get("slug")) for e in data[key]}
        try:
            taken |= {p.name for p in root.iterdir()}
        except OSError:
            pass
        return taken

    async def rename_topic(self, chat_id: int, thread_id: int, name: str) -> bool:
        """A topic renamed in Telegram: the project's name follows, its folder stays."""
        if chat_id != self.chat_id or not name:
            return False
        manual = self.manual_registry()
        changed = None
        with self.file.edit() as data:
            for e in data["projects"]:
                if e.get("thread_id") == thread_id:
                    others = {p.name for p in manual.projects} | {
                        str(o.get("name")) for o in data["projects"] if o is not e
                    }
                    e["name"] = unique_name(name, others)
                    changed = e
        if not changed:
            return False
        mapping = await self.manager.repository.get_by_chat_thread(chat_id, thread_id)
        if mapping and mapping.project_slug == changed["slug"]:
            await self.manager.repository.upsert_mapping(
                project_slug=changed["slug"],
                chat_id=chat_id,
                message_thread_id=thread_id,
                topic_name=changed["name"],
                is_active=True,
            )
        self.reload_registry()
        logger.info("Auto topic renamed", thread_id=thread_id, slug=changed["slug"])
        return True

    def set_closed(self, chat_id: int, thread_id: int, closed: bool) -> bool:
        """Closed or reopened: remembered, nothing else (the folder stays)."""
        if chat_id != self.chat_id:
            return False
        hit = False
        with self.file.edit() as data:
            for e in data["projects"]:
                if e.get("thread_id") == thread_id:
                    e["closed"] = bool(closed)
                    hit = True
        return hit

    # --------------------------------------------------------- deletion ---
    @staticmethod
    def classify_probe_error(error: Exception) -> str:
        """'deleted' only for a definite not-found; 'alive' for not-modified; else 'unknown'."""
        text = str(error).lower()
        if any(m in text for m in ALIVE_MARKERS):
            return "alive"
        if any(m in text for m in DELETED_MARKERS):
            return "deleted"
        return "unknown"

    async def probe_topic(self, bot: Any, chat_id: int, thread_id: int) -> str:
        """editForumTopic with nothing to change: a no-op on a topic that exists."""
        from telegram.error import TelegramError

        try:
            await bot.edit_forum_topic(chat_id=chat_id, message_thread_id=thread_id)
            return "alive"
        except TelegramError as e:
            return self.classify_probe_error(e)
        except Exception as e:  # network, timeouts: never a deletion
            logger.debug("Topic probe inconclusive", thread_id=thread_id, error=str(e))
            return "unknown"

    async def check_deleted(self, bot: Any) -> List[str]:
        """One probe round over the auto topics. Returns the slugs retired now."""
        if not self.enabled:
            return []
        self.reload_if_changed()
        data = self.file.read()
        manual = self.manual_registry()
        protected = self._protected_slugs(manual)
        retired = []
        live_threads = set()
        for e in list(data["projects"]):
            thread_id = e.get("thread_id")
            slug = str(e.get("slug") or "")
            if not isinstance(thread_id, int) or thread_id <= 1 or slug in protected:
                continue
            live_threads.add(thread_id)
            result = await self.probe_topic(bot, self.chat_id, thread_id)
            if result == "deleted":
                self.strikes[thread_id] = self.strikes.get(thread_id, 0) + 1
                logger.info(
                    "Auto topic not found",
                    thread_id=thread_id,
                    slug=slug,
                    strikes=self.strikes[thread_id],
                )
                if self.strikes[thread_id] >= 2:
                    if await self.retire(thread_id, reason="topic deleted"):
                        retired.append(slug)
                    self.strikes.pop(thread_id, None)
            else:
                self.strikes.pop(thread_id, None)
        for t in list(self.strikes):
            if t not in live_threads:
                self.strikes.pop(t, None)
        self.purge_trash()
        return retired

    async def retire(self, thread_id: int, reason: str) -> bool:
        """The topic is gone: drop entry and mapping; trash or keep the folder."""
        manual = self.manual_registry()
        protected = self._protected_slugs(manual)
        mode = self.settings.project_threads_deleted_topics
        days = self.settings.project_threads_trash_days
        done = None
        with self.file.edit() as data:
            for e in list(data["projects"]):
                if e.get("thread_id") != thread_id:
                    continue
                slug = str(e.get("slug") or "")
                if slug in protected:
                    return False
                folder = self._safe_auto_folder(str(e.get("path") or ""))
                data["projects"].remove(e)
                done = e
                if folder is None or not folder.is_dir():
                    logger.warning(
                        "Deleted topic's folder missing or not ours; left alone",
                        slug=slug,
                    )
                    break
                if mode == "keep":
                    data["unlinked"].append(
                        {
                            "slug": slug,
                            "name": e.get("name"),
                            "path": e.get("path"),
                            "since": now_iso(),
                            "reason": reason,
                        }
                    )
                elif days == 0:
                    shutil.rmtree(folder)
                else:
                    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                    trash_root = self._ensure_dir(TRASH_DIR)
                    dest = trash_root / (slug + "-" + stamp)
                    n = 2
                    while dest.exists():
                        dest = trash_root / (slug + "-" + stamp + "-" + str(n))
                        n += 1
                    os.rename(folder, dest)
                    data["trash"].append(
                        {
                            "slug": slug,
                            "name": e.get("name"),
                            "original_path": e.get("path"),
                            "trash_path": str(dest.relative_to(self.vault)),
                            "thread_id": thread_id,
                            "trashed_at": now_iso(),
                        }
                    )
                break
        if done is None:
            return False
        if self.chat_id is not None:
            await self.manager.repository.delete_mapping(
                self.chat_id, str(done["slug"])
            )
        self.reload_registry()
        logger.info(
            "Auto topic retired",
            thread_id=thread_id,
            slug=done["slug"],
            reason=reason,
            folder=("kept" if mode == "keep" else "deleted" if days == 0 else "trash"),
        )
        return True

    def purge_trash(self, now: Optional[datetime] = None) -> int:
        """Delete trashed folders older than the retention."""
        days = self.settings.project_threads_trash_days
        now = now or datetime.now(UTC)
        trash_root = self.vault / TRASH_DIR
        purged = 0
        with self.file.edit() as data:
            keep = []
            for t in data["trash"]:
                when = _parse_iso(t.get("trashed_at"))
                if when is not None and now - when < timedelta(days=days):
                    keep.append(t)
                    continue
                rel = str(t.get("trash_path") or "")
                path = self.vault / rel
                if (
                    rel.startswith(TRASH_DIR + "/")
                    and inside(path, trash_root)
                    and path.is_dir()
                ):
                    shutil.rmtree(path)
                purged += 1
            data["trash"] = keep
        if purged:
            logger.info("Purged trashed topic folders", count=purged, days=days)
        return purged

    async def _post(self, bot: Any, chat_id: int, thread_id: int, text: str) -> None:
        try:
            await bot.send_message(
                chat_id=chat_id, message_thread_id=thread_id, text=text
            )
        except Exception as e:
            logger.warning("Could not post in topic", thread_id=thread_id, error=str(e))


def topic_name_from_message(message: Any) -> Optional[str]:
    """The topic's name, from the message's own service part or the topic root it hangs off."""
    created = getattr(message, "forum_topic_created", None)
    if created is not None and getattr(created, "name", None):
        return str(created.name)
    reply = getattr(message, "reply_to_message", None)
    created = getattr(reply, "forum_topic_created", None) if reply is not None else None
    if created is not None and getattr(created, "name", None):
        return str(created.name)
    return None


def is_forum_topic_message(message: Any, chat: Any) -> Tuple[bool, Optional[int]]:
    """(True, thread id) for a message inside a real forum topic, not General."""
    if getattr(chat, "is_forum", None) is not True:
        return False, None
    if getattr(message, "is_topic_message", None) is not True:
        return False, None
    thread_id = getattr(message, "message_thread_id", None)
    if not isinstance(thread_id, int) or thread_id <= 1:
        return False, None
    return True, thread_id
