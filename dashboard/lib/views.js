"use strict";
/** Authentication screens, the OS dashboard, and the system pages. */

const {
  esc,
  bytes,
  duration,
  ago,
  stamp,
  shell,
  statusPill,
  agentPill,
  meter,
  stat,
  card,
  flashes,
  empty,
  icon,
  enrolSteps,
  can,
} = require("./ui");

exports.error = (title, msg) =>
  shell(
    title,
    `<div class="card">
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(msg)}</p>
      <p><a class="btn" href="/">${icon("chevron")} Back to the dashboard</a></p>
    </div>`
  );

/* ----------------------------------------------------------------- auth --- */

/**
 * Step one. Unchanged unless this address takes passkeys: then
 * public/passkey.js may switch the form to "password now, Windows Hello next"
 * (it does so by itself on a browser that has signed in with one here before),
 * which hides the code field and sends second=passkey. Without JavaScript the
 * form is the old one exactly: username, password, code.
 */
/**
 * The JOYA AI desktop app shows the same sign-in pages in its transparent
 * window (lib/desktop.js): `desktop` makes the card float there
 * (public/joya-desktop.css / .js) and offers the browser hand-off, for when
 * Windows Hello cannot show inside the app. `days`: how long the app stays
 * signed in.
 */
const DESK_ASSETS = ["joya-desktop.css", "joya-core-d.js", "joya-desktop-layout.js", "joya-desktop.js"];
function deskOpts(desktop, assets) {
  // joya-desktop-webauthn.js first: it must wrap navigator.credentials before passkey.js starts Windows Hello.
  return desktop ? { pageClass: "cc-desk dk-auth", assets: ["joya-desktop-webauthn.js"].concat(assets, DESK_ASSETS) } : { assets };
}
function deskHandOff(desktop) {
  return desktop
    ? `<div class="dk-browser"><div class="dk-or"><span>or</span></div><button type="button" class="btn w-full dk-browser-btn" id="dk-browser-signin">${icon("external", 16)} <span>Sign in in your browser</span></button><span class="dk-browser-note muted" id="dk-browser-note" role="status">Easiest with Windows Hello: your browser shows it, and the app is signed in when you are.</span></div>`
    : "";
}

exports.login = ({ csrf, error, passkeys, desktop, days, passwordOnly }) =>
  shell(
    "Sign in",
    `<div class="card">
      <h2 class="mb-14">Sign in</h2>
      ${error ? `<div class="alert bad">${icon("alert")}<div>${esc(error)}</div></div>` : ""}
      <form method="post" action="/login" autocomplete="off"${passkeys ? ` id="login-form" data-passkeys="1"` : ""}>
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        ${passkeys ? `<input type="hidden" name="second" value="">` : ""}
        <label>Username<input name="username" autocomplete="username" required autofocus></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        ${
          passwordOnly
            ? ""
            : `<label class="lg-code">Authenticator code
          <input name="token" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
                 autocomplete="one-time-code" required></label>`
        }
        ${
          passkeys
            ? `<p class="lg-pk-note muted small" hidden>${icon("fingerprint", 14)} Windows Hello confirms it is you on the next step.</p>`
            : ""
        }
        <button class="btn primary w-full" type="submit">Sign in</button>
        ${
          passkeys
            ? `<p class="lg-switch" hidden>
                 <button type="button" class="linkish" data-pk-mode="passkey">Sign in with a passkey (Windows Hello) instead</button>
                 <button type="button" class="linkish" data-pk-mode="code" hidden>Use authenticator code instead</button>
               </p>`
            : ""
        }
      </form>
      ${deskHandOff(desktop)}
      <p class="auth-foot">${icon("lock", 14)}<span>${
        passwordOnly
          ? desktop
            ? `The app stays signed in for ${esc(String(days || 14))} days`
            : "Sessions end after 8 h idle"
          : desktop
            ? `Two-factor required · the app stays signed in for ${esc(String(days || 14))} days`
            : "Two-factor required · sessions end after 8 h idle"
      }</span></p>
    </div>`,
    deskOpts(desktop, passkeys ? ["simplewebauthn-browser.js", "passkey.js"] : [])
  );

/**
 * Step two, after "password now, passkey next". The same page whatever the
 * password was (see POST /login): Windows Hello starts by itself, and the
 * authenticator code is one click away.
 */
exports.loginVerify = ({ csrf, username, passkeys, primary, error, desktop }) =>
  shell(
    "Confirm it is you",
    `<div class="card">
      <h2 class="mb-14">Confirm it is you</h2>
      <p class="muted small lg-who">Signing in as <strong class="mono">${esc(username)}</strong></p>
      ${error ? `<div class="alert bad">${icon("alert")}<div>${esc(error)}</div></div>` : ""}
      <div class="alert bad lg-err" role="alert" hidden>${icon("alert")}<div></div></div>
      ${
        passkeys
          ? `<div class="lg-pk" id="lg-pk" data-csrf="${esc(csrf)}">
              <button class="btn primary w-full" type="button" id="lg-pk-go">${icon("fingerprint")} <span>Use Windows Hello</span></button>
              <p class="muted small lg-pk-status" role="status" aria-live="polite">Face, fingerprint or PIN on this device.</p>
            </div>
            <p class="lg-switch"><button type="button" class="linkish" id="lg-code-show">Use authenticator code instead</button></p>`
          : `<div class="alert info">${icon("info")}<div>Passkeys do not work at this address${
              primary ? ` — they work at <span class="mono">${esc(primary.replace(/^https:\/\//, ""))}</span>` : ""
            }. Use your authenticator code.</div></div>`
      }
      <form method="post" action="/login/code" autocomplete="off" class="lg-code-form"${passkeys ? " hidden" : ""}>
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Authenticator code
          <input name="token" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000"
                 autocomplete="one-time-code" required${passkeys ? "" : " autofocus"}></label>
        <button class="btn primary w-full" type="submit">Sign in</button>
      </form>
      ${deskHandOff(desktop)}
      <p class="auth-foot">${icon("lock", 14)}<span><a href="/login">Start again</a> · the authenticator code always works</span></p>
    </div>`,
    deskOpts(desktop, passkeys ? ["simplewebauthn-browser.js", "passkey.js"] : [])
  );

exports.setup = ({ csrf, token, form = {}, errors = [], passwordOnly }) =>
  shell(
    "First-run setup",
    `<div class="card">
      <h2>Create the admin account</h2>
      <p class="muted small">This runs once. Afterwards <code>/setup</code> stops working.</p>
      ${errors.length ? `<div class="alert bad">${icon("alert")}<div>${errors.map(esc).join("<br>")}</div></div>` : ""}
      <form method="post" action="/setup" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="token" value="${esc(token)}">
        <label>Username<input name="username" value="${esc(form.username || "")}" required autofocus></label>
        <label>Email${passwordOnly ? "" : `
          <span class="hint">what your authenticator app shows beside the code</span>`}
          <input name="email" type="email" value="${esc(form.email || "")}" required></label>
        <label>Password <span class="hint">minimum 12 characters</span>
          <input name="password" type="password" required></label>
        <label>Repeat password<input name="password2" type="password" required></label>
        <button class="btn primary" type="submit" class="w-full">Create account</button>
      </form>
    </div>`
  );


exports.totpEnroll = ({ csrf, qr, secret, account, error }) =>
  shell(
    "Set up two-factor",
    `<div class="card">
      <h2>Set up two-factor authentication</h2>
      ${enrolSteps(account)}
      ${error ? `<div class="alert bad">${icon("alert")}<div>${esc(error)}</div></div>` : ""}
      <p class="center"><img src="${esc(qr)}" alt="TOTP QR code" width="240" height="240"></p>
      <p class="muted small">Can't scan? Enter this secret manually:</p>
      <p><code class="secret">${esc(secret)}</code></p>
      <div class="alert warn">${icon("alert")}<div>Save this secret somewhere safe. If you
        lose your authenticator and have no copy, you will need SSH access to reset it.</div></div>
      <form method="post" action="/setup/confirm" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Enter the current 6-digit code to confirm
          <input name="token" inputmode="numeric" pattern="[0-9 ]*" placeholder="000000" required autofocus></label>
        <button class="btn primary" type="submit" class="w-full">Confirm and finish</button>
      </form>
    </div>`
  );

exports.setupDone = ({ passwordOnly } = {}) =>
  shell(
    "Setup complete",
    `<div class="card">
      <h2>Setup complete</h2>
      <p>${passwordOnly ? "Your admin account is ready. Sign in with your username and password." : "Two-factor authentication is active. You can now sign in."}</p>
      <p><a class="btn primary" href="/login">Go to sign in</a></p>
    </div>`
  );

/* -------------------------------------------------------- OS dashboard --- */

/** A vitals ring: a HUD dial with ticks, filled to `pct`. */
function ring(key, label, pct, sub) {
  const c = 2 * Math.PI * 24;
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  let ticks = "";
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ticks += `<line class="tick" x1="${(30 + 29 * Math.cos(a)).toFixed(1)}" y1="${(30 + 29 * Math.sin(a)).toFixed(1)}" x2="${(30 + 27 * Math.cos(a)).toFixed(1)}" y2="${(30 + 27 * Math.sin(a)).toFixed(1)}"/>`;
  }
  return `<div class="ring-cell" data-ring="${esc(key)}">
    <div class="ring"><svg viewBox="0 0 60 60" aria-hidden="true">${ticks}
      <circle class="trk" cx="30" cy="30" r="24" fill="none" stroke-width="4.5"/>
      <circle class="val${p > 90 ? " bad" : p > 75 ? " hot" : ""}" cx="30" cy="30" r="24" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="${((c * p) / 100).toFixed(1)} ${c.toFixed(1)}"/>
    </svg><b>${p}%</b></div>
    <span class="ring-l">${esc(label)}</span><small>${esc(sub)}</small>
  </div>`;
}

const gib = (n) => (n == null ? "—" : (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1));

/**
 * The OS dashboard: the machine, not the fleet -- "Machine health".
 *
 * A document (pattern C, 2026-10-25: at the 16 px type of the redesign one
 * fixed screen cut the cards off, so the page scrolls). The centre is the host drawn as a mycelium: every
 * tracked unit a knot on the web, every thread a real dependency (thicker for
 * more real traffic in the last 24 h), and pulses running along the threads
 * as real events happen (public/mycelium.js, fed by /api/os/pulse). A unit
 * that stops withers and takes its threads dark. Around it,
 * the machine's vitals, what it is capable of, who can reach it, and what
 * happened lately. It still opens with what is wrong rather than what is fine:
 * a green wall of statistics is the least useful thing an operations page can
 * show you.
 */
exports.osDashboard = ({
  csrf,
  user,
  stats,
  status,
  statusError,
  services,
  agents,
  channels,
  graph,
  totals,
  probe,
  logins,
  users,
  roles,
  devices,
  audit,
}) => {
  const svcDown = services.filter((s) => s.active !== "active");
  const running = agents.filter((a) => a.state && a.state.active === "active").length;
  const jails = (status && status.jails) || {};
  const sshd = jails.sshd || { banned: 0, total_failed: 0 };
  const panelJail = jails["joya-dashboard"] || { banned: 0, total_failed: 0 };
  const files = (probe && probe.files) || {};
  const binaries = (probe && probe.binaries) || {};

  const failedLogins = logins.filter((l) => l.outcome === "fail" || l.outcome === "failed").length;
  const pendingEnrol = users ? users.filter((u) => !u.totp_confirmed && !u.disabled).length : 0;
  const disabledUsers = users ? users.filter((u) => u.disabled).length : 0;

  const warnings = [];
  if (probe && !probe.claude_credential) {
    warnings.push(
      `No Claude credential is set, so agents can receive messages but cannot answer.
       <a href="/credentials">Add one</a>.`
    );
  }
  if (probe && (probe.credential_stale_agents || []).length) {
    warnings.push(
      `${probe.credential_stale_agents.map(esc).join(", ")} started before the credential was
       last changed and ${probe.credential_stale_agents.length === 1 ? "is" : "are"} still using
       the old one. <a href="/services/agents">Restart</a>.`
    );
  }
  if (svcDown.length) {
    warnings.push(
      `${svcDown.length} service${svcDown.length === 1 ? " is" : "s are"} not running:
       ${svcDown.map((s) => "<strong>" + esc(s.unit) + "</strong>").join(", ")}.
       <a href="/services">Check services</a>.`
    );
  }
  if (pendingEnrol) {
    warnings.push(
      `${pendingEnrol} account${pendingEnrol === 1 ? " has" : "s have"} not finished
       two-factor enrolment and cannot sign in yet. <a href="/users">Users</a>.`
    );
  }

  const capabilities = [
    ["Claude credential", probe && probe.claude_credential, "Every agent authenticates with this."],
    [
      "Voice transcription",
      files.whisper_binary && files.whisper_model && binaries.ffmpeg,
      "whisper.cpp, its model, and ffmpeg — all three are needed.",
    ],
    ["Vector memory model", files.embedding_model, "Local ONNX embeddings for agent memory."],
    ["Agent runtime", files.runtime_venv, "The Python environment the Telegram agents run in."],
    ["Vault template", files.vault_template, "Skeleton copied into each new agent's memory vault."],
    ["Obsidian", binaries.obsidian, "Desktop editor for the memory vaults."],
    ["Claude CLI", binaries.claude, "Used for credential checks and one-shot prompts."],
    ["Node", binaries.node, "Runs this panel and the WhatsApp bridge."],
    ["git", binaries.git, "Pulls runtime updates."],
  ];
  const missing = capabilities.filter(([, ok]) => !ok).length;

  const cpuPct = Math.min(100, (stats.loadavg[0] / Math.max(1, stats.cpus)) * 100);
  const ramPct = stats.memTotal ? (stats.memUsed / stats.memTotal) * 100 : 0;
  const diskPct = stats.diskTotal ? (stats.diskUsed / stats.diskTotal) * 100 : 0;
  const upCount = services.length - svcDown.length;
  // The web's nodes, edges and 24 h counts. The page draws it; without
  // JavaScript the verdict line and the counts below still say it all.
  const web = graph || { nodes: [], edges: [] };
  const mycData = {
    nodes: web.nodes,
    edges: web.edges,
    totals: totals || null,
    audit: can(user, "audit.view"),
  };
  const downNames = svcDown.map((s) => (web.nodes.find((n) => n.id === s.unit) || {}).name || s.unit);

  const loginRows = logins.slice(0, 20).map(
    (l) => `<tr>
      <td class="mono nowrap">${esc(stamp(l.ts).slice(5, 16))}</td>
      <td>${esc(l.username || "—")} <span class="mono small muted">${esc(l.ip || "")}</span></td>
      <td><span class="pill ${l.outcome === "success" ? "ok" : l.outcome === "admin" ? "neutral" : "bad"}">${esc(l.outcome)}</span>${
        l.detail ? ` <span class="muted small">${esc(l.detail)}</span>` : ""
      }</td>
    </tr>`
  );

  return shell(
    "OS Dashboard",
    `${
      warnings.length
        ? `<div class="alert warn">${icon("alert")}<div>${warnings.join(" &nbsp;·&nbsp; ")}</div></div>`
        : ""
    }
    ${statusError ? `<div class="alert bad">${icon("alert")}<div>Could not query privileged status: ${esc(statusError)}</div></div>` : ""}

    <div class="ov-grid">
      <div class="col">
        <section class="card hud" data-vitals>
          <div class="card-head"><h2>${icon("cpu")}Machine</h2><span class="card-aside mono">${esc(stats.cpus)} vCPU</span></div>
          <div class="rings">
            ${ring("cpu", "CPU", cpuPct, stats.cpus + " vCPU")}
            ${ring("ram", "RAM", ramPct, gib(stats.memUsed) + " / " + gib(stats.memTotal) + " GB")}
            ${stats.diskTotal != null ? ring("disk", "Disk", diskPct, gib(stats.diskUsed) + " / " + gib(stats.diskTotal) + " GB") : ""}
          </div>
          <div class="vit-foot"><span>Load <span class="mono" data-load>${stats.loadavg
            .map((n) => n.toFixed(2))
            .join(" · ")}</span></span><span>live</span></div>
          <table class="kv">
            <tr><td>Host</td><td class="mono">${esc(stats.hostname)}</td></tr>
            <tr><td>OS</td><td class="small">${esc(stats.platform)} · ${esc(stats.arch)}</td></tr>
            <tr><td>Uptime</td><td>${esc(duration(stats.uptimeSec))}</td></tr>
            <tr><td>CPU</td><td>${stats.cpus} vCPU${
              stats.cpuModel ? ` <span class="muted small">${esc(stats.cpuModel)}</span>` : ""
            }</td></tr>
          </table>
          <div class="sr">${meter("memory", "Memory", stats.memUsed, stats.memTotal)}${
            stats.diskTotal != null ? meter("disk", "Disk /", stats.diskUsed, stats.diskTotal) : ""
          }</div>
        </section>
        <section class="card grow scroll-y">
          <div class="card-head"><h2>${icon("activity")}Platform</h2></div>
          <table class="kv">
            <tr><td>Runtime revision</td><td class="mono small">${esc((probe && probe.runtime_revision) || "—")}</td></tr>
            <tr><td>Node</td><td class="mono small">${esc(stats.node)}</td></tr>
            <tr><td>Panel uptime</td><td>${esc(duration(stats.panelUptimeSec))}
              <span class="muted small">${esc(bytes(stats.panelRssBytes))} resident</span></td></tr>
            <tr><td>Agents</td><td>${running} running of ${agents.length}
              ${agents.length ? `<a class="small" href="/agents/dashboard">agents dashboard</a>` : ""}</td></tr>
            <tr><td>Channels</td><td>${channels.length} configured</td></tr>
          </table>
        </section>
      </div>

      <section class="core-hero myc-hero" id="mc-hero" aria-label="Machine health: what runs on the host and what depends on what" data-myc="${esc(JSON.stringify(mycData))}">
        <canvas aria-hidden="true"></canvas>
        <div class="hero-title"><h2>Mycelium</h2><p data-mc-sub>${
          svcDown.length
            ? `<span class="v-bad">${downNames.map(esc).join(", ")} ${svcDown.length === 1 ? "is" : "are"} not running</span>`
            : "<b>All up</b> · nothing affected · threads = what needs what"
        }</p></div>
        <span class="pill ${svcDown.length ? "bad" : "ok"} hero-pill" data-mc-pill>${upCount} of ${services.length} services up</span>
        <div class="mc-ticker" data-mc-ticker aria-live="off"><div class="th">Live events</div><ol></ol></div>
        <div class="node-labels" data-mc-labels></div>
        <div class="hero-legend" data-mc-legend><span><i class="dot"></i>active</span><span><i class="dot bad"></i>failed</span><span><i class="ring"></i>affected</span><span>pulses = live events · threads = 24 h traffic</span></div>
        <div class="hero-stats">
          <a href="/services"><b data-mc-count>${upCount} / ${services.length}</b><span>services</span></a>
          <a href="/guide"><b>${capabilities.length - missing} / ${capabilities.length}</b><span>capabilities</span></a>
          ${users ? `<a href="/users"><b>${users.length}</b><span>users</span></a>` : ""}
          <div><b>${sshd.banned + panelJail.banned}</b><span>IPs banned</span></div>
        </div>
        <div class="mc-tip" data-mc-tip role="tooltip" hidden></div>
      </section>

      <div class="col">
        <section class="card hud">
          <div class="card-head"><h2>${icon("shield")}Security</h2>
            <div class="btn-row">${
              can(user, "firewall.view") ? `<a class="btn small" href="/firewall">${icon("ban")} Firewall</a>` : ""
            }<a class="btn small" href="/audit">Audit</a></div></div>
          <div class="sec-grid">
            <div class="sec-cell"><b data-stat="banned">${sshd.banned}</b><span>IPs banned (SSH)</span></div>
            <div class="sec-cell"><b>${panelJail.banned}</b><span>panel bans</span></div>
            <div class="sec-cell"><b data-stat="failed">${sshd.total_failed}</b><span>failed SSH auths</span></div>
            <div class="sec-cell${failedLogins ? " warn" : ""}"><b>${failedLogins} / ${logins.length}</b><span>failed panel sign‑ins</span></div>
          </div>
          <div class="muted small">fail2ban jails <span class="mono">sshd</span>, <span class="mono">joya-dashboard</span></div>
        </section>
        <section class="card grow scroll-y">
          <div class="card-head"><h2>${icon("users")}Access</h2>${users ? `<a class="btn small" href="/users">Manage</a>` : ""}</div>
          ${
            users
              ? `<table class="kv">
                  <tr><td>Users</td><td>${users.length}
                    ${disabledUsers ? `<span class="muted small">${disabledUsers} disabled</span>` : ""}</td></tr>
                  <tr><td>Awaiting enrolment</td><td>${
                    pendingEnrol ? `<span class="pill warn">${pendingEnrol}</span>` : "0"
                  }</td></tr>
                  <tr><td>Roles</td><td>${roles ? roles.length : "—"}</td></tr>
                  <tr><td>Paired laptops (SSH)</td><td>${devices ? devices.length : "—"}</td></tr>
                </table>
                ${
                  roles
                    ? `<div class="chips mt-8">${roles
                        .map(
                          (r) =>
                            `<a class="chip-link" href="/roles/${r.id}">${esc(r.label)}
                               <span class="muted">${r.user_count}</span></a>`
                        )
                        .join("")}</div>`
                    : ""
                }`
              : `<p class="muted small">Your role does not include viewing users.</p>`
          }
        </section>
      </div>

      <div class="ov-bottom">
        <section class="card">
          <div class="card-head"><h2>${icon("check")}Capabilities</h2><a class="btn small" href="/guide">Guide</a></div>
          <div class="panel-body">
            <ul class="cap-list">${capabilities
              .map(
                ([label, ok, note]) =>
                  `<li title="${esc(note)}"><span class="${ok ? "cap-ok" : "cap-miss"}">${icon(ok ? "check" : "close", 16)}</span>
                   <span>${esc(label)} <span class="sr">${ok ? "installed" : "missing"}</span><small>${esc(note)}</small></span></li>`
              )
              .join("")}</ul>
            ${
              missing
                ? `<p class="muted small mt-8">Missing pieces are installed by the deploy scripts in
                   <code>deploy/</code>; the guide says which script covers which.</p>`
                : ""
            }
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon("keys")}Recent sign-ins</h2><span class="card-aside">last ${logins.length}</span></div>
          <div class="panel-body">${
            loginRows.length
              ? `<table class="rows tight"><thead><tr><th>When</th><th>User · IP</th><th>Result</th></tr></thead><tbody>${loginRows.join("")}</tbody></table>`
              : `<p class="muted">No sign-ins recorded yet.</p>`
          }</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon("audit")}Recent audit</h2>${
            can(user, "audit.view") ? `<a class="btn small" href="/audit">Audit log</a>` : ""
          }</div>
          <div class="panel-body">${
            audit && audit.length
              ? `<ul class="feed">${audit
                  .map(
                    (e) => `<li><time>${esc(stamp(e.ts).slice(11, 16))}</time><span><span class="act">${esc(e.action)}</span>
                      <span class="det" title="${esc(JSON.stringify(e.detail))}">${esc(JSON.stringify(e.detail))}</span></span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="muted small">${can(user, "audit.view") ? "Nothing recorded yet." : "Your role does not include the audit log."}</p>`
          }</div>
        </section>
      </div>
    </div>`,
    {
      user,
      csrf,
      active: "os",
      pattern: "c",
      assets: ["mycelium-graph.js", "mycelium.js"],
      heading: "Machine health",
      subtitle: "The machine everything runs on — host health, capabilities, and who can reach it.",
      actions: `${can(user, "services.view") ? `<a class="btn" href="/services">${icon("services")} Services</a>` : ""}${
        can(user, "firewall.view") ? `<a class="btn" href="/firewall">${icon("ban")} Firewall</a>` : ""
      }`,
    }
  );
};

function capRow(label, present, note) {
  return `<tr>
    <td>${esc(label)}${note ? `<div class="muted small">${esc(note)}</div>` : ""}</td>
    <td>${
      present
        ? `<span class="pill ok">installed</span>`
        : `<span class="pill neutral">missing</span>`
    }</td></tr>`;
}

/* ----------------------------------------------------------------- keys --- */

/** "https://host/pair", with the port only when it is not 443. */
function pairUrl(host, port) {
  return "https://" + host + (String(port || "443") === "443" ? "" : ":" + port) + "/pair";
}

exports.keys = ({ csrf, user, keys, devices, canManage, canPair, codes, newCode, publicHost, publicPort, flash, flashError }) => {
  const deviceByFp = new Map((devices || []).map((d) => [d.fingerprint, d]));
  const rows = [];
  for (const [account, list] of Object.entries(keys || {})) for (const k of list || []) rows.push({ account, k });

  const keyTable = rows.length
    ? `<table class="rows stack aligned">
        <thead><tr><th>Label</th><th>User</th><th>Fingerprint</th><th></th></tr></thead>
        <tbody>${rows
          .map(({ account, k }) => {
            const dev = deviceByFp.get(k.fingerprint);
            return `<tr>
              <td class="first" data-h="Label"><div class="l1"><b class="ink">${esc(k.comment || "(no label)")}</b>${
                dev ? `<span class="pill nodot">paired</span>` : ""
              }</div><div class="l2">${esc(k.type)}${dev ? ` · paired ${esc(stamp(dev.paired_at).slice(0, 16))}${dev.paired_ip ? " from " + esc(dev.paired_ip) : ""}` : ""}</div></td>
              <td data-h="User"><div class="l1 mono small">${esc(account)}</div></td>
              <td data-h="Fingerprint"><div class="l1 mono small">${esc(k.fingerprint)}</div></td>
              <td class="right nolabel"><div class="l1">${
                canManage
                  ? `<form method="post" action="/keys/remove" class="inline"
                      data-confirm-dlg="Remove the key “${esc(k.comment || k.fingerprint)}”?"
                      data-confirm-body="That machine can no longer sign in to ${esc(account)} over SSH. It takes effect at once."
                      data-confirm-yes="Remove">
                      <input type="hidden" name="_csrf" value="${esc(csrf)}">
                      <input type="hidden" name="target_user" value="${esc(account)}">
                      <input type="hidden" name="fingerprint" value="${esc(k.fingerprint)}">
                      <button class="btn danger small" type="submit">${icon("trash", 14)} Remove</button>
                    </form>`
                  : ""
              }</div></td>
            </tr>`;
          })
          .join("")}</tbody></table>`
    : `<p class="muted">No keys.</p>`;

  const now = Date.now();
  const active = (codes || []).filter((c) => !c.used_at && new Date(c.expires_at).getTime() > now);
  const pairCard = canPair
    ? card(
        "Pair a device",
        `<p class="muted">A one-time code lets a laptop install its own SSH key at <span class="mono">/pair</span> — no private key is copied anywhere. Codes work once and expire after 15 minutes.</p>
        ${
          newCode
            ? `<div class="alert info">${icon("keys")}<div>Code <b class="mono pair-code">${esc(newCode)}</b> — enter it at <span class="mono">${esc(
                pairUrl(publicHost, publicPort)
              )}</span> on the laptop, with its public key.</div></div>`
            : ""
        }
        ${
          active.length
            ? `<table class="rows stack aligned">
                <thead><tr><th>Code</th><th>Label</th><th>Account</th><th>Expires</th><th></th></tr></thead>
                <tbody>${active
                  .map(
                    (c) => `<tr>
                      <td class="first" data-h="Code"><div class="l1 mono"><b class="ink">${esc(c.code)}</b></div></td>
                      <td data-h="Label"><div class="l1">${esc(c.label)}</div></td>
                      <td data-h="Account"><div class="l1 mono small">${esc(c.target_user)}</div></td>
                      <td data-h="Expires"><div class="l1 mono small">${esc(stamp(c.expires_at).slice(0, 16))}</div></td>
                      <td class="right nolabel"><div class="l1"><form method="post" action="/keys/pair/revoke" class="inline"
                          data-confirm-dlg="Revoke the code ${esc(c.code)}?" data-confirm-body="The laptop it was meant for can no longer use it." data-confirm-yes="Revoke">
                        <input type="hidden" name="_csrf" value="${esc(csrf)}">
                        <input type="hidden" name="code" value="${esc(c.code)}">
                        <button class="btn danger small" type="submit">Revoke code</button></form></div></td>
                    </tr>`
                  )
                  .join("")}</tbody></table>`
            : ""
        }
        <form method="post" action="/keys/pair" class="pair-form">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <label>Device label<input name="label" placeholder="e.g. new-laptop" maxlength="64" required></label>
          <label>Grant access to
            <select name="target_user">
              <option value="ubuntu">ubuntu (normal use — recommended)</option>
              <option value="root">root (full privilege)</option>
            </select></label>
          <div class="btn-row"><button class="btn primary" type="submit">${icon("plus", 16)} New pairing code</button></div>
        </form>`,
        { icon: "devices", id: "pair" }
      )
    : "";

  const addCard = canManage
    ? card(
        "Add a key by hand",
        `<p class="muted small">For a machine that cannot reach this panel${canPair ? `; otherwise prefer <a href="#pair">Pair a device</a>` : ""}.</p>
        <form method="post" action="/keys/add">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <label>Account
            <select name="target_user">
              <option value="ubuntu">ubuntu (normal use)</option>
              <option value="root">root (full privilege)</option>
            </select></label>
          <label>Label<input name="label" placeholder="e.g. work-laptop" maxlength="64"></label>
          <label>Public key <span class="hint">contents of a .pub file</span>
            <textarea name="pubkey" rows="3" placeholder="ssh-ed25519 AAAAC3... user@host" required></textarea></label>
          <button class="btn primary" type="submit">Authorise key</button>
        </form>`,
        { icon: "plus" }
      )
    : "";

  return shell(
    "SSH keys",
    `${flashes({ msg: flash, err: flashError })}
    ${card("Keys", keyTable, { icon: "keys" })}
    ${pairCard}
    ${addCard}`,
    {
      user,
      csrf,
      active: "keys",
      pattern: "b",
      heading: "SSH keys",
      subtitle: "Keys that may sign in to this machine over SSH. Removing one takes effect at once.",
    }
  );
};

/* -------------------------------------------------------------- devices --- */

/** "now", "38 min ago", "2 h ago", "yesterday", "3 days ago". */
function seenLabel(iso) {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t) || !t) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 90) return "now";
  if (sec < 3600) return Math.round(sec / 60) + " min ago";
  if (sec < 86400) return Math.floor(sec / 3600) + " h ago";
  if (sec < 2 * 86400) return "yesterday";
  return Math.floor(sec / 86400) + " days ago";
}

exports.devices = ({ csrf, user, devices, canPair, flash, flashError }) => {
  const list = devices || [];
  const others = list.filter((d) => !d.current).length;
  const signed = (d) =>
    d.signedInAt ? esc(stamp(d.signedInAt).slice(0, 16)) : d.signedInBefore ? "before " + esc(stamp(d.signedInBefore).slice(0, 16)) : "—";

  const outAll = `<form method="post" action="/devices/signout-others" class="inline"
      data-confirm-dlg="Sign out ${others} other device${others === 1 ? "" : "s"}?"
      data-confirm-body="Every session but this one ends at once, including a live call on it. This device stays signed in."
      data-confirm-yes="Sign out">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button class="btn danger" type="submit"${others ? "" : " disabled"}>${icon("power")} Sign out all other devices</button>
    </form>`;

  const table = list.length
    ? `<table class="rows stack aligned devices-table">
        <thead><tr><th>Device</th><th>IP · where</th><th>Signed in</th><th>Last seen</th><th></th></tr></thead>
        <tbody>${list
          .map(
            (d) => `<tr${d.current ? ' class="me"' : ""}>
              <td class="first" data-h="Device"><div class="dev-name"><span class="dev-ico${d.current ? " me" : ""}">${icon(d.mobile ? "devices" : "monitor", 18)}</span><div>
                <div class="l1"><b class="ink">${esc(d.label)}</b>${d.current ? `<span class="pill ok">this device</span>` : ""}</div>
                <div class="l2">session ${esc(d.id.slice(0, 6))}…${d.known ? "" : " · signed in before devices were recorded"}</div></div></div></td>
              <td data-h="IP · where"><div><div class="l1 mono small">${esc(d.ip || "—")}</div><div class="l2">${d.place ? esc(d.place) : "place unknown"}</div></div></td>
              <td data-h="Signed in"><div class="l1 mono small">${signed(d)}</div></td>
              <td data-h="Last seen"><div class="l1 small">${d.current ? "now" : esc(seenLabel(d.lastSeenAt))}</div></td>
              <td class="right nolabel"><div class="l1">${
                d.current
                  ? `<span class="muted small">you are here</span>`
                  : `<form method="post" action="/devices/${esc(d.id)}/signout" class="inline"
                      data-confirm-dlg="Sign out ${esc(d.label)}?"
                      data-confirm-body="It is signed out at once; a live call on it ends. Signing in again needs the password and the authenticator."
                      data-confirm-yes="Sign out">
                      <input type="hidden" name="_csrf" value="${esc(csrf)}">
                      <button class="btn danger small" type="submit">${icon("power", 14)} Sign out</button>
                    </form>`
              }</div></td>
            </tr>`
          )
          .join("")}</tbody></table>`
    : `<p class="muted">No signed-in browsers were found.</p>`;

  return shell(
    "Signed-in devices",
    `${flashes({ msg: flash, err: flashError })}
    ${card("Your devices", table, { icon: "devices" })}
    ${card(
      "About",
      `<p class="muted flush">A session ends by itself after 8 hours without use. Places are not looked up: there is no location database on this machine, and an IP is never sent elsewhere. Pairing a laptop for SSH moved to ${
        canPair ? `<a href="/keys#pair">SSH keys › Pair a device</a>` : "SSH keys › Pair a device"
      } — it installs a key, it is not a sign-in.</p>`,
      { icon: "info" }
    )}`,
    {
      user,
      csrf,
      active: "devices",
      pattern: "b",
      heading: "Signed-in devices",
      subtitle: "Every browser signed in to Joya as you. Signing a device out ends its session at once — including a live call on it.",
      actions: outAll,
    }
  );
};

exports.pair = ({ csrf, error }) =>
  shell(
    "Pair this device",
    `<div class="card">
      <h2>Pair this device</h2>
      <p class="muted small">Enter the pairing code from the dashboard, and this device's
        <strong>public</strong> key. Never paste a private key here — or anywhere.</p>
      ${error ? `<div class="alert bad">${icon("alert")}<div>${esc(error)}</div></div>` : ""}
      <details class="mb-14">
        <summary class="muted small">How do I get my public key?</summary>
        <p class="small">Windows PowerShell:</p>
        <pre>ssh-keygen -t ed25519 -f $env:USERPROFILE\\.ssh\\joya_key
type $env:USERPROFILE\\.ssh\\joya_key.pub</pre>
        <p class="small">macOS or Linux:</p>
        <pre>ssh-keygen -t ed25519 -f ~/.ssh/joya_key
cat ~/.ssh/joya_key.pub</pre>
      </details>
      <form method="post" action="/pair" autocomplete="off">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <label>Pairing code<input name="code" placeholder="XXXX-XXXX-XXXX" required autofocus></label>
        <label>Public key<textarea name="pubkey" rows="3" placeholder="ssh-ed25519 AAAAC3..." required></textarea></label>
        <button class="btn primary" type="submit" class="w-full">Pair device</button>
      </form>
    </div>`
  );

exports.paired = ({ label, targetUser, fingerprint, publicHost }) =>
  shell(
    "Device paired",
    `<div class="card">
      <h2>Device paired</h2>
      <div class="alert good">${icon("check")}<div>${esc(label)} can now sign in as
        <strong>${esc(targetUser)}</strong>.</div></div>
      <p class="muted small">Fingerprint</p>
      <p><code class="secret">${esc(fingerprint)}</code></p>
      <h3>Connect over SSH</h3>
      <pre>ssh -i ~/.ssh/joya_key ${esc(targetUser)}@${esc(publicHost)}</pre>
      <h3>Connect over Remote Desktop</h3>
      <p class="muted small">RDP is not exposed to the internet. Open a tunnel first, then
        point Remote Desktop at <code>127.0.0.1:13389</code>.</p>
      <pre>ssh -N -L 13389:127.0.0.1:3389 ${esc(targetUser)}@${esc(publicHost)}</pre>
    </div>`
  );

/* ---------------------------------------------------------------- audit --- */

exports.audit = ({ csrf, user, entries, err, logins }) => {
  const actPill = (a) =>
    /remove|delete|ban$|forget|clear|revoke/.test(a) ? "bad" : /set|update|settings|edit|write/.test(a) ? "warn" : "ok";
  return shell(
    "Audit log",
    `${err ? `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>` : ""}
    <div class="split">
      <section class="card hud">
        <div class="card-head"><h2>${icon("audit")}Privileged actions</h2><span class="card-aside">newest first</span></div>
        <div class="tbl">${
          entries.length
            ? `<table class="rows">
                <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Detail</th></tr></thead>
                <tbody>${entries
                  .map(
                    (e) => `<tr>
                      <td class="mono nowrap">${esc(stamp(e.ts))}</td>
                      <td><span class="pill act ${actPill(String(e.action))}">${esc(e.action)}</span></td>
                      <td><span class="det" title="${esc(JSON.stringify(e.detail))}">${esc(JSON.stringify(e.detail))}</span></td>
                    </tr>`
                  )
                  .join("")}</tbody></table>`
            : `<p class="muted card-body-pad">Nothing recorded yet.</p>`
        }</div>
        <div class="card-foot"><span>Header stays put; only this list scrolls.</span><span class="mono">latest ${entries.length}</span></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>${icon("keys")}Sign-in history</h2><span class="card-aside">newest first</span></div>
        <div class="tbl">${
          logins.length
            ? `<table class="rows">
                <thead><tr><th scope="col">When</th><th scope="col">IP</th><th scope="col">User</th><th scope="col">Result</th></tr></thead>
                <tbody>${logins
                  .map(
                    (l) => `<tr>
                      <td class="mono nowrap">${esc(stamp(l.ts).slice(5))}</td>
                      <td class="mono">${esc(l.ip || "—")}</td>
                      <td>${esc(l.username || "—")}</td>
                      <td><span class="pill ${l.outcome === "success" ? "ok" : l.outcome === "admin" ? "neutral" : "bad"}">${esc(l.outcome)}</span>
                        ${l.detail ? `<span class="muted small"> ${esc(l.detail)}</span>` : ""}</td>
                    </tr>`
                  )
                  .join("")}</tbody></table>`
            : `<p class="muted card-body-pad">No sign-ins recorded.</p>`
        }</div>
        <div class="card-foot"><span>Failed sign-ins feed the fail2ban jail.</span><span class="mono">latest ${logins.length}</span></div>
      </section>
    </div>`,
    {
      user,
      csrf,
      active: "audit",
      pattern: "b",
      fill: true,
      heading: "Audit log",
      subtitle: "Every privileged action taken through this panel.",
      actions: `<span class="pill nodot mono">${entries.length} actions · ${logins.length} sign-ins</span>`,
    }
  );
};
