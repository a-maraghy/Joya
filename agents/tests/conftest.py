"""Pytest configuration and fixtures."""

import pytest


@pytest.fixture
def sample_user_id():
    """Sample Telegram user ID for testing."""
    return 123456789


@pytest.fixture
def sample_config():
    """Sample configuration for testing."""
    return {
        "telegram_bot_token": "test_token",
        "telegram_bot_username": "test_bot",
        "approved_directory": "/tmp/test_projects",
        "allowed_users": [123456789],
    }


@pytest.fixture(autouse=True)
def _no_host_chatgpt(monkeypatch):
    """Keep the host's ChatGPT broker (if installed) out of every test's options.

    Tests that cover ask_chatgpt switch it on explicitly with their own script.
    """
    monkeypatch.setenv("ALLOW_CHATGPT", "false")
