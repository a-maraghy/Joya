"use strict";
/**
 * Claude Code: memory, sessions, and what is running now.
 *
 * Every value on these pages came through the privileged helper, which redacts
 * it, and through priv.js, which redacts it again. The views still escape
 * everything they print: redaction keeps secrets off the page, escaping keeps a
 * transcript that happens to contain markup from becoming markup.
 */

const { esc, bytes, duration, ago, stamp, shell, stat, card, flashes, empty, icon, can } =
  require("./ui");
const { graphPanel, viewSwitch } = require("./views-memgraph");

const KINDS = ["decision", "figure", "trap", "preference", "open_issue", "fact"];

/* ---------------------------------------------------------------- helpers - */

const hidden = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

/** A query string from an object, dropping empty values. */
function qs(params) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    out.set(k, v === true ? "1" : String(v));
  }
  const s = out.toString();
  return s ? "?" + s : "";
}

function pager(base, params, page, pages) {
  if (!pages || pages <= 1) return "";
  const link = (p, label, on) =>
    on
      ? `<a class="btn small" href="${esc(base + qs({ ...params, page: p }))}">${label}</a>`
      : `<span class="btn small" aria-disabled="true">${label}</span>`;
  return `<div class="cc-pager">
    ${link(1, "« First", page > 1)}
    ${link(page - 1, "‹ Prev", page > 1)}
    <span class="muted small">Page ${esc(page)} of ${esc(pages)}</span>
    ${link(page + 1, "Next ›", page < pages)}
    ${link(pages, "Last »", page < pages)}
  </div>`;
}

/** A kind as people say it ("Traps and fixes", not "trap"). */
const kindLabel = (k) => require("./views-memory").KIND_ONE[k] || k;
const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;

function unitPill(u) {
  if (!u || u.load === "not-found") return pill("neutral", "not present");
  const map = { active: "ok", activating: "warn", deactivating: "warn", failed: "bad", inactive: "neutral" };
  return pill(map[u.active] || "neutral", u.active + (u.sub && u.sub !== u.active ? " / " + u.sub : ""));
}

/** Epoch milliseconds (sessions/*.json) or ISO, to ISO. */
function iso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  return String(v);
}

const when = (v) => {
  const t = iso(v);
  return t ? `<span title="${esc(stamp(t))}">${esc(ago(t))}</span>` : "—";
};

function snippet(text, n) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const sessionHref = (home, uuid, extra) =>
  `/claude/sessions/${encodeURIComponent(home)}/${encodeURIComponent(uuid)}${qs(extra)}`;

/**
 * Sessions' tabs: Live (what was Running), All and Archived -- links, so each
 * is a page of its own (?tab=) and works without JavaScript. `counts` is
 * optional ({live, all, archived}).
 */
const SESSION_TABS = [
  ["live", "Live", "claude.running.view"],
  ["all", "All", "claude.sessions.view"],
  ["archived", "Archived", "claude.sessions.view"],
];
exports.SESSION_TABS = SESSION_TABS; // the page map's Sessions tabs (lib/page-registry.js)
function tabs(active, user, counts) {
  const c = counts || {};
  const items = SESSION_TABS.filter((i) => can(user, i[2]));
  if (items.length < 2) return "";
  return `<nav class="tabs2" role="tablist" aria-label="Sessions">${items
    .map(
      ([key, label]) =>
        `<a role="tab" href="/claude/sessions?tab=${key}" aria-selected="${active === key}">${label}${
          c[key] != null ? ` <span class="badge plain">${esc(c[key])}</span>` : ""
        }</a>`
    )
    .join("")}</nav>`;
}

const page = (title, body, { user, csrf, active, subtitle, actions, pattern, fill, crumbs, assets, headingHtml }) =>
  shell(title, body, {
    user,
    csrf,
    active: "claude-" + active,
    heading: title,
    headingHtml,
    subtitle,
    actions,
    wide: true,
    pattern: pattern || "c",
    fill,
    crumbs,
    assets,
  });

const memCrumbs = (here) => [["Agents & sessions", "/agents/dashboard"], ["Memory", "/claude/memory"], [here, null]];

function factStatus(f) {
  if (f.superseded_by == null) return pill("ok", "current");
  if (f.superseded_by === f.id) return pill("bad", "forgotten");
  return pill("neutral", "superseded");
}

/* ----------------------------------------------------------------- memory - */

function memoryStats(stats, err) {
  const db = (stats && stats.db) || null;
  const health = (stats && stats.health) || null;
  if (!db) {
    return `<div class="alert bad">${icon("alert")}<div>The memory database did not answer: ${esc(
      (stats && stats.db_error) || err || "unknown error"
    )}</div></div>`;
  }
  const chunks = db.chunks || {};
  return `<div class="statrow">
    ${stat(db.facts.current, "current facts", "memory")}
    ${stat(db.facts.superseded + db.facts.forgotten, `superseded (${db.facts.forgotten} forgotten)`, "archive")}
    ${stat(chunks.transcript || 0, "transcript chunks", "logs")}
    ${stat((chunks.doc || 0) + (chunks.memory_file || 0), `doc / memory-file chunks`, "file")}
    ${stat(db.sessions_indexed, "sessions indexed", "agents")}
    ${stat(bytes(db.db_bytes), "database size", "cpu")}
  </div>
  <p class="muted small cc-line">
    Search service ${
      health && health.ok
        ? pill("ok", "healthy") + ` <span class="mono">${esc(health.model)}</span> · ${esc(health.dims)} dims`
        : pill("bad", "unreachable") + ` <span class="mono">${esc((stats && stats.health_error) || "")}</span>`
    }
    · last ingest ${when(db.last_ingest)} · last fact extraction ${when(db.last_facts)}
  </p>`;
}

function searchCard(query, project, search, projects, err) {
  const results = search && search.results;
  return card(
    "Search memory",
    `<p class="muted small">The same hybrid search Claude Code's hooks use: vector similarity
      and full-text, fused. Facts rank above transcript chunks.</p>
    <form method="get" action="/claude/memory" class="searchbar">
      <input name="q" value="${esc(query || "")}" placeholder="what did we decide about the purchase plan?" maxlength="500">
      <select name="sproject" class="cc-narrow" aria-label="Project">
        <option value="">All projects</option>
        ${(projects || [])
          .map((p) => `<option value="${esc(p)}"${p === project ? " selected" : ""}>${esc(p)}</option>`)
          .join("")}
      </select>
      <button class="btn primary" type="submit">${icon("search")} Search</button>
    </form>
    ${err ? `<div class="alert bad">${icon("alert")}<div>${esc(err)}</div></div>` : ""}
    ${
      query && results
        ? results.length
          ? `<div class="hits">${results
              .map(
                (h) => `<div class="hit">
                <div class="hit-head">
                  ${pill(h.kind === "fact" ? "ok" : "neutral", h.kind || "?")}
                  ${
                    h.kind === "fact"
                      ? `<a class="mono small" href="/claude/memory/facts/${esc(h.id)}">fact #${esc(h.id)}</a>
                         <span class="mono small muted">${esc(h.topic || "")}</span>`
                      : `<span class="mono small muted">${esc(h.source || "")}${
                          h.role ? " · " + esc(h.role) : ""
                        }${h.project ? " · " + esc(h.project) : ""}</span>`
                  }
                  ${
                    h.session_id
                      ? `<a class="small" href="/claude/memory/session/${esc(h.session_id)}">session ${esc(
                          String(h.session_id).slice(0, 8)
                        )}</a>`
                      : ""
                  }
                  <span class="muted small right">${esc(stamp(h.ts).slice(0, 10))} · ${esc(
                  Number(h.score || 0).toFixed(4)
                )}</span>
                </div>
                <pre class="snippet">${esc(h.content)}${h.truncated ? "…" : ""}</pre>
              </div>`
              )
              .join("")}</div>
            <p class="muted small">${esc(results.length)} results in ${esc(
              Math.round((search.timing_ms && search.timing_ms.total) || search.timing_ms || 0) || "?"
            )} ms.</p>`
          : `<p class="muted">Nothing matched.</p>`
        : ""
    }`,
    { icon: "search" }
  );
}

function factFilters(filters, stats) {
  const db = (stats && stats.db) || {};
  return `<form method="get" action="/claude/memory" class="cc-filters">
    <label>Topic prefix
      <input name="topic" value="${esc(filters.topic || "")}" list="cc-topics" placeholder="project.topic" maxlength="121">
      <datalist id="cc-topics">${(db.topics || []).map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    </label>
    <label>Project
      <select name="project">
        <option value="">Any</option>
        ${(db.projects || [])
          .map((p) => `<option value="${esc(p)}"${p === filters.project ? " selected" : ""}>${esc(p)}</option>`)
          .join("")}
      </select>
    </label>
    <label>Kind
      <select name="kind">
        <option value="">Any</option>
        ${KINDS.map((k) => `<option value="${esc(k)}"${k === filters.kind ? " selected" : ""}>${esc(kindLabel(k))}</option>`).join("")}
      </select>
    </label>
    <label>Contains
      <input name="fq" value="${esc(filters.q || "")}" maxlength="200">
    </label>
    <label class="check"><input type="checkbox" name="sup" value="1"${
      filters.superseded ? " checked" : ""
    }> Include superseded</label>
    <button class="btn small" type="submit">Filter</button>
    <a class="btn small" href="/claude/memory">Reset</a>
  </form>`;
}

function factsTable(facts, emptyText) {
  if (!facts || !facts.length) return `<p class="muted">${esc(emptyText || "No facts match.")}</p>`;
  return `<div class="cc-scroll"><table class="rows">
    <thead><tr><th>#</th><th>Topic</th><th>Fact</th><th>Kind</th><th>Project</th><th>When</th><th></th></tr></thead>
    <tbody>${facts
      .map(
        (f) => `<tr>
        <td class="mono small"><a href="/claude/memory/facts/${esc(f.id)}">${esc(f.id)}</a></td>
        <td class="mono small">${esc(f.topic || "—")}</td>
        <td class="small">${esc(snippet(f.content, 220))}</td>
        <td class="small">${esc(kindLabel((f.meta && f.meta.kind) || "fact"))}</td>
        <td class="small">${esc((f.meta && f.meta.project) || "—")}</td>
        <td class="small nowrap">${when(f.ts)}</td>
        <td>${factStatus(f)}</td>
      </tr>`
      )
      .join("")}</tbody></table></div>`;
}

function addFactForm(csrf, stats) {
  const db = (stats && stats.db) || {};
  return `<details class="mt-12">
    <summary class="btn small">${icon("plus")} Add a fact</summary>
    <form method="post" action="/claude/memory/facts" class="mt-12">
      ${hidden(csrf)}
      <label>Fact <span class="hint">One durable statement. Secrets are redacted before it is stored.</span>
        <textarea name="content" rows="3" maxlength="4000" required></textarea></label>
      <div class="cc-filters">
        <label>Topic <input name="topic" required maxlength="121" list="cc-topics" placeholder="project.topic.detail"></label>
        <label>Kind <select name="kind">${KINDS.map((k) => `<option${k === "fact" ? " selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>Project <select name="project"><option value="">None</option>${(db.projects || [])
          .map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
          .join("")}</select></label>
      </div>
      <button class="btn primary small" type="submit">${icon("save")} Store fact</button>
    </form>
  </details>`;
}

function memfilesCard(files, err) {
  return card(
    "Auto-memory files",
    err
      ? `<p class="muted">${esc(err)}</p>`
      : files && files.length
      ? `<table class="rows">
          <thead><tr><th>File</th><th>Project</th><th>Size</th><th>Modified</th></tr></thead>
          <tbody>${files
            .map(
              (f) => `<tr>
              <td><a class="mono small" href="/claude/memory/files/${encodeURIComponent(f.project)}/${encodeURIComponent(
                f.name
              )}">${esc(f.name)}</a></td>
              <td class="mono small">${esc(f.project)}</td>
              <td class="mono small">${bytes(f.bytes)}</td>
              <td class="small">${when(f.modified)}</td>
            </tr>`
            )
            .join("")}</tbody></table>
          <p class="muted small">Claude Code's own notes to itself, one folder per project. A save
            re-indexes them into memory in the background.</p>`
      : `<p class="muted">No memory files yet.</p>`,
    { icon: "file" }
  );
}

function hooksCard(hooks, err) {
  const fmt = (d) =>
    Object.entries(d || {})
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  return card(
    "Hook activity",
    err
      ? `<p class="muted">${esc(err)}</p>`
      : hooks && hooks.length
      ? `<div class="cc-scroll cc-tall"><table class="rows">
          <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
          <tbody>${hooks
            .map(
              (h) => `<tr>
              <td class="small nowrap" title="${esc(h.ts)}">${esc(String(h.ts || "").replace("T", " ").slice(5, 19))}</td>
              <td class="small strong">${esc(h.event)}</td>
              <td class="mono small">${esc(fmt(h.detail))}</td>
            </tr>`
            )
            .join("")}</tbody></table></div>
          <p class="muted small">Counts and timings only — the hook log never records content.</p>`
      : `<p class="muted">No hook activity logged yet.</p>`,
    { icon: "activity" }
  );
}

function servicesCard(csrf, user, svc, err) {
  if (!svc) return card("Memory services", `<p class="muted">${esc(err || "Unavailable.")}</p>`, { icon: "services" });
  const writable = can(user, "claude.memory.write");
  const s = svc.service || {};
  const jobs = (svc.jobs && svc.jobs.processes) || [];
  return card(
    "Memory services",
    `<table class="kv">
      <tr><td>claude-memory</td><td>${unitPill(s)} ${
        s.memory != null ? `<span class="muted small">${bytes(s.memory)}</span>` : ""
      } <span class="muted small">since ${esc(s.since || "—")}</span></td></tr>
      <tr><td>Nightly backup</td><td>${esc((svc.backup_timer && svc.backup_timer.active) || "—")} · last run ${esc(
      (svc.backup && svc.backup.exited) || "never"
    )} (${esc((svc.backup && svc.backup.result) || "—")}) · next ${esc(
      (svc.backup_timer && svc.backup_timer.next) || "—"
    )}</td></tr>
      <tr><td>cm-ingest</td><td>${unitPill(svc.ingest)} ${
      svc.ingest && svc.ingest.exited ? `<span class="muted small">last exit ${esc(svc.ingest.exited)}</span>` : ""
    }</td></tr>
      <tr><td>cm-ingest-docs</td><td>${unitPill(svc.ingest_docs)}</td></tr>
      <tr><td>Ingest processes</td><td>${
        jobs.length
          ? jobs
              .map((j) => `<span class="mono small">${esc(j.script)} ${esc((j.flags || []).join(" "))} · pid ${esc(j.pid)} · ${esc(duration(j.uptime))}</span>`)
              .join("<br>")
          : `<span class="muted small">none running</span>`
      }</td></tr>
      <tr><td>Ingest log</td><td class="small">updated ${when(svc.ingest_log && svc.ingest_log.modified)}</td></tr>
    </table>
    ${
      svc.ingest_log && svc.ingest_log.tail && svc.ingest_log.tail.length
        ? `<pre class="cc-log">${esc(svc.ingest_log.tail.join("\n"))}</pre>`
        : ""
    }
    ${
      writable
        ? `<div class="btn-row">
            <form method="post" action="/claude/memory/restart" class="inline"
                  data-confirm="Restart claude-memory? Search and memory hooks pause for a few seconds while the model reloads.">
              ${hidden(csrf)}<button class="btn small" type="submit">${icon("restart")} Restart claude-memory</button>
            </form>
            <form method="post" action="/claude/memory/ingest" class="inline"
                  data-confirm="Re-scan every transcript into memory now? It runs in the background at low priority and skips what is already indexed.">
              ${hidden(csrf)}<button class="btn small" type="submit">${icon("reindex")} Run ingest --all</button>
            </form>
          </div>`
        : ""
    }`,
    { icon: "services" }
  );
}

/**
 * Claude Code > Memory: the long-term memory as a graph (the default), the
 * facts as a list, and the machinery (stats, auto-memory files, hook activity,
 * services) as an overview -- three views of one page, switched in place and
 * remembered in the URL (?view=). A search or a filter from the list lands on
 * the list, so every link and form the page had still goes where it went.
 */
exports.memory = (d) => {
  const { csrf, user, query, searchProject, filters, stats, facts, files, hooks, services, search, errors } = d;
  const view = MEMORY_VIEWS.some((v) => v[0] === d.view) ? d.view : "browse";
  const f = facts || { rows: [], total: 0, page: 1, per_page: 25 };
  const pages = Math.max(1, Math.ceil((f.total || 0) / (f.per_page || 25)));
  const filterParams = {
    topic: filters.topic,
    project: filters.project,
    kind: filters.kind,
    fq: filters.q,
    sup: filters.superseded,
  };
  const db = (stats && stats.db) || null;
  const projects = (db && db.projects) || [];
  const hide = (v) => (v === view ? "" : " hidden");
  return page(
    "Claude Code memory",
    `    ${flashes({ msg: d.flash, err: d.err })}
    <div class="mg-page mem-page">
      ${require("./views-memory").claudeBrowse({
        outline: d.outline,
        recent: d.recent && d.recent.rows,
        agents: d.memAgents,
        errors: Object.assign({ facts: errors.recent }, errors),
        hidden: view !== "browse",
      })}
      ${graphPanel({
        kind: "claude",
        src: "/api/claude/memory/graph",
        search: "/api/claude/memory/search",
        incremental: true,
        poll: 15000,
        groups: [{ key: "", label: "All projects" }].concat(projects.map((p) => ({ key: p, label: p, dot: "ok" }))),
        group: "",
        csrf,
        writable: can(user, "claude.memory.write"),
        factUrl: "/api/claude/memory/fact/",
        listHref: "/claude/memory",
        placeholder: "Search… (Enter = by meaning)",
        hidden: view !== "graph",
      })}
      <div data-view-panel="list"${hide("list")}>
        ${searchCard(query, searchProject, search, projects, errors.search)}
        ${card(
          "Facts",
          `${factFilters(filters, stats)}
          ${errors.facts ? `<div class="alert bad">${icon("alert")}<div>${esc(errors.facts)}</div></div>` : ""}
          <p class="muted small">${esc(f.total)} fact${f.total === 1 ? "" : "s"}, newest first. Editing a fact
            stores a new one that supersedes it, so the history is kept.</p>
          ${factsTable(f.rows)}
          ${pager("/claude/memory", Object.assign({ view: "list" }, filterParams), f.page, pages)}
          ${can(user, "claude.memory.write") ? addFactForm(csrf, stats) : ""}`,
          { icon: "memory" }
        )}
      </div>
      <div data-view-panel="sessions"${hide("sessions")}>
        ${sessionsPanel(d)}
      </div>
      <div data-view-panel="overview"${hide("overview")}>
        ${memoryStats(stats, errors.stats)}
        <div class="grid cols-2">
          ${memfilesCard(files, errors.files)}
          ${hooksCard(hooks, errors.hooks)}
        </div>
        ${servicesCard(csrf, user, services, errors.services)}
      </div>
    </div>`,
    {
      user,
      csrf,
      active: "memory",
      pattern: "a",
      assets: ["memgraph.css", "memgraph.js", "memory.css", "memory.js"],
      subtitle: "What Claude Code remembers across sessions on this machine, sorted by kind and topic.",
      actions: viewSwitch(
        view,
        MEMORY_VIEWS.map(([key, label, ic]) => [key, label, ic, "/claude/memory?view=" + key])
      ),
    }
  );
};

exports.fact = ({ csrf, user, data, flash, err }) => {
  const f = data.fact;
  const current = f.superseded_by == null;
  const writable = can(user, "claude.memory.write") && current;
  const meta = f.meta || {};
  const metaRows = Object.entries(meta)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono small">${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`)
    .join("");
  return page(
    "Fact #" + f.id,
    `    ${flashes({ msg: flash, err })}
    <div class="mem-note">
    <div class="mem-fact-main">
    ${card(
      f.topic || "Fact",
      `<div class="md-body mem-fact">${require("./markdown").render(f.content, { shift: 2 }).html}</div>
      <table class="kv mt-12">
        <tr><td>Kind</td><td>${esc(kindLabel(meta.kind || "fact"))}</td></tr>
        <tr><td>Status</td><td>${factStatus(f)}${
        data.newer
          ? ` replaced by <a href="/claude/memory/facts/${esc(data.newer.id)}">#${esc(data.newer.id)}</a>`
          : ""
      }</td></tr>
        <tr><td>Stored</td><td>${esc(stamp(f.ts))}</td></tr>
        <tr><td>Confidence</td><td>${esc(f.confidence == null ? "—" : f.confidence)}</td></tr>
        <tr><td>Embedded</td><td>${f.embedded ? "yes" : "no — found by full-text only"}</td></tr>
        <tr><td>Source session</td><td>${
          f.source_session
            ? `<a class="mono small" href="/claude/memory/session/${esc(f.source_session)}">${esc(f.source_session)}</a>`
            : "—"
        }</td></tr>
        ${metaRows}
      </table>`,
      {
        icon: "memory",
        actions: `<a class="btn small" href="/claude/memory">${icon("chevron")} Back to memory</a>`,
      }
    )}
    ${
      data.older && data.older.length
        ? card(
            "Earlier versions",
            `<table class="rows"><tbody>${data.older
              .map(
                (o) => `<tr><td class="mono small"><a href="/claude/memory/facts/${esc(o.id)}">#${esc(o.id)}</a></td>
                  <td class="small">${esc(snippet(o.content, 240))}</td><td class="small nowrap">${when(o.ts)}</td></tr>`
              )
              .join("")}</tbody></table>`,
            { icon: "clock" }
          )
        : ""
    }
    ${
      writable
        ? `<div class="grid cols-2">
          ${card(
            "Edit",
            `<p class="muted small">Stores the new wording as a new fact and marks this one superseded
              by it. Nothing is overwritten.</p>
            <form method="post" action="/claude/memory/facts/${esc(f.id)}/edit">
              ${hidden(csrf)}
              <label>Fact <textarea name="content" rows="5" maxlength="4000" required>${esc(f.content)}</textarea></label>
              <div class="cc-filters">
                <label>Topic <input name="topic" value="${esc(f.topic || "")}" required maxlength="121"></label>
                <label>Kind <select name="kind">${KINDS.map(
                  (k) => `<option${k === (meta.kind || "fact") ? " selected" : ""}>${k}</option>`
                ).join("")}</select></label>
              </div>
              <button class="btn primary small" type="submit">${icon("save")} Save as new version</button>
            </form>`,
            { icon: "edit" }
          )}
          ${card(
            "Forget",
            `<p class="muted small">A soft delete: the fact stays in the database, marked forgotten, and
              stops appearing in search and in the facts injected into new sessions.</p>
            <form method="post" action="/claude/memory/facts/${esc(f.id)}/forget"
                  data-confirm="Forget fact #${esc(f.id)}? It will stop being recalled. It is kept in the database and can be seen with 'Include superseded'.">
              ${hidden(csrf)}
              <label>Reason <span class="hint">Required. Recorded with the fact.</span>
                <input name="reason" required maxlength="500" placeholder="out of date since the v19 cutover"></label>
              <button class="btn danger small" type="submit">${icon("trash")} Forget this fact</button>
            </form>`,
            { icon: "ban" }
          )}
        </div>`
        : ""
    }
    </div>
    <aside class="mem-side" aria-label="Related facts">${require("./views-memory").factSide(data)}</aside>
    </div>`,
    { user, csrf, active: "memory", pattern: "c", assets: ["memory.css"], crumbs: memCrumbs("Fact #" + f.id), subtitle: `<span class="mono">${esc(f.topic || "")}</span>` }
  );
};

exports.memfile = ({ csrf, user, file, flash, err }) => {
  const writable = can(user, "claude.memory.write") && !file.redacted;
  return page(
    file.name,
    `    ${flashes({ msg: flash, err })}
    ${
      file.redacted
        ? `<div class="alert warn">${icon("alert")}<div>This file contains something that looks like a
            secret, so it is shown redacted and cannot be saved from here — saving would write the
            placeholders over the real text. Edit it over SSH.</div></div>`
        : ""
    }
    ${card(
      file.project + "/memory/" + file.name,
      `<form method="post" action="/claude/memory/files/${encodeURIComponent(file.project)}/${encodeURIComponent(file.name)}">
        ${hidden(csrf)}
        <textarea name="content" rows="26" class="code" spellcheck="false"${writable ? "" : " readonly"}>${esc(
          file.content
        )}</textarea>
        ${writable ? `<button class="btn primary" type="submit">${icon("save")} Save file</button>` : ""}
      </form>
      <p class="muted small">${bytes(file.bytes)} · modified ${esc(stamp(file.modified))}. Saving re-runs
        <span class="mono">ingest.py --docs</span> in the background.</p>`,
      {
        icon: "file",
        actions: `<a class="btn small" href="/claude/memory">${icon("chevron")} Back to memory</a>`,
      }
    )}`,
    { user, csrf, active: "memory", pattern: "c", crumbs: memCrumbs(file.name), subtitle: `<span class="mono">${esc(file.project)}</span>` }
  );
};

/* ------------------------------------------------------ memory by session - */

/**
 * Memory > Sessions: every Claude Code session that left something in memory, and
 * one session's facts and transcript chunks with hide / unhide / delete.
 *
 * Hiding keeps a row but takes it out of search, the injected memory (each prompt,
 * session start, subagents), memory_session and the graph; it can be undone. Deleting
 * removes it for good. The helper enforces the rules (one session per request, live
 * sessions protected, counts re-checked, the name typed back); these pages only say
 * them out loud.
 */

/** Memory's views, for the page's switch and the page map (lib/page-registry.js). */
const MEMORY_VIEWS = [
  ["browse", "Browse", "memory"],
  ["list", "Facts", "logs"],
  ["graph", "Graph", "network"],
  ["sessions", "Sessions", "clock"],
  ["overview", "Overview", "activity"],
];
exports.MEMORY_VIEWS = MEMORY_VIEWS;

const MM_SORTS = {
  name: (s) => String(s.name || "").toLowerCase(),
  origin: (s) => String(s.origin || "").toLowerCase(),
  project: (s) => String(s.project || "").toLowerCase(),
  first: (s) => String(s.first || ""),
  last: (s) => String(s.last || ""),
  chunks: (s) => Number(s.chunks || 0),
  facts: (s) => Number(s.facts || 0),
  hidden: (s) => Number(s.chunks_hidden || 0) + Number(s.facts_hidden || 0),
};
exports.MM_SORTS = Object.keys(MM_SORTS);

/** Search and sort the session list: { q, sort, dir } from the query string. */
function mmSortSessions(rows, o) {
  const q = String((o && o.q) || "").trim().toLowerCase();
  const sort = MM_SORTS[o && o.sort] ? o.sort : "last";
  const dir = o && o.dir === "asc" ? 1 : o && o.dir === "desc" ? -1 : sort === "name" || sort === "origin" || sort === "project" ? 1 : -1;
  const key = MM_SORTS[sort];
  const out = (rows || []).filter(
    (s) =>
      !q ||
      [s.name, s.origin, s.project, s.machine_label, s.session_id, s.title]
        .map((v) => String(v || "").toLowerCase())
        .some((v) => v.includes(q))
  );
  out.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -dir : x > y ? dir : String(a.session_id).localeCompare(String(b.session_id));
  });
  return { rows: out, sort, dir: dir === 1 ? "asc" : "desc", q };
}
exports.mmSortSessions = mmSortSessions;

const mmHref = (uuid, params) => `/claude/memory/session/${encodeURIComponent(uuid)}${qs(params)}`;
const day = (v) => (v ? `<span title="${esc(stamp(v))}">${esc(String(v).slice(0, 10))}</span>` : "—");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

const BACKUP_NOTE = `Deleted memory is gone from the live index at once, but the nightly backups
  (<span class="mono">/root/backups/claude_memory_*.dump</span>, the last 14 kept) still hold it until they rotate out.`;

function notReady(list) {
  const caps = (list && list.caps) || {};
  if (list && list.ready && caps.hidden && caps.excluded && caps.tombstones) return "";
  return `<div class="alert warn">${icon("alert")}<div>Hiding and deleting need the claude-memory update
    (<span class="mono">deploy/claude-memory-manage/install.sh</span>): a <span class="mono">hidden</span> flag on chunks, an
    exclusion list for deleted sessions, and an ingest that honours both. Until it is installed this list is read-only.</div></div>`;
}

function livePill(s) {
  return s.live ? `<span class="pill warn" title="${esc(s.live_reason || "")}">live</span>` : "";
}

function sessionsPanel(d) {
  const { user, mm, mmErr } = d;
  if (mmErr) return card("Sessions with memory", `<div class="alert bad">${icon("alert")}<div>${esc(mmErr)}</div></div>`, { icon: "clock" });
  const list = mm || { sessions: [] };
  const f = d.mmQuery || {};
  const sorted = mmSortSessions(list.sessions, f);
  const all = list.sessions || [];
  const tot = (k) => all.reduce((n, s) => n + Number(s[k] || 0), 0);
  const head = (key, label, cls) => {
    const on = sorted.sort === key;
    const next = on && sorted.dir === "desc" ? "asc" : on ? "desc" : key === "name" || key === "origin" || key === "project" ? "asc" : "desc";
    return `<th${cls ? ` class="${cls}"` : ""} aria-sort="${on ? (sorted.dir === "asc" ? "ascending" : "descending") : "none"}"><a href="${esc(
      "/claude/memory" + qs({ view: "sessions", sq: sorted.q, sort: key, dir: next })
    )}">${esc(label)}${on ? (sorted.dir === "asc" ? " ▲" : " ▼") : ""}</a></th>`;
  };
  const rows = sorted.rows
    .map(
      (s) => `<tr>
        <td class="cc-title-cell"><a href="${esc(mmHref(s.session_id))}">${esc(s.name)}</a> ${livePill(s)}${
        s.excluded ? ` <span class="pill neutral" title="Deleted ${esc(String(s.excluded.excluded_at || "").slice(0, 10))}; never indexed again">excluded</span>` : ""
      }<div class="mono small muted">${esc(String(s.session_id).slice(0, 8))}</div></td>
        <td class="small">${esc(s.origin || "—")}</td>
        <td class="small mono">${esc(s.project || "—")}</td>
        <td class="small">${esc(s.machine_label || "—")}</td>
        <td class="small nowrap">${day(s.first)}</td>
        <td class="small nowrap">${day(s.last)}</td>
        <td class="small right">${esc(s.chunks)}${s.chunks_hidden ? ` <span class="muted">(${esc(s.chunks_hidden)} hidden)</span>` : ""}</td>
        <td class="small right nowrap">${esc(s.facts)}${s.facts_hidden ? ` <span class="muted">· ${esc(s.facts_hidden)} hidden</span>` : ""}${
        s.facts_superseded ? ` <span class="muted">· ${esc(s.facts_superseded)} superseded</span>` : ""
      }</td>
      </tr>`
    )
    .join("");
  return card(
    "Sessions with memory",
    `${notReady(list)}
    <form method="get" action="/claude/memory" class="cc-filters" role="search">
      <input type="hidden" name="view" value="sessions">
      <label>Search <input type="search" name="sq" value="${esc(sorted.q)}" maxlength="120" placeholder="name, project, machine or id"></label>
      <label>Sort by <select name="sort">${Object.keys(MM_SORTS)
        .map((k) => `<option value="${k}"${k === sorted.sort ? " selected" : ""}>${esc(k === "last" ? "last active" : k === "first" ? "first seen" : k)}</option>`)
        .join("")}</select></label>
      <label>Order <select name="dir"><option value="desc"${sorted.dir === "desc" ? " selected" : ""}>descending</option>
        <option value="asc"${sorted.dir === "asc" ? " selected" : ""}>ascending</option></select></label>
      <button class="btn small" type="submit">${icon("search")} Show</button>
      <a class="btn small" href="/claude/memory?view=sessions">Reset</a>
    </form>
    <p class="muted small">${esc(plural(sorted.rows.length, "session"))}${
      sorted.rows.length !== all.length ? ` of ${esc(all.length)}` : ""
    } · ${esc(tot("chunks"))} chunks (${esc(tot("chunks_hidden"))} hidden) · ${esc(tot("facts"))} current facts (${esc(
      tot("facts_hidden")
    )} hidden). Open a session to see its memory${can(user, "claude.memory.manage") ? " and to hide or delete it" : ""}.</p>
    ${
      rows
        ? `<div class="cc-scroll"><table class="rows mm-sessions">
        <thead><tr>${head("name", "Session")}${head("origin", "Origin")}${head("project", "Project")}<th>Machine</th>${head(
            "first",
            "First"
          )}${head("last", "Last")}${head("chunks", "Chunks", "right")}${head("facts", "Facts", "right")}</tr></thead>
        <tbody>${rows}</tbody></table></div>`
        : `<p class="muted">No session matches.</p>`
    }
    <p class="muted small mt-12">${BACKUP_NOTE}</p>`,
    { icon: "clock", id: "mm-sessions" }
  );
}
exports.sessionsPanel = sessionsPanel;

function mmFactStatus(f) {
  if (f.superseded_by == null) return pill("ok", "active");
  if (f.superseded_by === f.id) return `<span class="pill bad" title="${esc(f.forgotten || "")}">hidden</span>`;
  return pill("neutral", "superseded");
}

/** The filters as hidden fields, so a bulk action acts on what the page shows. */
function filterFields(f) {
  return ["q", "topic", "status", "show"]
    .map((k) => `<input type="hidden" name="f_${k}" value="${esc((f && f[k]) || "")}">`)
    .join("");
}

exports.sessionMemory = ({ csrf, user, data, uuid, err, flash }) => {
  const d = data || null;
  const meta = (d && d.session) || { session_id: uuid, name: "Session " + String(uuid).slice(0, 8) };
  const manage = can(user, "claude.memory.manage");
  const ready = !!(d && d.ready && d.caps && d.caps.hidden && d.caps.excluded && d.caps.tombstones);
  const act = manage && ready;
  const f = (d && d.filters) || {};
  const filterParams = { q: f.q, topic: f.topic, status: f.status, show: f.show };
  const pages = d ? Math.max(1, Math.ceil((d.chunks_total || 0) / (d.per_page || 50))) : 1;
  const crumbs = memCrumbs(meta.name);
  if (!d) {
    return page(meta.name, `${flashes({ msg: flash, err })}
      <p><a class="btn small" href="/claude/memory?view=sessions">${icon("chevron")} All sessions</a></p>`, {
      user,
      csrf,
      active: "memory",
      pattern: "c",
      crumbs,
    });
  }
  const filtered = !!(f.q || f.topic || f.status || f.show);
  const box = (name, id) => (act ? `<input type="checkbox" name="${name}" value="${esc(id)}" aria-label="Select ${name === "f" ? "fact" : "chunk"} ${esc(id)}">` : "");
  const factRows = (d.facts || [])
    .map(
      (x) => `<tr>
        ${act ? `<td>${box("f", x.id)}</td>` : ""}
        <td class="mono small"><a href="/claude/memory/facts/${esc(x.id)}">#${esc(x.id)}</a></td>
        <td class="mono small">${esc(x.topic || "—")}</td>
        <td class="small">${esc(snippet(x.content, 260))}</td>
        <td class="small">${esc(x.kind || "—")}</td>
        <td class="small nowrap">${day(x.ts)}</td>
        <td>${mmFactStatus(x)}</td>
      </tr>`
    )
    .join("");
  const chunkRows = (d.chunks || [])
    .map(
      (c) => `<li class="mm-chunk${c.hidden ? " is-hidden" : ""}">
        ${act ? `<span class="mm-box">${box("c", c.id)}</span>` : ""}
        <div class="mm-chunk-body">
          <div class="hit-head">
            ${pill(c.role === "summary" ? "warn" : "neutral", c.role || "chunk")}
            ${c.hidden ? pill("bad", "hidden") : ""}
            <span class="mono small muted">#${esc(c.id)} · turn ${esc(c.turn_index == null ? "—" : c.turn_index)}${
        c.agent_type ? " · subagent " + esc(c.agent_type) : c.subagent_id ? " · subagent" : ""
      }</span>
            <span class="muted small right">${esc(stamp(c.ts))} · ${esc(c.chars)} chars</span>
          </div>
          <p class="small mm-preview">${esc(snippet(c.content, 320))}</p>
        </div>
      </li>`
    )
    .join("");
  const topics = d.topics || [];
  const liveNote = meta.live
    ? `<div class="alert warn" id="mm-live">${icon("alert")}<div><strong>This session is live</strong> — ${esc(
        meta.live_reason || "it is running now"
      )}. Its memory is still being written. Hiding or deleting the <em>whole</em> session is refused while it runs;
        single facts and chunks can still be hidden or deleted, but check twice: this may be the session you are working in.</div></div>`
    : "";
  const exNote = meta.excluded
    ? `<div class="alert info">${icon("info")}<div>Deleted on ${esc(stamp(meta.excluded.excluded_at))}${
        meta.excluded.excluded_by ? " by " + esc(meta.excluded.excluded_by) : ""
      }. It is excluded from indexing, so a re-scan will not bring it back.${
        act
          ? ` <form method="post" action="${esc(mmHref(uuid) + "/reindex")}" class="inline"
              data-confirm="Allow this session to be indexed again? The next re-scan indexes whatever transcript of it is still on disk.">
              ${hidden(csrf)}<button class="btn small" type="submit">${icon("reindex")} Allow re-indexing</button></form>`
          : ""
      }</div></div>`
    : "";
  const summary = `<div class="statrow mm-stats">
      ${stat(meta.facts || 0, "current facts", "memory")}
      ${stat(meta.facts_hidden || 0, "hidden facts", "eye")}
      ${stat(meta.chunks || 0, "chunks", "logs")}
      ${stat(meta.chunks_hidden || 0, "hidden chunks", "eye")}
    </div>
    <p class="muted small cc-line">${esc(meta.origin || "")} · project <span class="mono">${esc(meta.project || "—")}</span> ·
      ${esc(meta.machine_label || "—")} · ${day(meta.first)} → ${day(meta.last)} · ${esc(plural(meta.facts_superseded || 0, "superseded fact"))} ·
      <span class="mono">${esc(meta.session_id)}</span></p>`;
  const filterForm = `<form method="get" action="${esc(mmHref(uuid))}" class="cc-filters" role="search" id="mm-filter">
      <label>Text <input type="search" name="q" value="${esc(f.q || "")}" maxlength="200" placeholder="words in a fact or chunk"></label>
      <label>Topic <select name="topic"><option value="">any topic</option>${topics
        .map((t) => `<option value="${esc(t.topic)}"${t.topic === f.topic ? " selected" : ""}>${esc(t.topic)} (${esc(t.n)})</option>`)
        .join("")}</select></label>
      <label>Status <select name="status">${[["", "any"], ["active", "active"], ["hidden", "hidden"], ["superseded", "superseded (facts)"]]
        .map(([v, l]) => `<option value="${v}"${v === (f.status || "") ? " selected" : ""}>${l}</option>`)
        .join("")}</select></label>
      <label>Show <select name="show">${[["", "facts and chunks"], ["facts", "facts only"], ["chunks", "chunks only"]]
        .map(([v, l]) => `<option value="${v}"${v === (f.show || "") ? " selected" : ""}>${l}</option>`)
        .join("")}</select></label>
      <button class="btn small" type="submit">${icon("search")} Filter</button>
      ${filtered ? `<a class="btn small" href="${esc(mmHref(uuid))}">Reset</a>` : ""}
    </form>
    ${f.topic ? `<p class="muted small">A topic filter shows facts only: transcript chunks have no topic.</p>` : ""}`;
  const nSel = d.facts_total + d.chunks_total;
  const bar = act
    ? `<div class="mm-bar" role="group" aria-label="Act on the selection">
        <span class="small mm-count" data-mm-count>Select facts or chunks below</span>
        <button class="btn small" type="submit" name="op" value="hide-items" data-mm-needs>${icon("eye")} Hide selected</button>
        <button class="btn small" type="submit" name="op" value="unhide-items" data-mm-needs>Unhide selected</button>
        <button class="btn danger small" type="submit" name="op" value="delete-items" data-mm-needs>${icon("trash")} Delete selected…</button>
      </div>
      ${
        filtered && nSel
          ? `<div class="mm-bar" role="group" aria-label="Act on everything the filter shows">
        <span class="small">All ${esc(plural(d.facts_total, "fact"))} and ${esc(plural(d.chunks_total, "chunk"))} the filter matches:</span>
        <button class="btn small" type="submit" name="op" value="hide-filtered">Hide all filtered</button>
        <button class="btn small" type="submit" name="op" value="unhide-filtered">Unhide all filtered</button>
        <button class="btn danger small" type="submit" name="op" value="delete-filtered">Delete all filtered…</button>
      </div>`
          : ""
      }`
    : "";
  const body = `
    ${act ? `<form method="post" action="${esc(mmHref(uuid) + "/apply")}" id="mm-form" data-mm-form>
      ${hidden(csrf)}${filterFields(f)}` : `<div id="mm-form">`}
      ${bar}
      <h3 class="mm-h">Facts <span class="muted small">${esc(d.facts_total)}${d.facts_total > (d.facts || []).length ? `, the newest ${esc((d.facts || []).length)} shown` : ""}</span></h3>
      ${
        factRows
          ? `<div class="cc-scroll"><table class="rows mm-facts"><thead><tr>${
              act ? `<th><input type="checkbox" data-mm-all="f" aria-label="Select every fact shown"></th>` : ""
            }<th>#</th><th>Topic</th><th>Fact</th><th>Kind</th><th>When</th><th>Status</th></tr></thead><tbody>${factRows}</tbody></table></div>`
          : `<p class="muted">${f.show === "chunks" ? "Facts are not shown." : "No facts match."}</p>`
      }
      <h3 class="mm-h">Conversation chunks <span class="muted small">${esc(d.chunks_total)}${
    pages > 1 ? ` · page ${esc(d.page)} of ${esc(pages)}` : ""
  }</span>${act && chunkRows ? ` <label class="check small mm-allc"><input type="checkbox" data-mm-all="c"> select all on this page</label>` : ""}</h3>
      ${chunkRows ? `<ul class="mm-chunks">${chunkRows}</ul>` : `<p class="muted">${f.show === "facts" || f.topic ? "Chunks are not shown." : "No chunks match."}</p>`}
    ${act ? "</form>" : "</div>"}
    ${pager(mmHref(uuid), filterParams, d.page, pages)}`;
  const whole = act
    ? card(
        "Whole session",
        `<p class="muted small">Hide keeps everything but takes it out of search, the injected memory, subagents' memory,
          <span class="mono">memory_session</span> and the graph; Unhide brings it back. Delete is permanent: facts, chunks and
          their embeddings go, and the session is put on an exclusion list so a re-scan never indexes it again.</p>
        <div class="mm-bar">
          ${
            meta.live
              ? `<span class="small muted">Live sessions cannot be hidden or deleted as a whole.</span>`
              : `<form method="post" action="${esc(mmHref(uuid) + "/apply")}" class="inline"
              data-confirm="Hide everything this session left in memory (${esc(meta.facts || 0)} facts, ${esc(meta.chunks || 0)} chunks)? It can be unhidden.">
              ${hidden(csrf)}<input type="hidden" name="op" value="hide-session">
              <button class="btn small" type="submit">${icon("eye")} Hide whole session</button></form>`
          }
          <form method="post" action="${esc(mmHref(uuid) + "/apply")}" class="inline">
            ${hidden(csrf)}<input type="hidden" name="op" value="unhide-session">
            <button class="btn small" type="submit">Unhide whole session</button></form>
          ${
            meta.live
              ? ""
              : `<form method="post" action="${esc(mmHref(uuid) + "/delete")}" class="inline">
              ${hidden(csrf)}<button class="btn danger small" type="submit">${icon("trash")} Delete session…</button></form>`
          }
        </div>
        <p class="muted small">${BACKUP_NOTE}</p>`,
        { icon: "trash", id: "mm-whole" }
      )
    : "";
  return page(
    meta.name,
    `    ${flashes({ msg: flash, err })}
    ${manage && !ready ? notReady(d) : ""}
    ${liveNote}${exNote}
    ${summary}
    ${card("Memory from this session", filterForm + body, { icon: "memory", id: "mm-items",
      actions: `<a class="btn small" href="/claude/memory?view=sessions">${icon("chevron")} All sessions</a>` })}
    ${whole}`,
    {
      user,
      csrf,
      active: "memory",
      pattern: "c",
      crumbs,
      assets: ["memmanage.js"],
      subtitle: `${esc(meta.origin || "Session")} ${meta.live ? `<span class="pill warn">live</span>` : ""}`,
    }
  );
};

/** Bulk delete: the counts, before anything happens. Re-posts the same selection with them. */
exports.mmConfirmDelete = ({ csrf, user, uuid, preview, body }) => {
  const p = preview || {};
  const meta = p.session || { name: "Session " + String(uuid).slice(0, 8) };
  const keep = Object.entries(body || {})
    .filter(([k]) => k === "op" || k === "f" || k === "c" || k.startsWith("f_"))
    .flatMap(([k, v]) => [].concat(v).map((x) => `<input type="hidden" name="${esc(k)}" value="${esc(x)}">`))
    .join("");
  const nothing = !p.facts && !p.chunks;
  return page(
    "Delete memory permanently?",
    `${card(
      meta.name,
      `${meta.live ? `<div class="alert warn">${icon("alert")}<div><strong>This session is live</strong> — ${esc(meta.live_reason || "")}.
        Make sure this is not memory the running session still needs.</div></div>` : ""}
      ${
        nothing
          ? `<p>Nothing is selected any more.</p>`
          : `<p>This deletes <strong>${esc(plural(p.facts || 0, "fact"))}</strong> (${esc(p.facts_active || 0)} active, ${esc(
              p.facts_hidden || 0
            )} hidden, ${esc(p.facts_superseded || 0)} superseded) and <strong>${esc(plural(p.chunks || 0, "chunk"))}</strong>
            (${esc(p.chunks_active || 0)} visible, ${esc(p.chunks_hidden || 0)} hidden) from memory, with their embeddings.
            It cannot be undone. Deleted chunks are remembered by fingerprint so the transcript is never re-indexed into them;
            an older version of a deleted fact is hidden rather than brought back.</p>`
      }
      <p class="muted small">${BACKUP_NOTE}</p>
      <form method="post" action="${esc(mmHref(uuid) + "/apply")}" class="mm-bar">
        ${hidden(csrf)}${keep}
        <input type="hidden" name="confirmed" value="1">
        <input type="hidden" name="expect_facts" value="${esc(p.facts || 0)}">
        <input type="hidden" name="expect_chunks" value="${esc(p.chunks || 0)}">
        ${nothing ? "" : `<button class="btn danger" type="submit">${icon("trash")} Delete ${esc(plural((p.facts || 0) + (p.chunks || 0), "item"))}</button>`}
        <a class="btn" href="${esc(mmHref(uuid))}">Cancel</a>
      </form>`,
      { icon: "trash", id: "mm-confirm" }
    )}`,
    { user, csrf, active: "memory", pattern: "c", crumbs: memCrumbs("Delete") }
  );
};

/** Whole-session delete: the counts, the name typed back, and the transcript question. */
exports.mmConfirmSession = ({ csrf, user, uuid, preview, err }) => {
  const p = preview || {};
  const meta = p.session || { name: "Session " + String(uuid).slice(0, 8) };
  const files = Number(meta.transcripts_writable || 0);
  const ro = Number(meta.transcripts || 0) - files;
  return page(
    "Delete this session's memory?",
    `${flashes({ err })}
    ${card(
      meta.name,
      `<p>This permanently deletes everything <strong>${esc(meta.name)}</strong> left in memory:
        <strong>${esc(plural(p.facts || 0, "fact"))}</strong> and <strong>${esc(plural(p.chunks || 0, "chunk"))}</strong>, their embeddings,
        and its indexing state. Older versions of these facts held by other sessions are hidden, not brought back.</p>
      <p>So that a re-scan does not quietly index it again, the session is added to an <strong>exclusion list</strong>
        (it can be lifted later from the session's page). Its transcript on disk is <em>not</em> touched unless you tick the box below.</p>
      <p class="muted small">${BACKUP_NOTE}</p>
      <form method="post" action="${esc(mmHref(uuid) + "/delete")}">
        ${hidden(csrf)}<input type="hidden" name="step" value="confirm">
        <label class="check"><input type="checkbox" name="delete_files" value="1"${files ? "" : " disabled"}>
          Also delete the transcript file${files === 1 ? "" : "s"} (${esc(files)} on this server${
        ro > 0 ? `; ${esc(ro)} read-only archive cop${ro === 1 ? "y is" : "ies are"} always kept` : ""
      }). The conversation itself is then gone from the Sessions page too.</label>
        <label>Type the session's name to confirm: <span class="mono">${esc(meta.name)}</span>
          <input name="confirm" required autocomplete="off" spellcheck="false" maxlength="200" data-mm-typed="${esc(meta.name)}"></label>
        <div class="mm-bar">
          <button class="btn danger" type="submit">${icon("trash")} Delete permanently</button>
          <a class="btn" href="${esc(mmHref(uuid))}">Cancel</a>
        </div>
      </form>`,
      { icon: "trash", id: "mm-delete-session" }
    )}`,
    { user, csrf, active: "memory", pattern: "c", crumbs: memCrumbs("Delete session"), assets: ["memmanage.js"] }
  );
};

/* --------------------------------------------------------------- sessions - */

function statusPills(r) {
  const out = [];
  if (r.running) out.push(pill("ok", "running"));
  if (r.archived) out.push(pill("neutral", "archived"));
  if (r.released) out.push(pill("warn", "deleted in app"));
  if (r.indexed === true) out.push(pill("brand", "indexed"));
  else if (r.indexed === false && r.chunks) out.push(pill("neutral", "indexed (other copy)"));
  else if (r.indexed === false) out.push(pill("neutral", "not indexed"));
  return out.join(" ");
}

/**
 * Sessions ▸ All / Archived: every Claude Code transcript on this machine
 * (the Live tab is exports.live). An archived row can be restored in place.
 */
exports.sessions = ({ csrf, user, data, filters, flash, err, counts }) => {
  const d = data || { rows: [], total: 0, page: 1, per_page: 25, homes: [], projects: [] };
  const pages = Math.max(1, Math.ceil((d.total || 0) / (d.per_page || 25)));
  const tab = filters.archived ? "archived" : "all";
  const params = { tab, home: filters.home, project: filters.project, q: filters.q };
  const restorer = filters.archived && can(user, "claude.sessions.manage");
  return page(
    "Sessions",
    `${flashes({ msg: flash, err })}
    ${card(
      null,
      `${tabs(tab, user, counts)}
      <form method="get" action="/claude/sessions" class="cc-filters"><input type="hidden" name="tab" value="${tab}">
        <label>Home <select name="home"><option value="">All homes</option>${(d.homes || [])
          .map((h) => `<option value="${esc(h.key)}"${h.key === filters.home ? " selected" : ""}>${esc(h.label)}</option>`)
          .join("")}</select></label>
        <label>Project <select name="project"><option value="">All projects</option>${(d.projects || [])
          .map(
            ([slug, n]) =>
              `<option value="${esc(slug)}"${slug === filters.project ? " selected" : ""}>${esc(
                snippet(slug, 48)
              )} (${esc(n)})</option>`
          )
          .join("")}</select></label>
        <label>Title contains <input name="q" value="${esc(filters.q || "")}" maxlength="200"></label>
        <button class="btn small" type="submit">Filter</button>
        <a class="btn small" href="/claude/sessions?tab=${tab}">Reset</a>
      </form>
      ${
        d.index_available === false
          ? `<p class="muted small">The memory database did not answer, so "indexed" is unknown.</p>`
          : ""
      }
      ${
        d.rows && d.rows.length
          ? `<div class="cc-scroll"><table class="rows">
            <thead><tr><th>Session</th><th>Home</th><th>Project / cwd</th><th>Started</th><th>Last activity</th>
              <th class="right">Size</th><th class="right">Turns</th><th class="right">Subagents</th><th>Status</th></tr></thead>
            <tbody>${d.rows
              .map(
                (r) => `<tr>
                <td class="cc-title-cell">
                  <a class="row-title" href="${esc(sessionHref(r.home, r.uuid, { archived: r.archived }))}">${esc(
                  r.title || "(untitled)"
                )}</a>
                  ${
                    r.first && r.title_src === "custom"
                      ? `<div class="muted small">${esc(snippet(r.first, 110))}</div>`
                      : ""
                  }
                  <div class="muted small mono">${esc(r.uuid)}</div>
                </td>
                <td class="small">${esc(r.home_label)}</td>
                <td class="small"><span class="mono">${esc(snippet(r.project, 40))}</span>
                  ${r.cwd ? `<div class="muted small mono">${esc(snippet(r.cwd, 50))}</div>` : ""}</td>
                <td class="small nowrap">${when(r.started)}</td>
                <td class="small nowrap">${when(r.modified)}</td>
                <td class="mono small right">${bytes(r.bytes)}</td>
                <td class="mono small right">${esc(r.turns == null ? "—" : r.turns)}</td>
                <td class="mono small right">${esc(r.subagents || 0)}</td>
                <td>${statusPills(r)}${
                  restorer && r.archived
                    ? `<form method="post" action="${esc(sessionHref(r.home, r.uuid) + "/restore")}" class="inline">${hidden(csrf)}<button class="btn small" type="submit">${icon(
                        "reindex",
                        14
                      )} Restore</button></form>`
                    : ""
                }</td>
              </tr>`
              )
              .join("")}</tbody></table></div>
            ${pager("/claude/sessions", params, d.page, pages)}
            <p class="muted small">${esc(d.total)} session${d.total === 1 ? "" : "s"}. "Deleted in app" means the
              desktop app released it; the transcript is still on disk. The Windows archive is read-only.</p>`
          : empty("logs", "No sessions", filters.archived ? "Nothing has been archived from here." : "No transcripts match.")
      }`,
      { className: "sess-card" }
    )}`,
    {
      user,
      csrf,
      active: "sessions",
      pattern: "c",
      crumbs: [["Agents & sessions", "/agents/dashboard"], ["Sessions", null]],
      subtitle: "Every Claude Code session on this machine. What was “Running” is the Live tab.",
    }
  );
};

function toolRow(t) {
  return `<div class="tool-row">
    <span class="tool-name">${esc(t.name)}</span>
    <span class="tool-arg" title="${esc(t.arg)}">${esc(t.arg)}</span>
    <span class="cc-size${t.error ? " warn-text" : ""}">${
      t.size == null ? "no result" : bytes(t.size)
    }${t.error ? " · error" : ""}</span>
  </div>`;
}

function exchangeHtml(ex, n) {
  const label = { prompt: "", summary: "compaction summary", notification: "notification", preamble: "" }[ex.kind] || "";
  const parts = [];
  let tools = [];
  const flush = () => {
    if (tools.length) parts.push(`<div class="activity-body cc-tools">${tools.map(toolRow).join("")}</div>`);
    tools = [];
  };
  for (const it of ex.items || []) {
    if (it.t === "tool") {
      tools.push(it);
      continue;
    }
    flush();
    if (it.t === "text") {
      parts.push(`<div class="msg assistant"><div class="bubble cc-text">${esc(it.text)}${
        it.truncated ? `<span class="muted"> … (truncated)</span>` : ""
      }</div></div>`);
    } else if (it.t === "note") {
      parts.push(`<div class="msg system"><div class="note">${esc(it.text)}</div></div>`);
    }
  }
  flush();
  return `<div class="cc-ex" id="ex-${esc(n)}">
    <div class="msg-meta cc-ex-meta">#${esc(n)} · ${esc(stamp(ex.ts))}${label ? " · " + esc(label) : ""}${
    ex.model ? " · " + esc(ex.model) : ""
  }${ex.thinking ? " · thought " + esc(ex.thinking) + "×" : ""}</div>
    ${
      ex.kind === "preamble"
        ? ""
        : `<div class="msg user${ex.kind === "summary" ? " cc-summary" : ""}"><div class="bubble">${esc(ex.user)}${
            ex.user_truncated ? " … (truncated)" : ""
          }</div></div>`
    }
    ${parts.join("")}
  </div>`;
}

exports.session = ({ csrf, user, s, flash, err }) => {
  const manage = can(user, "claude.sessions.manage") && s.writable;
  const base = sessionHref(s.home, s.uuid);
  const params = { agent: s.agent, archived: s.archived };
  const first = (s.page - 1) * s.per_page + 1;
  const title = s.title || "(untitled session)";
  return page(
    title,
    `${flashes({ msg: flash, err })}
    <div class="grid cols-2">
      ${card(
        "Session",
        `<table class="kv">
          <tr><td>Home</td><td>${esc(s.home_label)}</td></tr>
          <tr><td>Project</td><td class="mono small">${esc(s.project)}</td></tr>
          <tr><td>Working directory</td><td class="mono small">${esc(s.cwd || "—")}</td></tr>
          <tr><td>Started</td><td>${esc(stamp(s.started))}</td></tr>
          <tr><td>Last activity</td><td>${esc(stamp(s.modified))} (${when(s.modified)})</td></tr>
          <tr><td>Size</td><td>${bytes(s.bytes)} · ${esc(s.turns)} turns · ${esc(s.records)} records</td></tr>
          <tr><td>Model</td><td class="mono small">${esc(s.model || "—")}</td></tr>
          <tr><td>Entrypoint</td><td class="mono small">${esc(s.entrypoint || "—")}</td></tr>
          <tr><td>Status</td><td>${statusPills(s) || "—"}${
          s.live ? ` <a class="small" href="/claude/running">pid ${esc(s.live.pid)} · ${esc(s.live.status || "")}</a>` : ""
        }</td></tr>
          <tr><td>Memory</td><td><a href="/claude/memory/session/${esc(s.uuid)}">Chunks and facts from this session</a></td></tr>
        </table>
        ${
          s.resume
            ? `<p class="muted small mt-12">Resume it from a root shell:</p><pre class="cc-cmd">${esc(s.resume)}</pre>`
            : ""
        }`,
        { icon: "info", actions: `<a class="btn small" href="/claude/sessions">${icon("chevron")} All sessions</a>` }
      )}
      ${card(
        "Manage",
        manage
          ? s.archived
            ? `<p class="muted small">Archived from the panel. Restoring moves it back to its project folder.</p>
              <form method="post" action="${esc(base)}/restore" data-confirm="Restore this session to its project folder?">
                ${hidden(csrf)}<button class="btn primary small" type="submit">${icon("reindex")} Restore</button>
              </form>`
            : `${
                s.running
                  ? `<div class="alert warn">${icon("alert")}<div>This session is running. Rename and archive
                      are refused until it stops.</div></div>`
                  : ""
              }
              <form method="post" action="${esc(base)}/rename" class="row-form">
                ${hidden(csrf)}
                <input name="title" value="${esc(s.title_src === "custom" ? s.title : "")}" maxlength="120"
                       placeholder="New title" required aria-label="New title">
                <button class="btn small" type="submit"${s.running ? " disabled" : ""}>${icon("edit")} Rename</button>
              </form>
              <p class="muted small">Written the way Claude Code writes it: a <span class="mono">custom-title</span>
                record in the transcript and <span class="mono">custom-title.json</span> beside it.</p>
              <form method="post" action="${esc(base)}/archive" class="mt-12"
                    data-confirm="Archive this session? Its transcript moves to .claude/archive/dashboard-archived and disappears from the app's session list. Nothing is deleted and it can be restored.">
                ${hidden(csrf)}<button class="btn danger small" type="submit"${s.running ? " disabled" : ""}>${icon(
                "archive"
              )} Archive</button>
              </form>
              <p class="muted small">Archiving moves files, never deletes them. Memory already indexed from
                this session stays in the memory database.</p>`
          : `<p class="muted small">${
              s.writable ? "Your role can read sessions but not change them." : esc(s.home_label) + " is read-only."
            }</p>`,
        { icon: "settings" }
      )}
    </div>
    ${
      s.subagents && s.subagents.length
        ? card(
            "Subagents",
            `<table class="rows">
              <thead><tr><th>Type</th><th>Description</th><th>Status</th><th class="right">Size</th><th>Last write</th><th></th></tr></thead>
              <tbody>${s.subagents
                .map(
                  (a) => `<tr${a.id === s.agent ? ' class="cc-on"' : ""}>
                  <td class="small strong">${esc(a.type || "agent")}</td>
                  <td class="small">${esc(a.description || "—")}</td>
                  <td>${pill(a.status === "done" ? "ok" : a.status === "running" ? "warn" : "neutral", a.status)}</td>
                  <td class="mono small right">${bytes(a.bytes)}</td>
                  <td class="small nowrap">${when(a.modified)}</td>
                  <td class="right"><a class="btn small" href="${esc(
                    sessionHref(s.home, s.uuid, { agent: a.id, archived: s.archived })
                  )}">Read</a></td>
                </tr>`
                )
                .join("")}</tbody></table>`,
            { icon: "agents" }
          )
        : ""
    }
    ${card(
      s.agent
        ? `Subagent: ${(s.agent_meta && s.agent_meta.description) || s.agent}`
        : "Conversation",
      `${
        s.agent
          ? `<p class="small"><a href="${esc(sessionHref(s.home, s.uuid, { archived: s.archived }))}">${icon(
              "chevron"
            )} Back to the main conversation</a></p>`
          : ""
      }
      <p class="muted small">${esc(s.exchanges_total)} exchanges · showing ${esc(first)}–${esc(
        first + (s.exchanges || []).length - 1
      )}. Tool calls are folded to one line with the size of what they returned; outputs are never shown.</p>
      ${pager(base, params, s.page, s.pages)}
      ${(s.exchanges || []).length ? s.exchanges.map((ex, i) => exchangeHtml(ex, first + i)).join("") : `<p class="muted">Empty transcript.</p>`}
      ${pager(base, params, s.page, s.pages)}`,
      { icon: "logs" }
    )}`,
    {
      user,
      csrf,
      active: "sessions",
      pattern: "b",
      crumbs: [["Agents & sessions", "/agents/dashboard"], ["Sessions", "/claude/sessions?tab=" + (s.archived ? "archived" : "all")], [title, null]],
      subtitle: `${esc(s.home_label)} · <span class="mono">${esc(s.uuid)}</span>`,
    }
  );
};

/* ---------------------------------------------------------------- running - */

const ENTRY = { "claude-desktop": "desktop", cli: "CLI", "sdk-cli": "SDK", "sdk-py": "SDK", "sdk-ts": "SDK" };

function entryLabel(s) {
  if (s.home === "console") return "console";
  if (s.home === "agents") return "agent";
  return ENTRY[s.entrypoint] || s.entrypoint || "—";
}

function sessionsRows(csrf, user, sessions) {
  if (!sessions.length) return `<tr><td colspan="10" class="muted">No Claude Code sessions are running.</td></tr>`;
  const stopper = can(user, "claude.running.stop");
  return sessions
    .map((s) => {
      const h = s.hints || {};
      const label = s.name || (s.session_id ? String(s.session_id).slice(0, 8) : "pid " + s.pid);
      let control = "";
      if (stopper && s.alive && s.claude) {
        if (s.force_available) {
          control = `<form method="post" action="/claude/running/stop" class="inline"
              data-confirm="Force stop pid ${esc(s.pid)} (${esc(label)})? The interrupt did not end it; this sends SIGTERM.">
              ${hidden(csrf)}<input type="hidden" name="pid" value="${esc(s.pid)}"><input type="hidden" name="force" value="1">
              <button class="btn danger small" type="submit">${icon("stop")} Force stop</button></form>`;
        } else if (s.stop_requested) {
          control = `<span class="muted small">interrupt sent ${when(s.stop_requested * 1000)}</span>`;
        } else {
          control = `<form method="post" action="/claude/running/stop" class="inline"
              data-confirm="Stop Claude Code session '${esc(label)}' (pid ${esc(s.pid)})? This sends an interrupt (SIGINT), like pressing Ctrl-C. Work in progress in that session stops.">
              ${hidden(csrf)}<input type="hidden" name="pid" value="${esc(s.pid)}">
              <button class="btn danger small" type="submit">${icon("stop")} Stop</button></form>`;
        }
      }
      return `<tr>
        <td>${
          s.session_id
            ? `<a class="row-title" href="${esc(sessionHref(s.home, s.session_id))}">${esc(label)}</a>`
            : `<span class="row-title">${esc(label)}</span>`
        }<div class="muted small">${esc(s.home_label)}</div></td>
        <td class="small">${esc(entryLabel(s))}</td>
        <td>${
          s.alive
            ? pill(s.status === "busy" ? "warn" : "ok", s.status || "alive")
            : pill("neutral", "not running")
        }</td>
        <td class="mono small">${esc(h.model || "—")}${
        h.permission_mode ? `<div class="muted small">${esc(h.permission_mode)}</div>` : ""
      }</td>
        <td class="mono small">${esc(snippet(s.cwd || "—", 40))}</td>
        <td class="mono small">${esc(s.pid)}</td>
        <td class="small nowrap">${s.uptime != null ? esc(duration(s.uptime)) : "—"}</td>
        <td class="mono small right">${s.cpu != null ? esc(s.cpu) + "%" : "—"}</td>
        <td class="small nowrap">${when(s.status_updated_at || s.updated_at)}</td>
        <td class="right">${control}</td>
      </tr>`;
    })
    .join("");
}

function subagentRows(list) {
  if (!list.length) return `<tr><td colspan="5" class="muted">No subagent is working right now.</td></tr>`;
  return list
    .map(
      (a) => `<tr>
      <td class="small strong">${esc(a.type || "agent")}</td>
      <td class="small">${esc(a.description || "—")}</td>
      <td class="small"><a href="${esc(sessionHref(a.home, a.session, { agent: a.id }))}">${esc(
        String(a.session).slice(0, 8)
      )}</a></td>
      <td class="mono small right">${bytes(a.bytes)}</td>
      <td class="small nowrap">${when(a.modified)}</td>
    </tr>`
    )
    .join("");
}

function processRows(list, emptyText, withCwd) {
  if (!list.length) return `<tr><td colspan="6" class="muted">${esc(emptyText)}</td></tr>`;
  return list
    .map(
      (p) => `<tr>
      <td class="mono small">${esc(p.binary || p.script || "?")}${
        p.flags && p.flags.length ? " " + esc(p.flags.join(" ")) : ""
      }</td>
      <td class="mono small">${esc(p.pid)}</td>
      <td class="small">${esc(p.user || "—")}</td>
      <td class="mono small">${withCwd ? esc(snippet(p.cwd || "—", 40)) : esc(p.parent || "")}</td>
      <td class="small nowrap">${p.uptime != null ? esc(duration(p.uptime)) : "—"}</td>
      <td class="mono small right">${p.cpu != null ? esc(p.cpu) + "%" : "—"}</td>
    </tr>`
    )
    .join("");
}

function unitRows(units) {
  if (!units.length) return `<tr><td colspan="4" class="muted">No units.</td></tr>`;
  return units
    .map(
      (u) => `<tr>
      <td class="mono small">${esc(u.unit)}</td>
      <td>${unitPill(u)}</td>
      <td class="mono small">${u.memory != null ? bytes(u.memory) : "—"}</td>
      <td class="small">${esc(u.since || u.exited || "—")}</td>
    </tr>`
    )
    .join("");
}

function hookRows(hooks) {
  if (!hooks.length) return `<tr><td colspan="3" class="muted">No subagent hook events logged.</td></tr>`;
  return hooks
    .map(
      (h) => `<tr><td class="small nowrap">${esc(String(h.ts || "").replace("T", " ").slice(5, 19))}</td>
      <td class="small strong">${esc(h.event)}</td>
      <td class="mono small">${esc((h.detail && h.detail.agent_type) || "")}</td></tr>`
    )
    .join("");
}

/** The parts of the Running page that refresh in place, keyed by section. */
function runningSections(csrf, user, r) {
  const sessions = r.sessions || [];
  const alive = sessions.filter((s) => s.alive);
  const jobs = (r.jobs && r.jobs.processes) || [];
  const jobUnits = (r.jobs && r.jobs.units) || [];
  return {
    stats: `${stat(alive.length, "live sessions", "activity")}
      ${stat((r.subagents || []).length, "subagents working", "agents")}
      ${stat((r.others || []).length, "other claude processes", "cpu")}
      ${stat(jobs.length, "memory jobs", "memory")}`,
    sessions: sessionsRows(csrf, user, sessions),
    subagents: subagentRows(r.subagents || []),
    others: processRows(r.others || [], "None — every claude process belongs to a session above.", true),
    jobs:
      processRows(jobs, "No ingest or fact-extraction job is running.", false) +
      jobUnits
        .map((u) => `<tr><td class="mono small">${esc(u.unit)}</td><td colspan="5">${unitPill(u)} <span class="muted small">${esc(u.exited || u.since || "")}</span></td></tr>`)
        .join(""),
    units: unitRows(r.units || []),
    services: processRows(r.services || [], "None.", false),
    hooks: hookRows(r.subagent_hooks || []),
  };
}
exports.runningSections = runningSections;

function fmtTok(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
}

/**
 * The sessions JOYA AI knows, one row each: who started it (JOYA AI itself,
 * yours, hired, kept), its state, folder and tokens today (of its daily cap),
 * and what may be done to it -- Keep / Stop keeping / Retire… for a hired
 * one, Stop… for one of yours, Resume for one paused at its cap, and its
 * transcript. Shared by Sessions ▸ Live and Agents & sessions ▸ Overview.
 *
 * @param team  { sessions: [supervisor sessions], caps: {key -> token-caps row}, error }
 * @param r     the Running data (priv.ccRunning), to find a session's pid and home
 */
function teamTable(csrf, user, team, r, opts = {}) {
  const t = team || {};
  const caps = t.caps || {};
  const running = (r && r.sessions) || [];
  const byId = new Map(running.filter((x) => x.session_id).map((x) => [x.session_id, x]));
  const rows = (t.sessions || []).filter((x) => opts.withSelf || !x.self);
  if (t.error) return `<div class="alert bad">${icon("alert")}<div>${esc(t.error)}</div></div>`;
  if (!rows.length) return empty("activity", "No live sessions", "Nothing is running round JOYA AI right now.");
  const useAi = can(user, "joyaai.use");
  const stopper = can(user, "claude.running.stop");
  const kindTag = (x) =>
    x.self
      ? `<span class="cc-tag ai">JOYA AI</span>`
      : x.hire
      ? x.hire.kept
        ? `<span class="cc-tag ok">kept</span>`
        : `<span class="cc-tag mute">hired</span>`
      : `<span class="pill neutral">yours</span>`;
  return `<table class="rows stack aligned"><thead><tr><th>Session</th><th>Who</th><th>Status</th><th>Folder</th><th class="right">Tokens today</th><th></th></tr></thead><tbody>${rows
    .map((x) => {
      const key = x.self ? "<self>" : x.hire ? x.hire.slug : x.session_id;
      const cap = caps[key] || null;
      const rr = x.session_id ? byId.get(x.session_id) : null;
      const name = x.name || (x.session_id ? String(x.session_id).slice(0, 8) : "pid " + x.pid);
      const paused = !!(cap && cap.paused);
      const status = paused
        ? `<span class="pill bad">paused</span>`
        : /busy|working|running/.test(String(x.status || ""))
        ? `<span class="pill work">working</span>`
        : `<span class="pill neutral">${esc(x.status && x.status !== "idle" ? x.status : "idle")}</span>`;
      const tk = cap ? cap.today && cap.today.total : x.tokens_today && x.tokens_today.total;
      const acts = [];
      if (rr && rr.home) acts.push(`<a class="btn small" href="${esc(sessionHref(rr.home, x.session_id))}">Transcript</a>`);
      if (useAi && x.hire && !x.self) {
        const slug = esc(x.hire.slug);
        acts.push(
          x.hire.kept
            ? `<form method="post" action="/claude/sessions/live/${slug}/keep" class="inline">${hidden(csrf)}<input type="hidden" name="kept" value="0"><button class="btn small" type="submit">Stop keeping</button></form>`
            : `<form method="post" action="/claude/sessions/live/${slug}/keep" class="inline">${hidden(csrf)}<input type="hidden" name="kept" value="1"><button class="btn small" type="submit">Keep</button></form>
               <form method="post" action="/claude/sessions/live/${slug}/retire" class="inline" data-step-up data-confirm-dlg="Retire “${esc(name)}”?" data-confirm-body="It ends gracefully and its sphere dissolves; its transcript is kept." data-confirm-yes="Retire" data-confirm-no="Keep">${hidden(
                 csrf
               )}<button class="btn small danger" type="submit">Retire…</button></form>`
        );
      }
      if (!x.hire && !x.self && stopper && rr && rr.alive && rr.claude && !rr.stop_requested)
        acts.push(
          `<form method="post" action="/claude/running/stop" class="inline" data-confirm-dlg="Stop “${esc(name)}”?" data-confirm-body="This sends an interrupt (SIGINT) to pid ${esc(
            rr.pid
          )}, like pressing Ctrl-C. Work in progress in that session stops." data-confirm-yes="Stop">${hidden(csrf)}<input type="hidden" name="pid" value="${esc(rr.pid)}"><button class="btn small danger" type="submit">Stop…</button></form>`
        );
      if (paused && useAi)
        acts.push(
          `<form method="post" action="/claude/sessions/live/resume" class="inline" data-step-up>${hidden(csrf)}<input type="hidden" name="key" value="${esc(key)}"><button class="btn small primary" type="submit">Resume</button></form>`
        );
      return `<tr><td class="first" data-h="Session"><div class="l1"><b class="ink">${esc(name)}</b></div>${
        x.hire && x.hire.purpose ? `<div class="l2">JOYA AI hired it: ${esc(snippet(x.hire.purpose, 140))}</div>` : ""
      }</td>
        <td data-h="Who"><div class="l1">${kindTag(x)}</div></td>
        <td data-h="Status"><div class="l1">${status}${rr && rr.uptime != null ? `<span class="muted-num">${esc(duration(rr.uptime))}</span>` : ""}</div></td>
        <td data-h="Folder"><div class="l1 mono small">${esc(snippet(x.cwd || "—", 40))}</div></td>
        <td class="right" data-h="Tokens"><div class="l1 mono small">${tk != null ? fmtTok(tk) : "—"}${cap && cap.cap ? " / " + fmtTok(cap.cap) : ""}</div></td>
        <td class="right nolabel" data-h=""><div class="l1">${acts.join("")}</div></td></tr>`;
    })
    .join("")}</tbody></table>`;
}
exports.teamTable = teamTable;

/**
 * Sessions ▸ Live: JOYA AI's view of the live sessions (above), then what the
 * Running page showed -- every claude process, subagents, memory jobs --
 * refreshed in place every ten seconds (public/app.js, /api/claude/running).
 */
exports.live = ({ csrf, user, r, team, flash, err, counts }) => {
  const data = r || {};
  const sec = runningSections(csrf, user, data);
  const table = (key, head) =>
    `<div class="cc-scroll"><table class="rows"><thead><tr>${head
      .map((h) => `<th${h.startsWith(">") ? ' class="right"' : ""}>${esc(h.replace(/^>/, ""))}</th>`)
      .join("")}</tr></thead><tbody data-cc-section="${key}">${sec[key]}</tbody></table></div>`;
  const panel = (title, iconName, inner, cls) =>
    `<section class="card${cls ? " " + cls : ""}"><div class="card-head"><h2>${icon(iconName)}${esc(title)}</h2></div>
      <div class="panel-body">${inner}</div></section>`;
  return page(
    "Sessions",
    `${flashes({ msg: flash, err })}
    ${card(
      null,
      `${tabs("live", user, counts)}${
        team
          ? teamTable(csrf, user, team, data)
          : `<p class="muted">JOYA AI's view of the sessions (who started each, tokens, Keep and Retire) needs the Command JOYA AI permission.</p>`
      }`,
      { className: "sess-card", id: "s-live" }
    )}
    <div data-cc-running class="cc-live">
      <div class="stats4" data-cc-section="stats">${sec.stats}</div>
      <p class="muted small cc-line">Processes updated <span data-cc-updated>${esc(stamp(data.ts))}</span> · refreshes every
        10 seconds while this tab is visible. <a href="/claude/sessions?tab=live">Refresh now</a></p>
      <div class="cc-board three">
        ${panel(
          "Claude Code processes",
          "activity",
          `${table("sessions", ["Session", "Entrypoint", "Status", "Model", "cwd", "pid", "Uptime", ">CPU", "Updated", ""])}
          <p class="muted small">Stop sends an interrupt (SIGINT), the same as Ctrl-C, and only to a pid that
            is both registered in a Claude home's <span class="mono">sessions/</span> folder and running the
            claude binary. If it is still alive ten seconds later, Force stop (SIGTERM) appears.</p>`,
          "hud span2"
        )}
        ${panel("Subagents working", "agents", table("subagents", ["Type", "Description", "Session", ">Size", "Last write"]))}
        ${panel(
          "Other claude processes",
          "cpu",
          `${table("others", ["Binary", "pid", "User", "cwd", "Uptime", ">CPU"])}
          <p class="muted small">Headless runs — fact extraction, agents answering a message — that have no
            sessions entry and so cannot be stopped from here.</p>
          <h3 class="sub-h">Supporting processes</h3>
          ${table("services", ["Process", "pid", "User", "", "Uptime", ">CPU"])}`
        )}
        ${panel("Recent subagent hooks", "clock", table("hooks", ["When", "Event", "Type"]))}
        ${panel(
          "Memory jobs",
          "memory",
          `${table("jobs", ["Job", "pid", "User", "Parent", "Uptime", ">CPU"])}
          <h3 class="sub-h">Agent and memory units</h3>
          ${table("units", ["Unit", "State", "Memory", "Since"])}`
        )}
      </div>
    </div>`,
    {
      user,
      csrf,
      active: "sessions",
      pattern: "c",
      crumbs: [["Agents & sessions", "/agents/dashboard"], ["Sessions", null]],
      subtitle: "Every Claude Code session on this machine. What was “Running” is the Live tab.",
    }
  );
};
