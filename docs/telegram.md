# Telegram setup

The same walkthrough is built into the panel at `/guide` — read it there when you
are mid-task. This is the reference copy.

---

## 1 · Create a bot

Every agent needs its own bot. Telegram allows exactly one poller per token, so
sharing one between two agents makes both drop messages at random.

1. Message [@BotFather](https://t.me/botfather).
2. `/newbot`
3. Display name — anything, e.g. *Odoo Dev*.
4. Username — must be unique and end in `bot`, e.g. `joya_odoo_dev_bot`.
5. BotFather replies with a token like `8123456789:AAHk9x…`. That line **is** the
   bot.

> The token is a password. Anyone holding it controls the bot and reads
> everything sent to it. Paste it into the create-agent form and nowhere else.
> The panel stores it `0600` and never displays it again. If one leaks,
> `/revoke` in BotFather invalidates it immediately.

Worth setting while you are there:

| Command | Why |
|---|---|
| `/setdescription` | Shown on the bot's empty chat screen |
| `/setuserpic` | Makes agents distinguishable when you run several |
| `/setprivacy` → Disable | Only if the bot will live in a group and should see all messages, not just replies and mentions |

## 2 · Find your user ID

Agents answer a whitelist of numeric IDs and silently ignore everyone else. An
agent with an empty whitelist talks to nobody — that is the safe default.

Message [@userinfobot](https://t.me/userinfobot); it replies with your ID.

## 3 · Create the agent

`Agents → Create agent` in the panel. The field that matters most is **Role**: it
is written into `CLAUDE.md` and loaded on every request. Be specific about what
the agent owns, what it may do unattended, and what it must ask about first.

The panel verifies the token with `getMe` before writing anything — a token
Telegram rejects is the most common reason a new agent is silently dead, and
catching it here costs one API call instead of a trip through the journal.

---

## Groups and topics

Default is a private chat: you and one agent. Group topic mode instead puts the
agent in a forum group where each project gets its own thread — useful when
several people share an agent, or one agent covers several projects.

1. Create a **group** (not a channel).
2. Group Settings → **Topics** → on. This converts it to a forum; without it
   there are no threads to route into.
3. Add the bot to the group.
4. Promote it to **administrator** with **Manage Topics** — it creates and
   renames threads itself.
5. Get the chat ID: forward any group message to
   [@userinfobot](https://t.me/userinfobot). Supergroup IDs start with `-100`.
6. In the channel's **Telegram Topics** card, enable topic routing and paste the ID.

The panel pre-flights all of this before saving — that the chat exists, that it
is a forum, that the bot is an admin with topic rights — and reports every
problem at once rather than one per attempt.

**The General topic** (Topics card → *General goes to*): off by default; pick one
of the projects in the list and the group's General topic is answered in that
project's folder. Only a project of the list, switched on, can be chosen.

**Respond in groups** (channel Settings): *To every message* (the default) or
*Only when asked* — an @mention, a reply to the bot, a command addressed to it,
or one of its names as a word in the text. The names are one per line, at most
10, and default to the agent's name. It applies in every topic of the group;
private chats are always answered.

**New topics get their own folder** (Topics card, off by default): a topic someone
makes in the group gets `topics/<name>` inside the agent's folder, optionally
announced with one line in the topic. The bot keeps these in its own
`projects.auto.json`; the card lists them marked *auto* (edit or switch off, not
remove). When such a topic is deleted, its folder goes to `.trash/topics/` for
the days you choose (0 = deleted at once) or is kept as a folder without a topic.
The card's Trash list can restore a folder or delete it now.
Telegram sends bots no event when a topic is deleted, so the bot checks its
topic folders at start-up, every 10 minutes and on `/sync_threads`, and acts
only after two checks in a row say the topic does not exist: expect the folder
in the trash 10 to 20 minutes after the topic is deleted. Network errors and
missing rights never count.

*Only when asked* and topic folders need the bot to see every message: make it
an admin of the group (Topics already require that), or turn group privacy off.

These options need the agent runtime (agents/) with them in it: update it
with `sudo bash deploy/update-runtime.sh --only <agent>` (or `--no-restart`).

> Group privacy mode is on by default, so the bot only sees messages that mention
> it or reply to it. That is usually what you want in a busy group. To change it:
> BotFather → `/mybots` → the bot → Bot Settings → Group Privacy → Turn off, then
> remove and re-add the bot for it to take effect.

---

## Files into the chat

An agent can make Word (.docx), PDF and Excel (.xlsx) files — and .csv, .txt,
.md and .png — and send them into the chat as documents: ask it ("make this a
PDF and send it"). The file goes to the **same chat and topic** the request
came from (General included), as a reply to it, with a short caption. The
agent cannot choose another chat: the runtime fixes the target from the
message it is answering.

Limits: files from the agent's own folder only (no links out of it), 20 MB
each, 5 per reply. Arabic works in all three formats; PDFs use the Arabic font
on the server (DejaVu Sans today; install `fonts-noto-core` or `fonts-hosny-amiri`
for a nicer one and the agents pick it up).

It is on for every agent. To switch it off for one: the agent's **Settings →
Behaviour → Send files to chat** (`ALLOW_FILE_SEND`; add-ons cannot set it).
Needs the runtime with send_file in it and its document libraries, both
installed by `sudo bash deploy/update-runtime.sh`.

## Images (drawn in code)

Agents make pictures by **drawing them in SVG** — logos, icons, badges, simple
illustrations and scenes — not with an image-generation service. Nothing is
paid per image and no key is involved. Ask it ("draw 4 logo ideas for MAVIX",
"make a flat illustration of a basil field at sunrise").

How it works: the agent writes an SVG in its folder, then calls `render_svg`,
which renders it to PNG on the server (resvg) and **shows Claude the picture**
plus a 32/64 px strip on light and dark, so it can critique its own drawing
and refine it before anything is sent. For several ideas it lays them out on
one **contact sheet** and sends that first. A final logo arrives as the real
`.svg` file plus a PNG preview photo, in the same chat and topic. The system
prompt carries a designer's playbook (concepts → draw → render → critique →
refine; construction, gradients, masks, filters, typography incl. Arabic, a
styles cookbook, palettes). For photo-realistic requests it says plainly that it
draws vector art and offers an illustrated take.

Safety: an SVG is checked before it is rendered or sent — no DOCTYPE/entities,
scripts, event handlers, `<foreignObject>`/HTML, or links/`url()` leaving the
file; only `#id` references and inline PNG/JPEG/GIF/WebP data. Rendering runs in
a child process with memory, CPU and time limits. Limits: renders up to 2048 px,
12 renders per reply, SVGs up to 2 MB; sends count against the 5 files per
reply (an SVG with its preview counts as two). It can also send `.jpg`/`.webp`
pictures, and post PNG/JPG as photos.

Fonts available to drawings are the ones installed on the server (DejaVu,
Liberation, Ubuntu, Quicksand, URW/Nimbus …); Arabic in drawings is shaped
correctly with DejaVu Sans. For final logos the agent prefers lettering drawn
as paths, so they look the same everywhere.

On for every agent. Switch it off per agent in **Settings → Behaviour → Images
(drawn in code)** (`ALLOW_DRAWING`; add-ons cannot set it, nor
`DRAW_MAX_RENDER_PX`, `DRAW_MAX_RENDERS_PER_REPLY`, `SVG_MAX_KB`). It needs **Send
files to chat**: with that off, drawing is off too. Needs the runtime with
`src/claude/drawing.py` and `resvg-py`, both installed by
`sudo bash deploy/update-runtime.sh`.

## Channels

Channels are broadcast, not conversation, and that difference decides how they
can be used here:

- A bot added to a channel as admin **can post** to it.
- Subscribers cannot reply in a way the bot receives, so there is no conversation
  to have. An agent in a channel can talk but never listen.

So use:

| Want | Use |
|---|---|
| A personal agent | Private chat |
| A shared agent, several projects | Group with topics |
| Deploy notices, nightly summaries, CI results | Channel, as an output only |

To make an agent broadcast: add its bot to the channel as an admin with post
rights, and put the channel ID in the agent's role brief. It will post there when
asked while continuing to take instructions from you in private.

---

## Commands in chat

| Command | Effect |
|---|---|
| `/start` | Wake it up, confirm it can hear you |
| `/new` | Fresh session. Clears the conversation, **not** the memory vault |
| `/status` | Session, model, usage |
| `/verbose 0\|1\|2` | How much of its own work it narrates |
| `/repo` | Git status of the working directory |

Voice notes, photos and documents work too.

---

## When it does not answer

| Symptom | Cause |
|---|---|
| Never answers | Your user ID is not in the allowed list, or the unit is not running |
| Unit is `failed` | Bad token, or no Claude credential. The logs say which |
| Answers then goes quiet | Two pollers on one bot token |
| Ignores you in a group | Privacy mode — mention the bot or reply to it |
