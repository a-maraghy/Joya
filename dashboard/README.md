# Dashboard

The web panel. Node, server-rendered HTML, no client framework, no external
assets — the CSP blocks them, and a panel that can grant SSH access is the last
place to be pulling scripts off a CDN.

Architecture, security model and deployment: see the [repository README](../README.md)
and [docs/agents.md](../docs/agents.md).

## Layout

    server.js              routes, auth, sessions, CSRF
    lib/db.js              SQLite: admin account, pairing codes, devices, login log
    lib/priv.js            wrapper that shells out to the privileged helper
    lib/ui.js              shared page chrome and formatting
    lib/views.js           system pages (overview, keys, devices, audit)
    lib/views-agents.js    agent management pages
    lib/views-guide.js     the operator's manual, served from the panel
    lib/views-claude.js    Claude Code: memory, sessions, running processes
    lib/joyaai.js          client for the JOYA AI supervisor's unix socket
    lib/views-joyaai.js    the JOYA AI Command Center's frame
    lib/telegram.js        Bot API client, used only to validate configuration
    public/style.css       styles, and the light and dark palettes
    public/app.js          confirmations + live stat refresh + Running refresh + theme switch
    public/theme-init.js   applies the saved theme before first paint
    public/joya-ai.css     the Command Center's styles and HUD palette
    public/joya-ai.js      the Command Center: API, event stream, seed core, voice
    tools/test-*.cjs       standalone tests (node tools/test-claude.cjs)
    tools/make-monogram.cjs  the browser-tab icon: the letter M, black on white (white on
                           black in dark mode), public/brand/m/; --raster writes the .ico
    tools/make-bot-icon.cjs  the installed app icon (the bot head, JOYA_APP_ICON=bot):
                           apple-touch and manifest PNGs; tools/make-app-icon.cjs the older
                           "Mesh" set (kept as the fallback); ui.iconLinks() links them

    deploy/joya-helper             privileged helper -> /usr/local/sbin/
    deploy/joya-agent@.service     systemd template, one instance per agent
    deploy/joya-dashboard.service  systemd unit for this panel
    deploy/nginx-joya.conf         nginx site
    deploy/joya-proxy-params       shared proxy headers
    deploy/joya-sudoers            the single-command sudo rule
    deploy/fail2ban-*.conf         filter and jail

## Deploying a change

    sudo bash /opt/joya/deploy/deploy-dashboard.sh

It syntax-checks every file before restarting. Doing it by hand instead, always
`node --check` first — a syntax error otherwise leaves the service in a restart
loop with the panel down.

## Computers (laptop control, Path A, 2026-10-08)

Joya ▸ JOYA AI ▸ **Computers** (`/machines`, `joyaai.use`): the user's own Windows computers,
linked through the JOYA AI desktop app. `lib/machines.js` (store, pairing, the link, leases,
action log), `lib/routes-machines.js` (routes + the WebSocket upgrade), `lib/views-machines.js`,
`public/machines.{js,css}`; the supervisor's half is `joya-ai/lib/machines.js` (+ `machine-gate.js`).

- **Pairing:** "Pair a computer" → a one-time code (Crockford base32, `ABCD-EFGH`, 10 min, one per
  person, in memory). The app posts it to `POST /machines/api/claim` `{code, name, platform,
  app_version}` → `{machine_id, name, token}` (`mmt_` + 32 random bytes; only its SHA-256 is stored).
  The app keeps the token in Windows Credential Manager. Rename / Revoke on the page; Revoke closes
  the link and ends any lease.
- **Link:** `wss://…/machines/api/link`, `Authorization: Bearer <token>` (401 otherwise), one per
  computer (a newer link replaces the older), pings every 10 s, 2 MB frames. Wire contract in
  `desktop/README.md` ("Laptop control"). Relayed to the supervisor as actor `machine.<id>`; the
  registry is pushed with `machines-sync` (actor `machines`); the supervisor's `machine` events
  (start / tell / stop) arrive through one standing subscription.
- **Lease:** created when the supervisor's `start` arrives (default 15 min, ≤ 60 min from now);
  extended (+15, capped) here or from the app's pill; ended here on timeout (+15 s grace, app told to
  stop), Stop, revoke, the app's report (stop hotkey, lock, sign-out, link lost, runner exit). The app
  enforces it too.
- **Action log:** every action with a JPEG screenshot (magic-checked, ≤ 1.5 MB, 0600) in
  `JOYA_MACHINES_DIR` (default `<data dir>/machines/<id>/`), rows in `machine_actions`; kept **7 days**
  (hourly prune deletes row and file). Screenshots: `/machines/shot/<id>`, signed in, `no-store`.
- **DB:** three new tables in `joya.db` (`machines`, `machine_leases`, `machine_actions`), created on
  start (`CREATE TABLE IF NOT EXISTS`); nothing else changes.
- Tests: `NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-machines.cjs`.

## Passkeys (Windows Hello)

The sign-in's second step can be a passkey instead of the authenticator code
(`lib/passkeys.js`, `@simplewebauthn/server`; the browser half is
`public/simplewebauthn-browser.js`, the library's own bundle, vendored because
the CSP allows no CDN, and `public/passkey.js`). The code stays enrolled and is
offered on every sign-in; root unlock still asks for it, and it is the fallback
for approvals (below).

- **Account ▸ Passkeys**: add this device (needs a code unless you signed in
  within 5 minutes), rename, remove. Table `passkeys` (+ `passkey_handles`, the
  per-account WebAuthn user handle) in `joya.db`, created at start.
- **Sign-in**: on a browser that has used a passkey here, the form hides the code
  field and sends `second=passkey`; `/login/verify` then starts Windows Hello, with
  "Use authenticator code instead" beside it. The second step looks the same for a
  right password, a wrong one and an unknown user (the request names no
  credentials), so it cannot be used to test a password; every failure ends in
  "Invalid credentials". Challenges are single-use (checked against an in-memory
  set, so two concurrent answers cannot both pass), expire after 2 minutes, and a
  pending sign-in dies after 5 minutes or 5 failures. Sign counters must go up.
- **Addresses**: a passkey belongs to one domain. `JOYA_PASSKEY_ORIGINS`
  (comma-separated origins) is the allow-list; default
  `https://joya.example.com,https://joya.example.com:8443`. The RP is
  chosen from the raw `Host` header (never `X-Forwarded-Host`); any other host gets
  no passkeys and the old form.
- An administrator's **Reset two-factor** removes the user's passkeys too.
- Test: `tools/test-passkeys.cjs` (Chromium's virtual authenticator; set
  `PLAYWRIGHT=` to a playwright module).

### Windows Hello for every approval (2026-10-08)

Every decision that lets something run needs a fresh passkey assertion with
user verification from the signed-in user, or -- where no passkey can be used
(an address off the allow-list, a passkey kept in Google Password Manager that
WebView2 cannot see, Hello cancelled or failing) -- a fresh authenticator code.
The server enforces it (`lib/stepup.js`, `requireStepUp(spec)`); the page only
helps. Deny, Keep, Dismiss, Ask more, Skip never ask. There is no setting that
turns it off.

- **Routes wrapped** (server.js): `POST /joya-ai/api/approvals/:id/approve`
  (Approve once and Always allow this, every card: JOYA AI's, a hired or machine
  session's `origin: session:<slug>`, a retire consent), `/joya-ai/api/decisions/:id/approve`
  (Apply fix, Retire) and `/resume`, `/joya-ai/api/rules` (a new **allow** rule;
  deny/ask rules pass), `/joya-ai/api/rules/:id` and `/:id/delete` (any change),
  `/joya-ai/api/sessions/:slug/retire`, the forms `/claude/sessions/live/:slug/retire`,
  `/claude/sessions/live/resume`, `/joya-ai/settings/usage/resume`
  (lib/routes-settings.js), and the hidden console's `/console/:id/permission` Allow.
- **Protocol**: a request without proof gets **428** `{code: "step-up", step_up}`:
  `step_up.passkey` = options for `navigator.credentials.get()` naming the user's
  passkeys for this host (`userVerification: "required"`), or `null` with
  `no_passkey` saying why; `totp: true`; `expires_at` when the card was held.
  The same request again with `step_up: {token, response}` (or `{totp}`; a form
  sends it as JSON text in a hidden field) is checked and applied. A challenge is
  single use, 2 minutes, bound to the user, the browser session and the exact
  action (`approval:<id>:approve`, `+:always:<hash of tool+pattern>`,
  `decision:<id>:approve|resume`, `rule:...`, `retire:<slug>`, `resume:<key>`;
  lib/passkeys.js `stepUpOptions` / `verifyStepUp`). A refused proof answers 403
  with a fresh challenge; five wrong codes in ten minutes lock the code (429)
  while Hello keeps working.
- **The card waits for Hello**: issuing a challenge for an approval asks the
  supervisor to hold the card (`approval-hold`, at least 90 s from now, never
  more than 120 s past its own window); the dialog shows the time left.
- **Audit**: the panel's login log ("approved request 12 with Windows Hello
  (Laptop Windows Hello)" / "with authenticator code", refusals as `step-up`), and
  the supervisor op carries `verified: hello|totp` + `verified_with` (stored on
  the approval row, in JOYA AI's audit table and log). An older supervisor that
  refuses those fields gets the op without them.
- **Page**: `public/step-up.js` (on every page, lib/ui.js) -- the "Confirm it is
  you" dialog: starts Windows Hello at once, "Use authenticator code instead",
  Cancel; the Command Center's `api()` and the plain `form[data-step-up]` forms
  use it. In the desktop app `joya-desktop-webauthn.js` (now also on the
  Command Center) makes the window an ordinary one while Hello's prompt is up.
  Windows toasts never approve (unchanged).
- Tests: `tools/test-stepup.cjs` (server, a software authenticator),
  `tools/test-stepup-ui.cjs` (Chromium, the virtual authenticator; `--shots DIR`).

## Proactive JOYA AI: the brief, watchers, "while you were away" (2026-10-20)

A morning brief at each person's time, watchers set in plain words (they only notify, at most 50
per person), and a catch-up after 30 minutes away. The dashboard's own clock writes them every 20 s
from read-only supervisor ops; they show in the Command Center and the desktop app only.
`lib/proactive.js` (pure), `lib/proactive-store.js` (tables `proactive_*` in joya.db),
`lib/routes-proactive.js` (clock, `/joya-ai/api/proactive/*`, Settings ▸ Briefs & watchers),
`lib/proactive-writer.js` (the summaries' model, kept only when grounded), `public/joya-proactive.js`.
Design note and screenshots: `mockups/proactive/`. Test: `tools/test-proactive.cjs` (`--shots DIR`).
`JOYA_PROACTIVE_TICK_MS` changes the clock (tests).

## Where you land

`/` is not a page: it 302s to the signed-in role's default landing,
`rbac.landing()` -- `/joya-ai` for `joyaai.use`, else `/os` (the OS overview,
the Machine core) for `os.view`, else `/agents/dashboard` for `agents.view`,
else `/account`. Sign-in and the brand link use the same function. The top
bar's tabs are JOYA AI (`/joya-ai`), OS Dashboard (`/os`) and Agents Dashboard
(`/agents/dashboard`). Test: `tools/test-landing.cjs`.

## Claude Code pages

OS Dashboard > Claude Code: **Memory** (`/claude/memory`), **Sessions**
(`/claude/sessions`), **Running** (`/claude/running`). Permissions
`claude.memory.read|write`, `claude.sessions.view|manage`,
`claude.running.view|stop` -- in no stock role, so administrator-only until a
role is given them: transcripts hold client data and the panel faces the
internet.

All data comes from the helper's `cc-*` subcommands. Memory reads and writes go
through memlib, run by the claude-memory venv inside the helper, so the database
credentials in `/root/.claude-memory/db.env` never reach this process. Output is
redacted by the helper (its own rules plus memlib's) and again by
`priv.redactDeep`. Outside Memory ▸ Sessions nothing is deleted: editing a fact supersedes it, forgetting
is memlib's soft delete, archiving a session moves it to
`<home>/.claude/archive/dashboard-archived/`. Rename and archive are refused
while a session runs; Stop sends SIGINT only to a pid registered in a
`sessions/<pid>.json` whose process is the claude binary, and SIGTERM only 10 s
after that. Every write is in the audit log with the panel user.

**Memory ▸ Sessions** (`/claude/memory?view=sessions`, `/claude/memory/session/<uuid>`) lists every
session that left memory (name from JOYA AI's state, the hired-sessions ledger, a live session's
name or the transcript title; origin, project, machine, dates, chunk and fact counts) and, for
`claude.memory.manage` (administrators only by default), hides, unhides or permanently deletes
facts and chunks -- selected, everything a filter matches, or the whole session. Helper
subcommands `cc-mm-*`; the rules live there: one session per request, no whole-session hide or
delete of a live session (a running process, JOYA AI's current session, or a transcript written
in the last 2 minutes), deletes only with the counts the confirm page showed, a whole-session
delete only with its name typed back and only once claude-memory's ingest honours exclusions.
A deleted session goes on `excluded_sessions` (lifted with *Allow re-indexing*), deleted chunks
leave a tombstone, and *also delete the transcript file* removes the copies in writable homes
(read-only Windows-archive copies stay). Hiding needs claude-memory's update:
`deploy/claude-memory-manage/install.sh` (until then the list is read-only). Audit: counts only.
Tests: `tools/test-memory-manage.cjs`; every read path against a scratch copy of the database:
`/opt/claude-memory/venv/bin/python tools/test-memory-manage-db.py --make --drop`.

Known follow-up: the memory search service on 127.0.0.1:8765 takes no token, so
any local process can query it. Adding one is deliberately left for later.

## JOYA AI API

JOYA AI (formerly JOYA AI, and before that JOYA Bot) is one root Claude Code session that delegates
commands to every other session on the machine. It is run by its own
supervisor, `joya-ai.service`; the design, the approval gate and the traps are
in [`joya-ai/README.md`](../joya-ai/README.md). The panel's part is a JSON and
SSE API, and the Command Center page that consumes it (below). The old console
(`/console`) keeps working; only its label changed.

Permission `joyaai.use`, in no stock role: it reaches a root session that can
message every session on the box. API routes answer in JSON, refusals too
(401 not signed in, 403 no permission or bad CSRF, 400 invalid, 409 refused
by the supervisor, 503 supervisor down, 504 no answer).

    GET  /joya-ai/api/overview             status + sessions + recent delegations + memory counts + csrf
    GET  /joya-ai/api/status               process, current turn and its steps, pending approvals, vitals, counts
    GET  /joya-ai/api/sessions             claude agents --json merged with the ledger
    GET  /joya-ai/api/memory               fact / chunk / session counts (cached 60 s)
    GET  /joya-ai/api/rc                   Remote Control state and session URL
    GET  /joya-ai/api/ledger/:table        delegations | inbound | approvals | turns | audit
                                           ?limit=&before_id=&status=
    GET  /joya-ai/api/events               Server-Sent Events; Last-Event-ID or ?since= resumes
    POST /joya-ai/api/send                 {text, target?}
    POST /joya-ai/api/interrupt
    POST /joya-ai/api/approvals/:id/approve   {note?}
    POST /joya-ai/api/approvals/:id/deny      {note?}
    POST /joya-ai/api/rc                   {enabled}
    POST /joya-ai/api/restart

Writes carry the CSRF token as `_csrf` in the JSON body or an `X-CSRF-Token`
header (`/overview` returns it). SSE event names are the supervisor's event
types (`turn`, `text`, `assistant`, `tool`, `steps`, `approval`,
`delegation`, `inbound`, `sessions`, `vitals`, `rc`, `proc`, …); `text` deltas
carry no id and are not replayed after a reconnect.

The panel reaches the supervisor over `/run/joya-ai/joya-ai.sock`
(`root:joyaai 0660`). `joyaadmin` is in the `joyaai` group -- the deploy script
adds it, and it takes effect at the restart that follows. No sudo is involved;
the supervisor re-validates every request and audits every write with the
panel user (`/var/log/joya-ai/audit.log` and its ledger). The panel also logs
sends, approvals and restarts in its own login log.

`deploy-dashboard.sh` now tars the tree it replaces to
`/root/backups/joya-dashboard_<timestamp>.tgz` before syncing.

    POST /joya-ai/api/transcribe           {data: base64, mime?, vt?} -> {text}  (OpenAI transcription)
    POST /joya-ai/api/speak                {text, vt?, cat?} -> NDJSON PCM stream (Accept: application/x-ndjson),
                                           else audio/wav or 204            (OpenAI realtime voice)
    GET  /joya-ai/api/voice/usage          today's / this month's voice spend, by kind, and the last turn

Tests: `node dashboard/tools/test-joyaai.cjs` (client and permission).

### The Command Center (`/joya-ai`)

The top bar's JOYA AI tab opens it. Someone with `console.use` but not
`joyaai.use` is sent on to `/console`. One screen, no page scroll at
1920×1080, 1600×900 and 1440×900 -- only its panels scroll:

- **Left rail** -- JOYA AI Core (process, sessions, agents, memory, voice,
  guardrails), Talk to JOYA, vitals rings (the supervisor's own vitals, which
  arrive on the stream every 5 s) and memory counts.
- **Centre** -- the seed core: one canvas, `requestAnimationFrame`, DPR-aware,
  paused while the tab is hidden, a still frame under reduced motion. Its
  satellites are the live sessions from `/sessions`, in their real state
  colours. States come from real events: *thinking* while a turn runs,
  *delegating* when a `delegation` event with status `sent` arrives (a bead of
  light runs down the root to that session), *listening* while the microphone
  records, *speaking* while a reply is read aloud. Below it the sessions strip
  (Delegate… prefills the composer for that session; Open says where it runs,
  and for JOYA AI itself opens the Remote Control link) and the composer
  (target chip, `@` to pick, interrupt while a turn runs).
- **Drawer** -- Conversation (the turns ledger, then live: streamed text,
  delegation cards, approval cards), Timeline (delegations and approvals),
  Live feed (replies, idle notices, service and session events), and Current
  AI Activity from the turn's `steps`.
- **Approval cards** come from `approval` events: command, target, effect,
  reason, a countdown to the automatic deny, and Approve & run / Deny. While
  any is pending the status chip and the core's pill say *Awaiting approval*.
- **Voice** is OpenAI, used as a voice only (see *OpenAI voice* below): tap
  to talk (end of utterance from the level, barge-in over a reply), or hold
  Space. A spoken turn gets a spoken "On it." and its reply read aloud; the
  *replies aloud* chip reads every reply. The core pulses with the reply's
  real output level. Without a key the controls are off and say
  "Add an OpenAI key in Settings".

- **The family of spheres** (`public/cc-family.js`, 2026-09-30, the default
  sessions view; the approved mockup's Flat view): each live session is a
  small dotted sphere like JOYA AI, with its name and state under it, drifting
  round her -- never over her, each other, the caption, the composer or voice
  bar, the approval card, the icon rail, the top bar, the reply or an open
  sheet (soft forces, then hard guarantees each frame; an overlap audit is
  exposed for checks). Its own tint; size by what it did today (delegations,
  cost); a kept ring (every session today -- hiring is not built, a session
  marked `hired` would have none); working ones shimmer, idle ones dim, one
  waiting on you glows amber with a pulsing "needs you" badge, one that just
  finished blooms and says "done". Real events drive it: a `sent` delegation
  streams dots from her to it, a reply (ack or inbound message) a thread back;
  running sub-agents are specks circling it; a session that appears condenses
  out of her, one that goes away dissolves back (nothing here retires
  anything). Hover: a card with its task, last message and cost today; click,
  or Tab to its name and Enter, opens its deep view. Same with cores A, B,
  C and D. On a phone the core is smaller so the spheres fit round her. It rides the
  core's own frame (about 1 ms of JS a frame for 7 spheres, 60 fps); under
  reduced motion it is placed once and drawn still. **Account › Appearance ›
  Sessions view** picks Spheres (new, the default) or Classic orbit, stored
  per user (`users.sessions_view`, `POST /joya-ai/api/prefs/sessions`,
  audited like the core) and rendered as `data-sessview` on `#cc`.

- **Core D, "Mesh" -- the default core since 2026-10-06** (`public/joya-core-d.js`,
  approved mockup `mockups/ai-core-v4/`): a sphere made of dots -- a fine
  lat/long grid drawn as rows of dots with brighter crossings -- whose surface
  folds like a liquid, cyan -> blue -> violet -> magenta across the screen,
  with a glow hugging the silhouette (magenta lower right, blue upper left) and
  a halo of fine dots. States live in the mesh: idle drifts and breathes;
  listening sends ripples in toward the front with the voice level; thinking
  deepens and twists the folds and turns the gradient; speaking swells a ring
  out from the front per syllable; delegating peels a stream of dots off the
  side facing the session and flows it to that session's sphere (or the edge
  marker); needs-you warms the rim to amber with a double pulse. WebGL2, with a
  2D wireframe if WebGL2 is missing; DPR <= 2; stops while hidden; one still
  frame per change under reduced motion; frames slower than ~45 fps for 2 s
  drop to 0.7x resolution once. The canvas stays transparent away from the
  core (`backdrop: "glow"`), so the page keeps its own background; the shared
  CSS halo is hidden for D (it paints its own glow). A, B and C are unchanged
  and one switch away (Settings > Appearance, the voice menu, `core.set`):
  crossing between D and A/B/C stops the running core, releases its GPU
  context and starts the other on a fresh copy of the canvas (a canvas that
  gave out WebGL1 can never give WebGL2). With D the **session spheres are
  small mesh replicas** drawn by the core on its own canvas in one batch
  (cc-family.js `setMesh` / `meshKids`): the session's tint woven into the
  gradient, faster folds and a brighter rim while working, dimmer when idle,
  an amber rim pulse when it needs you, born out of JOYA AI and dissolved back
  into her as mesh dots, brightening as a delegation lands; names, badges,
  rings, sub-agents, hover, click and drift are the family's, unchanged. The
  dock on other pages draws the mesh at dock size (`data-core="D"` on
  `#joya-dock-root`, `joya-core-d.js` loaded before `joya-dock.js`). **Default
  and migration:** `users.joya_core` '' reads as D (`cc-logic.js`
  `CORE_DEFAULT`); `lib/db.js migrateCoreDefaultD` moved every existing account
  to D once at start, one audit line each ("JOYA AI core X -> D (Mesh) (new
  default, migration)"), recorded in `settings` as `migration.joya_core_d` so
  it never runs again -- a later switch back to A/B/C sticks.

Everything is built in `public/joya-ai.js` from the API; the frame is
`lib/views-joyaai.js`, the styles `public/joya-ai.css`. No inline script or
style (the CSP forbids both) and no external requests.

### The composer and attached files (2026-10-25)

The message bar at the bottom of the Command Center is one pill-shaped field (as ChatGPT's): **+**
(Upload a file, Upload a photo, Address a session), the message (a text area: Enter sends,
Shift+Enter is a new line, Enter while an input method composes does nothing; it grows to about six
lines, then scrolls, and takes the full width once it has more than one line), the voice chip
("Live · <voice>": the voice and core menu), and one round button that is the live conversation
(the waveform) while the field is empty, **send** once something is typed or attached, and **stop**
while JOYA AI works and nothing is typed. With voice off the waveform is struck through on a dashed
ring and says why (tooltip, description, a click explains it with the Settings link). `@` typed first
still opens the session picker; the chosen session shows as a chip in the bar.

**Attachments.** Three ways in: the **+** menu (a file picker, several at once), a paste (Ctrl+V of
files, or a screenshot on the clipboard -- a paste that also carries text pastes the text) and a drop
anywhere on the Command Center (the bar lights up). Each file is uploaded at once and shown above the
text as a chip (a preview for an image, its size, a remove button); progress and errors are announced
(`#cc-att-live`, aria-live) and a failed upload or send never touches the typed message.

- `POST /joya-ai/api/uploads` (joyaai.use + the CSRF token in `X-CSRF-Token`): the raw bytes of one
  file, `X-File-Name` (URI-encoded), `X-Upload-Batch` for the message's folder after its first file.
  20 MB per file (413), ten files per message; an allow-list of extensions (images png/jpg/gif/webp,
  pdf, doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp/rtf, txt/csv/tsv/md/json/log/xml/yaml, zip; 415 for
  anything else, SVG included) checked against the first bytes; programs (MZ, ELF, Mach-O, `#!`) are
  refused whatever they are called. `lib/uploads.js`, `lib/routes-uploads.js`.
- **Storage:** `<data dir>/uploads/<yyyy-mm-dd>/<message folder>/<random>.<ext>` (on the VPS
  `/var/lib/joya-dashboard/uploads/…`, env `JOYA_UPLOAD_DIR` overrides), 0700 folders and 0600 files
  owned by the dashboard user; the original name, type, size, sha256 and owner are in `<file>.json`.
  Nothing a browser sends becomes part of a path. **Files are kept**: there is no cleanup job yet;
  delete old day folders by hand if the disk needs it.
- **To JOYA AI:** `POST /joya-ai/api/send {text, attachments: [ids]}` -- the server (never the page)
  checks each id is the sender's own file and adds one line per file to the turn's text:
  `[Attached file: /var/lib/joya-dashboard/uploads/2026-10-25/<folder>/<file> | name.pdf | application/pdf | 1.2 MB]`.
  The supervisor runs as root and needs no change; JOYA AI opens the path with its Read tool (images
  and PDFs included). A voice turn carries no files. Files with no text are allowed.
- `GET /joya-ai/api/uploads/<day>/<folder>/<file>` (joyaai.use): the file, `nosniff`, a sandboxing CSP,
  inline only for images and PDFs. The Conversation reads the lines back (`cc-logic.js
  splitAttached`) and shows each file under the message: a thumbnail for an image, else its name and
  size, each a link. The desktop app's chat names them under the message.
- **The desktop app** keeps the attach button and paste (WebView2 has the file picker and the
  clipboard); a drop of files from Windows is taken by the app window (Tauri's own drag and drop) and
  does not reach the page there -- use the button or paste.
- Tests: `tools/test-composer.cjs` (scratch server + fake supervisor; `--shots DIR`).

### OpenAI voice

Voice only: OpenAI hears the person and reads the replies aloud; Claude does
all the thinking. Everything goes through this server -- the browser never
talks to OpenAI and never sees the key (the CSP still forbids it to).

- **Hearing**: the live call streams the microphone to this server (see *Live
  conversation*). On the realtime voice models the server's own full-turn
  transcript of what it relayed (`POST /v1/audio/transcriptions`,
  `gpt-4o-transcribe` -- the one transcription model since 2026-10-30, with a
  vocabulary prompt: Joya, JOYA AI, Odoo, sessions, agents) is what JOYA AI
  gets; on GPT-Live, GPT-Live's own input transcript is (see *Live conversation
  on GPT-Live*). The console's dictation still posts a recording to `/console/:id/transcribe`.
  The Command Center's push to talk (`/joya-ai/api/transcribe`) is gone.
- **Speaking**: each sentence of a reply is posted to `/joya-ai/api/speak` or
  `/console/:id/speak`. The Command Center asks for it **streamed**
  (`Accept: application/x-ndjson`): `start {engine}`, then `audio {pcm}` (PCM16
  mono 24 kHz, base64, whole samples) as OpenAI produces it, then `end` -- and
  plays it with Web Audio from the first chunk (a 60 ms lead, each chunk
  scheduled right after the last, one gain node per reading into the analyser
  that drives the seed core). The console still gets a whole WAV. `lib/voice.js` keeps
  WebSockets to `wss://api.openai.com/v1/realtime?model=<the reader>` warm and
  reuses them. The reader is the voice model when it passed the verbatim check
  (`READER_MODELS`: `gpt-realtime-2.1-mini`, which read 18 of 18 test sentences
  word for word on the real API on 2026-09-30, English and Egyptian, including
  the ones that tempt a model to answer); `readerModelFor` gives
  `gpt-realtime-2.1-mini` for any other voice model. A reading that still fails the verbatim check is read again by
  `gpt-4o-mini-tts` -- a fixed safety net, not a setting. `gpt-live-1` never
  reads aloud (it paraphrases by design); it is offered as the live
  conversation only (see *Live conversation on GPT-Live*). Each sentence is an **out-of-band** `response.create`
  (`conversation: "none"`, empty input, the text quoted in that response's
  instructions): put in as a user message, the real model *answers* it ("Hello,
  can you hear me?" -> "Yes, I can hear you loud and clear. How can I assist
  you today?"), which is why the first build spoke almost nothing. The page
  fetches the next sentences while one plays. Short lines ("On it.") are cached
  in memory per model and voice.
- **Verbatim guard, while streaming**: the model's own transcript of what it
  said is compared with the text word by word. Its transcript runs *ahead* of
  its audio (measured 2026-09-29: most of a sentence's words arrive before the
  first audio chunk, and the audio arrives several times faster than it
  plays), so the check runs on every transcript delta while the audio flows:
  once it holds more invented words than a faithful reading may, the reading
  is cut (`cut`), usually before that audio was even sent; at the end the full
  check (dropped words too) can still cut it, a fraction of a second into
  playback. On `cut` the page stops that sentence at once (a 12 ms fade, every
  scheduled chunk stopped) and drops what it held; the server cancels the
  realtime response (`response.cancel` with its id, whose usage is still
  counted) and **re-reads the whole sentence with `gpt-4o-mini-tts`**, streamed
  too (`stream_format: "sse"`, which also reports its usage), which cannot
  answer it. Only if that fails is the sentence skipped (`skipped`; 204 in the
  WAV form), its text still on screen, and the page says so. Measured
  2026-09-27: realtime-mini read about 88% of sentences verbatim out of band.
  Barge-in stops the stream playing and aborts the ones fetched ahead;
  sentences play strictly in order. Each call logs one key-free, text-free
  line to the journal: `voice speak 200 engine=... ms=... first_audio_ms=...
  warm=1 cuts=... audio_s=... words=... streamed=1 usd=...` or `voice transcribe
  200 model=... ms=... usd=...`.
- **The key**: JOYA AI ▸ Settings ▸ Voice (`/joya-ai/settings/voice`, row
  *Voice API token*; permission `voice.manage`, in no stock role --
  administrators only). Write-only, shown only as set / not set; **Replace**
  opens a dialog with a password field (`POST /joya-ai/settings/voice/key`),
  **Remove** asks first (`/clear`), **Test the voice** (in the main group,
  after the key) speaks one line with the selected voice model and transcribes
  it back with `gpt-4o-transcribe` (`/test`; the result names the model that
  answered and the milliseconds). Stored by the helper in `/var/lib/joya-voice/openai-voice.env`
  (root:root 0600, directory 0700) -- not the repo, not the database, not argv;
  set/clear/options are audited with the last four characters only. The panel
  reads it through `joya-helper voice-key-read` and keeps it in memory.
  This is a separate credential from the Odoo walkthrough's
  `/etc/odoo/openai_key`.

Piper (`/opt/joya-tts`) is gone. whisper.cpp stays: the Telegram agents'
voice-notes add-on runs its `whisper-cli` with `ggml-base.bin`
(`VOICE_PROVIDER=local`). The old `joya-whisper.service` (tiny.en on
127.0.0.1:8081) is unused and disabled; the panel's local transcription is a
different unit, `joya-voice-whisper.service` (below).

Tests: `node dashboard/tools/test-voice.cjs` (mock OpenAI for both protocols
and transcription, the verbatim guard, the helper's key storage, the no-key
views). Needs `ws` on `NODE_PATH`.

### Voice: live conversation only (JOYA AI ▸ Settings ▸ Voice)

Since 2026-09-30 (the Joya reorganisation) voice **is** live conversation:
the relay front desk, the Direct / Front desk / Live picker, push to talk and
hands-free, Space held to talk and every "trial" label are gone.

- **One switch, for everyone**: *Voice Enabled / Disabled*
  (`POST /joya-ai/settings/voice/enabled`, audited). Stored in the old front
  desk's setting key, `voice_desk`, as `on` / `off`: the old values read as
  `0` -> off, `1` and `live` -> on, and are rewritten once at start
  (`migrateVoiceSetting`, logged). **Off** means no voice for anyone: no mic on
  the Command Center or the dock, no read-aloud, no live bar and no voice-menu
  voice entries; the live WebSocket upgrade answers 403 and open calls end
  (`voiceLive.closeAll("disabled")`); `/joya-ai/api/speak` (and the console's
  speak / transcribe) answer 409 `{code: "voice-off"}`; JOYA AI's screen
  actions `call.*` and `voice.set` are refused ("voice is off") on the server
  and on the page. The key is kept, and its row stays usable.
- **Who may talk**: permission `voice.use` (*Talk with JOYA AI by voice*,
  JOYA AI group, implies `joyaai.use`; administrators only by default). Live
  needs `joyaai.use` + `voice.use`; `voice.manage` is for Settings ▸ Voice.
  Without `voice.use` there is no mic and no read-aloud anywhere.
- **The voice model** (Settings ▸ Voice ▸ *Voice model*): `lib/voice.js`
  `VOICE_MODELS` -- `gpt-realtime-2.1-mini` (the default), `gpt-realtime-mini`
  and `gpt-4o-mini-realtime-preview` (*GPT-4o Mini Realtime*), each with a short
  line of its 2026-09-30 test results in the selector. On 2026-09-30 the list
  was cut to 2.1 mini alone (gpt-realtime-mini read 14/18 word for word and
  answered Arabic in English 2/2, retiring 2027-01-20; 4o-mini-realtime was
  refused for this key); on 2026-10-01 the administrator asked for the other
  two back. It is the panel setting `voice_model` and drives the live call.
  **Read-aloud stays verbatim**: the reader is the voice model only when it is
  in `READER_MODELS` (2.1 mini), else `readerModelFor` gives
  `gpt-realtime-2.1-mini`. *GPT-4o Mini Realtime* is `gated`: offered only when
  the key's free `GET /v1/models` listing carries it or a dated snapshot of it
  (`modelAccess`; the call then uses that id). The server lists the models at
  start, after a key change and when the section is opened with an answer
  older than 6 h (`checkVoiceAccess`, ids only, a failed check keeps the last
  good list); the option is shown disabled -- "not available on this OpenAI
  key" -- while it is not listed, `POST /joya-ai/settings/voice/options`
  refuses to save it (re-checking once first), and a stored choice the key is
  known not to reach reads as the default. On 2026-10-01 the key listed
  `gpt-realtime-mini` but no `gpt-4o-mini-realtime*`.
  A realtime voice model cannot also be the transcriber: no
  realtime model can transcribe its own input (OpenAI refuses one as the
  session's transcription model and on `/audio/transcriptions`), and a
  hand-off to JOYA AI must carry the server's own transcript (prompting the
  voice model to transcribe its own input was tested too and lost or changed
  about 1 turn in 5 -- see the note in `lib/voice.js`). The helper's options
  hold the reader, the voice and the live session's transcription model (its
  `VOICE_MODEL_RE` accepts `gpt-realtime*`, `gpt-live*` and
  `gpt-4o-mini-realtime*`); each
  Settings row posts only its own field to `POST /joya-ai/settings/voice/options`
  (a `transcribe_model` field from an older page is ignored). At start
  `migrateVoiceModelSetting` rewrites only an unknown `voice_model`
  (`gpt-realtime`, `gpt-live-1`, junk) to the default -- a listed choice,
  `gpt-realtime-mini` included, is left alone -- and `migrateVoiceHelperModels`
  rewrites the helper's reader/listening models when they differ -- both idempotent. A
  change reconnects open calls (`voiceLive.swapAll`, the model included). The
  summariser (`lib/voice-shared.js` `SUMMARY_MODEL`) is a text step and stays
  on `gpt-realtime-mini` for now: on `gpt-realtime-2.1-mini` its 220-token cap
  cut a sentence mid-way (2026-09-30).
- **Transcription** -- one model, `gpt-4o-transcribe`, no setting (2026-10-30,
  the administrator: "make the gpt 4o transcribe be used with gpt realtime mini
  2.1. remove all other models, and remove the transcription section from the
  settings"). `lib/voice-transcribe.js` (`TRANSCRIBERS` is one entry). On the
  realtime models it writes down the full turn (`transcribeTurn`, the hand-off
  text) and is the live session's own input transcription (`sessionModelFor`;
  the helper's `VOICE_TRANSCRIBE_RE` now accepts only `gpt-4o-transcribe` and a
  dated snapshot of it, and a fresh helper file defaults to it). No language is
  sent (the model detects Arabic, English and the two mixed); only a live call's
  second try pins one. GPT-Live calls use no transcription model. The old
  setting `voice_transcription` (2026-09-30 to 2026-10-30: gpt-4o-mini-transcribe,
  gpt-transcribe, gpt-4o-transcribe and, until 2026-10-25, whisper.cpp on this
  server) is left in the database and ignored; its route
  `/joya-ai/settings/voice/transcription` is gone. The retired models stay
  priced in `lib/voice-usage.js`, so older rows still read. The local
  whisper-server (`joya-voice-whisper.service`, `deploy/install-voice-whisper.sh`,
  the helper's `voice-whisper-*`) is left installed and disabled; nothing in
  the panel starts it. The guards still read English written in Arabic script
  («ريستارت للداشبورد», «ستوب الليسنينج», «يس», «اندو»), tested in
  `test-voice-arabic.cjs` / `test-voice-stop.cjs`.
- **Voice cards** follow the voice model (`lib/voice.js` `voicesFor`), tested
  on the real API on 2026-10-30: the realtime models take ten voices
  (`REALTIME_VOICES`: marin, cedar, alloy, ash, ballad, coral, echo, sage,
  shimmer, verse); GPT-Live takes those ten **and** its own 21
  (`LIVE_ONLY_VOICES`: quartz, ripple, vesper, willow, stone, gleam, meridian,
  delta, cinder, beacon, bossa, tempo, nuri, juni, flitz, brise, sillage, nira,
  harema, shida, noeul -- English with Australian, British, Irish, North
  American, Southern US and Filipino accents, Brazilian Portuguese, German,
  French, Hindi, Japanese, Korean); fable, onyx and nova are refused by both.
  Each card carries a gender (♀ Female / ♂ Male / ◌ Neutral) from one table,
  `VOICE_META`: the realtime voices as each presents in OpenAI's own samples
  (OpenAI labels none; alloy is Neutral); GPT-Live's as OpenAI's GPT-Live page
  labels them, with its language/accent as the note. A GPT-Live-only voice has a
  `standIn` (marin or cedar, same presentation): the verbatim reader (2.1 mini)
  speaks with it inside a GPT-Live call, and a change to a realtime model stores
  it (`POST /options` says so and reloads the section for the new cards); posting
  a voice the model cannot use is refused. `voice.set` by voice (`public/ui-actions.js`
  `VOICE_NAMES`) still offers the ten shared voices.
- **Voice samples**: each card has a play button (beside its radio label, so it
  never chooses the voice; hidden without JavaScript) that posts
  `POST /joya-ai/settings/voice/sample {voice}` (`voice.manage`, CSRF) and plays
  the `audio/wav` it gets: "Hi, I'm JOYA AI.", spoken by the voice model that
  holds the call -- GPT-Live for GPT-Live (~5 s to make), the realtime model
  otherwise (~1.5 s) -- so it sounds as on a call. Made once per (model, voice,
  line) and kept in `<data>/voice-samples/` (0600); a made clip is recorded in
  `voice_usage` (category `sample`, "Voice samples" in the spend card). Refused
  while voice is off (409), without a key (503), or for a voice the model does
  not have (400). States: loading (spinner), playing (click again stops), an
  error line under the cards.
- **Removed on 2026-10-30**: the *Arabic* persona row and its Reset
  (`/persona/reset`; the persona is learned from how the administrator speaks,
  and `POST /persona` stays for a confirmed `persona.set` from the Command
  Center), and *Read replies aloud* (the Settings switch, the Command Center's
  speaker button and its voice-menu item, `localStorage` `joya-read-aloud`):
  typed replies are no longer read by themselves; a reply's **Read aloud**
  stays.
- **The rest of the section**: live audio (speakers / headphones default, noise reduction:
  `/live-audio`, each row its own field), call limits, spend, and the link to
  the voice evaluation (`/joya-ai/voice-eval`, unchanged). The markup is
  `lib/views-settings-voice.js`; the routes sit with the voice code in
  `server.js` (`settingsRoutes.sections.voice`). Every form works in place
  (os.js, JSON) and without JavaScript (a redirect back to its row).
- **Old URLs**: `GET /credentials/openai-voice` -> 302 to the section; its
  POSTs (`key`, `clear`, `test`, `options`, `persona`, `live-audio`) -> 308 to
  the new routes (method and body kept);
  `/credentials/openai-voice/desk` changes nothing and says the desk is gone.
  Credentials shows the voice key as one status line linking here.
- **The mic**: in the Command Center it starts a live call (hint "click the
  mic to talk"); during a call the mic mutes and unmutes it everywhere, Space
  mutes or interrupts, Esc only interrupts, and **only the red X ends a call**
  (never within 1.5 s of its start). The dock on any other page goes to
  `/joya-ai?at=<this page>&call=1`: the shell keeps the page on screen in its
  frame and the call starts; in the shell the dock's mic starts or mutes it
  (muted: the mic amber with a slash, the tag says MUTED).
- **Sign-out ends that device's call**: the live upgrade records the session
  id with the call, and `endLiveCallsForSession(sid, reason)` (server.js) ends
  every call bound to it -- on logout, on a revoked session, and from the
  Devices page's sign-out of another device.

### What the live voice shares with the old front desk (`lib/voice-shared.js`)

The desk's module was cut down to what the live call uses: the supervisor door
(`voiceOps`: `snapshot` and `send` only, `via: "voice-desk"` -- the
supervisor's existing name for a voice hand-off), the snapshot filter
(`forModel`), the fixed lines, the output guard (`judge` / `guard` /
`Releaser`) and the guarded summary of JOYA AI's replies (`Summariser`,
`summariserFor`). The rules below are the guard's, and hold for every word the
live voice speaks and every summary.

It cuts: a claim that something was done/deleted/restarted/pushed/approved (or
is being: "Restarting Odoo."), a promise of one, a figure not in the snapshot /
a result / what was said, a status claim with no snapshot or about something
the snapshot does not hold, a finding ("I found ...", "I checked the logs",
«لقيت إن ...», «راجعت الـ logs») before any result has arrived, and "I'm
checking" / "give me a moment" / «ثانية أشوفلك» / "I'll tell you what I find"
when no request is being worked on (an `ask_joya` call in this response, or
one still in progress). A cut reply is replaced by "Give me a moment, I'm
looking into it." and the request really is worked on.

**One identity: the voice IS JOYA AI** (the administrator, 2026-09-29: "you
are JOYA AI; don't say you delegate to JOYA AI; talk to me as JOYA AI; you can
take time to think, and while you think build a report with me or just talk").
Relay desk, live conversation, summaries and every fixed line speak as JOYA AI
in the first person. `ask_joya` stays (internally it is still the supervisor's
`send`); the live mode's tool is now named `look_into` (it was `ask_joya_ai`:
speaking as JOYA AI, the audio model read that name aloud -- «هسأل JOYA» --
and was cut as third-person), same handler. The instructions describe the tool
as the voice's own deeper work, which takes a while. The relay model, speaking as
JOYA AI, often says "Give me a moment, I'm checking" and forgets the call
(gpt-realtime-mini, real API 2026-09-29): the guard stops the words, the server
starts the work in the administrator's own words, and then -- now true -- the
model's own words are said (`backedByServer`); a `read_status` call in the same
response backs "let me check" too. Pending: "Give me a moment, I'm
checking…" / «ثانية أشوفلك…» / «خليني أبص على الـ logs»; the result, when it
arrives, is summarised as "I found…" / «لقيت إن…» (the summariser is told the
reply is its own finished work). While waiting the voice may keep talking --
acknowledge, say in general terms what it is looking at, ask a clarifying
question, small talk, help draft or structure a report -- but never invents
progress, findings, results or finished actions. The guard adds a
`third-person` rule: "I've passed that to JOYA AI", «تم تمرير الطلب لـ JOYA AI»,
"JOYA AI says / restarted …" are cut in the desk and in summaries ("I'm JOYA
AI", «أنا صوت JOYA AI», "JOYA AI OS" and service names like `joya-agent@admin`
are not). "I restarted Odoo" / «عملت restart لأودو» is spoken only when a result
says it was done. Fixed lines, first person, gendered in Arabic by the persona
(feminine for Cairene feminine, masculine for Cairene masculine, neutral for
MSA or while unknown): "Give me a moment, I'm checking that." / «ثانية أشوفلك
الموضوع.»; "I'll tell you what I find." / «وهقولك على اللي ألاقيه.»; "I need
your approval or your answer." / «محتاجة / محتاج موافقتك أو ردك.» (neutral
«الموضوع محتاج موافقتك أو ردك.»); "The details are on screen." / «التفاصيل
قدامك على الشاشة.»; "Sorry, I didn't catch that." / «معلش، مسمعتش كويس.» when
there is nothing grounded to work on. It is always JOYA AI's voice and never
claims to be human.

**Summaries.** JOYA AI's answer to a live call's request stays on screen
exactly as written; aloud, the call asks the summariser for a **detailed**
summary (since 2026-10-30, the administrator: "always reading a detailed
summary when a delegation is finished"): every key fact, figure, status and
what is still open, three to six spoken sentences, at most ~120 words, a list
summed up in words; only code, commands, paths and links are left to the
screen -- never just "the details are on screen" (an out-of-band text
response: no conversation, no tools, the reply quoted,
the administrator's request and last words alongside). When part of the reply
was already read while it was written, the summary is told so (`alreadySaid`)
and covers the rest; a final text that differs from what was read gets the
summary of all of it. A transient OpenAI
server error is retried once. A reply of one or two plain sentences is read word for word instead
(`fallback: "verbatim"`). The summary is held to the reply: a figure changed
or rounded wrongly (2.7 may become 3, never 2), a negation flipped, a
recommendation JOYA AI did not make, "I'll ask you first" turned into "done", a
name or a path it did not give, "I did" what the reply did not say was done,
JOYA AI spoken of in the third person -- each is cut, and the rest becomes "The
rest is on screen." A pending approval or question the summary left out is said
anyway ("I need your approval or your answer."). JOYA AI is told its reply will
be summarised.

**Language and persona** (`lib/voice-persona.js`, the administrator's decision
of 2026-09-29: "replies in my language and saves the persona based on how I
speak"). Each reply is in the language of the administrator's last utterance:
English gets English; Arabic, or Arabic mixed with English, gets Arabic with
technical terms kept in Latin script. In Arabic the register follows theirs
(Egyptian colloquial or MSA), and the voice's grammatical gender for itself
follows how they address it («تقدميني», «إنتِ مصرية» → feminine; «إنتَ»,
«إنت مصري» → masculine), gender-neutral phrasing until that is known. It is
always JOYA AI's voice and never claims to be human. The register and the
gender are saved per user (`users.voice_persona`, JSON), change only when an
utterance clearly shows a change (at least two markers of one register and none
of the other; an unambiguous form of address), and each change is audited.
Settings ▸ Voice > *Arabic persona* shows it with a **Reset**;
there is no free-text persona. The instruction for the language, register and
gender is sent with every response (`instructionsFor`); summaries and the
Arabic fixed lines follow it. The guard reads feminine and masculine Egyptian
forms (participles such as «أنا عاملة ده», «مشغّلاه», «أنا عامله»). Tests:
`test-voice-persona.cjs` (the real server from a scratch copy that cannot reach
the helper -- `tools/scratch-server.cjs` -- the Settings rows, the audit,
Reset), and the persona and gender sections of `test-voice-arabic.cjs`.

**A chosen persona** (the administrator, 2026-09-29: «البرسونا بتاعتك بنت
عربية مصرية من القاهرة»). Settings ▸ Voice > *Arabic persona* is a fixed
list, posted to `POST /joya-ai/settings/voice/persona` (voice.manage + CSRF,
audited with the old and new choice): **Learn from how I speak** (the default,
as above), **Cairene Egyptian -- feminine**, **Cairene Egyptian -- masculine**,
**Modern Standard Arabic -- neutral** (`voicePersona.PRESETS`). A choice is
stored as `{mode:"explicit", preset, dialect, gender, updated_at}`; an explicit
choice always wins and learning never changes it (`merge` returns it untouched).
Cairene feminine means Arabic replies in Cairo colloquial Egyptian with feminine
first-person forms -- the live conversation's instructions, the summary language, the safe lines and the approval line
(`linesFor("ar","f")`); English replies stay plain English, and it is still
JOYA AI's voice, never claiming to be human. **Reset** (or picking *Learn from
how I speak*) clears the choice and returns to learning. Nothing sets a user's
value except that form.

**Usage sheet (2026-09-30).** The dock's *Usage* sheet (key `cost`, kept for
`sheet.open`) leads with the Claude plan limits exactly as Claude Code's `/usage`
shows them -- Current session, Current week (all models), any per-model week --
"N% used" (floored), a bar and "Resets <time> (<zone>)", with "as of HH:MM"
(`GET /joya-ai/api/usage`, supervisor op `usage`: the supervisor asks JOYA AI's CLI
with the `get_usage` control request, so the figures are Claude's own, never
estimated; no credential passes through the dashboard). Refreshed when the sheet
opens and every minute; a failed refresh keeps the last figures marked "not
refreshed: <why>", and with none it says the plan usage is not available. Below:
tokens counted on this box from the transcripts (today / last 7 days: input,
output, cache read, cache write, per session, JOYA AI first), labelled as Joya
OS's own count, not plan figures; *Details* adds the 14-day chart and the full
table. Money appears only in the folded voice block (OpenAI bills it). The
estimated-dollar view and its daily budget were retired from the panel.
The rest of the Command Center follows suit: a sphere's hover card ("Today
1.4M tok"), each session's line in the sessions sheet and JOYA AI's own card
("1.4M tok today"), and the mission header's KPI show tokens in the same compact
format (`JoyaLogic.tokens`, byte-identical to the sheet's), with a tooltip that
splits input / output / cache read / cache write; sphere size follows tokens,
not dollars. Only the voice block shows money (`test-joyaai-v3` holds it).

**Cost, on screen -- no cap.** The daily budget was removed (the
administrator's decision of 2026-09-29): nothing refuses or diverts the voice for
what it has spent. Instead every OpenAI call the voice makes is priced from the
usage OpenAI reports -- each live response and summary, each reading (a cancelled one
included), the text-to-speech fallback (`speech.audio.done`), each
transcription -- with the one price list in `lib/voice-usage.js` (OpenAI's
pricing page, read 2026-09-29), and written to the panel's `voice_usage` table
with its voice turn and kind: **live** (the live call, its summaries and
safe lines), **read aloud** (`direct`), and transcription on its own line; the
old desk's kinds (small talk, snapshot, hand-offs) show only while the month
still has spend on them. The Command Center
shows it at the foot of the *Usage* sheet, folded under "Voice · OpenAI -- billed
separately" (`GET /joya-ai/api/voice/usage`): today's and this
month's voice spend (Africa/Cairo) by kind, transcription, the total, and the
last turn's cost. Measured on the real API: small talk ~$0.0015 per utterance,
a snapshot answer ~$0.0022, a hand-off ~$0.0008 plus ~$0.0054 for the summary
(transcription, ~$0.0001-0.00025 per utterance, on top of each). Speech is 85-95% of
it; the desk's own text tokens are $0.0001-0.0005.
A kept conversation is replaced after 12 turns or 12k input tokens.

Tests: `node dashboard/tools/test-voice-shared.cjs` (mock realtime server with
the real event shapes: the supervisor door, the snapshot payload, the guard,
sentence release and its property, summaries). `test-voice-settings.cjs` runs
the real server (scratch copy, helper cut off) through the switch, its
migration, `voice.use`, the voice model, the old URLs and sign-out ending a
call; `test-voice-mode.cjs` holds the page and the dock to live conversation
only. `node dashboard/tools/test-voice-stream.cjs` runs the page's read-aloud
module (cut out of `public/joya-ai.js`) against a fake Web Audio clock:
playback from the first chunk, order, a clean cut and the fallback after it,
switching it off during a stream.
`node dashboard/tools/test-voice-guard.cjs` covers the guard between the
microphone and JOYA AI (`lib/voice-guard.js`, `lib/voice-intake.js`): silence
is never transcribed (under 1,200 bytes, or measured by the page as under
300 ms or with under 150 ms above its speech threshold); a transcript that
echoes the transcription prompt, the desk's instructions or tool descriptions,
has more words than its audio could hold, or is a stock silence phrase on a
short or quiet clip is dropped ("didn't catch that"); a voice send
(`/joya-ai/api/send` with `vt`) must match what the server transcribed for that
voice turn, once; the desk's `ask_joya` and its supervisor door refuse
prompt-like text. Why: on 2026-09-29 a silent push-to-talk press came back from
gpt-4o-mini-transcribe as its own prompt and reached JOYA AI as a turn (ledger
turn 92); prompted transcription models echo the prompt on silence.
`node dashboard/tools/test-voice-arabic.cjs` covers the same guards in Arabic
(`lib/voice-arabic.js`): Arabic-Indic and Eastern digits and Arabic number
words compared with the snapshot's figures, the Arabic and mixed claim,
promise, approval, negation (incl. ما…ش) and hedge rules with clitics and
spelling normalised, the fail-closed rules (a script other than Latin or
Arabic, an unknown past-tense result verb), the summary rules across the two
languages, the Arabic fixed lines, and the Arabic silence phrases and
subtitle credits on the transcript side. `ask_joya` sends the server's own
transcript of the turn, never the voice model's paraphrase.

### Live conversation on GPT-Live (beta, 2026-10-29)

Settings ▸ Voice ▸ Voice model **GPT-Live + JOYA AI** (`gpt-live-1`, gated on
the key's model list; not the default). `lib/voice-gptlive.js` (`GptLiveCall`,
a `LiveCall` with the upstream leg swapped; server.js picks the class by
`voice.protocolFor(live_model)`). The page and its protocol are unchanged.

- **Protocol** (OpenAI docs + real API, 2026-10-29): `wss://api.openai.com/v1/live/sessions`,
  no Origin header; `session.start {model, instructions, audio: {format:
  {type: "audio/pcm", rate: 24000}, output: {voice}}, delegation: {type:
  "client"}}` -> `session.started`. Input `session.input_audio.append`
  (continuous: it only talks while it hears, so the server sends silence
  when the page sends nothing). Out: `session.input_transcript.delta` /
  `session.output_transcript.delta` (`start_ms`/`end_ms` on GPT-Live's own
  clock, which drifts from the audio sent), `session.output_audio.delta`
  (continuous, silence included, no timing), `session.delegation.created
  {delegation: {id}, offset_ms}` (metadata only, never the words),
  `session.usage.updated {usage: {seconds}}` (cumulative), `session.closed`.
  Back: `session.commentary.append {delegation_id, content}` (said in its own
  words), `session.thinking.append` (quiet context), `session.instructions.append`
  (steers; can cut off its speech); <= 500 tokens each. $0.05 a minute.
- **Delegation = JOYA AI.** The prompt asks for `<|SpawnThinking|>` for
  anything about the machine or the screen. On a delegation the request text
  is **GPT-Live's own input transcript** of the turn (since 2026-10-30; joined
  across a request said in pieces) -- through the transcript guard
  (`checkTranscript`, the turn's length the longer of its audio span and
  GPT-Live's word timings) and the door guard -- and handed over through
  `passOn`: the same door, the voiceprint (on the turn's audio, `speechSpan`),
  talk-only speakers, the approval gate. No transcription model is called or
  billed, and no note about another transcript goes along (until then the
  full-turn gpt-4o-transcribe text was the request; on the real calls of
  2026-10-29 GPT-Live's transcript read better, and two requests it had
  understood were lost as "ungrounded"). JOYA AI's finished reply goes back as
  commentary on that delegation: the detailed summary, a line at a time
  (short plain replies whole; the rest of a reply already being said as it was
  written, when that finishes it).
- **Guard.** Output audio is held `HOLD_MS` (250 ms; an utterance's start `LEAD_MS` 150 ms more, the page's jitter buffer) for its words; the
  Releaser judges the words so far (claims, figures). A result is judged with
  the summary rules against exactly the commentary it was given, figures on the
  words so far. A cut flushes the page, mutes GPT-Live until it is quiet, and
  the safe line -- or the result itself -- is read word for word by 2.1 mini.
  An unbacked "let me check" is made true (the turn is handed over).
- **Barge-in.** GPT-Live yields by itself (~1-1.5 s, measured); the page's
  detector makes it immediate (headphones mode). Speakers mode: GPT-Live
  hears silence while it is audible; a tap interrupts.
- **2026-10-30 (call lv1jz4g).** Both live call kinds: the call starts its own small
  JOYA AI sessions as it connects (`voice-warm`; joya-ai voice lanes: a quick lane for
  weather / time / facts, work lanes with JOYA AI's full abilities, agents by name --
  see joya-ai/README "voice lanes"), instead of queueing in JOYA AI's main conversation
  (31-39 s and up to $1.00 a request there; 2-9 s and 1-11 cents measured in lanes). A
  follow-up while the request is starting is folded into it by the supervisor
  (`merged`). An agent's later reply to a request (a peer turn of the lane that
  `follows` it) is said on the call (`followUpEvent`). The reply being said is put on
  screen in full (`replying` / `replied` -> the Command Center's reply panel, or the
  dock's reply card over a page or sheet); the page answers `reply-shown`, and only
  then may the voice say "the details are on screen" (`screenLine`, else "ask me if
  you want the rest"). The page reports the Joya page and panel in view
  (`screen`), added to each hand-off as a marked note. GPT-Live's prompt gives exact
  fillers ("One second." / «ثانية واحدة.»), forbids "I'll ask ..." of anyone, and names
  the agents (real API: 6 of 6 delegations, EN + AR, no third-person line). The
  summary guard passes a clause that restates one of the reply's plain sentences in
  other words (`restatesReply`); a summary cut part-way reads the rest of the reply
  word for word (`restOfReply`), never "the rest is on screen".
- Tests: `tools/test-voice-gptlive.cjs` (mock of the live protocol),
  `tools/test-voice-models.cjs` (the route opens a GPT-Live session),
  `tools/e2e-live-browser.cjs` (real API, headless Chromium: also the reply on screen).

### Live conversation

`lib/voice-live.js` (server), `public/voice-live.js` + `public/voice-live-worklet.js`
+ `public/voice-live.css` (page). M-3 Phase 1, option C of the full-duplex
proposal: you talk and the voice answers at once, and you can interrupt it --
while the voice model still never thinks or acts for JOYA AI.

**The switch.** Settings ▸ Voice (see *Voice: live conversation only*); in
the Command Center the mic starts a call for those with `joyaai.use` +
`voice.use`.

**How it works.** The page opens the mic with echo cancellation, noise
suppression and auto gain, and an AudioWorklet streams 24 kHz PCM16 in 20 ms
frames to `GET /joya-ai/api/live?csrf=…` (a WebSocket). The server relays it to
`gpt-realtime-2.1-mini` (server VAD at 700 ms of silence and threshold 0.7,
far-field noise reduction; `create_response` and `interrupt_response` off --
this server decides both, see *Self-hearing*)
with exactly two tools, `read_status` and `look_into`, dispatched only through
`voiceOps()` (`snapshot` / `send`); any other tool name is refused. The key never
leaves the server.

- **Guard before sound.** Each audio chunk is tagged with the sentence the
  model's own transcript is in when the chunk arrives (the transcript leads the
  audio by 40-360 ms, so that is the chunk's sentence or a later one) and held
  until that sentence has passed the output guard (`Releaser` / `judge()`: the
  sentences before it, the Arabic rules, fail-closed). The last sentence is
  judged as soon as `response.output_audio_transcript.done` arrives (unless it
  mentions a hand-off, which waits for the function calls). On a cut the held
  audio is dropped, the response cancelled, the item truncated at what was
  sent, the request passed to JOYA AI if it had not been, and the safe line
  read by the verbatim reader in the cut sentence's language (feminine /
  masculine / neutral from the saved persona).
- **JOYA AI's answers never come from the speech model.** The server polls the
  supervisor's snapshot for the reply to a hand-off; the reply goes through the
  guarded summary (`SUMMARY_INSTRUCTIONS` -> `judge()`) or, if short and
  plain, word for word, and each line is read by the verbatim reader into the
  same stream. The realtime conversation is then told (a system item) what JOYA
  AI said and what was heard.
- **Hand-offs carry this server's transcript.** At the end of each utterance the
  server transcribes the audio it relayed (a full-turn gpt-4o-transcribe since 2026-10-30)
  and sends that -- through the transcript guard -- never the model's `text`;
  the session's own transcription is the fallback. Measured on the mixed clip:
  the session transcript heard «ريكستور» / «ريكارك» for "restart", the full-turn
  one "restart" (twice out of two). Since 2026-10-22 both transcripts are
  candidates (`lib/voice-heard.js`): the full-turn one first, unless it does
  not read as Egyptian Arabic or English (another script, a Latin text that is
  not English -- «La parte más vital es difícil» reached JOYA AI that way) or is
  far too short for the speech in the turn («أريد أن أعود.» for 4.4 s), and the
  session's reads better or is clearly longer. When neither reads right, the
  audio is transcribed once more with the language pinned (the language the live
  voice understood the turn in, else Arabic). When the words may be misheard,
  a marked `[Voice: ...]` note follows the request: the other transcript and,
  only when no transcript reads right, what the live voice understood ("its own
  wording, not theirs"). The request itself is always a transcript, and one log
  line per hand-off names the sources and why (never the words). At most one hand-off per utterance. Spoken,
  it is first person ("Give me a moment, I'm checking."), true only while the
  call is really in flight; «تم تمرير الطلب لـ JOYA AI» and the like are cut
  (`third-person`, see *One identity*).
- **Barge-in.** When the administrator really talks over the voice (below),
  the server tells the page to flush (the playback worklet drops its buffer and
  answers with the millisecond it had played), cancels the response and
  truncates the item there (or at the page's last reported position after
  400 ms). Summaries being read stop too.
- **Self-hearing** (2026-09-29: on laptop speakers the voice heard itself and
  kept cutting itself off -- 13 phantom turns and 16 dropped empty turns in 6
  calls, each phantom a paid response). Four layers:
  1. *Echo-cancelled playback.* Chromium's echo canceller does not reliably
     cover Web Audio output. The player worklet now feeds a
     `MediaStreamDestination` -> a local `RTCPeerConnection` pair (loopback,
     never leaves the page; Opus 96 kbit/s) -> an unmuted `<audio>` element, so
     the canceller knows the audio and removes it from the mic. Falls back to
     `ctx.destination` if WebRTC is missing or does not connect in 3 s
     (`VoiceLive.route()`: `loopback` | `direct`, logged per call). The loopback's
     jitter-buffer delay (getStats) is taken off the played milliseconds, and
     on a flush the element is silenced for that delay so nothing buffered is heard.
  2. *Speakers mode* (half-duplex, **the default** until the loopback is proven
     on the administrator's laptop): while anything is audible and for 300 ms
     after, the server does not relay the mic at all. Interrupt with a tap on
     the bar's text, Space or the mute button (both interrupt while it speaks),
     or Esc (it only interrupts; the red X ends the call). *Headphones
     mode* (full duplex) is a toggle in the live bar (remembered per browser,
     `localStorage` `joya-live-duplex`) and the default in Settings ▸ Voice >
     *Live conversation audio* (`POST /joya-ai/settings/voice/live-audio`,
     `duplex=speakers|full`, `noise=far_field|near_field|off`, audited; setting
     `voice_live_audio`). The bar shows which mode is on.
  3. *Guarded barge-in* (headphones mode). The VAD's `speech_started` while the
     voice is audible is only a candidate. It becomes a barge-in when the page's
     detector (`public/voice-live-detect.js`, the same code the tests drive)
     says `voice`: at least 400 ms of mic level within 800 ms above
     max(6 x noise floor + 0.01, 2 x output level x the measured leak), never in
     the first 600 ms of a playback segment (that is when the leak -- mic /
     output -- is measured; the noise floor is learned while nothing plays, and
     never from speech). Speech that stops first is not a barge-in. A turn over
     the voice that the detector missed but that passes the guard still
     interrupts (a late barge-in).
  4. *Echo guard before the answer.* `create_response` is off. A turn that
     started over (or within 1.5 s after) the voice and was not a confirmed
     barge-in is held for its transcript: empty, refused by the transcript guard,
     or one or two words -> `echo-leak`: no response is created (nothing paid),
     and its item is deleted while still the last one (the cached prefix
     survives). A real-length turn (>= 450 ms) nowhere near the voice is
     answered at once, as before. Two echo-leaks within 10 s in headphones mode
     make the page offer speakers mode (a small non-blocking prompt).
  Logged: each call's mode, playback route and noise reduction; barge-in
  candidates and confirmations with the ms into playback; phantom turns; mode
  switches; the end-of-call line counts barge-ins of candidates and phantoms.
  A `response.done` that arrives twice for one response is billed once (it had
  been: `voice_usage` rows 439/440, 462/463, 499/500, 535/536, +$0.0252 of
  the day's $0.2608 live total, 9.7%).
- **Also:** the echo guard (a transcript matching what the voice said in the
  last 30 s is dropped and the item deleted; over the voice, 70% of its words
  being the voice's is enough); the spoken stop command (`public/voice-stop.js`, English and Arabic,
  polite forms) ends the call; one call per user, at most 4 at once, 20 minutes
  a call, frames of at most half a second, no more than twice real time; the
  saved persona is in the instructions and refreshed when it changes.
- **Usage.** Every response's `usage` is priced (gpt-realtime-2.1-mini's list
  prices, read 2026-09-29) into `voice_usage` with category `live`, part
  `realtime`; transcriptions and the readings are their own rows. Shown as
  *Live* in the Cost today card.

**What cannot be guaranteed.** The guard reads the model's transcript of its
audio, not the audio itself; audio that differs from its own transcript would
be heard. JOYA AI's answers never take that path.

**Self-hearing, measured (2026-09-29, real API, stubbed supervisor, same clips,
6aeca3c vs this change).** First audio after the end of speech: English 1.42 ->
1.16 s, Egyptian 1.79 -> 1.93 s, mixed (a guard cut and hand-off) 2.92 -> 3.34 s --
no added latency, the fast path answers clean turns at once (waiting for every
transcript had cost +0.7-0.85 s: 2.15 / 2.64 s). Barge-in with a choppy "Wait,
stop, never mind" over the voice (headphones mode): VAD candidate after
209-235 ms as before, flush 640 ms after the talking-over began (was 184-197 ms
with no guard). Speakers mode interrupts on a tap at once. Measurement cost $0.17.

**Measured (2026-09-29, real API, stubbed supervisor, TTS clips).** End of
speech to the first audio the page plays, including the 700 ms VAD, a
`read_status` round trip and the hold: English 1.0 s, Egyptian 1.75 s, mixed
1.46 s. Hold per chunk: median 186 ms, p90 463 ms. Barge-in: the upstream VAD
reported speech 183-191 ms after the talking-over began (286-636 ms while a
reader line played); the flush reaches the page at once after that. Cost:
$0.004-0.011 per turn (Arabic answers run longer), about $0.03 a conversation
minute: ~$0.55 for 20 minutes a day, ~$1.7 for 60.

**nginx.** No change is needed: `/etc/nginx/joya-proxy-params` (both the `:8443`
and the `joya.example.com` vhosts) already sends `proxy_http_version 1.1`,
`Upgrade $http_upgrade` and `Connection "upgrade"`. Its `proxy_read_timeout 60s`
would cut a quiet call; the server pings every 15 s, which keeps it open. If a
longer idle is ever wanted, the location to add (before `location /`) is:

```nginx
location = /joya-ai/api/live {
    proxy_pass http://127.0.0.1:3000;
    include /etc/nginx/joya-proxy-params;
    proxy_read_timeout 1300s;   # a 20-minute call and a margin
    proxy_send_timeout 1300s;
    proxy_buffering off;
}
```

**Integration contract** (for any page, e.g. the Joya rebuild). Load
`voice-live.css`, `voice-live-detect.js` and `voice-live.js` (in that order,
before the page's own script); render `data-voice-live="1"` when the server's
`voicePublic(req).live` is true, `data-live-worklet="${asset("voice-live-worklet.js")}"`
and `data-live-duplex="${voicePublic(req).liveDuplex}"` (the Settings default); then:

```js
if (window.VoiceLive && VoiceLive.supported() && root.getAttribute("data-voice-live") === "1") {
  VoiceLive.start({
    csrf: root.getAttribute("data-csrf"),
    worklet: root.getAttribute("data-live-worklet"),
    duplex: "speakers",   // or "full" (headphones); this browser's choice, else data-live-duplex
    onState: (s) => {},   // connecting | listening | talking | thinking | speaking | interrupted | waiting | muted | ended | error
    onCaption: (c) => {}, // {who: "you" | "desk" | "joya", text, final}
    onLevel: (l) => {},   // {mic, out}, 0..1-ish
    onEvent: (m) => {},   // every server message: ready {model, voice, duplex, noise}, asked, replied, stop, ended,
                          // error (code "busy": another tab), duplex {mode}, suggest {mode: "speakers"} (offer it)
  }).catch((e) => {});    // refused, no mic, or the call could not connect
}
VoiceLive.stop();          // hang up
VoiceLive.mute(true);      // hard mute; VoiceLive.muted(), .active(), .state()
VoiceLive.interrupt();     // stop the voice now (tap / Space / Esc); false if it was not speaking
VoiceLive.duplex("full");  // switch mode mid-call; .speaking(), .route() ("loopback" | "direct")
```

Map `listening`/`talking`/`interrupted` to the core's *listening*, `thinking`
to *thinking*, `speaking` to *speaking* (the caption: `onCaption` text of
`who !== "you"`, word by word), `waiting` to *delegating* (to JOYA AI); flash
the voice bar on `interrupted`; feed `onLevel` to the core's amplitude. The
mic starts a call (no key does); during one Space mutes and unmutes it and Esc
ends it; while the voice speaks, Space (speakers mode) and Esc interrupt it
instead, and the hint row says so. `#cc-live-duplex` (in `#cc-live-acts`, before mute) shows
and switches the mode; its label goes at ≤1100 px.
During a call the voice bar is one row inside the pill (2026-09-29, after the
administrator's report of chips overflowing it and two X buttons): the status
text (it takes the room, with an ellipsis), the wave, then `#cc-live-acts` --
mute and End -- at the right. The route, the tags and the bar's own X are
hidden (End ends the call);
narrower screens drop the wave (≤1000 px), End's label (≤720 px) and the tag
(≤420 px). The page's grid column is `minmax(0, 1fr)`, so no bar can widen the
page on a phone. The Command Center's own
wiring is the block marked `LIVE CONVERSATION` in `public/joya-ai.js`.

**The Egyptian evaluation** (`lib/voice-live-eval.js`). Administrators open
**`/joya-ai/voice-eval`** (also linked from Settings ▸ Voice), record the
20 phrases in their own voice (Egyptian, MSA, English and mixed: status
questions, an action request, stop commands, small talk; kept in
`DATA_DIR/voice-eval/<user id>/`), tick the models (gpt-realtime-mini,
gpt-realtime-2.1-mini, gpt-realtime-2.1) and voices (marin, cedar) and press
*Run*: each phrase goes through a real live session with a stubbed supervisor
(nothing reaches JOYA AI) and the page shows one row per model and voice --
first audio, hold, transcription CER (session and full turn), guard cuts,
hand-offs and stops right, dialect right, cost -- with the per-phrase detail
underneath (saved as `results.json` / `results.md`). The same from a shell:
`sudo NODE_PATH=/opt/joya-dashboard/node_modules node
dashboard/tools/voice-live-eval.cjs --dir <that folder>` (or `--self-test` for 2-3
TTS clips).

Tests: `node dashboard/tools/test-voice-live.cjs` (a mock realtime server with
the real event shapes: the session's configuration, the sentence hold,
cross-sentence and Arabic cuts and fail-closed, the tool whitelist, hand-off
grounding (the paraphrase sends exactly the transcript), JOYA AI's answers via
summary and reader only, barge-in (flush, cancel, truncate at the played ms),
self-hearing (the detector; speakers mode's gate and tap interrupt; candidates,
confirmation, echo-leak turns, the suggestion, the late barge-in, when the answer
is asked for, a duplicate response.done billed once; and a real-time loopback
simulation in which the voice's own audio fed back as the mic makes the mock VAD
fire but never interrupts, while real speech over it interrupts in ~0.4 s),
the stop command, the echo guard, usage rows, the persona, the maximum length;
then the WebSocket route on the real server from a scratch copy that cannot
reach the helper: auth, CSRF, origin, the mode, one call per user, frame size,
the evaluation page's API).

### Call reliability (2026-09-30)

The diagnosis of calls that ended on their own (46 endings in 26 h: 26
"hung-up", 13 "upstream", 5 voice-command, 2 joya-ended) found the upstream
close reasons thrown away, the firewall seeing OpenAI's IPv6 packets 13-21 s
after our side's TCP connection had died, a page.open that ended the call, a
double click on the mic that landed on the red X, Esc ending calls, and every
guard cut handed to JOYA AI. What changed:

- **Why a call ended is logged.** `live: call <id> ended (<why>: <detail>)`:
  the upstream close code and reason with the socket error's code and the last
  event OpenAI sent (`upstream lost: code 1011 "..." , after N s, last event
  ...`); the page's own reason (`{type: "end", why}`: `button`, `mic`, `esc`,
  `navigate`, `unload`, `track-ended`, `devicechange`, `error:<msg>`; anything
  else is `unspecified`), also by `navigator.sendBeacon` to `POST
  /joya-ai/api/live/end` on pagehide; a page socket that just goes away is
  `page-closed: code <n>` (no longer "hung-up"); a spoken stop logs its phrase.
  The audit line carries the reason and the number of upstream reconnects.
- **The upstream leg is kept alive and replaced when it drops.** IPv4 only for
  the OpenAI WebSocket (`family: 4`; `JOYA_OPENAI_IPV4=0` turns it off); a
  ping every 10 s, and a leg silent for 25 s (no pong, no event) is dropped;
  an unexpected close reconnects through `swapUpstream()` with a recap of the
  last six lines heard and said, and the voice says "The line dropped for a
  second — I'm back." («الخط قطع لثانية، وأنا معاك تاني.» in an Arabic call).
  At most two a minute: a third ends the call "upstream" with the reason
  shown. Opening a session is tried twice, 0.8 s apart.
- **page.open never ends a call.** "command-center" became "cc" in the page
  map, which the Command Center's special case missed: now `cc` and every
  `cc.<sheet>` open right here; anything else opens in the shell's frame, and
  without it (or when the shell refuses a url) a link is shown -- the tab is
  never moved while a call is on, and the shell toast's Open refuses a
  whole-tab move during a call. `tools/test-live-reliability.cjs` checks every
  key of the page map.
- **The page says why** a call ended (a toast with Reconnect, on the Command
  Center or on the dock), a start that fails says so, the microphone's track
  ending or a device change reopens the mic once (else the call ends with that
  reason).
- **Screen actions are confirmed by this server.** After the page's `ui-ack`
  says ok, the server says the fixed line ("Opened Agents & sessions.",
  «فتحت Agents & sessions.») and the model is not asked for another round; "I'll
  open the missions" is backed by a ui_action call in the same response (held
  until the calls are known); "the agents dashboard is open" passes after an ok
  screen action; "JOYA AI OS" (and "JOYA AI's OS", "Joya AIOS") is the product.
  A cut response that called a tool runs its calls and hands nothing to JOYA
  AI; only a cut with no tool call is handed on (still with this server's
  transcript).
- **Repeats and late answers.** Every hand-off carries the call id; the
  supervisor folds a repeat from the same call that is still queued (within
  `voice_merge_s`, 20 s) into that turn. A result for an older question (newer
  words since, or 45 s) is introduced: "About your earlier question:".
- **Restarts.** On SIGTERM every page is told `{type: "restarting"}` before its
  call ends, and comes back by itself (1, 2, 4, 8, 15 s) with
  `?resume=restart`, the voice saying "Reconnected.". The open calls are in
  `$JOYA_DATA_DIR/live-calls.json`, which `deploy/deploy-dashboard.sh` and
  `deploy-joya-ai.sh` read to warn (and pause 10 s; `JOYA_DEPLOY_NOWAIT=1`)
  before restarting anything. At start the dashboard sends the supervisor a
  `deploy-event` with the commit and time the deploy script stamped in
  `DEPLOYED`; JOYA AI gets it with its next turn.

Tests: `node dashboard/tools/test-live-reliability.cjs`.

### Screen control by voice (UI control, Phase 1: the desk's `ui_action`)

The administrator: *"Ideally, I want Joya AI to be able to do everything on the
front end here as well."* The live voice has a third tool,
`ui_action`, from one shared allowlist, `public/ui-actions.js` (pure, required by
the server and loaded by the page, so both refuse the same things):
`call.end`, `call.mute` (mute only -- **unmute is by hand**), `call.interrupt`,
`voice.mode` (ptt / handsfree / live), `sheet.open` (the dock's sheets and
Everything), `sheet.close`, `view` (map / missions), `core.set` (A/B/C/D),
`reply.show`, `reply.read`, `decision.show` (shows the card; **Approve stays a
human click**), `settings.open` (a fixed list -- voice, account, voice-eval --
offered as a link in the toast, never navigated to by itself). Nothing else has
a name: no approve/deny, keys, users, rules, gate, settings values, restart or
deploy.

- **Live call:** `call.*` act on the call on the server (`call.end` ends it after
  the goodbye has played); the rest go to the tab that holds the call over its own
  WebSocket (`{type:"ui", nonce, action, args, toast}`); the page checks the
  allowlist again, acts through the same functions the buttons use, and answers
  `ui-ack` -- no answer in 3 s, or a refusal, and the tool returns *refused*.
- **Voice off** (Settings ▸ Voice): `call.*` and `voice.set` are refused, on the
  server (opening a confirm, JOYA AI's own, and the confirm itself) and on the page.
- Only in a turn the administrator really started (a transcript this server
  heard); at most 6 actions a turn and 20 a minute, `call.end` and
  `settings.open` once a turn; audited (`joya-ui` in the sign-in log); every one
  shown as a toast ("Joya opened Missions"), with **Undo** for sheets, view, core
  and voice mode.
- **The guard:** "I opened Missions" / «فتحتلك الـ missions» / "I muted the
  microphone" is spoken only when a `ui_action` in this turn returned ok
  (`ui-claim` otherwise); a bare "... and restarted Odoo" after a first-person
  clause is still an action claim.
- **Undo by voice:** while the last screen action's toast still offers Undo
  (15 s), saying "undo", "undo that", "go back", "never mind", "cancel that",
  «رجّعها», «رجع», «ألغي ده», «لأ خلاص», «ارجعي» (the whole utterance, as with
  the stop command: `VoiceStop.undo()` in `public/voice-stop.js`) runs that same
  Undo -- in a live call (the page tells the call `ui-undoable`; the server
  drops the turn and sends `ui-undo`). With nothing to undo the words go on as an
  ordinary turn; "undo the last git commit" is always a request.
- **JOYA AI itself (Phase 2):** its MCP tool `ui_action` reaches the tab that
  asked, and only that tab. The page sends a per-tab id (`sessionStorage`
  `joya-tab`) with every send, live call and on its event stream;
  this server mints a one-time token for each send (`lib/ui-relay.js`, in
  memory, 1 h at most) and passes it to the supervisor; the supervisor's live
  `ui` event names only a tag of it. The tab's stream acts on it once; call.*
  go to that user's live call (`LiveCall.deepUi`), the rest to the page, which
  answers through `POST /joya-ai/api/ui/ack` (CSRF'd, only a nonce delivered to
  that user). A tag this server never minted -- a `send` forged straight onto
  the supervisor's socket -- is dropped and audited ("never minted").
- **Preferences (Tier 2, Phase 3):** `theme.set` (system/dark/light),
  `persona.set` (the voice persona presets, or learned) and `voice.set` (the
  voice's sound -- global: once applied, every open live call reconnects its
  upstream with it and goes on; the confirmer's call says "I switched my voice,
  this is my new voice." in it, the others get a toast) are never applied by
  the model. The server opens a pending confirm (`lib/ui-confirm.js`: one per
  user, 30 s, audited) and the tab shows "Joya asks: Switch the voice to cedar?
  Confirm / Cancel". It is applied only after a click on Confirm, or when the
  administrator's NEXT utterance -- as this server heard or received it (the
  live call's transcript, or /send), never the model's words
  -- is a whole "yes" (`VoiceStop.yes()`: "yes", "go ahead", «أيوه»,
  «اعملها»...). A whole "no" («لأ», "cancel") cancels it; anything else drops
  it and goes on as a normal turn; in a live call only a later, non-echo turn
  counts, and nothing is answered early while it waits. The page then takes it
  once (`POST /joya-ai/api/ui/confirm`) and applies it through the existing
  CSRF'd, `voice.manage`-checked routes (`/joya-ai/settings/voice/persona`,
  `/options` -- a voice.set posts only the voice -- which answer JSON when asked) or the theme switch itself.
  The voice and JOYA AI are told `status: "confirm"`: nothing changed yet, and
  "I switched the voice" is cut (ui-claim) until it is. Tier 3 (keys, users,
  roles, 2FA, rules, watchers, voice mode, budget, orders, restart, deploy) has
  no action names at all.
- **Closing a panel:** `sheet.close` may name the panel ("close the missions",
  «اقفلي المهام», «اقفل الميشنز»); the page refuses when another is open. The
  tool's description gives the Arabic panel names (المهام / الميشنز, الجلسات /
  السيشنز, القرارات, التكلفة ...) and says a panel close is never ending the call.

Tests: `tools/test-ui-actions.cjs` (the allowlist, the tool schema, rate limits,
the claim words), the `ui_action` sections of `test-voice-live.cjs`.

### Themes

System (the default), Dark and Light, from a switch in the top bar of every
page. `public/theme-init.js` applies the saved choice (localStorage
`joya-theme`, guarded) before first paint; `app.js` wires the switch; System
follows `prefers-color-scheme` live. The whole panel's palette is custom
properties in `style.css` -- the rules use tokens only (QR codes excepted,
which must stay white). The Command Center has its own HUD palette in
`joya-ai.css`, dark and light, which wins over the site's on this page.

Tests: `node dashboard/tools/test-joyaai-page.cjs` (the page's frame, CSP
safety, escaping, the tab, the palette, the client's pure helpers).
