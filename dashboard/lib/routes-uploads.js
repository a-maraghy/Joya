"use strict";
/**
 * Attachments for messages to JOYA AI (lib/uploads.js keeps them). Both routes need joyaai.use --
 * the permission that sends JOYA AI a message; the upload also needs the CSRF token (X-CSRF-Token).
 *
 *   POST /joya-ai/api/uploads                     the raw bytes of one file (any Content-Type; at most 20 MB)
 *        X-File-Name: the original name, URI-encoded    X-Upload-Batch: the message's folder, after its first file
 *        -> { id, batch, name, type, size, image, url }   400 / 403 / 409 / 413 / 415 { error } in words
 *   GET  /joya-ai/api/uploads/<yyyy-mm-dd>/<batch>/<file>   a kept file, for the chips and the Conversation
 *
 * The sent message carries the ids (POST /joya-ai/api/send {attachments: [id]}); server.js turns
 * them into the turn's "[Attached file: …]" lines with uploads.trailer().
 *
 *   mount(app, { apiGuard, apiWrite, express, uploads, db }) -> nothing
 */
const Uploads = require("./uploads");

function mount(app, deps) {
  const { uploads } = deps;
  const audit = (req, what) => {
    try {
      deps.db.logLogin(req.ip, req.me.username, "joya-upload", what);
    } catch (_) {
      /* the audit is a nicety here */
    }
  };
  // Too big is refused before a byte is read: the declared length first, then the parser's own limit.
  const sizeGate = (req, res, next) => {
    const n = Number(req.get("content-length"));
    if (Number.isFinite(n) && n > Uploads.MAX_BYTES) return res.status(413).json({ error: `That file is ${Uploads.sizeText(n)}; the limit is 20 MB.` });
    next();
  };
  const raw = deps.express.raw({ type: () => true, limit: Uploads.MAX_BYTES });
  const rawErr = (err, req, res, next) => {
    if (err && (err.type === "entity.too.large" || err.status === 413)) return res.status(413).json({ error: "That file is over the 20 MB limit." });
    if (err) return res.status(400).json({ error: "The upload did not arrive whole. Try again." });
    next();
  };

  app.post("/joya-ai/api/uploads", ...deps.apiWrite, sizeGate, raw, rawErr, (req, res) => {
    let name = "";
    try {
      name = decodeURIComponent(String(req.get("x-file-name") || ""));
    } catch (_) {
      return res.status(400).json({ error: "The file name could not be read." });
    }
    const batch = req.get("x-upload-batch") || "";
    try {
      const f = uploads.save({ owner: req.me.username, name, buf: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), batch });
      audit(req, `attached ${f.name} (${f.type}, ${Uploads.sizeText(f.size)}) as ${f.id}`);
      res.json(f);
    } catch (e) {
      if (e.code !== "invalid") console.error("upload: " + e.message);
      res.status(e.code === "invalid" ? e.status || 400 : 500).json({ error: e.code === "invalid" ? e.message : "The file could not be kept." });
    }
  });

  app.get(/^\/joya-ai\/api\/uploads\/(\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\/[a-f0-9]{12}\.[a-z0-9]{1,5})$/, ...deps.apiGuard, (req, res) => {
    const f = uploads.find(req.params[0]);
    if (!f) return res.status(404).json({ error: "No such file." });
    const inline = /^image\/(png|jpeg|gif|webp)$|^application\/pdf$/.test(f.type);
    res.setHeader("Content-Type", f.type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Disposition", (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(f.name));
    res.sendFile(f.path, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
}

module.exports = { mount };
