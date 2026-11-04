# Session story and day timeline: design note (2026-10-20)

Opening a session in the Command Center used to show a wall of transcript text. Now it opens a
**story**: a picture of the work. The Command Center also gets a **day timeline** that replays the
day on the map.

## What you see

**The story** (`public/cc-story.js`, `cc-story.css`) is a glass panel in the Command Center's design
language: the session's bot head (core E's `JoyaBot.thumb`), its name, folder and state.

- **Moment scrubber.** The session's own activity in 5-minute bars. Drag it (or use ←/→, Shift for an
  hour, Home/End) and everything below shows that moment. End, or "Now", goes back to live.
- **Progress rail.** The session's plan as steps marked done, now or next. The rail comes from the
  first source that exists:
  1. the mission it works on (the ledger's steps; steps that belong to other sessions are dimmed);
  2. its todo list (`TodoWrite`, or `TaskCreate` / `TaskUpdate`);
  3. its turns, where each step is a real prompt or hand-off it was given.

  No step is invented. A long rail shows a window of 7 steps (5 on a phone) around the current step,
  with "N earlier" and "N later" buttons. Clicking a step moves the moment to that step.
- **Cards.**
  - **Files touched.** The `+`/`−` lines that Claude Code recorded (`toolUseResult.structuredPatch`;
    a new file counts all its lines as added).
  - **Approvals.** Where a person was actually asked: the transcript's `permissionDecision` (an
    allow by a saved rule or by the classifier does not count), plus the ledger's cards for JOYA AI
    and hired sessions. Questions asked with `AskUserQuestion` are counted separately.
  - **Tokens & cost.** Tokens are counted once per message id. Cost is today's figure from the
    supervisor's own cost report, marked "est." when it is an API-equivalent estimate.
  - **Time spent.** Active time adds up gaps of 5 minutes or less. Also shown: first to last
    activity, and the number of turns.
  - **Hand-offs.** JOYA AI's delegations and replies from the ledger, messages between sessions, and
    the sub-agents the session started.
- **Live mirror.** This button opens the old read-only text view, which is unchanged.

**The day timeline** starts as a small "Replay the day" pill at the top centre of the Command
Center. Open, it is a glass bar with these parts:

- **Controls.** Play/pause, the day with ‹ › (the last 14 days), Lanes, and a **Now** button.
- **The track.** The day's activity from the hour it started until now, shown as a heat strip.
  Hand-offs are dots along the top (violet for delegations and messages, blue for replies).
  Approvals are amber ticks.

While you drag or play, the map replays the day:

- **Sessions as they were.** The sessions that existed at that moment become the spheres or bot
  heads. A session is working if it wrote anything in the last 5 to 10 minutes, waiting if it had an
  approval card open, and idle otherwise.
- **Hand-offs fly.** Each hand-off you step across flies as the existing dot streams:
  - a delegation goes from the core to the head;
  - a reply comes back from the head;
  - a message between two sessions goes head to head, through the new `family.link()`.

  The latest hand-off is named under the bar.

Lanes show one heat row per session, JOYA AI first. Clicking a lane opens that session's story at
the replayed moment. **Now** goes back to live, and the live session list takes the map back.

## Data (read-only, cached)

- **Supervisor** (`joya-ai/lib/story.js`, the new ops `session-story` and `story-day`, both
  read-only):
  - It reads transcripts incrementally: a byte offset per file, yielding between 4 MB chunks.
  - It keeps parsed state for at most 64 files.
  - It caches the day for 15 s.
  - On this box the first day took about 0.5 s and later calls were served from cache.
  - Days older than 14 days are refused, matching the cost scanner's window.
- **Dashboard.** Two routes, `GET /joya-ai/api/sessions/:sid/story` and `GET /joya-ai/api/story/day`
  (behind `joyaai.use`). `lib/story-api.js` cleans the input and caches results per key (4 s for a
  story, 15 s for a day), with one call in flight per key.

## Links and API

- `/joya-ai?session=<id>&t=<ISO>` opens a story at a moment.
- `/joya-ai?t=<ISO>` opens the day timeline replaying that moment.
- The address bar follows the moment you are looking at.
- JavaScript API: `JoyaStory.open(sessionId, t)`, `JoyaStory.link(sessionId, t)`,
  `JoyaStory.replay(t)`, `JoyaStory.live()`, `JoyaStory.replaying()` and `JoyaStory.at()`.

## Hooks into existing files (small, additive)

- **`joya-ai.js`.**
  - `renderSessions` leaves the spheres alone while a replay runs.
  - Clicking a sphere opens the story.
  - `JoyaStory.attach(CC, P)`.
- **`cc-panels.js`.** `openDeep(key, opt)` opens the story unless `{ mirror: true }` is passed.
- **`cc-map.js`.**
  - `link()`.
  - Spheres keep clear of `[data-cc-obstacle]`.
- **`cc-family.js`.** `link()`, a head-to-head stream.
- **`views-joyaai.js`.** Loads the two new assets (the browser and the desktop shell).
- **Supervisor.** `features.js` and `protocol.js` register the two ops. `joya-ai-ctl` lists them.

## Limits (true to the data)

- **Interactive sessions' approvals.** These exist only where Claude Code recorded a
  `permissionDecision`.
- **Session-to-session messages.** These are resolved by name. A message to a raw socket address is
  dropped as a duplicate when the ledger already has that reply. Otherwise it is shown as "a session
  (by its socket)".
- **Active time by a past moment.** This is counted in 5-minute blocks with activity and labelled
  "active blocks by then".
- **JOYA AI's own sessions.** Its several session ids are merged into one lane.
