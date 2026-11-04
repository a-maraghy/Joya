"""ask_chatgpt: hand a task to ChatGPT, on the user's explicit request only.

The tool itself is the Joya ChatGPT broker's stdio MCP server
(Joya chatgpt/chatgpt_mcp.py, installed at
/usr/local/lib/joya-chatgpt/chatgpt_mcp.py by deploy/install-chatgpt.sh). It
talks to the broker over /run/joya-chatgpt/sock; the broker runs the OpenAI
Codex CLI with the one ChatGPT sign-in on the server. Nothing here holds or
sees that sign-in.

This module only decides whether an agent gets the server and how it is
configured: its context files must come from the agent's own folder, and the
files ChatGPT makes land in <approved dir>/chatgpt/<task id>/, where send_file
can post them.
"""

import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SERVER = "chatgpt"
TOOL_NAMES = [f"mcp__{SERVER}__ask_chatgpt"]


def caller_name(settings: Any) -> str:
    """agent:<slug> for a panel-made agent (/opt/joya-agents/agents/<slug>/vault)."""
    approved = Path(str(getattr(settings, "approved_directory", "") or "."))
    if approved.parent.parent.name == "agents":
        return f"agent:{approved.parent.name}"
    return f"agent:{getattr(settings, 'telegram_bot_username', '') or approved.name}"


def server_config(settings: Any) -> Optional[Tuple[str, Dict[str, Any], List[str]]]:
    """(name, stdio config, allowed tool names), or None when switched off or not installed."""
    if not getattr(settings, "allow_chatgpt", True):
        return None
    script = str(getattr(settings, "chatgpt_mcp_server", "") or "")
    if not script or not os.path.isfile(script):
        return None
    approved = str(getattr(settings, "approved_directory", "") or "")
    env = {
        "JOYA_CHATGPT_CALLER": caller_name(settings),
        "JOYA_CHATGPT_FILES_ROOT": approved,
        "JOYA_CHATGPT_OUT": os.path.join(approved, "chatgpt"),
    }
    python = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable
    return SERVER, {"type": "stdio", "command": python, "args": ["-I", script], "env": env}, list(TOOL_NAMES)


def chatgpt_guide() -> str:
    return (
        "ChatGPT: you have the tool ask_chatgpt, which hands a task to ChatGPT "
        "(OpenAI) through the user's ChatGPT account. Use it ONLY when the user "
        "explicitly asks you to ask, use or delegate to ChatGPT/GPT; never on your "
        "own. Give it the whole task and context (it cannot see this chat; pass "
        "files from your folder in `files`). Say that the answer is ChatGPT's. Files "
        "it makes are saved under chatgpt/ in your folder; send them with send_file "
        "when the user wants them."
    )
