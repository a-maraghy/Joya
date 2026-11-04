"use strict";
/**
 * The memory graphs' data: what the helper returns, shaped for the page.
 *
 * Two sources, one shape. Claude Code's long-term memory (facts, transcript
 * chunks, the sessions they came from, the dotted topics that file them and
 * the projects they belong to) and the agents' vaults (notes, their
 * [[wikilinks]] and #tags, the agent each belongs to). Both become
 *
 *   { nodes: [{ id, t, l, g, h, ts, s, m }], edges: [[a, b, k, w?]], ... }
 *
 *   id  stable across refreshes, so a poll can add what is new and nothing else
 *   t   type (decision, trap, topic, session, people, ...), which picks colour
 *   l   label, short; s a longer snippet for the side panel
 *   g   group -- the project, or the agent -- which the chips filter on
 *   h   1 for a hub (topic, session, project, agent), drawn larger with a halo
 *   k   link kind: "s" structure, "m" related by meaning, "v" superseded by
 *
 * Nothing here trusts its input to be free of secrets: the helper redacts, and
 * the route runs priv.redactDeep over this module's output before it leaves.
 * Nothing here escapes either -- the page draws text onto a canvas and into
 * the DOM with textContent, never as markup.
 */

const FACT_KINDS = new Set(["decision", "figure", "trap", "preference", "open_issue", "fact"]);

function short(text, n) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** A fact's label: its first clause, which is usually what it is about. */
function factLabel(content) {
  const s = short(content, 400);
  const cut = s.search(/[.:;!?](\s|$)| — | - /);
  return short(cut > 12 && cut < 80 ? s.slice(0, cut) : s, 64);
}

/* ---------------------------------------------------------- Claude Code -- */

/**
 * @param raw  the helper's cc-memory-graph answer
 * @param opts { known } -- ids the page already has (incremental requests), so
 *             hubs are not sent twice
 */
function buildClaude(raw, opts = {}) {
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const known = opts.known || null;
  const add = (n) => {
    if (!nodes.has(n.id) && !(known && known.has(n.id))) nodes.set(n.id, n);
  };
  const link = (a, b, k, w) => {
    const key = a < b ? a + "|" + b + "|" + k : b + "|" + a + "|" + k;
    if (a === b || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(w == null ? [a, b, k] : [a, b, k, w]);
  };

  const sessions = new Map((raw.sessions || []).map((s) => [s.session_id, s]));
  const projectOf = (sid) => (sid && sessions.get(sid) ? sessions.get(sid).project || null : null);

  const projectNode = (p) => {
    if (!p) return null;
    add({ id: "p:" + p, t: "project", l: p, g: p, h: 1 });
    return "p:" + p;
  };
  const sessionNode = (sid) => {
    if (!sid) return null;
    const s = sessions.get(sid) || {};
    const p = s.project || null;
    add({
      id: "s:" + sid,
      t: "session",
      l: short(s.title || "Session " + String(sid).slice(0, 8), 48),
      g: p,
      h: 1,
      ts: s.last || s.first || null,
      m: { session: sid, chunks: s.n || 0, first: s.first || null },
    });
    const pn = projectNode(p);
    if (pn) link("s:" + sid, pn, "s");
    return "s:" + sid;
  };
  const topicNode = (topic) => {
    if (!topic) return null;
    const parts = String(topic).split(".").filter(Boolean).slice(0, 6);
    let prev = null;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join(".");
      add({ id: "t:" + path, t: "topic", l: parts[i], g: null, h: 1, m: { topic: path, depth: i } });
      if (prev) link("t:" + path, prev, "s");
      prev = "t:" + path;
    }
    return prev;
  };

  for (const f of raw.facts || []) {
    const kind = FACT_KINDS.has(f.kind) ? f.kind : "fact";
    const project = f.project || projectOf(f.source_session);
    const id = "f:" + f.id;
    add({
      id,
      t: kind,
      l: factLabel(f.content),
      g: project,
      ts: f.ts,
      s: short(f.content, 360),
      m: { fact: f.id, topic: f.topic || null, session: f.source_session || null, sup: f.superseded_by || null },
    });
    const tn = topicNode(f.topic);
    if (tn) link(id, tn, "s");
    const sn = sessionNode(f.source_session);
    if (sn) link(id, sn, "s");
    else if (project) link(id, projectNode(project), "s");
  }

  for (const c of raw.chunks || []) {
    const t = c.source === "doc" ? "document" : c.source === "memory_file" ? "file" : "conversation";
    const project = c.project || projectOf(c.session_id);
    const id = "c:" + c.id;
    add({
      id,
      t,
      l: short(c.label || c.content, 64),
      g: project,
      ts: c.ts,
      s: short(c.content, 240),
      m: { chunk: c.id, session: c.session_id || null, source: c.source, role: c.role || null, file: c.rel || c.file || null },
    });
    const sn = sessionNode(c.session_id);
    if (sn) link(id, sn, "s");
    else if (project) link(id, projectNode(project), "s");
  }

  for (const [older, newer] of raw.supers || []) link("f:" + older, "f:" + newer, "v");
  for (const [a, b, sim] of raw.sem || []) link("f:" + a, "f:" + b, "m", sim);

  // A link is only worth sending if both ends exist on the page: here, or
  // already there.
  const has = (id) => nodes.has(id) || (known && known.has(id));
  return {
    nodes: [...nodes.values()],
    edges: edges.filter((e) => has(e[0]) && has(e[1])),
    cursor: raw.cursor || null,
    alive: (raw.alive || []).map((id) => "f:" + id),
    incremental: !!raw.incremental,
    limits: raw.limits || null,
  };
}

/* ---------------------------------------------------------------- agents -- */

const NOTE_TYPES = new Set([
  "people", "decision", "figure", "trap", "run", "conversation", "call", "research", "report",
  "output", "preference", "goal", "pattern", "topic", "file", "document", "project", "note",
]);

/**
 * @param vaults  [{ slug, name, graph }] -- one helper agent-memory-graph
 *                answer per agent the viewer may see
 */
function buildAgents(vaults) {
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const add = (n) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const link = (a, b, k, w) => {
    const key = a < b ? a + "|" + b + "|" + k : b + "|" + a + "|" + k;
    if (a === b || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(w == null ? [a, b, k] : [a, b, k, w]);
  };
  const notes = [];
  const errors = [];

  for (const v of vaults) {
    const slug = v.slug;
    const hub = "a:" + slug;
    add({ id: hub, t: "agent", l: v.name || slug, g: slug, h: 1, m: { agent: slug } });
    if (v.error) {
      errors.push({ agent: slug, error: v.error });
      continue;
    }
    const g = v.graph || {};
    if (g.sem_error) errors.push({ agent: slug, error: "related by meaning: " + g.sem_error });
    const byName = new Map();
    for (const n of g.notes || []) {
      const id = "n:" + slug + ":" + n.path;
      const base = n.path.split("/").pop().replace(/\.md$/i, "").toLowerCase();
      byName.set(base, id);
      if (n.title) byName.set(String(n.title).toLowerCase(), id);
      add({
        id,
        t: NOTE_TYPES.has(n.type) ? n.type : "note",
        l: short(n.title || base, 64),
        g: slug,
        ts: n.modified || null,
        s: short(n.snippet, 320),
        m: { agent: slug, path: n.path, bytes: n.bytes, tags: n.tags || [] },
      });
      link(id, hub, "s");
      notes.push({ slug, id, n });
    }
    for (const { id, n } of notes.filter((x) => x.slug === slug)) {
      for (const target of n.links || []) {
        const key = String(target).replace(/\\+$/, "").split("/").pop().replace(/\.md$/i, "").toLowerCase();
        let to = byName.get(key);
        if (!to) {
          // An unresolved [[link]] is a subject nobody has written up yet:
          // drawn as a topic, the way Obsidian draws an unresolved note.
          to = "u:" + slug + ":" + key;
          add({ id: to, t: "topic", l: short(target, 48), g: slug, h: 1, m: { agent: slug, unresolved: true } });
        }
        link(id, to, "s");
      }
      for (const tag of n.tags || []) {
        const to = "tag:" + slug + ":" + String(tag).toLowerCase();
        add({ id: to, t: "topic", l: "#" + tag, g: slug, h: 1, m: { agent: slug, tag } });
        link(id, to, "s");
      }
    }
    for (const [a, b, sim] of g.sem || []) link("n:" + slug + ":" + a, "n:" + slug + ":" + b, "m", sim);
  }
  return {
    nodes: [...nodes.values()],
    edges: edges.filter((e) => nodes.has(e[0]) && nodes.has(e[1])),
    errors,
    full: true,
  };
}

/** Search hits to node ids, best first. */
function claudeHits(results) {
  return (results || [])
    .map((h) => ({ id: (h.kind === "fact" ? "f:" : "c:") + h.id, score: h.score }))
    .filter((h) => /^[fc]:\d+$/.test(h.id));
}

function agentHits(slug, hits) {
  return (hits || []).map((h) => ({ id: "n:" + slug + ":" + h.path, score: h.score }));
}

module.exports = { buildClaude, buildAgents, claudeHits, agentHits, factLabel, short };
