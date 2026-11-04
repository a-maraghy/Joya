"use strict";
/**
 * The add-on catalogue: a searchable list of capabilities you can switch on for
 * an agent or a channel, and the checkbox grid embedded in their edit forms.
 *
 * `availability` is passed in from the system probe so the catalogue can say
 * "voice notes needs ffmpeg, which is not installed" instead of offering a
 * switch that silently does nothing.
 */

const { esc, shell, card, flashes, empty, icon } = require("./ui");
const { ADDONS, byScope, search, categories } = require("./catalog");

/** Which requirements of an add-on are missing, given a probe result. */
function missingFor(addon, probe) {
  if (!addon.requires || !probe) return [];
  const files = probe.files || {};
  const binaries = probe.binaries || {};
  const known = {
    "whisper.cpp binary": files.whisper_binary,
    "whisper model": files.whisper_model,
    ffmpeg: binaries.ffmpeg,
  };
  return addon.requires
    .filter((r) => known[r.label] === false)
    .map((r) => r.label);
}

/**
 * The checkbox grid used inside agent and channel forms.
 * Locked add-ons render as always-on with a hidden input, because unchecking
 * them would produce an agent that cannot remember anything.
 */
function renderAddons(list, enabledIds, probe) {
  const enabled = new Set(enabledIds || []);
  if (!list.length) return `<p class="muted">Nothing available.</p>`;

  return `<div class="addon-grid">${list
    .map((a) => {
      const missing = missingFor(a, probe);
      const unavailable = missing.length > 0;
      const on = a.locked || enabled.has(a.id);
      return `<label class="addon${on ? " on" : ""}${unavailable ? " unavailable" : ""} ${a.locked ? "static-cursor" : "clickable"}">
        <span class="addon-top">
          ${
            a.locked
              ? `<input type="hidden" name="addons" value="${esc(a.id)}">
                 <span title="Always on">${icon("check")}</span>`
              : `<input type="checkbox" name="addons" value="${esc(a.id)}"
                        ${on ? "checked" : ""} ${unavailable ? "disabled" : ""}
                        class="pick">`
          }
          <span class="addon-ico">${icon(a.icon)}</span>
          <span>
            <span class="addon-name">${esc(a.name)}</span>
            <span class="addon-cat">${esc(a.category)}${a.locked ? " · always on" : ""}</span>
          </span>
        </span>
        <p class="addon-desc">${esc(a.summary)}</p>
        ${
          unavailable
            ? `<p class="addon-desc warn-text">Needs ${esc(
                missing.join(", ")
              )}, which is not installed on this server.</p>`
            : ""
        }
      </label>`;
    })
    .join("")}</div>`;
}

/* -------------------------------------------------------------- catalogue - */

exports.catalogue = ({ csrf, user, query, scope, results, probe, agents, channels }) => {
  const scopeLabel = { agent: "Agent", channel: "Channel" };

  const groups = [];
  for (const s of ["channel", "agent"]) {
    if (scope && scope !== s) continue;
    const inScope = results.filter((a) => a.scope === s);
    if (!inScope.length) continue;
    groups.push({ scope: s, items: inScope });
  }

  // Which agents/channels already use each add-on, so the page answers "who has
  // this on" rather than just "this exists".
  const usage = new Map();
  for (const a of agents) for (const id of a.addons || []) push(usage, id, { kind: "agent", ...a });
  for (const c of channels) for (const id of c.addons || []) push(usage, id, { kind: "channel", ...c });

  return shell(
    "Add-ons",
    `<form method="get" action="/addons" class="searchbar">
      <input name="q" value="${esc(query || "")}" placeholder="Search — try 'excel', 'voice', 'schedule'…">
      <select name="scope" class="pick">
        <option value="">Everything</option>
        <option value="channel" ${scope === "channel" ? "selected" : ""}>Channel add-ons</option>
        <option value="agent" ${scope === "agent" ? "selected" : ""}>Agent add-ons</option>
      </select>
      <button class="btn primary" type="submit">${icon("search")} Search</button>
    </form>

    ${
      groups.length
        ? groups
            .map((g) =>
              card(
                scopeLabel[g.scope] + " add-ons",
                `<p class="muted small">${
                  g.scope === "channel"
                    ? "What a channel can receive, and how conversations feel. Set per channel."
                    : "What the agent itself can do once it has the message. Set per agent."
                }</p>
                <div class="addon-grid">${g.items
                  .map((a) => renderCatalogueCard(a, probe, usage.get(a.id) || []))
                  .join("")}</div>`,
                { icon: g.scope === "channel" ? "channels" : "agents" }
              )
            )
            .join("")
        : card(
            "",
            empty(
              "search",
              "Nothing matched",
              "Try a broader word — the catalogue is searched by name, description and keywords."
            )
          )
    }

    ${card(
      "How add-ons work",
      `<p>An add-on is a capability with a switch, not a plugin you install. Turning one on
        writes configuration the agent runtime already understands and restarts the
        affected process; turning it off writes the opposite. Nothing is downloaded and
        nothing can half-install.</p>
      <ul>
        <li><strong>Channel add-ons</strong> decide what arrives — voice notes, files,
          images — and how replies feel. Change them on a channel.</li>
        <li><strong>Agent add-ons</strong> decide what the agent can do with what
          arrived. Change them on an agent.</li>
      </ul>
      <p class="muted small">Add-ons whose prerequisites are missing are shown greyed out
        rather than hidden, so it is clear the capability exists and what it needs.</p>`,
      { icon: "info" }
    )}`,
    {
      user,
      csrf,
      active: "addons",
      pattern: "c",
      heading: "Add-ons",
      subtitle: "Capabilities you can give an agent or a channel.",
    }
  );
};

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function renderCatalogueCard(a, probe, users) {
  const missing = missingFor(a, probe);
  const unavailable = missing.length > 0;
  return `<div class="addon${users.length ? " on" : ""}${unavailable ? " unavailable" : ""}">
    <div class="addon-top">
      <span class="addon-ico">${icon(a.icon)}</span>
      <span>
        <span class="addon-name">${esc(a.name)}</span>
        <span class="addon-cat">${esc(a.category)}${a.locked ? " · always on" : ""}</span>
      </span>
    </div>
    <p class="addon-desc">${esc(a.summary)}</p>
    <p class="addon-desc muted">${esc(a.detail)}</p>
    ${
      unavailable
        ? `<p class="addon-desc warn-text">Needs ${esc(missing.join(", "))}.</p>`
        : ""
    }
    <div class="addon-foot">
      ${
        users.length
          ? `<span class="muted small">Used by ${users
              .map(
                (u) =>
                  `<a href="/${u.kind === "agent" ? "agents" : "channels"}/${esc(u.slug)}">${esc(
                    u.name || u.slug
                  )}</a>`
              )
              .join(", ")}</span>`
          : `<span class="muted small">Not in use</span>`
      }
    </div>
  </div>`;
}

exports.renderAddons = renderAddons;
exports.missingFor = missingFor;
