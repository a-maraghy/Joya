"use strict";
/**
 * Markdown to HTML for the memory pages: a vault note or a fact, rendered to read.
 *
 * The input is the least trusted text the dashboard shows -- whatever an agent wrote,
 * which may quote mail or web pages -- so every piece of text is escaped first and
 * only then given structure; no HTML in the source ever reaches the page as HTML.
 * Links keep to http(s), mailto and paths inside the vault; images are not loaded
 * (named instead); [[wikilinks]] go through the caller's resolver, which says where a
 * note lives or that it is not written yet.
 *
 *   const md = require("./markdown");
 *   const { html, props, title } = md.render(text, { resolve: (target) => ({ href, label }) | null,
 *                                                   link: (path) => href | null, shift: 1 });
 *
 * shift moves headings down (a note's "# Title" becomes an h2 under the page's own h1).
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const unesc = (s) =>
  String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);

const FRONT_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A note's frontmatter as a flat object: scalars as strings, "- item" lists as arrays. */
function frontmatter(text) {
  const m = FRONT_RE.exec(String(text || ""));
  if (!m) return { props: {}, body: String(text || "") };
  const props = {};
  let last = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$|^-\s+(.*)$/.exec(line);
    if (item && last) {
      if (!Array.isArray(props[last])) props[last] = props[last] ? [props[last]] : [];
      props[last].push((item[1] || item[2] || "").trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]{1,40})\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    last = kv[1].toLowerCase();
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) {
      props[last] = v
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      props[last] = v.replace(/^["']|["']$/g, "");
    }
  }
  return { props, body: String(text).slice(m[0].length) };
}

function safeHref(raw, link) {
  const u = String(raw || "").trim();
  if (/^(https?:|mailto:)/i.test(u)) return { href: u, external: /^https?:/i.test(u) };
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//")) return null; // javascript:, data:, file:, ...
  if (u.startsWith("#")) return { href: u };
  const local = link ? link(u) : null;
  return local ? { href: local } : null;
}

/** One line (or a paragraph's joined lines) of inline Markdown. */
function inline(src, o) {
  const keep = [];
  const hold = (html) => "\u0000" + (keep.push(html) - 1) + "\u0000";
  let s = String(src);
  // Code spans first: nothing inside them is Markdown.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => hold("<code>" + esc(code.trim()) + "</code>"));
  s = esc(s);
  // Images are named, never loaded: a vault path or a remote URL in an <img> would be a request we did not mean.
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, src2) =>
    hold(`<span class="md-img" title="${src2}">Image: ${alt || unesc(src2).split("/").pop()}</span>`)
  );
  s = s.replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g, (m, target) => hold(`<span class="md-img">Embedded: ${target}</span>`));
  s = s.replace(/\[\[([^\]|#\n]{1,160})(#[^\]|\n]*)?(?:\|([^\]\n]{1,160}))?\]\]/g, (m, target, anchor, alias) => {
    const t = unesc(target).trim().replace(/\\+$/, "");
    const label = alias ? alias.trim() : target.trim();
    const r = o.resolve ? o.resolve(t) : null;
    if (r && r.href) return hold(`<a class="md-wiki" href="${esc(r.href)}">${alias || !r.label ? label : esc(r.label)}</a>`);
    return hold(`<span class="md-wiki missing" title="No note called “${esc(t)}” yet">${label}</span>`);
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, text, url) => {
    const h = safeHref(unesc(url), o.link);
    if (!h) return hold(`<span class="md-link-off" title="${url}">${text}</span>`);
    return hold(`<a href="${esc(h.href)}"${h.external ? ' rel="noopener noreferrer" target="_blank"' : ""}>${text}</a>`);
  });
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;|(^|[\s(])(https?:\/\/[^\s<"')\]]+[^\s<"')\].,;:!?])/g, (m, a, pre, b) => {
    const url = unesc(a || b);
    return (pre || "") + hold(`<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(url)}</a>`);
  });
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|\s)#([A-Za-z؀-ۿ][\w؀-ۿ/-]{1,40})/g, '$1<span class="md-tag">#$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[Number(i)]);
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function blocks(lines, o) {
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const html = para
      .map((l, i) => inline(l.replace(/\s+$/, ""), o) + (i < para.length - 1 && / {2,}$/.test(l) ? "<br>" : ""))
      .join("\n");
    out.push("<p>" + html + "</p>");
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !new RegExp("^\\s*" + fence[1][0] + "{" + fence[1].length + ",}\\s*$").test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code"${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(6, h[1].length + (o.shift == null ? 1 : o.shift));
      out.push(`<h${level}>${inline(h[2], o)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push("<blockquote>" + blocks(quote, o) + "</blockquote>");
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) body.push(cells(lines[i++]));
      const td = (tag, c, j) => `<${tag}${align[j] ? ` class="${align[j]}"` : ""}>${inline(c, o)}</${tag}>`;
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c, j) => td("th", c, j)).join("")}</tr></thead><tbody>${body
          .map((r) => "<tr>" + head.map((_, j) => td("td", r[j] || "", j)).join("") + "</tr>")
          .join("")}</tbody></table></div>`
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      flush();
      const items = [];
      const sameKind = (m) => !items.length || m[1].length > items[0].indent || /\d/.test(m[2]) === items[0].ordered;
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (m && !sameKind(m)) break;
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: [m[3]] });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].text.push(lines[i].trim());
          i++;
        } else if (!lines[i].trim() && i + 1 < lines.length && LIST_RE.test(lines[i + 1]) && sameKind(LIST_RE.exec(lines[i + 1]))) {
          i++;
        } else break;
      }
      out.push(listHtml(items, o));
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join("\n");
}

function listHtml(items, o) {
  let html = "";
  const stack = [];
  const open = (it) => {
    stack.push(it);
    html += it.ordered ? `<ol${it.start > 1 ? ` start="${it.start}"` : ""}>` : "<ul>";
  };
  const close = () => {
    const it = stack.pop();
    html += "</li>" + (it.ordered ? "</ol>" : "</ul>");
  };
  for (const it of items) {
    if (!stack.length) open(it);
    else if (it.indent > stack[stack.length - 1].indent + 1) open(it);
    else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) close();
      html += "</li>";
    }
    let text = it.text.join(" ");
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) {
      const done = task[1] !== " ";
      html += `<li class="md-task${done ? " done" : ""}"><span class="md-box" aria-hidden="true"></span><span class="sr">${
        done ? "Done: " : "To do: "
      }</span>${inline(task[2], o)}`;
    } else {
      html += "<li>" + inline(text, o);
    }
    stack[stack.length - 1].indent = Math.min(stack[stack.length - 1].indent, it.indent);
  }
  while (stack.length) close();
  return html;
}

function render(text, opts) {
  const o = opts || {};
  const { props, body } = frontmatter(text);
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.find((l) => /^#\s+/.test(l));
  return {
    html: blocks(lines, o),
    props,
    title: props.title || (first ? first.replace(/^#\s+/, "").replace(/\s*#*\s*$/, "") : ""),
  };
}

module.exports = { render, frontmatter, inline: (s, o) => inline(s, o || {}), esc };
