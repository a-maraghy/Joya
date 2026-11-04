# Living canvas: JOYA AI arranges the Command Center (design note, 2026-10-20)

The Command Center used to be a fixed page. Now it is a **board** that JOYA AI lays out moment to moment.
The bot core stays the hero at the centre, and the session spheres and the map keep working round it.
Next to the core sit the standing tiles, the widgets the person pinned, and the widgets JOYA AI just
offered with an answer.

Screenshots and GIFs are in `mockups/living-canvas/`:
- the three moments: `calm-*`, `morning-*`, `failure-*` and `waiting-dark`;
- a widget answer being pinned: `widget-pinned.gif`, `answer-widget-dark` and `pinned-board-dark`;
- Fix it: `failure-fixit.gif` and `failure-fixit-dark`;
- the other block types: `widgets-gallery-dark`;
- the conversation keeping them: `conversation-history-light`;
- the lock: `locked-light`;
- learning: `learned-standing-dark` and `settings-board-light`;
- the phone: `phone-*`;
- the desktop app: `desktop-shell-*` and `desktop-floating-dark`.

## 1. Answers as widgets

When JOYA AI answers a request sent from the Command Center, it can add a small live widget with its
**MCP tool `ui_widget`**. The path is the one `ui_do` already uses to drive the page:

1. **Tool.** `bin/joya-ai-mcp` exposes `ui_widget`. Its schema is frozen to one object field, so a
   resumed CLI never holds a stale schema. The tool also checks the widget itself first.
2. **Supervisor op.** The tool calls the supervisor op `ui-widget`. `lib/protocol.js` checks the widget
   again. The supervisor's `uiWidget` then applies the same terms as `ui-action`:
   - actor `joya-ai` only;
   - only during a turn the administrator started from the Command Center, which carries a one-time UI
     token;
   - at most 3 widgets a turn, counted toward the screen actions' per-minute limit;
   - live only: never kept in the ring buffer or the ledger;
   - the event carries a tag of the token, never the token itself.
3. **Dashboard.** `server.js` passes the event to `uiWidgetDeliver`:
   - the ui relay picks the one tab that asked;
   - the person's switch for screen actions applies;
   - the widget is checked again;
   - `routes-canvas.offer` declines a kind this person always dismisses, and JOYA AI is told to answer in
     words.
4. **Page.** `joya-ai.js` passes `widget.show` to `JoyaCanvas.offer`, which checks the widget once more,
   draws it and acknowledges it.

The widget appears **beside the reply**, in the centre slot under the core, marked "From JOYA AI's
answer · time · live". The core shrinks a little to make room; cc-map takes its size from the stage. The
widget's header has three controls:
- **Pin** keeps it on the board. The server stores it, so it survives a reload.
- **S / M / L** cycles its size.
- **×** dismisses it.

**The conversation keeps them (user, 2026-10-20).** A widget the tab showed is stored with its reply,
in the supervisor's ledger, which is where the conversation itself is kept:
- `turns.widgets` is a JSON list of `{ id, at, widget }`, at most 3 per turn, each ≤ 12,000 bytes;
- a widget that was refused or that no screen answered is not stored.

The turn then goes out to every viewer as a `turn` event (phase `widget`), and it comes back with the
turn on every load (`ledger turns`, `publicTurn`). Each widget is checked again on the way out by the
supervisor's `turnWidgets` and once more on the page.

The Conversation shows it under its reply, marked "Shown with this reply · time":
- after a reload, and in other tabs and on other devices;
- live sources refresh as usual;
- **Pin** puts it on the board.

Old history is history: a kind that has since stopped being offered is still shown there. The board
offers nothing again after a reload; pinned widgets stay on it.

The approval kind is the existing decision card, never a new approval path. The widget names only the
approval's id, so its text comes from the real approval. It has three buttons:
- **Review** opens `#cc-need`.
- **Approve** and **Deny** call the same functions the desktop glance cards use (`__joyaCC.approve` and
  `__joyaCC.decide`), with the usual step-up.

## 2. The block catalog (version 1)

The catalog lives in `public/joya-widgets.js`. That one pure file runs on:
- the supervisor, as a byte-for-byte copy in `joya-ai/lib/joya-widgets.js` (a test checks they match);
- the dashboard;
- the page.

JOYA AI reads the catalog at run time with the tool `ui_widgets_list`.

A widget has this shape:

```
{ v: 1, kind, title (<= 80), note? (<= 200), source? {name, params}, size? s|m|l, blocks: [1-6] }
```

### Kinds

The kind is also the first half of the learning key.

| kind | first block | what it is |
|---|---|---|
| `chart` | chart | spend, tokens, any series |
| `files` | files | files touched, + / − lines (a diff summary) |
| `table` | table | a table |
| `approval` | approval | a waiting approval, opening the decision card |
| `compare` | compare | two sessions side by side |
| `story` | story | a session's story card |
| `metric` | metric | one figure |
| `list` | list | a short list |

### Blocks

Data either comes in the payload, within the limits below, or is a `{type, view}` that reads the widget's
source.

| block | payload fields | takes a view |
|---|---|---|
| `text` | `text` ≤ 500, `tone` | no |
| `metric` | `label` ≤ 40, `value` (a number, or text ≤ 24), `unit` (usd / tokens / count / pct / minutes), `hint` ≤ 80, `tone` | yes |
| `chart` | `style` (bar / line), `unit`, `series` (≤ 3, each with ≤ 60 `[x ≤ 16, y]` points) | yes |
| `table` | `columns` (≤ 8, each `{key, label, align, format}`), `rows` (≤ 50, cells ≤ 120) | yes |
| `list` | `items` (≤ 20, each `{text ≤ 160, sub ≤ 120, tone, session?}`) | yes |
| `files` | `files` (≤ 50, each `{path ≤ 240, add, del}`) | yes |
| `story` | `session` (uuid): the text is read from the story source | no |
| `compare` | `sessions` (2 uuids): read from the story source | no |
| `approval` | `approval` (an id): read from the page's live approvals | no |

### Sources

Every source is read-only and is already served to the Command Center.

| source | read from | views |
|---|---|---|
| `usage.spend` | `GET /joya-ai/api/cost` | `days` (chart), `today` (metric), `sessions` (table), `top` (list) |
| `usage.caps` | `GET /joya-ai/api/caps` | `tokens` (metric), `tightest` (metric), `sessions` (table), `chart` (chart) |
| `sessions` {state} | the page's live sessions | `list`, `table`, `working`, `waiting` |
| `story` {session} | `GET /joya-ai/api/sessions/:id/story` | `files`, `tokens`, `active`, `steps`, `handoffs` |
| `feed` | the page's event log | `alerts`, `recent` |
| `approvals` | the page's live approvals | `pending`, `count` |

Fetched sources refresh every 30 s while they are on screen. The page's own state refreshes on every tick.

### Never

A widget never carries any of these:
- **HTML, script, style or a URL.** No field takes one, and an unknown field is an error. Text holding a
  scheme (`x://`, `javascript:`, `data:x/`, `file:/`) or a `<` followed by a letter or `/` is refused.
  Comparisons such as `a < b` are allowed.
- **More than 12,000 bytes** of JSON.

The page builds every block with `createElement` and `textContent`, and charts are SVG built node by
node. A test checks that `joya-canvas.js` has no `innerHTML`, `eval`, `href` or `src`.

## 3. The layout follows the moment

`public/joya-canvas-policy.js` is pure and tested. Its `plan(facts)` picks the mode, most urgent first:

| mode | when | what the board shows |
|---|---|---|
| incident | a delegation to a session **failed or was held** in the last 2 h, or a session has **waited on you 10 min or more** | That session's card is the hero: in the centre, large, with its error, **Fix it** and its story. Everything else steps down to S. Further incidents show as small cards on the right. |
| brief | the **morning brief** is fresh: under 3 h old, between 05:00 and 12:00 in the person's brief time zone. A catch-up counts too, for 30 min at any hour. | The brief card (JoyaProactive's own, still updated by it) moves into the centre. |
| board | there are pinned or offered widgets | Each keeps its size. Pins go in the left column (4 to a column, then the right). An answer goes in the centre. |
| calm | nothing at all | The core and three quiet tiles: Spend today, Sessions, Approvals. They are small and dim, and brighter on hover. |

**Fix it** sends JOYA AI an ordinary request through the composer's own `send` (`POST /api/send` with a
UI token). It never acts directly. First it shows the text it will send, with Send, Edit first and
Cancel. The text asks JOYA AI to find the cause and delegate the fix, and to ask before anything
destructive.

**×** on the hero puts that incident away (remembered in this browser). A new failure, or a new wait, is
a new incident.

**Motion.** Cards move with a FLIP animation (320 ms). While the centre slot changes height, the core
follows frame by frame. With reduced motion nothing animates. The spheres keep clear of every card,
which carries `data-cc-obstacle`.

**Lock.** The pill at the bottom left (also in Settings ▸ Appearance ▸ Board) keeps the arrangement as
it is: no hero grows and sizes stay. What would have changed the board shows as a badge ("1 needs you")
that opens the session.

## 4. It learns what you keep

`lib/canvas-store.js` adds three tables of its own to the panel database:
- `canvas_pins`;
- `canvas_stats`, with counts per person and **widget key**. The key is the kind plus where the data
  comes from, e.g. `chart:usage.spend`, `table:payload` or `story:story`. Each row counts how often that
  key was offered, pinned, dismissed and opened, plus the last widget pinned under it;
- `canvas_prefs`, holding the lock and learning on or off.

`JoyaCanvasPolicy.learn()` turns the counts into verdicts:
- **Standing tile:** pinned at least 3 times, and at least twice as often as it was dismissed. It is
  drawn from the last widget of that key pinned, and it replaces the default quiet tiles.
- **Not offered:** dismissed at least 3 times, and never pinned or opened. The dashboard declines it,
  and JOYA AI is told to answer in words.

Unpinning is tidying the board, so it is not counted as a dismissal.

**Settings ▸ Appearance ▸ Board** has these controls:
- the lock;
- **Learn from what I keep** (with it off, nothing is counted and no verdict applies);
- the table of counts, each row with its verdict;
- **Reset**, after a confirm (it forgets the counts and keeps the pins).

## 5. Desktop app (`?shell=desktop`)

- **Desktop layer and Peek.** The board is one column beside the core, on the side opposite the glance
  cards and below the decision card. In **Floating**, widgets go in the headroom above the box, where
  the decision card would be, and step back while that card or focus mode is up.
- **No quiet tiles while the glance cards are on.** The glance cards already show sessions, tokens and
  approvals.
- **No brief mode in the app.** The morning brief stays the first glance card (`joya-desktop.js`), so
  the board never takes it to the centre or shows it twice: `joya-canvas.js` passes no brief to the
  policy when `DESK`. When the brief and the day's cards are taller than the column, the column scrolls.
  A card cut at the column's edge catches the mouse only where it shows, and it gets no blur
  (fixed 2026-10-21).
- **Tests are hour-proof.** A scratch server writes no scheduled brief (`tools/scratch-server.cjs`,
  `scheduledBriefs` / `JOYA_SCRATCH_BRIEFS`: `off` by default, or `due` or `real`). Before this, every
  suite run between 08:00 and 14:00 Cairo got a real brief on the server's first look.
- **`joya-desktop.js` has two additive lines.**
  - `HIT` gains `#cv-board:not(.cv-under) .cv-w`, so each card catches the mouse and the gaps let clicks
    through.
  - `GLASS` gains the cards as `card`, and an approval widget as `alert`.
- **Blur.** It follows only once a card holds still (`JoyaDesktopLayout.glass`, 80 ms), so cards animate
  first and blur after.
- **No native work was needed**, and `desktop/src-tauri` is untouched.
- **Locking in the app.** The app hides the lock pill (`.cv-ctl`), so there the lock is set from
  Settings.

## 6. Files

**New**
- `dashboard/public/`: `joya-widgets.js`, `joya-canvas-policy.js`, `joya-canvas.js`, `joya-canvas.css`
- `dashboard/lib/`: `canvas-store.js`, `routes-canvas.js`
- `joya-ai/lib/joya-widgets.js` (the copy)
- `dashboard/tools/`: `canvas-fake-supervisor.cjs` and four suites, `test-canvas-widgets.cjs`,
  `test-canvas-policy.cjs`, `test-canvas-store.cjs` and `test-living-canvas.cjs`
- `joya-ai/tools/test-ui-widget.cjs`

**Small, additive edits**
- `server.js`: the mount and `uiWidgetDeliver`.
- `views-joyaai.js`: the asset lists.
  - Browser: the new assets plus `joya-desktop-glance.js` go before `ui-actions.js`. The list still keeps
    `"ui-actions.js", "joya-ai.js"` together and ends with `"joya-ai.js", "joya-dock.js", "joya-shell.js"`.
  - Desktop: the new assets go before `joya-desktop.js`.
- `joya-ai.js`: the hand-off of `widget.show`, and `paintTurn` handing a turn's widgets to
  `JoyaCanvas.history`.
- `joya-desktop.js`: `HIT` and `GLASS`.
- `joya-ai/lib/protocol.js`: the op.
- `joya-ai/supervisor.js`: `uiWidget` (stores a shown widget with its turn), `turnWidgets` (re-validates
  on the way out, in `publicTurn` and the `turns` ledger rows), plus the audit summary of a widget.
- `joya-ai/lib/ledger.js`: the column `turns.widgets`, added by the existing migration.
- `joya-ai/bin/joya-ai-mcp`: the two tools.
- `joya-ai/home/CLAUDE.md`: the charter's widget rule.

**Deploy**
- **joya-ai needs a restart** for the new op and tools.
- JOYA AI's CLI discovers `ui_widget` and `ui_widgets_list` on its next start.
