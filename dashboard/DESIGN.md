# Joya — design system: "Plain label"

> The 2026-10-25 redesign (accessible, simple, professional; the leaf logo replaced by
> the word JOYA). Stage 1 built the shell, Telegram agents, JOYA AI Settings and the
> Command Center's chrome; stage 2 (same day) carried it to every page, removed the leaf
> everywhere (lib/marks.js, the seedlings, the marks) and the three old font families
> (Space Grotesk, Inter, JetBrains Mono). Source of truth for values:
> `public/style.css` (tokens) and `public/joya-ds.css` (components). Product truth:
> `PRODUCT.md`.

## Direction contract

- **THESIS.** A working control panel that reads like a well-made printed label: one
  legible typeface, plain words, ink on paper, one green for "this is yours / act here".
  It refuses the category default it came from — near-black, neon joya, glows, glass,
  gradient pills, tracked mono capitals and a leaf.
- **OWN-WORLD.** Tinted paper neutrals (a breath of leaf green in the greys), one
  spearmint-ink accent, state colours that always travel with a word and a shape;
  Atkinson Hyperlegible Next for everything a person reads, its Mono for code and ids;
  flat cards with hairlines, 8–10 px corners, no glow.
- **STORY.** The administrator sees within seconds whether anything needs him (the top
  bar's single sentence), finds every page in one labelled sidebar, and acts with
  controls that look the same everywhere.
- **FIRST VIEWPORT.** Top bar: the wordmark JOYA left, the health sentence and avatar
  right. Sidebar: the machine, then five groups of labelled items, the current one a
  raised white chip. Content: crumbs, a 28 px title, one line of purpose, the primary
  action top right; then the work (a table, a settings group, the core).
- **FORM.** Operate mode; standard web controls only. Signature move: **state as word +
  shape** (● Running, ▲ Failed, ○ Stopped, ◐ Starting) everywhere a status appears, so
  colour only ever repeats what the text already says. The roll (`concept-seed`) could not
  run here (the Impeccable launcher is not allowed on this box): `seed: none (unavailable)`.
- **FINISH.** unreviewed and undocumented is unfinished; this build ends with the finish
  review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Logo

- The logo is the word **JOYA**, set as text: Atkinson Hyperlegible Next 800, 20 px in the
  top bar (32 px on sign-in), tracking +0.16 em, colour `--ink`. No mark, no tag, no
  gradient. Markup: `brand.lockup()` → `<span class="wordmark"><span class="wm-joya">JOYA</span></span>`.
- Sign-in adds one plain line under it ("Operating System").
- Browser-tab icon: an **M monogram**, black on a white rounded square with a black frame;
  white on black in dark mode (the SVG's own `prefers-color-scheme`; the .ico is the light
  one). `tools/make-monogram.cjs` → `public/brand/m/`. The installed app icon (apple-touch,
  manifest, desktop app) stays the core E bot head (`JOYA_APP_ICON=bot`).
- "More: …" — rarely used rows fold into a `<details class="set-more">` at the end of their
  group (`V.more()` in lib/views-settings.js): a 44 px summary, no script needed.

## Colour

**Revision 2026-10-25 (user): bold black and white.** Light mode is pure white, dark mode pure
black; black and white are the main colours and the accent is the ink itself (black primary
buttons on white, white on black). Neutrals are true greys (no green tint). Colour is kept only
for state (ok / warning / failed / info), always with a word and a shape. Links are underlined,
since they no longer differ from text by colour.

Strategy: Restrained — tinted neutrals plus one accent; state colours carry meaning only.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#000000` | page |
| `--panel` | `#FFFFFF` | `#0D0D0D` | cards, inputs, menus |
| `--panel-2` | `#F2F2F2` | `#161616` | sidebar, table heads, hovers |
| `--panel-3` | `#E6E6E6` | `#1F1F1F` | pressed, badges |
| `--line` | `#DEDEDE` | `#2B2B2B` | hairlines between things |
| `--line-strong` | `#757575` | `#8C8C8C` | control edges (≥ 3:1 on page and panel) |
| `--ink` | `#000000` | `#FFFFFF` | headings, values (16–17:1) |
| `--body` | `#1A1A1A` | `#EBEBEB` | running text (≥ 11:1) |
| `--muted` | `#4D4D4D` | `#B8B8B8` | secondary text (≥ 5.9:1 on every ground) |
| `--accent` | `#000000` | `#FFFFFF` | primary action, links, current place, focus |
| `--on-accent` | `#FFFFFF` | `#000000` | text on the accent (21:1 both) |
| `--accent-soft` | `#EDEDED` | `#262626` | selected ground |
| `--ok` / `--warn` / `--bad` / `--info` | `#0A7A3D` / `#8A4B00` / `#C4170C` / `#0B4FB3` | `#4ADE80` / `#FBBF24` / `#FF6B61` / `#7CB0FF` | state text, each with a `-tint` ground and `-line` edge |
| `--violet-ink` | `#5B3FA8` | `#B9A6F2` | JOYA AI's own things (a hired session) |

Every text pair is ≥ 4.5:1 (checked in `tools/test-brand.cjs` against `--bg`, `--panel` and
`--panel-2` in both themes). The JOYA AI cores keep their own colours: they are a product
feature the person chooses, not chrome.

## Type

- `--ui`: "Atkinson Hyperlegible Next" (400, 500, 600, 700, 800), system fallback with
  Noto Sans Arabic for Arabic. `--mono`: "Atkinson Hyperlegible Mono" (400–600) for code,
  ids, slugs, hostnames, clocks. Self-hosted in `public/fonts` (OFL, latin).
- Fixed rem scale, ratio ≈ 1.125–1.25: 13 (`--fs-xs`, tags and table heads only) · 14
  (`--fs-sm`, secondary lines) · **16 (`--fs-md`, body)** · 18 (card titles) · 22 (section
  titles) · 28 (page titles; 24 on phones). Line height 1.5 for text, 1.2–1.3 for titles.
- Sentence case everywhere. No tracked capitals, no monospace as decoration.
- Tabular figures on by default (`font-variant-numeric: tabular-nums`).

## Space, shape, depth

- 4 px grid; content padding 24/32 px desktop, 16 px phone; card padding 20/24 px; gap 16 px.
- Radius: 8 px controls (`--radius`), 10 px cards, groups and menus (`--r`), 999 px pills.
- Depth: cards are flat with a 1 px hairline. Shadows only on things that float (menus,
  toasts, dialogs, the decision card): `--shadow-pop`. No glow, no glass, no gradients.

## Components (public/joya-ds.css)

- **Top bar** 56 px, `--panel`, hairline below: wordmark · (Command Center only: where you
  are) · health sentence · needs-you pill · avatar menu. Framed pages name themselves in
  their own head, so the bar does not repeat it.
- **Sidebar** `--panel-2`; group labels 13 px sentence case; items 40 px (44 on touch),
  icon + label, current item a raised `--panel` chip with an accent icon and
  `aria-current="page"`. Badges carry their sentence for screen readers. Off-canvas
  (phone, Command Center drawer) it is `visibility: hidden` so focus never enters it.
- **Page head**: crumbs (underlined links) · h1 28 px · one line of purpose (70 ch) · actions.
- **Buttons** 40 px (44 on touch; 36 for `.small`): default (panel, strong edge), `primary`
  (accent fill), `danger` (red text and edge; red ground on hover). One primary per view.
- **Forms**: visible label above, 14 px hint under it, 44 px fields with a ≥ 3:1 edge;
  20 px checkboxes inside a 44 px label; the switch is a real checkbox under a 44 × 24 track.
- **Tables** (`.ds-table`): head row on `--panel-2`, 13 px; rows 14 px padding with a hairline;
  numbers right-aligned; a second line in `.sub`. Under 760 px each row becomes a block with
  every value under its column name.
- **State** (`.state`): shape + word in the state colour; never colour alone.
- **Alerts**: tinted ground, matching edge, icon, 16 px text; links underlined.
- **Empty state**: icon tile, a title that says what is missing, one sentence on what to do.
- **Menu** (`.ds-menu`): a `<details>` — works without script, by keyboard and touch.
- **Toasts**: opaque panel, `--shadow-pop`, 16 px, 36 px actions.
- **Focus**: one ring everywhere — 2 px `--focus`, 2 px offset. A skip link is the first stop.
- **Motion**: 160 ms, `cubic-bezier(.2,0,0,1)`, state changes only; reduced motion turns
  transitions off. The core's own motion is the core's.

## Agent avatars

Every Telegram agent wears a small still bot head of JOYA AI's family (2026-10-25, the user: "agents
are no longer plants being planted; every agent gets a random bot avatar based on what it does").
`lib/agent-avatar.js` draws it on the server as an inline SVG from the core E geometry
(`public/joya-core-bot.js` `build()`, every other grid line, plus five agent-only accessories in
`XHEADS`: beret, glasses, magnifier, pencil, tie). Told apart from JOYA AI: a tile with a hairline
frame (`.av`, 40 px in tables, 56 px in the page head, 136 px in Settings), no glow, never the cap.
The head's lines are `--ink`; the face and lit parts are the agent's own hue (`.av-h-<hue>`: a 700
shade on white, a 300 shade on black). Decorative (`aria-hidden`); the name is always beside it.
Theme from the role's keywords → accessory + hue; face, hue, turn seeded by the slug. Stored in
`agent.json` `avatar` (joya-helper `validate_avatar`, `agent-avatar` writes it without a restart);
Settings ▸ Avatar shuffles within the theme and "Use this" keeps it; "Download avatar (PNG)" makes a
640 px PNG in the browser to set by hand in @BotFather. Creating an agent is a plain form ("Create
agent": name, what it does, model, then the channel) — no planting words or pictures anywhere.

## Command Center

The core (A–E, the person's choice) and everything it draws stay as they are. Around it:
opaque panels instead of glass, the rail always visible (44 px buttons, names on hover and
focus), the composer a pill-shaped field modelled on ChatGPT's (2026-10-25: 56 px, radius = half
its height, a fill one step off the page -- `--cc-field`, panel-2 light / panel-3 dark -- and a hairline;
"+" plain, the voice chip quiet text with a chevron, one round ink disc at the end that is the
waveform / send / stop; files as chips above the text; nothing under it at rest; see README "The
composer and attached files"), the caption
in sentence case, the decision card without its coloured edge bar. The desktop app's render
mode (`html.cc-desk`) keeps its own measured layout.
