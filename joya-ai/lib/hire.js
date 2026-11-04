"use strict";
/**
 * Hiring and retiring worker sessions (M-6) -- the checks, pure, for the
 * supervisor and its tests.
 *
 * The standing rule (fact #779): JOYA AI may HIRE worker sessions on its own,
 * but may RETIRE one only with the administrator's explicit consent; the
 * administrator may keep any hired session permanently. Kept sessions, and
 * every session not hired through this feature (the administrator's own:
 * today Giza Odoo Automation and JOYA AI OS), are never retirable by JOYA AI.
 *
 * Limits: at most MAX_LIVE sessions in the spheres view (every live session
 * but JOYA AI itself, plus hires still starting); a cwd under /root (the
 * allowlist: /root/joya and /root itself, never a hidden directory such as
 * /root/.ssh or /root/.claude); a unique normalised name among the hires not
 * retired (a retired hire's name may be hired again, under a fresh slug); a
 * sanitised slug;
 * at most HIRES_PER_HOUR hires an hour.
 *
 * MAX_LIVE, HIRES_PER_HOUR and the hired permission mode are DEFAULTS since the
 * Joya reorganisation (2026-09-30): the administrator edits them in
 * Settings > Sessions & hiring (ledger settings hire_max_live, hire_per_hour,
 * hire_perm_mode; the supervisor's hire-limits ops), within LIMIT_BOUNDS, and
 * the supervisor reads them at hire time. bypassPermissions is never a mode.
 */
const fs = require("fs");
const path = require("path");
const targets = require("./targets");
const names = require("./names");

const MAX_LIVE = 7;
const HIRES_PER_HOUR = 3;
const LIMIT_BOUNDS = { max_live: [1, 12], per_hour: [0, 10] };
const HIRE_MODES = ["auto", "default", "plan"]; // never bypassPermissions
const CWD_ROOTS = ["/root/joya", "/root"];
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{2,60}$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'()&-]{0,47}$/u;

/** "Session Birth" -> "session-birth": lower case, [a-z0-9-] only, 1..40 characters. */
function slugOf(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * `slug`, or -- when it is already in hired_sessions (a retired hire's) -- the
 * first of "<slug>-2", "<slug>-3", ... that is not, kept within 40
 * characters. null only if a thousand are taken.
 */
function freeSlug(slug, taken) {
  const used = new Set(taken || []);
  if (!used.has(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const sfx = "-" + i;
    const s = slug.slice(0, 40 - sfx.length).replace(/-+$/, "") + sfx;
    if (!used.has(s)) return s;
  }
  return null;
}

/** The realpath of a directory the allowlist accepts, or an error. */
function checkCwd(cwd, opts = {}) {
  const exists = opts.exists || ((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  const real = opts.realpath || ((p) => fs.realpathSync(p));
  const roots = opts.roots || CWD_ROOTS;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return { error: "cwd must be an absolute path" };
  if (!exists(cwd)) return { error: "cwd is not an existing directory" };
  let r;
  try {
    r = real(cwd);
  } catch (e) {
    return { error: "cwd cannot be resolved" };
  }
  const under = roots.some((root) => r === root || r.startsWith(root + "/"));
  if (!under) return { error: `cwd must be under ${roots.join(" or ")}` };
  // Never a hidden directory anywhere on the way (/root/.ssh, /root/.claude, /root/joya/.git ...).
  if (r.split("/").some((part) => part.startsWith("."))) return { error: "cwd may not be (inside) a hidden directory" };
  return { cwd: r };
}

/** The hired permission mode today's config gives (joya-session's own rule), as a HIRE_MODES value. */
function defaultPermMode(cfg = {}) {
  const m = cfg.hired_permission_mode || cfg.permission_mode;
  return HIRE_MODES.includes(m) ? m : "default";
}

/** The defaults: what applies when nothing is stored. */
function defaultLimits(cfg) {
  return { max_live: MAX_LIVE, per_hour: HIRES_PER_HOUR, perm_mode: defaultPermMode(cfg) };
}

/**
 * Validate a change to the limits: any of {max_live, per_hour, perm_mode}.
 * Returns the cleaned fields, or { error }.
 */
function checkLimits(p) {
  const out = {};
  for (const k of ["max_live", "per_hour"]) {
    if (p[k] === undefined) continue;
    const [lo, hi] = LIMIT_BOUNDS[k];
    if (typeof p[k] !== "number" || !Number.isInteger(p[k]) || p[k] < lo || p[k] > hi) return { error: `${k} must be a whole number ${lo}..${hi}` };
    out[k] = p[k];
  }
  if (p.perm_mode !== undefined) {
    if (/bypass/i.test(String(p.perm_mode))) return { error: "bypassPermissions is never allowed for a hired session" };
    if (!HIRE_MODES.includes(p.perm_mode)) return { error: `perm_mode must be one of ${HIRE_MODES.join(", ")}` };
    out.perm_mode = p.perm_mode;
  }
  return out;
}

/** Stored values (any may be missing or out of bounds) over the defaults. */
function effectiveLimits(stored, cfg) {
  const d = defaultLimits(cfg);
  const s = stored || {};
  const inb = (k) => {
    const [lo, hi] = LIMIT_BOUNDS[k];
    return Number.isInteger(s[k]) && s[k] >= lo && s[k] <= hi ? s[k] : d[k];
  };
  return { max_live: inb("max_live"), per_hour: inb("per_hour"), perm_mode: HIRE_MODES.includes(s.perm_mode) ? s.perm_mode : d.perm_mode };
}

/** The live sessions counted against max_live, and the hired / kept ones: as checkHire counts them. */
function liveCount(live, hired) {
  const liveOthers = (live || []).filter((s) => s && !s.self);
  const starting = (hired || []).filter((h) => !liveOthers.some((s) => s.session_id === h.session_id)).length;
  return { live: liveOthers.length + starting, hired: (hired || []).length };
}

/**
 * Check a hire. `live`: the live sessions list (supervisor's cache); `hired`:
 * the hired_sessions rows not retired; `recent`: hires in the last hour;
 * `taken`: every slug in hired_sessions, retired ones included (the column is
 * UNIQUE). A name held by a hire that is still hired or retiring is refused;
 * one held only by a RETIRED hire may be hired again -- the old row stays for
 * the record and the new hire gets a fresh slug (freeSlug: "<slug>-2", ...).
 * Returns { ok, name, slug, cwd, model, slug_note? } or { error }.
 */
function checkHire({ name, cwd, purpose, model }, { live, hired, recent, cwdOpts, limits, taken } = {}) {
  const lim = limits || { max_live: MAX_LIVE, per_hour: HIRES_PER_HOUR };
  const nm = String(name || "").trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(nm)) return { error: "name must be 1-48 letters, digits, spaces and . _ ' ( ) & -" };
  if (names.isSelfName(nm)) return { error: "that name is JOYA AI's own" };
  if (targets.isInternal({ name: nm.toLowerCase() })) return { error: "names starting joya-internal- are reserved for Joya's own processes" };
  const slug = slugOf(nm);
  if (!slug) return { error: "that name has no letters or digits to make a slug from" };
  const n = targets.norm(nm);
  const clash = (hired || []).find((h) => h.status !== "retired" && targets.norm(h.name) === n);
  if (clash && clash.status === "retiring") return { error: `a hired session named "${clash.name}" is being retired (waiting for the administrator's consent): pick another name, or hire again once it is retired` };
  if (clash) return { error: `a hired session named "${clash.name}" already exists and is still hired: pick another name, or retire it first` };
  const liveOthers = (live || []).filter((s) => s && !s.self);
  if (liveOthers.some((s) => targets.norm(s.name) === n)) return { error: `a session named "${nm}" is already running` };
  if (liveCount(live, hired).live >= lim.max_live) return { error: `already ${lim.max_live} sessions: retire one first (the limit is ${lim.max_live} live sessions)` };
  if (lim.per_hour === 0) return { error: "hiring is switched off (0 hires an hour in Settings)" };
  if ((recent || 0) >= lim.per_hour) return { error: `at most ${lim.per_hour} hires an hour` };
  const c = checkCwd(cwd, cwdOpts);
  if (c.error) return c;
  const p = String(purpose || "").trim();
  if (p.length < 10) return { error: "purpose must say what the session is for (10 characters or more)" };
  if (model !== undefined && model !== null && model !== "" && !MODEL_RE.test(String(model))) return { error: "model must be a claude-* model id" };
  // A retired hire keeps its row (and its slug) for the record: the new one gets the next free slug.
  const free = freeSlug(slug, [...(taken || []), ...(hired || []).map((h) => h.slug)]);
  if (!free) return { error: `too many hires have been named "${nm}": pick another name` };
  return { ok: true, name: nm, slug: free, cwd: c.cwd, purpose: p, model: model || null, ...(free !== slug ? { slug_note: `"${slug}" belongs to a retired hire, kept for the record` } : {}) };
}

/**
 * Which hired session a retire (or keep) request names: {slug}, {session_id},
 * {ref} (a ListAgents ref, via refs), or {name} (unique normalised). Only
 * sessions hired through this feature, and not yet retired, are found.
 */
function findHired(q, hired, refs) {
  const list = (hired || []).filter((h) => h.status !== "retired");
  if (q.slug) return list.find((h) => h.slug === q.slug) || null;
  if (q.session_id) return list.find((h) => h.session_id === q.session_id) || null;
  let name = q.name;
  if (q.ref && refs && refs[String(q.ref).toLowerCase()]) name = refs[String(q.ref).toLowerCase()].name;
  if (!name) return null;
  const n = targets.norm(name);
  const m = list.filter((h) => targets.norm(h.name) === n);
  return m.length === 1 ? m[0] : null;
}

/**
 * May JOYA AI (actor joya-ai) ask to retire this? Never a kept session, never
 * one not hired through this feature (findHired returns null for those).
 */
function retireRefusal(h) {
  if (!h) return "that is not a session hired through JOYA AI: the administrator's own sessions can never be retired by JOYA AI";
  if (h.kept) return `"${h.name}" is kept by the administrator: it is never retired by JOYA AI`;
  if (h.status === "retiring") return `retiring "${h.name}" is already waiting for the administrator's consent`;
  return null;
}

/** JOYA AI's first message to its new session: marked as JOYA AI's, not the administrator's. */
function firstPrompt(h) {
  return (
    `[From JOYA AI -- not the administrator. JOYA AI, the assistant that runs this VPS, hired this session as "${h.name}".]\n\n` +
    `What this session is for:\n${h.purpose}\n\n` +
    "Work in this directory. Destructive actions wait for the administrator's approval in the Command Center. " +
    "When you have something to report, send it to JOYA AI with SendMessage."
  );
}

module.exports = { MAX_LIVE, HIRES_PER_HOUR, LIMIT_BOUNDS, HIRE_MODES, CWD_ROOTS, defaultPermMode, defaultLimits, checkLimits, effectiveLimits, liveCount, slugOf, freeSlug, checkCwd, checkHire, findHired, retireRefusal, firstPrompt };
