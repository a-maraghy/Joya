"""Auto-mapped forum topics: folders, mappings, renames, deletion via probe, trash."""

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from telegram import Chat, ForumTopicCreated, ForumTopicEdited, Message, Update, User
from telegram.error import BadRequest, NetworkError, RetryAfter

from src.bot.orchestrator import MessageOrchestrator
from src.config import create_test_config
from src.projects import ProjectThreadManager, load_project_registry
from src.projects.auto_topics import AutoTopicService, slugify, unique_slug
from src.storage.database import DatabaseManager
from src.storage.repositories import ProjectThreadRepository

CHAT = -1009999999999
ALICE = User(id=1, is_bot=False, first_name="Alice")
STRANGER = User(id=99, is_bot=False, first_name="Eve")
BOTU = User(id=4242, is_bot=True, first_name="Mavix", username="mavix_eg_bot")
FORUM = Chat(id=CHAT, type="supergroup", title="G", is_forum=True)


@pytest.fixture
async def env(tmp_path):
    db = DatabaseManager(f"sqlite:///{tmp_path / 'data' / 'bot.db'}")
    (tmp_path / "data").mkdir()
    await db.initialize()
    vault = tmp_path / "vault"
    (vault / "work").mkdir(parents=True)
    projects = tmp_path / "projects.yaml"
    projects.write_text(
        "projects:\n"
        '  - slug: "mavix-bot"\n    name: "MAVIX"\n    path: "."\n'
        '  - slug: "work"\n    name: "Work"\n    path: "work"\n',
        encoding="utf-8",
    )

    def make(**extra):
        base = dict(
            approved_directory=str(vault),
            agentic_mode=True,
            enable_project_threads=True,
            project_threads_mode="group",
            project_threads_chat_id=CHAT,
            projects_config_path=str(projects),
            database_url=f"sqlite:///{tmp_path / 'data' / 'bot.db'}",
            telegram_bot_username="mavix_eg_bot",
            allowed_users=[1],
            project_threads_auto_map=True,
            project_threads_general_project="mavix-bot",
        )
        base.update(extra)
        s = create_test_config(**base)
        reg = load_project_registry(
            Path(s.projects_config_path),
            s.approved_directory,
            s.project_threads_auto_path,
        )
        mgr = ProjectThreadManager(
            reg, ProjectThreadRepository(db), sync_action_interval_seconds=0
        )
        bot_data = {}
        return s, mgr, AutoTopicService(s, mgr, bot_data), bot_data

    yield SimpleNamespace(make=make, vault=vault, tmp=tmp_path, db=db)
    await db.close()


def bot():
    b = MagicMock()
    b.send_message = AsyncMock()
    b.edit_forum_topic = AsyncMock(side_effect=BadRequest("Topic_not_modified"))
    b.create_forum_topic = AsyncMock()
    b.reopen_forum_topic = AsyncMock()
    b.close_forum_topic = AsyncMock()
    return b


def auto_file(env):
    return json.loads((env.tmp / "projects.auto.json").read_text())


# ------------------------------------------------------------- slugs -------
def test_slugify():
    assert slugify("Client X (EU)") == "client-x-eu"
    assert slugify("مشروع البريد") == "mshrwa-albryd"
    assert slugify("Café déjà vu") == "cafe-deja-vu"
    assert slugify("🔥🔥", fallback="topic-12") == "topic-12"
    assert unique_slug("notes", {"notes", "notes-2"}) == "notes-3"


# ----------------------------------------------------------- mapping -------
async def test_new_topic_gets_folder_mapping_and_entry(env):
    s, mgr, svc, bot_data = env.make()
    b = bot()
    entry = await svc.map_topic(CHAT, 200, "Client X", 1, bot=b)
    assert entry["path"] == "topics/client-x"
    assert (env.vault / "topics" / "client-x").is_dir()
    m = await mgr.repository.get_by_chat_thread(CHAT, 200)
    assert m.project_slug == "client-x"
    data = auto_file(env)
    assert data["projects"][0]["thread_id"] == 200 and data["chat_id"] == CHAT
    proj = await mgr.resolve_project(CHAT, 200)
    assert (
        proj.absolute_path == (env.vault / "topics" / "client-x").resolve()
        and proj.auto
    )
    assert bot_data["project_registry"] is mgr.registry
    b.send_message.assert_awaited_once()
    assert "topics/client-x" in b.send_message.call_args.kwargs["text"]
    # survives a restart: a fresh registry has it, and the sync makes no topic
    s2, mgr2, _, _ = env.make()
    assert mgr2.registry.get_by_slug("client-x").thread_id == 200
    b2 = bot()
    b2.create_forum_topic = AsyncMock(
        side_effect=lambda **kw: SimpleNamespace(
            message_thread_id=900 + len(kw["name"])
        )
    )
    await mgr2.sync_topics(b2, CHAT)
    made = [c.kwargs["name"] for c in b2.create_forum_topic.call_args_list]
    assert "Client X" not in made  # only the panel's projects, which had no topic yet
    assert (await mgr2.resolve_project(CHAT, 200)).slug == "client-x"


async def test_announce_can_be_switched_off(env):
    s, mgr, svc, _ = env.make(project_threads_auto_announce=False)
    b = bot()
    await svc.map_topic(CHAT, 201, "Quiet", 1, bot=b)
    b.send_message.assert_not_awaited()


async def test_duplicates_and_arabic_names(env):
    s, mgr, svc, _ = env.make()
    a = await svc.map_topic(CHAT, 201, "Notes", 1)
    b2 = await svc.map_topic(CHAT, 202, "Notes", 1)
    c = await svc.map_topic(CHAT, 203, "Work", 1)  # name of a panel project
    ar = await svc.map_topic(CHAT, 204, "مشروع البريد", 1)
    assert (a["slug"], b2["slug"]) == ("notes", "notes-2")
    assert b2["name"] == "Notes (2)"
    assert c["slug"] == "work-2" and c["name"] == "Work (2)"
    assert ar["slug"] == "mshrwa-albryd" and ar["name"] == "مشروع البريد"
    assert (env.vault / "topics" / "mshrwa-albryd").is_dir()
    assert {p.slug for p in mgr.registry.projects} >= {
        "notes",
        "notes-2",
        "work-2",
        "mshrwa-albryd",
    }
    # mapping the same thread twice changes nothing
    assert await svc.map_topic(CHAT, 201, "Notes", 1) is None


async def test_rename_changes_name_not_folder(env):
    s, mgr, svc, _ = env.make()
    await svc.map_topic(CHAT, 210, "Draft", 1)
    assert await svc.rename_topic(CHAT, 210, "Final report")
    e = auto_file(env)["projects"][0]
    assert e["name"] == "Final report" and e["path"] == "topics/draft"
    assert (await mgr.resolve_project(CHAT, 210)).name == "Final report"
    m = await mgr.repository.get_by_chat_thread(CHAT, 210)
    assert m.topic_name == "Final report"


async def test_cap(env):
    s, mgr, svc, _ = env.make(project_threads_auto_max=2)
    b = bot()
    assert await svc.map_topic(CHAT, 221, "A", 1, bot=b)
    assert await svc.map_topic(CHAT, 222, "B", 1, bot=b)
    assert await svc.map_topic(CHAT, 223, "C", 1, bot=b) is None
    assert not (env.vault / "topics" / "c").exists()
    assert (
        "already has 2 automatic topic folders"
        in b.send_message.call_args.kwargs["text"]
    )


async def test_disabled_by_default(env):
    s, mgr, svc, _ = env.make(project_threads_auto_map=False)
    assert not svc.enabled
    assert await svc.map_topic(CHAT, 230, "X", 1) is None
    assert not (env.tmp / "projects.auto.json").exists()


# ------------------------------------------------ via the orchestrator -----
def _update(**kw):
    m = Message(
        message_id=kw.pop("mid", 300),
        date=datetime.now(UTC),
        chat=FORUM,
        from_user=kw.pop("user", ALICE),
        **kw,
    )
    return Update(update_id=1, message=m)


async def test_service_messages_and_first_contact(env):
    s, mgr, svc, bot_data = env.make()
    o = MessageOrchestrator(s, {"auto_topic_service": svc})
    c = MagicMock()
    c.bot = bot()
    # forum_topic_created service message
    await o._observe_topics(
        _update(
            mid=300,
            message_thread_id=300,
            is_topic_message=True,
            forum_topic_created=ForumTopicCreated(name="Invoices", icon_color=1),
        ),
        c,
    )
    assert (await mgr.resolve_project(CHAT, 300)).slug == "invoices"
    # renamed in Telegram
    await o._observe_topics(
        _update(
            mid=301,
            message_thread_id=300,
            is_topic_message=True,
            forum_topic_edited=ForumTopicEdited(name="Invoices 2026"),
        ),
        c,
    )
    assert (await mgr.resolve_project(CHAT, 300)).name == "Invoices 2026"
    # first message in a topic made while the bot was down: the name comes from the topic root
    root = Message(
        message_id=310,
        date=datetime.now(UTC),
        chat=FORUM,
        from_user=ALICE,
        forum_topic_created=ForumTopicCreated(name="Offline topic", icon_color=1),
    )
    await o._observe_topics(
        _update(
            mid=311,
            message_thread_id=310,
            is_topic_message=True,
            text="hello",
            reply_to_message=root,
        ),
        c,
    )
    assert (await mgr.resolve_project(CHAT, 310)).slug == "offline-topic"
    # a stranger's topic, a bot's own topic, and General are never mapped
    await o._observe_topics(
        _update(
            mid=320,
            user=STRANGER,
            message_thread_id=320,
            is_topic_message=True,
            forum_topic_created=ForumTopicCreated(name="Spam", icon_color=1),
        ),
        c,
    )
    await o._observe_topics(
        _update(
            mid=321,
            user=BOTU,
            message_thread_id=321,
            is_topic_message=True,
            forum_topic_created=ForumTopicCreated(name="Made by bot", icon_color=1),
        ),
        c,
    )
    await o._observe_topics(_update(mid=322, text="in general"), c)
    assert [p["slug"] for p in auto_file(env)["projects"]] == [
        "invoices",
        "offline-topic",
    ]


# ------------------------------------------------------------ deletion -----
async def test_deletion_needs_two_definite_not_found(env):
    s, mgr, svc, _ = env.make()
    await svc.map_topic(CHAT, 400, "Gone soon", 1)
    folder = env.vault / "topics" / "gone-soon"
    (folder / "note.md").write_text("x")
    b = bot()
    b.edit_forum_topic = AsyncMock(side_effect=BadRequest("Topic_id_invalid"))
    assert await svc.check_deleted(b) == []
    assert folder.is_dir()
    # a transient error in between resets the count
    b.edit_forum_topic = AsyncMock(side_effect=NetworkError("timed out"))
    assert await svc.check_deleted(b) == []
    b.edit_forum_topic = AsyncMock(side_effect=BadRequest("Topic_id_invalid"))
    assert await svc.check_deleted(b) == []
    assert folder.is_dir()
    assert await svc.check_deleted(b) == ["gone-soon"]
    assert not folder.exists()
    data = auto_file(env)
    assert data["projects"] == []
    t = data["trash"][0]
    assert t["trash_path"].startswith(".trash/topics/gone-soon-")
    assert (env.vault / t["trash_path"] / "note.md").read_text() == "x"
    assert await mgr.repository.get_by_chat_project(CHAT, "gone-soon") is None
    assert mgr.registry.get_by_slug("gone-soon") is None


@pytest.mark.parametrize(
    "err",
    [
        RetryAfter(30),
        NetworkError("Bad Gateway"),
        BadRequest("Not enough rights to manage topics"),
        BadRequest("Chat not found"),
    ],
)
async def test_other_errors_never_count(env, err):
    s, mgr, svc, _ = env.make()
    await svc.map_topic(CHAT, 401, "Stays", 1)
    b = bot()
    b.edit_forum_topic = AsyncMock(side_effect=err)
    for _ in range(4):
        assert await svc.check_deleted(b) == []
    assert (env.vault / "topics" / "stays").is_dir()


async def test_alive_topics_are_left_alone(env):
    s, mgr, svc, _ = env.make()
    await svc.map_topic(CHAT, 402, "Alive", 1)
    b = bot()  # Topic_not_modified
    for _ in range(3):
        assert await svc.check_deleted(b) == []
    b.edit_forum_topic.assert_awaited_with(chat_id=CHAT, message_thread_id=402)


async def test_keep_mode_and_relink(env):
    s, mgr, svc, _ = env.make(project_threads_deleted_topics="keep")
    await svc.map_topic(CHAT, 410, "Kept", 1)
    b = bot()
    b.edit_forum_topic = AsyncMock(side_effect=BadRequest("Message thread not found"))
    await svc.check_deleted(b)
    await svc.check_deleted(b)
    assert (env.vault / "topics" / "kept").is_dir()
    data = auto_file(env)
    assert data["projects"] == [] and data["unlinked"][0]["slug"] == "kept"
    # a new topic of the same name gets the old folder back
    e = await svc.map_topic(CHAT, 411, "Kept", 1)
    assert e["path"] == "topics/kept" and auto_file(env)["unlinked"] == []


async def test_zero_days_deletes_at_once_and_purge_after_retention(env):
    s, mgr, svc, _ = env.make(project_threads_trash_days=0)
    await svc.map_topic(CHAT, 420, "Now", 1)
    b = bot()
    b.edit_forum_topic = AsyncMock(side_effect=BadRequest("Topic_id_invalid"))
    await svc.check_deleted(b)
    await svc.check_deleted(b)
    assert not (env.vault / "topics" / "now").exists()
    assert not (env.vault / ".trash").exists() or not any(
        (env.vault / ".trash" / "topics").iterdir()
    )

    s, mgr, svc, _ = env.make(project_threads_trash_days=30)
    await svc.map_topic(CHAT, 421, "Later", 1)
    await svc.check_deleted(b)
    await svc.check_deleted(b)
    t = auto_file(env)["trash"][0]
    assert svc.purge_trash(now=datetime.now(UTC) + timedelta(days=29)) == 0
    assert (env.vault / t["trash_path"]).is_dir()
    assert svc.purge_trash(now=datetime.now(UTC) + timedelta(days=31)) == 1
    assert not (env.vault / t["trash_path"]).exists()
    assert auto_file(env)["trash"] == []


async def test_manual_projects_root_and_general_are_never_touched(env):
    s, mgr, svc, _ = env.make()
    b = bot()
    b.edit_forum_topic = AsyncMock(side_effect=BadRequest("Topic_id_invalid"))
    # an auto entry the panel has overridden in projects.yaml is manual now
    await svc.map_topic(CHAT, 430, "Promoted", 1)
    p = Path(s.projects_config_path)
    p.write_text(
        p.read_text()
        + '  - slug: "promoted"\n    name: "Promoted"\n    path: "topics/promoted"\n'
    )
    svc.reload_registry()
    for _ in range(3):
        await svc.check_deleted(b)
    assert (env.vault / "topics" / "promoted").is_dir()
    assert mgr.registry.get_by_slug("promoted").thread_id == 430
    # the panel's projects and the vault root were never even probed
    probed = {c.kwargs["message_thread_id"] for c in b.edit_forum_topic.call_args_list}
    assert probed == set()
    assert (env.vault / "work").is_dir()


async def test_links_are_refused(env):
    s, mgr, svc, _ = env.make()
    outside = env.tmp / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("precious")
    (env.vault / "topics").mkdir()
    os.symlink(outside, env.vault / "topics" / "evil")
    data = {
        "version": 1,
        "chat_id": CHAT,
        "projects": [
            {"slug": "evil", "name": "Evil", "path": "topics/evil", "thread_id": 500},
            {
                "slug": "escape",
                "name": "Escape",
                "path": "topics/../../outside",
                "thread_id": 501,
            },
            {"slug": "root", "name": "Root", "path": "topics/..", "thread_id": 502},
        ],
        "unlinked": [],
        "trash": [
            {
                "slug": "x",
                "trash_path": "../outside",
                "trashed_at": "2000-01-01T00:00:00Z",
            },
        ],
    }
    (env.tmp / "projects.auto.json").write_text(json.dumps(data))
    reg = svc.reload_registry()
    assert {p.slug for p in reg.projects} == {"mavix-bot", "work"}
    b = bot()
    b.edit_forum_topic = AsyncMock(side_effect=BadRequest("Topic_id_invalid"))
    await svc.check_deleted(b)
    await svc.check_deleted(b)
    assert (outside / "keep.txt").read_text() == "precious"
    assert (env.vault / "work").is_dir()
    # a topics/ folder that is itself a link is refused for new topics
    os.unlink(env.vault / "topics" / "evil")
    (env.vault / "topics").rmdir()
    os.symlink(outside, env.vault / "topics")
    with pytest.raises(RuntimeError):
        await svc.map_topic(CHAT, 510, "New", 1)
    assert not (outside / "new").exists()


async def test_malformed_auto_file_never_stops_the_bot(env):
    s, mgr, svc, _ = env.make()
    (env.tmp / "projects.auto.json").write_text("{not json")
    reg = load_project_registry(
        Path(s.projects_config_path), s.approved_directory, s.project_threads_auto_path
    )
    assert {p.slug for p in reg.projects} == {"mavix-bot", "work"}
