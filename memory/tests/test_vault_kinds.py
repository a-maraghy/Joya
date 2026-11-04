"""memory_write files notes by kind, keeps names unique across memory/, lists them under
the matching MEMORY.md heading, and an old flat path still finds a note that moved.

    cd memory && python3 -m pytest -q tests      (or: python3 tests/test_vault_kinds.py)
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from joya_memory.vault import Vault, kind_folder  # noqa: E402

INDEX = """# MEMORY

## CURRENT STATE

Nothing yet.

---

## Memory index

_New notes land at the top of their kind._

### People

- [[nour]] — Runs the lab.

### Decisions

### Facts

---

## How to keep this memory

1. Search first.
"""


def make():
    d = Path(tempfile.mkdtemp())
    (d / "MEMORY.md").write_text(INDEX, encoding="utf-8")
    return d, Vault(d)


def test_kind_folders():
    assert kind_folder("person")[0] == "people"
    assert kind_folder("Decision")[0] == "decisions"
    assert kind_folder("trap")[0] == "lessons"
    assert kind_folder(None)[0] == "facts"
    assert kind_folder("nonsense")[0] == "facts"


def test_write_files_by_kind_and_indexes_under_heading():
    d, v = make()
    r = v.write_note("Short lot rule", "Decided on 3 Oct. Because X.", kind="decision")
    assert r["path"] == "memory/decisions/short-lot-rule.md"
    text = (d / r["path"]).read_text()
    assert "type: decision" in text
    idx = (d / "MEMORY.md").read_text().splitlines()
    i = idx.index("### Decisions")
    assert idx[i + 1] == "" and idx[i + 2].startswith("- [[short-lot-rule]]") and idx[i + 3] == ""
    # the How-to section is untouched and nothing landed after it
    assert idx[-1] == "1. Search first."


def test_default_is_facts_and_people_go_first_in_their_section():
    d, v = make()
    assert v.write_note("Port", "The panel listens on 3000.")["path"] == "memory/facts/port.md"
    v.write_note("Omar", "Co-founder.", kind="person")
    idx = (d / "MEMORY.md").read_text().splitlines()
    i = idx.index("### People")
    assert idx[i + 2].startswith("- [[omar]]") and idx[i + 3].startswith("- [[nour]]")


def test_unknown_section_falls_back_to_top_of_index():
    d, v = make()
    v.write_note("Q4 lesson", "Do not X.", kind="lesson")  # no "### Lessons learned" heading
    idx = (d / "MEMORY.md").read_text().splitlines()
    i = idx.index("## Memory index")
    assert idx[i + 2].startswith("_New notes")
    assert any(l.startswith("- [[q4-lesson]]") for l in idx[i:i + 5])


def test_names_unique_across_folders():
    d, v = make()
    v.write_note("Pricing", "A.", kind="decision")
    r = v.write_note("Pricing", "B.", kind="fact")
    assert r["path"] == "memory/facts/pricing-2.md"


def test_old_flat_path_finds_moved_note():
    d, v = make()
    v.write_note("Billing policy", "Net 30.", kind="decision")
    assert v.find_note("memory/billing-policy.md") == (d / "memory/decisions/billing-policy.md").resolve()
    v.update_note("memory/billing-policy.md", "Net 45.")
    assert (d / "memory/decisions/billing-policy.md").read_text() == "Net 45."
    assert not (d / "memory/billing-policy.md").exists()
    # a path that escapes is still refused
    try:
        v.find_note("../x.md")
        assert False
    except ValueError:
        pass


def test_flat_index_without_sections_still_works():
    d = Path(tempfile.mkdtemp())
    (d / "MEMORY.md").write_text("# MEMORY\n\n## Memory index\n\n_One line per fact._\n\n---\n", encoding="utf-8")
    v = Vault(d)
    v.write_note("Thing", "It is.", kind="project")
    lines = (d / "MEMORY.md").read_text().splitlines()
    assert lines[lines.index("## Memory index") + 4].startswith("- [[thing]]")


def test_folder_guides_and_prompt_files_are_not_indexed():
    d, v = make()
    (d / "memory").mkdir(exist_ok=True)
    (d / "memory" / "README.md").write_text("Notes live here.", encoding="utf-8")
    (d / "CLAUDE.md").write_text("You are X.", encoding="utf-8")
    v.write_note("Kept", "A real memory.")
    got = [v.rel(p) for p in v.iter_markdown()]
    assert got == ["memory/facts/kept.md"], got


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
