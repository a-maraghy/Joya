---
type: guide
---
# Memory notes

One durable fact per file, linked with [[wikilinks]], filed by kind:

| Folder | Kind | Example |
|---|---|---|
| `people/` | person | who someone is, how to reach them, what they care about |
| `projects/` | project | a piece of work: goal, status, links to its decisions and files |
| `decisions/` | decision | what was decided, when, by whom, and why |
| `preferences/` | preference | how someone wants things done |
| `lessons/` | lesson | a gotcha and its fix |
| `facts/` | fact | everything else worth keeping |

Each note starts with frontmatter (`title`, `type`, `created`, `tags`) and has a
pointer line in [[MEMORY]] under its kind. `memory_write(..., kind=...)` does
both. A note that is wrong is corrected, not contradicted.
