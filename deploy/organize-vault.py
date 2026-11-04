#!/usr/bin/env python3
"""Bring an existing agent vault to the organised layout of deploy/vault-template.

    sudo python3 deploy/organize-vault.py <slug> [--plan plan.json] [--dry-run]

What it does (and nothing else):
  * creates the template's folders and folder guides that are missing
    (memory/<kind>/, outbox/archive/, archive/, the README.md guides) -- never
    overwriting a file that exists, except memory/README.md when it is still the
    old two-line template text;
  * files every note directly under memory/ into memory/<kind>/ (kind from the
    plan, else its frontmatter `type`, else facts) and adds `type:` (and `tags:`
    from the plan) to its frontmatter where missing;
  * moves the files the plan lists (superseded versions into an archive/ folder);
    a move never overwrites, and never touches the folders the runtime writes to
    except to create archive/ inside them;
  * rebuilds MEMORY.md's index into "### <Kind>" sections (every existing pointer
    line is kept, moved under its note's kind) and adds the vault map, keeping
    CURRENT STATE and anything else as it is;
  * replaces the generic "## Your memory" section of CLAUDE.md with the template's
    "## Your memory and your vault" (the role / persona sections are not touched);
  * adds keys to .obsidian/app.json that are not set (existing settings win);
  * appends a dated WORKLOG.md entry, and gives the tree back to the agent account
    with the helper's own chown_tree.

The vector index has to be rebuilt afterwards (joya-helper agent-memory-index <slug> --force).
Back the vault up first; the script refuses to run without --backup-ok unless --dry-run.

The plan (JSON): {"kinds": {"<note file name>": "decision", ...},
                  "tags": {"<note file name>": ["a", "b"]},
                  "moves": [["outbox/x.svg", "outbox/archive/2026-10-03-logo/x.svg"], ...],
                  "vault_map_extra": [["`mail/ledger.md`", "The mail ledger, kept by the agent"]],
                  "worklog": "extra sentence"}
"""
import argparse
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "vault-template")
HELPER = os.path.join(HERE, "..", "dashboard", "deploy", "joya-helper")
AGENTS = "/opt/joya-agents/agents"
KIND_FOLDERS = ["people", "projects", "decisions", "preferences", "lessons", "facts"]
KIND_HEADINGS = {"people": "People", "projects": "Projects", "decisions": "Decisions",
                 "preferences": "Preferences", "lessons": "Lessons learned", "facts": "Facts"}
KIND_OF = {"person": "people", "people": "people", "project": "projects", "projects": "projects",
           "decision": "decisions", "decisions": "decisions", "preference": "preferences",
           "preferences": "preferences", "lesson": "lessons", "lessons": "lessons", "trap": "lessons",
           "fact": "facts", "facts": "facts"}
TYPE_OF = {"people": "person", "projects": "project", "decisions": "decision",
           "preferences": "preference", "lessons": "lesson", "facts": "fact"}
OLD_MEMORY_README = "Notes live here: one durable fact per file, linked with [[wikilinks]]."
FRONT_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*\n", re.S)
POINTER_RE = re.compile(r"^\s*-\s+\[\[([^\]|#]+)")

log = []


def say(msg):
    log.append(msg)
    print(msg)


def load_helper():
    spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", HELPER))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def write(p, text, dry):
    if dry:
        return
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".organize-tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, p)


def section(text, heading):
    """(start, end) of '## heading' up to the next '## ' heading or a '---' rule before it."""
    m = re.search(r"^## " + re.escape(heading) + r"[^\n]*\n", text, re.M)
    if not m:
        return None
    nxt = re.search(r"^## ", text[m.end():], re.M)
    end = m.end() + nxt.start() if nxt else len(text)
    return m.start(), end


def frontmatter_set(text, key, value):
    m = FRONT_RE.match(text)
    line = key + ": " + value
    if not m:
        return "---\n" + line + "\n---\n\n" + text
    body = m.group(1)
    if re.search(r"^" + re.escape(key) + r"\s*:", body, re.M):
        return text
    return "---\n" + body + "\n" + line + "\n---\n" + text[m.end():]


def frontmatter_get(text, key):
    m = FRONT_RE.match(text)
    if not m:
        return None
    k = re.search(r"^" + re.escape(key) + r"\s*:\s*(.*)$", m.group(1), re.M)
    return k.group(1).strip().strip("'\"") if k else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--plan")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backup-ok", action="store_true", help="the vault has been backed up")
    ap.add_argument("--root", default=AGENTS, help="agents directory (tests point it at a copy)")
    a = ap.parse_args()
    dry = a.dry_run
    if not dry and not a.backup_ok:
        sys.exit("back the vault up first, then pass --backup-ok")
    if not re.match(r"^[a-z][a-z0-9-]{1,30}$", a.slug):
        sys.exit("bad slug")
    vault = os.path.join(a.root, a.slug, "vault")
    if not os.path.isdir(vault):
        sys.exit("no vault at " + vault)
    plan = json.load(open(a.plan)) if a.plan else {}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    agent_name = a.slug
    try:
        agent_name = json.load(open(os.path.join(a.root, a.slug, "agent.json"))).get("name") or a.slug
    except Exception:
        pass

    # 1. Folders and folder guides from the template.
    for dirpath, dirnames, filenames in os.walk(TEMPLATE):
        rel = os.path.relpath(dirpath, TEMPLATE)
        if rel.startswith(".obsidian"):
            continue
        target_dir = os.path.normpath(os.path.join(vault, rel))
        if not os.path.isdir(target_dir):
            say("mkdir   " + os.path.relpath(target_dir, vault))
            if not dry:
                os.makedirs(target_dir, exist_ok=True)
        for f in filenames:
            if rel == "." or f in ("CLAUDE.md", "MEMORY.md", "WORKLOG.md"):
                continue
            src, dst = os.path.join(dirpath, f), os.path.join(target_dir, f)
            replace_old = (os.path.relpath(dst, vault) == "memory/README.md" and os.path.exists(dst)
                           and read(dst).strip().startswith(OLD_MEMORY_README))
            if not os.path.exists(dst) or replace_old:
                say(("update  " if replace_old else "add     ") + os.path.relpath(dst, vault))
                if not dry:
                    shutil.copy2(src, dst)

    # 2. File the flat memory notes by kind.
    kinds = plan.get("kinds", {})
    tags = plan.get("tags", {})
    note_kind = {}
    mem = os.path.join(vault, "memory")
    for f in sorted(os.listdir(mem)) if os.path.isdir(mem) else []:
        p = os.path.join(mem, f)
        if not f.endswith(".md") or f == "README.md" or not os.path.isfile(p):
            continue
        text = read(p)
        k = KIND_OF.get(str(kinds.get(f) or frontmatter_get(text, "type") or "fact").lower(), "facts")
        note_kind[f[:-3]] = k
        new = frontmatter_set(text, "type", TYPE_OF[k])
        if f in tags and not frontmatter_get(new, "tags"):
            new = frontmatter_set(new, "tags", "[" + ", ".join(tags[f]) + "]")
        dst = os.path.join(mem, k, f)
        if os.path.exists(dst):
            say("SKIP    memory/" + f + " (memory/" + k + "/" + f + " exists)")
            continue
        say("file    memory/" + f + " -> memory/" + k + "/" + f)
        if not dry:
            write(p, new, dry)
            os.replace(p, dst)
    # notes already in kind folders count for the index too
    for k in KIND_FOLDERS:
        d = os.path.join(mem, k)
        for f in os.listdir(d) if os.path.isdir(d) else []:
            if f.endswith(".md"):
                note_kind.setdefault(f[:-3], k)

    # 3. Planned moves (superseded versions to an archive folder).
    for src_rel, dst_rel in plan.get("moves", []):
        src, dst = os.path.join(vault, src_rel), os.path.join(vault, dst_rel)
        for p in (src, dst):
            if os.path.commonpath([os.path.realpath(os.path.dirname(p)), os.path.realpath(vault)]) != os.path.realpath(vault):
                sys.exit("move outside the vault: " + src_rel + " -> " + dst_rel)
        if not os.path.exists(src):
            say("SKIP    " + src_rel + " (gone)")
            continue
        if os.path.exists(dst):
            say("SKIP    " + src_rel + " (" + dst_rel + " exists)")
            continue
        say("move    " + src_rel + " -> " + dst_rel)
        if not dry:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.replace(src, dst)
    for note in plan.get("notes", []):  # new hub notes, never overwriting
        p = os.path.join(vault, note["path"])
        if os.path.exists(p):
            say("SKIP    " + note["path"] + " (exists)")
            continue
        say("add     " + note["path"])
        write(p, note["content"], dry)
        m = re.match(r"memory/([^/]+)/([^/]+)\.md$", note["path"])
        if m:
            note_kind[m.group(2)] = m.group(1)

    # 4. MEMORY.md: the index by kind, the vault map, the template's how-to.
    tpl = read(os.path.join(TEMPLATE, "MEMORY.md")).replace("{{AGENT_NAME}}", agent_name)
    mpath = os.path.join(vault, "MEMORY.md")
    text = read(mpath)
    idx = section(text, "Memory index")
    if idx:
        old = text[idx[0]:idx[1]]
        pointers = {}
        order = []
        for line in old.splitlines():
            m = POINTER_RE.match(line)
            if m:
                key = m.group(1).strip()
                if key not in pointers:
                    order.append(key)
                pointers.setdefault(key, line.rstrip())
        for extra in plan.get("index_lines", []):
            m = POINTER_RE.match(extra)
            if m and m.group(1) not in pointers:
                order.insert(0, m.group(1))
                pointers[m.group(1)] = extra
        by_kind = {k: [] for k in KIND_FOLDERS}
        for key in order:
            by_kind[note_kind.get(key, "facts")].append(pointers[key])
        rule = "\n---\n\n" if old.rstrip().endswith("---") else ""
        new_idx = "## Memory index\n\n_One line per note, under its kind. `memory_write` adds the line itself._\n\n"
        for k in KIND_FOLDERS:
            new_idx += "### " + KIND_HEADINGS[k] + "\n\n" + ("\n".join(by_kind[k]) + "\n\n" if by_kind[k] else "")
        new_idx = new_idx.rstrip() + "\n\n---\n\n"
        text = text[:idx[0]] + new_idx + text[idx[1]:].lstrip("-\n ")
        del rule
    vm = section(tpl, "Vault map")
    vault_map = tpl[vm[0]:vm[1]].rstrip().rstrip("-").rstrip() + "\n"
    for path_cell, what in plan.get("vault_map_extra", []):
        vault_map = vault_map.replace("| `WORKLOG.md` |", "| " + path_cell + " | " + what + " |\n| `WORKLOG.md` |")
    have = section(text, "Vault map")
    if have:
        text = text[:have[0]] + vault_map + "\n---\n\n" + text[have[1]:].lstrip("-\n ")
    else:
        how = section(text, "How to keep this memory")
        at = how[0] if how else len(text)
        text = text[:at] + vault_map + "\n---\n\n" + text[at:]
    how_t = section(tpl, "How to keep this memory")
    how = section(text, "How to keep this memory")
    if how and how_t:
        text = text[:how[0]] + tpl[how_t[0]:how_t[1]] + text[how[1]:]
    text = text.replace("**This file is the long-term memory of " + agent_name + ". It is injected into the\nsystem prompt on every request.",
                        "**This file is the long-term memory of " + agent_name + " and the home page of its\nvault. It is injected into the system prompt on every request.")
    text = re.sub(r"\n{3,}", "\n\n", text)
    say("rewrite MEMORY.md (index by kind, vault map)")
    write(mpath, text, dry)

    # 5. CLAUDE.md: the memory section only.
    cpath = os.path.join(vault, "CLAUDE.md")
    ctext = read(cpath)
    tsec = section(read(os.path.join(TEMPLATE, "CLAUDE.md")), "Your memory and your vault")
    tcl = read(os.path.join(TEMPLATE, "CLAUDE.md"))
    new_sec = tcl[tsec[0]:tsec[1]]
    s_old = section(ctext, "Your memory and your vault") or section(ctext, "Your memory")
    if s_old:
        ctext = ctext[:s_old[0]] + new_sec + ctext[s_old[1]:]
        say("rewrite CLAUDE.md (## Your memory -> ## Your memory and your vault)")
        write(cpath, ctext, dry)
    else:
        say("SKIP    CLAUDE.md has no '## Your memory' section")

    # 6. Obsidian: add settings that are not set.
    app = os.path.join(vault, ".obsidian", "app.json")
    if os.path.exists(app):
        cur = json.load(open(app))
        tpl_app = json.load(open(os.path.join(TEMPLATE, ".obsidian", "app.json")))
        added = [k for k in tpl_app if k not in cur]
        if added:
            for k in added:
                cur[k] = tpl_app[k]
            say("obsidian app.json + " + ", ".join(added))
            write(app, json.dumps(cur, indent=2) + "\n", dry)

    # 7. Work log.
    wpath = os.path.join(vault, "WORKLOG.md")
    entry = ("\n## " + today + "\n\nVault organised (by the administrator, with Claude Code): memory notes filed "
             "by kind under memory/<kind>/, MEMORY.md index by kind plus a vault map, folder guides "
             "(README.md) added, superseded versions moved to archive/ folders. Nothing deleted. "
             + plan.get("worklog", "")).rstrip() + "\n"
    say("append  WORKLOG.md")
    if not dry:
        write(wpath, read(wpath).rstrip() + "\n" + entry, dry)

    # 8. Ownership, as the helper gives it.
    if not dry:
        h = load_helper()
        uid, gid = h.agent_ids()
        h.chown_tree(vault, uid, gid)
        say("chown_tree " + vault)
    print(json.dumps({"slug": a.slug, "dry_run": dry, "steps": len(log)}))


if __name__ == "__main__":
    main()
