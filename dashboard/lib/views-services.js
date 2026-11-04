"use strict";
/** Service management — system units, and the per-agent units. */

const { esc, bytes, shell, statusPill, agentPill, card, flashes, empty, icon, ago, can } =
  require("./ui");
const { OS_SERVICES } = require("./catalog");

const DETAIL = new Map(OS_SERVICES.map((s) => [s.unit, s]));

function controls(csrf, action, target, state) {
  const running = state.active === "active";
  const button = (act, label, cls, confirm) => `
    <form method="post" action="${action}" class="inline"${
      confirm ? ` data-confirm="${esc(confirm)}"` : ""
    }>
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <input type="hidden" name="target" value="${esc(target)}">
      <input type="hidden" name="action" value="${act}">
      <button class="btn ${cls} small" type="submit">${label}</button>
    </form>`;

  const parts = [];
  if (running) {
    parts.push(button("restart", "Restart", "", "Restart " + target + "?"));
  } else {
    parts.push(button("start", "Start", "primary"));
  }
  if (running && state.stoppable !== false) {
    parts.push(button("stop", "Stop", "danger", "Stop " + target + "?"));
  } else if (running) {
    parts.push(`<span class="lockt" title="Stopping it would cut off access">${icon("lock", 12)}restart only</span>`);
  }
  return `<div class="row-end">${parts.join("")}</div>`;
}

/**
 * Machine ▸ Services' tabs: All (every unit this panel tracks), System (not the
 * agents' and channels' own) and Agents (the Telegram agents' units, with their
 * controls -- what was Agents ▸ Agent services). Links: each is ?kind=.
 */
const SERVICE_TABS = [
  ["all", "All", "services.view"],
  ["system", "System", "services.view"],
  ["agents", "Agents", "agents.view"],
];
exports.SERVICE_TABS = SERVICE_TABS; // the page map's Services tabs (lib/page-registry.js)
function tabs(kind, user, counts) {
  const c = counts || {};
  const items = SERVICE_TABS.filter((i) => can(user, i[2]));
  if (items.length < 2) return "";
  return `<nav class="tabs2" role="tablist" aria-label="Services">${items
    .map(([k, label]) => `<a role="tab" href="/services?kind=${k}" aria-selected="${kind === k}">${label}${c[k] != null ? ` <span class="badge plain">${esc(c[k])}</span>` : ""}</a>`)
    .join("")}</nav>`;
}
exports.tabs = tabs;

/** A unit that belongs to an agent or a channel (the Agents tab's), not the machine's. */
function isAgentUnit(s) {
  const unit = String((s && s.unit) || "");
  return s.kind === "agent" || s.kind === "whatsapp" || unit.startsWith("joya-agent@") || unit.startsWith("joya-whatsapp@");
}
exports.isAgentUnit = isAgentUnit;

/* ------------------------------------------------------- system services -- */

function unitMeta(s) {
  const unit = String(s.unit || "");
  if (DETAIL.has(unit)) return DETAIL.get(unit);
  if (s.kind === "agent" || unit.startsWith("joya-agent@")) {
    return { name: "Agent · " + unit.slice("joya-agent@".length), icon: "agents",
      detail: "A Telegram agent's process. Start, stop and restart it from the Agents tab." };
  }
  if (s.kind === "whatsapp" || unit.startsWith("joya-whatsapp@")) {
    return { name: "WhatsApp · " + unit.slice("joya-whatsapp@".length), icon: "whatsapp",
      detail: "A WhatsApp channel's bridge. Managed from its channel." };
  }
  return {};
}

/** What a reported-only unit offers instead of controls: where it is managed, if anywhere here. */
function readOnly(s, meta, user) {
  const unit = String(s.unit || "");
  const tag = `<span class="lockt" title="Reported here; the panel does not control this unit from this page">${icon("lock", 12)}read-only</span>`;
  let link = "";
  if (unit.startsWith("joya-agent@") && can(user, "agents.view")) link = `<a class="btn small" href="/services?kind=agents">${icon("agents", 14)}Agents tab</a>`;
  else if (unit.startsWith("joya-whatsapp@") && can(user, "channels.view"))
    link = `<a class="btn small" href="/channels/${encodeURIComponent(unit.slice("joya-whatsapp@".length))}">${icon("whatsapp", 14)}Channel</a>`;
  else if (unit === "claude-memory" && can(user, "claude.memory.read")) link = `<a class="btn small" href="/claude/memory">${icon("memory", 14)}Memory</a>`;
  else if (unit === "joya-ai" && can(user, "joyaai.use")) link = `<a class="btn small" href="/joya-ai">${icon("core", 14)}Command Center</a>`;
  return tag + link;
}

exports.system = ({ csrf, user, services, flash, err, kind = "all", counts }) =>
  shell(
    "Services",
    `${flashes({ msg: flash, err })}
    ${tabs(kind, user, counts)}
    <div class="alert info">${icon("info")}<div>SSH, nginx, the firewall and this panel
      can be restarted but not stopped from here. Stopping any of them would cut off
      access to the machine or to this page, and getting back in would need the Contabo
      console. Rows marked <em>read-only</em> are reported here so the picture is complete;
      the panel does not control them from this page.</div></div>

    <section class="card table-card fill-card hud">
      <div class="tbl"><table class="rows">
        <thead><tr><th scope="col">Service</th><th scope="col">State</th><th scope="col">At boot</th><th scope="col">Memory</th><th scope="col">Since</th><th scope="col" class="right">Actions</th></tr></thead>
        <tbody>${services
          .map((s) => {
            const meta = unitMeta(s);
            const managed = s.managed !== false;
            const mb = s.memory != null ? s.memory / 1024 / 1024 : null;
            return `<tr>
              <td><div class="svc-name"><span class="svc-ic">${icon(meta.icon || "services", 16)}</span><div>
                <span class="strong">${esc(meta.name || s.unit)}</span> <span class="mono small muted">${esc(s.unit)}</span>
                ${meta.detail ? `<div class="muted">${esc(meta.detail)}</div>` : ""}
              </div></div></td>
              <td>${statusPill(s.active)}</td>
              <td class="small">${esc(s.enabled)}${s.socket_activated ? `<div class="muted small">via socket</div>` : ""}</td>
              <td>${
                mb != null
                  ? `<div class="memline"><span class="mono small">${bytes(s.memory)}</span><div class="bar"><div class="fill" data-w="${Math.min(
                      100,
                      Math.round(mb / 2)
                    )}"></div></div></div>`
                  : `<span class="muted">—</span>`
              }</td>
              <td class="mono small nowrap">${esc(String(s.since || "").replace(/^[A-Z][a-z]{2} /, "").slice(0, 19) || "—")}</td>
              <td class="right"><div class="row-end">${
                managed
                  ? `${controls(csrf, "/services/action", s.unit, s)}
                     <a class="btn small" href="/services/logs?unit=${encodeURIComponent(s.unit)}">${icon("logs", 14)}Logs</a>`
                  : readOnly(s, meta, user)
              }</div></td>
            </tr>`;
          })
          .join("")}</tbody></table></div>
    </section>`,
    {
      user,
      csrf,
      active: "services",
      pattern: "b",
      fill: true,
      heading: "Services",
      subtitle: "Every unit this panel tracks. The Telegram agents' own units are the Agents tab.",
      actions: `<span class="pill ${services.every((s) => s.active === "active") ? "ok" : "warn"}">${
        services.filter((s) => s.active === "active").length
      } of ${services.length} active</span>`,
    }
  );

/* -------------------------------------------------------- agent services -- */

exports.agents = ({ csrf, user, agents, flash, err, counts }) =>
  shell(
    "Services",
    `${flashes({ msg: flash, err })}
    ${tabs("agents", user, counts)}
    ${
      agents.length
        ? card(
            "Agent processes",
            `<table class="rows">
              <thead><tr><th>Agent</th><th>State</th><th>At boot</th><th>Channel</th><th>Since</th><th></th></tr></thead>
              <tbody>${agents
                .map(
                  (a) => `<tr>
                  <td>
                    <a class="strong" href="/agents/${esc(a.slug)}">${esc(a.name || a.slug)}</a>
                    <div class="muted small mono">joya-agent@${esc(a.slug)}</div>
                  </td>
                  <td>${agentPill(a.state && a.state.active)}</td>
                  <td class="small">${esc((a.state && a.state.enabled) || "—")}</td>
                  <td class="small">${
                    a.channel
                      ? `<a href="/channels/${esc(a.channel.slug)}">${esc(a.channel.name)}</a>`
                      : `<span class="muted">none</span>`
                  }</td>
                  <td class="mono small">${esc(((a.state && a.state.since) || "").slice(0, 19) || "—")}</td>
                  <td class="right">
                    ${controls(csrf, "/services/agent-action", a.slug, (a.state || {}))}
                    <div class="stack-actions"><a class="btn small" href="/agents/${esc(
                      a.slug
                    )}/logs">Logs</a></div>
                  </td>
                </tr>`
                )
                .join("")}</tbody></table>`,
            { icon: "agents" }
          )
        : card(
            "",
            empty(
              "agents",
              "No agents yet",
              'Create one from <a href="/agents">Telegram agents</a>.'
            )
          )
    }`,
    {
      user,
      csrf,
      active: "services",
      pattern: "b",
      heading: "Services",
      subtitle:
        "One systemd unit per Telegram agent. Restarting an agent does not lose its memory or its conversation — both are on disk.",
    }
  );

/* ------------------------------------------------------------------ logs -- */

exports.logs = ({ csrf, user, unit, lines, err }) =>
  shell(
    "Logs — " + unit,
    `${flashes({ err })}
    <section class="card fill-card grow">
      <div class="card-head"><h2>${icon("logs")}Last ${esc(lines.length)} lines · ${esc(unit)}</h2>
        <a class="btn small" href="/services/logs?unit=${encodeURIComponent(unit)}">${icon("restart")} Refresh</a></div>
      ${
        lines.length
          ? `<div class="panel-body logbox" data-scroll-end><pre class="logs">${esc(lines.join("\n"))}</pre></div>`
          : `<p class="muted">Nothing logged.</p>`
      }
    </section>
    <p class="muted small">Secrets are stripped from this view before it reaches the
      browser. Live tail from a shell: <code>journalctl -u ${esc(unit)} -f</code></p>`,
    {
      user,
      csrf,
      active: "services",
      pattern: "b",
      fill: true,
      crumbs: [["OS Dashboard", "/os"], ["Platform", null], ["Services", "/services"], [unit, null]],
      heading: unit,
      subtitle: "Journal output for this unit.",
      actions: `<a class="btn" href="/services">${icon("chevron")} All services</a>`,
    }
  );
