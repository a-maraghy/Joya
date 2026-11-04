"use strict";
/**
 * The memory graph's markup: the frame public/memgraph.js draws into.
 *
 * Server-rendered so the page has its controls before the script runs --
 * filters, chips, the search box and the zoom buttons are real buttons and a
 * real form -- and so a page without JavaScript still says what it is and
 * where the same memories are as a list.
 */

const { esc, icon } = require("./ui");

/**
 * @param o {
 *   kind       "claude" | "agents"
 *   src        JSON endpoint for the graph
 *   search     JSON endpoint for search by meaning
 *   incremental  true when the endpoint takes after_f / after_c cursors
 *   poll       ms between checks for new memories
 *   groups     [{ key, label, dot }] -- the chips; "" is the "all" chip
 *   group      the chip selected at load ("" for all)
 *   csrf, writable, factUrl   Claude Code only: the edit and forget forms
 *   listHref   where the same memories are as a list
 *   placeholder  the search box's hint
 * }
 */
function graphPanel(o) {
  const chips = (o.groups || [])
    .map(
      (g) =>
        `<button type="button" class="mg-chip" data-group-chip="${esc(g.key)}" aria-pressed="${
          (o.group || "") === g.key ? "true" : "false"
        }">${g.dot ? `<span class="dot${g.dot === "ok" ? "" : " " + esc(g.dot)}"></span>` : ""}${esc(g.label)}</button>`
    )
    .join("");
  return `<div class="mg" data-memgraph data-kind="${esc(o.kind)}" data-src="${esc(o.src)}" data-search="${esc(o.search || "")}"
      data-incremental="${o.incremental ? "1" : "0"}" data-poll="${esc(o.poll || 15000)}" data-group="${esc(o.group || "")}"
      data-csrf="${esc(o.csrf || "")}" data-writable="${o.writable ? "1" : "0"}" data-fact-url="${esc(o.factUrl || "")}"
      data-view-panel="graph"${o.hidden ? " hidden" : ""}>
    <aside class="card mg-types" aria-label="Memory types"><ul><li><button type="button" class="mg-type" data-type="" aria-pressed="true">
      <span class="mg-dot all"></span><span class="mg-type-l">All memories</span><span class="mg-type-n">…</span></button></li></ul></aside>
    <div class="mg-main">
      <div class="mg-bar">
        <div class="mg-chips" role="group" aria-label="${esc(o.kind === "agents" ? "Agents" : "Projects")}">${chips}</div>
        <form class="mg-search" role="search" action="${esc(o.listHref || "")}" method="get">
          ${icon("search", 15)}<input type="search" name="q" autocomplete="off" spellcheck="false" maxlength="500"
            placeholder="${esc(o.placeholder || "Search… (Enter = by meaning)")}" aria-label="Search memories; Enter searches by meaning">
          <input type="hidden" name="view" value="list">
        </form>
        <span class="mg-count" aria-live="polite">— memories · — links</span>
      </div>
      <div class="mg-stage">
        <canvas role="img" aria-label="Memory graph. Drag to pan, scroll to zoom, click a node for its details. Keys: / search, + and - zoom, 0 fit."></canvas>
        <div class="mg-empty"><p>Growing the graph…${
          o.listHref ? ` <noscript>It needs JavaScript; the same memories are in the <a href="${esc(o.listHref)}">list</a>.</noscript>` : ""
        }</p></div>
        <div class="mg-zoom" aria-label="Zoom">
          <button type="button" data-zoom="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
          <button type="button" data-zoom="out" title="Zoom out (−)" aria-label="Zoom out">−</button>
          <button type="button" data-zoom="fit" title="Fit (0)" aria-label="Fit to screen">${icon("overview", 15)}</button>
        </div>
        <div class="mg-status" aria-live="polite" hidden></div>
        <div class="mg-tip" hidden></div>
        <div class="mg-legend" aria-hidden="true"></div>
        <label class="mg-related"><input type="checkbox" checked> Related by meaning</label>
        <aside class="card hud mg-detail" hidden aria-label="Selected memory"></aside>
      </div>
    </div>
  </div>`;
}

/** Graph / List / Overview: which panel of a memory page is showing. */
function viewSwitch(active, views) {
  return `<nav class="view-switch" data-view-switch role="tablist" aria-label="View">${views
    .map(
      ([key, label, ic, href]) =>
        `<a href="${esc(href)}" data-view="${esc(key)}" role="tab" aria-selected="${active === key}" class="${
          active === key ? "on" : ""
        }">${icon(ic, 14)}${esc(label)}</a>`
    )
    .join("")}</nav>`;
}

module.exports = { graphPanel, viewSwitch };
