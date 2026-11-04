"use strict";
/** Agent management, and the Agents Dashboard. */

const {
  esc,
  bytes,
  shell,
  agentPill,
  card,
  stat,
  flashes,
  empty,
  icon,
  stamp,
  ago,
  can,
  steps,
} = require("./ui");
const { byScope } = require("./catalog");
const { renderAddons } = require("./views-addons");
const avatar = require("./agent-avatar");

const MODELS = [
  ["claude-opus-5-5", "Opus 5.5 — best all-round, the default"],
  ["claude-sonnet-5-5", "Sonnet 5.5 — faster, cheaper"],
  ["claude-haiku-5-5", "Haiku 5.5 — fastest, cheapest"],
  ["claude-fable-5-1", "Fable 5.1 — strongest reasoning, dearest"],
  ["claude-opus-5", "Opus 5 — previous generation"],
  ["claude-sonnet-5", "Sonnet 5 — previous generation"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5 — previous generation"],
];

/** How hard the agent thinks before answering. */
const EFFORTS = [
  ["low", "Low — answers fast, thinks little"],
  ["medium", "Medium — the default, right for most agents"],
  ["high", "High — thinks longer on hard problems"],
  ["xhigh", "Extra high — slower and dearer again"],
  ["max", "Max — everything it has, for genuinely hard reasoning"],
];

/** Whether the agent may post the files it makes into the chat that asked. */
const fileSendSwitch = (on) =>
  `<input type="hidden" name="file_send_shown" value="1">
  <label class="check"><input type="checkbox" name="file_send" value="1"${on === false ? "" : " checked"}>
    Send files to chat <span class="hint">lets it post the Word, PDF and Excel files it makes into the same chat and topic that asked — files from its own folder only, up to 20&nbsp;MB each and 5 per reply</span></label>`;

/** Pictures drawn in code (SVG, rendered to PNG on the server); rides on file sending. */
const drawingSwitch = (on) =>
  `<input type="hidden" name="drawing_shown" value="1">
  <label class="check"><input type="checkbox" name="drawing" value="1"${on === false ? "" : " checked"}>
    Images (drawn in code) <span class="hint">lets it draw logos, icons and illustrations as SVG, look at the rendered picture and refine it, then send the SVG with a PNG preview — free, no image service or key. Needs Send files to chat</span></label>`;

const effortSelect = (current) =>
  `<label>Thinking effort <span class="hint">higher levels cost noticeably more time and tokens on every turn, so raise it for agents that reason rather than agents that answer</span>
    <select name="effort">
      ${EFFORTS.map(
        ([id, label]) =>
          `<option value="${id}"${
            (current || "medium") === id ? " selected" : ""
          }>${label}</option>`
      ).join("")}
    </select></label>`;

function tabs(slug, active) {
  const items = [
    ["", "overview", "Overview", "overview"],
    ["/instructions", "instructions", "Instructions", "guide"],
    ["/memory", "memory", "Memory", "memory"],
    ["/logs", "logs", "Logs", "logs"],
    ["/settings", "settings", "Settings", "settings"],
  ];
  return `<nav class="tabs" aria-label="Agent sections">${items
    .map(
      ([suffix, key, label, ic]) =>
        `<a href="/agents/${esc(slug)}${suffix}" class="${active === key ? "on" : ""}"${
          active === key ? ' aria-current="page"' : ""
        }>${icon(ic, 14)}${label}</a>`
    )
    .join("")}</nav>`;
}

/** The trail for every page under one agent. */
const agentCrumbs = (agent, here) =>
  [["Agents overview", "/agents/dashboard"], ["Agents", "/agents"], [agent.slug, "/agents/" + agent.slug]].concat(
    here ? [[here, null]] : []
  );

const GETS = [
  ["Workspace", "An isolated directory it may read and write. Nothing outside it."],
  ["Memory vault", "CLAUDE.md, MEMORY.md, WORKLOG.md and memory/ — a real Obsidian vault."],
  ["Vector index", "Local embeddings over that vault, which the agent searches itself."],
  ["systemd unit", "Restarts on crash, starts on boot, logs to the journal."],
  ["A channel", "Added separately, so you can change how it is reached without rebuilding it."],
];

function controls(csrf, agent) {
  const state = agent.state || {};
  const running = state.active === "active";
  const button = (action, label, cls, iconName) => `
    <form method="post" action="/agents/${esc(agent.slug)}/action" class="inline">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="action" value="${action}">
      <button class="btn ${cls} small" type="submit">${icon(iconName)} ${label}</button>
    </form>`;
  const parts = [];
  if (running) {
    parts.push(button("restart", "Restart", "", "restart"));
    parts.push(button("stop", "Stop", "danger", "stop"));
  } else {
    parts.push(button("start", "Start", "primary", "play"));
  }
  return `<div class="btn-row">${parts.join("")}</div>`;
}

/* ------------------------------------------------------ agents dashboard - */

/**
 * Agents & sessions ▸ Overview: everything that acts on this machine -- the
 * sessions round JOYA AI (with Keep / Retire / Stop / Resume, as on Sessions ▸
 * Live), the Telegram agents, and what an agent can be given.
 *
 * @param o { csrf, user, agents, channels, probe, flash, err,
 *            team (sessions round JOYA AI, or null), limits (hire-limits, or null),
 *            facts (Claude memory facts, or null), running (priv.ccRunning, or null) }
 */
exports.dashboard = ({ csrf, user, agents, channels, probe, flash, err, team, limits, facts, running: runningNow }) => {
  const running = agents.filter((a) => a.state && a.state.active === "active");
  const failed = agents.filter((a) => a.state && a.state.active === "failed");
  const noChannel = agents.filter((a) => !a.channel);
  const totalNotes = agents.reduce((n, a) => n + (a.notes || 0), 0);
  const totalChunks = agents.reduce((n, a) => n + ((a.memory || {}).chunks || 0), 0);

  const alerts = [];
  if (probe && !probe.claude_credential) {
    alerts.push(["warn", `No Claude credential is set, so agents can receive messages but cannot answer.
      <a href="/credentials">Set one now</a>.`]);
  }
  // systemd reads an EnvironmentFile only at unit start, so an agent that was
  // already running when the credential changed still holds the old one. It
  // looks configured everywhere and fails at the only moment that matters, so
  // it is called out rather than left to be discovered.
  if (probe && (probe.credential_stale_agents || []).length) {
    alerts.push(["warn", `The Claude credential changed after
      ${probe.credential_stale_agents.map(esc).join(", ")} started, so
      ${probe.credential_stale_agents.length === 1 ? "it is" : "they are"} still running with the old one and
      cannot authenticate. Restart from <a href="/services?kind=agents">Services ▸ Agents</a>.`]);
  }
  if (failed.length) {
    alerts.push(["bad", `${failed.length} agent${failed.length === 1 ? " is" : "s are"} in a failed state:
      ${failed.map((a) => `<a href="/agents/${esc(a.slug)}/logs">${esc(a.name || a.slug)}</a>`).join(", ")} — the logs say why.`]);
  }
  if (noChannel.length) {
    alerts.push(["warn", `${noChannel.length} agent${noChannel.length === 1 ? " has" : "s have"} no channel and
      cannot be reached: ${noChannel.map((a) => `<a href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>`).join(", ")}.
      <a href="/channels/new">Add a channel</a>.`]);
  }
  const worst = alerts.some((a) => a[0] === "bad") ? "bad" : "warn";

  const liveTeam = team && !team.error ? team.sessions.filter((x) => !x.self) : null;
  const hired = liveTeam ? liveTeam.filter((x) => x.hire).length : null;
  const claudeViews = require("./views-claude");
  const seesAgents = can(user, "agents.view");
  return shell(
    "Agents overview",
    `${flashes({ msg: flash, err })}
    <div class="stats4">
      ${stat(liveTeam ? liveTeam.length + (limits && limits.max_live ? " / " + limits.max_live : "") : "—", "sessions live", "activity")}
      ${stat(hired == null ? "—" : hired, "hired by JOYA AI", "core")}
      ${seesAgents ? stat(running.length + " / " + agents.length, "Telegram agents running", "agents") : ""}
      ${facts != null ? stat(Number(facts).toLocaleString("en-US"), "memory facts", "memory") : seesAgents ? stat(totalNotes.toLocaleString("en-US"), "agent memory notes", "memory") : ""}
    </div>
    ${
      team
        ? card("Live sessions", claudeViews.teamTable(csrf, user, team, runningNow), {
            icon: "activity",
            id: "a-sessions",
            actions: `<a class="btn small" href="/joya-ai#sessions">See them as spheres</a>`,
          })
        : ""
    }
    ${
      alerts.length
        ? `<div class="alert ${worst}">${icon("alert")}<div>${alerts.map((a) => a[1]).join(" &nbsp;·&nbsp; ")}</div></div>`
        : ""
    }
    ${
      !seesAgents
        ? ""
        : `<section class="card" id="a-telegram"><div class="card-head"><h2>${icon("agents")}Telegram agents</h2><span class="muted small">${running.length} running · ${channels.length} channel${
            channels.length === 1 ? "" : "s"
          }</span></div>${
            agents.length
              ? agentTable(csrf, user, agents)
              : empty("agents", "No agents yet", can(user, "agents.create") ? 'An agent is a Claude session with its own memory. <a href="/agents/new">Create the first one</a>.' : "An agent is a Claude session with its own memory.")
          }</section>
    ${card(
      "Capabilities",
      `<table class="kv">
        ${can(user, "addons.view") ? `<tr><td>Add-ons</td><td><a href="/addons">What an agent can be given</a></td></tr>` : ""}
        <tr><td>Agent services</td><td><a href="/services?kind=agents">Services ▸ Agents</a></td></tr>
      </table>
      <details class="set-more" id="a-gets"><summary>What every agent gets</summary><div class="set-more-body"><dl class="ds-dl">${GETS.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></div></details>`,
      { icon: "addons", id: "a-capabilities" }
    )}`
    }`,
    {
      user,
      csrf,
      active: "agents-dashboard",
      pattern: "c",
      heading: "Agents overview",
      subtitle: "Everything that acts on this machine: JOYA AI's sessions and the Telegram agents.",
      actions: `${can(user, "channels.view") ? `<a class="btn" href="/channels">${icon("channels")} Channels</a>` : ""}
        ${can(user, "agents.create") ? `<a class="btn primary" href="/agents/new">${icon("plus")} New agent</a>` : ""}`,
    }
  );
};

/* ----------------------------------------------------------------- list --- */

/**
 * An agent's state as a word and a shape, never colour alone: a filled dot
 * running, a triangle failed, a hollow ring stopped, a half dot in between.
 */
const STATE_WORDS = {
  active: ["Running", "ok", '<circle cx="8" cy="8" r="5"/>'],
  failed: ["Failed", "bad", '<path d="M8 2.5 14 13H2Z"/>'],
  activating: ["Starting", "warn", '<path d="M8 3a5 5 0 0 1 0 10Z"/><circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>'],
  deactivating: ["Stopping", "warn", '<path d="M8 3a5 5 0 0 1 0 10Z"/><circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>'],
  inactive: ["Stopped", "off", '<circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>'],
};
function stateChip(st) {
  const [word, tone, shape] = STATE_WORDS[st] || [st || "Unknown", "off", '<circle cx="8" cy="8" r="4.25" fill="none" stroke-width="1.5"/>'];
  return `<span class="state ${tone}" title="systemd: ${esc(st || "unknown")}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" stroke="currentColor">${shape}</svg>${esc(word)}</span>`;
}
exports.stateChip = stateChip;

const EFFORT_WORDS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const modelWord = (id) => {
  const m = MODELS.find((x) => x[0] === id);
  return m ? m[1].split(" — ")[0] : id || "—";
};

/** The Telegram agents as one table: who, state, how they are reached, the mind, memory, actions. */
function agentTable(csrf, user, agents) {
  const rows = agents
    .map((a) => {
      const st = (a.state && a.state.active) || "inactive";
      const mem = a.memory || {};
      const label = a.name || a.slug;
      const ch = a.channel;
      const chCell = ch
        ? `<a class="ch" href="/channels/${esc(ch.slug)}">${icon(ch.type === "whatsapp" ? "whatsapp" : "telegram", 16)}<span>${esc(
            ch.type === "whatsapp" ? "WhatsApp" : "Telegram"
          )}${ch.telegram_bot_username ? ` <span class="sub mono">@${esc(ch.telegram_bot_username)}</span>` : ch.name && ch.type === "whatsapp" ? ` <span class="sub">${esc(ch.name)}</span>` : ""}</span></a>`
        : `<a class="ch none" href="/channels/new">${icon("plus", 16)}<span>No channel — add one</span></a>`;
      const actions = can(user, "agents.control", a.slug) ? controls(csrf, a) : "";
      return `<tr>
        <th scope="row" data-h="Agent"><div class="who">${avatar.agentTile(a, "sm")}<div class="who-t"><a class="nm" href="/agents/${esc(a.slug)}">${esc(label)}</a><span class="sub mono">${esc(a.slug)}</span></div></div></th>
        <td data-h="State">${stateChip(st)}</td>
        <td data-h="Channel">${chCell}</td>
        <td data-h="Model"><span>${esc(modelWord(a.model))}</span><span class="sub">${esc(EFFORT_WORDS[a.effort || "medium"] || a.effort)} effort</span></td>
        <td data-h="Memory" class="num"><span>${(a.notes || 0).toLocaleString("en-US")} notes</span><span class="sub">indexed ${esc(ago(mem.last_indexed))}</span></td>
        <td data-h="" class="acts"><div class="acts-in">${actions}
          <details class="ds-menu"><summary aria-label="More for ${esc(label)}">More</summary><div class="ds-menu-pop" role="list">
            <a role="listitem" href="/agents/${esc(a.slug)}/instructions">${icon("guide", 16)}Instructions</a>
            <a role="listitem" href="/agents/${esc(a.slug)}/memory">${icon("memory", 16)}Memory</a>
            <a role="listitem" href="/agents/${esc(a.slug)}/logs">${icon("logs", 16)}Logs</a>
            <a role="listitem" href="/agents/${esc(a.slug)}/settings">${icon("settings", 16)}Settings</a>
          </div></details></div></td>
      </tr>`;
    })
    .join("");
  return `<div class="ds-card flush"><table class="ds-table agents-table">
    <caption class="sr">Telegram agents</caption>
    <thead><tr><th scope="col">Agent</th><th scope="col">State</th><th scope="col">Channel</th><th scope="col">Model</th><th scope="col" class="num">Memory</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/** What an agent gets, as a plain definition list under the table. */
function getsList() {
  return `<section class="ds-card" aria-labelledby="gets-h"><h2 id="gets-h" class="ds-card-title">What every agent gets</h2>
    <dl class="ds-dl">${GETS.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>`;
}

exports.list = ({ csrf, user, agents, flash, err }) => {
  const running = agents.filter((a) => a.state && a.state.active === "active").length;
  const failed = agents.filter((a) => a.state && a.state.active === "failed").length;
  const summary = agents.length
    ? `<p class="ds-summary">${agents.length} agent${agents.length === 1 ? "" : "s"} · ${running} running${
        failed ? ` · <strong class="bad-t">${failed} failed</strong>` : ""
      }</p>`
    : "";
  return shell(
    "Agents",
    `${flashes({ msg: flash, err })}
    ${summary}
    ${
      agents.length
        ? agentTable(csrf, user, agents)
        : `<div class="ds-card">${empty(
            "agents",
            "No agents yet",
            can(user, "agents.create")
              ? 'An agent is one Claude session with its own workspace and memory, reached through a Telegram or WhatsApp channel. <a href="/agents/new">Create the first one</a>.'
              : "An agent is one Claude session with its own workspace and memory. Your role cannot create one."
          )}</div>`
    }
    ${getsList()}`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "c",
      heading: "Telegram agents",
      subtitle: "Each agent is one Claude session with its own memory. They cannot see each other.",
      actions: can(user, "agents.create") ? `<a class="btn primary" href="/agents/new">${icon("plus")} New agent</a>` : "",
    }
  );
};

/* ------------------------------------------------------------------ new --- */

exports.create = ({ csrf, user, form = {}, errors = [], probe }) => {
  const v = (k, d) => esc(form[k] != null && form[k] !== "" ? form[k] : d == null ? "" : d);
  const chosen =
    form.addons ||
    byScope("agent")
      .filter((a) => a.default || a.locked)
      .map((a) => a.id);

  return shell(
    "New agent",
    `${steps(1, ["Create the agent", "Connect a channel"])}
    ${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
    <div class="alert info">${icon("info")}<div>An agent is the mind: a workspace, a memory
      vault and a role. It has no way to be reached until a channel is connected, which is
      the next step — you will be taken straight there.</div></div>

    <form method="post" action="/agents/new" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Identity",
        `<label>Display name <span class="hint">what you call it</span>
          <input name="name" value="${v("name")}" placeholder="e.g. Odoo Dev" maxlength="64" required autofocus></label>
        <label>Short name <span class="hint">lowercase; names the folder and the systemd unit, and cannot be changed later</span>
          <input name="slug" value="${v("slug")}" placeholder="odoo-dev"
                 pattern="[a-z][a-z0-9\\-]{1,30}" maxlength="31" required></label>
        <label>What it does <span class="hint">its role, written into CLAUDE.md and loaded on every request — this is the field that decides whether the agent is useful. It also picks the agent's bot avatar (change it later in Settings)</span>
          <textarea name="role" rows="7" placeholder="You maintain the Odoo 17 instance at /opt/projects/odoo. You handle module changes, migrations and deployment. You may edit code and run tests unattended. Ask before restarting the service during working hours.">${v("role")}</textarea></label>`,
        { icon: "agents" }
      )}

      ${card(
        "Behaviour",
        `<label>Model
          <select name="model">
            ${MODELS.map(
              ([id, label]) =>
                `<option value="${id}" ${form.model === id ? "selected" : ""}>${label}</option>`
            ).join("")}
          </select></label>
        ${effortSelect(form.effort)}
        <label>Verbosity <span class="hint">how much of its own work it narrates in chat</span>
          <select name="verbose_level">
            <option value="0" ${form.verbose_level === "0" ? "selected" : ""}>Quiet — final answer only</option>
            <option value="1" ${form.verbose_level !== "0" && form.verbose_level !== "2" ? "selected" : ""}>Normal — tool names as it works</option>
            <option value="2" ${form.verbose_level === "2" ? "selected" : ""}>Detailed — tools with inputs</option>
          </select></label>
        <label>Project directory <span class="hint">optional. Must be under /opt/projects, /srv or /opt/joya-agents/workspaces. Appears inside the vault as <code>project/</code>.</span>
          <input name="project_dir" value="${v("project_dir")}" placeholder="/opt/projects/odoo"></label>
        ${fileSendSwitch(form.file_send)}
        ${drawingSwitch(form.drawing)}`,
        { icon: "settings" }
      )}

      ${card(
        "Add-ons",
        `<p class="muted small">What this agent can do once a message reaches it. What it
          can <em>receive</em> is set on its channel.</p>
        ${renderAddons(byScope("agent"), chosen, probe)}`,
        { icon: "addons" }
      )}

      ${card(
        "",
        `<p class="muted small">On save the vault is scaffolded and the vector index is
          built. Takes a few seconds. You then go straight to connecting a channel.</p>
        <button class="btn primary" type="submit">${icon("plus")} Create agent</button>
        <a class="btn" href="/agents">Cancel</a>`
      )}
    </form>`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "c",
      heading: "Create agent",
      subtitle: "Step 1 of 2: name, what it does and the model. The channel it answers on comes next.",
    }
  );
};

/* --------------------------------------------------------------- detail --- */

/** Journal lines as markup: escaped, one span each, warnings and errors tinted. */
const JOURNAL_PREFIX = /^(\d{4}-(\d\d-\d\d)T(\d\d:\d\d:\d\d))\S*\s+\S+\s+[^\s:]+:\s?/;

function journalHtml(lines) {
  return (lines || [])
    .map((raw) => {
      // "2026-09-27T18:36:35+02:00 host unit[pid]: message" -> "09-27 18:36:35 message":
      // the host and unit are the same on every line of an agent's own journal.
      const m = JOURNAL_PREFIX.exec(raw);
      const l = m ? raw.slice(m[0].length) : raw;
      const t = m ? `<span class="t">${esc(m[2] + " " + m[3])}</span> ` : "";
      const cls = /\b(error|failed|traceback|exception|fatal)\b/i.test(l)
        ? " e"
        : /\b(warn|warning|retry|retrying|timeout)\b/i.test(l)
        ? " w"
        : /\b(started|resumed|ready|listening)\b/i.test(l)
        ? " ok"
        : "";
      return `<span class="ln${cls}">${t}${esc(l)}</span>`;
    })
    .join("");
}
exports.journalHtml = journalHtml;

/** The agent's avatar, name and state: the head of every page under an agent. */
function agentHead(agent) {
  const st = (agent.state && agent.state.active) || "inactive";
  return `<span class="agent-h1">${avatar.agentTile(agent, "md")}<span>${esc(agent.name || agent.slug)}</span> ${agentPill(st)}</span>`;
}

/**
 * One agent, as a HUD (pattern A): its service, channel and configuration on
 * the left, its memory drawn as a dial of notes in the centre, and its journal
 * tailing live on the right -- the same privileged read, the same permission
 * and the same redaction as the Logs tab.
 */
exports.detail = ({ csrf, user, agent, notes = [], journal = null, journalErr = null, flash, err }) => {
  const mem = agent.memory || {};
  const state = agent.state || {};
  const ch = agent.channel;
  const canLogs = can(user, "agents.logs", agent.slug);
  const canControl = can(user, "agents.control", agent.slug);
  const canMemRead = can(user, "agents.memory.read", agent.slug);
  const canMemWrite = can(user, "agents.memory.write", agent.slug);

  const alerts = [];
  if (!ch) {
    alerts.push(["warn", `No channel is connected, so this agent cannot receive messages and is not running.
      <a href="/channels/new">Add a channel</a>.`]);
  }
  if (state.active === "failed") {
    alerts.push(["bad", `This agent is in a failed state. The <a href="/agents/${esc(agent.slug)}/logs">logs</a> will say
      why — a rejected bot token and a missing Claude credential are the two usual causes.`]);
  }

  return shell(
    agent.name || agent.slug,
    `${tabs(agent.slug, "overview")}
    ${flashes({ msg: flash, err })}
    ${alerts.map((a) => `<div class="alert ${a[0]}">${icon("alert")}<div>${a[1]}</div></div>`).join("")}

    <div class="ad-grid">
      <div class="col">
        <section class="card hud">
          <div class="card-head"><h2>${icon("services")}Service</h2><span class="card-aside mono">joya-agent@${esc(agent.slug)}</span></div>
          <table class="kv">
            <tr><td>State</td><td>${agentPill(state.active)}</td></tr>
            <tr><td>At boot</td><td>${esc(state.enabled || "—")}</td></tr>
            <tr><td>Since</td><td class="mono small">${esc(String(state.since || "").replace(/^[A-Z][a-z]{2} /, "").slice(0, 19) || "—")}</td></tr>
            <tr><td>Unit</td><td class="mono small">joya-agent@${esc(agent.slug)}</td></tr>
          </table>
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon("channels")}Channel</h2>${
            ch ? `<a class="btn small" href="/channels/${esc(ch.slug)}">Open</a>` : ""
          }</div>
          ${
            ch
              ? `<table class="kv">
                  <tr><td>Channel</td><td><a href="/channels/${esc(ch.slug)}">${esc(ch.name)}</a></td></tr>
                  <tr><td>Type</td><td>${esc(ch.type)}</td></tr>
                  ${ch.telegram_bot_username ? `<tr><td>Bot</td><td class="mono small">@${esc(ch.telegram_bot_username)}</td></tr>` : ""}
                  <tr><td>Allowed</td><td class="mono small">${esc(ch.allowed_users || "nobody")}</td></tr>
                </table>
                ${
                  ch.telegram_bot_username
                    ? `<p class="muted small foot-note">Open the chat: <code>https://t.me/${esc(ch.telegram_bot_username)}</code></p>`
                    : ""
                }`
              : `<p class="muted">Not connected.</p>
                 <div class="btn-row"><a class="btn primary small" href="/channels/new">${icon("plus")} Add a channel</a></div>`
          }
        </section>
        <section class="card grow scroll-y">
          <div class="card-head"><h2>${icon("settings")}Configuration</h2>${
            can(user, "agents.edit", agent.slug) ? `<a class="btn small" href="/agents/${esc(agent.slug)}/settings">Edit</a>` : ""
          }</div>
          <table class="kv">
            <tr><td>Model</td><td class="mono small">${esc(agent.model || "—")}</td></tr>
            <tr><td>Thinking effort</td><td>${esc(EFFORT_WORDS[agent.effort || "medium"] || agent.effort)}</td></tr>
            <tr><td>Verbosity</td><td>${esc(String(agent.verbose_level))}</td></tr>
            <tr><td>Max turns</td><td>${esc(String(agent.max_turns || "—"))}</td></tr>
            <tr><td>Timeout</td><td>${esc(String(agent.timeout_seconds || "—"))}s</td></tr>
            <tr><td>Project</td><td class="mono small">${esc(agent.project_dir || "none")}</td></tr>
            <tr><td>Send files to chat</td><td>${agent.file_send === false ? "Off" : "On"}</td></tr>
            <tr><td>Images (drawn in code)</td><td>${
              agent.drawing === false ? "Off" : agent.file_send === false ? "Off (needs Send files to chat)" : "On"
            }</td></tr>
            <tr><td>Add-ons</td><td class="small">${
              (agent.addons || []).length ? (agent.addons || []).map(esc).join(", ") : "—"
            }</td></tr>
            <tr><td>Created</td><td class="mono small">${esc(stamp(agent.created_at))}</td></tr>
          </table>
        </section>
      </div>

      <section class="card hud vault" aria-label="Memory vault">
        <div class="card-head"><h2>${icon("memory")}Memory vault</h2>
          <div class="btn-row">${
            canMemRead ? `<a class="btn small" href="/agents/${esc(agent.slug)}/memory">${icon("search")} Browse</a>` : ""
          }${
            canMemWrite
              ? `<form method="post" action="/agents/${esc(agent.slug)}/memory/reindex" class="inline">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <button class="btn small" type="submit">${icon("reindex")} Reindex</button>
                </form>`
              : ""
          }</div></div>
        <div class="vault-art">
          <svg data-vault="${esc(agent.notes || 0)}" viewBox="-160 -160 320 320" aria-hidden="true"></svg>
          <div class="v-center"><b>${esc(agent.notes || 0)}</b><span>notes</span></div>
        </div>
        <div>
          <div class="vault-stats">
            <div><b>${esc(agent.notes || 0)}</b><span>md files</span></div>
            <div><b>${(mem.chunks || 0).toLocaleString("en-US")}</b><span>chunks</span></div>
            <div><b>${bytes(mem.bytes || 0)}</b><span>index</span></div>
            <div><b>${esc(ago(mem.last_indexed))}</b><span>indexed</span></div>
          </div>
          <div class="card-head"><h2 class="sub-h">Recently written memories</h2>${
            canMemRead ? `<a class="small" href="/agents/${esc(agent.slug)}/memory">All notes</a>` : ""
          }</div>
          ${
            notes.length
              ? `<ul class="notes">${notes
                  .slice(0, 8)
                  .map(
                    (n) => `<li><a href="/agents/${esc(agent.slug)}/memory/note?path=${encodeURIComponent(n.path)}" title="${esc(
                      n.path
                    )}">${esc(n.path)}</a><span>${bytes(n.bytes)}</span><span>${esc(ago(n.modified))}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="muted small">Nothing written yet. The agent creates notes as it works — or you can write
                 the first one yourself in the vault.</p>`
          }
        </div>
      </section>

      <section class="card panel-fill">
        <div class="card-head"><h2>${icon("logs")}Journal · live tail</h2>${
          canLogs ? `<a class="btn small" href="/agents/${esc(agent.slug)}/logs" data-journal-refresh>${icon("restart")} Refresh</a>` : ""
        }</div>
        ${
          canLogs
            ? `<div class="panel-body logbox" data-journal="/api/agents/${esc(agent.slug)}/logs">${
                journalErr ? `<p class="muted small">${esc(journalErr)}</p>` : ""
              }<pre class="logs">${journalHtml(journal || [])}</pre></div>
              <p class="muted small foot-note">Secrets are stripped before this reaches the browser.
                <code>journalctl -u joya-agent@${esc(agent.slug)} -f</code></p>`
            : `<p class="muted small">Your role does not include reading this agent's logs.</p>`
        }
      </section>
    </div>`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "a",
      assets: ["agent-avatar.js"],
      crumbs: agentCrumbs(agent),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      subtitle: `<span class="mono small">${esc(agent.slug)}</span> · ${esc(agent.dir || "")} · ${downloadLink(agent, "dl-link")}`,
      actions: `${canLogs ? `<a class="btn" href="/agents/${esc(agent.slug)}/logs">${icon("logs")} Logs</a>` : ""}${
        canControl ? controls(csrf, agent).replace('class="btn-row"', 'class="btn-row flat"').replace(/ small"/g, '"') : ""
      }`,
    }
  );
};

/* --------------------------------------------------------- instructions --- */

exports.instructions = ({ csrf, user, agent, content, flash, err }) =>
  shell(
    "Instructions — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "instructions")}
    ${flashes({ msg: flash, err })}
    ${card(
      "CLAUDE.md",
      `<p class="muted small">Loaded into the system prompt on every single request. The
        right place for who the agent is, what it may do, and how it should behave — and
        the wrong place for anything that changes often. Saving takes effect on the next
        message; no restart needed.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/instructions">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <textarea name="content" rows="30" class="code" spellcheck="false">${esc(content)}</textarea>
        <button class="btn primary" type="submit">${icon("save")} Save instructions</button>
      </form>`,
      { icon: "guide" }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "c",
      crumbs: agentCrumbs(agent, "Instructions"),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      subtitle: "Standing instructions.",
    }
  );

/* --------------------------------------------------------------- memory --- */

/* The memory tab and one note live in lib/views-memory.js (the organised view, 2026-10-25). */
const memoryChrome = () => ({ shell, tabs, agentCrumbs, agentHead });
exports.memory = (d) => require("./views-memory").agentMemory(d, memoryChrome());
exports.note = (d) => require("./views-memory").agentNote(d, memoryChrome());

/* ----------------------------------------------------------------- logs --- */

exports.logs = ({ csrf, user, agent, lines, err }) =>
  shell(
    "Logs — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "logs")}
    ${flashes({ err })}
    <section class="card fill-card grow">
      <div class="card-head"><h2>${icon("logs")}Last ${esc(lines.length)} journal lines</h2>
        <a class="btn small" href="/agents/${esc(agent.slug)}/logs">${icon("restart")} Refresh</a></div>
      ${
        lines.length
          ? `<div class="panel-body logbox" data-scroll-end><pre class="logs">${journalHtml(lines)}</pre></div>`
          : `<p class="muted">Nothing logged yet.</p>`
      }
    </section>
    <p class="muted small">Secrets are stripped from this view before it reaches the
      browser. Live tail from a shell:
      <code>journalctl -u joya-agent@${esc(agent.slug)} -f</code></p>`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "b",
      fill: true,
      crumbs: agentCrumbs(agent, "Logs"),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      subtitle: "Journal output.",
    }
  );

/* ------------------------------------------------------------- settings --- */

/**
 * Settings ▸ Avatar: the agent's bot head, large, in words; Shuffle shows another one in the same theme
 * (?avatar=shuffle -> candidate), "Use this" stores it (agent.json only, no restart), and the PNG to set
 * as the Telegram bot's picture by hand in @BotFather.
 */
function avatarCard(csrf, user, agent, candidate) {
  const cur = avatar.specFor(agent), shown = candidate || cur;
  const canEdit = can(user, "agents.edit", agent.slug);
  const base = "/agents/" + esc(agent.slug);
  const fields = candidate
    ? avatar.KEYS.map((k) => `<input type="hidden" name="avatar_${k}" value="${esc(String(candidate[k]))}">`).join("")
    : "";
  return card(
    "Avatar",
    `<div class="av-pick">
      ${avatar.tile(shown, "lg")}
      <div>
        <p class="av-desc">${candidate ? "<strong>A new one, not saved yet:</strong> " : ""}${esc(avatar.describe(shown))}.
          <span class="muted">Picked from what the agent does; it stays the same when you edit the role.</span></p>
        <div class="btn-row">
          ${
            canEdit
              ? `${candidate
                  ? `<form method="post" action="${base}/avatar" class="inline">
                      <input type="hidden" name="_csrf" value="${esc(csrf)}">${fields}
                      <button class="btn primary" type="submit">${icon("check")} Use this</button>
                    </form>
                    <a class="btn" href="${base}/settings?avatar=shuffle#avatar">${icon("restart")} Shuffle again</a>
                    <a class="btn" href="${base}/settings#avatar">Keep the current one</a>`
                  : `<a class="btn" href="${base}/settings?avatar=shuffle#avatar">${icon("restart")} Shuffle avatar</a>`}`
              : ""
          }
          ${candidate ? "" : downloadLink(agent)}
        </div>
        ${candidate ? "" : `<p class="muted small">To show it as the Telegram bot's picture, download the PNG and send it to @BotFather with /setuserpic.</p>`}
      </div>
    </div>`,
    { icon: "agents", id: "avatar" }
  );
}

/** The avatar as a 640 px PNG (public/agent-avatar.js; without script, the SVG) to set by hand in @BotFather. */
const downloadLink = (agent, cls = "btn") =>
  `<a class="${cls}" href="/agents/${esc(agent.slug)}/avatar.svg?download=1" download="${esc(agent.slug)}-avatar.svg"
     data-avatar-png="/agents/${esc(agent.slug)}/avatar.svg" data-avatar-name="${esc(agent.slug)}-avatar.png">${icon("download")} Download avatar (PNG)</a>`;

exports.settings = ({ csrf, user, agent, probe, flash, err, candidate }) =>
  shell(
    "Settings — " + (agent.name || agent.slug),
    `${tabs(agent.slug, "settings")}
    ${flashes({ msg: flash, err })}
    ${avatarCard(csrf, user, agent, candidate || null)}

    <form method="post" action="/agents/${esc(agent.slug)}/settings" autocomplete="off">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">

      ${card(
        "Identity",
        `<label>Display name<input name="name" value="${esc(agent.name || "")}" maxlength="64" required></label>
        <p class="muted small">The short name <code>${esc(agent.slug)}</code> is fixed — it
          names the directory and the systemd unit.</p>
        <p class="muted small">The agent's brief lives in
          <a href="/agents/${esc(agent.slug)}/instructions">CLAUDE.md</a>, not here.</p>`,
        { icon: "agents" }
      )}

      ${card(
        "Behaviour",
        `<label>Model
          <select name="model">
            ${MODELS.map(
              ([id, label]) =>
                `<option value="${id}" ${agent.model === id ? "selected" : ""}>${label}</option>`
            ).join("")}
          </select></label>
        ${effortSelect(agent.effort)}
        <label>Project directory<input name="project_dir" value="${esc(agent.project_dir || "")}"
          placeholder="/opt/projects/odoo"></label>
        ${fileSendSwitch(agent.file_send)}
        ${drawingSwitch(agent.drawing)}
        <details class="set-more" id="agent-more"${agent.verbose_level !== 1 || (agent.max_turns && agent.max_turns !== 100) || (agent.timeout_seconds && agent.timeout_seconds !== 1800) ? " open" : ""}><summary>More: turns, timeout, verbosity</summary><div class="set-more-body">
        <label>Max turns per request <span class="hint">100 suits almost every agent</span><input name="max_turns" type="number" min="1" max="500"
          value="${esc(String(agent.max_turns || 100))}"></label>
        <label>Request timeout (seconds) <span class="hint">1800 (30 minutes) by default</span><input name="timeout_seconds" type="number" min="60" max="7200"
          value="${esc(String(agent.timeout_seconds || 1800))}"></label>
        <label>Verbosity <span class="hint">how much of its own work it narrates in chat</span>
          <select name="verbose_level">
            <option value="0" ${agent.verbose_level === 0 ? "selected" : ""}>Quiet: the final answer only</option>
            <option value="1" ${agent.verbose_level === 1 ? "selected" : ""}>Normal: tool names as it works</option>
            <option value="2" ${agent.verbose_level === 2 ? "selected" : ""}>Detailed: tools with inputs</option>
          </select></label>
        </div></details>`,
        { icon: "settings" }
      )}

      ${card(
        "Add-ons",
        `<p class="muted small">What this agent can do. What it can receive is set on
          <a href="${agent.channel ? "/channels/" + esc(agent.channel.slug) : "/channels"}">its channel</a>.</p>
        ${renderAddons(byScope("agent"), agent.addons || [], probe)}`,
        { icon: "addons" }
      )}

      ${card(
        "",
        `<p class="muted small">Saving rewrites the agent's environment and restarts it if
          it is running. Conversations resume — sessions are on disk, not in memory.</p>
        <button class="btn primary" type="submit">${icon("save")} Save settings</button>`
      )}
    </form>


    ${card(
      "Delete this agent",
      `<p class="muted small">Stops the service and moves the whole agent directory — vault,
        vector index, session history — into <code>/opt/joya-agents/archived/</code>.
        Nothing is erased, but the agent stops answering immediately.</p>
      <form method="post" action="/agents/${esc(agent.slug)}/delete"
            data-confirm="Delete ${esc(agent.slug)}? The service stops and the agent is archived.">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Type the agent's short name to confirm
          <input name="confirm" placeholder="${esc(agent.slug)}" autocomplete="off"></label>
        <button class="btn danger" type="submit">${icon("trash")} Delete agent</button>
      </form>`,
      { icon: "trash", className: "danger-zone" }
    )}`,
    {
      user,
      csrf,
      active: "agents",
      pattern: "c",
      crumbs: agentCrumbs(agent, "Settings"),
      heading: agent.name || agent.slug,
      headingHtml: agentHead(agent),
      subtitle: "Configuration.",
      assets: ["agent-avatar.js"],
    }
  );
