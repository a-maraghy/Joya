"use strict";
/**
 * The operator's manual, served from the panel itself (avatar menu ▸ Guide & help).
 *
 * It lives here rather than in a README because the moment you need it is the
 * moment you are looking at the panel wondering why something is silent.
 *
 * Every section is a `<section id="…" class="card gd">` whose id is written out
 * literally below: the page registry scans this file for section ids, so
 * JOYA AI can open `/guide#voice` and the like. Keep the ids stable, and keep
 * them in step with GUIDE_TOC. Each section carries a "where" line naming its
 * place in the sidebar. The search box and its highlighting live in
 * public/guide.js, the styles in public/guide.css.
 */

const { esc, shell, docLayout, tocCard } = require("./ui");

/** The contents list, in page order: [section id, label]. */
const GUIDE_TOC = [
  ["around", "Getting around"],
  ["cc", "The Command Center"],
  ["voice", "Talking to JOYA AI"],
  ["hire", "Hiring and retiring sessions"],
  ["screen", "Screen control"],
  ["budget", "Usage and token caps"],
  ["approvals", "Approvals, system alerts and schedules"],
  ["briefs", "Briefs and watchers"],
  ["chatgpt", "ChatGPT"],
  ["computers", "Your computers"],
  ["agents", "Telegram agents"],
  ["memory", "Memory"],
  ["machine", "The machine"],
  ["access", "Users, roles and credentials"],
  ["devices", "Devices and SSH keys"],
  ["trouble", "Troubleshooting"],
  ["where", "Where things live"],
];

/** A section's place in the sidebar. */
const where = (text) => `<p class="where">${esc(text)}</p>`;

exports.GUIDE_TOC = GUIDE_TOC;

exports.guide = ({ csrf, user, publicHost, publicPort, sshHost }) => {
  const ssh = esc(sshHost || publicHost);

  const main = `
    <section class="card gd-search-card">
      <div class="guide-search"><input type="search" id="guide-q" placeholder="Search the guide — voice, retire, caps, devices…" aria-label="Search the guide" autocomplete="off" spellcheck="false"></div>
      <p class="muted small gd-empty" id="gd-empty" role="status">Nothing matches.</p>
    </section>

    <section id="around" class="card gd">
      <h2>Getting around</h2>
      ${where("Everywhere")}
      <div class="gd-body">
      <p>Signing in lands on <b>JOYA AI › Command Center</b> (a role without JOYA AI lands on
        the first page it may open, or on its account). Everything else is in the
        <b>sidebar</b>, in four groups:</p>
      <ul>
        <li><b>JOYA AI</b>: the Command Center, JOYA AI's Settings and your Computers.</li>
        <li><b>Agents &amp; sessions</b>: the Agents overview, Sessions, Telegram agents,
          Channels, Add-ons and Memory.</li>
        <li><b>Machine</b>: Machine health, Services and the Audit log.</li>
        <li><b>Access &amp; security</b>: Users, Roles, Devices, SSH keys, Firewall and
          Credentials.</li>
      </ul>
      <p>The top bar shows where you are, how many Decisions wait for you (<b>“N needs
        you”</b>), whether the machine is healthy, and your avatar. The avatar menu holds
        <b>Account &amp; sign-in</b>, your <b>Signed-in devices</b>, <b>JOYA AI appearance</b>,
        <b>Guide &amp; help</b> (this page), the theme (System / Dark / Light) and <b>Sign
        out</b>.
        <b>Collapse</b> at the foot of the sidebar shrinks it to icons; on a phone, the ☰
        button opens it as a drawer.</p>
      <p>In the Command Center, the sidebar is out of the way: its own icon bar sits on the
        left as always, and the <b>☰ button at the bottom of that bar</b> opens the Joya
        menu over it.</p>
      </div>
    </section>

    <section id="cc" class="card gd">
      <h2>The Command Center</h2>
      ${where("JOYA AI › Command Center")}
      <div class="gd-body">
      <p>JOYA AI is the assistant that runs this machine. You talk to it in the composer (or
        by voice); it answers, and hands work to the right session. Its icon bar opens the
        panels behind the scenes:</p>
      <ul>
        <li><b>Conversation</b> — the whole chat and what JOYA AI did step by step.</li>
        <li><b>Sessions</b> — every live session, as a list; the same sessions drift round
          JOYA AI as spheres.</li>
        <li><b>Missions</b>: multi-step jobs and where each stands. Its button shows while
          a mission is open or running; <b>New mission</b> is always in Search
          (<kbd>Ctrl K</kbd>) and the Everything grid.</li>
        <li><b>Decisions</b> — anything that waits for you: an approval, a retire request, a
          cap reached. The amber “needs you” count in the top bar opens it.</li>
        <li><b>Timeline</b>; <b>Rules &amp; alerts</b>, with three tabs: approval rules,
          system alerts and <b>Schedules</b> (the standing orders); <b>Usage</b> and
          <b>Machine</b>.</li>
        <li><b>Search or run</b> (<kbd>Ctrl K</kbd>) finds any panel, session or command.</li>
      </ul>
      <p>Type <kbd>@</kbd> to address a session directly. Destructive steps always wait for
        your approval.</p>
      </div>
    </section>

    <section id="voice" class="card gd">
      <h2>Talking to JOYA AI</h2>
      ${where("JOYA AI › Settings › Voice")}
      <div class="gd-body">
      <p>Voice is one thing: a <b>live conversation</b>. Press the microphone in the Command
        Center or the dock and just talk; JOYA AI answers at once and you can interrupt it.
        It speaks as JOYA AI, in the first person, and what it reports is read from JOYA AI's
        own results — the voice itself cannot run anything.</p>
      <p>Only <b>administrators</b> may talk by voice: it takes the permission <b>Talk with
        JOYA AI by voice</b> (<code>voice.use</code>), which no other built-in role has.
        Changing the voice settings is a separate permission.</p>
      <h3>Turning it on</h3>
      <ol>
        <li>Open <b>Settings › Voice</b>. Switch <b>Voice</b> to <b>On</b>.</li>
        <li>Add the <b>OpenAI key</b>. It is written to a root-only file and never shown
          again; <b>Replace</b> and <b>Remove</b> are next to it. <b>Test the voice</b>
          speaks one line and writes it back.</li>
        <li>Check the <b>Voice model</b> and pick a <b>voice</b> — each card says whether it
          sounds female, male or neutral, and its play button speaks a short sample in that
          voice without choosing it.</li>
      </ol>
      <h3>Voice model</h3>
      <p>The voice model holds the live conversation. <b>GPT Realtime 2.1 mini</b> is the
        default: it read 18 of 18 test sentences word for word and answers Arabic in Arabic.
        <b>GPT-Live + JOYA AI</b> (offered when your OpenAI key can use it) is the most natural:
        it listens while it speaks and hands every real request to JOYA AI. The others are
        listed with their test results. Replies cut by the guard are read word for word by
        GPT Realtime 2.1 mini, so they are never paraphrased.</p>
      <p>The voices offered follow the model: GPT-Live has 31, including English voices with
        Australian, British, Irish and Southern accents and voices for other languages; the
        realtime models have 10. Changing the model keeps your voice if the new model has it,
        otherwise it picks a similar one.</p>
      <h3>What JOYA AI hears</h3>
      <p>On <b>GPT-Live</b>, JOYA AI acts on GPT-Live's own transcript of what you said. On the
        realtime models, what you say is written down by <b>GPT-4o Transcribe</b>, and JOYA AI
        acts on that transcript, never on the voice model's retelling of your words. There is
        nothing to set: it detects Arabic, English and the two mixed.</p>
      <p>When JOYA AI finishes a request, the voice always tells you the result in a few
        sentences, with its figures — not just “the details are on screen”.</p>
      <h3>During a call</h3>
      <ul>
        <li>Say “stop listening”, press <kbd>Esc</kbd> or the red <b>End</b> to finish. A call
          lasts at most 20 minutes; one call at a time.</li>
        <li><b>Speakers mode</b> (default) pauses the microphone while JOYA AI speaks — tap,
          <kbd>Space</kbd> or <kbd>Esc</kbd> to interrupt. With headphones, <b>Headphones
          mode</b> lets you talk over it.</li>
        <li>Arabic: it answers in the language you last used, and learns from how you speak
          to it (Egyptian or formal Arabic, and how you address it).</li>
      </ul>
      <h3>Turning it off</h3>
      <p>Switching <b>Voice</b> to <b>Off</b> turns off all voice for everyone: live calls,
        a reply's Read aloud and every voice control. The key stays saved, so switching it back on needs
        nothing else.</p>
      <h3>Voiceprint</h3>
      <p>JOYA AI can recognise people by voice and greet them by name. <b>Add and enrol</b>
        records about two minutes of reading; <b>Only respond to stored voices</b> ignores
        voices it does not know. A voice identifies; it never approves anything.</p>
      </div>
    </section>

    <section id="hire" class="card gd">
      <h2>Hiring and retiring sessions</h2>
      ${where("Agents & sessions › Sessions · JOYA AI › Settings › Sessions & hiring")}
      <div class="gd-body">
      <p>JOYA AI may <b>hire</b> a worker session on its own when a job needs one — by
        default up to 7 live sessions and 3 hires an hour. Both limits are editable in
        <b>Settings › Sessions &amp; hiring</b>. A hired session runs as its own service,
        survives restarts, and its first message is marked as coming from JOYA AI.</p>
      <ul>
        <li><b>Keep</b> a hired session to make it permanent: JOYA AI will never retire
          it.</li>
        <li><b>Retire</b> ends it gracefully; its transcript is kept. JOYA AI may <i>ask</i>
          to retire one — a Decision card — but retiring always needs your consent: only you
          can say yes.</li>
        <li>Your own sessions (started by you) are never hired, kept or retired by JOYA
          AI.</li>
      </ul>
      <p>Every tool a hired session runs passes the same destructive-action gate; anything
        risky comes to you as a Decision naming that session.</p>
      </div>
    </section>

    <section id="screen" class="card gd">
      <h2>Screen control</h2>
      ${where("JOYA AI › Settings › Screen control")}
      <div class="gd-body">
      <p>When you ask, JOYA AI can act on your screen: end or mute a call, open a panel,
        switch the core, show the last reply, or take you to any page. These happen at once
        with a note and a 60-second <b>Undo</b>. Changing a preference — the theme or the
        voice — always asks you first. It never clicks anything on a page for
        you, and approving stays yours. <b>Allow screen actions</b> switches all of this off
        for you.</p>
      <h3>The page map</h3>
      <p>JOYA AI can open any page, section, tab or anchor in the <b>page map</b> — this
        guide's sections included. The map is built from the source itself; <b>Rescan
        pages</b> rebuilds it and shows what is new, renamed or removed. Each entry has an
        allow switch, and <b>New entries</b> decides whether newly found ones are allowed at
        once (the default) or wait for you. JOYA AI only ever sees entries your role may
        open.</p>
      </div>
    </section>

    <section id="budget" class="card gd">
      <h2>Usage and token caps</h2>
      ${where("JOYA AI › Settings › Usage & token caps")}
      <div class="gd-body">
      <p>Usage is counted in tokens. Each session can have a <b>daily token cap</b>: JOYA
        AI, every hired or kept session, your own sessions, and a default that each new hire
        copies. The bar shows today's use against the cap, with the warning line (<b>Warn
        at</b>, 80 % by default).</p>
      <ul>
        <li><b>Warn</b> — a Decision card tells you the cap was passed; the session keeps
          going.</li>
        <li><b>Pause</b> — the session stops at the end of its current step and takes no new
          work until you <b>Resume</b> it or the day turns (Cairo time). When JOYA AI itself
          is paused it holds every new turn, your own messages included. Raising the cap above
          today's use also releases it.</li>
      </ul>
      <p><b>Pause</b> is only for JOYA AI and hired or kept sessions. Your own sessions were
        not started by JOYA AI and it has no hold on them, so they can only warn.</p>
      <h3>What counts, and when it is checked</h3>
      <p>A cap counts <b>all</b> tokens — input, output and cache — the same “N tok today”
        figure the Usage panel shows. Caps are checked at the end of every JOYA AI turn and
        after each cost scan, so a session other than JOYA AI can run past its cap by up to
        one cost-scan interval before it is warned or paused.</p>
      <p><b>Voice spend</b>, what OpenAI charges for voice, is on the same page.</p>
      </div>
    </section>

    <section id="approvals" class="card gd">
      <h2>Approvals, system alerts and schedules</h2>
      ${where("JOYA AI › Settings › Approvals & automations · Command Center › Rules & alerts")}
      <div class="gd-body">
      <p>JOYA AI waits up to 300 seconds for an approval before refusing. <b>Approval
        rules</b> answer common requests in advance (allow, ask or deny). <b>System
        alerts</b> are JOYA AI's own checks on the server: a service failed, bans burst, the
        disk fills, an agent keeps failing or Odoo errors pile up. Switch each on or off in
        Settings. <b>Schedules</b> (standing orders) run a job on a schedule, as JOYA AI or a
        session; add, edit, pause or run them in the Command Center's Rules &amp; alerts.</p>
      </div>
    </section>

    <section id="briefs" class="card gd">
      <h2>Briefs and watchers</h2>
      ${where("JOYA AI › Settings › Briefs & watchers")}
      <div class="gd-body">
      <p>JOYA AI tells you things without being asked, here and in the desktop app only:</p>
      <ul>
        <li>The <b>morning brief</b>: what each session did, what finished, failed or waits on
          you, today's usage and anything stuck. Set its time and days; <b>Write one now</b>
          makes one at once, and an unread brief can be read to you when you start a call.</li>
        <li><b>Your watchers</b>: rules you write in plain words, such as “tell me when the
          Planning engine session finishes” or “remind me at 17:30 to call the warehouse”.
          A watcher only notifies; it never acts.</li>
        <li><b>Catch-up</b>: after a while away, one short card says what happened.</li>
      </ul>
      <p>Your watchers are yours; the server checks JOYA AI runs itself are the system
        alerts above.</p>
      </div>
    </section>

    <section id="chatgpt" class="card gd">
      <h2>ChatGPT</h2>
      ${where("JOYA AI › Settings › ChatGPT")}
      <div class="gd-body">
      <p>Every agent can hand a task to ChatGPT when you ask it to (“ask ChatGPT…”). They all
        share one ChatGPT sign-in on this server; this panel never sees it, and what they ask
        and get back is not stored here, only who asked, when and how it went.</p>
      <ul>
        <li><b>Sign in again</b> asks for Windows Hello (or the code), then shows a link and a
          one-time code to enter on OpenAI's page.</li>
        <li>Each Telegram agent has its own switch. An agent reads it when it starts: if it is
          running and not answering anyone, <b>Restart now</b> applies the change at once;
          otherwise it applies at its next restart.</li>
        <li>JOYA AI and the sessions it hires always have it, and use it only when you ask.</li>
      </ul>
      </div>
    </section>

    <section id="computers" class="card gd">
      <h2>Your computers</h2>
      ${where("JOYA AI › Computers")}
      <div class="gd-body">
      <p>Link a Windows laptop through the JOYA AI desktop app and JOYA AI can work on it when
        you ask: files, Office documents and PDFs, and your Chrome. It never starts by itself.
        You hand over control for a limited time, a glowing frame shows round the screen the
        whole time, and the stop key or the pill's <b>Stop</b> ends it at once. The page lists
        each linked computer, whether it is online, the folders JOYA AI may use there and the
        log of every take-over; <b>Revoke</b> unlinks one.</p>
      </div>
    </section>

    <section id="agents" class="card gd">
      <h2>Telegram agents</h2>
      ${where("Agents & sessions › Telegram agents · Channels · Add-ons")}
      <div class="gd-body">
      <p>An <b>agent</b> is a Claude session with its own workspace and memory; a
        <b>channel</b> is how people reach it (a Telegram bot, or a linked WhatsApp number).
        To make one: create a Telegram bot with BotFather, find your Telegram user ID, then
        <b>New agent</b> — the mind first, then its channel. Only listed users are answered.
        One channel per agent; swapping the channel keeps the agent's memory. Add-ons (voice
        notes, files, …) are switched per agent and per channel. Groups with topics, WhatsApp
        and broadcast channels are covered below.</p>

      <div class="gd-sub" id="how">
      <h3>How it works</h3>
      <p>Two things, kept separate, and nothing is shared between agents.</p>
      <pre class="diagram">You, on Telegram or WhatsApp
      │
      ▼
  channel                   the credential and the allow-list live here
      │
      ▼
  joya-agent@&lt;name&gt;         systemd unit, runs as the joyaagent account
  or joya-whatsapp@&lt;chan&gt;
      │
      ├─ Claude Agent SDK ──▶ claude CLI ──▶ Anthropic
      │
      ├─ vault/             the only directory it may read or write
      │
      └─ memory MCP server ─▶ vault (Markdown) + vectors (local embeddings)</pre>
      <p class="muted">Four things follow from this shape, and they are the ones worth
        remembering:</p>
      <ul>
        <li><strong>No inbound port.</strong> Both transports connect outbound, so the
          firewall stays shut. Nothing about an agent is reachable from the internet.</li>
        <li><strong>Only files survive.</strong> A chat session ends on timeout or
          <code>/new</code>. Whatever the agent did not write to its vault is gone.</li>
        <li><strong>One channel per agent.</strong> Telegram allows exactly one poller per
          token; two agents sharing a channel would make both drop messages at random, so
          the panel refuses it.</li>
        <li><strong>The channel is not the agent.</strong> Swap the bot, or move it to
          WhatsApp, and the agent keeps every word of its memory.</li>
      </ul>
      </div>

      <div class="gd-sub" id="bot">
      <h3>1 · Create a Telegram bot</h3>
      <p>Every agent needs its own bot. This takes about a minute.</p>
      <ol class="steps">
        <li>Open Telegram and message <a href="https://t.me/botfather"><code>@BotFather</code></a>.</li>
        <li>Send <code>/newbot</code>.</li>
        <li>Give it a display name (anything, e.g. <em>Odoo Dev</em>).</li>
        <li>Give it a username. It must be unique and end in <code>bot</code> —
          e.g. <code>joya_odoo_dev_bot</code>.</li>
        <li>BotFather replies with a token that looks like
          <code class="mono">8123456789:AAHk9x…</code>. That line is the bot. Copy it.</li>
      </ol>
      <div class="alert warn">The token is a password. Anyone holding it controls the bot
        and can read everything sent to it. Paste it into the add-channel form and nowhere
        else — not into a chat, not into a file. The panel stores it <code>0600</code> and
        never displays it again. If you ever leak one, <code>/revoke</code> in BotFather
        invalidates it immediately.</div>
      <p><b>Worth setting while you are there:</b></p>
      <ul>
        <li><code>/setdescription</code> — shown on the bot's empty chat screen.</li>
        <li><code>/setuserpic</code> — makes agents distinguishable at a glance when you
          run several.</li>
        <li><code>/setprivacy</code> → <em>Disable</em> — only if you plan to use the bot in
          a group and want it to see all messages rather than only replies and mentions.</li>
      </ul>
      </div>

      <div class="gd-sub" id="userid">
      <h3>2 · Find your Telegram user ID</h3>
      <p>The agent answers a whitelist of numeric user IDs and ignores everyone else. An
        agent with an empty whitelist talks to nobody — that is the safe default, not a bug.</p>
      <ol class="steps">
        <li>Message <a href="https://t.me/userinfobot"><code>@userinfobot</code></a> on Telegram.</li>
        <li>It replies with your ID — a number like <code class="mono">123456789</code>.</li>
      </ol>
      <p class="muted">Adding a colleague later is the same trick: they message that bot,
        send you the number, you add it to the channel's allowed list.</p>
      </div>

      <div class="gd-sub" id="create">
      <h3>3 · Create the agent and its channel</h3>
      <p>These are two separate things, on purpose. The <strong>agent</strong> is the mind:
        its brief, its workspace, its memory. The <strong>channel</strong> is how people
        reach it: a bot token, a list of who may talk to it. Keeping them apart means you
        can swap the bot an agent answers on, or move it to WhatsApp, without rebuilding
        the agent or losing a word of its memory.</p>
      <p><b>First the agent</b> — <a href="/agents/new">Telegram agents › New agent</a>:</p>
      <table class="kv">
        <tr><td>Display name</td><td class="muted">What you call it. Cosmetic.</td></tr>
        <tr><td>Short name</td><td class="muted">Lowercase, becomes the folder and the
          systemd unit. Permanent — choose one you can live with.</td></tr>
        <tr><td>What it does</td><td class="muted">Its role: the standing brief, written into
          CLAUDE.md and loaded on every request. This is the field that decides whether the
          agent is useful. Be specific about what it owns, what it may do unattended, and what
          it must ask about first. It also picks the agent's bot avatar.</td></tr>
        <tr><td>Project directory</td><td class="muted">Optional. An existing folder under
          <code>/opt/projects</code>, <code>/srv</code> or
          <code>/opt/joya-agents/workspaces</code>. It appears inside the vault as
          <code>project/</code>.</td></tr>
        <tr><td>Add-ons</td><td class="muted">What the agent can do — git, scheduled jobs,
          webhooks. Memory is always on.</td></tr>
        <tr><td>Avatar</td><td class="muted">Every agent gets a small bot head chosen from what it
          does (an email agent a headset, a design agent a beret or a pencil, a coding agent
          glasses), with its own colour and face. <b>Settings › Avatar</b> shuffles it and
          offers the PNG to set as the Telegram bot's picture in @BotFather.</td></tr>
      </table>
      <p><b>Then the channel</b> — <a href="/channels/new">Channels › Add channel</a>:</p>
      <table class="kv">
        <tr><td>Type</td><td class="muted">Telegram or WhatsApp.</td></tr>
        <tr><td>Bot token</td><td class="muted">From step 1. Verified with Telegram before
          anything is written, so a mistyped token fails here rather than in the logs.</td></tr>
        <tr><td>Allowed user IDs</td><td class="muted">From step 2. Empty means nobody.</td></tr>
        <tr><td>Connect to agent</td><td class="muted">The agent you just made.</td></tr>
        <tr><td>Add-ons</td><td class="muted">What it can receive — voice notes, files,
          images — and how replies feel.</td></tr>
      </table>
      <p>On save the panel writes the agent's environment, enables a systemd unit and
        starts it. An agent with no channel stays stopped rather than crash-looping.</p>
      <div class="alert info">A good role brief beats every other setting. "You maintain the
        Odoo 19 instance at /opt/projects/odoo; you may edit modules and run tests
        unattended; ask before restarting the service during working hours" produces a far
        better agent than "You are a helpful assistant".</div>
      </div>

      <div class="gd-sub" id="talk">
      <h3>4 · Talk to it</h3>
      <p>Open <code class="mono">https://t.me/&lt;your_bot_username&gt;</code>, press Start,
        and type normally. No commands needed — it is a conversation.</p>
      <table class="kv">
        <tr><td><code>/start</code></td><td class="muted">Wake it up, confirm it can hear you.</td></tr>
        <tr><td><code>/new</code></td><td class="muted">Start a fresh session. Clears the
          conversation, <em>not</em> the memory vault.</td></tr>
        <tr><td><code>/status</code></td><td class="muted">Session, model, usage.</td></tr>
        <tr><td><code>/verbose 0|1|2</code></td><td class="muted">How much of its own work it
          narrates while thinking.</td></tr>
        <tr><td><code>/repo</code></td><td class="muted">Git status of the working directory.</td></tr>
      </table>
      <p class="muted">Voice notes, photos and documents work too — it transcribes and reads
        them.</p>
      </div>

      <div class="gd-sub" id="addons">
      <h3>Add-ons</h3>
      <p>An add-on is a capability with a switch, not a plugin you install. Turning one on
        writes configuration the runtime already understands and restarts the affected
        process. Browse them all under <a href="/addons">Agents &amp; sessions › Add-ons</a>.</p>
      <table class="kv">
        <tr><td><strong>Channel</strong></td><td class="muted">What arrives and how it
          feels: voice notes, file capture, image capture, live typing, quick actions.</td></tr>
        <tr><td><strong>Agent</strong></td><td class="muted">What the agent does with it:
          memory (always on), git, scheduled jobs, webhooks, telemetry.</td></tr>
      </table>
      <p><b>Voice notes.</b> Send a voice message and the agent hears it. Transcription runs
        on this server with whisper.cpp — no API key, no per-minute cost, and the recording
        never leaves the box.</p>
      <p><b>Files.</b> Send a spreadsheet, a PDF, a Word document, a photo, a CSV. The file is
        saved into the agent's workspace under <code>attachments/inbox/</code> and the agent
        gets the path, so it can open a spreadsheet with pandas or pull the text out of a PDF
        — and it is still there tomorrow if you want to ask a follow-up question.</p>
      <p class="muted small">Executables, libraries, installers and key material are
        refused regardless of what is switched on.</p>
      </div>

      <div class="gd-sub" id="topics">
      <h3>Groups &amp; topics</h3>
      <p>Default is a private chat: you and one agent. Group topic mode instead puts the
        agent in a group where each project gets its own topic thread — useful when several
        people work with the same agent, or one agent covers several projects.</p>
      <ol class="steps">
        <li>In Telegram, create a <strong>group</strong> (not a channel).</li>
        <li>Group Settings → <strong>Topics</strong> → turn on. This converts it to a forum;
          without it there are no threads to route into.</li>
        <li>Add your bot to the group.</li>
        <li>Promote the bot to <strong>administrator</strong>, and grant it
          <strong>Manage Topics</strong>. It creates and renames threads itself.</li>
        <li>Get the group's chat ID: forward any message from the group to
          <a href="https://t.me/userinfobot"><code>@userinfobot</code></a>, or temporarily add
          <code>@RawDataBot</code>. Supergroup IDs start with <code class="mono">-100</code>.</li>
        <li>In the channel's <strong>Telegram Topics</strong> card, tick <em>Route
          conversations into topics</em> and paste that ID. Each row under
          <em>Projects</em> becomes one topic, working in a folder inside the agent's folder
          (<code>.</code> is the agent's folder itself; that one row is the proposed default).</li>
        <li>Save. The panel checks the folders, that the group is a forum and that the bot is
          an admin before anything changes, then waits for the bot to start in topic mode. If it
          does not, the previous settings are put back and the bot's own error is shown.</li>
      </ol>
      <p><strong>General goes to</strong> (Topics card): the group's General topic is answered in
        the folder of the project you pick from the list; <em>Off</em> by default.</p>
      <p><strong>Respond in groups</strong> (channel Settings): <em>To every message</em>, or
        <em>Only when asked</em> &mdash; an @mention, a reply to the bot, or one of its names
        (one per line, the agent's name by default), in every topic of the group. Private chats
        are always answered.</p>
      <p><strong>New topics get their own folder</strong> (Topics card, off by default): a topic
        made in the group gets <code>topics/&lt;name&gt;</code> in the agent's folder. They show in
        the list marked <em>auto</em>: edit or switch off, not remove. A deleted topic's folder
        goes to the Trash list for the days you choose (Restore or Delete now there), or is kept.</p>
      <div class="alert warn">Group privacy mode is on by default, so the bot only sees
        messages that mention it or reply to it. That is usually what you want in a busy
        group. To let it read everything: BotFather → <code>/mybots</code> → your bot → Bot
        Settings → Group Privacy → Turn off, then remove and re-add the bot for the change
        to take effect.</div>
      </div>

      <div class="gd-sub" id="whatsapp">
      <h3>WhatsApp</h3>
      <p>A WhatsApp channel links a real number the way WhatsApp Web does: you scan a QR
        code from your phone, and the server holds the linked-device session. The agent
        behind it is the same agent — same workspace, same memory, same voice and file
        handling — reached over a different transport.</p>
      <ol class="steps">
        <li>Install the bridge once:
          <code>sudo bash /opt/joya/deploy/install-whatsapp.sh</code></li>
        <li><a href="/channels/new">Channels › Add channel</a>, pick WhatsApp, name it, and
          connect it to an agent.</li>
        <li>Add the numbers allowed to talk to it, in international format.</li>
        <li>Press <strong>Start linking</strong>, then on your phone:
          <strong>WhatsApp → Settings → Linked devices → Link a device</strong> and scan
          the code. It expires after about a minute; reload for a fresh one.</li>
      </ol>
      <div class="alert warn">WhatsApp has no official API for this. The bridge uses an
        unofficial library, which is against WhatsApp's terms of service, and the number
        <strong>can be banned without warning</strong>. Use a number you can afford to
        lose, not your main business line.</div>
      <p class="muted small">A WhatsApp channel with no agent connected does not run at
        all — collecting messages with nothing to answer them is worse than being visibly
        off. Group chats are ignored by design.</p>
      </div>

      <div class="gd-sub" id="channels">
      <h3>Telegram broadcast channels</h3>
      <p class="muted">Not to be confused with a Joya <em>channel</em>, which is any way of
        reaching an agent. This is Telegram's own broadcast feature.</p>
      <ul>
        <li>A bot added to a channel as admin <strong>can post</strong> to it.</li>
        <li>Channel subscribers cannot reply in a way the bot receives, so there is no
          conversation to have. An agent in a channel can only talk, never listen.</li>
      </ul>
      <p>So: use a <strong>private chat</strong> for a personal agent, a <strong>group with
        topics</strong> for a shared one, and a <strong>channel</strong> only as a
        notification feed. If you want an agent to broadcast — deploy notices, nightly
        summaries, CI results — add its bot to the channel as an admin with post rights and
        give it the channel ID in its role brief; it will post there when asked, while
        continuing to take instructions from you in private.</p>
      </div>
      </div>
    </section>

    <section id="memory" class="card gd">
      <h2>Memory</h2>
      ${where("Agents & sessions › Memory · each Telegram agent's page")}
      <div class="gd-body">
      <p>Two kinds. <b>Claude Code's memory</b> on this machine — every conversation,
        searchable, plus curated facts — is under <b>Memory</b>: search it, add, edit or
        forget a fact, read a past session. Each <b>Telegram agent</b> has its own vault
        (Markdown files and a vector index) on its page; press Reindex if search finds
        nothing.</p>

      <div class="gd-sub" id="vault">
      <h3>A Telegram agent's vault</h3>
      <p>A Telegram session dies on timeout, restart, or <code>/new</code>. Nothing in the
        conversation survives it. Files do. Every agent therefore gets a vault:</p>
      <table class="kv">
        <tr><td><code>CLAUDE.md</code></td><td class="muted">Identity and standing rules.
          Injected into the system prompt every request. Edit it on the agent's page under
          <em>Instructions</em>.</td></tr>
        <tr><td><code>MEMORY.md</code></td><td class="muted">Current state plus an index of
          every note. Also injected every request — so it is the map, not the territory.</td></tr>
        <tr><td><code>memory/*.md</code></td><td class="muted">One durable fact per file,
          linked with <code>[[wikilinks]]</code>. The substance.</td></tr>
        <tr><td><code>WORKLOG.md</code></td><td class="muted">Dated narrative of what was
          done.</td></tr>
      </table>
      <p><b>The vector index.</b> MEMORY.md cannot hold everything — it is in the prompt, so
        it has a budget. The notes it points at are indexed instead: each is chunked by
        heading, embedded with a small model running <strong>on this machine</strong>, and
        stored in a per-agent SQLite database. The agent searches it with a
        <code>memory_search</code> tool before answering anything that depends on prior
        work.</p>
      <p class="muted">Search is hybrid — vector similarity for paraphrase ("how do we
        deploy" finding "release procedure"), keyword matching for the exact tokens
        embeddings lose (error codes, flag names, IDs) — and the two rankings are merged.
        The files are the source of truth; the index is a cache you can delete and rebuild
        with the Reindex button at any time. Nothing is sent anywhere to be embedded.</p>
      <p><b>Curating it.</b> Memory rots if nobody prunes it. The single highest-value
        maintenance action is correcting a wrong note — an agent that keeps repeating a
        mistake is usually reading a stale memory, and fixing that one file fixes the
        behaviour permanently. Do it on the agent's page under <em>Memory</em>, or in
        Obsidian.</p>
      </div>

      <div class="gd-sub" id="obsidian">
      <h3>Obsidian</h3>
      <p>Every vault is a real Obsidian vault — backlinks, graph view, search, the lot.
        Obsidian is installed on this server's desktop, so the quickest way in is over RDP.
        RDP is not exposed to the internet; tunnel it over SSH first:</p>
      <pre>ssh -N -L 13389:127.0.0.1:3389 ubuntu@${ssh}</pre>
      <p>Then point Remote Desktop at <code class="mono">127.0.0.1:13389</code>, log in, and
        open Obsidian. Each agent's vault is at:</p>
      <pre>/opt/joya-agents/agents/&lt;agent&gt;/vault</pre>
      <p class="muted">Open several as separate vaults and switch between them, or open
        <code>/opt/joya-agents/agents</code> as one vault to see every agent's memory in a
        single graph.</p>
      <p class="muted small">Editing notes by hand is expected and safe. The agent re-reads
        files on its next search; you never need to tell it you changed something.</p>
      </div>
      </div>
    </section>

    <section id="machine" class="card gd">
      <h2>The machine</h2>
      ${where("Machine › Machine health · Services · Audit log")}
      <div class="gd-body">
      <p><b>Machine health</b> shows CPU, memory, disk, security and access at a glance; the
        Command Center's Machine panel shows the same in brief.
        <b>Services</b> lists every unit this panel tracks — restart one or read its logs;
        the <b>Agents</b> tab shows the Telegram agent and hired-session units. The <b>Audit
        log</b> records every sign-in and every change.</p>
      </div>
    </section>

    <section id="access" class="card gd">
      <h2>Users, roles and credentials</h2>
      ${where("Access & security › Users · Roles · Credentials")}
      <div class="gd-body">
      <p>A user has exactly one <b>role</b>; the role carries the permissions and the agent /
        channel scope. ${
          require("./signin").passwordOnly
            ? `<b>Add user</b> gives them a username and a temporary password. <b>Manage</b> changes a
        role, resets the password, disables or deletes, and lets an administrator sign out that user's devices.`
            : `<b>Add user</b> sends them through authenticator enrolment (Microsoft
        Authenticator: “Other account”). <b>Manage</b> changes a role, resets the
        authenticator (which also removes their passkeys), disables or deletes, and lets an
        administrator sign out that user's devices.`
        } Built-in roles cannot be deleted. Talking to JOYA AI by voice is its own
        permission (<code>voice.use</code>), given to administrators only.</p>
      ${require("./signin").passwordOnly ? "<p>Everyone signs in with a username and password; approving a sensitive action asks for the password again.</p>" : `<p><b>Passkeys.</b> On <b>Account › Passkeys</b> you can add this device (Windows Hello:
        face, fingerprint or PIN) after a fresh code; signing in then asks for the password and
        Windows Hello instead of the code. A passkey works only at the address where it was
        added (joya.example.com is the one to use), the authenticator code stays one click
        away on every sign-in, and root unlock and approvals still ask for the code.</p>`}
      <p><b>Credentials</b> holds the secrets the agents share; the OpenAI key for voice lives
        in <b>JOYA AI › Settings › Voice</b>.</p>
      </div>
    </section>

    <section id="devices" class="card gd">
      <h2>Devices and SSH keys</h2>
      ${where("Access & security › Devices · SSH keys")}
      <div class="gd-body">
      <p><b>Devices</b> lists every browser signed in to Joya as you — device, browser,
        IP, when it signed in and when it was last seen; <b>this device</b> is marked.
        <b>Sign out</b> ends one at once (a live call on it ends too); <b>Sign out all other
        devices</b> keeps only this one. A session also ends after 8 hours unused. The same
        list is under the avatar menu's <b>Signed-in devices</b>, and an administrator can
        sign out another user's devices from <b>Users › Manage</b>.</p>
      <p>To let a laptop in over SSH, use <b>SSH keys › Pair a device</b>: a one-time code the
        laptop enters at <span class="mono">/pair</span> installs its key.</p>
      </div>
    </section>

    <section id="trouble" class="card gd">
      <h2>Troubleshooting</h2>
      ${where("Everywhere")}
      <div class="gd-body">
      <table class="kv">
        <tr><td><b>No microphone</b></td><td class="muted">Voice is disabled, no token is
          set (JOYA AI › Settings › Voice), or your role may not talk by voice; only
          administrators may.</td></tr>
        <tr><td><b>It hears itself</b></td><td class="muted">Use Speakers mode, or
          headphones.</td></tr>
        <tr><td><b>A session stopped working</b></td><td class="muted">It may be paused at its
          token cap: JOYA AI › Settings › Usage &amp; token caps, or the Decision card.</td></tr>
        <tr><td><b>JOYA AI cannot open a page</b></td><td class="muted">Rescan pages, and check
          its allow switch — JOYA AI › Settings › Screen control.</td></tr>
        <tr><td><b>Signed out unexpectedly</b></td><td class="muted">Another device signed you
          out, or 8 hours passed — Devices.</td></tr>
        <tr><td><b>Bot never answers</b></td><td class="muted">Check the agent is
          <em>active</em> on its page, then check your Telegram user ID is in its channel's
          allowed list. An unlisted user is silently ignored — by design, but it looks like a
          dead bot.</td></tr>
        <tr><td><b>Unit is <em>failed</em></b></td><td class="muted">Open the Logs tab. A
          rejected token and a missing Claude credential are the two usual causes and both
          say so plainly.</td></tr>
        <tr><td><b>Answers, then goes quiet</b></td><td class="muted">Two pollers on one bot
          token. Make sure no other agent — and no bot running elsewhere — uses the same
          token.</td></tr>
        <tr><td><b>Forgets things</b></td><td class="muted">Look at MEMORY.md. If it is empty,
          the agent is not writing memories: tighten the instruction in CLAUDE.md that tells
          it to write before reporting work done.</td></tr>
        <tr><td><b>Search finds nothing</b></td><td class="muted">Press Reindex on the agent's
          Memory tab and watch the chunk count.</td></tr>
        <tr><td><b>Cannot reach a file</b></td><td class="muted">The agent is confined to its
          workspace. To give it a project, set the project directory in its Settings rather
          than loosening anything.</td></tr>
      </table>
      </div>
    </section>

    <section id="where" class="card gd">
      <h2>Where things live</h2>
      ${where("On this machine")}
      <div class="gd-body">
      <pre>/opt/joya-dashboard/       this panel (Joya)
/opt/joya-ai/              JOYA AI's supervisor, its CLI and joya-session@ units
/opt/joya-agents/          Telegram agents: runtime, vaults, vectors
/etc/joya-ai/              JOYA AI's config (read-only here)
/var/lib/joya-dashboard/   users, roles, settings, sign-in sessions</pre>
      <div class="gd-sub" id="layout">
      <h3>Inside /opt/joya-agents</h3>
      <pre>/opt/joya-agents/
├── runtime/              shared Python runtime (the Telegram↔Claude bridge)
├── shared/
│   ├── claude-auth.env   Claude credential, readable only by the agent account
│   ├── models/           the embedding model, downloaded once
│   └── home/             HOME for the agent account
├── vault-template/       what a new agent's vault is copied from
├── agents/&lt;name&gt;/
│   ├── agent.env         generated config, 0600 — holds the bot token
│   ├── agent.json        metadata, no secrets
│   ├── mcp.json          wires the memory server to this agent's vault
│   ├── data/bot.db       conversation sessions
│   ├── vectors/memory.db the vector index
│   └── vault/            CLAUDE.md · MEMORY.md · WORKLOG.md · memory/
└── archived/&lt;name&gt;-&lt;ts&gt;/  deleted agents, kept whole</pre>
      </div>
      <h3>Privilege</h3>
      <p class="muted">This panel runs as an unprivileged account that can execute exactly
        one command as root: <code class="mono">joya-helper</code>, which validates every
        argument against a whitelist and never invokes a shell. Agents run as a separate
        account under a systemd sandbox with a read-only filesystem apart from their own
        directory. Keys and tokens reach the helper over stdin, never on a command line where
        another local user could read them from <code>/proc</code>.</p>
      <p class="muted small">Full architecture and threat model: the repository README.</p>
      </div>
    </section>`;

  return shell("Guide", docLayout(main, tocCard(GUIDE_TOC, "Contents")), {
    user,
    csrf,
    active: "guide",
    pattern: "c",
    heading: "Guide",
    subtitle: "How Joya works, page by page.",
    assets: ["guide.css", "guide.js"],
  });
};
