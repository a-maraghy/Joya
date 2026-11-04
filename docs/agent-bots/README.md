# The bot for the Telegram agents

JOYA AI's core E head (the bot) for the Telegram agents in `agents/`: a profile picture
and three animated stickers per role. They are drawn by the Command Center's own renderer
(`dashboard/public/joya-core-bot.js`), so an agent wears the same bot as the core and the
sessions. Made by `dashboard/tools/make-agent-bots.cjs`.

**Nothing has been applied.** No bot's profile was changed and nothing was sent to Telegram.
Applying them is the administrator's decision; the steps are below.

## The files

One set per role of the session team (the role rule table in `dashboard/public/cc-logic.js`,
`BOT_ROLE_RULES`), plus `core`, the core's default head:

| role | head | for |
|---|---|---|
| `hired` | cap & headphones | sessions / agents JOYA AI hired |
| `planning` | graduation cap | planning |
| `erp` | headset & mic | Odoo / ERP |
| `builder` | twin antennas | Joya, the dashboard, the desktop app, `agents/` |
| `other` | headphones | anything else |
| `core` | cap & headphones | JOYA AI itself |

Per role:

- `avatar-<role>.png` -- 640 x 640, opaque (navy field). Telegram shows profile photos as a
  circle; the head is inside the safe circle.
- `sticker-<role>-ready.webm`, `-thinking.webm`, `-done.webm` -- Telegram **video stickers**:
  512 x 512, VP9 with transparency, 3 s, 30 fps, under 256 KB each. Each head sits on a soft
  dark disc so it reads on light and dark chat backgrounds. *ready* blinks and sways, *thinking*
  shows the brows and the shimmer, *done* grins and hops twice.
- `sticker-<role>-ready.png` -- 512 x 512 still, for a static sticker set.
- `manifest.json` -- the list.

GIF versions (over the dark page colour) for review are in
`mockups/bot-design-upgrades/telegram/` of the shared checkout (not in git).

Suggested agents (change freely): `admin` -> `builder` (the administrator's own agent, works on
Joya), `mavix-bot` -> `erp` or `other` (the group assistant).

## Applying them (when approved)

These steps change what other people see in Telegram; do them only once the administrator
approves.

1. **Copy into `agents/`** (the agents' repo), e.g. `assets/bot-avatars/`, and commit there:
   `cp docs/agent-bots/* agents/assets/bot-avatars/`.
2. **Profile picture** -- a bot's photo is set in Telegram by its owner through **@BotFather**:
   `/setuserpic`, choose the bot, send `avatar-<role>.png` as a photo.
3. **A sticker set** (optional) -- with the bot's own token, the Bot API's
   `createNewStickerSet` (`user_id` = the owner's Telegram id, `name` ending in `_by_<botname>`,
   `stickers` = the three `.webm` files with `format: "video"` and an emoji each, e.g. ready
   🙂, thinking 🤔, done 😄). The set is then added in Telegram from its link
   `t.me/addstickers/<name>`.
4. **Sending them from an agent** (optional, a code change in `agents/`, not made): the bot
   code sends photos and documents only today (`src/claude/file_send.py`); a sticker would be
   `await message.reply_sticker(open(path, "rb"))` (python-telegram-bot), e.g. *done* when a long
   task finishes. A GIF / MP4 goes with `reply_animation`.

## Making them again

    PLAYWRIGHT=/path/to/node_modules/playwright node dashboard/tools/make-agent-bots.cjs [OUT_DIR] [--gif DIR]

It renders with WebGL2 in headless Chromium (SwiftShader is fine) and needs `ffmpeg` with
`libvpx-vp9`. The colours are the Default preset's; the heads follow the renderer, so a change to
the bot's look is picked up by running it again.
