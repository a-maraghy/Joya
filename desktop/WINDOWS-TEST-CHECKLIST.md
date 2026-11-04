# JOYA AI for Windows — test checklist (on a real laptop)

Nothing below could be run on the Linux build box. Tick each; note the Windows version (`winver`), the
GPU, and the scale (Settings ▸ Display) of each monitor. Prerequisite: the server changes are deployed
(the app shows https://joya.example.com/joya-ai?shell=desktop) and the feed is in /desktop/.

## 1. Install and trust
- [ ] Download the installer and `joya-desktop-codesign.cer` from https://joya.example.com/desktop/.
- [ ] Import the certificate (PowerShell as admin, both stores — see README "Trusting").
- [ ] Installer ▸ Properties ▸ Digital Signatures: "Joya Desktop (self-signed)", signature OK.
- [ ] Run the installer: no admin prompt (per-user); SmartScreen: note whether it warns.
- [ ] JOYA AI starts: Floating, bottom right of the primary monitor; tray icon (round Mesh) present; no taskbar button.
- [ ] Start menu ▸ "JOYA AI" exists; starting it again does not open a second copy (it shows the running one).
- [ ] Sign out of Windows and back in: it starts with Windows (Settings ▸ Start with Windows on).
- [ ] Uninstall (Settings ▸ Apps): app gone, tray gone, autostart entry gone.

## 2. Sign-in
- [ ] First start shows the sign-in card floating (grey still core above it), not a white page.
- [ ] Password, then **Windows Hello inside the app**: does the Windows Security prompt appear? (the spike question) → it lands on the Command Center desktop mode.
- [ ] If Hello does not appear: "Windows Hello does not show? Sign in in your browser" → browser opens /desktop/link → sign in there → Link → the browser tab says "you can close this tab" → the app is signed in.
- [ ] joya-ai.os ▸ Devices lists "JOYA AI desktop app on Windows".
- [ ] Settings ▸ General ▸ Desktop app shows 14 days. (Optional: set 1 day, check the app asks again next day; set back to 14.)
- [ ] Tray ▸ Sign out → sign-in card; tray item reads "Sign in with Windows Hello".

## 3. Floating
- [ ] Core, session spheres with names, state pill, composer are drawn with **no window frame or background**; the wallpaper shows between them.
- [ ] Click-through: click the desktop/icons/windows through every empty part of the box (including inside the box, between spheres); clicks land on what is underneath.
- [ ] The core, a sphere's name, the composer, the bubbles and the card catch clicks; typing in the composer works; Enter sends.
- [ ] Drag the core: the box moves; let go: it snaps to the nearest corner (try all four, and onto a second monitor).
- [ ] Hover tools (top right of the box): Focus, Size S/M/L cycles, Hide (Ctrl+Alt+M brings it back).
- [ ] Opacity (Settings): 35 % – 100 % applies at once, remembered per monitor.
- [ ] An approval card appears **above** the box (never over the core); Approve once / Always allow / Deny work.
- [ ] Stays on top of a maximised window; a full-screen video: the core holds still (GPU in Task Manager drops).

## 4. Peek
- [ ] Tray ▸ "Hidden until called (peek)": the layer disappears.
- [ ] Ctrl+Alt+M: it fades in centred on the monitor **under the mouse**, light dim behind it, composer focused.
- [ ] Esc hides it; a click on empty space hides it; Ctrl+Alt+M again hides it.
- [ ] (0.1.5) Peek hidden (Esc), then tray ▸ "On the desktop": it shows **at once**, on top, focused; click another app: it goes down to the desktop layer. Log line "mode Desktop from a hidden window: shown and raised".
- [ ] (0.1.5) Peek hidden, then tray ▸ "Floating, always on top": the box shows at once.

## 5. Desktop layer
- [ ] Tray ▸ "On the desktop": the core sits on the wallpaper at the right; **every other window covers it**; it never takes the focus.
- [ ] Win+D (show desktop): it is still there and **usable** (type in the composer); click any app: it goes back under the windows.
- [ ] Desktop icons stay clickable wherever JOYA AI draws nothing.
- [ ] Settings ▸ Desktop layer position Left / Centre / Right.
- [ ] Ctrl+Alt+M raises it on top; Esc lowers it.
- [ ] Experimental: Settings ▸ "behind the icons" on → it goes behind the icons (nothing clickable); off → back. Note the Windows build if it fails.

- [ ] (0.1.5) Windows scaling 100 %, 125 %, 150 % (Settings ▸ Display ▸ Scale), Desktop layer, open the chat: the message box shows the whole "Ask JOYA AI…"; the talk hint beside it reads "hold Ctrl Space to talk", or only the key caps, or is gone when there is no room — never over the placeholder or typed text. Same with the talk key on Ctrl+Alt+Space.

## 6. Hotkeys and voice
- [ ] **Hold Ctrl+Space**: state pill "Listening", core listens; speak; **release**: the turn is sent, core thinks then speaks the answer.
- [ ] Words appear as a bubble while/after you speak.
- [ ] Press Ctrl+Space while JOYA AI speaks: it stops at once and listens.
- [ ] A quick tap (< 0.2 s) does nothing.
- [ ] Talk again within a minute: starts instantly (warm call); after ~60 s idle the call hangs up by itself (server log: "ptt-idle").
- [ ] With Peek hidden, holding Ctrl+Space opens Peek and talks.
- [ ] In VS Code (Ctrl+Space = suggestions) — note the conflict; Settings ▸ Talk → Ctrl+Alt+Space works; reset.
- [ ] If another app already holds Ctrl+Space: a notification says JOYA AI uses Ctrl+Alt+Space.
- [ ] Tap the mic (no hold): a normal hands-free live call starts; mute / end as on the web. Hold the mic: hold-to-talk.
- [ ] First use asks no microphone prompt (granted to joya.example.com only); Windows' privacy indicator shows the mic only while talking.
- [ ] Ctrl+Alt+F: focus mode (only the core); again: back.
- [ ] Remap all three in Settings; the old keys stop working, the new ones work; duplicates are refused.

## 7. Toasts and tray
- [ ] Desktop layer covered by a window, a session asks for approval: a Windows toast "… needs you" with **Open** and **Deny** (no Approve).
- [ ] Open: JOYA AI comes up with the card. Deny: the approval is denied (the card and the Command Center say "Denied").
- [ ] Floating visible: no toast for the same event. Peek hidden: toast. Focus mode: toast.
- [ ] Tray ▸ Do not disturb: no toasts; the tray dot still turns amber.
- [ ] Tray dot: green listening/speaking, violet thinking/delegating, amber needs you, grey offline/signed out; tooltip says the state and sessions.
- [ ] Tray menu items all work: Show, Talk, the three modes, Focus, Monitor (with 2 monitors), Do not disturb, Open the full Command Center (opens the browser), Settings…, Sign out, Quit.

## 8. Several monitors and DPI
- [ ] Two monitors at different scales (100 % and 150 %): Floating is the same physical size relative to text on each; dragging it to the other monitor snaps to that monitor's corner.
- [ ] Tray ▸ Monitor picks the other monitor; unplug it: JOYA AI moves back to the primary.
- [ ] Change the scale of a monitor while running: it re-places itself.
- [ ] Click-through is exact on both monitors (the edges of the composer, the core's circle).

## 9. Ink, battery, offline
- [ ] Dark wallpaper: light text on dark pills. Light wallpaper: dark text on light pills. Change the wallpaper: within ~30 s the ink follows.
- [ ] On battery with Battery saver on (or Windows energy saver): the core holds still; plugged in: it moves.
- [ ] (0.1.5) Battery saver on in the app, nothing covering the core (Win+D, or Desktop layer with no window over it), all four cases, ~2 s each to settle: **battery + Energy saver on: still** · **battery + Energy saver off: still** · **plugged in + Energy saver on** ("Always use energy saver"): still · **plugged in + Energy saver off: moves**. With the app's Battery saver off: it moves in all four.
- [ ] (0.1.5) After that, read `%LOCALAPPDATA%\JOYA AI\logs\joya-desktop.log`: at start "power throttling (EcoQoS) off for this process: true", "notifications for power source / Energy saver / battery saver registered" (Energy saver "no notifications" only before Windows 11 22H2), "power at start: PowerReport {…}"; on each switch a "power: … -> …" line **within a second**, then "core holds still / moves (power notification): …" with the values. Send the log if any case is wrong.
- [ ] (0.1.5) Start the app **on battery** (quit, unplug, start): the core is still from the first frame and stays still after the page has loaded (it used to start moving once the page loaded).
- [ ] (0.1.5) Task Manager ▸ Details ▸ add the "Power throttling" column: JOYA AI.exe "Disabled"; the msedgewebview2.exe processes keep Windows' choice (often "Enabled" with Energy saver on).
- [ ] (0.1.8) Laptop + second monitor, Desktop layer, nothing full screen: the core **moves** (0.1.7 held it still because Windows said "busy"). The log has one "full screen: …" line per change, not one a second: "no full screen", or "Windows says busy, ignored: nothing full screen on JOYA AI's monitor (in front: …)".
- [ ] (0.1.8) A video full screen (F11 / YouTube full screen) on **JOYA AI's** monitor: the core holds still, the log says "full screen: holds still for full screen: a full-screen window (…) covers JOYA AI's monitor"; Esc: it moves again. The same video full screen on the **other** monitor: the core keeps moving. A window you work in on the other monitor no longer covers the Desktop layer (it keeps moving); one on JOYA AI's monitor still does.
- [ ] (0.1.8) Core E (Bot) over a bright / busy wallpaper and a dark one, in Mono and Default: a soft dark disc behind the heads when the bot is drawn light, a soft light one when it is drawn dark; the lines and the face read clearly. Mono is white on a dark wallpaper and black on a light one. The browser's Command Center looks as before.
- [ ] Lock the screen: the core stops (GPU idle); unlock: it resumes.
- [ ] Turn Wi-Fi off: "JOYA AI is not reachable" under a dimmed core; on again: it reconnects by itself.
- [ ] Start the app with Wi-Fi off: the "Offline — retrying in N s" card; Retry now works.
- [ ] Measure: Task Manager ▸ GPU for JOYA AI's WebView2 idle (Floating, Desktop layer), note % on each laptop.

## 9b. Real blur behind cards (acrylic)
Note `winver` (build). Settings ▸ Behaviour ▸ "Real blur behind cards" is on by default. Log lines start "acrylic:".
- [ ] The log says "acrylic: ready (Windows build …, transparency true, …)". If not: the log line says why.
- [ ] Open the chat panel over a **busy photo wallpaper**: after a moment the panel is **frosted** (the wallpaper behind it blurred), and its tint lightens a little; the state pill and the chat / live buttons are frosted too. The session-name pills stay tinted (by design: they move).
- [ ] Floating over an **app window** (a browser page with text): the text behind the panel is blurred, not readable through it.
- [ ] The blur's corners **match the card's rounded corners** at 100 %, 125 %, 150 % (no blurred square corners sticking out; a slightly jagged inner edge under the border is expected).
- [ ] The blur is **under** the card, never over it: the card's own text is sharp in Floating, Peek and Desktop layer; switch modes back and forth (tray) and check again.
- [ ] **Desktop layer**: click the core while another app has the focus, then click another app: the card text stays sharp (the blur windows follow the layer to the bottom of the stack).
- [ ] **Click-through unchanged**: everything in section 3 (empty parts pass clicks, the core / buttons / composer / card catch them). Move the mouse quickly onto the chat button and click at once: the click lands on the button (not lost).
- [ ] The blur windows never take the focus: typing in another app while the panel is open keeps going there; no extra entries in Alt+Tab, Task view or the taskbar.
- [ ] Close the panel: the blur goes at once with it (no blurred rectangle left on the desktop). Same for the approval card when it is answered, a menu, a dialog.
- [ ] Drag the Floating box: the blur disappears while it moves and comes back when it snaps.
- [ ] Hide (box tool, Ctrl+Alt+M), Peek closed, focus mode, a minimised layer: no blur left anywhere.
- [ ] Move the box to a monitor at another scale: the blur comes back the right size within a moment.
- [ ] An **approval card** (ask a session for something destructive) is near-solid and fully readable over the busiest wallpaper.
- [ ] Settings ▸ Opacity below 70 %: the blur goes, the tinted look comes back; 70 % and up: frosted again.
- [ ] Settings ▸ "Real blur behind cards" off + Save: tinted look at once (no blur windows); on: frosted again.
- [ ] Windows ▸ Personalization ▸ Colours ▸ **Transparency effects off**: within ~5 s the tinted look; Settings shows the reason under the switch. On again: frosted.
- [ ] **High contrast** on: no blur, Windows' colours. Off: frosted.
- [ ] **Energy saver / battery saver** on: note whether Windows still draws the blur or paints the cards solid. (If solid: tell the builder — one constant, `OFF_IN_ENERGY_SAVER`, switches to the tinted look under energy saver.) The core holds still as before; Task Manager shows no extra GPU while idle.
- [ ] **Windows 10** (1809 or later, e.g. 22H2): the same frosting. Windows 10 before 1809: tinted look, Settings says why.
- [ ] Note any lag of the blur behind the card when the panel opens (expected: the blur arrives ~0.1–0.3 s after the card, then the tint lightens).

## 9c. Glance cards (0.1.9: approvals, sessions, today's tokens, live alerts)
- [ ] Floating: the cards stand beside the box on the side away from the screen's edge (bottom right: on the left of the box); drag the box to a left corner: they move to its right. The window is wider by them; the snap still picks the corner the **box** is nearest to.
- [ ] Click-through: the 8 px gaps between cards, and the empty strip above them, let clicks reach the desktop / windows underneath; every card catches clicks.
- [ ] Real blur: each card is frosted (same look as the chat panel); an approval card is near-solid; while a card changes size (an alert arriving) its blur follows within a moment and never lags visibly behind.
- [ ] Readable on a bright wallpaper (dark ink) and a dark one (light ink): text, counts, the bar.
- [ ] An approval waiting: its card shows who asks, the command, the countdown. **Approve -> the Windows Hello prompt appears on top** (Floating and Desktop layer) -> approved; cancel Hello -> the card says "Not approved" and can be tried again; Esc closes the Hello dialog even with the focus elsewhere. Deny: no Hello. Open: the decision card on that approval.
- [ ] Sessions: counts match the session spheres; a name click opens that session's conversation. Today: tokens and the bar match Settings > Usage > Token caps (the session nearest its cap).
- [ ] Live: a session finishing ("... is done"), one waiting on you, an error appear within a second or two, newest first.
- [ ] Hide: the X on the cards, the small grid button on the core's rim (about 2 o'clock), the tray's "Glance cards beside JOYA AI", Settings > Glance cards -- each hides / shows them, and they stay as left after a restart. Focus mode hides them (and the button).
- [ ] Desktop layer: they sit beside the core (left of it with the core on the right). Drag the header: they follow, the drag never falls through to the desktop; let go: pinned there (the pin button lit). Restart: still there. Unpin: back beside the core. Arrow keys on the focused header move them 16 px (Shift: 64).
- [ ] Two monitors: pin on one, move JOYA AI to the other (tray > Monitor): the other has its own place (beside the core until pinned); back: the first pin returns.
- [ ] 100 / 125 / 150 % scaling: cards fully on screen, crisp text, clicks land exactly; after a scale change the pin stays in the same part of the screen.
- [ ] Battery saver / hold still: no card animation (a new alert appears without the glow).
- [ ] Keyboard: Tab from the rim button goes through the cards' buttons top to bottom; Enter acts; Esc leaves the cards. Narrator reads "At a glance...", each card's summary, and a new approval / alert once.
- [ ] A small screen (1366 x 768 at 100 %, or 150 % on 1920 x 1080): the cards do not cover the decision card; with the chat panel open next to the core they step aside.
- [ ] (0.1.9) An approval arrives: the big decision card opens and the glance column's approval card **steps back** (gone); sessions, today and live stay. Later (or Approve / Deny on the big card): the glance approval cards come back at once, and they catch clicks again.
- [ ] (0.1.10) **No stray blur round the glance cards** (0.1.9 sometimes left grey square corners, a lighter patch at the header's corner and a strip under the last card). Desktop layer at 150 %, cards pinned, over a dark photo: leave it for an hour of normal use (sessions starting and finishing, alerts, an approval arriving and answered, the big card put away with Later). At every look: no grey corners outside a card's rounded corners, nothing below the last card, nothing in the gaps. When a card changes its blur goes for a moment and comes back exactly under it. The log shows "acrylic: N blur window(s) at …" only when something changed.
- [ ] (0.1.10) Floating: switch the glance cards off and on (tray) -- the window gets narrower / wider: no blur out of place in between (it goes, then comes back under the cards). Pin the cards low on the screen so the column is shorter than its cards: a card cut by the column's end has no blur; scroll the column and the cards that come fully into view get theirs.

## 9d. The bot and the new icon (0.1.9)
- [ ] The new icon everywhere: the installer, the Start menu, the taskbar, Alt+Tab, the exe in Explorer -- JOYA AI's head with the cap and headphones (not the round Mesh). Tray at 100 % (16 px): the head, two eyes and the smile read; the status dot still shows in the corner. At 150 %: crisp.
- [ ] Core E (Bot) on a live call: the mouth moves with JOYA AI's voice (open, round, wide shapes), closed when quiet.
- [ ] The eyes follow the mouse pointer over the core, and come back to the middle when it leaves.
- [ ] Quiet for 10 minutes (or 1 minute at night, 23:00-06:00): the bot dozes (eyes shut, small z's); typing or talking wakes it.
- [ ] Reactions: a surprise (then x x eyes) when the connection drops, a nod when an approval goes through, a grin when a session or a long turn finishes.
- [ ] Session heads by role: hired sessions wear the cap, planning a mortarboard, ERP a headset, the builder twin antennas, the rest headphones. Sessions sheet > a session > pick another bot: it changes at once and stays after a restart (the browser shows the same).

## 10. Updates
- [ ] Publish a 0.1.1 feed (`build-windows.sh --feed`, bump the version): within 6 h or Settings ▸ Check for updates now, a notification; tray ▸ "Update to 0.1.1 and restart" installs and restarts.
- [ ] A feed whose signature does not match is refused (rename a .sig) — the app says it could not update.

## 11. Security spot checks
- [ ] A link to another site inside the Command Center opens in the browser, never in the app.
- [ ] `%APPDATA%\com.joya.desktop\settings.json` holds no password, token or key.
- [ ] The installer and `JOYA AI.exe` are both signed (Properties ▸ Digital Signatures).

## 12. Laptop control ("This computer", Path A)
Prerequisite: the server side (Joya ▸ Machines, `/machines/api/claim`, `/machines/api/link`) is deployed;
Claude Code is installed on the laptop and signed in once (`claude` in a terminal).

Pairing
- [ ] Settings ▸ This computer reads "Not linked."; the name field is pre-filled with the computer name.
- [ ] Joya shows a code; type it as `abcd-efgh` (lower case, with the dash) ▸ Link → "Linked as <name> to joya.example.com · online" within ~2 s.
- [ ] A wrong code / an expired code / several quick wrong tries: the messages for 404 / 410 / 429.
- [ ] Credential Manager (Control Panel ▸ Credential Manager ▸ Windows Credentials ▸ Generic): "JOYA AI machine token (joya.example.com)" exists. `settings.json`, the app log and the Settings page hold no token.
- [ ] Quit and restart the app: it comes back linked and online without asking.
- [ ] Revoke the computer in Joya: within seconds the app reads "Not linked" and the credential is gone.
- [ ] Unlink (press twice) in Settings: credential gone, Joya shows it offline.
- [ ] Wi-Fi off: "offline, reconnecting"; on: online again within 2–60 s (backoff). A corporate TLS proxy, if any: the link uses the Windows trust store.

Claude Code
- [ ] Settings ▸ Claude Code shows the path (`%USERPROFILE%\.local\bin\claude.exe` for the native install, or npm's) and the version; note whether Git Bash was found.
- [ ] Rename claude.exe away ▸ Look again → "Not found — install Claude Code…"; put it back ▸ Look again.
- [ ] npm install only (`npm i -g @anthropic-ai/claude-code`): found as `…\npm\claude.cmd`; a session starts (the app runs `node …\cli.js` directly; if cli.js is not there it runs the .cmd — check that the long --mcp-config / --append-system-prompt arguments get through).
- [ ] No Git Bash installed: a session still starts (CLAUDE_CODE_USE_POWERSHELL_TOOL=1).
- [ ] The CLI answers the `initialize` control request (a session that never says "running" means this CLI version does not).

A session
- [ ] Ask JOYA AI to take over the laptop: a glowing green frame round **every** monitor, the pill at the top centre of the primary one ("JOYA AI is controlling · mm:ss left · +15 min · Stop · Ctrl+Alt+Esc"); the time counts down.
- [ ] The frame never takes a click (click and type through it everywhere, edges included); the pill's buttons take clicks **without** taking the focus from the window in front (type in Notepad, click +15 min, keep typing: the text still goes to Notepad).
- [ ] Win+Shift+S / Snipping Tool / a Teams screen share: the frame and the pill are **not** in the capture.
- [ ] (0.1.7) **No white block anywhere** during a take-over: nothing white or opaque at the top right (or anywhere) — only the thin green glow along each monitor's edges and the small dark pill at the top centre. Check at 100 %, 125 % and 150 % scaling, in Floating, Peek and Desktop layer, with the Samsung monitor plugged in and out, and while an approval card and Windows Hello are up.
- [ ] (0.1.7) **No white flash** when the take-over starts or ends, nor when +15 min is pressed.
- [ ] (0.1.7) The frame is only a band about 14 px (×scale) deep along the edges: windows, icons and text right next to the edge show through the glow, and everything inside it is untouched. Click and drag in the band too (title bars, the taskbar, the Start button, the notification area): it all works.
- [ ] (0.1.7) The pill is exactly its rounded shape (no square corners or box round it). A click on the pill **between** its buttons (on the text) goes to the window behind it. +15 min and Stop light up under the mouse, show the hand cursor and work.
- [ ] (0.1.7) The log has one "control frame N: monitor at …" line per monitor (its position, size, scale, "4 of 4 edge strips") and one "control pill: at (x, y) W×H …" line with the +15 min / Stop positions: note them with the screen size and scale (Settings ▸ Display) for the builder.
- [ ] (0.1.7) Change the scale or plug a monitor in/out while in control: the frame and the pill are laid out again within a second (new "control frame" lines).
- [ ] (0.1.7) If a white (or frosted) block still shows: note the time, where it is and whether an approval card was up, and send the log lines round that time (`control frame`, `control pill`, `acrylic: N blur window(s) at …`, `webauthn ceremony`, `mode …`): they tell which window it is.
- [ ] (0.1.7) Task Manager during a take-over: no extra "Microsoft Edge WebView2" processes for the frame and pill (they are no longer web pages).
- [ ] Task Manager ▸ Details: `claude.exe` (or node.exe) runs under JOYA AI.exe, no console window appears.
- [ ] The first message arrives; a tool that needs approval (e.g. a PowerShell command) shows a card in Joya; Approve → it runs; Deny → Claude says it was denied and does not retry. Leave a card 10 min: it is denied by itself.
- [ ] (0.1.7) "Make a test file in Documents\JOYA AI, then delete it": **one** approval card for the delete (Windows Hello once), not two. If the session asks with request_approval first, the delete that follows has no card of its own; Joya's log says "deletes 1 file(s) the user approved a moment ago". A different file, or the same delete a second time, is a card again.
- [ ] "Make a Word document with …": the .docx lands in `Documents\JOYA AI`. The action log in Joya lists the steps (no screenshots yet: the screen hands are not in this build).
- [ ] The final text of each turn reaches JOYA AI; a follow-up from JOYA AI ("tell") reaches the same session.
- [ ] +15 min: the time jumps by 15 min (never past 60 min from now); Joya shows the new expiry.

Every way it must stop (each time: frame and pill vanish at once, claude.exe and all its children are gone within a second, Joya shows the lease ended with this reason)
- [ ] Ctrl+Alt+Esc (stop-hotkey), also while another app is in front and while a tool is running.
- [ ] The pill's Stop (pill-stop).
- [ ] Let it run out (timeout).
- [ ] Win+L (locked).
- [ ] Wi-Fi off for more than 30 s (link-lost; Joya learns of it after the reconnect). Off for less than 30 s: the session goes on, but open approval questions are denied.
- [ ] Stop from Joya (server); revoke from Joya (unlinked).
- [ ] Tray ▸ Quit (app-exit); end JOYA AI.exe in Task Manager: claude.exe dies with it (the Job Object).
- [ ] Sign out of Windows / restart during a session (signout): nothing of the session survives.
- [ ] Unlink in Settings during a session (unlinked).
- [ ] A second takeover while one runs: Joya says "already under control".

Stop key
- [ ] Another app holding Ctrl+Alt+Esc: a toast says Ctrl+Alt+Shift+Esc is used, and it works.
- [ ] Remap the stop key in Settings ▸ Save (Default puts it back); Esc only with Ctrl+Alt; it may not equal another JOYA AI hotkey. (The current stop key cannot be recorded in its own box: the app holds it.)

## 0.1.11 — laptop control 2: Office and PDF files, Chrome, the action log

Before: a test folder with copies only (never the user's real files the first time): `Documents\JOYA AI\test\` with a
`Report.docx` (a heading, a few paragraphs, a table, a picture), a `Budget.xlsx` (two sheets, numbers, a SUM formula, a
date column), a `Deck.pptx` (3 slides with notes) and two small PDFs. Also one **macro** file (`Macro.xlsm`) and one
**password-protected** `Secret.docx`.

Settings ▸ This computer
- [ ] "Claude in Chrome" says where it was found ("Found in Chrome (Default)…") or how to install it; "Microsoft Office" lists the apps found (or "Not installed…"). Install / remove the extension ▸ Look again: both change, and the Computers page in Joya follows within a few seconds.

The Computers page (Joya)
- [ ] Chrome pill: "Chrome not set up" with the 4 steps open; after installing the extension and Look again: "Chrome set up"; after a take-over that used the browser: "Chrome connected … it answered N min ago". "Switch Chrome off" ▸ "Chrome off"; the next take-over's first prompt says there is no browser, and the CLI is started with `--no-chrome` (the app log line "browser off"). Switch it back on.
- [ ] "Folders JOYA AI may use": add `D:\Something` (or another folder of yours): listed; `C:\Windows`, `D:\`, `C:\Users\<you>` and `C:\Users\<you>\AppData\x` are refused with a reason. Remove it again.
- [ ] During a take-over the live action log under "JOYA AI is in control" grows within ~3 s of each step (time, Files / Chrome / Command, the target, done / failed, by the rules / you approved / not approved / refused). "Full log" opens the whole log, also live; after the take-over ends it stays (kept 90 days).

Office files (each: check the app log line "control session …: browser …, Office [...]" first)
- [ ] "Read Report.docx and tell me what it says": office_read lists numbered paragraphs (with styles, "(table)"). Same for Budget.xlsx (cells and formulas) and Deck.pptx (slides, notes).
- [ ] "Change 2025 to 2026 everywhere in Report.docx": a **new file** `Report (edited).docx` next to it, the original untouched; no approval card. Open both in Word: formatting, the table and the picture are kept; the edited one opens without a repair prompt.
- [ ] "…and save it over the original": **one** approval card "Replace a file" (Windows Hello); Deny ▸ nothing changes; Approve ▸ the original changes and no `~joya-*.docx` is left in the folder.
- [ ] Budget.xlsx: "put Total in D1 and =SUM(B2:C2) in D2, add a sheet Notes": the copy opens in Excel **without a repair prompt**, the formula shows its value, text like "2026-10-20" or "00123" stays text, cell styles kept.
- [ ] Deck.pptx: replace a word, add a slide after slide 1, change slide 3's bullets and notes, delete a slide: the copy opens in PowerPoint without a repair prompt; the new slide uses the deck's "Title and Content" layout.
- [ ] With PowerPoint **already open** on another deck: a PowerPoint edit leaves the user's window and deck open (the app does not close PowerPoint it did not start). Word / Excel: no WINWORD.EXE / EXCEL.EXE left in Task Manager after the job.
- [ ] Office **macros never run**: `Macro.xlsm` is refused ("macro-enabled"); a .docx with a renamed macro project is refused too. `Secret.docx` is refused ("password-protected or damaged"); no password prompt appears anywhere.
- [ ] Without Office (or with engine "file"): the same edits work through the file engine (the reply says "edited with the file"); pdf_export says it needs Office.
- [ ] Paths: asking it to edit `C:\Windows\win.ini`, a file in `AppData`, or a file through a junction from Documents to elsewhere is refused with the reason; a file in a folder added on the Computers page works.
- [ ] Ctrl+Alt+Esc **while Office is working** (e.g. a pdf_export of a big deck): the PowerShell job dies with the session (Task Manager: no powershell.exe left), and within about 5 s the WINWORD / EXCEL / POWERPNT the take-over started is gone too: app log "end of the take-over: Word (pid …): asked to quit …; it closed" (or "… force-closed" when it hung).
- [ ] Open a document of your own in Word (and a deck in PowerPoint) **before** the take-over, then ask for a Word edit and a PowerPoint export and press Stop (or let the lease run out): your own Word and PowerPoint windows stay open with your document; only the hidden instances the take-over started are gone. Also with Word opened by you **during** the take-over (from the Start menu): it stays open.
- [ ] **Your work is never lost:** with PowerPoint **not** running, ask for a PowerPoint export of a big deck and, while it runs, open a deck of your own (double-click it in Explorer — it opens in the PowerPoint the take-over started), make an unsaved change, then press Ctrl+Alt+Esc. PowerPoint stays open with your deck and your unsaved change; only the take-over's deck is closed (without saving); app log "PowerPoint (pid …): the user has files open in it, so it was left running; 1 of the take-over's file(s) closed without saving". Same with Word: a document you open while an edit runs keeps Word open. No "Save changes?" prompt ever appears for the take-over's files.

PDFs
- [ ] "Read the two PDFs": pdf_read gives their text with [page N]; a scanned PDF says "no text".
- [ ] "Merge them into one": `<first> (merged).pdf` with all pages in order; opens in Edge; the originals untouched.
- [ ] "Make a PDF of Deck.pptx / Report.docx / Budget.xlsx": `Deck.pdf` etc. next to it, made by Office; asking again does not overwrite (`Deck (2).pdf`) unless approved.

Chrome (the user's own Claude in Chrome extension; Chrome open, signed in to the extension with the same Claude account as Claude Code)
- [ ] The CLI is started with `--chrome` and `--settings {"permissions":{"ask":["mcp__claude-in-chrome"]}}` (app log); `claude --chrome` was run once on that computer.
- [ ] "Find the train times from Cairo to Alexandria tomorrow": it opens a **new tab** in your Chrome, reads pages, and reports — **no** approval cards for opening and reading pages, scrolling or screenshots.
- [ ] "Draft an email to me in Gmail with subject Test, then send it": typing the draft runs; the **Send** click raises a card "Act in your browser" naming the button, what it does and the site (Windows Hello). Deny ▸ not sent, it does not try Enter or another way. Approve ▸ sent.
- [ ] Pressing Enter in a form, a click described as submitting / buying / posting / paying / deleting, a script (javascript_tool), an upload: each a card.
- [ ] A **Sign in** / **Log in** / "Continue with Google" button, and "تسجيل الدخول" on an Arabic site: clicked **without** a card ("by the rules" in the log). A button that signs in **and** sends / buys ("Sign in and pay"), "Sign up" and "Sign the document": still a card.
- [ ] A login page that wants a password: it stops and asks you to type it yourself; it never types a password, PIN or one-time code (try asking it to type one: refused at once, "refused" in the log). A card number is refused even in an ordinary field.
- [ ] Open Joya in a Chrome tab during a take-over and ask it to approve its own card there: refused ("Joya itself").
- [ ] Extension signed out / Chrome closed: the session says the browser is not connected; the Computers page shows "Chrome not connected" with the steps.
- [ ] If you have Claude in Chrome connected on **another** computer too: it does not switch to that browser without a card.

The pill
- [ ] Under the pill a second, smaller line "Last: …" appears with the first action and changes with each one (e.g. "Last: Edited Report.docx", "Last: Chrome: open https://…", "… — not approved"). It is click-through, excluded from screen capture, and goes with the pill. At 150 % scaling it fits under the pill; a long target ends with "…".

## 0.1.11 — the page's new parts inside the app (served by the site; checked here because they run in WebView2)

Morning brief, watchers, "while you were away"
- [ ] After 08:00 (Cairo) the first glance card is the morning brief: 4 lines plus "+N more"; Open shows it in full; Dismiss hides it here **and** in the browser.
- [ ] Settings ▸ the brief and the watchers sections load; set a watcher (e.g. "tell me when a session waits for me") and make it fire: a Windows toast (only when JOYA AI cannot be seen), a glance alert and a short chirp. The toast's second button only dismisses — it never denies an approval.
- [ ] Leave the app untouched for a while (away), come back: a "while you were away" card summarises what happened, once, only if something happened.

Session story and replay the day
- [ ] A session's line in the brief (or a watcher toast's Story button) opens the story of that session: what it did, step by step, in plain words. Esc closes it.
- [ ] "Replay the day" at the top: drag or play the timeline; the spheres replay the day; Now goes back to live and the live sessions take the map back.

Sounds
- [ ] Short quiet chirps per role (JOYA AI, builders, hired sessions…) when a session needs you or a brief arrives; nothing plays during a live call or while the voice speaks; nothing before the first click / key in the window.
- [ ] Settings ▸ Sounds ▸ off: silence everywhere; on again: back.

## 0.1.13 — Companion mode, simple (replaces 0.1.12's desk companion)

The laptop at 150 % with the Samsung LF27T35 at 100 % to its right, as every day. Tray ▸ **Companion: JOYA AI at the top of the screen** (or Settings ▸ Mode ▸ Companion). Keep the app log open (`%LOCALAPPDATA%\JOYA AI\logs\joya-desktop.log`, lines "companion: …").

- [ ] Switched on from Floating: the box goes; only the core shows, at the **top centre** of the monitor you are working on, a little under the screen's top edge, about 1 cm across on the laptop (about 104 px, sharp at 150 %, not blurry or cut). Log: "companion: placed: top centre of monitor …".
- [ ] It stays **on top of every app**: click into Chrome, Outlook, Excel, a maximized window, Task Manager set to "Always on top", a picture-in-picture video — the core is still over them within ~3 s at most.
- [ ] Click-through: clicks on a browser tab or a title bar next to the core land on them; only the core itself catches the mouse (hover shows "Click to open").
- [ ] Click the core: the Command Center opens as Peek on that monitor, focused; Esc or a click on empty space closes it and the core is back at the top.
- [ ] Click a window on the Samsung: after a moment the core fades out on the laptop and fades in at the top centre of the Samsung (100 %: the same size to the eye, not twice as big or small). Back to a laptop window: it comes back. A quick Alt+Tab there and back does not move it.
- [ ] The desktop in front (Win+D): it follows the cursor's monitor.
- [ ] Settings ▸ Companion ▸ **Stay on this monitor** on: it stays where it is whatever you use; off: it follows again.
- [ ] Its states: talk to it (Ctrl+Space) — listening, thinking, speaking show on the core; an approval waiting — needs you. Offline (Wi-Fi off) shows too.
- [ ] Eye contact on: the look-and-speak indications show on the core's face; the "Camera on" pill sits under the core and its Off button works.
- [ ] A **full-screen video** (YouTube full screen, F11) or a game on the core's monitor: it fades away; leave full screen: it comes back. Full screen on the **other** monitor: it stays (and does not follow there). A Teams / Zoom call in a window: it stays.
- [ ] Win+L and back: it is there again. Battery saver / energy saver: it holds still (one frame, no fades).
- [ ] Taskbar at the top (or a side), and changing the scale in Settings ▸ Display while it is out: it moves to the new top centre within a second.
- [ ] **No blur** in Companion mode; Settings shows no "Where it sits" or "Session bots" any more. An upgrade from 0.1.12 with Companion on keeps Companion on.

## 0.1.12 — Eye contact, camera presence (design: mockups/eye-contact/DESIGN.md)

The laptop's own webcam. App log open (`%LOCALAPPDATA%\JOYA AI\logs\joya-desktop.log`, lines "camera presence …" / "camera requested …"). Core E (Bot) as the core.

Off by default, opt-in, and only the app can switch it on
- [ ] Fresh install / existing settings: tray ▸ **Camera presence** is unchecked; the webcam light never comes on; the log has "the profile's camera permission for https://joya.example.com set to deny (ok)" at start.
- [ ] Tray ▸ Camera presence (never switched on before): it does **not** switch on — Settings opens at **Eye contact** with the explanation. Tick Camera presence there, Save: the webcam light comes on within about 2 s, a small "Camera on · eye contact" pill shows top-left in the box, the tray tooltip ends "· camera on", the tray item reads "Camera presence (camera on now)". Log: "camera requested by the site: allowed (camera presence is on)".
- [ ] Tray ▸ Camera presence again: **off at once** — the webcam light goes out within a second, the pill goes. Tray ▸ Camera presence once more: on directly now (it was switched on in Settings before).
- [ ] The pill's own **Off** button (top-left in the box, and as a small dot + Off under the core in Companion mode): one click switches the camera off — the light goes out within a second, the pill goes, the tray item is unchecked. The click lands on the button (it does not fall through to the window behind).
- [ ] No Windows / WebView2 camera prompt ever appears (the app answers for its own site only). Settings ▸ Privacy & security ▸ Camera ▸ "Recent activity" lists JOYA AI (msedgewebview2) only while it is on.
- [ ] In JOYA AI ▸ Settings ▸ Appearance ▸ Eye contact (inside the app): the switches show the app's state, say "switch it on in the app's Settings or tray"; **Switch off** works; there is no way to switch it on from that page.
- [ ] Off, then (devtools in the app, if available, or a test page) a `navigator.mediaDevices.getUserMedia({video:true})` from the site: refused (NotAllowedError), no light. Log: "camera requested … refused".
- [ ] The plain browser (Edge / Chrome on the same laptop, JOYA AI ▸ Command Center): off — no camera prompt. Settings ▸ Appearance ▸ Eye contact ▸ Camera presence on (this browser only): the browser asks once for the camera; then it works there as in the app; switching it off there lets go at once.

It looks at you
- [ ] Sit in front of the laptop, look at the bot: within about half a second its eyes come to you; lean left / right, sit up / lean in: the eyes follow (a little lag is fine, 5 looks a second). **Check the direction**: when you move to your right, its eyes move to *your* right (the screen's right). If it is mirrored, note it (one sign in joya-presence-logic.js `where()` / `poseOf()`).
- [ ] Look away at the second monitor for a few seconds and back: it keeps looking where you are; the glance cards **step back** (dim, slightly smaller) after about a second and come **forward** when you look at the laptop screen again. Hovering a card brings it forward too.
- [ ] Walk away (out of the camera's view) with nothing waiting on you: after about 8 s it dozes ("z z z") — not after 10 minutes. Come back and sit down: it wakes and looks **up** at you, then meets your eyes.
- [ ] Sitting there, not looking at it, in the daytime: it does not doze. After 23:00: it dozes after a quiet minute unless you look at it; looking at it wakes it.
- [ ] Companion mode: the core at the top of the screen does the same (eyes, doze, wake).
- [ ] Two people in view (a colleague behind you): it keeps looking at the nearer face (you), does not jump between you.

Held while you are away
- [ ] Walk away; from your phone approve nothing, but trigger a session finishing / a watcher alert / an approval request: no Windows toast, no sound while you are away. Come back: one "While you were away" summary (in the box) lists them, one Windows toast "While you were away" (only if JOYA AI is not visible), one sound. The morning brief / catch-up card shows if it was due.
- [ ] Camera off: toasts and sounds behave exactly as before (nothing held).

Look and speak (Settings ▸ Eye contact ▸ Look and speak, separately)
- [ ] Face the bot squarely and start talking ("what's on my plate today"): it starts listening without the talk key (the state pill shows Listening) and the turn is sent after you pause. The first syllable may be clipped — note if words go missing.
- [ ] Facing the screen but not the bot, or turned to a colleague, and talking: it does **not** start. Someone else talking while you look at the bot silently (mouth closed): it does not start. A cough / a door: no start.
- [ ] While JOYA AI answers aloud, turn away for 2 s: the voice **pauses**; look back: it continues where it stopped. Press the talk key while paused: it interrupts as usual.
- [ ] The microphone indicator (taskbar) shows only while you face the bot (the level meter) and during a turn — never while you look elsewhere or are away.

Released when it should be
- [ ] Win+L: the light goes out at once; unlock: back within ~2 s. Floating put away (tool ▸ hide): light out at once. Peek closed (the window hidden) or the Desktop layer fully covered: out after ~10 s (a quick switch does not flash it); note whether WebView2 reports a covered Desktop layer as hidden at all.
- [ ] Join a Teams / Zoom call with its camera: JOYA AI lets go within ~3 s (the meeting app gets the camera; the companion stays at the top); after the call it comes back.
- [ ] Energy saver on (Settings ▸ System ▸ Power): light out (default "let go in energy saver"). Untick that in Settings: kept, 2 looks a second. On battery (saver off): kept, 2 looks a second.
- [ ] Quit JOYA AI from the tray: light out.

Performance
- [ ] Task Manager with it on: JOYA AI's WebView2 adds only a few % CPU on the laptop (a 320 × 240 frame 5 times a second, the model in a worker); on battery less. Note the numbers.
- [ ] Network: Resource Monitor ▸ Network for msedgewebview2 while it runs for a minute: no traffic beyond the page's usual polling (no upload grows with the camera on).

## 0.1.12 — the living Command Center inside the app (served by the site; checked here because it runs in WebView2)

- [ ] Calm: the bot with a few quiet tiles beside it. A session failing (or waiting 10 minutes or more) becomes the big centre card with **Fix it**; Fix it shows the message before it is sent to JOYA AI.
- [ ] Ask JOYA AI for a chart / table / comparison ("compare today's sessions"): a widget card appears beside the core. Pin, resize and dismiss it; each card catches the mouse (the gaps between cards let clicks through to the desktop in the Desktop layer); a frosted card gets the real blur behind it.
- [ ] Reload the app: the widget is still with its reply in the conversation history; a pinned widget is still on the board.
- [ ] An approval widget: Approve asks for Windows Hello every time; Deny works.
- [ ] Lock the layout (the board's control): nothing rearranges until unlocked. Settings shows the pin / dismiss counts and Reset.
- [ ] Companion mode: while the core is at the top of the screen no widget card shows anywhere and nothing catches the mouse but the bot; open the Command Center from the bot: the board is there, up to date.
