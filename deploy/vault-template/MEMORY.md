# MEMORY

**This file is the long-term memory of {{AGENT_NAME}} and the home page of its
vault. It is injected into the system prompt on every request. Nothing in a
chat session survives a reset — only this file and the notes it points at do.**

---

## CURRENT STATE

_What this agent is for, what is finished, what is still open. Keep it honest and
current: move items from open to done in the same turn you finish them._

Created {{CREATED}}. Nothing recorded yet.

---

## Memory index

_One line per note, under its kind. `memory_write` adds the line itself._

### People

### Projects

### Decisions

### Preferences

### Lessons learned

### Facts

---

## Vault map

| Folder | What is in it |
|---|---|
| `memory/<kind>/` | One durable note per file — [[memory/README\|how notes are kept]] |
| `outbox/<project>/` | Files made and sent; older versions in `outbox/archive/` — [[outbox/README\|outbox]] |
| `drawings/` | Drawings (SVG + PNG); older versions in `drawings/archive/` |
| `chatgpt/<task>/` | What ChatGPT returned, one folder per task |
| `attachments/inbox/<date>/` | What people sent in chat — [[attachments/README\|attachments]] |
| `archive/` | Anything superseded that belongs nowhere else — [[archive/README\|archive]] |
| `WORKLOG.md` | The dated narrative of work done |

---

## How to keep this memory

1. **Search first.** `memory_search` before answering anything that depends on
   earlier work. This index is a table of contents, not the content.
2. **One fact per note,** written with `memory_write` and the right `kind`.
3. **Correct, do not stack.** Fix a wrong note; never add a contradiction.
4. **Archive, never delete.** A replaced file or drawing moves to the
   `archive/` folder beside it.
5. **Log the narrative** in `WORKLOG.md` — one short dated entry per piece of
   work.
