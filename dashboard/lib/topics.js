"use strict";
/**
 * Telegram Topics for an agent's channel: one forum topic per project folder.
 *
 * The privileged helper (deploy/joya-helper, "topics" section) is the
 * authority: it checks a Topics configuration against everything the agent
 * runtime checks before it starts, writes the projects file, and puts the old
 * settings back if the bot still does not come up. This module only reads the
 * channel form and catches the mistakes worth a sentence before the round
 * trip -- the same wording the helper would use.
 */

const MAX_PROJECTS = 20;
const MODES = ["group", "private"];
const RESPOND_MODES = ["all", "mention"];
const MAX_ALIASES = 10;
const MAX_ALIAS_LEN = 40;
const MAX_TRASH_DAYS = 3650;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SUPERGROUP_RE = /^-100\d{7,13}$/;

const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x == null ? "" : x).trim());

/** A short name from a display name: "Client work (EU)" -> "client-work-eu". */
function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/[-_]+$/g, "");
}

/**
 * The Topics part of a channel form. Rows come as parallel fields tp_name /
 * tp_slug / tp_path / tp_on / tp_auto (one value each, or arrays when there are
 * several); a row left entirely blank is dropped, and a blank short name is
 * made from the name. tp_auto marks a folder the bot made for a new topic
 * (projects.auto.json): the helper keeps it only when it was edited.
 */
function parseTopicsForm(body) {
  const b = body || {};
  const names = list(b.tp_name);
  const slugs = list(b.tp_slug);
  const paths = list(b.tp_path);
  const ons = list(b.tp_on);
  const autos = list(b.tp_auto);
  const n = Math.max(names.length, slugs.length, paths.length);
  const projects = [];
  for (let i = 0; i < n; i++) {
    const name = names[i] || "";
    const path = paths[i] || "";
    let slug = (slugs[i] || "").toLowerCase();
    if (!name && !path && !slug) continue;
    if (!slug) slug = slugify(name);
    const row = { slug, name, path: path || ".", enabled: ons[i] !== "0" };
    if (autos[i] === "1") row.auto = true;
    projects.push(row);
  }
  const mode = MODES.includes(String(b.topics_mode || "")) ? String(b.topics_mode) : "group";
  const general = String(b.topics_general || "").trim().toLowerCase();
  const days = String(b.topics_trash_days == null ? "" : b.topics_trash_days).trim();
  return {
    topics_enabled: !!b.topics_enabled,
    topics_mode: mode,
    topics_chat_id: String(b.topics_chat_id || "").trim(),
    topics_projects: projects,
    topics_general: general === "off" ? "" : general,
    topics_auto: b.topics_auto === "1",
    topics_auto_announce: b.topics_auto_announce === "1",
    topics_deleted: b.topics_deleted === "keep" ? "keep" : "trash",
    topics_trash_days: days === "" ? 30 : /^\d{1,5}$/.test(days) ? Number(days) : NaN,
    // Only send the list when the form carried the table: a form without it
    // (the create page) leaves the helper to propose the default.
    has_projects_table: b.tp_table === "1",
  };
}

/**
 * "Respond in groups" (channel settings): answer every group message, or only
 * when asked -- an @mention, a reply to the bot, or one of its names (one per
 * line in the form).
 */
function parseRespondForm(body) {
  const b = body || {};
  const mode = String(b.respond_mode || "all").trim().toLowerCase();
  const raw = Array.isArray(b.name_aliases) ? b.name_aliases.join("\n") : String(b.name_aliases || "");
  const seen = new Set();
  const aliases = [];
  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    aliases.push(name);
  }
  return { respond_mode: mode, name_aliases: aliases, has_respond: b.respond_form === "1" };
}

/** Sentences for what is wrong with the respond settings, or []. */
function checkRespond(r) {
  const errors = [];
  if (!RESPOND_MODES.includes(r.respond_mode)) errors.push("Respond in groups: choose 'Only when asked' or 'To every message'.");
  for (const name of r.name_aliases || []) {
    if (/[,\x00-\x1f\x7f]/.test(name)) errors.push("The name '" + name.slice(0, 40) + "' contains a comma; put each name on a line of its own.");
    else if (name.length > MAX_ALIAS_LEN) errors.push("The name '" + name.slice(0, 40) + "...' is longer than " + MAX_ALIAS_LEN + " characters.");
  }
  if ((r.name_aliases || []).length > MAX_ALIASES) errors.push("At most " + MAX_ALIASES + " names.");
  return errors;
}

/** The payload keys for priv.channelUpdate. */
function respondPayload(r) {
  return r.has_respond ? { respond_mode: r.respond_mode, name_aliases: r.name_aliases } : {};
}

/** Sentences for what is wrong, or [] -- the helper checks folders and Telegram itself. */
function checkTopics(t) {
  const errors = [];
  if (t.topics_enabled && t.topics_mode === "group") {
    if (!t.topics_chat_id) errors.push("Group topic mode needs the group's chat id.");
    else if (!SUPERGROUP_RE.test(t.topics_chat_id))
      errors.push(
        "The group chat id " + t.topics_chat_id + " is not a group with Topics: Topics live only in " +
          "supergroups, whose id starts with -100. Turn on Topics in the group's settings (Telegram " +
          "then gives the group a new id starting with -100) and use that id."
      );
  }
  const projects = t.topics_projects || [];
  if (projects.filter((p) => !p.auto).length > MAX_PROJECTS) errors.push("At most " + MAX_PROJECTS + " projects.");
  if (t.has_projects_table) {
    const days = t.topics_trash_days;
    if (!Number.isInteger(days) || days < 0 || days > MAX_TRASH_DAYS)
      errors.push("Deleted topics' folders stay in the trash 0 to " + MAX_TRASH_DAYS + " days (0 deletes them at once).");
    if (t.topics_enabled && t.topics_mode === "group" && t.topics_general) {
      const target = projects.find((p) => p.slug === t.topics_general);
      if (!target) errors.push("The General topic goes to '" + t.topics_general + "', which is not one of the projects.");
      else if (target.auto) errors.push("The General topic can only go to a project of the list, not to a folder made for a new topic.");
      else if (!target.enabled) errors.push("The General topic goes to '" + target.name + "', which is switched off.");
    }
  }
  const seen = { slug: new Set(), name: new Set(), path: new Set() };
  projects.forEach((p, i) => {
    const label = p.name ? "Project '" + p.name + "'" : "Project " + (i + 1);
    if (!p.name) errors.push(label + " needs a name; it becomes the topic's title.");
    if (!SLUG_RE.test(p.slug))
      errors.push(label + ": the short name may use only lowercase letters, digits, '-' and '_' (at most 40).");
    if (/^[/~]/.test(p.path)) errors.push(label + ": the folder must be inside the agent's folder, written relative to it (\".\" is the agent's own folder).");
    else if (/(^|\/)\.\.(\/|$)/.test(p.path)) errors.push(label + ": the folder may not climb out with '..'.");
    for (const k of ["slug", "name", "path"]) {
      if (p[k] && seen[k].has(p[k])) errors.push("Two projects share the " + (k === "slug" ? "short name" : k === "path" ? "folder" : "name") + " '" + p[k] + "'.");
      seen[k].add(p[k]);
    }
  });
  return errors;
}

/** The payload keys for priv.channelUpdate / channelCreate. */
function topicsPayload(t) {
  const out = {
    topics_enabled: t.topics_enabled,
    topics_mode: t.topics_mode,
    topics_chat_id: t.topics_chat_id,
  };
  if (t.has_projects_table) {
    out.topics_projects = t.topics_projects;
    out.topics_general = t.topics_general;
    out.topics_auto = t.topics_auto;
    out.topics_auto_announce = t.topics_auto_announce;
    out.topics_deleted = t.topics_deleted;
    out.topics_trash_days = t.topics_trash_days;
  }
  return out;
}

/** One line for the channel's summary table. */
function describe(c) {
  if (!c || !c.topics_enabled) return "off";
  const n = Array.isArray(c.topics_projects) && c.topics_projects.length ? c.topics_projects.length : 1;
  const where = (c.topics_mode || "group") === "private" ? "private chat" : "group " + (c.topics_chat_id || "?");
  return "on · " + where + " · " + n + (n === 1 ? " project" : " projects") +
    (c.topics_auto && (c.topics_mode || "group") === "group" ? " · new topics get folders" : "");
}

/** One line for "Respond in groups". */
function describeRespond(c) {
  return c && c.respond_mode === "mention" ? "only when asked" : "every message";
}

module.exports = {
  parseTopicsForm, checkTopics, topicsPayload, describe, slugify,
  parseRespondForm, checkRespond, respondPayload, describeRespond,
  MAX_PROJECTS, MAX_ALIASES, MAX_ALIAS_LEN, SUPERGROUP_RE,
};
