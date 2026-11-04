"use strict";
/**
 * The memory pages, organised to be read (2026-10-25, "redesign the memory ... make sure it
 * is organized"): what is in memory, sorted by kind and by agent, with search, the latest
 * changes, each note rendered to read, and what links to what. The graph stays as the
 * other view.
 *
 *   agentMemory   /agents/:slug/memory  -- one agent's vault: notes by kind, files by folder
 *   agentNote     /agents/:slug/memory/note?path=  -- one note, read (or edit, for writers)
 *   claudeBrowse  the Browse panel of /claude/memory -- facts by kind, topic and project
 *   factRelated   the side column of a fact: related by meaning, same topic
 *
 * Everything here is escaped or goes through lib/markdown.js, which escapes first.
 */

const { esc, bytes, ago, stamp, icon, flashes, can } = require("./ui");
const md = require("./markdown");
const { graphPanel, viewSwitch } = require("./views-memgraph");

/* ------------------------------------------------------------- vault --- */

/** Where a note belongs on the page: [group key, label, order]. */
const NOTE_GROUPS = {
  start: ["Start here", 0],
  people: ["People", 1],
  project: ["Projects", 2],
  decision: ["Decisions", 3],
  preference: ["Preferences", 4],
  trap: ["Lessons learned", 5],
  fact: ["Facts", 6],
  goal: ["Goals", 7],
  figure: ["Figures", 8],
  topic: ["Topics and research", 9],
  document: ["Documents", 10],
  other: ["Other notes", 11],
  guide: ["Folder guides", 12],
  archive: ["Archive", 13],
};
const GROUP_ONE = { start: "Start", people: "Person", project: "Project", decision: "Decision", fact: "Fact", preference: "Preference", goal: "Goal", figure: "Figure", trap: "Lesson", topic: "Topic", document: "Document", other: "Note", guide: "Guide", archive: "Archived" };
const TYPE_TO_GROUP = {
  people: "people",
  project: "project",
  decision: "decision",
  preference: "preference",
  goal: "goal",
  figure: "figure",
  trap: "trap",
  topic: "topic",
  research: "topic",
  report: "topic",
  conversation: "topic",
  call: "topic",
  run: "topic",
  pattern: "topic",
  document: "document",
  output: "document",
  file: "document",
};
const START = { "MEMORY.md": ["Home", "The index: what the agent knows, one line per note."], "CLAUDE.md": ["Instructions", "Who the agent is and how it works."], "WORKLOG.md": ["Work log", "What was done, one dated entry at a time."] };

/** The three start files read as what they are (Home, Instructions, Work log), not as "# MEMORY". */
function startTitles(notes) {
  return (notes || []).map((n) => (START[n.path] ? Object.assign({}, n, { title: START[n.path][0] }) : n));
}

function noteGroup(n) {
  const p = String(n.path || "");
  const parts = p.split("/");
  const base = parts[parts.length - 1].toLowerCase();
  if (parts.length === 1 && START[parts[0]]) return "start";
  if (base === "readme.md" || base === "index.md") return "guide";
  if (parts.some((s) => /^(archive|_archive|superseded)$/i.test(s))) return "archive";
  const g = TYPE_TO_GROUP[n.type];
  if (g) return g;
  if (parts[0] === "memory") return "fact";
  return "other";
}

const FILE_FOLDERS = {
  outbox: ["Sent and made files", "What the agent made and sent (send_file). Final versions at the top, older drafts in outbox/archive/."],
  drawings: ["Drawings", "Pictures the agent drew (SVG and their PNG renders)."],
  chatgpt: ["ChatGPT results", "One folder per task handed to ChatGPT."],
  attachments: ["Received files", "What people sent in chat, by day (attachments/inbox/<date>/)."],
  mail: ["Mail", "The mail ledger and mail records."],
  outputs: ["Outputs", "Finished work, by project."],
  files: ["Files", "Working files, by project."],
  topics: ["Topic folders", "One folder per Telegram topic."],
};

function fileGroup(f) {
  const top = String(f.path || "").split("/")[0];
  if (!String(f.path).includes("/")) return "_root";
  return top;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const noteHref = (slug, p) => `/agents/${encodeURIComponent(slug)}/memory/note?path=${encodeURIComponent(p)}`;
const day = (v) => (v ? `<time datetime="${esc(v)}" title="${esc(stamp(v))}">${esc(String(v).slice(0, 10))}</time>` : "—");
const when = (v) => (v ? `<time datetime="${esc(v)}" title="${esc(stamp(v))}">${esc(ago(v))}</time>` : "—");

/** Wikilink resolution, the way Obsidian and lib/memgraph.js do it: by file name, then title. */
function resolver(notes) {
  const byName = new Map();
  for (const n of notes || []) {
    const base = String(n.path).split("/").pop().replace(/\.md$/i, "").toLowerCase();
    if (!byName.has(base)) byName.set(base, n);
    if (n.title && !byName.has(String(n.title).toLowerCase())) byName.set(String(n.title).toLowerCase(), n);
  }
  const byPath = new Map((notes || []).map((n) => [String(n.path).replace(/\.md$/i, "").toLowerCase(), n]));
  return (target) => {
    // "[[outbox/README\|outbox]]" inside a table leaves the escaping backslash on the target.
    const t = String(target || "").replace(/\\+$/, "").replace(/\.md$/i, "").trim().toLowerCase().replace(/^\.?\//, "");
    if (t.includes("/") && byPath.has(t)) return byPath.get(t);
    return byName.get(t.split("/").pop()) || null;
  };
}

/** Links out of each note and into it: { out: Map(path -> [{target, note}]), back: Map(path -> [note]) }. */
function linkMap(notes) {
  const find = resolver(notes);
  const out = new Map();
  const back = new Map();
  for (const n of notes || []) {
    const list = [];
    for (const t of n.links || []) {
      const to = find(t);
      list.push({ target: t, note: to });
      if (to && to.path !== n.path) {
        if (!back.has(to.path)) back.set(to.path, []);
        if (!back.get(to.path).some((x) => x.path === n.path)) back.get(to.path).push(n);
      }
    }
    out.set(n.path, list);
  }
  return { out, back, find };
}

function noteRow(slug, n, links) {
  const outN = (links.out.get(n.path) || []).filter((l) => l.note).length;
  const inN = (links.back.get(n.path) || []).length;
  const tags = (n.tags || []).slice(0, 4);
  return `<li class="mem-row">
    <a class="mem-title" href="${esc(noteHref(slug, n.path))}">${esc(n.title || n.path)}</a>
    <span class="mem-path mono">${esc(n.path)}</span>
    ${n.snippet ? `<p class="mem-snip">${esc(snip(n.snippet, n.title, 180))}</p>` : ""}
    <span class="mem-meta">${[
      `<span>Changed&nbsp;${when(n.modified)}</span>`,
      outN || inN ? `<span>${icon("link", 13)}${plural(outN, "link")} out · ${inN} in</span>` : "",
      tags.length ? tags.map((t) => `<span class="md-tag">#${esc(t)}</span>`).join(" ") : "",
    ]
      .filter(Boolean)
      .join('<span class="sep" aria-hidden="true">·</span>')}</span>
  </li>`;
}

/** A snippet without the title it usually starts with. */
function snip(text, title, n) {
  let t = String(text || "").trim();
  if (title && t.toLowerCase().startsWith(String(title).toLowerCase())) t = t.slice(String(title).length).trim();
  t = t
    .replace(/^---.*?---\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
}

function fileRow(f) {
  const name = String(f.path).split("/").pop();
  const dir = String(f.path).split("/").slice(0, -1).join("/");
  return `<tr><td><span class="mono mem-fname">${esc(name)}</span>${dir.includes("/") ? `<span class="sub mono">${esc(dir)}/</span>` : ""}</td>
    <td class="num">${esc(bytes(f.bytes))}</td><td class="nowrap">${day(f.modified)}</td></tr>`;
}

function filesSection(groupKey, files, readme, slug) {
  const meta = FILE_FOLDERS[groupKey] || [groupKey === "_root" ? "Loose files at the top of the vault" : groupKey + "/", ""];
  const sorted = files.slice().sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  const archived = sorted.filter((f) => /(^|\/)(archive|_archive|superseded)\//i.test(f.path));
  const live = sorted.filter((f) => !archived.includes(f));
  const head = live.slice(0, 8);
  const rest = live.slice(8);
  const table = (rows) =>
    `<table class="ds-table mem-files"><thead><tr><th scope="col">File</th><th scope="col" class="num">Size</th><th scope="col">Changed</th></tr></thead><tbody>${rows
      .map(fileRow)
      .join("")}</tbody></table>`;
  return `<section class="mem-sec" id="${esc("f-" + groupKey.replace(/[^a-z0-9_-]/gi, ""))}" aria-labelledby="${esc("fh-" + groupKey.replace(/[^a-z0-9_-]/gi, ""))}">
    <div class="mem-sec-head"><h3 id="${esc("fh-" + groupKey.replace(/[^a-z0-9_-]/gi, ""))}">${esc(meta[0])} <span class="mem-count">${files.length}</span></h3>
      ${groupKey !== "_root" ? `<span class="mono muted small">${esc(groupKey)}/</span>` : ""}</div>
    ${meta[1] || readme ? `<p class="muted small mem-sec-sub">${esc(meta[1])}${readme ? ` <a href="${esc(noteHref(slug, readme.path))}">About this folder</a>` : ""}</p>` : ""}
    ${head.length ? table(head) : ""}
    ${rest.length ? `<details class="mem-more"><summary>Show ${rest.length} more</summary>${table(rest)}</details>` : ""}
    ${archived.length ? `<details class="mem-more"><summary>Archive: ${plural(archived.length, "older version")}</summary>${table(archived)}</details>` : ""}
  </section>`;
}

/**
 * /agents/:slug/memory. d = { csrf, user, agent, agents, index: {notes, files, truncated} | null,
 * notes (the flat list, used when the index is missing), query, hits, view, flash, err, chrome }
 * chrome = { shell, tabs, agentCrumbs, agentHead } from views-agents.js.
 */
function agentMemory(d, chrome) {
  const { csrf, user, agent, query, hits, flash, err } = d;
  const slug = agent.slug;
  const base = "/agents/" + slug + "/memory";
  const v = d.view === "graph" ? "graph" : "notes";
  const mem = agent.memory || {};
  const notes = startTitles((d.index && d.index.notes) || (d.notes || []).map((n) => ({ path: n.path, title: n.path.split("/").pop().replace(/\.md$/, ""), bytes: n.bytes, modified: n.modified, links: [], tags: [] })));
  const files = (d.index && d.index.files) || [];
  const links = linkMap(notes);
  const peers = (d.agents && d.agents.length ? d.agents : [agent]).filter((a) => can(user, "agents.memory.read", a.slug));
  const writable = can(user, "agents.memory.write", slug);

  // Notes by group, newest first inside each.
  const groups = new Map();
  for (const n of notes) {
    const g = noteGroup(n);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }
  for (const list of groups.values()) list.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  const order = [...groups.keys()].sort((a, b) => NOTE_GROUPS[a][1] - NOTE_GROUPS[b][1]);

  const readmes = new Map(notes.filter((n) => /(^|\/)readme\.md$/i.test(n.path)).map((n) => [n.path.split("/")[0], n]));
  const fgroups = new Map();
  for (const f of files) {
    const g = fileGroup(f);
    if (!fgroups.has(g)) fgroups.set(g, []);
    fgroups.get(g).push(f);
  }
  const forder = [...fgroups.keys()].sort((a, b) => {
    const known = Object.keys(FILE_FOLDERS);
    const ia = known.indexOf(a), ib = known.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  const recent = notes
    .map((n) => ({ kind: "note", at: n.modified, n }))
    .concat(files.map((f) => ({ kind: "file", at: f.modified, f })))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 8);

  const startNotes = groups.get("start") || [];
  const memoryCount = notes.filter((n) => !["start", "guide", "archive", "other", "document"].includes(noteGroup(n))).length;

  const nav = `<nav class="mem-nav" aria-label="What is in this vault">
    ${
      peers.length > 1
        ? `<div class="mem-nav-group"><h2 class="mem-nav-h">Agent</h2><ul>${peers
            .map(
              (a) =>
                `<li><a href="/agents/${esc(a.slug)}/memory"${a.slug === slug ? ' aria-current="page" class="on"' : ""}>${esc(a.name || a.slug)}${
                  a.notes != null ? `<span class="mem-count">${esc(a.notes)}</span>` : ""
                }</a></li>`
            )
            .join("")}</ul></div>`
        : ""
    }
    <div class="mem-nav-group"><h2 class="mem-nav-h">Start here</h2><ul>${Object.keys(START)
      .map((p) => {
        const n = startNotes.find((x) => x.path === p);
        return n ? `<li><a href="${esc(noteHref(slug, p))}">${esc(START[p][0])}<span class="mem-count mono">${esc(p)}</span></a></li>` : "";
      })
      .join("")}</ul></div>
    <div class="mem-nav-group"><h2 class="mem-nav-h">Notes by kind</h2><ul>${order
      .filter((g) => g !== "start")
      .map((g) => `<li><a href="#n-${esc(g)}">${esc(NOTE_GROUPS[g][0])}<span class="mem-count">${groups.get(g).length}</span></a></li>`)
      .join("") || `<li class="muted small">No notes yet.</li>`}</ul></div>
    ${
      forder.length
        ? `<div class="mem-nav-group"><h2 class="mem-nav-h">Files</h2><ul>${forder
            .map(
              (g) =>
                `<li><a href="#f-${esc(g.replace(/[^a-z0-9_-]/gi, ""))}">${esc((FILE_FOLDERS[g] || [g === "_root" ? "Loose files" : g + "/"])[0])}<span class="mem-count">${fgroups.get(g).length}</span></a></li>`
            )
            .join("")}</ul></div>`
        : ""
    }
    <div class="mem-nav-group mem-nav-foot">
      <p class="small muted">${plural(notes.length, "note")} · ${plural(files.length, "file")} · ${esc(mem.chunks || 0)} indexed passages${
        mem.last_indexed ? ` · indexed ${when(mem.last_indexed)}` : ""
      }</p>
      ${
        writable
          ? `<form method="post" action="${esc(base)}/reindex" class="inline">
              <input type="hidden" name="_csrf" value="${esc(csrf)}">
              <button class="btn small" type="submit">${icon("reindex")} Reindex search</button>
            </form>`
          : ""
      }
    </div>
  </nav>`;

  const results = query
    ? `<section class="mem-sec" aria-labelledby="mh-results"><div class="mem-sec-head"><h2 id="mh-results">Results for “${esc(query)}”</h2>
        <a class="small" href="${esc(base)}">Clear</a></div>
        ${
          hits && hits.length
            ? `<ol class="mem-list mem-hits">${hits
                .map((h) => {
                  const n = notes.find((x) => x.path === h.path);
                  return `<li class="mem-row"><a class="mem-title" href="${esc(noteHref(slug, h.path))}">${esc((n && n.title) || h.path)}</a>
                    <span class="mem-path mono">${esc(h.path)}${h.heading ? " › " + esc(h.heading) : ""}</span>
                    <p class="mem-snip">${esc(snip(h.text, "", 260))}</p></li>`;
                })
                .join("")}</ol>`
            : `<p class="muted">Nothing matched “${esc(query)}”. Try other words, or browse the notes by kind below. If the vault has notes but search finds none, the search index may be empty${
                writable ? " — use Reindex search" : ""
              }.</p>`
        }</section>`
    : "";

  const recentHtml = recent.length
    ? `<section class="mem-sec" aria-labelledby="mh-recent"><div class="mem-sec-head"><h2 id="mh-recent">Recent changes</h2></div>
        <ol class="mem-recent">${recent
          .map((r) =>
            r.kind === "note"
              ? `<li><span class="mem-kind">${esc(GROUP_ONE[noteGroup(r.n)] || "Note")}</span><a href="${esc(noteHref(slug, r.n.path))}">${esc(r.n.title || r.n.path)}</a><span class="mono muted small">${esc(r.n.path)}</span>${when(r.at)}</li>`
              : `<li><span class="mem-kind">File</span><span class="mem-fname">${esc(String(r.f.path).split("/").pop())}</span><span class="mono muted small">${esc(String(r.f.path).split("/").slice(0, -1).join("/"))}/</span>${when(r.at)}</li>`
          )
          .join("")}</ol></section>`
    : "";

  const noteSections = order
    .filter((g) => g !== "start")
    .map(
      (g) => `<section class="mem-sec" id="n-${esc(g)}" aria-labelledby="nh-${esc(g)}">
        <div class="mem-sec-head"><h3 id="nh-${esc(g)}">${esc(NOTE_GROUPS[g][0])} <span class="mem-count">${groups.get(g).length}</span></h3></div>
        <ul class="mem-list">${groups.get(g).map((n) => noteRow(slug, n, links)).join("")}</ul>
      </section>`
    )
    .join("");

  const body = `
    ${chrome.tabs(slug, "memory")}
    ${flashes({ msg: flash, err })}
    <div class="mg-page mem-page">
    ${graphPanel({
      kind: "agents",
      src: "/api/agents/memory/graph?agent=all",
      search: "/api/agents/memory/search",
      incremental: false,
      poll: 20000,
      groups: [{ key: "", label: "All agents" }].concat(
        peers.map((a) => ({
          key: a.slug,
          label: a.name || a.slug,
          dot: a.state && a.state.active === "active" ? "ok" : a.state && a.state.active === "failed" ? "bad" : "off",
        }))
      ),
      group: slug,
      listHref: base,
      placeholder: "Search… (Enter = by meaning)",
      hidden: v !== "graph",
    })}
    <div class="mem-grid" data-view-panel="notes"${v === "notes" ? "" : " hidden"}>
      ${nav}
      <div class="mem-main">
        <form method="get" action="${esc(base)}" class="mem-search" role="search">
          <label for="mem-q">Search this agent’s memory <span class="hint">Finds notes by meaning and by exact words. Press / to jump here.</span></label>
          <div class="mem-search-row"><input id="mem-q" name="q" value="${esc(query || "")}" placeholder="e.g. what did we decide about the logo?" maxlength="500" data-mem-search>
          <button class="btn primary" type="submit">${icon("search")} Search</button></div>
        </form>
        ${results}
        <p class="mem-summary">${esc(agent.name || slug)} keeps ${plural(memoryCount, "memory note")}${
          files.length ? ` and ${plural(files.length, "file")}` : ""
        }. ${startNotes.some((n) => n.path === "MEMORY.md") ? `<a href="${esc(noteHref(slug, "MEMORY.md"))}">Home</a> is its index.` : ""}</p>
        ${recentHtml}
        ${
          notes.length
            ? `<h2 class="mem-h2">Notes</h2>${noteSections || `<p class="muted">Only the start files so far.</p>`}`
            : `<div class="empty"><span class="empty-ico">${icon("memory", 28)}</span><p class="empty-title">No notes yet</p><p class="muted">The agent writes a note when it learns something worth keeping.</p></div>`
        }
        ${
          forder.length
            ? `<h2 class="mem-h2" id="files">Files</h2><p class="muted small mem-sec-sub">Names and sizes only. The files themselves stay in the vault.</p>${forder
                .map((g) => filesSection(g, fgroups.get(g), readmes.get(g), slug))
                .join("")}`
            : ""
        }
        ${
          d.index && (d.index.truncated || {}).files
            ? `<p class="muted small">Only the first ${esc((d.index.limits || {}).files || "")} files are listed.</p>`
            : ""
        }
        <section class="mem-sec mem-obsidian" aria-labelledby="mh-obs"><h2 id="mh-obs" class="mem-h2">Open in Obsidian</h2>
          <p class="muted small">The vault is a plain folder of Markdown, registered in Obsidian on this server’s desktop. Reach it over an SSH tunnel to RDP — see the <a href="/guide#obsidian">Guide</a>.</p>
          <pre class="mem-pre">${esc((agent.dir || "") + "/vault")}</pre></section>
      </div>
    </div>
    </div>`;

  return chrome.shell("Memory — " + (agent.name || slug), body, {
    user,
    csrf,
    active: "agents",
    pattern: "a",
    assets: ["memgraph.css", "memgraph.js", "memory.css", "memory.js"],
    crumbs: chrome.agentCrumbs(agent, "Memory"),
    heading: agent.name || slug,
    headingHtml: chrome.agentHead(agent),
    subtitle: "What this agent remembers, sorted by kind. Open a note to read it and see what it links to.",
    actions: viewSwitch(v, [
      ["notes", "Notes", "logs", base + "?view=notes"],
      ["graph", "Graph", "network", base + "?view=graph"],
    ]),
  });
}

/**
 * /agents/:slug/memory/note. d = { csrf, user, agent, path, content, index, mode, flash, err }.
 * Read: the note rendered, its properties, links out and in. Edit (writers): the raw text.
 */
function agentNote(d, chrome) {
  const { csrf, user, agent, path, content, flash, err } = d;
  const slug = agent.slug;
  const writable = can(user, "agents.memory.write", slug);
  const editing = writable && d.mode === "edit";
  const notes = startTitles((d.index && d.index.notes) || []);
  const links = linkMap(notes);
  const me = notes.find((n) => n.path === path) || { path, links: [], tags: [] };
  const isMd = /\.md$/i.test(path);
  const rendered = isMd
    ? md.render(content, {
        resolve: (t) => {
          const n = links.find(t);
          return n ? { href: noteHref(slug, n.path), label: n.title } : null;
        },
        link: (u) => {
          const clean = u.split("#")[0];
          if (!clean || /\.\./.test(clean)) return null;
          const dir = path.split("/").slice(0, -1).join("/");
          const target = (clean.startsWith("/") ? clean.slice(1) : dir ? dir + "/" + clean : clean).replace(/^\.\//, "");
          return /\.md$/i.test(target) && notes.some((n) => n.path === target) ? noteHref(slug, target) : null;
        },
        shift: 1,
      })
    : { html: `<pre class="mem-pre">${esc(content)}</pre>`, props: {}, title: "" };
  const title = (me && me.title) || rendered.title || path.split("/").pop();
  // A note that opens with "# <its title>" would show the title twice.
  const html = rendered.html.replace(new RegExp("^<h2>" + escRe(md.inline(title)) + "</h2>\\n?"), "");
  const props = rendered.props || {};
  const group = noteGroup(me);
  const outLinks = links.out.get(path) || (me.links || []).map((t) => ({ target: t, note: links.find(t) }));
  const backLinks = (links.back.get(path) || []).slice().sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const sameKind = notes
    .filter((n) => n.path !== path && noteGroup(n) === group && group !== "start")
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
    .slice(0, 5);
  const tags = Array.isArray(props.tags) ? props.tags : me.tags || [];
  const propRows = [
    ["Kind", GROUP_ONE[group] || "Note"],
    props.created ? ["Created", String(props.created).slice(0, 16).replace("T", " ")] : null,
    ["Changed", me.modified ? stamp(me.modified).slice(0, 16) : "—"],
    tags.length ? ["Tags", tags.map((t) => "#" + String(t).replace(/^#/, "")).join("  ")] : null,
    me.bytes != null ? ["Size", bytes(me.bytes)] : null,
  ].filter(Boolean);
  const base = "/agents/" + slug + "/memory";
  const linkItem = (n) => `<li><a href="${esc(noteHref(slug, n.path))}">${esc(n.title || n.path)}</a><span class="mono muted small">${esc(n.path)}</span></li>`;

  const side = `
    <section class="mem-side-sec" aria-labelledby="ns-out"><h2 id="ns-out">Links from this note <span class="mem-count">${outLinks.length}</span></h2>
      ${
        outLinks.length
          ? `<ul class="mem-links">${outLinks
              .map((l) =>
                l.note
                  ? linkItem(l.note)
                  : `<li><span class="md-wiki missing">${esc(l.target)}</span><span class="muted small">Not written yet</span></li>`
              )
              .join("")}</ul>`
          : `<p class="muted small">None. Link a related note with [[its-name]].</p>`
      }</section>
    <section class="mem-side-sec" aria-labelledby="ns-in"><h2 id="ns-in">Linked from <span class="mem-count">${backLinks.length}</span></h2>
      ${backLinks.length ? `<ul class="mem-links">${backLinks.map(linkItem).join("")}</ul>` : `<p class="muted small">No other note links here yet.</p>`}</section>
    ${
      sameKind.length
        ? `<section class="mem-side-sec" aria-labelledby="ns-kind"><h2 id="ns-kind">More ${esc(NOTE_GROUPS[group][0].toLowerCase())}</h2><ul class="mem-links">${sameKind
            .map(linkItem)
            .join("")}</ul></section>`
        : ""
    }`;

  const reading = `<div class="mem-note">
    <article class="mem-doc" aria-labelledby="note-title">
      <header class="mem-doc-head">
        <h2 id="note-title" class="mem-doc-title">${esc(title)}</h2>
        <dl class="mem-props">${propRows.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join("")}</dl>
      </header>
      <div class="md-body">${html || `<p class="muted">This note is empty.</p>`}</div>
    </article>
    <aside class="mem-side" aria-label="Links">${side}</aside>
  </div>`;

  const editor = `<section class="card">
      <div class="card-head"><h2>${icon("edit")}Edit ${esc(path)}</h2></div>
      <p class="muted small">The agent reads these files and its search catches up on the next search. Correcting a wrong memory here is the fastest way to fix an agent that keeps repeating a mistake.</p>
      <form method="post" action="${esc(base)}/note">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="path" value="${esc(path)}">
        <label for="note-text" class="sr">Note text</label>
        <textarea id="note-text" name="content" rows="26" class="code" spellcheck="false">${esc(content)}</textarea>
        <div class="btn-row"><button class="btn primary" type="submit">${icon("save")} Save note</button>
          <a class="btn" href="${esc(noteHref(slug, path))}">Cancel</a></div>
      </form>
    </section>`;

  return chrome.shell(title + " — " + (agent.name || slug), `${chrome.tabs(slug, "memory")}${flashes({ msg: flash, err })}${editing ? editor : reading}`, {
    user,
    csrf,
    active: "agents",
    pattern: "c",
    assets: ["memory.css"],
    crumbs: chrome
      .agentCrumbs(agent, "Memory")
      .slice(0, -1)
      .concat([["Memory", base], [title, null]]),
    heading: agent.name || slug,
    headingHtml: chrome.agentHead(agent),
    subtitle: `<span class="mono">${esc(path)}</span>`,
    actions: `<a class="btn small" href="${esc(base)}">${icon("chevron")} All notes</a>${
      writable && !editing ? `<a class="btn small" href="${esc(noteHref(slug, path))}&amp;mode=edit">${icon("edit")} Edit</a>` : ""
    }`,
  });
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------- claude code --- */

const KIND_LABELS = {
  decision: ["Decisions", "What was decided, and why."],
  trap: ["Traps and fixes", "What went wrong once and how it was fixed."],
  preference: ["Preferences", "How the user wants things done."],
  figure: ["Figures", "Verified numbers and results."],
  open_issue: ["Open issues", "Known problems not yet solved."],
  fact: ["Facts", "Everything else worth knowing."],
};
const KIND_ORDER = ["decision", "preference", "trap", "open_issue", "figure", "fact"];
const KIND_ONE = { decision: "Decision", trap: "Trap", preference: "Preference", figure: "Figure", open_issue: "Open issue", fact: "Fact" };

const factHref = (id) => `/claude/memory/facts/${encodeURIComponent(id)}`;
const listHref = (params) =>
  "/claude/memory?" +
  Object.entries(Object.assign({ view: "list" }, params))
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");

function firstLine(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
}

/**
 * The Browse panel of /claude/memory. d = { outline, recent: [facts], agents: [{slug,name,notes}],
 * stats, errors }.
 */
function claudeBrowse(d) {
  const o = d.outline || null;
  const kinds = (o && o.kinds) || {};
  const total = Object.values(kinds).reduce((a, b) => a + Number(b || 0), 0);
  const topics = (o && o.topics) || [];
  const projects = (o && o.projects) || [];
  const agents = d.agents || [];

  const nav = `<nav class="mem-nav" aria-label="What is in memory">
    <div class="mem-nav-group"><h2 class="mem-nav-h">On this page</h2><ul>
      <li><a href="#ch-kinds">Kinds of memory<span class="mem-count">${KIND_ORDER.length}</span></a></li>
      <li><a href="#ch-recent">Recent changes</a></li>
      <li><a href="#ch-topics">By topic<span class="mem-count">${esc((o && o.topics_total) || topics.length)}</span></a></li>
    </ul></div>
    ${
      projects.length
        ? `<div class="mem-nav-group"><h2 class="mem-nav-h">By project</h2><ul>${projects
            .slice(0, 12)
            .map((p) => `<li><a href="${esc(listHref({ project: p.name }))}">${esc(p.name)}<span class="mem-count">${Number(p.count).toLocaleString("en-US")}</span></a></li>`)
            .join("")}</ul></div>`
        : ""
    }
    ${
      agents.length
        ? `<div class="mem-nav-group"><h2 class="mem-nav-h">Telegram agents</h2><ul>${agents
            .map(
              (a) =>
                `<li><a href="/agents/${esc(a.slug)}/memory">${esc(a.name || a.slug)}${a.notes != null ? `<span class="mem-count">${esc(a.notes)} notes</span>` : ""}</a></li>`
            )
            .join("")}</ul><p class="small muted">Each agent keeps its own memory, in its own vault.</p></div>`
        : ""
    }
    <div class="mem-nav-group"><h2 class="mem-nav-h">Also here</h2><ul>
      <li><a href="/claude/memory?view=sessions">Memory by session</a></li>
      <li><a href="/claude/memory?view=overview">Files, hooks and services</a></li>
    </ul></div>
  </nav>`;

  const recent = (d.recent || []).slice(0, 10);
  const recentHtml = `<section class="mem-sec" aria-labelledby="ch-recent"><div class="mem-sec-head"><h2 id="ch-recent">Recent changes</h2>
      <a class="small" href="${esc(listHref({}))}">All facts, newest first</a></div>
    ${
      recent.length
        ? `<ol class="mem-recent">${recent
            .map((f) => {
              const k = (f.meta && f.meta.kind) || "fact";
              return `<li><span class="mem-kind">${esc(KIND_ONE[k] || "Fact")}</span><a href="${esc(factHref(f.id))}">${esc(
                firstLine(f.content, 140)
              )}</a><span class="mono muted small">${esc(f.topic || "")}</span>${when(f.ts)}</li>`;
            })
            .join("")}</ol>`
        : `<p class="muted">${esc((d.errors && d.errors.facts) || "No facts yet.")}</p>`
    }</section>`;

  const topicHtml = topics.length
    ? `<section class="mem-sec" aria-labelledby="ch-topics"><div class="mem-sec-head"><h2 id="ch-topics">By topic</h2>
        <span class="small muted">${plural(Number(o.topics_total || topics.length), "topic")} · open one to see its parts</span></div>
        <div class="mem-topics">${topics
          .map(
            (t, i) => `<details class="mem-topic"${i < 2 ? " open" : ""}>
              <summary><span class="mem-topic-name">${esc(t.name)}</span><span class="mem-count">${Number(t.count).toLocaleString("en-US")}</span>
                <span class="small muted">changed ${when(t.last)}</span></summary>
              <ul class="mem-sub">${(t.children || [])
                .map(
                  (c) =>
                    `<li><a href="${esc(listHref({ topic: c.name ? t.name + "." + c.name : t.name }))}">${esc(c.name || "(" + t.name + " itself)")}<span class="mem-count">${Number(
                      c.count
                    ).toLocaleString("en-US")}</span></a></li>`
                )
                .join("")}${t.more_children ? `<li class="muted small">and ${esc(t.more_children)} more parts</li>` : ""}
                <li><a class="strong" href="${esc(listHref({ topic: t.name }))}">All of ${esc(t.name)}</a></li></ul>
            </details>`
          )
          .join("")}</div></section>`
    : d.errors && d.errors.outline
    ? `<div class="alert bad">${icon("alert")}<div>Could not read what is in memory: ${esc(d.errors.outline)}</div></div>`
    : "";

  return `<div class="mem-grid" data-view-panel="browse"${d.hidden ? " hidden" : ""}>
    ${nav}
    <div class="mem-main">
      <form method="get" action="/claude/memory" class="mem-search" role="search">
        <input type="hidden" name="view" value="list">
        <label for="mem-q">Search Claude Code’s memory <span class="hint">By meaning and by exact words, across facts and past conversations. Press / to jump here.</span></label>
        <div class="mem-search-row"><input id="mem-q" name="q" placeholder="e.g. what did we decide about the purchase plan?" maxlength="500" data-mem-search>
        <button class="btn primary" type="submit">${icon("search")} Search</button></div>
      </form>
      <p class="mem-summary">${
        total
          ? `Claude Code remembers ${total.toLocaleString("en-US")} current facts${
              o && o.topics_total ? `, in ${esc(o.topics_total)} topics` : ""
            }. Older versions are kept but not recalled.`
          : ""
      }</p>
      <h2 class="sr" id="ch-kinds">Kinds of memory</h2>
      <div class="mem-kinds" role="list" aria-labelledby="ch-kinds">${KIND_ORDER.map(
        (k) => `<a role="listitem" class="mem-kind-tile" href="${esc(listHref({ kind: k }))}"><b>${esc(KIND_LABELS[k][0])}</b><span class="mem-kind-n">${Number(
          kinds[k] || 0
        ).toLocaleString("en-US")}</span><span class="small muted">${esc(KIND_LABELS[k][1])}</span></a>`
      ).join("")}</div>
      ${recentHtml}
      ${topicHtml}
    </div>
  </div>`;
}

/** The fact page's side column: related by meaning, the same topic, older versions. */
function factSide(data) {
  const row = (r, extra) =>
    `<li><a href="${esc(factHref(r.id))}">${esc(firstLine(r.content, 120))}</a><span class="small muted">${esc(r.topic || "")}${extra ? " · " + extra : ""}</span></li>`;
  const rel = data.related || [];
  const same = data.same_topic || [];
  return `
    <section class="mem-side-sec" aria-labelledby="fs-rel"><h2 id="fs-rel">Related by meaning</h2>${
      rel.length ? `<ul class="mem-links">${rel.map((r) => row(r, "similarity " + esc(Number(r.sim).toFixed(2)))).join("")}</ul>` : `<p class="muted small">Nothing close enough.</p>`
    }</section>
    <section class="mem-side-sec" aria-labelledby="fs-same"><h2 id="fs-same">Same topic</h2>${
      same.length ? `<ul class="mem-links">${same.map((r) => row(r, esc(String(r.ts || "").slice(0, 10)))).join("")}</ul>` : `<p class="muted small">No other current fact under this topic.</p>`
    }</section>`;
}

module.exports = { agentMemory, agentNote, claudeBrowse, factSide, noteGroup, linkMap, resolver, KIND_LABELS, KIND_ONE, KIND_ORDER, NOTE_GROUPS };
