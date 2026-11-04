"use strict";
/**
 * What the frame shows on every page: the badges in the sidebar, the health
 * chip in the top bar, and the machine's line at the top of the sidebar.
 *
 * Every page draws the frame, so none of this may cost a page a helper round
 * trip. The facts are fetched together, at most once every CACHE_MS, and held
 * for everyone: a page render reads the cache, and a stale cache is refreshed
 * in the background while the stale copy is served. Only the very first page
 * after a start waits, and not for long -- if the helper is slow the frame
 * simply renders without numbers.
 *
 * The cache is shared, the numbers are not: badges are derived per actor at
 * render time, so a role scoped to one agent counts one agent, and a role that
 * cannot see users never sees how many are pending.
 */

const os = require("os");

const CACHE_MS = 30 * 1000;
const FIRST_WAIT_MS = 1500;

let deps = null; // { priv, db, catalog, devicesFor? } -- injected so tests can fake them
let cache = null; // { at, data }
let inflight = null;

function configure(d) {
  deps = d;
  cache = null;
  inflight = null;
}

async function settle(map) {
  const keys = Object.keys(map);
  const out = {};
  const results = await Promise.allSettled(keys.map((k) => map[k]()));
  results.forEach((r, i) => {
    out[keys[i]] = r.status === "fulfilled" ? r.value : null;
  });
  return out;
}

function refresh() {
  if (inflight) return inflight;
  const { priv } = deps;
  inflight = settle({
    services: () => priv.serviceList(),
    agents: () => priv.agentList(),
    channels: () => priv.channelList(),
    status: () => priv.status(),
    credentials: () => priv.credentialList(),
    keys: () => priv.listAllKeys(),
    memory: () => priv.ccMemoryStats(),
    running: () => priv.ccRunning(),
  })
    .then((data) => {
      cache = { at: Date.now(), data };
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The shared facts, fresh within CACHE_MS; stale ones while a refresh runs. */
async function facts() {
  if (!deps) return null;
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.data;
  const p = refresh().catch(() => null);
  if (cache) return cache.data; // serve stale, refresh behind it
  const timeout = new Promise((r) => setTimeout(() => r(null), FIRST_WAIT_MS));
  const got = await Promise.race([p, timeout]);
  return got ? got.data : null;
}

/**
 * The tracked units one actor may see. An agent's unit is as private as the
 * agent (a role scoped to one agent must not learn the others' names from
 * the services list), and a WhatsApp bridge as private as its channel.
 * Every count of services -- badge, chip, overview, /services -- goes
 * through this, so they all agree for any given viewer.
 */
function visibleServices(services, perm) {
  if (!Array.isArray(services)) return services;
  if (!perm) return services;
  return services.filter((s) => {
    const unit = String((s && s.unit) || "");
    if (s.kind === "agent" || unit.startsWith("joya-agent@")) return perm.seesAgent(unit.slice("joya-agent@".length));
    if (s.kind === "whatsapp" || unit.startsWith("joya-whatsapp@")) return perm.seesChannel(unit.slice("joya-whatsapp@".length));
    return true;
  });
}

const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

function uptimeLong(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m";
}

/**
 * The frame for one actor. `perm` is the actor from rbac; `data` the shared
 * facts (null when the helper has not answered yet -- then only what this
 * process knows by itself is shown); `me` the signed-in user, for the one
 * badge that is per person rather than per role (Devices).
 */
function forActor(perm, data, me) {
  const can = (p) => !perm || perm.can(p);
  const sees = (slug) => !perm || perm.seesAgent(slug);
  const seesCh = (slug) => !perm || perm.seesChannel(slug);
  const d = data || {};
  const badges = {};

  const services = Array.isArray(d.services) ? visibleServices(d.services, perm) : null;
  const agents = Array.isArray(d.agents) ? d.agents.filter((a) => sees(a.slug)) : null;
  const channels = Array.isArray(d.channels) ? d.channels.filter((c) => seesCh(c.slug)) : null;
  const down = services ? services.filter((s) => s.active !== "active") : [];
  const failed = agents ? agents.filter((a) => a.state && a.state.active === "failed") : [];
  const running = agents ? agents.filter((a) => a.state && a.state.active === "active") : [];

  // Badges are [text, class, title]. Counts are quiet ("plain", a zero is
  // hidden by the sidebar); only states are tinted.
  if (services && can("services.view")) {
    const up = services.length - down.length;
    badges.services = [up + "/" + services.length, down.length ? "warn" : "ok", down.length ? plural(down.length, "service") + " down" : "all " + services.length + " up"];
  }
  if (d.status && d.status.jails && can("firewall.view")) {
    const banned = Object.values(d.status.jails).reduce((n, j) => n + (j.banned || 0), 0);
    if (banned) badges.firewall = [String(banned), "warn", banned + " banned"];
  }
  if (d.keys && typeof d.keys === "object" && can("keys.view")) {
    const n = Object.values(d.keys).reduce((m, list) => m + (Array.isArray(list) ? list.length : 0), 0);
    badges.keys = [String(n), "plain"];
  }
  if (deps && deps.db) {
    try {
      if (can("users.view")) {
        const users = deps.db.listUsers();
        const pending = require("./signin").passwordOnly ? 0 : users.filter((u) => !u.totp_confirmed && !u.disabled).length;
        badges.users = pending ? [String(pending), "warn", pending + " awaiting enrolment"] : [String(users.length), "plain"];
      }
      if (can("roles.view")) badges.roles = [String(deps.db.listRoles().length), "plain"];
    } catch (_) {
      /* the database is this process's own; if it fails the page will say so */
    }
  }
  // Devices: how many browsers the viewer is signed in on. Their own, so no
  // permission; counted by lib/sessions.js, which caches it per user for 30 s.
  if (me && deps && typeof deps.devicesFor === "function") {
    try {
      const n = deps.devicesFor(me.id);
      if (n) badges.devices = [String(n), "plain", n === 1 ? "signed in on 1 browser" : "signed in on " + n + " browsers"];
    } catch (_) {
      /* no badge */
    }
  }
  if (d.memory && d.memory.db && can("claude.memory.read")) {
    badges["claude-memory"] = [Number(d.memory.db.facts.current).toLocaleString("en-US"), "plain", "memory facts"];
  }
  if (d.running && Array.isArray(d.running.sessions) && (can("claude.running.view") || can("claude.sessions.view"))) {
    const live = d.running.sessions.filter((s) => s.alive !== false).length;
    if (live) badges["claude-sessions"] = [String(live), "ok", live + " live"];
  }
  if (agents && can("agents.view")) {
    badges.agents = failed.length ? [String(failed.length), "bad", plural(failed.length, "agent") + " failed"] : [String(agents.length), "plain"];
  }
  if (channels && can("channels.view")) badges.channels = [String(channels.length), "plain"];
  if (deps && deps.catalog && can("addons.view")) {
    try {
      badges.addons = [String(deps.catalog.ADDONS ? deps.catalog.ADDONS.length : deps.catalog.all().length), "plain"];
    } catch (_) {
      /* no count is better than a wrong one */
    }
  }
  // Voice off is a state of JOYA AI's Settings worth seeing from anywhere.
  if (deps && typeof deps.voiceOff === "function" && can("joyaai.use")) {
    try {
      if (deps.voiceOff()) badges["joya-settings"] = ["voice off", "plain", "voice is disabled"];
    } catch (_) {
      /* no badge */
    }
  }

  // The health chip: what needs attention, among what this actor may see.
  let health = null;
  const agentIssue = agents && can("agents.view") ? failed.length : 0;
  // A failed agent is an agent unit that is down too; when the agent count
  // already says so, the service count leaves it out rather than say it twice.
  const svcIssue =
    services && can("services.view")
      ? down.filter((s) => !(agentIssue && (s.kind === "agent" || String(s.unit).startsWith("joya-agent@")) && s.active === "failed")).length
      : 0;
  if (svcIssue || agentIssue) {
    const parts = [];
    if (svcIssue) parts.push(plural(svcIssue, "service") + (svcIssue === 1 ? " needs" : " need") + " attention");
    if (agentIssue) parts.push(plural(agentIssue, "agent") + " failed");
    health = {
      cls: agentIssue ? "bad" : "warn",
      text: parts.join(" · "),
      short: svcIssue + agentIssue + " attention",
      href: svcIssue ? "/services" : "/agents",
    };
  } else if ((services && can("services.view")) || (agents && can("agents.view"))) {
    health = { cls: "ok", text: "All systems nominal", short: "OK", href: can("services.view") ? "/services" : "/agents" };
  }

  const mem = os.totalmem();
  const facts = [os.cpus().length + " vCPU", Math.round(mem / 1024 ** 3) + " GB", "up " + uptimeLong(os.uptime())];
  const ids = {
    os: { name: os.hostname(), facts, sub: facts.join(" · ") },
    agents: {
      name: "Telegram agents",
      sub: agents ? running.length + " of " + agents.length + " running" + (channels ? " · " + plural(channels.length, "channel") : "") : "",
    },
  };

  return { badges, health, ids };
}

/** Express middleware: attaches req.chrome for signed-in page requests. */
function middleware() {
  return async (req, res, next) => {
    req.chrome = null;
    if (!req.me || req.method !== "GET" || req.path.startsWith("/api/") || req.path.includes("/api/")) return next();
    try {
      req.chrome = forActor(req.perm, await facts(), req.me);
    } catch (_) {
      req.chrome = null;
    }
    next();
  };
}

/**
 * Fold a fresher fact into the shared cache, so the frame agrees with the page
 * that just read it: the overview and /services read the unit list fresh, and
 * a badge or a live update still showing the 30 s old list next to it would
 * contradict the page. Returns the merged facts (or null with no cache yet).
 */
function prime(partial) {
  if (!cache || !partial) return cache ? cache.data : null;
  cache = { at: cache.at, data: Object.assign({}, cache.data, partial) };
  return cache.data;
}

/** Forget the cache, so a page after a change shows the change. */
function invalidate() {
  if (cache) cache.at = 0;
}

module.exports = { configure, facts, forActor, middleware, invalidate, prime, visibleServices, CACHE_MS };
