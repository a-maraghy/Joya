"use strict";
/**
 * Credential management.
 *
 * The panel shows whether a credential is set, and lets it be replaced. It
 * deliberately never displays one: a token rendered into a page is a token in a
 * screenshot, a proxy log, and a browser scrollback. What you get instead is
 * enough to answer "is this configured, and is it the one I think it is" — a
 * length and the first and last few characters.
 */

const { esc, shell, card, flashes, icon, stamp, docLayout, tocCard } = require("./ui");

/**
 * The master list beside every credential page: each credential this panel
 * manages, with a dot for whether it is set. (The OpenAI voice key lives in
 * JOYA AI ▸ Settings ▸ Voice since 2026-09-30; the index keeps a status line
 * that links there.)
 */
function credNav(user, credentials, active) {
  const items = (credentials || []).map(
    (c) => `<a href="/credentials/${esc(c.name)}"${active === c.name ? ' class="on" aria-current="page"' : ""}>
      <span class="cred-ic">${icon("credentials", 16)}</span><span><b>${esc(c.label || c.name)}</b><small>${esc(
        String(c.path || c.name).split("/").pop()
      )}</small></span><span class="dot${c.configured ? "" : " off"}"></span></a>`
  );
  return `<section class="card hud cred-list" aria-label="Credentials">
    <div class="card-head"><h2>${icon("credentials")}Credentials</h2>${
      active ? `<a class="small" href="/credentials">All</a>` : ""
    }</div>${items.join("")}</section>`;
}

/**
 * The OpenAI voice key, as one status line on the index: set or not, voice on
 * or off, and the way to Settings ▸ Voice, where it is managed. The key itself
 * is never shown -- not even its last characters.
 */
function voiceSummary(v) {
  if (!v) return "";
  const state = v.error
    ? `<span class="pill warn">unknown</span> <span class="muted small">could not read the voice settings: ${esc(v.error)}</span>`
    : `${v.configured ? `<span class="pill ok">token set</span>` : `<span class="pill bad">no token</span>`} ${
        v.on ? `<span class="pill ok">voice on</span>` : `<span class="pill neutral">voice off</span>`
      }`;
  return `<div class="alert info cred-voice" id="openai-voice">${icon("voice")}<div><b>OpenAI voice</b> ${state}
    <span class="small">Managed in <a href="/joya-ai/settings/voice#v-token">JOYA AI ▸ Settings ▸ Voice</a>.</span></div></div>`;
}

exports.index = ({ csrf, user, credentials, probe, flash, err, voice }) =>
  shell(
    "Credentials",
    `${flashes({ msg: flash, err })}
    ${
      probe && !probe.claude_credential
        ? `<div class="alert warn">${icon("alert")}<div>No Claude credential is set.
           Agents will start, receive messages, and then fail to answer — the logs say
           <em>authentication</em> when this is the cause.</div></div>`
        : ""
    }
    ${
      probe && (probe.credential_stale_agents || []).length
        ? `<div class="alert warn">${icon("alert")}<div>
           ${probe.credential_stale_agents.map(esc).join(", ")} started before the
           credential was last changed, so
           ${probe.credential_stale_agents.length === 1 ? "it is" : "they are"} still
           using the old one. Saving a credential here restarts agents automatically;
           this one predates that. Restart from
           <a href="/services/agents">Agent services</a>.</div></div>`
        : ""
    }

    ${docLayout(`${voiceSummary(voice)}

    ${credentials
      .map((c) =>
        card(
          c.label,
          `<table class="kv">
            <tr><td>Status</td><td>${
              c.configured
                ? `<span class="pill ok">configured</span>`
                : `<span class="pill bad">not set</span>`
            }</td></tr>
            <tr><td>File</td><td class="mono small">${esc(c.path)}</td></tr>
            <tr><td>Accepted keys</td><td class="mono small">${c.keys.map(esc).join("<br>")}</td></tr>
          </table>
          <div class="btn-row">
            <a class="btn primary small" href="/credentials/${esc(c.name)}">
              ${icon("edit")} ${c.configured ? "Replace" : "Set"}</a>
          </div>`,
          { icon: "credentials", className: "hud" }
        )
      )
      .join("")}`, credNav(user, credentials, null))}`,
    {
      user,
      csrf,
      active: "credentials",
      pattern: "c",
      heading: "Credentials",
      subtitle:
        "Secrets the agents need. Stored on disk readable only by the agent account, never displayed back.",
    }
  );

exports.detail = ({ csrf, user, credential, credentials, flash, err }) => {
  const c = credential;
  const present = c.present || {};
  const toc = [["c-state", "Current state"], ["c-file", "File contents"], ["c-set", "Set a value"]];
  if (c.name === "claude") toc.push(["c-where", "Where to get this"]);
  if (Object.keys(present).length) toc.push(["c-remove", "Remove"]);

  return shell(
    c.label,
    `${docLayout(`${flashes({ msg: flash, err })}

    ${card(
      "Current state",
      `<table class="kv">
        <tr><td>File</td><td class="mono small">${esc(c.path)}</td></tr>
        <tr><td>Exists</td><td>${c.exists ? "yes" : "no"}</td></tr>
        <tr><td>Permissions</td><td class="mono small">${esc(c.mode || "—")}</td></tr>
        <tr><td>Last changed</td><td class="mono small">${esc(stamp(c.modified))}</td></tr>
        ${c.keys
          .map(
            (k) =>
              `<tr><td>${esc(k)}</td><td>${
                present[k]
                  ? `<span class="pill ok">set</span>
                     <span class="mono small muted"> ${esc(present[k].preview)} · ${
                      present[k].length
                    } chars</span>`
                  : `<span class="pill neutral">empty</span>`
              }</td></tr>`
          )
          .join("")}
      </table>`,
      { icon: "info", id: "c-state", className: "hud" }
    )}

    ${card(
      "File contents",
      `<p class="muted small">Secret values are masked. Comments and other lines are shown as they are.</p>
       <pre>${esc(c.masked || "(file does not exist yet)")}</pre>`,
      { icon: "file", id: "c-file" }
    )}

    ${card(
      "Set a value",
      `<form method="post" action="/credentials/${esc(c.name)}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Key
          <select name="key">
            ${c.keys
              .map((k) => `<option value="${esc(k)}">${esc(k)}</option>`)
              .join("")}
          </select></label>
        <label>Value <span class="hint">written straight to the file and never shown again</span>
          <input name="value" type="password" placeholder="sk-ant-..." required></label>
        <button class="btn primary" type="submit">${icon("save")} Save credential</button>
      </form>
      <p class="muted small mt-12">Setting one key clears the other —
        the runtime uses whichever it finds, and having both set makes it ambiguous which
        one is actually in use.</p>`,
      { icon: "credentials", id: "c-set", className: "hud" }
    )}

    ${
      c.name === "claude"
        ? card(
            "Where to get this",
            `<p>A subscription token is the usual choice — it bills against your Claude plan
              rather than per token.</p>
            <ol class="steps">
              <li>On a machine with a browser, run <code>claude setup-token</code></li>
              <li>Log in and approve when the browser opens</li>
              <li>Copy the <code>sk-ant-oat01-…</code> value it prints and paste it above,
                  with the key set to <code>CLAUDE_CODE_OAUTH_TOKEN</code></li>
            </ol>
            <p class="muted small">Prefer pay-as-you-go API billing instead? Use
              <code>ANTHROPIC_API_KEY</code> with a key from the Anthropic console.</p>
            <div class="alert info">${icon("info")}<div>Changing this affects every agent —
              they all authenticate with the same credential. Running agents pick it up on
              their next restart.</div></div>`,
            { icon: "guide", id: "c-where" }
          )
        : ""
    }

    ${
      Object.keys(present).length
        ? card(
            "Remove",
            `<p class="muted small">Clearing the credential stops every agent from being
              able to answer. They keep running and keep receiving messages.</p>
            ${c.keys
              .filter((k) => present[k])
              .map(
                (k) => `<form method="post" action="/credentials/${esc(c.name)}/clear" class="inline"
                       data-confirm="Clear ${esc(k)}? Every agent stops being able to answer.">
                  <input type="hidden" name="_csrf" value="${esc(csrf)}">
                  <input type="hidden" name="key" value="${esc(k)}">
                  <button class="btn danger small" type="submit">${icon("trash")} Clear ${esc(k)}</button>
                </form>`
              )
              .join(" ")}`,
            { icon: "trash", className: "danger-zone", id: "c-remove" }
          )
        : ""
    }`, credNav(user, credentials || [c], c.name) + tocCard(toc))}`,
    {
      user,
      csrf,
      active: "credentials",
      pattern: "c",
      crumbs: [["OS Dashboard", "/os"], ["Security", null], ["Credentials", "/credentials"], [c.label, null]],
      heading: c.label,
      subtitle: "Shared by every agent on this machine.",
      actions: `<a class="btn" href="/credentials">${icon("chevron")} All credentials</a>`,
    }
  );
};
