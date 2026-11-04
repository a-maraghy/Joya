"use strict";
/**
 * Joya > Computers: the routes of the user's own computers (lib/machines.js,
 * views lib/views-machines.js). Path A laptop control, 2026-10-08.
 *
 *   signed in, joyaai.use (forms with the session's CSRF token):
 *     GET  /machines                       the list, pairing, take over / extend / stop
 *     POST /machines/pair                  a one-time pairing code (10 min)
 *     POST /machines/:id/rename|revoke|take-over|extend|stop
 *     POST /machines/:id/browser           {on: "1"|"0"}: JOYA AI may use Chrome there (Claude in Chrome)
 *     POST /machines/:id/folders           {path}: a folder JOYA AI may use there; /folders/remove {path}
 *     GET  /machines/:id                   its control sessions
 *     GET  /machines/:id/lease/:lid        a session's action log (live while it runs)
 *     GET  /machines/shot/:aid             one screenshot of an old (pre-0.1.11) log row (no-store)
 *     GET  /machines/api/list | /machines/api/lease/:lid[?after=<id>]   JSON for public/machines.js
 *   the desktop app (no cookie):
 *     POST /machines/api/claim             {code, name, platform, app_version} -> {machine_id, name, token}
 *     WS   /machines/api/link              Authorization: Bearer <token>   (upgrade(), from server.js)
 *
 *   mount(app, deps)  deps: { machines, requireAuth, requirePerm, requireCsrf, ctx, db, rateLimit, WebSocketServer }
 */

const fs = require("fs");
const V = require("./views-machines");
const M = require("./machines");

const LINK_PATH = /^\/machines\/api\/link(?:\?|$)/;

function mount(app, deps) {
  const { machines, requireAuth, requirePerm, requireCsrf, ctx, db } = deps;
  const guard = [requireAuth, requirePerm("joyaai.use")];
  const write = [requireAuth, requirePerm("joyaai.use"), requireCsrf];
  const who = (req) => req.me.username;
  const audit = (req, line) => {
    try {
      db.logLogin(req.ip, who(req), "machines", line);
    } catch (_) {
      /* the audit never stops the action */
    }
  };
  const back = (res, { msg, err, anchor } = {}) =>
    res.redirect(303, "/machines" + (err ? "?err=" + encodeURIComponent(err) : msg ? "?msg=" + encodeURIComponent(msg) : "") + (anchor ? "#" + anchor : ""));
  const idOf = (req) => (/^[1-9][0-9]{0,9}$/.test(String(req.params.id)) ? Number(req.params.id) : null);

  app.get(["/machines", "/machines/"], ...guard, (req, res) => {
    const code = req.session.machinePairCode && Date.parse(req.session.machinePairCode.expires_at) > Date.now() ? req.session.machinePairCode : null;
    res.set("Cache-Control", "no-store");
    const list = machines.list().map((m) => (m.lease ? { ...m, recent: machines.lastActions(m.lease.id, 8) } : m));
    res.send(V.list({ csrf: res.locals.csrf, user: ctx(req), machines: list, code, msg: req.query.msg, err: req.query.err, retention: M.RETENTION_DAYS }));
  });

  app.post("/machines/pair", ...write, (req, res) => {
    const c = machines.issueCode(req.me.id, who(req));
    if (!c) return back(res, { err: "Too many pairing codes are waiting. Try again in ten minutes.", anchor: "pair" });
    req.session.machinePairCode = c;
    audit(req, "computer pairing code issued (10 min)");
    back(res, { anchor: "pair" });
  });

  app.post("/machines/:id/rename", ...write, (req, res) => {
    const id = idOf(req);
    const r = id ? machines.rename(id, req.body.name, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id} renamed "${r.name}"`);
    back(res, r.error ? { err: r.error } : { msg: `Renamed to ${r.name}.`, anchor: "machine-" + id });
  });

  app.post("/machines/:id/revoke", ...write, (req, res) => {
    const id = idOf(req);
    const r = id ? machines.revoke(id, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id} revoked`);
    back(res, r.error ? { err: r.error } : { msg: "The computer is unlinked. Pair it again to use it." });
  });

  app.post("/machines/:id/take-over", ...write, async (req, res) => {
    const id = idOf(req);
    const minutes = [15, 30, 60].includes(Number(req.body.minutes)) ? Number(req.body.minutes) : 15;
    const purpose = String(req.body.purpose || "").trim().slice(0, 4000);
    const r = id ? await machines.takeOver(id, purpose, minutes, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id}: JOYA AI takes over for ${minutes} min`);
    back(res, r.error ? { err: r.error } : { msg: `JOYA AI is taking over for ${minutes} minutes. Ctrl+Alt+Esc on the computer stops it.`, anchor: "machine-" + id });
  });

  app.post("/machines/:id/extend", ...write, (req, res) => {
    const id = idOf(req);
    const r = id ? machines.extend(id, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id}: control extended to ${r.expires_at}`);
    back(res, r.error ? { err: r.error } : { msg: "Extended by 15 minutes.", anchor: "machine-" + id });
  });

  app.post("/machines/:id/stop", ...write, async (req, res) => {
    const id = idOf(req);
    const r = id ? await machines.stopControl(id, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id}: control stopped`);
    back(res, r.error ? { err: r.error } : { msg: "Control stopped.", anchor: "machine-" + id });
  });

  app.post("/machines/:id/browser", ...write, (req, res) => {
    const id = idOf(req);
    const on = String(req.body.on) === "1";
    const r = id ? machines.setBrowser(id, on, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id}: browser ${on ? "allowed" : "switched off"}`);
    back(res, r.error ? { err: r.error } : { msg: on ? "JOYA AI may use Chrome on that computer (from the next take-over)." : "JOYA AI will not use Chrome on that computer.", anchor: "machine-" + id });
  });

  app.post("/machines/:id/folders", ...write, (req, res) => {
    const id = idOf(req);
    const r = id ? machines.addFolder(id, req.body.path, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id}: folder added ${r.path}`);
    back(res, r.error ? { err: r.error, anchor: "machine-" + id } : { msg: `JOYA AI may use ${r.path} on that computer (from the next take-over).`, anchor: "machine-" + id });
  });

  app.post("/machines/:id/folders/remove", ...write, (req, res) => {
    const id = idOf(req);
    const r = id ? machines.removeFolder(id, req.body.path, who(req)) : { error: "No such computer." };
    if (!r.error) audit(req, `computer #${id}: folder removed ${String(req.body.path || "").slice(0, 240)}`);
    back(res, r.error ? { err: r.error, anchor: "machine-" + id } : { msg: "Folder removed.", anchor: "machine-" + id });
  });

  app.get("/machines/api/list", ...guard, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ machines: machines.list() });
  });
  app.get("/machines/api/lease/:lid", ...guard, (req, res) => {
    const l = /^[1-9][0-9]{0,9}$/.test(req.params.lid) ? machines.lease(Number(req.params.lid)) : null;
    res.set("Cache-Control", "no-store");
    if (!l) return res.status(404).json({ error: "No such control session." });
    // ?after=<id>: only the action-log rows after that one (the live log); without it the whole log.
    const after = /^[0-9]{1,12}$/.test(String(req.query.after || "")) ? Number(req.query.after) : 0;
    res.json({ lease: l, log: machines.actionLog(l.id, after), ...(after ? {} : { actions: machines.actions(l.id) }) });
  });

  app.get("/machines/shot/:aid", ...guard, (req, res) => {
    const p = /^[1-9][0-9]{0,12}$/.test(req.params.aid) ? machines.shotFile(Number(req.params.aid)) : null;
    if (!p) return res.status(404).send("Not found");
    res.set("Cache-Control", "no-store, private");
    res.set("X-Content-Type-Options", "nosniff");
    res.type("image/jpeg");
    fs.createReadStream(p).pipe(res);
  });

  app.get("/machines/:id", ...guard, (req, res) => {
    const id = idOf(req);
    const m = id ? machines.get(id) : null;
    if (!m) return res.redirect(303, "/machines?err=" + encodeURIComponent("No such computer."));
    res.send(V.detail({ csrf: res.locals.csrf, user: ctx(req), machine: machines.publicMachine(m), leases: machines.leases(id, 50) }));
  });
  app.get("/machines/:id/lease/:lid", ...guard, (req, res) => {
    const id = idOf(req);
    const m = id ? machines.get(id) : null;
    const l = m && /^[1-9][0-9]{0,9}$/.test(req.params.lid) ? machines.lease(Number(req.params.lid)) : null;
    if (!m || !l || l.machine_id !== id) return res.redirect(303, "/machines?err=" + encodeURIComponent("No such control session."));
    res.set("Cache-Control", "no-store");
    res.send(V.leaseLog({ csrf: res.locals.csrf, user: ctx(req), machine: machines.publicMachine(m), lease: l, actions: machines.actions(l.id), log: machines.actionLog(l.id, 0), retention: M.RETENTION_DAYS }));
  });

  // The app's claim: no cookie, its own small budget (a code is 40 bits and single use).
  const claimLimiter = deps.rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  app.post("/machines/api/claim", claimLimiter, (req, res) => {
    const r = machines.claim(req.body);
    try {
      db.logLogin(req.ip, "", r.status === 200 ? "machines" : "fail", r.status === 200 ? `computer #${r.machine_id} "${r.name}" paired` : "computer pairing code refused");
    } catch (_) {
      /* audit only */
    }
    res.set("Cache-Control", "no-store");
    if (r.status !== 200) return res.status(r.status).json({ error: r.error });
    res.json({ machine_id: r.machine_id, name: r.name, token: r.token });
  });

  // The app's link: one WebSocket per computer, authenticated by its token (never a cookie).
  const wss = new deps.WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  function upgrade(req, socket, head) {
    const refuse = (status, text) => {
      try {
        socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
      } catch (_) {
        /* gone */
      }
      socket.destroy();
    };
    const m = machines.authenticate(req);
    if (!m) return refuse(401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => machines.connected(ws, m));
  }
  return { upgrade, isLink: (req) => LINK_PATH.test(req.url || "") };
}

module.exports = { mount, LINK_PATH };
