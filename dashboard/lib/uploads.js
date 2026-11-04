"use strict";
/**
 * Files attached to a message to JOYA AI (2026-10-25): the Command Center's
 * paperclip, a paste (a screenshot from the clipboard) or a drop.
 *
 * Each file is uploaded on its own (POST /joya-ai/api/uploads, the raw bytes)
 * as soon as it is attached, into a folder for the message it will go with:
 *
 *   <root>/<yyyy-mm-dd>/<batch>/<file>        the bytes, a random name + the allowed extension
 *   <root>/<yyyy-mm-dd>/<batch>/<file>.json   { owner, name, type, size, sha256, at }
 *   <root>/<yyyy-mm-dd>/<batch>/batch.json    { owner, at }
 *
 * <root> is <data dir>/uploads (/var/lib/joya-dashboard/uploads on the VPS),
 * readable by JOYA AI's supervisor (root). The original name is kept only in
 * the metadata; nothing a browser sends ever becomes part of a path. Files are
 * kept (no cleanup job yet).
 *
 * When the message is sent, the server -- never the page -- turns the ids into
 * lines at the end of the turn's text, one per file, which JOYA AI opens with
 * its Read tool (it reads images and PDFs) and the Conversation shows as files:
 *
 *   [Attached file: /var/lib/joya-dashboard/uploads/2026-10-25/<batch>/<file> | name.pdf | application/pdf | 1.2 MB]
 *
 * public/cc-logic.js splitAttached() reads those lines back for the page.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_BYTES = 20 * 1024 * 1024; // per file
const MAX_FILES = 10; // per message
const NAME_MAX = 120;

/** The allow-list: extension -> the type it is served and announced as. Nothing else is taken. */
const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  md: "text/markdown",
  json: "application/json",
  log: "text/plain",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};
/** What the first bytes of each kind must look like (the extension alone is a claim). */
const MAGIC = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  pdf: [[0x25, 0x50, 0x44, 0x46]],
  zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]],
  docx: [[0x50, 0x4b, 0x03, 0x04]],
  xlsx: [[0x50, 0x4b, 0x03, 0x04]],
  pptx: [[0x50, 0x4b, 0x03, 0x04]],
  odt: [[0x50, 0x4b, 0x03, 0x04]],
  ods: [[0x50, 0x4b, 0x03, 0x04]],
  odp: [[0x50, 0x4b, 0x03, 0x04]],
  doc: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  xls: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ppt: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  rtf: [[0x7b, 0x5c, 0x72, 0x74, 0x66]],
};
const TEXT_EXT = new Set(["txt", "csv", "tsv", "md", "json", "log", "xml", "yaml", "yml"]);
/** A program, whatever it is called: Windows (MZ), Linux (ELF), macOS (Mach-O), a script (#!). */
const EXECUTABLE = [[0x4d, 0x5a], [0x7f, 0x45, 0x4c, 0x46], [0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xca, 0xfe, 0xba, 0xbe], [0x23, 0x21]];

const ID_RE = /^(\d{4}-\d{2}-\d{2})\/([a-f0-9]{16})\/([a-f0-9]{12}\.[a-z0-9]{1,5})$/;
const BATCH_RE = /^\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}$/;

function bad(message, status) {
  const e = new Error(message);
  e.code = "invalid";
  e.status = status || 400;
  return e;
}

const startsWith = (buf, sig) => buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/** The extension of a file name, lower case, or "". */
function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

/** A name fit to show and to put in a turn's line: no control characters, brackets or bars, at most 120 characters. */
function cleanName(raw) {
  let s = String(raw == null ? "" : raw).normalize("NFC");
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\\/|[\]]/g, "_").replace(/\s+/g, " ").trim();
  if (s.length > NAME_MAX) {
    const ext = extOf(s);
    s = s.slice(0, NAME_MAX - ext.length - 2).trim() + "…" + (ext ? "." + ext : "");
  }
  return s;
}

/** 1.2 MB, 240 KB, 900 B: the size as the turn's line and the chips say it. */
function sizeText(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (Math.round((n / (1024 * 1024)) * 10) / 10).toFixed(1) + " MB";
}

/**
 * Is this upload acceptable? Returns { ext, type } or throws a 400/413/415 with a reason in words.
 */
function check(name, buf) {
  const ext = extOf(name);
  if (!ext || !Object.prototype.hasOwnProperty.call(TYPES, ext)) {
    throw bad(`${ext ? "." + ext + " files" : "Files without an extension"} can't be attached. Attach images, PDFs, Office documents, text, CSV, Markdown, JSON or ZIP.`, 415);
  }
  if (!buf || !buf.length) throw bad("That file is empty.");
  if (buf.length > MAX_BYTES) throw bad(`That file is ${sizeText(buf.length)}; the limit is 20 MB.`, 413);
  if (EXECUTABLE.some((sig) => startsWith(buf, sig))) throw bad("That file is a program; programs can't be attached.", 415);
  const magic = MAGIC[ext];
  if (magic && !magic.some((sig) => startsWith(buf, sig))) throw bad(`That file is not really a .${ext} file.`, 415);
  if (ext === "webp" && !(startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.slice(8, 12).toString("latin1") === "WEBP")) throw bad("That file is not really a .webp file.", 415);
  if (TEXT_EXT.has(ext) && buf.subarray(0, 65536).includes(0)) throw bad(`That file is not text, so it can't be a .${ext} file.`, 415);
  return { ext, type: TYPES[ext] };
}

function create(opts) {
  const root = path.resolve(opts.root);
  const now = opts.now || (() => new Date());

  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  /** A path under the root, or null: the resolved path must stay inside it. */
  function inside(rel) {
    const p = path.resolve(root, rel);
    return p === root || !p.startsWith(root + path.sep) ? null : p;
  }
  function readJson(p) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_) {
      return null;
    }
  }
  function filesIn(dir) {
    try {
      return fs.readdirSync(dir).filter((f) => /^[a-f0-9]{12}\.[a-z0-9]{1,5}$/.test(f));
    } catch (_) {
      return [];
    }
  }

  /**
   * Keep one file. batch: the message's folder from an earlier upload ("yyyy-mm-dd/<16 hex>"), or
   * empty to start one. Returns { id, batch, name, type, size, image, url }.
   */
  function save({ owner, name, buf, batch }) {
    const clean = cleanName(name);
    if (!clean) throw bad("The file has no name.");
    const { ext, type } = check(clean, buf);
    ensureRoot();
    let dir;
    if (batch) {
      if (typeof batch !== "string" || !BATCH_RE.test(batch)) throw bad("That upload folder is not valid.");
      dir = inside(batch);
      const meta = dir && readJson(path.join(dir, "batch.json"));
      if (!meta || meta.owner !== owner) throw bad("That upload folder is not yours.", 403);
      // The page holds a message to ten files; files removed from it before sending still sit in its
      // folder, so the folder itself takes a few more before it says no.
      if (filesIn(dir).length >= MAX_FILES * 3) throw bad("Too many files went into this message's folder. Send it, then attach more.", 409);
    } else {
      const day = now().toISOString().slice(0, 10);
      batch = day + "/" + crypto.randomBytes(8).toString("hex");
      dir = inside(batch);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, "batch.json"), JSON.stringify({ owner, at: now().toISOString() }), { mode: 0o600, flag: "wx" });
    }
    const file = crypto.randomBytes(6).toString("hex") + "." + ext;
    const p = path.join(dir, file);
    fs.writeFileSync(p, buf, { mode: 0o600, flag: "wx" });
    const meta = { owner, name: clean, type, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), at: now().toISOString() };
    fs.writeFileSync(p + ".json", JSON.stringify(meta), { mode: 0o600, flag: "wx" });
    const id = batch + "/" + file;
    return { id, batch, name: clean, type, size: buf.length, image: /^image\//.test(type), url: "/joya-ai/api/uploads/" + id };
  }

  /** A kept file by its id, or null: { id, path, name, type, size, owner }. */
  function find(id) {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    const p = inside(id);
    if (!p) return null;
    let real;
    try {
      real = fs.realpathSync(p);
    } catch (_) {
      return null;
    }
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null;
    const meta = readJson(p + ".json");
    if (!meta || typeof meta.name !== "string") return null;
    let st;
    try {
      st = fs.statSync(real);
    } catch (_) {
      return null;
    }
    if (!st.isFile()) return null;
    return { id, path: real, name: meta.name, type: meta.type || TYPES[extOf(p)] || "application/octet-stream", size: st.size, owner: meta.owner };
  }

  /** The files a send names (ids), the sender's own, at most ten; throws a 400 naming the problem. */
  function forSend(ids, owner) {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw bad("Attachments must be a list.");
    if (ids.length > MAX_FILES) throw bad(`A message can carry at most ${MAX_FILES} files.`);
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const f = find(id);
      if (!f || f.owner !== owner) throw bad("One of the attached files is no longer there. Remove it and attach it again.");
      out.push(f);
    }
    return out;
  }

  return { root, save, find, forSend };
}

/** The lines added to a turn's text for its files (lib/uploads.js is the only writer). */
function trailer(files) {
  return files.map((f) => `[Attached file: ${f.path} | ${cleanName(f.name)} | ${f.type} | ${sizeText(f.size)}]`).join("\n");
}

module.exports = { create, check, cleanName, sizeText, extOf, trailer, TYPES, MAX_BYTES, MAX_FILES, ID_RE };
