"""Configuration management using Pydantic Settings.

Features:
- Environment variable loading
- Type validation
- Default values
- Computed properties
- Environment-specific settings
"""

import json
from pathlib import Path
from typing import Any, List, Literal, Optional

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.utils.constants import (
    DEFAULT_CLAUDE_MAX_COST_PER_REQUEST,
    DEFAULT_CLAUDE_MAX_COST_PER_USER,
    DEFAULT_CLAUDE_MAX_TURNS,
    DEFAULT_CLAUDE_TIMEOUT_SECONDS,
    DEFAULT_DATABASE_URL,
    DEFAULT_MAX_SESSIONS_PER_USER,
    DEFAULT_PROJECT_THREADS_SYNC_ACTION_INTERVAL_SECONDS,
    DEFAULT_RATE_LIMIT_BURST,
    DEFAULT_RATE_LIMIT_REQUESTS,
    DEFAULT_RATE_LIMIT_WINDOW,
    DEFAULT_RETRY_BACKOFF_FACTOR,
    DEFAULT_RETRY_BASE_DELAY,
    DEFAULT_RETRY_MAX_ATTEMPTS,
    DEFAULT_RETRY_MAX_DELAY,
    DEFAULT_SESSION_TIMEOUT_HOURS,
)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Bot settings
    telegram_bot_token: SecretStr = Field(
        ..., description="Telegram bot token from BotFather"
    )
    telegram_bot_username: str = Field(..., description="Bot username without @")

    # Security
    approved_directory: Path = Field(..., description="Base directory for projects")
    allowed_users: Optional[List[int]] = Field(
        None, description="Allowed Telegram user IDs"
    )
    enable_token_auth: bool = Field(
        False, description="Enable token-based authentication"
    )
    auth_token_secret: Optional[SecretStr] = Field(
        None, description="Secret for auth tokens"
    )

    # Security relaxation (for trusted environments)
    disable_security_patterns: bool = Field(
        False,
        description=(
            "Disable dangerous pattern validation (pipes, redirections, etc.)"
        ),
    )
    disable_tool_validation: bool = Field(
        False,
        description="Allow all Claude tools by bypassing tool validation checks",
    )

    # Claude settings
    claude_binary_path: Optional[str] = Field(
        None, description="Path to Claude CLI binary (deprecated)"
    )
    claude_cli_path: Optional[str] = Field(
        None, description="Path to Claude CLI executable"
    )
    anthropic_api_key: Optional[SecretStr] = Field(
        None,
        description="Anthropic API key for SDK (optional if CLI logged in)",
    )
    claude_model: Optional[str] = Field(
        None, description="Claude model to use (defaults to CLI default if unset)"
    )
    claude_effort: Optional[Literal["low", "medium", "high", "xhigh", "max"]] = Field(
        "medium",
        description=(
            "How hard the model thinks before answering. Medium suits most "
            "conversational work; the higher levels cost noticeably more time "
            "and tokens per turn and earn it only on hard reasoning"
        ),
    )
    claude_max_turns: int = Field(
        DEFAULT_CLAUDE_MAX_TURNS, description="Max conversation turns"
    )
    claude_timeout_seconds: int = Field(
        DEFAULT_CLAUDE_TIMEOUT_SECONDS, description="Claude timeout"
    )
    claude_max_cost_per_user: float = Field(
        DEFAULT_CLAUDE_MAX_COST_PER_USER, description="Max cost per user"
    )
    claude_max_cost_per_request: float = Field(
        DEFAULT_CLAUDE_MAX_COST_PER_REQUEST,
        description="Max cost per individual request (SDK budget cap)",
    )

    # === PERSISTENT MEMORY ===
    # A Telegram session can end or be reset at any time, and nothing in the
    # conversation survives that -- only files do. These settings inject the
    # project's durable notes into the system prompt on every request, so the
    # assistant always starts knowing who it is and what is already done.
    enable_persistent_memory: bool = Field(
        True,
        description="Inject MEMORY.md from the project directory into the system prompt",
    )
    memory_scaffold_on_start: bool = Field(
        True,
        description="Create MEMORY.md / WORKLOG.md / memory/ in a project that has none",
    )
    context_file_max_chars: int = Field(
        24000,
        description="Max characters read from CLAUDE.md and MEMORY.md (each) before truncation",
    )
    # NOTE: When changing this list, also update docs/tools.md,
    # docs/configuration.md, .env.example,
    # src/claude/facade.py (_get_admin_instructions),
    # and src/bot/orchestrator.py (_TOOL_ICONS).
    claude_allowed_tools: Optional[List[str]] = Field(
        default=[
            "Read",
            "Write",
            "Edit",
            "Bash",
            "Glob",
            "Grep",
            "LS",
            "Task",
            "TaskOutput",
            "MultiEdit",
            "NotebookRead",
            "NotebookEdit",
            "WebFetch",
            "TodoRead",
            "TodoWrite",
            "WebSearch",
            "Skill",
        ],
        description="List of allowed Claude tools",
    )
    claude_disallowed_tools: Optional[List[str]] = Field(
        default=[],
        description="List of explicitly disallowed Claude tools/commands",
    )

    # Retry settings
    claude_retry_max_attempts: int = Field(
        DEFAULT_RETRY_MAX_ATTEMPTS,
        ge=0,
        description="Max retry attempts for transient SDK errors (0 = disabled)",
    )
    claude_retry_base_delay: float = Field(
        DEFAULT_RETRY_BASE_DELAY,
        ge=0,
        description=(
            "Base delay in seconds between retries. "
            "0 means retries are attempted immediately with no pause."
        ),
    )
    claude_retry_backoff_factor: float = Field(
        DEFAULT_RETRY_BACKOFF_FACTOR,
        gt=0,
        description="Exponential backoff multiplier",
    )
    claude_retry_max_delay: float = Field(
        DEFAULT_RETRY_MAX_DELAY,
        ge=0,
        description=(
            "Maximum delay cap in seconds. "
            "0 disables the cap entirely (delays grow unbounded with backoff)."
        ),
    )

    # Sandbox settings
    sandbox_enabled: bool = Field(
        True,
        description="Enable OS-level bash sandboxing for approved dir",
    )
    sandbox_excluded_commands: Optional[List[str]] = Field(
        default=["git", "npm", "pip", "poetry", "make", "docker"],
        description="Commands that run outside the sandbox (need system access)",
    )

    # Rate limiting
    rate_limit_requests: int = Field(
        DEFAULT_RATE_LIMIT_REQUESTS, description="Requests per window"
    )
    rate_limit_window: int = Field(
        DEFAULT_RATE_LIMIT_WINDOW, description="Rate limit window seconds"
    )
    rate_limit_burst: int = Field(
        DEFAULT_RATE_LIMIT_BURST, description="Burst capacity"
    )

    # Storage
    database_url: str = Field(
        DEFAULT_DATABASE_URL, description="Database connection URL"
    )
    session_timeout_hours: int = Field(
        DEFAULT_SESSION_TIMEOUT_HOURS, description="Session timeout"
    )
    session_timeout_minutes: int = Field(
        default=120,
        description="Session timeout in minutes",
        ge=10,
        le=1440,  # Max 24 hours
    )
    max_sessions_per_user: int = Field(
        DEFAULT_MAX_SESSIONS_PER_USER, description="Max concurrent sessions"
    )

    # Features
    enable_mcp: bool = Field(False, description="Enable Model Context Protocol")
    mcp_config_path: Optional[Path] = Field(
        None, description="MCP configuration file path"
    )
    enable_git_integration: bool = Field(True, description="Enable git commands")
    enable_file_uploads: bool = Field(True, description="Enable file upload handling")
    enable_voice_messages: bool = Field(
        True, description="Enable voice message transcription"
    )
    voice_provider: Literal["mistral", "openai", "local"] = Field(
        "mistral",
        description="Voice transcription provider: 'mistral', 'openai', or 'local'",
    )
    mistral_api_key: Optional[SecretStr] = Field(
        None, description="Mistral API key for voice transcription"
    )
    openai_api_key: Optional[SecretStr] = Field(
        None, description="OpenAI API key for Whisper voice transcription"
    )
    voice_transcription_model: Optional[str] = Field(
        None,
        description=(
            "Model for voice transcription. "
            "Defaults to 'voxtral-mini-latest' (Mistral) or 'whisper-1' (OpenAI)"
        ),
    )
    voice_max_file_size_mb: int = Field(
        20,
        description=(
            "Maximum Telegram voice message size (MB) that will be downloaded "
            "for transcription"
        ),
        ge=1,
        le=200,
    )
    attachment_max_size_mb: int = Field(
        20,
        description=(
            "Maximum size (MB) of a file sent in chat that will be saved into "
            "the agent's workspace"
        ),
        ge=1,
        le=200,
    )
    # --- JOYA: send generated files back into the chat ---------------------
    allow_file_send: bool = Field(
        True,
        description=(
            "Give Claude a send_file tool that posts a file from the agent's "
            "folder into the chat and topic the request came from"
        ),
    )
    file_send_max_mb: int = Field(
        20,
        description="Largest file (MB) send_file will post; Telegram's bot limit is 50",
        ge=1,
        le=50,
    )
    file_send_max_per_reply: int = Field(
        5,
        description="How many files send_file may post while answering one message",
        ge=1,
        le=20,
    )
    # --- JOYA: hand a task to ChatGPT on the user's explicit request --------
    allow_chatgpt: bool = Field(
        True,
        description=(
            "Give Claude the ask_chatgpt tool (Joya ChatGPT broker), used only "
            "when the user explicitly asks to delegate to ChatGPT; off when the "
            "broker's MCP server is not installed"
        ),
    )
    chatgpt_mcp_server: str = Field(
        "/usr/local/lib/joya-chatgpt/chatgpt_mcp.py",
        description="Path of the ChatGPT broker's stdio MCP server",
    )
    # --- JOYA: pictures drawn in code (SVG -> PNG with resvg) ---------------
    allow_drawing: bool = Field(
        True,
        description=(
            "Give Claude render_svg / contact_sheet and SVG previews so it can draw "
            "logos and illustrations in SVG, look at the render and refine it. "
            "Needs ALLOW_FILE_SEND"
        ),
    )
    draw_max_render_px: int = Field(
        2048,
        description="Longest edge (px) of any PNG rendered from an SVG",
        ge=256,
        le=4096,
    )
    draw_max_renders_per_reply: int = Field(
        12,
        description="How many render_svg / contact_sheet calls one message may use",
        ge=1,
        le=50,
    )
    svg_max_kb: int = Field(
        2048,
        description="Largest SVG (KB) that will be rendered or sent",
        ge=64,
        le=10240,
    )
    save_photos_to_workspace: bool = Field(
        True,
        description=(
            "Also write photos into attachments/inbox/ as well as passing them "
            "to the model. Photos are otherwise visible for one turn only"
        ),
    )
    whisper_cpp_binary_path: Optional[str] = Field(
        None,
        description=(
            "Path to whisper.cpp binary. "
            "Required when VOICE_PROVIDER=local. Auto-detected from PATH if unset."
        ),
    )
    whisper_cpp_model_path: Optional[str] = Field(
        None,
        description=(
            "Path to whisper.cpp GGML model file, or model name "
            "(e.g. 'base', 'small'). Defaults to 'base'. "
            "Named models resolve to ~/.cache/whisper-cpp/ggml-{name}.bin"
        ),
    )
    enable_quick_actions: bool = Field(True, description="Enable quick action buttons")
    agentic_mode: bool = Field(
        True,
        description="Conversational agentic mode (default) vs classic command mode",
    )

    # Reply quoting
    reply_quote: bool = Field(
        True,
        description=(
            "Quote the original user message when replying. "
            "Set to false for cleaner thread-based conversations."
        ),
    )

    # Output verbosity (0=quiet, 1=normal, 2=detailed)
    verbose_level: int = Field(
        1,
        description=(
            "Bot output verbosity: 0=quiet (final response only), "
            "1=normal (tool names + reasoning), "
            "2=detailed (tool inputs + longer reasoning)"
        ),
        ge=0,
        le=2,
    )

    # Streaming drafts (Telegram sendMessageDraft)
    enable_stream_drafts: bool = Field(
        False,
        description="Stream partial responses via sendMessageDraft (private chats only)",
    )
    stream_draft_interval: float = Field(
        0.3,
        description="Minimum seconds between draft updates (0.1-5.0)",
        ge=0.1,
        le=5.0,
    )

    # Monitoring
    log_level: str = Field("INFO", description="Logging level")
    enable_telemetry: bool = Field(False, description="Enable anonymous telemetry")
    sentry_dsn: Optional[str] = Field(None, description="Sentry DSN for error tracking")

    # Development
    debug: bool = Field(False, description="Enable debug mode")
    development_mode: bool = Field(False, description="Enable development features")

    # Webhook settings (optional)
    webhook_url: Optional[str] = Field(None, description="Webhook URL for bot")
    webhook_port: int = Field(8443, description="Webhook port")
    webhook_path: str = Field("/webhook", description="Webhook path")

    # Agentic platform settings
    enable_api_server: bool = Field(False, description="Enable FastAPI webhook server")
    api_server_port: int = Field(8080, description="Webhook API server port")
    webhook_fresh_session: bool = Field(
        False,
        description=(
            "Run each webhook event in a new Claude session instead of resuming "
            "the user's current one, so per-event cost does not grow with history"
        ),
    )
    enable_scheduler: bool = Field(False, description="Enable job scheduler")
    github_webhook_secret: Optional[str] = Field(
        None, description="GitHub webhook HMAC secret"
    )
    webhook_api_secret: Optional[str] = Field(
        None, description="Shared secret for generic webhook providers"
    )
    notification_chat_ids: Optional[List[int]] = Field(
        None, description="Default Telegram chat IDs for proactive notifications"
    )
    enable_project_threads: bool = Field(
        False,
        description="Enable strict routing by Telegram forum project threads",
    )
    project_threads_mode: Literal["private", "group"] = Field(
        "private",
        description="Project thread mode: private chat topics or group forum topics",
    )
    project_threads_chat_id: Optional[int] = Field(
        None, description="Telegram forum chat ID where project topics are managed"
    )
    projects_config_path: Optional[Path] = Field(
        None, description="Path to YAML project registry for thread mode"
    )
    project_threads_sync_action_interval_seconds: float = Field(
        DEFAULT_PROJECT_THREADS_SYNC_ACTION_INTERVAL_SECONDS,
        description=(
            "Minimum delay between Telegram API calls during project topic sync"
        ),
        ge=0.0,
    )
    # --- JOYA: General topic, respond-when-asked, auto-mapped topics -------
    # All default to the behaviour before these options existed.
    project_threads_general_project: Optional[str] = Field(
        None,
        description=(
            "Group thread mode: route the forum's General topic to this project "
            "slug ('off' or empty = keep refusing General)"
        ),
    )
    group_respond_mode: Literal["all", "mention"] = Field(
        "all",
        description=(
            "In group chats: 'all' answers every message, 'mention' only messages "
            "that @mention the bot, reply to it, address a command to it or name it"
        ),
    )
    bot_name_aliases: str = Field(
        "",
        description="Comma-separated names that count as addressing the bot",
    )
    project_threads_auto_map: bool = Field(
        False,
        description="Group thread mode: give every new forum topic its own folder",
    )
    project_threads_auto_announce: bool = Field(
        True,
        description="Post one line in a topic when it is linked to a new folder",
    )
    project_threads_auto_max: int = Field(
        100, ge=1, le=500, description="Cap on automatically created topic projects"
    )
    project_threads_deleted_topics: Literal["trash", "keep"] = Field(
        "trash",
        description="What happens to an auto topic's folder when the topic is deleted",
    )
    project_threads_trash_days: int = Field(
        30, ge=0, le=3650, description="Days a trashed topic folder is kept (0 = none)"
    )
    project_threads_probe_interval_seconds: int = Field(
        600,
        ge=1,
        le=86400,
        description="How often auto topics are checked for deletion",
    )

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    @field_validator("allowed_users", "notification_chat_ids", mode="before")
    @classmethod
    def parse_int_list(cls, v: Any) -> Optional[List[int]]:
        """Parse comma-separated integer lists."""
        if v is None:
            return None
        if isinstance(v, int):
            return [v]
        if isinstance(v, str):
            return [int(uid.strip()) for uid in v.split(",") if uid.strip()]
        if isinstance(v, list):
            return [int(uid) for uid in v]
        return v  # type: ignore[no-any-return]

    @field_validator("claude_allowed_tools", mode="before")
    @classmethod
    def parse_claude_allowed_tools(cls, v: Any) -> Optional[List[str]]:
        """Parse comma-separated tool names."""
        if v is None:
            return None
        if isinstance(v, str):
            return [tool.strip() for tool in v.split(",") if tool.strip()]
        if isinstance(v, list):
            return [str(tool) for tool in v]
        return v  # type: ignore[no-any-return]

    @field_validator("approved_directory")
    @classmethod
    def validate_approved_directory(cls, v: Any) -> Path:
        """Ensure approved directory exists and is absolute."""
        if isinstance(v, str):
            v = Path(v)

        path = v.resolve()
        if not path.exists():
            raise ValueError(f"Approved directory does not exist: {path}")
        if not path.is_dir():
            raise ValueError(f"Approved directory is not a directory: {path}")
        return path  # type: ignore[no-any-return]

    @field_validator("mcp_config_path", mode="before")
    @classmethod
    def validate_mcp_config(cls, v: Any, info: Any) -> Optional[Path]:
        """Validate MCP configuration path if MCP is enabled."""
        if not v:
            return v  # type: ignore[no-any-return]
        if isinstance(v, str):
            v = Path(v)
        if not v.exists():
            raise ValueError(f"MCP config file does not exist: {v}")
        # Validate that the file contains valid JSON with mcpServers
        try:
            with open(v) as f:
                config_data = json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"MCP config file is not valid JSON: {e}")
        if not isinstance(config_data, dict):
            raise ValueError("MCP config file must contain a JSON object")
        if "mcpServers" not in config_data:
            raise ValueError(
                "MCP config file must contain a 'mcpServers' key. "
                'Format: {"mcpServers": {"name": {"command": ...}}}'
            )
        if not isinstance(config_data["mcpServers"], dict):
            raise ValueError(
                "'mcpServers' must be an object mapping server names to configurations"
            )
        if not config_data["mcpServers"]:
            raise ValueError(
                "'mcpServers' must contain at least one server configuration"
            )
        return v  # type: ignore[no-any-return]

    @field_validator("projects_config_path", mode="before")
    @classmethod
    def validate_projects_config_path(cls, v: Any) -> Optional[Path]:
        """Validate projects config path if provided."""
        if not v:
            return None
        if isinstance(v, str):
            value = v.strip()
            if not value:
                return None
            v = Path(value)
        if not v.exists():
            raise ValueError(f"Projects config file does not exist: {v}")
        if not v.is_file():
            raise ValueError(f"Projects config path is not a file: {v}")
        return v  # type: ignore[no-any-return]

    @field_validator("project_threads_mode", mode="before")
    @classmethod
    def validate_project_threads_mode(cls, v: Any) -> str:
        """Validate project thread mode."""
        if v is None:
            return "private"
        mode = str(v).strip().lower()
        if mode not in {"private", "group"}:
            raise ValueError("project_threads_mode must be one of ['private', 'group']")
        return mode

    @field_validator("project_threads_general_project", mode="before")
    @classmethod
    def validate_general_project(cls, v: Any) -> Optional[str]:
        """Blank or 'off' switches General routing off; otherwise a project slug."""
        if v is None:
            return None
        value = str(v).strip()
        if not value or value.lower() in {"off", "none", "false"}:
            return None
        if len(value) > 64 or any(c.isspace() or c == "," for c in value):
            raise ValueError(
                "project_threads_general_project must be a project slug or 'off'"
            )
        return value

    @field_validator(
        "group_respond_mode", "project_threads_deleted_topics", mode="before"
    )
    @classmethod
    def normalise_choice(cls, v: Any) -> Any:
        """Accept any case and surrounding blanks for the choice settings."""
        return str(v).strip().lower() if isinstance(v, str) else v

    @field_validator("bot_name_aliases", mode="before")
    @classmethod
    def validate_bot_name_aliases(cls, v: Any) -> str:
        """Comma-separated names, each 1-64 characters, at most 20."""
        if v is None:
            return ""
        items = v if isinstance(v, (list, tuple)) else str(v).split(",")
        names: List[str] = []
        seen = set()
        for item in items:
            name = " ".join(str(item).split())
            if not name:
                continue
            if len(name) > 64:
                raise ValueError(
                    "bot_name_aliases: a name is longer than 64 characters"
                )
            if name.casefold() not in seen:
                seen.add(name.casefold())
                names.append(name)
        if len(names) > 20:
            raise ValueError("bot_name_aliases: at most 20 names")
        return ",".join(names)

    @field_validator("voice_provider", mode="before")
    @classmethod
    def validate_voice_provider(cls, v: Any) -> str:
        """Validate and normalize voice transcription provider."""
        if v is None:
            return "mistral"
        provider = str(v).strip().lower()
        if provider not in {"mistral", "openai", "local"}:
            raise ValueError(
                "voice_provider must be one of ['mistral', 'openai', 'local']"
            )
        return provider

    @field_validator("project_threads_chat_id", mode="before")
    @classmethod
    def validate_project_threads_chat_id(cls, v: Any) -> Optional[int]:
        """Allow empty chat ID for private mode by treating blank values as None."""
        if v is None:
            return None
        if isinstance(v, str):
            value = v.strip()
            if not value:
                return None
            return int(value)
        if isinstance(v, int):
            return v
        return v  # type: ignore[no-any-return]

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v: Any) -> str:
        """Validate log level."""
        valid_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        if v.upper() not in valid_levels:
            raise ValueError(f"log_level must be one of {valid_levels}")
        return v.upper()  # type: ignore[no-any-return]

    @model_validator(mode="after")
    def validate_cross_field_dependencies(self) -> "Settings":
        """Validate dependencies between fields."""
        # Check auth token requirements
        if self.enable_token_auth and not self.auth_token_secret:
            raise ValueError(
                "auth_token_secret required when enable_token_auth is True"
            )

        # Check MCP requirements
        if self.enable_mcp and not self.mcp_config_path:
            raise ValueError("mcp_config_path required when enable_mcp is True")

        if self.enable_project_threads:
            if (
                self.project_threads_mode == "group"
                and self.project_threads_chat_id is None
            ):
                raise ValueError(
                    "project_threads_chat_id required when "
                    "project_threads_mode is 'group'"
                )
            if not self.projects_config_path:
                raise ValueError(
                    "projects_config_path required when enable_project_threads is True"
                )

        return self

    @property
    def is_production(self) -> bool:
        """Check if running in production mode."""
        return not (self.debug or self.development_mode)

    @property
    def database_path(self) -> Optional[Path]:
        """Extract path from SQLite database URL."""
        if self.database_url.startswith("sqlite:///"):
            db_path = self.database_url.replace("sqlite:///", "")
            return Path(db_path).resolve()
        return None

    @property
    def telegram_token_str(self) -> str:
        """Get Telegram token as string."""
        return self.telegram_bot_token.get_secret_value()

    @property
    def auth_secret_str(self) -> Optional[str]:
        """Get auth token secret as string."""
        if self.auth_token_secret:
            return self.auth_token_secret.get_secret_value()
        return None

    @property
    def anthropic_api_key_str(self) -> Optional[str]:
        """Get Anthropic API key as string."""
        return (
            self.anthropic_api_key.get_secret_value()
            if self.anthropic_api_key
            else None
        )

    @property
    def mistral_api_key_str(self) -> Optional[str]:
        """Get Mistral API key as string."""
        return self.mistral_api_key.get_secret_value() if self.mistral_api_key else None

    @property
    def openai_api_key_str(self) -> Optional[str]:
        """Get OpenAI API key as string."""
        return self.openai_api_key.get_secret_value() if self.openai_api_key else None

    @property
    def resolved_voice_model(self) -> str:
        """Get the voice transcription model, with provider-specific defaults."""
        if self.voice_transcription_model:
            return self.voice_transcription_model
        if self.voice_provider == "openai":
            return "whisper-1"
        if self.voice_provider == "local":
            return self.whisper_cpp_model_path or "base"
        return "voxtral-mini-latest"

    @property
    def voice_max_file_size_bytes(self) -> int:
        """Maximum allowed voice message size in bytes."""
        return self.voice_max_file_size_mb * 1024 * 1024

    @property
    def attachment_max_size_bytes(self) -> int:
        """Maximum allowed chat attachment size in bytes."""
        return self.attachment_max_size_mb * 1024 * 1024

    @property
    def file_send_max_bytes(self) -> int:
        """Largest file send_file will post, in bytes."""
        return self.file_send_max_mb * 1024 * 1024

    @property
    def voice_provider_api_key_env(self) -> str:
        """API key environment variable required for the configured voice provider."""
        if self.voice_provider == "openai":
            return "OPENAI_API_KEY"
        if self.voice_provider == "local":
            return ""
        return "MISTRAL_API_KEY"

    @property
    def voice_provider_display_name(self) -> str:
        """Human-friendly label for the configured voice provider."""
        if self.voice_provider == "openai":
            return "OpenAI Whisper"
        if self.voice_provider == "local":
            return "Local whisper.cpp"
        return "Mistral Voxtral"

    @property
    def resolved_whisper_cpp_binary(self) -> str:
        """Resolve whisper.cpp binary path, defaulting to 'whisper-cpp' on PATH."""
        return self.whisper_cpp_binary_path or "whisper-cpp"

    @property
    def resolved_whisper_cpp_model_path(self) -> str:
        """Resolve whisper.cpp model file path from name or explicit path."""
        path_or_name = self.whisper_cpp_model_path or "base"
        if "/" in path_or_name or path_or_name.endswith(".bin"):
            return path_or_name
        return str(Path.home() / ".cache" / "whisper-cpp" / f"ggml-{path_or_name}.bin")

    @property
    def bot_name_alias_list(self) -> List[str]:
        """Names that address the bot, as a list."""
        return [n for n in self.bot_name_aliases.split(",") if n]

    @property
    def project_threads_auto_path(self) -> Optional[Path]:
        """The runtime-owned list of automatically mapped topics.

        Next to the projects file: the panel writes projects.yaml, this process
        writes projects.auto.json, and each reads the other's.
        """
        if not self.projects_config_path:
            return None
        return Path(self.projects_config_path).parent / "projects.auto.json"

    @property
    def thread_sessions_path(self) -> Path:
        """Where per-topic Claude session ids are kept across restarts."""
        db = self.database_path
        base = db.parent if db else Path(self.approved_directory).parent
        return base / "thread_sessions.json"
