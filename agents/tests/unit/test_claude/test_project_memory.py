"""Test project memory: CLAUDE.md + MEMORY.md injection and scaffolding."""

from pathlib import Path
from types import SimpleNamespace

from src.claude.sdk_integration import ClaudeSDKManager


def _build(tmp_path, **overrides):
    """Build a system prompt with just the config attributes it reads."""
    values = {
        "enable_persistent_memory": True,
        "memory_scaffold_on_start": True,
        "context_file_max_chars": 24000,
    }
    values.update(overrides)
    manager = ClaudeSDKManager.__new__(ClaudeSDKManager)
    manager.config = SimpleNamespace(**values)
    return manager._build_system_prompt(Path(tmp_path))


class TestSystemPromptComposition:
    def test_sandbox_instruction_always_present(self, tmp_path):
        prompt = _build(tmp_path)
        assert str(tmp_path) in prompt
        assert "Use relative paths." in prompt

    def test_claude_md_is_injected(self, tmp_path):
        (tmp_path / "CLAUDE.md").write_text("You are the ACME assistant.", encoding="utf-8")
        assert "You are the ACME assistant." in _build(tmp_path)

    def test_memory_is_injected_with_source_of_truth_header(self, tmp_path):
        (tmp_path / "MEMORY.md").write_text("Shipped the parser.", encoding="utf-8")
        prompt = _build(tmp_path)
        assert "Shipped the parser." in prompt
        assert "PERSISTENT MEMORY (MEMORY.md)" in prompt

    def test_memory_can_be_disabled(self, tmp_path):
        (tmp_path / "CLAUDE.md").write_text("identity", encoding="utf-8")
        (tmp_path / "MEMORY.md").write_text("Shipped the parser.", encoding="utf-8")
        prompt = _build(tmp_path, enable_persistent_memory=False)
        assert "identity" in prompt
        assert "Shipped the parser." not in prompt

    def test_oversized_file_is_truncated_not_dropped(self, tmp_path):
        (tmp_path / "CLAUDE.md").write_text("A" * 500 + "TAIL", encoding="utf-8")
        prompt = _build(tmp_path, context_file_max_chars=100)
        assert "truncated" in prompt
        assert "TAIL" not in prompt

    def test_missing_files_are_not_an_error(self, tmp_path):
        assert _build(tmp_path, memory_scaffold_on_start=False)


class TestMemoryScaffolding:
    def test_scaffold_creates_memory_files(self, tmp_path):
        _build(tmp_path)
        assert (tmp_path / "MEMORY.md").exists()
        assert (tmp_path / "WORKLOG.md").exists()
        assert (tmp_path / "memory").is_dir()

    def test_scaffold_never_overwrites_existing_memory(self, tmp_path):
        (tmp_path / "MEMORY.md").write_text("hand written", encoding="utf-8")
        _build(tmp_path)
        assert (tmp_path / "MEMORY.md").read_text(encoding="utf-8") == "hand written"

    def test_scaffold_can_be_disabled(self, tmp_path):
        _build(tmp_path, memory_scaffold_on_start=False)
        assert not (tmp_path / "MEMORY.md").exists()

    def test_scaffolded_memory_is_immediately_injected(self, tmp_path):
        assert "PERSISTENT MEMORY (MEMORY.md)" in _build(tmp_path)
