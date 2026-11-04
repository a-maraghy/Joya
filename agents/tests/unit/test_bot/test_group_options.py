"""JOYA options: General topic routing, respond-when-asked, defaults unchanged."""

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from telegram import Chat, Message, Update, User
from telegram.ext import ApplicationHandlerStop

from src.bot.orchestrator import MessageOrchestrator
from src.config import create_test_config

CHAT_ID = -1009999999999
BOT = User(id=4242, is_bot=True, first_name="Mavix", username="mavix_eg_bot")
ALICE = User(id=1, is_bot=False, first_name="Alice")
FORUM = Chat(id=CHAT_ID, type="supergroup", title="G", is_forum=True)
PRIVATE = Chat(id=1, type="private", first_name="Alice")


def make_settings(tmp_path: Path, **extra):
    vault = tmp_path / "vault"
    vault.mkdir(exist_ok=True)
    (vault / "work").mkdir(exist_ok=True)
    projects = tmp_path / "projects.yaml"
    projects.write_text(
        "projects:\n"
        '  - slug: "mavix-bot"\n    name: "MAVIX"\n    path: "."\n'
        '  - slug: "work"\n    name: "Work"\n    path: "work"\n',
        encoding="utf-8",
    )
    base = dict(
        approved_directory=str(vault),
        agentic_mode=True,
        enable_project_threads=True,
        project_threads_mode="group",
        project_threads_chat_id=CHAT_ID,
        projects_config_path=str(projects),
        database_url=f"sqlite:///{tmp_path / 'data' / 'bot.db'}",
        telegram_bot_username="mavix_eg_bot",
        allowed_users=[1],
    )
    base.update(extra)
    return create_test_config(**base)


def message(text=None, chat=FORUM, thread=None, topic=None, caption=None, reply=None):
    return Message(
        message_id=99,
        date=datetime.now(UTC),
        chat=chat,
        from_user=ALICE,
        text=text,
        caption=caption,
        message_thread_id=thread,
        is_topic_message=topic,
        reply_to_message=reply,
    )


def update_for(msg):
    return Update(update_id=1, message=msg)


def ctx(user_data=None):
    c = MagicMock()
    c.bot_data = {}
    c.user_data = {} if user_data is None else user_data
    c.bot = SimpleNamespace(username="mavix_eg_bot", id=4242)
    return c


def manager_for(settings, mapping=None):
    from src.projects import load_project_registry

    registry = load_project_registry(
        Path(settings.projects_config_path), settings.approved_directory
    )
    m = MagicMock()
    m.registry = registry
    m.guidance_message.return_value = "Project Thread Required"
    m.resolve_project = AsyncMock(
        side_effect=lambda chat, thread: (mapping or {}).get(thread)
    )
    return m


def deps():
    return {
        "claude_integration": MagicMock(),
        "storage": MagicMock(),
        "rate_limiter": MagicMock(),
        "audit_logger": MagicMock(),
        "security_validator": MagicMock(),
    }


# ------------------------------------------------------------ defaults ------
def test_defaults_are_unchanged(tmp_path):
    s = create_test_config(approved_directory=str(tmp_path))
    assert s.group_respond_mode == "all"
    assert s.project_threads_general_project is None
    assert s.project_threads_auto_map is False
    assert s.bot_name_alias_list == []
    app = MagicMock()
    MessageOrchestrator(s, deps()).register_handlers(app)
    groups = [c.kwargs.get("group", 0) for c in app.add_handler.call_args_list]
    assert all(g >= 0 for g in groups), "no pre-middleware handlers for a default agent"


def test_mention_mode_registers_gate_and_auto_registers_observer(tmp_path):
    s = make_settings(
        tmp_path, group_respond_mode="mention", project_threads_auto_map=True
    )
    app = MagicMock()
    MessageOrchestrator(s, deps()).register_handlers(app)
    groups = sorted(c.kwargs.get("group", 0) for c in app.add_handler.call_args_list)
    assert groups[:2] == [-5, -4]


def test_settings_parse_from_env_strings(tmp_path):
    s = make_settings(
        tmp_path,
        group_respond_mode=" Mention ",
        bot_name_aliases="MAVIX, مافيكس ,mavix",
        project_threads_general_project="off",
    )
    assert s.group_respond_mode == "mention"
    assert s.bot_name_alias_list == ["MAVIX", "مافيكس"]
    assert s.project_threads_general_project is None
    with pytest.raises(Exception):
        make_settings(tmp_path, group_respond_mode="sometimes")


# -------------------------------------------------------------- gate --------
async def test_gate_drops_unaddressed_group_message_silently(tmp_path):
    s = make_settings(tmp_path, group_respond_mode="mention", bot_name_aliases="MAVIX")
    o = MessageOrchestrator(s, deps())
    o._known_commands = frozenset({"new", "start"})
    u = update_for(message("lunch at 2?", thread=76, topic=True))
    with pytest.raises(ApplicationHandlerStop):
        await o._respond_gate(u, ctx())


@pytest.mark.parametrize(
    "text", ["@mavix_eg_bot hi", "mavix, hi", "/new", "/new@mavix_eg_bot"]
)
async def test_gate_lets_addressed_messages_through(tmp_path, text):
    s = make_settings(tmp_path, group_respond_mode="mention", bot_name_aliases="MAVIX")
    o = MessageOrchestrator(s, deps())
    o._known_commands = frozenset({"new", "start"})
    await o._respond_gate(update_for(message(text)), ctx())  # no ApplicationHandlerStop


async def test_gate_lets_caption_and_reply_through(tmp_path):
    s = make_settings(tmp_path, group_respond_mode="mention")
    o = MessageOrchestrator(s, deps())
    await o._respond_gate(update_for(message(caption="@mavix_eg_bot read this")), ctx())
    bot_msg = Message(
        message_id=7, date=datetime.now(UTC), chat=FORUM, from_user=BOT, text="ok"
    )
    await o._respond_gate(update_for(message("and this", reply=bot_msg)), ctx())


async def test_gate_never_filters_private_chats(tmp_path):
    s = make_settings(tmp_path, group_respond_mode="mention")
    o = MessageOrchestrator(s, deps())
    await o._respond_gate(update_for(message("hello", chat=PRIVATE)), ctx())


async def test_prompt_is_stripped_of_the_address(tmp_path):
    s = make_settings(tmp_path, group_respond_mode="mention", bot_name_aliases="MAVIX")
    o = MessageOrchestrator(s, deps())
    assert (
        o._addressed_text(
            update_for(message("@mavix_eg_bot Mavix, list files")),
            "@mavix_eg_bot Mavix, list files",
        )
        == "list files"
    )
    # private chat: untouched
    assert (
        o._addressed_text(
            update_for(message("Mavix, list", chat=PRIVATE)), "Mavix, list"
        )
        == "Mavix, list"
    )
    # mode all: untouched
    s2 = make_settings(tmp_path)
    assert (
        MessageOrchestrator(s2, deps())._addressed_text(
            update_for(message("@mavix_eg_bot x")), "@mavix_eg_bot x"
        )
        == "@mavix_eg_bot x"
    )


async def test_agentic_text_sends_stripped_prompt_to_claude(tmp_path):
    s = make_settings(
        tmp_path,
        group_respond_mode="mention",
        bot_name_aliases="MAVIX",
        enable_project_threads=False,
    )
    d = deps()
    d["rate_limiter"].check_rate_limit = AsyncMock(return_value=(True, ""))
    resp = SimpleNamespace(
        session_id="s1",
        content="ok",
        interrupted=False,
        tools_used=[],
        cost=0.0,
        num_turns=1,
        duration_ms=1,
        is_error=False,
    )
    d["claude_integration"].run_command = AsyncMock(return_value=resp)
    d["storage"].save_claude_interaction = AsyncMock()
    o = MessageOrchestrator(s, d)
    u = MagicMock()
    u.effective_user.id = 1
    u.effective_chat = FORUM
    u.message.text = "Mavix, what is in the vault?"
    u.message.chat.send_action = AsyncMock()
    u.message.chat.type = "supergroup"
    u.message.reply_text = AsyncMock(
        return_value=MagicMock(delete=AsyncMock(), edit_text=AsyncMock())
    )
    c = ctx()
    c.bot_data = dict(d, audit_logger=None, storage=None)
    await o.agentic_text(u, c)
    assert (
        d["claude_integration"].run_command.call_args.kwargs["prompt"]
        == "what is in the vault?"
    )


# ------------------------------------------------------------ General -------
async def run_wrapped(o, u, c):
    seen = {}

    async def handler(update, context):
        seen["dir"] = context.user_data.get("current_directory")
        seen["thread"] = context.user_data.get("_thread_context")
        seen["force_new"] = context.user_data.get("force_new_session")
        context.user_data["claude_session_id"] = "sess-" + str(
            seen["thread"]["state_key"]
        )

    await o._inject_deps(handler)(u, c)
    return seen


async def test_general_goes_to_the_chosen_project_with_its_own_state(tmp_path):
    s = make_settings(tmp_path, project_threads_general_project="mavix-bot")
    d = deps()
    mgr = manager_for(
        s,
        {
            76: SimpleNamespace(
                slug="mavix-bot",
                name="MAVIX",
                absolute_path=Path(s.approved_directory).resolve(),
            )
        },
    )
    d["project_threads_manager"] = mgr
    o = MessageOrchestrator(s, d)
    c = ctx()
    # General: no thread id at all
    seen = await run_wrapped(o, update_for(message("@mavix_eg_bot hi")), c)
    assert seen["thread"]["state_key"] == f"{CHAT_ID}:general"
    assert seen["dir"] == Path(s.approved_directory).resolve()
    assert seen["force_new"] is True  # never auto-resumes the MAVIX topic's session
    # A reply in General carries the replied-to id as thread id but is not a topic message
    seen = await run_wrapped(o, update_for(message("again", thread=55)), c)
    assert seen["thread"]["state_key"] == f"{CHAT_ID}:general"
    # The MAVIX topic keeps its own state
    seen = await run_wrapped(
        o, update_for(message("in topic", thread=76, topic=True)), c
    )
    assert seen["thread"]["state_key"] == f"{CHAT_ID}:76"
    states = c.user_data["thread_state"]
    assert (
        states[f"{CHAT_ID}:general"]["claude_session_id"] == f"sess-{CHAT_ID}:general"
    )
    assert states[f"{CHAT_ID}:76"]["claude_session_id"] == f"sess-{CHAT_ID}:76"
    # ... and both survive a restart, apart
    saved = json.loads(s.thread_sessions_path.read_text())
    assert saved[f"{CHAT_ID}:general:1"] == f"sess-{CHAT_ID}:general"
    assert saved[f"{CHAT_ID}:76:1"] == f"sess-{CHAT_ID}:76"
    o2 = MessageOrchestrator(s, d)
    seen = await run_wrapped(o2, update_for(message("after restart")), ctx())
    assert seen["force_new"] is False


async def test_other_unmapped_topics_still_get_the_guidance(tmp_path):
    s = make_settings(tmp_path, project_threads_general_project="mavix-bot")
    d = deps()
    d["project_threads_manager"] = manager_for(s, {})
    o = MessageOrchestrator(s, d)
    u = update_for(message("hello", thread=300, topic=True))
    sent = []

    async def fake_reply(update, text):
        sent.append(text)

    o._reject_for_thread_mode = fake_reply
    called = []
    await o._inject_deps(lambda *a: called.append(1))(u, ctx())
    assert sent == ["Project Thread Required"] and not called


async def test_general_off_keeps_todays_guidance(tmp_path):
    s = make_settings(tmp_path)
    d = deps()
    d["project_threads_manager"] = manager_for(s, {})
    o = MessageOrchestrator(s, d)
    sent = []

    async def fake_reply(update, text):
        sent.append(text)

    o._reject_for_thread_mode = fake_reply
    await o._inject_deps(AsyncMock())(update_for(message("hi")), ctx())
    assert sent == ["Project Thread Required"]
    assert o._thread_sessions is None
