"""ask_chatgpt wiring: the Joya ChatGPT broker's MCP server per agent."""

from pathlib import Path
from unittest.mock import patch

from src.claude.chatgpt_tool import TOOL_NAMES, caller_name, server_config
from src.claude.sdk_integration import ClaudeSDKManager
from src.config.settings import Settings

from .test_sdk_integration import (
    _make_assistant_message,
    _make_result_message,
    _mock_client_factory,
)


def _settings(tmp_path: Path, **kw):
    script = tmp_path / "chatgpt_mcp.py"
    script.write_text("# fake\n")
    vault = tmp_path / "agents" / "mavix-bot" / "vault"
    vault.mkdir(parents=True)
    base = dict(
        telegram_bot_token="test:token",
        telegram_bot_username="testbot",
        approved_directory=vault,
        claude_timeout_seconds=2,
        allow_chatgpt=True,
        chatgpt_mcp_server=str(script),
    )
    base.update(kw)
    return Settings(**base), script, vault


def test_server_config(tmp_path):
    settings, script, vault = _settings(tmp_path)
    name, conf, names = server_config(settings)
    assert name == "chatgpt"
    assert names == ["mcp__chatgpt__ask_chatgpt"]
    assert conf["type"] == "stdio"
    assert conf["args"] == ["-I", str(script)]
    assert conf["env"]["JOYA_CHATGPT_CALLER"] == "agent:mavix-bot"
    assert conf["env"]["JOYA_CHATGPT_FILES_ROOT"] == str(vault)
    assert conf["env"]["JOYA_CHATGPT_OUT"] == str(vault / "chatgpt")


def test_off_when_disabled_or_missing(tmp_path):
    settings, _, _ = _settings(tmp_path, allow_chatgpt=False)
    assert server_config(settings) is None
    (tmp_path / "b").mkdir()
    settings, _, _ = _settings(tmp_path / "b", chatgpt_mcp_server=str(tmp_path / "nope.py"))
    assert server_config(settings) is None


def test_caller_name_fallback(tmp_path):
    settings = Settings(
        telegram_bot_token="t:t", telegram_bot_username="somebot", approved_directory=tmp_path
    )
    assert caller_name(settings) == "agent:somebot"


async def test_execute_command_adds_chatgpt(tmp_path):
    settings, _, vault = _settings(tmp_path)
    manager = ClaudeSDKManager(settings)
    captured = []
    factory = _mock_client_factory(
        _make_assistant_message("ok"),
        _make_result_message(total_cost_usd=0.01),
        capture_options=captured,
    )
    with patch("src.claude.sdk_integration.ClaudeSDKClient", side_effect=factory):
        await manager.execute_command(prompt="hi", working_directory=vault)
    opts = captured[0]
    assert "chatgpt" in opts.mcp_servers
    assert TOOL_NAMES[0] in opts.allowed_tools
    assert "ask_chatgpt" in opts.system_prompt
    assert "ONLY when the user" in opts.system_prompt
