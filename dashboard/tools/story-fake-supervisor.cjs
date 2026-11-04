"use strict";
/**
 * A fake JOYA AI supervisor for the session story's tests and screenshots: a unix socket that answers
 * the ops the Command Center loads (status, sessions, the ledger, missions...) from a fixture world
 * (story-fixture.cjs) and the two story ops with the REAL joya-ai/lib/story.js over that world.
 * The event stream is kept open (nothing is pushed).
 *
 *     const sup = await startFake(sockPath, world);  ...  sup.close();
 */
const net = require("net");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { createStory } = require(path.join(ROOT, "joya-ai", "lib", "story.js"));
const names = require(path.join(ROOT, "joya-ai", "lib", "names.js"));

function startFake(sock, W, o) {
  o = o || {};
  const story = createStory({
    projectsDir: W.projectsDir,
    db: W.ledger.db,
    tz: "Africa/Cairo",
    sessions: () => W.sessions,
    selfIds: () => W.selfIds,
    selfBusy: () => false,
    describeTool: (n, i) => (n === "Bash" ? "Ran: " + String((i && i.command) || "").slice(0, 100) : n === "Edit" || n === "Write" ? (n === "Edit" ? "Edited " : "Wrote ") + ((i && i.file_path) || "") : n),
    sessionCost: (sid) => ({ today_usd: sid === W.ids.self ? 3.1 : 1.84, today_in: 0, today_out: 0, week_tokens: [], estimated: sid !== W.ids.self }),
    isSelfName: names.isSelfName,
    now: o.now,
  });
  const seen = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", async (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch (_) {
          continue;
        }
        seen.push(m);
        if (m.op === "events") continue; // kept open
        let data = {};
        let err = null;
        try {
          if (m.op === "status") data = { name: "JOYA AI", seq: 1, process: { state: "ready", pid: 100 }, session_id: W.ids.self, approvals: [], counts: {} };
          else if (m.op === "sessions") data = { sessions: W.sessions };
          else if (m.op === "ledger") data = { rows: m.table === "delegations" ? W.ledger.db.prepare("SELECT * FROM delegations ORDER BY id DESC LIMIT 30").all() : [] };
          else if (m.op === "missions") data = { missions: [] };
          else if (m.op === "decisions") data = { decisions: [] };
          else if (m.op === "orders") data = { orders: [], tz: "Africa/Cairo", telegram: { available: false } };
          else if (m.op === "watchers") data = { watchers: [] };
          else if (m.op === "session-story") data = await story.sessionStory(m.session_id);
          else if (m.op === "story-day") data = await story.day(m.day || null);
        } catch (e) {
          err = e.message;
        }
        if (!c.destroyed) c.write(JSON.stringify(err ? { id: m.id, ok: false, error: err } : { id: m.id, ok: true, data }) + "\n");
      }
    });
    c.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ close: () => server.close(), seen, story })));
}

module.exports = { startFake };
