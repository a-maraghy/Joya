"use strict";
/**
 * The voice front desk's view of this VPS: a read-only, speakable snapshot.
 *
 * The front desk (a GPT realtime model in the dashboard, trial, off by
 * default) may answer only from this, or hand the question to JOYA AI. So it
 * holds what a person would ask about at a glance -- services, disk, memory,
 * the live sessions, active missions and their steps, open decisions and
 * pending approvals -- and nothing it could act on:
 *
 *   - decisions and approvals are counts and titles. Never a command, a fix
 *     command, evidence, a tool input or an approval's summary (which is the
 *     command itself);
 *   - no live Odoo: nothing here reads it, by the administrator's choice;
 *   - figures are already in human units (GB with one decimal, whole percent),
 *     so a model reading them out has nothing to convert and nothing to round
 *     -- and the dashboard's output guard can check every figure it says
 *     against this very object;
 *   - every string is redacted and clipped.
 *
 * Built on demand from the caches the supervisor keeps fresh anyway (vitals,
 * the service list the watchers poll, the session list), so asking costs no
 * helper call and no subprocess.
 */

const { redact, clip } = require("./redact");

const GB = 1024 * 1024 * 1024;
const MAX_LIST = 20;
const MAX_STEPS = 20;
const TITLE = 140;

function gb(bytes) {
  return typeof bytes === "number" && isFinite(bytes) ? Math.round((bytes / GB) * 10) / 10 : null;
}
function title(s) {
  return clip(redact(String(s == null ? "" : s)).replace(/\s+/g, " ").trim(), TITLE);
}

/** systemd's words, reduced to the three a person means. */
function serviceState(active) {
  const a = String(active || "");
  if (a === "active" || a === "reloading" || a === "activating") return "running";
  if (a === "failed") return "failed";
  return "not running";
}

/**
 * The time now in the three zones that get mixed up (2026-09-30: JOYA AI read
 * Cairo time, the journal's server time and the ledger's UTC as one): UTC,
 * the administrator's (Africa/Cairo by default) and this server's own zone,
 * each with its offset. { utc, admin: {zone, time, offset}, server: {...} }.
 */
function offsetOf(date, zone) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(date).find((x) => x.type === "timeZoneName");
    const v = p ? p.value.replace(/^GMT/, "UTC") : "UTC";
    return v === "UTC" ? "UTC+00:00" : v;
  } catch (_) {
    return null;
  }
}
function localTime(date, zone) {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const g = (t) => (f.find((x) => x.type === t) || {}).value;
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
  } catch (_) {
    return null;
  }
}
function clockOf(iso, adminTz, serverTz) {
  const d = new Date(iso || Date.now());
  const zone = (z) => ({ zone: z, time: localTime(d, z), offset: offsetOf(d, z) });
  return {
    utc: d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"),
    admin: zone(adminTz || "Africa/Cairo"),
    server: zone(serverTz || "UTC"),
    note: "The ledger and the supervisor's stamps are UTC; the journal and log files are in the server's zone; the administrator reads Cairo time.",
  };
}

/**
 * @param src {
 *   now: ISO string, tz: the administrator's zone, serverTz: this server's zone,
 *   host, vitals, services: [{unit, active}], servicesAt, servicesError,
 *   sessions: [{name, status, self}], process: {state, busy, queued},
 *   missions: [mission view], decisions: [{title, status}],
 *   approvals: [{tool, label}], requests: [{id, status, ended_at, result_text, error}] }
 */
function buildSnapshot(src) {
  const v = src.vitals || {};
  const services = (src.services || []).filter((s) => s && s.unit);
  const failed = services.filter((s) => s.active === "failed").map((s) => title(s.unit));
  const sessions = (src.sessions || []).filter((s) => s && !s.self);
  const missions = (src.missions || []).filter((m) => m && (m.status === "planned" || m.status === "active"));
  const decisions = src.decisions || [];
  const approvals = src.approvals || [];

  const out = {
    taken_at: src.now || new Date().toISOString(),
    clock: clockOf(src.now, src.tz, src.serverTz),
    machine: {
      host: title(src.host || v.host || ""),
      cpu_used_percent: typeof v.cpu_pct === "number" ? v.cpu_pct : null,
      cpus: v.cpus || null,
      load_1_minute: Array.isArray(v.load) ? v.load[0] : null,
      memory: v.mem
        ? { used_percent: v.mem.pct, total_gb: gb(v.mem.total), available_gb: gb(v.mem.available) }
        : null,
      disk: v.disk ? { used_percent: v.disk.pct, total_gb: gb(v.disk.total), free_gb: gb(v.disk.free) } : null,
      uptime_hours: typeof v.uptime_s === "number" ? Math.round(v.uptime_s / 360) / 10 : null,
    },
    services: {
      tracked: services.length,
      running: services.filter((s) => serviceState(s.active) === "running").length,
      failed,
      list: services.slice(0, 40).map((s) => ({ name: title(s.unit), state: serviceState(s.active) })),
      checked_at: src.servicesAt || null,
      note: src.servicesError ? "the service list could not be read just now" : undefined,
    },
    joya_ai: {
      state: title((src.process && src.process.state) || "unknown"),
      busy: !!(src.process && src.process.busy),
      requests_queued: (src.process && src.process.queued) || 0,
    },
    sessions: {
      live: sessions.length,
      list: sessions.slice(0, MAX_LIST).map((s) => ({ name: title(s.name || "unnamed session"), status: title(s.status || "unknown") })),
    },
    missions: {
      active: missions.length,
      list: missions.slice(0, 10).map((m) => ({
        ref: title(m.ref),
        title: title(m.title),
        status: title(m.status),
        steps_done: m.metrics ? m.metrics.steps_done : null,
        steps_total: m.metrics ? m.metrics.steps_total : null,
        steps: (m.steps || []).slice(0, MAX_STEPS).map((s) => ({ n: s.n, title: title(s.title), status: title(s.status) })),
      })),
    },
    decisions: {
      open: decisions.length,
      titles: decisions.slice(0, MAX_LIST).map((d) => ({ title: title(d.title), status: title(d.status) })),
    },
    approvals: {
      pending: approvals.length,
      // A label and a tool: "Deletes files (Bash)". Never the command.
      titles: approvals.slice(0, MAX_LIST).map((a) => title((a.label || "Needs permission") + " (" + (a.tool || "tool") + ")")),
    },
  };
  // The last (re)starts of the dashboard and of this supervisor, with what was deployed (deploy-event).
  if (Array.isArray(src.deploys) && src.deploys.length) {
    out.restarts = src.deploys.slice(-4).map((d) => ({ component: title(d.component), started_at: d.started_at || null, commit: d.commit || null, deployed_at: d.deployed_at || null }));
  }
  if (src.requests) {
    out.requests_to_joya_ai = src.requests.map((r) => ({
      id: r.id,
      answered: !!r.ended_at,
      status: title(r.status),
      reply: r.ended_at ? clip(redact(r.result_text || r.error || ""), 4000) : undefined,
    }));
  }
  return out;
}

/** Keys that must never appear in a snapshot, checked by the tests and the dashboard. */
const FORBIDDEN_KEYS = ["command", "fix_command", "evidence", "input", "input_json", "summary", "proposal", "detail", "key", "token", "password"];

module.exports = { buildSnapshot, serviceState, clockOf, FORBIDDEN_KEYS };
