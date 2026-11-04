"""send_file: confinement, limits, chat/topic binding and the off switch."""

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from claude_agent_sdk._internal.query import Query
from telegram import Chat, Message, User

from src.claude.file_send import (
    CAPTION_LIMIT,
    QUALIFIED_TOOL_NAME,
    SERVER_NAME,
    TOOL_NAME,
    FileSendError,
    FileSendPolicy,
    ReplyFileSender,
    build_file_tool_server,
    file_guide,
    make_reply_file_sender,
    open_confined,
)
from src.claude.sdk_integration import ClaudeSDKManager
from src.config.settings import Settings

# --------------------------------------------------------------------------
# helpers


@pytest.fixture
def vault(tmp_path):
    root = tmp_path / "vault"
    (root / "outbox").mkdir(parents=True)
    return root


@pytest.fixture
def outside(tmp_path):
    other = tmp_path / "elsewhere"
    other.mkdir()
    secret = other / "secret.pdf"
    secret.write_bytes(b"%PDF-1.4 not yours")
    return secret


def policy(root, **kw):
    return FileSendPolicy(root=root, **kw)


def put(path: Path, data: bytes = b"hello") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def opened_name(raw, root, cwd=None, **kw):
    fobj, real, size = open_confined(raw, policy(root, **kw), cwd or root)
    fobj.close()
    return real, size


class FakeMessage:
    """Records reply_document calls the way PTB's Message would make them."""

    def __init__(self, chat_id, thread_id=None, fail=None):
        self.chat_id = chat_id
        self.message_thread_id = thread_id
        self.is_topic_message = thread_id is not None
        self.calls = []
        self._fail = fail

    async def reply_document(self, document, filename, caption=None, **kw):
        await asyncio.sleep(0.01)  # let concurrent senders interleave
        if self._fail:
            raise self._fail
        self.calls.append(
            {
                "chat_id": self.chat_id,
                "thread": self.message_thread_id,
                "filename": filename,
                "caption": caption,
                "bytes": document.read(),
            }
        )
        return SimpleNamespace(message_id=1)


async def call_tool(server_cfg, args, name=TOOL_NAME):
    """Go through the Agent SDK's own MCP router, as the CLI's request would."""
    q = Query.__new__(Query)
    q.sdk_mcp_servers = {server_cfg["name"]: server_cfg["instance"]}
    resp = await q._handle_sdk_mcp_request(
        server_cfg["name"],
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        },
    )
    return resp["result"]


def settings_for(root, **kw):
    return Settings(
        telegram_bot_token="test:token",
        telegram_bot_username="testbot",
        approved_directory=root,
        enable_mcp=False,
        **kw,
    )


# --------------------------------------------------------------------------
# path confinement


class TestConfinement:
    def test_relative_path_inside_is_resolved_against_cwd(self, vault):
        put(vault / "topics" / "a" / "r.pdf")
        real, size = opened_name("r.pdf", vault, cwd=vault / "topics" / "a")
        assert real == (vault / "topics" / "a" / "r.pdf").resolve()
        assert size == 5

    def test_absolute_path_inside(self, vault):
        f = put(vault / "outbox" / "r.docx")
        real, _ = opened_name(str(f), vault)
        assert real == f.resolve()

    def test_absolute_path_outside_refused(self, vault, outside):
        with pytest.raises(FileSendError, match="outside your folder"):
            opened_name(str(outside), vault)

    def test_dotdot_escape_refused(self, vault, outside):
        with pytest.raises(FileSendError, match="outside"):
            opened_name("../elsewhere/secret.pdf", vault)

    def test_sibling_prefix_is_not_inside(self, tmp_path):
        root = tmp_path / "vault"
        root.mkdir()
        put(tmp_path / "vault2" / "x.pdf")
        with pytest.raises(FileSendError, match="outside"):
            opened_name(str(tmp_path / "vault2" / "x.pdf"), root)

    def test_symlink_to_outside_refused(self, vault, outside):
        link = vault / "outbox" / "looks-local.pdf"
        os.symlink(outside, link)
        with pytest.raises(FileSendError, match="outside"):
            opened_name(str(link), vault)

    def test_symlink_to_inside_refused_too(self, vault):
        real = put(vault / "outbox" / "real.pdf")
        link = vault / "outbox" / "alias.pdf"
        os.symlink(real, link)
        with pytest.raises(FileSendError, match="symbolic link"):
            opened_name(str(link), vault)

    def test_symlinked_directory_leading_outside_refused(self, vault, outside):
        os.symlink(outside.parent, vault / "outbox" / "door")
        with pytest.raises(FileSendError, match="outside"):
            opened_name("outbox/door/secret.pdf", vault)

    def test_hard_link_refused(self, vault, outside):
        try:
            os.link(outside, vault / "outbox" / "hard.pdf")
        except OSError:
            pytest.skip("hard links not possible here")
        with pytest.raises(FileSendError, match="hard links"):
            opened_name("outbox/hard.pdf", vault)

    def test_missing_file(self, vault):
        with pytest.raises(FileSendError, match="No such file"):
            opened_name("outbox/nope.pdf", vault)

    def test_directory_is_not_a_file(self, vault):
        (vault / "dir.pdf").mkdir()
        with pytest.raises(FileSendError):
            opened_name("dir.pdf", vault)

    @pytest.mark.parametrize("raw", ["", "   ", "a\x00b.pdf"])
    def test_blank_or_nul(self, vault, raw):
        with pytest.raises(FileSendError):
            opened_name(raw, vault)


# --------------------------------------------------------------------------
# extensions and size


class TestLimits:
    @pytest.mark.parametrize(
        "name",
        ["r.docx", "r.pdf", "r.xlsx", "r.csv", "r.txt", "r.md", "r.png", "R.PDF"],
    )
    def test_allowed_types(self, vault, name):
        put(vault / name)
        opened_name(name, vault)

    @pytest.mark.parametrize(
        "name",
        ["run.sh", "agent.env", "x.exe", "noext", "r.pdf.sh", "db.sqlite", ".env"],
    )
    def test_other_types_refused(self, vault, name):
        put(vault / name)
        with pytest.raises(FileSendError, match="cannot be sent"):
            opened_name(name, vault)

    def test_empty_refused(self, vault):
        put(vault / "e.pdf", b"")
        with pytest.raises(FileSendError, match="empty"):
            opened_name("e.pdf", vault)

    def test_size_limit(self, vault):
        put(vault / "ok.pdf", b"x" * 1000)
        put(vault / "big.pdf", b"x" * 1001)
        opened_name("ok.pdf", vault, max_bytes=1000)
        with pytest.raises(FileSendError, match="limit"):
            opened_name("big.pdf", vault, max_bytes=1000)

    def test_settings_defaults_and_bounds(self, vault):
        s = settings_for(vault)
        assert s.allow_file_send is True
        assert s.file_send_max_bytes == 20 * 1024 * 1024
        assert s.file_send_max_per_reply == 5
        with pytest.raises(Exception):
            settings_for(vault, file_send_max_mb=51)  # over Telegram's 50 MB

    async def test_max_files_per_reply(self, vault):
        for i in range(3):
            put(vault / f"f{i}.txt")
        msg = FakeMessage(-100, 9)
        sender = ReplyFileSender(msg, policy(vault, max_files=2), vault)
        await sender.send("f0.txt")
        await sender.send("f1.txt")
        with pytest.raises(FileSendError, match="Already sent 2"):
            await sender.send("f2.txt")
        assert len(msg.calls) == 2

    async def test_caption_truncated_to_telegram_limit(self, vault):
        put(vault / "r.pdf")
        msg = FakeMessage(-100, 9)
        await ReplyFileSender(msg, policy(vault), vault).send("r.pdf", "x" * 5000)
        assert len(msg.calls[0]["caption"]) == CAPTION_LIMIT

    async def test_telegram_failure_is_reported_and_not_counted(self, vault):
        put(vault / "r.pdf")
        msg = FakeMessage(-100, 9, fail=RuntimeError("Request Entity Too Large"))
        sender = ReplyFileSender(msg, policy(vault), vault)
        with pytest.raises(FileSendError, match="did not accept"):
            await sender.send("r.pdf")
        assert sender.sent == []


# --------------------------------------------------------------------------
# the tool, through the SDK's router; chat/topic binding


class TestToolAndBinding:
    async def test_tools_list_schema_has_no_chat_argument(self, vault):
        cfg = build_file_tool_server(
            ReplyFileSender(FakeMessage(1), policy(vault), vault)
        )
        q = Query.__new__(Query)
        q.sdk_mcp_servers = {SERVER_NAME: cfg["instance"]}
        resp = await q._handle_sdk_mcp_request(
            SERVER_NAME, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        (tool,) = resp["result"]["tools"]
        assert tool["name"] == TOOL_NAME
        assert set(tool["inputSchema"]["properties"]) == {"path", "caption"}
        assert tool["inputSchema"]["additionalProperties"] is False
        assert (
            cfg["type"] == "sdk" and QUALIFIED_TOOL_NAME == "mcp__joya_files__send_file"
        )

    async def test_tool_result_ok_and_error(self, vault):
        put(vault / "r.pdf", b"%PDF")
        msg = FakeMessage(-100, 9)
        cfg = build_file_tool_server(ReplyFileSender(msg, policy(vault), vault))
        ok = await call_tool(cfg, {"path": "r.pdf", "caption": "Report"})
        assert "isError" not in ok and ok["content"][0]["text"].startswith("Sent r.pdf")
        bad = await call_tool(cfg, {"path": "/etc/passwd"})
        assert bad["isError"] is True and "Not sent" in bad["content"][0]["text"]
        # Extra arguments the model might invent are ignored, not obeyed.
        await call_tool(cfg, {"path": "r.pdf", "chat_id": 999, "message_thread_id": 1})
        assert {c["chat_id"] for c in msg.calls} == {-100}
        assert {c["thread"] for c in msg.calls} == {9}

    async def test_concurrent_requests_in_two_topics_do_not_cross(self, vault):
        put(vault / "topics" / "a" / "a.pdf", b"AAA")
        put(vault / "topics" / "b" / "b.xlsx", b"BBB")
        msg_a = FakeMessage(-100, 11)
        msg_b = FakeMessage(-100, 22)
        cfg_a = build_file_tool_server(
            ReplyFileSender(msg_a, policy(vault), vault / "topics" / "a")
        )
        cfg_b = build_file_tool_server(
            ReplyFileSender(msg_b, policy(vault), vault / "topics" / "b")
        )
        await asyncio.gather(
            call_tool(cfg_a, {"path": "a.pdf", "caption": "for A"}),
            call_tool(cfg_b, {"path": "b.xlsx", "caption": "for B"}),
            call_tool(cfg_a, {"path": "a.pdf", "caption": "for A again"}),
        )
        assert [(c["thread"], c["filename"], c["bytes"]) for c in msg_a.calls] == [
            (11, "a.pdf", b"AAA"),
            (11, "a.pdf", b"AAA"),
        ]
        assert [(c["thread"], c["filename"], c["bytes"]) for c in msg_b.calls] == [
            (22, "b.xlsx", b"BBB")
        ]

    @pytest.mark.parametrize(
        "is_topic,thread,expected",
        [(True, 76, 76), (False, None, None)],  # a topic; General (no thread id)
    )
    async def test_real_ptb_message_posts_to_its_own_chat_and_topic(
        self, vault, is_topic, thread, expected
    ):
        put(vault / "r.docx", b"PK")
        bot = MagicMock()
        bot.send_document = AsyncMock(return_value=None)
        bot.defaults = None
        chat = Chat(id=-1009999999999, type="supergroup", is_forum=True)
        msg = Message(
            message_id=500,
            date=__import__("datetime").datetime.now(),
            chat=chat,
            from_user=User(id=1, is_bot=False, first_name="A"),
            text="make the report",
            message_thread_id=thread,
            is_topic_message=is_topic,
        )
        msg.set_bot(bot)
        await ReplyFileSender(msg, policy(vault), vault).send("r.docx", "Report")
        kw = bot.send_document.call_args.kwargs
        assert kw["chat_id"] == -1009999999999
        assert kw["message_thread_id"] == expected
        assert kw["caption"] == "Report" and kw["filename"] == "r.docx"


# --------------------------------------------------------------------------
# the off switch and the wiring into the SDK options


def _mock_client_factory(captured):
    def factory(options):
        captured.append(options)
        client = AsyncMock()

        async def receive():
            yield AssistantMessage(content=[TextBlock(text="ok")], model="m")
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="s",
                total_cost_usd=0.0,
                result="ok",
            )

        client._query = MagicMock()
        client._query.receive_messages = receive
        return client

    return factory


class TestSwitchAndWiring:
    def test_sender_absent_when_disabled(self, vault):
        s = settings_for(vault, allow_file_send=False)
        assert make_reply_file_sender(s, FakeMessage(1), vault) is None

    def test_sender_present_by_default(self, vault):
        s = settings_for(vault)
        sender = make_reply_file_sender(s, FakeMessage(1), vault)
        assert isinstance(sender, ReplyFileSender)
        assert sender.policy.root == Path(vault)

    def test_orchestrator_passes_nothing_when_disabled(self, vault):
        from src.bot.orchestrator import MessageOrchestrator

        update = SimpleNamespace(effective_message=FakeMessage(1))
        on = MessageOrchestrator(settings_for(vault), {})
        off = MessageOrchestrator(settings_for(vault, allow_file_send=False), {})
        assert "file_sender" in on._file_send_kwargs(update, vault)
        assert off._file_send_kwargs(update, vault) == {}

    async def _options(self, vault, sender):
        captured = []
        mgr = ClaudeSDKManager(settings_for(vault))
        with (
            patch("src.claude.sdk_integration.parse_message", side_effect=lambda x: x),
            patch(
                "src.claude.sdk_integration.ClaudeSDKClient",
                side_effect=_mock_client_factory(captured),
            ),
        ):
            kw = {"file_sender": sender} if sender else {}
            await mgr.execute_command(prompt="hi", working_directory=vault, **kw)
        return captured[0]

    async def test_tool_wired_when_sender_given(self, vault):
        sender = ReplyFileSender(FakeMessage(1), policy(vault), vault)
        opts = await self._options(vault, sender)
        assert opts.mcp_servers[SERVER_NAME]["type"] == "sdk"
        assert opts.mcp_servers[SERVER_NAME]["instance"]._sender is sender
        assert QUALIFIED_TOOL_NAME in opts.allowed_tools
        assert "send_file" in opts.system_prompt

    async def test_tool_absent_without_sender(self, vault):
        opts = await self._options(vault, None)
        assert SERVER_NAME not in (opts.mcp_servers or {})
        assert QUALIFIED_TOOL_NAME not in (opts.allowed_tools or [])
        assert "send_file" not in opts.system_prompt

    def test_guide_names_an_arabic_font_and_limits(self, vault):
        text = file_guide(settings_for(vault))
        assert "5 files" in text and "20 MB" in text
        assert "arabic_reshaper" in text
