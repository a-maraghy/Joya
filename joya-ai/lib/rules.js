"use strict";
/**
 * Approval rules: the administrator's standing answers to the gate.
 *
 * The gate (hooks/gate.js) asks about anything the classifier calls
 * destructive. Rules let the administrator answer some of those questions once:
 *
 *   allow  run it without a card ("Always allow this" on an approval card)
 *   ask    always raise a card, even when the classifier would not
 *   deny   never run it; the model is told so and must not route around it
 *
 * Order, first match wins at each step:
 *
 *   1. a built-in deny (force pushes, pushing the client repository)
 *   2. a deny from the configuration (the delegation allow-list)
 *   3. one of the administrator's deny rules
 *   4. a built-in ask (anything touching live Odoo) -- no allow rule overrides it
 *   5. the administrator's allow / ask rules: the most specific pattern wins,
 *      and on a tie ask beats allow
 *   6. the classifier: ask for anything destructive
 *   7. nothing: the normal permission flow
 *
 * Built-ins live in code, so they hold even if the rules store cannot be read;
 * they are also stored as rows (builtin = 1) so the page can list them and
 * count their uses, and the socket refuses to edit or delete those rows.
 *
 * Patterns are globs: `*` is any text, `\*` a literal star, everything else
 * literal. A Bash rule matches the whole command (an allow rule never matches
 * one part of a compound command); deny and ask rules also match any single
 * command inside it. A SendMessage rule matches "<target>: <message>".
 *
 * Phase 1 scope: every rule applies to JOYA AI's own gate on this machine
 * (scope_session "joya-ai", scope_machine "this"). Rules for other sessions
 * are a phase 2 question.
 */

const classifier = require("./classifier");

const EFFECTS = ["allow", "ask", "deny"];
const TOOLS = ["Bash", "SendMessage", "any"];
const MAX_PATTERN = 2000;

/* ------------------------------------------------------------- built-ins --- */

const GIT_PUSH_RE = /\bgit\b[^;&|\n]*?\bpush\b([^;&|\n]*)/g;
const FORCE_RE = /(^|\s)(--force(-with-lease|-if-includes)?\b|-[A-Za-z]*f[A-Za-z]*\b|\+\S)/;
const CLIENT_REPO_RE = /gizaseeds-Odoo19|\/opt\/odoo\/custom\b/i;
const LIVE_ODOO_RE = /test\.gizaseeds\.cloud|\/root\/rpcwork\/rpc\.py/i;

const BUILTINS = [
  {
    key: "no-force-push",
    effect: "deny",
    tool: "any",
    pattern: "git push --force*  (also -f, --force-with-lease, +refspec)",
    note: "Never force-push, anywhere.",
    test: (text) => {
      for (const m of String(text).matchAll(GIT_PUSH_RE)) if (FORCE_RE.test(m[1])) return true;
      return false;
    },
  },
  {
    key: "no-client-repo-push",
    effect: "deny",
    tool: "any",
    pattern: "git push * a-maraghy/gizaseeds-Odoo19  (or in /opt/odoo/custom)",
    note: "Never push to the client repository; its deploy key is read-only by design.",
    test: (text) => /\bgit\b[^;&|\n]*?\bpush\b/.test(String(text)) && CLIENT_REPO_RE.test(String(text)),
  },
  {
    key: "ask-live-odoo",
    effect: "ask",
    tool: "any",
    // Worded without the host: the Command Center does not show the live
    // server anywhere, but the gate still guards it.
    pattern: "anything touching the live production server (its host or RPC client)",
    note: "Always ask first. The live server stays read-only unless the administrator says otherwise; no rule can allow it.",
    hard: true,
    test: (text) => LIVE_ODOO_RE.test(String(text)),
  },
  {
    key: "classifier",
    effect: "ask",
    tool: "any",
    pattern: "destructive (gate classifier)",
    note: "Ask before deleting, stopping services, database writes, kill, chmod or credentials, and before telling a session to.",
    display: true, // listed and counted; matching is the classifier's, step 6
  },
];

/* --------------------------------------------------------------- patterns --- */

function globToRegex(pattern) {
  let re = "";
  const p = String(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && p[i + 1] === "*") {
      re += "\\*";
      i++;
    } else if (c === "*") re += "[\\s\\S]*";
    else re += c.replace(/[.+?^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** How specific a pattern is: the literal characters in it. */
function specificity(pattern) {
  return String(pattern).replace(/\\\*/g, "#").replace(/\*/g, "").length;
}

/** A pattern that matches exactly this text and nothing else. */
function exactPattern(text) {
  return String(text).trim().replace(/\\/g, "\\\\").replace(/\*/g, "\\*");
}

function checkPattern(p) {
  if (typeof p !== "string") throw new Error("pattern must be text");
  const t = p.trim();
  if (!t) throw new Error("pattern is empty");
  if (t.length > MAX_PATTERN) throw new Error(`pattern is longer than ${MAX_PATTERN} characters`);
  if (t.includes("\u0000")) throw new Error("pattern contains a NUL byte");
  if (!/[^*\s]/.test(t)) throw new Error("a pattern must contain some literal text, not only *");
  return t;
}

/* -------------------------------------------------------------- subjects --- */

const BASH_TOOLS = new Set(["Bash", "Monitor", "PowerShell"]);

/** What a rule is matched against for this call, or null if rules do not apply. */
function subjectOf(tool, input) {
  const i = input || {};
  if (BASH_TOOLS.has(tool)) {
    const cmd = typeof i.command === "string" ? i.command : JSON.stringify(i);
    return { kind: "Bash", text: cmd.trim(), parts: segments(cmd) };
  }
  if (tool === "SendMessage") {
    const to = bare(i.to);
    const msg = String(i.message == null ? "" : i.message).trim();
    return { kind: "SendMessage", text: `${to}: ${msg}`, parts: [], body: msg };
  }
  return null;
}

function bare(to) {
  return String(to || "").replace(/\s*\[[0-9a-f]+\]\s*$/i, "").trim();
}

/** Each simple command inside a compound one, as text. */
function segments(cmd) {
  try {
    return classifier
      .splitCommands(cmd)
      .map((c) => c.words.join(" ").trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Does a stored rule apply to this gate? JOYA AI's gate (session "joya-ai") uses
 * its own rules. A hired session's gate (session "hired.<slug>", M-6) uses the
 * rules scoped to it, and of JOYA AI's only the deny and ask ones -- never an
 * "Always allow" JOYA AI was given: a hired session inherits no approvals.
 */
function ruleApplies(rule, kind, session) {
  const me = session || "joya-ai";
  const scope = rule.scope_session || "joya-ai";
  if (me === "joya-ai") {
    if (scope !== "joya-ai") return false;
  } else if (scope !== me && !(scope === "joya-ai" && rule.effect !== "allow")) return false;
  if (rule.scope_machine && rule.scope_machine !== "this") return false;
  return rule.tool === "any" || rule.tool === kind;
}

function userMatch(rule, subject) {
  let re;
  try {
    re = globToRegex(rule.pattern);
  } catch (_) {
    return false;
  }
  if (re.test(subject.text)) return true;
  // deny and ask also catch one command inside a compound; allow never does
  if (rule.effect !== "allow") return subject.parts.some((p) => re.test(p));
  return false;
}

/* ------------------------------------------------------------ evaluation --- */

/**
 * Decide one call.
 *   rules: the stored rows (builtin rows are ignored here; code applies them)
 *   cfg:   the supervisor config (delegation_allow)
 * Returns { decision: allow|ask|deny|none, source, rule, builtin, classifier, explain }.
 */
function evaluate(tool, input, rules, cfg = {}, opts = {}) {
  const subject = subjectOf(tool, input);
  const gate = classifier.gateDecision(tool, input, cfg);
  const cls = gate ? { destructive: gate.decision === "ask", decision: gate.decision, category: gate.category, label: gate.label, reason: gate.reason } : null;
  const out = (decision, source, extra) => ({ decision, source, rule: null, builtin: null, classifier: cls, ...extra });

  if (subject) {
    const hay = subject.kind === "SendMessage" ? subject.body : subject.text;
    for (const b of BUILTINS) {
      if (b.display || b.effect !== "deny") continue;
      if (b.test(hay)) return out("deny", "builtin", { builtin: b.key, explain: `Built-in rule: ${b.note}` });
    }
  }
  if (gate && gate.decision === "deny") return out("deny", "config", { explain: gate.label + ": " + gate.reason });
  if (!subject) {
    return gate ? out(gate.decision, "classifier", { explain: gate.label + ": " + gate.reason }) : out("none", "none", { explain: "No rule applies to this tool." });
  }

  const mine = (rules || []).filter((r) => r && !r.builtin && EFFECTS.includes(r.effect) && ruleApplies(r, subject.kind, opts.session));
  const denies = mine.filter((r) => r.effect === "deny" && userMatch(r, subject));
  if (denies.length) {
    const r = denies.sort((a, b) => specificity(b.pattern) - specificity(a.pattern))[0];
    return out("deny", "rule", { rule: r, explain: `Rule #${r.id}: never allow.` });
  }
  const hay = subject.kind === "SendMessage" ? subject.body : subject.text;
  for (const b of BUILTINS) {
    if (b.display || b.effect !== "ask") continue;
    if (b.test(hay)) return out("ask", "builtin", { builtin: b.key, explain: `Built-in rule: ${b.note}` });
  }
  const hits = mine.filter((r) => r.effect !== "deny" && userMatch(r, subject));
  if (hits.length) {
    hits.sort((a, b) => specificity(b.pattern) - specificity(a.pattern) || (a.effect === "ask" ? -1 : 1) - (b.effect === "ask" ? -1 : 1));
    const r = hits[0];
    return out(r.effect, "rule", { rule: r, explain: `Rule #${r.id}: always ${r.effect}.` });
  }
  if (gate) return out(gate.decision, "classifier", { explain: gate.label + ": " + gate.reason });
  return out("none", "none", { explain: "No rule matches and the classifier sees nothing destructive: it runs." });
}

/** The narrow "Always allow this" rule for an approval card. */
function suggestion(tool, input) {
  const subject = subjectOf(tool, input);
  if (!subject) return null;
  return {
    effect: "allow",
    tool: subject.kind,
    pattern: exactPattern(subject.text),
    scope_session: "joya-ai",
    scope_machine: "this",
    note: subject.kind === "Bash" ? "Always allow exactly this command for JOYA AI on this VPS." : "Always allow exactly this message to this session.",
  };
}

/** Would an allow rule with this pattern override a built-in or a deny? Refuse those up front. */
const PROBES = ["", "--force origin main", "-f", "origin a-maraghy/gizaseeds-Odoo19"];
function checkAllowable(rule) {
  if (rule.effect !== "allow") return;
  // Evaluation would let the built-in win anyway; refusing here tells the
  // administrator up front instead of leaving a rule that never applies.
  for (const fill of PROBES) {
    const probe = rule.pattern.replace(/(^|[^\\])\*/g, (m, pre) => pre + fill).replace(/\\\*/g, "*");
    for (const b of BUILTINS) {
      // only the denies: the built-in ask always wins at evaluation anyway,
      // and refusing every trailing * because it could match a URL helps nobody
      if (b.display || b.effect !== "deny") continue;
      if (b.test(probe)) throw new Error(`an allow rule cannot cover what the built-in rule "${b.key}" guards`);
    }
  }
}

function validateRule(r, { partial = false } = {}) {
  const out = {};
  if (!partial || r.effect !== undefined) {
    if (!EFFECTS.includes(r.effect)) throw new Error("effect must be allow, ask or deny");
    out.effect = r.effect;
  }
  if (!partial || r.tool !== undefined) {
    if (!TOOLS.includes(r.tool)) throw new Error("tool must be Bash, SendMessage or any");
    out.tool = r.tool;
  }
  if (!partial || r.pattern !== undefined) out.pattern = checkPattern(r.pattern);
  if (r.note !== undefined) {
    if (typeof r.note !== "string" || r.note.length > 500) throw new Error("note must be at most 500 characters");
    out.note = r.note.trim();
  }
  return out;
}

module.exports = {
  BUILTINS,
  EFFECTS,
  TOOLS,
  globToRegex,
  specificity,
  exactPattern,
  checkPattern,
  subjectOf,
  evaluate,
  suggestion,
  checkAllowable,
  validateRule,
};
