"use strict";
/**
 * Thin wrapper around the privileged helper.
 *
 * The dashboard process is unprivileged. Anything requiring root goes through
 * `sudo /usr/local/sbin/joya-helper <subcommand> [args...]`, which is the ONLY
 * command this user is permitted to run via sudo.
 *
 * Arguments are passed as an argv array to spawn -- never concatenated into a
 * shell string -- so user-supplied values cannot escape into a shell. Secrets
 * (bot tokens) and bulk text go over stdin instead of argv, because argv is
 * readable by any local user in /proc while the call runs.
 */

const { spawn } = require("child_process");

const HELPER = "/usr/local/sbin/joya-helper";
const MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Patterns for secrets that must never reach a browser.
 *
 * The runtime is configured not to log bot tokens, but a log view is exactly
 * the wrong place to rely on a single upstream fix: any library that logs a
 * request URL at INFO puts a Telegram token straight into the journal, and from
 * there into a screenshot or a scrollback buffer. Redacting on the way out
 * costs nothing and does not depend on every dependency behaving.
 */
const SECRET_PATTERNS = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,60}\b/g, "«bot-token»"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "«anthropic-key»"],
  [/\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, "«openai-key»"],
  [/\bsk-[A-Za-z0-9]{32,}/g, "«api-key»"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "«github-token»"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "«private-key»"],
  [/\b(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/gi, "$1«token»"],
  [/\b(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(\s*[=:]\s*["']?)[^\s"',;]+/g, "$1$2«token»"],
];

function redact(text) {
  let out = String(text == null ? "" : text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

function callHelper(subcommand, args = [], opts = {}) {
  const { stdin = null, timeout = 20000 } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", HELPER, subcommand, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let overflow = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("the privileged helper timed out"));
      }
    }, timeout);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    child.stdout.on("data", (d) => {
      if (stdout.length > MAX_OUTPUT) {
        overflow = true;
        return;
      }
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });

    child.on("error", (e) => finish(e));

    child.on("close", () => {
      if (overflow) return finish(new Error("helper produced too much output"));
      // The helper reports failure as JSON on stdout with a non-zero exit, so
      // parse stdout first and only fall back to the raw error.
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim().split("\n").pop());
      } catch (_) {
        /* not JSON -- fall through */
      }
      if (parsed && parsed.ok === false) return finish(new Error(parsed.error));
      if (parsed && parsed.ok === true) return finish(null, parsed.data);
      finish(new Error(stderr.trim() || "helper returned unparseable output"));
    });

    if (stdin != null) child.stdin.end(String(stdin));
    else child.stdin.end();
  });
}

const cc = (sub, args = [], opts = {}) => callHelper(sub, args, opts).then(redactDeep);

module.exports = {
  callHelper,

  /* ---------------------------------------------------------------- keys -- */
  listAllKeys: () => callHelper("list-all-keys"),
  listKeys: (user) => callHelper("list-keys", [user]),
  addKey: (user, type, data, comment) =>
    callHelper("add-key", [user, type, data, comment]),
  removeKey: (user, fingerprint) => callHelper("remove-key", [user, fingerprint]),
  status: () => callHelper("status"),
  auditTail: (n = 100) => callHelper("audit-tail", [String(n)]),

  /* -------------------------------------------------------------- agents -- */
  agentList: () => callHelper("agent-list", [], { timeout: 30000 }),
  agentGet: (slug) => callHelper("agent-get", [slug]),

  // Config carries the bot token, so it goes over stdin as JSON.
  agentCreate: (config) =>
    callHelper("agent-create", [], { stdin: JSON.stringify(config), timeout: 90000 }),
  agentUpdate: (config) =>
    callHelper("agent-update", [], { stdin: JSON.stringify(config), timeout: 90000 }),
  // The agent's bot avatar alone: agent.json only, no restart (lib/agent-avatar.js).
  agentAvatar: (slug, avatar) =>
    callHelper("agent-avatar", [], { stdin: JSON.stringify({ slug, avatar }) }),

  agentAction: (slug, action) =>
    callHelper("agent-action", [slug, action], { timeout: 60000 }),
  agentLogs: (slug, lines = 200) =>
    callHelper("agent-logs", [slug, String(lines)], { timeout: 40000 }).then(
      redactDeep
    ),
  agentDelete: (slug) => callHelper("agent-delete", [slug], { timeout: 60000 }),

  /* --------------------------------------------------------------- vault -- */
  agentReadFile: (slug, relpath) => callHelper("agent-read-file", [slug, relpath]),
  agentWriteFile: (slug, relpath, content) =>
    callHelper("agent-write-file", [slug, relpath], { stdin: content }),
  agentVaultList: (slug, subdir) =>
    callHelper("agent-vault-list", subdir ? [slug, subdir] : [slug]),
  // The organised view of a vault: every note (title, type, links, tags, frontmatter
  // properties) and the other files by name and size -- never their content.
  agentVaultIndex: (slug) => callHelper("agent-vault-index", [slug], { timeout: 30000 }).then(redactDeep),

  /* -------------------------------------------------------------- memory -- */
  agentMemoryIndex: (slug, force = false) =>
    callHelper("agent-memory-index", force ? [slug, "--force"] : [slug], {
      timeout: 300000,
    }),
  agentMemorySearch: (slug, query) =>
    callHelper("agent-memory-search", [slug], { stdin: query, timeout: 120000 }),
  agentMemoryStats: (slug) => callHelper("agent-memory-stats", [slug]),
  // The vault as a graph: notes, wikilinks, tags, and similarity from the
  // agent's own index. Redacted by the helper and again here.
  agentMemoryGraph: (slug) =>
    callHelper("agent-memory-graph", [slug], { timeout: 90000 }).then(redactDeep),

  /* ------------------------------------------------------------ channels -- */
  channelList: () => callHelper("channel-list", [], { timeout: 30000 }),
  channelGet: (slug) => callHelper("channel-get", [slug]),
  // With Topics on, the helper waits for the bot to come up (up to 45 s) and,
  // if it does not, puts the old settings back and waits again: allow for both.
  channelCreate: (config) =>
    callHelper("channel-create", [], {
      stdin: JSON.stringify(config),
      timeout: 180000,
    }),
  channelUpdate: (config) =>
    callHelper("channel-update", [], {
      stdin: JSON.stringify(config),
      timeout: 180000,
    }),
  channelTopicsFolders: (slug) => callHelper("channel-topics-folders", [slug]),
  // Telegram Topics ▸ Trash: restore|delete one folder of a deleted topic.
  channelTopicsTrash: (slug, op, trashPath) =>
    callHelper("channel-topics-trash", [slug, op, trashPath], { timeout: 60000 }),
  channelDelete: (slug) => callHelper("channel-delete", [slug], { timeout: 60000 }),

  /* ------------------------------------------------------------ whatsapp -- */
  waStatus: (slug) => callHelper("channel-whatsapp-status", [slug]),
  waLink: (slug) => callHelper("channel-whatsapp-link", [slug], { timeout: 90000 }),
  waUnlink: (slug) => callHelper("channel-whatsapp-unlink", [slug], { timeout: 60000 }),
  waLogs: (slug, lines = 200) =>
    callHelper("channel-whatsapp-logs", [slug, String(lines)], { timeout: 40000 }).then(
      redactDeep
    ),

  /* ------------------------------------------------------------ services -- */
  serviceList: () => callHelper("service-list", [], { timeout: 30000 }),
  serviceAction: (unit, action) =>
    callHelper("service-action", [unit, action], { timeout: 60000 }),
  serviceLogs: (unit, lines = 200) =>
    callHelper("service-logs", [unit, String(lines)], { timeout: 40000 }).then(
      redactDeep
    ),
  // The Machine core's live events. The cursor is the helper's own, handed
  // back unchanged; it goes over stdin because it is structured, not secret.
  pulseFeed: (cursor) =>
    callHelper("pulse-feed", [], { stdin: JSON.stringify({ cursor: cursor || null }), timeout: 15000 }).then(redactDeep),
  pulseTotals: () => callHelper("pulse-feed", ["totals"], { timeout: 30000 }),

  /* ------------------------------------------------------------ firewall -- */
  firewallStatus: () => callHelper("firewall-status", [], { timeout: 30000 }),

  // The requester's own address travels with the request so the helper can
  // refuse to block the person typing. It is a check the browser cannot do:
  // the page does not know which address it reached the server from.
  firewallBan: ({ ip, note, requester }) =>
    callHelper("firewall-ban", [], {
      stdin: JSON.stringify({ ip, note, requester }),
      timeout: 40000,
    }),
  firewallUnban: (ip) =>
    callHelper("firewall-unban", [], {
      stdin: JSON.stringify({ ip }),
      timeout: 40000,
    }),

  /* --------------------------------------------------------- credentials -- */
  credentialList: () => callHelper("credential-list"),
  credentialGet: (name) => callHelper("credential-get", [name]),
  credentialSet: (name, key, value) =>
    callHelper("credential-set", [name, key], { stdin: value }),
  credentialClear: (name, key) => callHelper("credential-clear", [name, key]),

  /* -------------------------------------------------------------- console -- */

  /**
   * Open a long-lived console conversation and hand back the live process.
   *
   * Unlike every other call here this does not resolve with a parsed result.
   * The process stays up between turns -- that is where the conversation's
   * context lives, since `claude -p` persists no transcript to disk -- so the
   * caller writes each message into its stdin and reads events off its stdout
   * for as long as the chat is in use.
   *
   * The configuration goes over stdin rather than argv, and so does every
   * message after it: what the administrator types never appears in the
   * process table.
   */
  consoleOpen: (config) => {
    const child = spawn("sudo", ["-n", HELPER, "console-open"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(JSON.stringify(config) + "\n");
    return child;
  },

  consoleDirs: () => callHelper("console-dirs", [], { timeout: 15000 }),

  consoleUpload: (request) =>
    callHelper("console-upload", [], {
      stdin: JSON.stringify(request),
      timeout: 60000,
    }),

  /* ------------------------------------------------------- openai voice -- */
  // The key goes in over stdin, never argv. voiceKeyRead is the only call that
  // returns it, and only the server's voice config cache uses it.
  /* ------------------------------------------------- chatgpt (broker) -- */
  // JOYA AI Settings > ChatGPT (lib/routes-chatgpt.js). Nothing here carries the
  // sign-in: status says whether it is valid, login-start returns the device link
  // and one-time code, the call log has no task text or answer.
  chatgptStatus: () => callHelper("chatgpt-status", [], { timeout: 60000 }),
  chatgptCalls: (n = 100) => callHelper("chatgpt-calls", [String(n)]),
  chatgptLoginStart: () => callHelper("chatgpt-login-start", [], { timeout: 30000 }),
  chatgptLoginPoll: (id) => callHelper("chatgpt-login-poll", [id], { timeout: 45000 }),
  chatgptLoginCancel: (id) => callHelper("chatgpt-login-cancel", [id]),
  agentChatgpt: (slug, on) => callHelper("agent-chatgpt", [slug, on ? "on" : "off"], { timeout: 60000 }),
  agentRestartIdle: (slug) => callHelper("agent-restart-idle", [slug], { timeout: 60000 }),

  voiceStatus: () => callHelper("voice-status"),
  voiceKeyRead: () => callHelper("voice-key-read"),
  voiceKeySet: (value) => callHelper("voice-key-set", [], { stdin: value }),
  voiceKeyClear: () => callHelper("voice-key-clear"),
  voiceOptionsSet: (model, voice, transcribeModel) =>
    callHelper("voice-options-set", [model, voice, transcribeModel]),
  // (The local transcription server's voice-whisper-* wrappers went with the
  // Transcription setting on 2026-10-30: nothing here starts it any more.)

  // The voiceprint (lib/voiceprint.js): sealed and opened by the helper, whose key never leaves it.
  voiceprintSeal: (plainB64) => callHelper("voiceprint-seal", [], { stdin: JSON.stringify({ plain: plainB64 }) }),
  voiceprintOpen: (sealedB64) => callHelper("voiceprint-open", [], { stdin: JSON.stringify({ sealed: sealedB64 }) }),
  voiceprintForget: (keepKey) => callHelper("voiceprint-forget", keepKey ? ["keep-key"] : []),

  /* ---------------------------------------------------------- claude code -- */

  // Everything from the cc-* commands is redacted twice: once by the helper
  // (its own rules plus memlib's) and again here, because raw transcripts on
  // disk are not redacted and a browser is the last place a token should land.
  // Writes carry the signed-in username so the audit log says who, not just
  // "joyaadmin".
  ccMemoryStats: () => cc("cc-memory-stats", [], { timeout: 30000 }),
  ccMemorySearch: (query, k, project) =>
    cc("cc-memory-search", [], { stdin: JSON.stringify({ query, k, project }), timeout: 45000 }),
  ccMemoryServices: () => cc("cc-memory-services", [], { timeout: 30000 }),
  ccMemoryGraph: (params) =>
    cc("cc-memory-graph", [], { stdin: JSON.stringify(params || {}), timeout: 90000 }),
  ccMemoryRestart: (actor) =>
    cc("cc-memory-restart", [], { stdin: JSON.stringify({ actor }), timeout: 70000 }),
  ccIngestAll: (actor) => cc("cc-ingest-all", [], { stdin: JSON.stringify({ actor }), timeout: 30000 }),
  ccFactsList: (filters) =>
    cc("cc-facts-list", [], { stdin: JSON.stringify(filters || {}), timeout: 30000 }),
  ccMemoryOutline: () => cc("cc-memory-outline", [], { timeout: 30000 }),
  ccFactGet: (id) => cc("cc-fact-get", [String(id)], { timeout: 30000 }),
  ccFactAdd: (fact) => cc("cc-fact-add", [], { stdin: JSON.stringify(fact), timeout: 60000 }),
  ccFactEdit: (fact) => cc("cc-fact-edit", [], { stdin: JSON.stringify(fact), timeout: 60000 }),
  ccFactForget: (request) => cc("cc-fact-forget", [], { stdin: JSON.stringify(request), timeout: 30000 }),
  ccSessionMemory: (uuid, page) =>
    cc("cc-session-memory", [uuid, String(page || 1)], { timeout: 30000 }),
  // Memory by session (Memory > Sessions). Reads: the list and one session's facts and
  // chunks. Writes (claude.memory.manage): hide / unhide / delete items or a whole session.
  ccMmSessions: () => cc("cc-mm-sessions", [], { stdin: "{}", timeout: 60000 }),
  ccMmSession: (params) => cc("cc-mm-session", [], { stdin: JSON.stringify(params || {}), timeout: 60000 }),
  ccMmPreview: (request) => cc("cc-mm-preview", [], { stdin: JSON.stringify(request || {}), timeout: 60000 }),
  ccMmApply: (request) => cc("cc-mm-apply", [], { stdin: JSON.stringify(request || {}), timeout: 120000 }),
  ccMmDeleteSession: (request) =>
    cc("cc-mm-delete-session", [], { stdin: JSON.stringify(request || {}), timeout: 120000 }),
  ccMmReindex: (request) => cc("cc-mm-reindex", [], { stdin: JSON.stringify(request || {}), timeout: 30000 }),
  ccMemfilesList: () => cc("cc-memfiles-list"),
  ccMemfileRead: (project, name) => cc("cc-memfile-read", [project, name]),
  ccMemfileWrite: (project, name, content, actor) =>
    cc("cc-memfile-write", [project, name], {
      stdin: JSON.stringify({ content, actor }),
      timeout: 30000,
    }),
  ccHooksTail: (n = 50) => cc("cc-hooks-tail", [String(n)]),
  ccSessionsList: (filters) =>
    cc("cc-sessions-list", [], { stdin: JSON.stringify(filters || {}), timeout: 120000 }),
  ccSessionGet: (home, uuid, opts) =>
    cc("cc-session-get", [home, uuid], { stdin: JSON.stringify(opts || {}), timeout: 90000 }),
  ccSessionRename: (home, uuid, title, actor) =>
    cc("cc-session-rename", [home, uuid], { stdin: JSON.stringify({ title, actor }), timeout: 30000 }),
  ccSessionArchive: (home, uuid, actor) =>
    cc("cc-session-archive", [home, uuid], { stdin: JSON.stringify({ actor }), timeout: 30000 }),
  ccSessionRestore: (home, uuid, actor) =>
    cc("cc-session-restore", [home, uuid], { stdin: JSON.stringify({ actor }), timeout: 30000 }),
  ccRunning: () => cc("cc-running", [], { timeout: 30000 }),
  ccStop: (pid, force, actor) =>
    cc("cc-stop", [], { stdin: JSON.stringify({ pid, force: !!force, actor }), timeout: 20000 }),

  /* -------------------------------------------------------------- probes -- */
  systemProbe: () => callHelper("system-probe", [], { timeout: 30000 }),

  redact,
  redactDeep,
};
