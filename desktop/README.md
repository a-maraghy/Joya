# JOYA AI for Windows (the desktop app)

The Command Center without its page: the JOYA AI core, the session spheres, the chat, the voice and the
approval cards straight on the Windows desktop. Design (approved 2026-10-07):
`Joya/mockups/desktop-app/DESIGN.md` and its mockup.

It is a small Tauri 2 app (WebView2, about 10 MB) around **the site's own page**: one transparent,
frameless window shows `https://joya.example.com/joya-ai?shell=desktop`, the Command Center's desktop
render mode (`dashboard/lib/views-joyaai.js`, `dashboard/public/joya-desktop*.{js,css}`). Every fix to the
Command Center reaches the app without a new release. Sign-in is the site's: password, then Windows Hello.

## What the app adds (src-tauri/src)

| File | What |
|---|---|
| `lib.rs` | The window, the three modes, tray and menu, hotkeys, toasts, the click-through and environment loops, updates, the commands the page may call |
| `layout.rs` | Window geometry per mode, size (S/M/L), corner, monitor and DPI; corner snapping after a drag |
| `companion.rs` | Companion mode (pure; simplified in 0.1.13): the monitor it lives on (the window in front's, else the cursor's, or one with "stay on this monitor"), its window at the top centre of that monitor's work area (per-monitor DPI), the settle-and-fade move to another monitor, ducking out (full screen on its monitor, the lock screen) |
| `presence.rs` | Eye contact (pure; mockups/eye-contact/DESIGN.md): camera presence's setting (off by default), the WebView2 permission policy (the camera only for the site, only while on), the profile's stored camera permission, what the page may change (only off), the tray switch, the reload guard |
| `companion_host.rs` | Companion mode in the app: its loop (own thread) reads the monitors and the window in front, places the small window, keeps it on top of every app (HWND_TOPMOST again when the window in front changes and every 3 s; asynchronous, no activation), tells the page to fade (fade-out / fade-in, duck / pop) |
| `hit.rs` | Per-pixel click-through: is the cursor on a region the page reported (rounded rectangles / circles)? |
| `blur.rs` | Real blur behind the cards (pure): when it is drawn (setting, Windows build, transparency effects, high contrast, opacity, dragging, scale), where each acrylic window goes, the pool's next state |
| `acrylic.rs` | Real blur, Windows only: a pool of small borderless acrylic windows (the accent of SetWindowCompositionAttribute) right under the main window, one per glass surface the page reports, rounded like the CSS, following the main window through its own messages; never focused or clicked |
| `settings.rs` | The app's settings file (`%APPDATA%\com.joya.desktop\settings.json`), hotkey validation |
| `policy.rs` | When a toast is shown (only when JOYA AI cannot be seen; never in Do not disturb), the tray dot, when the core holds still |
| `signin.rs` | "Sign in in your browser": PKCE verifier/challenge and the loopback listener for the one-time code |
| `platform.rs` | Windows only: what is in front, full-screen apps, power, lock screen, wallpaper brightness (ink), the WorkerW layer |
| `trayicon.rs` | The tray icon's status dot |
| `site.rs` | The user agent (`… JoyaDesktop/<version>`) and the "stay on the site" rule |
| `capabilities/remote.json` | The **only** commands the site may call: hit regions, glass surfaces (real blur), status, needs-you toast, hide Peek, drag, the box's tools, the glance cards (show / hide, pin), the companion bot's click (open its Command Center), open the full Command Center, start the browser sign-in, events. Nothing that runs a program, reads a file or changes settings |
| `capabilities/local.json` | The app's own pages (`dist/`): the connecting/offline card and the Settings window |

`dist/index.html` is the first thing the window shows: "Connecting…" / "Offline — retrying in N s"; it
goes to the site as soon as the site answers (nothing typed is queued while offline).
`dist/settings.html` is the Settings window (tray ▸ Settings…).

### Modes

- **Floating** (default): a 480 × 580 box (S/M/L) in a corner, above every window, with 280 px of
  transparent headroom for a decision card. Drag the core to move it; it snaps to the nearest corner of
  the monitor it was dropped on. Its hover tools: drag, focus, size, hide.
- **Peek**: hidden until called (Ctrl+Alt+M, the tray, a toast's Open, holding the talk key), then over
  everything on the monitor under the mouse, with the composer focused and a light dim; Esc or a click on
  empty space hides it.
- **Desktop layer**: the whole work area at the **bottom** of the window stack (above the icons, below every
  window; Tauri's always-on-bottom keeps `HWND_BOTTOM`). While the desktop itself has the focus (Win+D, a
  click on the wallpaper) it comes up on top so it can be used, and goes back down when another window is
  focused. Ctrl+Alt+M raises it on top for a moment. **Experimental (off):** behind the icons (WorkerW) —
  no clicks reach it there.
- **Companion** (opt-in; tray ▸ "Companion: JOYA AI at the top of the screen", Settings ▸ Mode; simplified in 0.1.13 --
  the user: "I just want the core showing at the centre top of the screen, on top of all apps, always"): just the
  core (core E with your head and colours) in a small 176 × 160 logical-px window at the **top centre** of the monitor
  you are working on (the window in front's, else the cursor's), **always on top** of every app, click-through except
  the bot itself. Its states, eye contact's look-and-speak indications on its face and the "Camera on" pill (under it)
  as in the box. Switching monitors it fades out and back in on the other one (after 250 ms, so a quick Alt+Tab does
  not move it); it ducks out of a full-screen video, game or presentation on its monitor and comes back after. A
  click opens the Command Center as Peek. No real blur in this mode. Settings ▸ Companion: stay on this monitor
  (default off). 0.1.12's perching on the taskbar / windows, walking, stepping aside and session bots are gone (an
  old settings file loads; its perch / session bots / side are dropped on the next save). The page side
  `dashboard/public/joya-desktop-companion.js`; tests `dashboard/tools/test-desktop-companion.cjs`; screenshots
  `mockups/companion-simple/`.
- **Focus mode** (Ctrl+Alt+F): only the core.
- **Glance cards** (0.1.9; on by default): beside the core, the approvals waiting (Approve asks for Windows Hello
  first, as every approval does -- the server enforces it; Deny; Open = the decision card), the sessions (working /
  waiting on you / idle and the names that matter; a click opens one), today's tokens against the tightest daily cap,
  and live alerts (a session done or waiting on you, errors, approvals) from the Command Center's own event stream.
  Floating: a column beside the box on the side away from the screen edge (the window is `GLANCE_W` + `GLANCE_GAP` =
  268 px wider; the box sits at the edge end; layout.rs and joya-desktop-layout.js share the numbers). Desktop layer:
  beside the core, or dragged anywhere by its header and **pinned** there (per monitor, fractions of the work area,
  `per_monitor.glance_pin`). Shown / hidden by the tray item "Glance cards beside JOYA AI", Settings, the small button
  on the core's rim or the cards' X (`settings.glance`, command `set_glance`). Focus mode hides them. Each card is a
  hit region and a glass surface; the gaps between them let clicks through. Tests: `dashboard/tools/test-desktop-glance.cjs`.

Click-through: the page reports its interactive parts ~10× a second when they change (`set_hit_regions`);
a loop checks the cursor 30× a second and switches the window between catching and passing the mouse.

### Hotkeys (Settings ▸ Hotkeys, remappable)

Hold **Ctrl+Space** to talk (hold-to-talk on the live call; released = sent), **Ctrl+Alt+M** show/hide,
**Ctrl+Alt+F** focus mode, **Esc** (only while JOYA AI has the focus) hides Peek or ends a call.
If Ctrl+Space is taken by another app the talk key falls back to **Ctrl+Alt+Space** and a notification says so.

## Laptop control ("This computer", Path A — `src-tauri/src/machine/`)

The app can be JOYA AI's **machine agent**. Settings ▸ This computer pairs it with Joya once: a one-time
code (8 Crockford characters, `ABCD-EFGH`, 10 min) → `POST {origin}/machines/api/claim`
`{code, name, platform:"windows", app_version}` → `{machine_id, name, token}`. The token lives **only** in
Windows Credential Manager (generic credential "JOYA AI machine token (<host>)", local machine) — never in
settings.json, the log or the repo. The app then keeps one outbound WebSocket
`wss://<host>/machines/api/link` (`Authorization: Bearer <token>`; no inbound port): reconnects 2 s → 60 s,
lost after 60 s silence (the server pings every 10 s); a 401/403 on the upgrade or `{t:"revoked"}` deletes
the token.

| File | What |
|---|---|
| `machine/mod.rs` | The controller: link messages, start / stop, questions → cards, the hands' Host, the Settings commands, the pill's view / +15 / Stop, the lib.rs hooks |
| `machine/lease.rs` | The lease (pure): start / extend (≤ now + 60 min) / end (idempotent) / tick |
| `machine/wire.rs` | The messages (pure), ISO times, pairing-code and slug checks |
| `machine/claude.rs` | Claude Code (pure): where claude.exe is, the arguments, the MCP config, the stream-json conversation |
| `machine/prompt.rs` | The rules appended to the CLI's system prompt (pure) |
| `machine/mcp_http.rs` | The hands as MCP over HTTP on 127.0.0.1 (a new 256-bit bearer per lease; parse / auth / dispatch pure) |
| `machine/runner.rs` | The CLI process: no console, in a Job Object (KILL_ON_JOB_CLOSE) |
| `machine/link.rs` | The WebSocket thread (tungstenite + rustls, the Windows trust store) |
| `machine/overlay.rs` | The glowing frame (four thin click-through edge strips per monitor) and the pill (its own rounded shape, click-through; +15 min and Stop as two small windows), all plain Win32 layered windows drawn by the app before they show (no WebView2 since 0.1.7: 0.1.6's showed a white block), excluded from capture; logs each window's place |
| `machine/overlay_layout.rs` | Pure: the strips, the pill's layout at any scale, the shading (unit-tested in core-tests) |
| `machine/cred.rs` | Credential Manager |

**A session.** The server sends `start {slug, name, purpose, model, first_prompt, lease:{id, minutes, expires_at}}`.
The app starts the lease (minutes preferred over expires_at: a laptop clock that is off cannot shorten it),
shows the frame and pill, serves the hands (`crate::hands`) on loopback and runs Claude Code headless as
`joya-ai/bin/joya-session` runs a hired session: `-p --input-format stream-json --output-format stream-json
--verbose -n <name> [--model] --permission-mode default --permission-prompt-tool stdio --session-id <uuid>
--strict-mcp-config --mcp-config <only joya-hands> --allowedTools <the hands' tools> --add-dir Desktop,
Downloads, Pictures --append-system-prompt <rules>`, cwd Documents, files in Documents\JOYA AI; never
bypassPermissions or --dangerously-*. Git Bash missing → `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`. An npm
`claude.cmd` is run as `node …\cli.js`. The user signs in to Claude Code themselves; the app never touches
those credentials.
Every `can_use_tool` becomes `{t:"ask", origin:"cli"}` (denied at once without a lease or link; 10 min
timeout); the hands' own approvals are `origin:"hands"`; `result` → `{t:"report"}`; every non-hands tool →
`{t:"action"}`. app → server also: `hello {app_version, platform, host, user, home, claude}`, `lease`,
`cancel`, `session`. Messages queued while the link is down (except questions) go after the next `hello`.

**It stops** — the CLI's whole process tree killed at once, the MCP server closed, open questions denied,
frame and pill gone, `lease ended` sent — on: the local stop key (default **Ctrl+Alt+Esc**, fallback
Ctrl+Alt+Shift+Esc, Settings ▸ This computer, handled in the app with no server round trip), the pill's Stop,
the expiry, the lock screen, sign-out / shutdown / app exit (and if the app dies, the Job Object takes the
CLI with it), the link down for 30 s, the server's `stop` / `revoked`, unlinking, the CLI exiting. A second
`start` while one runs is answered `session failed "already under control"`.

**A start that cannot run fails loudly** (0.1.6; 0.1.5 dropped a `start` whose lease id was a JSON number
without a word): every `start` is logged on arrival; a frame the app cannot read is logged by its `t`, and an
unreadable `start` is answered `session failed`. Claude Code not found (looked for again first), the hands
server or the CLI not starting, the CLI ending before it answers `initialize` (reason = exit code + its first
stderr line) or not ready within 45 s → `session failed <plain reason>` at once (e.g. "Claude Code is not
installed on this computer — install it and sign in once by running `claude`"), the lease ended (`failed`),
frame and pill gone, a toast. `hello.claude` is `{found, path, version, git_bash}`, sent again whenever Look
again (or a take-over's re-check) finds it changed; Joya shows it on the Computers page and refuses a
take-over up front while it says not found. Lease ids may arrive as strings or whole numbers. The server
also ends a start the app has not acknowledged (`lease active` / `session starting`) within 60 s ("the
computer did not start the session"). **The site cannot start any of
this**: nothing machine_* is in `capabilities/remote.json`; the Settings commands are in `local.json`. The
pill is native (no page, no commands): its buttons call the controller directly.

**Asked once (0.1.7):** request_approval takes `delete_paths` (exact files). Once that card is approved,
the supervisor (joya-ai/lib/machines.js + machine-gate.js) lets the delete of exactly those files through
without a second card: this lease only, 5 minutes, each file once, a plain delete (no wildcards, pipes,
chained commands, -Recurse); anything else is a card as before and refusals still win. An older app's
one-file summary "Delete the file <path>" counts too. The session is told not to ask first for commands
that raise their own card.

**What the laptop session can do (0.1.11):** read, write and edit files; run PowerShell and other
commands; open files and apps with `Start-Process`; create Word / Excel / PowerPoint files with
`create_document`; read and edit existing ones (`office_read` / `office_edit`); read and merge PDFs and make
a PDF from an Office file (`pdf_read` / `pdf_merge` / `pdf_export`); use the user's own Chrome through their
Claude in Chrome extension; `request_approval`; `wait`. Outside Chrome it has **no** screen, mouse or keyboard
control and takes no screenshots. The MCP tool text, `firstPrompt`, the CLI prompt, JOYA AI's CLAUDE.md and
the Computers page say exactly this (tests check it).

### Laptop control 2 (0.1.11): Office and PDF files, Chrome, the action log — design note

Built on 2026-10-20 at the user's request ("finish laptop control"). **Not built, on purpose:** generic screen
capture, mouse or keyboard control (the earlier build was stopped there by a safety check; nothing here works
around that). Office goes through files and COM, the browser only through the user's own Claude in Chrome
extension.

| File | What |
|---|---|
| `hands/mod.rs` | The tools: create_document, office_read, office_edit, pdf_read, pdf_merge, pdf_export, request_approval, wait. Every path through `paths.rs`, then again after links on disk are resolved (a junction cannot lead out). An existing file is only written over after the hands' own approval card ("Replace a file", Windows Hello); by default the result is a new copy next to the original (`Report (edited).docx`, then ` (2)`…), written to a `~joya-*.ext` temp file and renamed into place. |
| `hands/paths.rs` | Pure: the allowed folders (Documents, Desktop, Downloads, each OneDrive the environment names, the folders the user added on the Computers page), `..` resolved before the check, no UNC / device / ADS paths, no hidden or AppData folders; the kinds (macro-enabled `.docm/.xlsm/.pptm…` refused, old `.doc/.xls/.ppt` refused). |
| `hands/ooxml.rs` | Pure, the **file engine**: the zip unpacked, only the XML parts that change edited by splicing (every other byte kept), zipped again. Word: replace across runs (the text of one paragraph's runs, the new text into the run where a match starts), set / insert (with a style from styles.xml) / delete paragraphs (a table cell keeps one); Excel: set a block of cells from a top-left cell (text as inline strings, numbers, booleans, `=formulas`, styles kept), add a sheet; the calc chain is dropped and `fullCalcOnLoad` set; a shared/array formula's master cell is refused; PowerPoint: replace, set title / bullets / notes, add a slide on the deck's "Title and Content" layout, delete a slide (its notes, rels and content types with it). Reading lists numbered paragraphs / cells with formulas / slides with notes. A package with a vbaProject is refused; zip-bomb limits (20 000 parts, 400 MB). Checked with python-docx / openpyxl on the build box (`write_edited_samples`). |
| `hands/office.ps1` + `hands/office_com.rs` | The **Office engine** (default when that Office app is installed: its COM class is registered): one fixed PowerShell script, never built from the model's words — `powershell -NoProfile -NonInteractive -EncodedCommand <bootstrap>` reads two base64 lines from stdin (the script and the job as JSON) and answers one base64 JSON line. In the session's Job Object (`Proc::contain`; the stop key kills it), 180 s limit. `AutomationSecurity = 3` (macros forced off) before anything is opened, events and alerts off, links not updated, the original opened **read-only** with a dummy password (a protected file fails instead of prompting) and saved to the temp file (`SaveAs2` / `SaveAs` / `ExportAsFixedFormat`); Word / Excel instances it started are quit; PowerPoint (one instance per user) is quit only if it was not running, and its AutomationSecurity put back. COM starts Office outside the Job Object, so the app also keeps track of the Office apps a take-over **started** (`office_com::job_begins` / `job_done`: WINWORD / EXCEL / POWERPNT processes that appear during a job with svchost.exe — DcomLaunch — as parent, by pid **and** creation time) and, when the take-over ends (stop key, Stop, expiry, link lost, sign-out: `hands::shutdown`), closes those still running, including one a job cut short was starting; Office that was running before, or that the user opened from the Start menu meanwhile, is left alone (user, 2026-10-20). **The user's own work is never lost** (`office_com::end_plan`): office.ps1's `inspect` asks COM (`GetActiveObject`) for the instance and its open files; when its window belongs to the take-over's process and a file is open that the take-over did not open (its `src` / temp `out` paths — PowerPoint is one instance per user, and a Word / Excel file can open into a hidden instance), only the take-over's files are closed without saving (`close_own`) and the app keeps running; with only its own files (or none) it is asked to `quit` (no save prompts) and force-closed if still running after 5 s; one COM cannot reach is left running if it has a visible window, else its windows get WM_CLOSE and the same 5 s. `close_own` / `quit` act only while the instance's window handle is still the one `inspect` saw. Each step is a line in the app log ("end of the take-over: …"). Word paragraph edits carry the text office_read showed (`expect`, from a dry run of the same edits in the file engine) because Word numbers paragraphs in tables a little differently. If Office fails under engine "auto", the file engine does the edit and says so. `pdf_export` needs Office. |
| `hands/pdf.rs` | Pure (lopdf 0.44): text per page, merge (inherited Resources / MediaBox moved onto each page; the catalog's OpenAction, AA and Names dropped, so no document script is carried across). Protected PDFs refused. |
| `machine/browser.rs` | Pure: the extension's check (`<User Data>\{Default,Profile N}\Extensions\fcoeoabgfenejglbffodgkkbkcdhcgfn` in Chrome, Edge, Brave, … — the CLI's own check), the `--settings` ask rule, a tracker of element labels (`ref_N` lines of read_page / find results) and tab addresses (tabs_context JSON), the steps the app refuses at once (Joya's own pages, typing into password / PIN / card fields, card numbers — also inside a browser_batch), the hint sent with a question, the log line ("Chrome: left click button "Send" — Sends the reply"). |

**The browser.** The CLI is started with `--chrome` (only when the extension was found and the user did not
switch the browser off on the Computers page; else `--no-chrome`) and always with
`--settings {"permissions":{"ask":["mcp__claude-in-chrome"]}}`: an `ask` rule wins over any `allow` in the
user's own Claude settings (tested on the build box with Claude Code 2.1.283: allow + ask → asked), so **every
browser step comes to this app** as a permission question (the app is the CLI's permission prompt, stdio). A
PreToolUse hook was considered and not needed: this is the same point (before the tool runs), with no extra
process. The app refuses the never-cases itself, then asks Joya with the hint; the supervisor's gate
(`joya-ai/lib/machine-gate.js decideBrowser`) lets reading, tabs, scrolling, screenshots, plain typing and
opening web pages run (`auto`) and puts on a card (Windows Hello) a click or form choice whose target label
or `action_summary` says send / submit / buy / pay / post / publish / delete / sign up / confirm /
accept (EN + AR), a click nobody described, Enter / Ctrl+Enter / Alt+S, text with a newline, javascript_tool,
file uploads, saved shortcuts, switching to another computer's browser and non-web addresses; it refuses
passwords, payment details and Joya's pages again. **Signing in is not a card** (user, 2026-10-20):
`SIGN_IN_PHRASES` (sign in, log in, continue with Google / Microsoft / Apple, تسجيل الدخول …) are taken out of
a step's words before the risky words are looked for, so "Sign in" runs while "Sign in and pay", "Sign up" and
"Sign the contract" still ask; typing into a password, PIN, code or payment field is still refused. A browser_batch is the strictest of its steps. The step
itself raises the card, so the session is told **not** to call request_approval first (the user would be
asked twice — the 0.1.7 lesson). Whether the extension answers is learnt from the steps' results
(`{t:"browser", connected, detail}`) and shown on the Computers page with the steps to set it up.

**The action log.** Every step — the hands' tools, the browser steps, the CLI's commands — is one
`{t:"action", lease_id, slug, at, tool, target, decision: auto|approved|denied|refused, result: ok|error,
detail, kind: hands|browser|cli}` (an older server reads `summary`/`decision`). `auto` vs `approved` comes from
Joya's answer (`answer.auto`: its rules let it run, no card). The dashboard keeps it in joya.db table
`machine_action_log` for **90 days** and shows it per take-over on the Computers page, live (polling
`/machines/api/lease/:lid?after=<id>` every 2.5 s). The pill shows the last one on a second line ("Last: …").
No screenshots are taken; the old `machine_actions` table (screenshots, 7 days) is only read for old
take-overs.

**Wire additions (all optional, older peers ignore them):** hello `chrome {extension, browser, profile, last}`
and `office [..]`; `start.folders [..]`, `start.browser bool`; `answer.auto`; `ask.hint {targets, tab_urls}`;
`action` fields above; `{t:"browser"}`. Supervisor: `machines-sync` items gain `chrome`, `folders`, `office`;
`machine-ask` gains `hint`; `machine_list` reports `browser` and `office`.

## Server side (dashboard)

- `/joya-ai?shell=desktop` — the render mode. `lib/views-joyaai.js` (`shell: "desktop"`),
  `public/joya-desktop-layout.js` (the layouts, shared with the tests), `public/joya-desktop.js` (layout,
  bubbles, hit regions, bridge), `public/joya-desktop.css`. Hooks in `joya-ai.js` (`DESK`: core placement,
  recent turns, deny from a toast, hold-to-talk) and `cc-map.js` (`layoutOverride`).
- Hold-to-talk: `lib/voice-live.js` turn mode `"ptt"` (no server VAD; the key's press clears the input and
  stops the voice, its release commits the turn; the committed item goes through the same guard and
  hand-off path; a slip under 200 ms is not a turn; a warm call with no press for 3 min ends). The page
  (`public/voice-live.js` `press/release`, `joya-ai.js` `pttPress/pttRelease`) keeps the call warm for 60 s
  after the last release. Only the desktop page asks for it; the web Command Center is unchanged.
- `lib/desktop.js` — app sessions last **14 days** from sign-in (Settings ▸ General ▸ Desktop app, 1–90),
  the browser hand-off (`/desktop/link`, `/desktop/redeem`; one-time code, 2 min, bound to the app's
  PKCE challenge), the update feed (`/desktop/latest.json`, `/desktop/files/<name>`, public; `/desktop/` the
  download page, signed in). The app's user agent only changes the look and the session length.
- Sign-in pages in the app (`lib/views.js` `desktop`): a floating card, the grey still core, "Sign in in
  your browser".

## Building (Linux → Windows)

All user space, nothing installed system-wide:

```
# once: Rust + the Windows target, cargo-xwin, tauri-cli
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target x86_64-pc-windows-msvc
cargo install --locked cargo-xwin tauri-cli@^2
# once: clang/lld/llvm, NSIS, osslsigncode from Ubuntu packages, extracted (not installed)
mkdir -p ~/.local/wintools/debs && cd ~/.local/wintools/debs
apt-get download nsis nsis-common clang-18 lld-18 llvm-18 llvm-18-linker-tools libclang-common-18-dev osslsigncode
for d in *.deb; do dpkg -x "$d" ../root; done
# then link clang-cl/lld-link/llvm-lib/llvm-rc into ~/.local/wintools/bin and wrap makensis with
# NSISDIR=~/.local/wintools/root/usr/share/nsis (see the box's ~/.local/wintools/bin)

PW=/path/to/node_modules/playwright node desktop/tools/make-icons.cjs   # src-tauri/icons/ from the bot icon (head "cap"; 0.1.9)
desktop/tools/build-windows.sh --feed /tmp/joya-feed      # signed installer + update feed
node desktop/tools/test-feed.cjs                          # the feed tool
(cd desktop/core-tests && cargo test)                     # the app's pure modules (91 tests)
```

The installer: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/JOYA AI_<version>_x64-setup.exe`
(per-user install, no admin; WebView2 is part of Windows 10/11, the bootstrapper fetches it if missing).

### Keys (never in the repo)

`~/.local/joya-desktop-keys/` (0700) on the build box:

- `updater.key` + `updater.password` — the updater's minisign key. Its public half is in
  `tauri.conf.json` (`plugins.updater.pubkey`); the app refuses an update not signed with it. **Losing it
  means installed apps can no longer be updated** (they would need a manual reinstall with a new key).
- `codesign.pfx` + `codesign.password` (+ `codesign.key`, `codesign.crt`) — the self-signed code-signing
  certificate "Joya Desktop (self-signed)", 5 years; `joya-desktop-codesign.cer` is its public part.

### Trusting the self-signed certificate (once per computer)

On each of your machines, PowerShell **as administrator**, in the folder with the `.cer`
(also on https://joya.example.com/desktop/):

```
Import-Certificate -FilePath .\joya-desktop-codesign.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
Import-Certificate -FilePath .\joya-desktop-codesign.cer -CertStoreLocation Cert:\LocalMachine\Root
```

Check: right-click the installer ▸ Properties ▸ Digital Signatures ▸ "Joya Desktop (self-signed)" ▸
Details: "This digital signature is OK". SmartScreen may still warn the first time on a machine (it is
reputation based): More info ▸ Run anyway.

To remove the trust later: `certlm.msc` ▸ Trusted Root Certification Authorities and Trusted Publishers ▸
delete "Joya Desktop (self-signed)".

### Swapping in a real certificate later

`tools/sign.sh` signs with whatever PKCS#12 `JOYA_SIGN_PFX` points at. For an OV certificate in a .pfx:
put it in the keys folder as `codesign.pfx` (+ `codesign.password`) and rebuild. For a hardware token or
**Azure Trusted Signing**, replace the `osslsigncode` call in `tools/sign.sh` with the vendor's signer
(Azure: `jsign --storetype TRUSTEDSIGNING …` works from Linux), keeping the same one-argument interface.
Nothing in the app or the update key changes; installed apps update normally (the updater checks the
minisign signature, not the Authenticode one).

## Deploying (server)

1. Merge the branch; run the dashboard's suites.
2. `deploy/deploy-dashboard.sh` — only the dashboard restarts (live calls drop and reconnect).
3. The feed: copy the `--feed` folder to `/var/lib/joya-dashboard/desktop/` (owned by the dashboard's
   user): `latest.json` and `files/`.
4. No database migration: one new setting row (`desktop_session_days`) appears when changed.

## Limits and what is not verified yet

- Built and unit-tested on Linux only (`core-tests`: 91 tests of the pure modules; the dashboard's
  `test-desktop-shell.cjs` renders the page in headless Chromium). Everything Windows-specific —
  transparency and WebGL in WebView2, click-through, always-on-bottom and Win+D, WorkerW, global
  hotkeys and key-up, toasts, Windows Hello inside WebView2, DPI, the installer — is on
  `WINDOWS-TEST-CHECKLIST.md`.
- Settings `origin` exists for a test server, but the page's bridge (capabilities/remote.json) is granted
  to https://joya.example.com only; another origin loads without the bridge (no click-through info,
  no hotkeys into the page).
- Real blur (acrylic, 2026-10-08): the page reports its settled glass surfaces (`set_blur_rects`: the chat
  panel, the state pill, the chat / live buttons, the box's tools, menus, dialogs, the sign-in and offline
  cards, the approval card) and the app puts a native acrylic window under each (`blur.rs`, `acrylic.rs`);
  they take a lighter tint only once their blur is there. Windows 10 1809+ and Windows 11 alike (the accent
  API: Windows 11's system backdrop goes flat on windows that are never active). Off, unsupported, with
  transparency effects off, high contrast or opacity under 70 %: the tinted look. The session-name pills
  stay tinted (they move with their spheres). A shown blur window is never moved or resized (0.1.10): Windows
  draws the acrylic of a window moved while shown late, sometimes not again, which left grey corners and strips
  round the glance cards in 0.1.9; a surface that moves or changes size gets a fresh window. The page reports the
  viewport it measured in and the app shows no blur while its window is another size; a card cut by a scrolling
  box (the glance column) gets none. Unverified on real Windows: checklist 9b. Arabic/RTL and
  screen-reader behaviour of the desktop mode are not designed yet (as in the design).
- The talk key's release is Windows' `GetAsyncKeyState` poll (global-hotkey, every 50 ms) on the main
  key; releasing only Ctrl while still holding Space keeps talking until Space is released.
