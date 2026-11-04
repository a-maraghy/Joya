---
type: guide
---
# Outbox

Files the agent made and sent (with `send_file`), one folder per project:
`outbox/<project>/`. The current version sits in the project folder; when a
newer version replaces one, the old one moves to `outbox/archive/` (or
`outbox/<project>/archive/`). Nothing is deleted.
