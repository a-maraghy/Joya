/**
 * WhatsApp transport for a JOYA agent.
 *
 * One process per WhatsApp channel. It owns a linked-device session (the same
 * mechanism as WhatsApp Web), and hands every incoming message to the Claude
 * Agent SDK pointed at the agent's own vault — the same workspace, the same
 * memory MCP server, the same files as that agent's Telegram side. An agent
 * that gains a WhatsApp channel does not become a different agent.
 *
 * Configuration arrives entirely through the environment, written by the
 * dashboard's privileged helper. Nothing here reads user input to decide what
 * to run.
 *
 * A caution worth repeating in the code that does it: WhatsApp has no official
 * API for this. Linking a number with an unofficial library is against their
 * terms of service and the number can be banned without warning. That is a
 * decision for whoever runs this, but it should be a knowing one.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState,
} from "baileys";
import QRCode from "qrcode";
import { query } from "@anthropic-ai/claude-agent-sdk";

/* ------------------------------------------------------------------ config */

const SLUG = required("JOYA_CHANNEL_SLUG");
const CHANNEL_DIR = required("JOYA_CHANNEL_DIR");
const VAULT = required("JOYA_AGENT_VAULT");
const MCP_CONFIG = process.env.JOYA_MCP_CONFIG || "";
const AGENT_NAME = process.env.JOYA_AGENT_NAME || SLUG;
const MODEL = process.env.JOYA_MODEL || "claude-opus-5";
const MAX_TURNS = Number(process.env.JOYA_MAX_TURNS || 100);
const WHISPER_BIN = process.env.WHISPER_CPP_BINARY_PATH || "";
const WHISPER_MODEL = process.env.WHISPER_CPP_MODEL_PATH || "";
const VOICE_ENABLED = process.env.ENABLE_VOICE_MESSAGES !== "false" && !!WHISPER_BIN;
const FILES_ENABLED = process.env.ENABLE_FILE_UPLOADS !== "false";
const MAX_ATTACHMENT_BYTES =
  Number(process.env.ATTACHMENT_MAX_SIZE_MB || 20) * 1024 * 1024;

// Empty means nobody, deliberately. An agent reachable by any number that
// happens to message it is not a useful default.
const ALLOWED = (process.env.JOYA_ALLOWED_NUMBERS || "")
  .split(",")
  .map((n) => n.replace(/[^\d]/g, ""))
  .filter(Boolean);

const SESSION_DIR = path.join(CHANNEL_DIR, "session");
const RUNTIME_FILE = path.join(CHANNEL_DIR, "runtime.json");
const SESSIONS_FILE = path.join(CHANNEL_DIR, "sessions.json");

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set; this process is started by the JOYA panel.`);
    process.exit(2);
  }
  return value;
}

function log(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), channel: SLUG, event, ...extra }));
}

/* --------------------------------------------------------------- state io */

/** The panel reads this file to show link status and the QR code. */
async function writeRuntime(patch) {
  let current = {};
  try {
    current = JSON.parse(await fsp.readFile(RUNTIME_FILE, "utf8"));
  } catch (_) {
    /* first write */
  }
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  const tmp = RUNTIME_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, RUNTIME_FILE);
  return next;
}

/**
 * Claude session ids, one per WhatsApp conversation.
 * Persisted so a restart does not lose the thread; the vault is the durable
 * memory, but losing the session id means losing the working context.
 */
async function readSessions() {
  try {
    return JSON.parse(await fsp.readFile(SESSIONS_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

async function writeSessions(map) {
  const tmp = SESSIONS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(map, null, 2));
  await fsp.rename(tmp, SESSIONS_FILE);
}

function loadMcpServers() {
  if (!MCP_CONFIG) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8"));
    return parsed.mcpServers || {};
  } catch (e) {
    log("mcp_config_unreadable", { error: e.message });
    return {};
  }
}

/* ------------------------------------------------------------ attachments */

const MAX_NAME_LEN = 96;

/** Mirrors the Python runtime's safe_name: the filename is untrusted input. */
function safeName(raw, fallback = "upload") {
  let name = String(raw || "").replace(/\\/g, "/").split("/").pop() || "";
  name = name.normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
  name = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (!name) name = fallback;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.slice(0, MAX_NAME_LEN);
  const ext = name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  let stem = name.slice(0, dot).slice(0, MAX_NAME_LEN - ext.length - 1);
  stem = stem.replace(/^[-._]+|[-._]+$/g, "") || fallback;
  return ext ? `${stem}.${ext}` : stem;
}

async function inboxPath(filename) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(VAULT, "attachments", "inbox", day);
  await fsp.mkdir(dir, { recursive: true });
  const base = safeName(filename);
  let candidate = path.join(dir, base);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

const KIND_HINTS = {
  spreadsheet:
    "Read it with pandas (pd.read_excel / pd.read_csv). List the sheets and columns before drawing conclusions.",
  document: "Extract the text before answering, and quote what you rely on.",
  image: "Look at the image with the Read tool before answering.",
  audio: "Transcribe it if you need the contents.",
  video: "Inspect it with ffprobe/ffmpeg if you need details.",
  archive: "Unpack it into a subfolder next to the archive before reading.",
  file: "Open it with whatever tool suits the format.",
};

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if ([".xlsx", ".xls", ".xlsm", ".csv", ".tsv", ".ods"].includes(ext)) return "spreadsheet";
  if ([".pdf", ".doc", ".docx", ".odt", ".rtf", ".epub", ".ppt", ".pptx"].includes(ext))
    return "document";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".opus", ".flac"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi"].includes(ext)) return "video";
  if ([".zip", ".tar", ".gz", ".tgz", ".7z"].includes(ext)) return "archive";
  return "file";
}

/* ---------------------------------------------------------------- whisper */

function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().slice(0, 300) || `${cmd} exited ${code}`));
    });
  });
}

/** Same pipeline the Python runtime uses: ffmpeg to 16k mono WAV, then whisper.cpp. */
async function transcribe(oggPath) {
  const wav = oggPath.replace(/\.[^.]+$/, "") + ".wav";
  await run("ffmpeg", ["-loglevel", "error", "-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  try {
    const out = await run(WHISPER_BIN, ["-m", WHISPER_MODEL, "-f", wav, "--no-timestamps", "-l", "auto"]);
    return out.trim();
  } finally {
    fs.promises.unlink(wav).catch(() => {});
  }
}

/* ------------------------------------------------------------------ claude */

let mcpServers = loadMcpServers();

const SYSTEM_APPEND = `
You are ${AGENT_NAME}, reached over WhatsApp. Replies are read on a phone, so be
brief and direct — no headings, no long bullet lists, no code blocks unless the
user asked for code. Your working directory is your own vault; CLAUDE.md and
MEMORY.md there are your identity and your memory, and the memory tools are how
you keep them. Files people send you are saved under attachments/inbox/.
`.trim();

async function ask(prompt, sessionId) {
  const options = {
    cwd: VAULT,
    model: MODEL,
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
    systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
    mcpServers,
  };
  // Resuming keeps the working context; the vault keeps the durable memory.
  if (sessionId) options.resume = sessionId;

  let text = "";
  let newSession = sessionId || null;
  let failed = null;

  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") {
      for (const block of message.message?.content || []) {
        if (block.type === "text" && block.text) text += block.text;
      }
      if (message.session_id) newSession = message.session_id;
    } else if (message.type === "result") {
      if (message.session_id) newSession = message.session_id;
      if (message.subtype === "success") {
        // The result string is the authoritative final answer; assistant blocks
        // may include intermediate narration between tool calls.
        if (message.result) text = message.result;
      } else {
        failed = message.subtype;
      }
    }
  }

  if (failed && !text) throw new Error("the agent could not finish: " + failed);
  return { text: text.trim(), sessionId: newSession };
}

/* -------------------------------------------------------------- whatsapp */

function numberOf(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/[^\d]/g, "");
}

/**
 * The phone number behind a message, which is not always in the chat's address.
 *
 * WhatsApp now addresses many chats by LID -- `<opaque digits>@lid` -- rather
 * than by phone number. A LID looks like a number and is not one: taking the
 * digits out of the address gets you something like 129789717430357, which
 * matches no allow-list and is rejected. That is why a linked number could sit
 * there sending messages to silence.
 *
 * Three sources, in order of how directly they answer the question: the address
 * itself when it is a phone number, the phone number the message carries
 * alongside a LID, and failing both, the mapping Baileys keeps between the two.
 */
async function senderNumber(sock, msg) {
  const jid = msg.key?.remoteJid || "";

  if (jid.endsWith("@s.whatsapp.net")) return numberOf(jid);

  // Present on LID-addressed messages; the field is written by Baileys even
  // where its type definitions do not mention it.
  const carried = msg.key?.senderPn || msg.key?.participantPn || msg.participantPn;
  if (carried) return numberOf(carried);

  if (jid.endsWith("@lid")) {
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) return numberOf(pn);
    } catch (err) {
      log("lid_lookup_failed", { error: String(err?.message || err).slice(0, 200) });
    }
  }

  return numberOf(jid);
}

function allowed(number) {
  if (!ALLOWED.length) return false;
  const n = String(number || "");
  if (!n) return false;
  // Match on suffix so a stored number works whether or not it carries a
  // country code the way WhatsApp reports it.
  return ALLOWED.some((a) => a === n || n.endsWith(a) || a.endsWith(n));
}

async function extractPrompt(sock, msg) {
  const content = msg.message || {};
  const type = getContentType(content);
  const caption = content[type]?.caption || "";

  if (type === "conversation") return { text: content.conversation || "" };
  if (type === "extendedTextMessage") return { text: content.extendedTextMessage?.text || "" };

  const mediaTypes = {
    imageMessage: "image",
    documentMessage: "document",
    videoMessage: "video",
    audioMessage: "audio",
    stickerMessage: "sticker",
  };
  if (!mediaTypes[type]) {
    return { text: "", unsupported: type || "unknown" };
  }

  const node = content[type] || {};
  const size = Number(node.fileLength || 0);
  if (size && size > MAX_ATTACHMENT_BYTES) {
    return { error: `That file is ${(size / 1024 / 1024).toFixed(1)}MB. The limit is ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)}MB.` };
  }

  const isVoice = type === "audioMessage" && node.ptt === true;
  if (isVoice && !VOICE_ENABLED) {
    return { error: "Voice notes are not enabled on this channel." };
  }
  if (!isVoice && !FILES_ENABLED) {
    return { error: "File uploads are not enabled on this channel." };
  }

  const buffer = await downloadMediaMessage(msg, "buffer", {}, {
    reuploadRequest: sock.updateMediaMessage,
  });

  if (isVoice) {
    const tmp = path.join(os.tmpdir(), `wa-voice-${Date.now()}.ogg`);
    await fsp.writeFile(tmp, buffer);
    try {
      const transcript = await transcribe(tmp);
      if (!transcript) return { error: "That voice note came back empty." };
      return { text: `${caption || "Voice message"}:\n\n${transcript}` };
    } finally {
      fsp.unlink(tmp).catch(() => {});
    }
  }

  const fallbackExt = { image: "jpg", video: "mp4", audio: "ogg", sticker: "webp" }[
    mediaTypes[type]
  ];
  const name =
    node.fileName || `${mediaTypes[type]}-${Date.now()}.${fallbackExt || "bin"}`;
  const target = await inboxPath(name);
  await fsp.writeFile(target, buffer);
  const kind = kindOf(target);
  log("attachment_saved", { path: target, kind, bytes: buffer.length });

  return {
    text: [
      caption.trim() || "The user sent you a file.",
      "",
      `**File saved to your workspace:** \`${target}\``,
      `(${kind}, ${(buffer.length / 1024).toFixed(0)}KB)`,
      "",
      KIND_HINTS[kind] || KIND_HINTS.file,
      "",
      "It stays there, so you can refer to it again in a later message.",
    ].join("\n"),
  };
}

async function handleMessage(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || msg.key?.fromMe) return;
  // Groups and broadcasts are out of scope: a bot answering everything in a
  // group chat is rarely what anyone wants, and never by default.
  if (jid.endsWith("@g.us") || jid === "status@broadcast") return;

  const from = await senderNumber(sock, msg);
  if (!allowed(from)) {
    // Both the resolved number and the raw address, because when these differ
    // the difference is the whole explanation -- and the previous version
    // logged only the address, which is what made this hard to see.
    log("rejected_sender", { number: from, jid, allowed: ALLOWED });
    return;
  }

  let extracted;
  try {
    extracted = await extractPrompt(sock, msg);
  } catch (e) {
    log("extract_failed", { error: e.message });
    await sock.sendMessage(jid, { text: "I could not read that message." });
    return;
  }

  if (extracted.error) {
    await sock.sendMessage(jid, { text: extracted.error });
    return;
  }
  if (extracted.unsupported) {
    log("unsupported_type", { type: extracted.unsupported });
    return;
  }
  const prompt = (extracted.text || "").trim();
  if (!prompt) return;

  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  const keepTyping = setInterval(
    () => sock.sendPresenceUpdate("composing", jid).catch(() => {}),
    8000
  );

  const sessions = await readSessions();
  try {
    log("prompt", { number: from, chars: prompt.length });
    const { text, sessionId } = await ask(prompt, sessions[jid]);
    if (sessionId && sessionId !== sessions[jid]) {
      sessions[jid] = sessionId;
      await writeSessions(sessions);
    }
    await sock.sendMessage(jid, {
      text: text || "(the agent finished without saying anything)",
    });
    log("replied", { number: from, chars: text.length });
  } catch (e) {
    log("agent_failed", { error: e.message });
    await sock.sendMessage(jid, {
      text: "Something went wrong on my side: " + e.message.slice(0, 300),
    });
  } finally {
    clearInterval(keepTyping);
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}

/* ------------------------------------------------------------------- boot */

let reconnectDelay = 2000;

async function start() {
  await fsp.mkdir(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    // Baileys is chatty at info level and the QR is handled by the panel.
    logger: silentLogger(),
    browser: ["JOYA", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Written as a data URL so the panel can show it without serving a file
      // or relaxing the image-src CSP.
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      await writeRuntime({ status: "qr", qr: dataUrl, linked: false });
      log("qr_ready");
    }

    if (connection === "open") {
      reconnectDelay = 2000;
      const me = sock.user || {};
      await writeRuntime({
        status: "linked",
        linked: true,
        qr: null,
        me: { id: me.id || "", name: me.name || "", number: numberOf(me.id) },
      });
      log("linked", { number: numberOf(me.id) });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      await writeRuntime({
        status: loggedOut ? "logged_out" : "reconnecting",
        linked: false,
        qr: null,
        last_error: lastDisconnect?.error?.message || null,
      });
      log("disconnected", { code, loggedOut });

      if (loggedOut) {
        // The phone unlinked us. Reconnecting with these credentials will never
        // work; the session has to be cleared and a new QR scanned.
        log("session_invalid", {
          hint: "unlink and re-link this channel from the panel",
        });
        process.exit(1);
      }
      // Back off so a persistent failure does not hammer WhatsApp.
      setTimeout(start, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      handleMessage(sock, msg).catch((e) =>
        log("handler_error", { error: e.message })
      );
    }
  });
}

function silentLogger() {
  const noop = () => {};
  const logger = { level: "silent", trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  logger.child = () => logger;
  return logger;
}

process.on("unhandledRejection", (e) =>
  log("unhandled_rejection", { error: String(e && e.message ? e.message : e) })
);

await writeRuntime({ status: "starting", linked: false, qr: null });
if (!ALLOWED.length) {
  log("no_allowed_numbers", {
    hint: "nobody can talk to this channel until numbers are added in the panel",
  });
}
log("starting", { vault: VAULT, model: MODEL, voice: VOICE_ENABLED, files: FILES_ENABLED });
await start();
