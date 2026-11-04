"use strict";
/**
 * The catalogue of add-ons an agent or a channel can have.
 *
 * Every entry maps to configuration the runtime actually reads. That constraint
 * is the whole point: a catalogue of capabilities that do not exist is worse
 * than no catalogue, because it takes a support request to discover the switch
 * did nothing. Each `env` block below was checked against the runtime's
 * Settings model, not against its documentation -- the docs list a couple of
 * flags (image uploads, session export) that were never implemented.
 *
 * Scope:
 *   channel  how messages arrive and what the agent can receive
 *   agent    what the agent itself can do once it has the message
 */

const WHISPER_BIN = "/opt/joya-agents/shared/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL = "/opt/joya-agents/shared/whisper.cpp/models/ggml-base.bin";

const ADDONS = [
  /* ------------------------------------------------------------ channel -- */
  {
    id: "voice_notes",
    name: "Voice notes",
    scope: "channel",
    category: "Input",
    icon: "voice",
    default: true,
    summary: "Transcribe voice messages so you can talk to the agent instead of typing.",
    detail:
      "Audio is converted with ffmpeg and transcribed by whisper.cpp running on this " +
      "server. No API key, no per-minute cost, and the recording never leaves the box.",
    keywords: ["voice", "audio", "speech", "transcribe", "whisper", "dictation", "talk"],
    requires: [
      { kind: "file", path: WHISPER_BIN, label: "whisper.cpp binary" },
      { kind: "file", path: WHISPER_MODEL, label: "whisper model" },
      { kind: "binary", name: "ffmpeg", label: "ffmpeg" },
    ],
    env: {
      ENABLE_VOICE_MESSAGES: "true",
      VOICE_PROVIDER: "local",
      WHISPER_CPP_BINARY_PATH: WHISPER_BIN,
      WHISPER_CPP_MODEL_PATH: WHISPER_MODEL,
      VOICE_MAX_FILE_SIZE_MB: "20",
    },
    envOff: { ENABLE_VOICE_MESSAGES: "false" },
  },
  {
    id: "file_capture",
    name: "File capture",
    scope: "channel",
    category: "Input",
    icon: "file",
    default: true,
    summary:
      "Accept spreadsheets, PDFs, documents and data files, and save them into the agent's workspace.",
    detail:
      "Uploads land in attachments/inbox/<date>/ and the agent is given the path, so it " +
      "can open a spreadsheet with pandas or pull the text out of a PDF. Files stay put, " +
      "so you can ask a follow-up question tomorrow without re-sending them.",
    keywords: ["file", "upload", "excel", "xlsx", "csv", "pdf", "word", "docx", "document", "attachment", "spreadsheet"],
    env: { ENABLE_FILE_UPLOADS: "true", ATTACHMENT_MAX_SIZE_MB: "20" },
    envOff: { ENABLE_FILE_UPLOADS: "false" },
  },
  {
    id: "image_capture",
    name: "Image capture",
    scope: "channel",
    category: "Input",
    icon: "image",
    default: true,
    summary: "Read photos sent in chat, and keep a copy in the workspace.",
    detail:
      "The agent sees the image directly, which is what makes it useful now. The saved " +
      "copy is what makes it useful later — without it a photo exists for one turn and " +
      "you have to send it again to ask a second question.",
    keywords: ["image", "photo", "picture", "screenshot", "vision", "camera", "scan"],
    env: { SAVE_PHOTOS_TO_WORKSPACE: "true" },
    envOff: { SAVE_PHOTOS_TO_WORKSPACE: "false" },
  },
  {
    id: "stream_drafts",
    name: "Live typing",
    scope: "channel",
    category: "Experience",
    icon: "clock",
    default: false,
    summary: "Stream the reply as it is written instead of sending it all at once.",
    detail:
      "Feels faster on long answers. It costs one message edit every few hundred " +
      "milliseconds, so on a busy group it can bump into Telegram's rate limits.",
    keywords: ["stream", "typing", "live", "draft", "realtime", "progressive"],
    env: { ENABLE_STREAM_DRAFTS: "true", STREAM_DRAFT_INTERVAL: "0.3" },
    envOff: { ENABLE_STREAM_DRAFTS: "false" },
  },
  {
    id: "quick_actions",
    name: "Quick actions",
    scope: "channel",
    category: "Experience",
    icon: "addons",
    default: true,
    summary: "Inline buttons for common follow-ups under the agent's replies.",
    detail: "Useful on a phone, where tapping beats typing. Adds a little chrome to every message.",
    keywords: ["buttons", "inline", "keyboard", "shortcuts", "actions", "quick"],
    env: { ENABLE_QUICK_ACTIONS: "true" },
    envOff: { ENABLE_QUICK_ACTIONS: "false" },
  },

  /* -------------------------------------------------------------- agent -- */
  {
    id: "memory",
    name: "Vector memory",
    scope: "agent",
    category: "Core",
    icon: "memory",
    default: true,
    locked: true,
    summary:
      "The Obsidian vault plus a local vector index the agent searches before answering.",
    detail:
      "CLAUDE.md and MEMORY.md go into the system prompt on every request; the notes they " +
      "point at are embedded locally and retrieved on demand. This is what makes an agent " +
      "survive a session reset, so it cannot be turned off.",
    keywords: ["memory", "vector", "obsidian", "recall", "notes", "embeddings", "rag", "search"],
    env: {
      ENABLE_PERSISTENT_MEMORY: "true",
      MEMORY_SCAFFOLD_ON_START: "true",
      CONTEXT_FILE_MAX_CHARS: "24000",
      ENABLE_MCP: "true",
    },
  },
  {
    id: "git",
    name: "Git",
    scope: "agent",
    category: "Development",
    icon: "git",
    default: true,
    summary: "Let the agent read git state and work with repositories in its workspace.",
    detail: "Enables the /repo command and lets the agent reason about branches, diffs and history.",
    keywords: ["git", "repo", "version", "commit", "branch", "github", "diff"],
    env: { ENABLE_GIT_INTEGRATION: "true" },
    envOff: { ENABLE_GIT_INTEGRATION: "false" },
  },
  {
    id: "scheduler",
    name: "Scheduled jobs",
    scope: "agent",
    category: "Automation",
    icon: "clock",
    default: false,
    summary: "Let the agent run work on a cron schedule and message you with the result.",
    detail:
      "Nightly summaries, morning briefings, periodic checks. Jobs persist in the agent's " +
      "database, so they survive a restart.",
    keywords: ["schedule", "cron", "recurring", "timer", "automation", "daily", "job"],
    env: { ENABLE_SCHEDULER: "true" },
    envOff: { ENABLE_SCHEDULER: "false" },
  },
  {
    id: "webhooks",
    name: "Webhooks",
    scope: "agent",
    category: "Automation",
    icon: "webhook",
    default: false,
    summary: "Give the agent an HTTP endpoint so other systems can trigger it.",
    detail:
      "Starts a local API server for the agent. GitHub events are verified by HMAC; " +
      "everything else needs a bearer token. Bind it behind nginx before exposing anything.",
    keywords: ["webhook", "api", "http", "trigger", "github", "ci", "integration", "endpoint"],
    env: { ENABLE_API_SERVER: "true" },
    envOff: { ENABLE_API_SERVER: "false" },
    fields: [
      { name: "API_SERVER_PORT", label: "Port", type: "number", default: "8080" },
    ],
  },
  {
    id: "telemetry",
    name: "Usage telemetry",
    scope: "agent",
    category: "Operations",
    icon: "overview",
    default: false,
    summary: "Record token and cost accounting per request in the agent's database.",
    detail: "Local only — nothing is sent anywhere. Useful when you run several agents and want to know which one is expensive.",
    keywords: ["telemetry", "usage", "cost", "tokens", "metrics", "accounting", "stats"],
    env: { ENABLE_TELEMETRY: "true" },
    envOff: { ENABLE_TELEMETRY: "false" },
  },
];

/** System services the OS dashboard can start, stop and inspect. */
const OS_SERVICES = [
  { unit: "joya-dashboard", name: "Admin dashboard", icon: "overview", critical: true,
    detail: "This panel. Restarting it drops your session for a second or two." },
  { unit: "nginx", name: "Web server", icon: "shield", critical: true,
    detail: "Terminates TLS on :8443 and proxies to the panel. Stopping it takes the panel offline." },
  { unit: "ssh", name: "SSH", icon: "keys", critical: true,
    detail: "Remote shell access. Stopping it locks you out of the server." },
  { unit: "fail2ban", name: "fail2ban", icon: "shield", critical: false,
    detail: "Bans IPs that fail authentication repeatedly, on both SSH and this panel." },
  { unit: "ufw", name: "Firewall", icon: "shield", critical: true,
    detail: "Host firewall. Everything except SSH, HTTPS and ACME is closed." },
  { unit: "xrdp", name: "Remote desktop", icon: "devices", critical: false,
    detail: "The desktop you reach over an SSH tunnel to run Obsidian." },
  { unit: "xrdp-sesman", name: "RDP session manager", icon: "devices", critical: false,
    detail: "Session broker for xrdp. Needed for remote desktop logins." },
  // Reported, not controlled: the helper refuses to act on these (READONLY_UNITS).
  { unit: "odoo", name: "Odoo 19", icon: "activity", critical: false, readonly: true,
    detail: "The trial Odoo on :8444. Shown here so its state is visible; it is managed outside the panel." },
  { unit: "postgresql@16-main", name: "PostgreSQL 16", icon: "network", critical: false, readonly: true,
    detail: "Holds the Odoo database and the memory service's claude_memory. Managed outside the panel." },
  { unit: "claude-memory", name: "Memory service", icon: "memory", critical: false, readonly: true,
    detail: "Embeddings and search for Claude Code's long-term memory. Restart it from Claude Code › Memory." },
  { unit: "joya-ai", name: "JOYA AI", icon: "core", critical: false, readonly: true,
    detail: "The supervisor of JOYA AI's Claude Code session. Restart it from the Command Center." },
];

function byScope(scope) {
  return ADDONS.filter((a) => a.scope === scope);
}

function byId(id) {
  return ADDONS.find((a) => a.id === id) || null;
}

/**
 * Free-text search across the catalogue.
 * Matching on keywords as well as prose is what lets "excel" find File capture.
 */
function search(query, scope) {
  const pool = scope ? byScope(scope) : ADDONS;
  const q = String(query || "").trim().toLowerCase();
  if (!q) return pool;
  const terms = q.split(/\s+/).filter(Boolean);
  return pool
    .map((a) => {
      const hay = [
        a.name.toLowerCase(),
        a.category.toLowerCase(),
        a.summary.toLowerCase(),
        a.detail.toLowerCase(),
        a.keywords.join(" "),
      ].join(" ");
      let score = 0;
      for (const t of terms) {
        if (a.name.toLowerCase().includes(t)) score += 4;
        if (a.keywords.some((k) => k === t)) score += 3;
        if (hay.includes(t)) score += 1;
      }
      return { addon: a, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.addon);
}

/**
 * Turn a set of enabled add-on ids into environment variables.
 * Disabled add-ons contribute their `envOff` block so that turning something off
 * writes an explicit false rather than leaving the previous value in place.
 */
function envFor(enabledIds, scope, overrides = {}) {
  const enabled = new Set(enabledIds || []);
  const env = {};
  for (const addon of scope ? byScope(scope) : ADDONS) {
    const on = addon.locked || enabled.has(addon.id);
    Object.assign(env, on ? addon.env || {} : addon.envOff || {});
    if (on && addon.fields) {
      for (const field of addon.fields) {
        const value = overrides[field.name];
        env[field.name] = value != null && value !== "" ? String(value) : field.default;
      }
    }
  }
  return env;
}

/** Ids that are on by default — used when creating something new. */
function defaultsFor(scope) {
  return byScope(scope)
    .filter((a) => a.default || a.locked)
    .map((a) => a.id);
}

function categories(scope) {
  const out = [];
  for (const a of byScope(scope)) if (!out.includes(a.category)) out.push(a.category);
  return out;
}

module.exports = {
  ADDONS,
  OS_SERVICES,
  byScope,
  byId,
  search,
  envFor,
  defaultsFor,
  categories,
  WHISPER_BIN,
  WHISPER_MODEL,
};
