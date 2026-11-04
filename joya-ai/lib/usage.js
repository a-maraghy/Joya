"use strict";
/**
 * Claude plan usage -- the figures Claude Code's own /usage screen shows.
 *
 * Source: the CLI's `get_usage` control request (stream-json, 2.1.283). It is
 * answered by the CLI itself from the claude.ai usage endpoint, with the CLI's
 * own login: the same call that fills the /usage dialog. Nothing here reads,
 * holds or forwards a credential; the answer carries none.
 *
 * Asked of JOYA AI's running CLI (answered out of band in ~0.1 s, even
 * mid-turn: verified 2026-09-30, it does not touch the turn). When JOYA AI is
 * not running, a throwaway CLI is started just for the question (initialize +
 * get_usage, no model turn, no transcript) and killed.
 *
 * Only the windows /usage shows are passed on, in /usage's order and with its
 * labels (read off the 2.1.283 binary):
 *   Current session              <- five_hour
 *   Current week (all models)    <- seven_day
 *   Current week (Sonnet only)   <- seven_day_sonnet   (max / team / unknown plans)
 *   Current week (<model>)       <- model_scoped[]      (e.g. "Fable")
 * A window that is absent or has no utilization is skipped, as /usage skips it.
 * The dialog shows `Math.floor(utilization)% used` and "Resets <time>"; the
 * weekly rows always show the date.
 */

const { spawn } = require("child_process");
const os = require("os");

const PCT_MAX = 1000; // utilization can legitimately run past 100

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? Math.max(0, Math.min(PCT_MAX, n)) : null;
}
function iso(v) {
  if (v == null || v === "") return null;
  const ms = Date.parse(String(v));
  return isFinite(ms) ? new Date(ms).toISOString() : null;
}
function str(v, max = 80) {
  return v == null ? null : String(v).replace(/[\u0000-\u001f]/g, " ").slice(0, max);
}

/**
 * Shape a get_usage answer into what the panel shows. Pure; `at` is when the
 * answer arrived. Everything not listed above is dropped.
 */
function shapePlan(resp, at) {
  const r = resp && typeof resp === "object" ? resp : {};
  const sub = r.subscription_type == null ? null : str(r.subscription_type, 20);
  const rl = r.rate_limits && typeof r.rate_limits === "object" ? r.rate_limits : null;
  const out = {
    at: iso(at) || new Date().toISOString(),
    subscription_type: sub,
    available: r.rate_limits_available !== false && !!rl,
    rows: [],
    extra_usage: null,
  };
  if (!rl) return out;
  const showSonnet = sub === "max" || sub === "team" || sub === null;
  const cand = [
    { key: "five_hour", title: "Current session", group: "session", date: false, limit: rl.five_hour },
    { key: "seven_day", title: "Current week (all models)", group: "weekly", date: true, limit: rl.seven_day },
  ];
  if (showSonnet) cand.push({ key: "seven_day_sonnet", title: "Current week (Sonnet only)", group: "weekly", date: true, limit: rl.seven_day_sonnet });
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    if (!m || !m.display_name) continue;
    const name = str(m.display_name, 40);
    cand.push({ key: "model:" + name, title: "Current week (" + name + ")", group: "weekly", date: true, limit: { utilization: m.utilization, resets_at: m.resets_at } });
  }
  for (const c of cand) {
    if (!c.limit || typeof c.limit !== "object") continue;
    const u = num(c.limit.utilization);
    if (u === null) continue;
    out.rows.push({ key: c.key, title: c.title, group: c.group, always_date: c.date, utilization: u, resets_at: iso(c.limit.resets_at) });
  }
  if (rl.extra_usage && typeof rl.extra_usage === "object") out.extra_usage = { is_enabled: !!rl.extra_usage.is_enabled };
  return out;
}

/**
 * Ask a throwaway CLI for get_usage. Resolves with the raw answer. The child
 * gets no prompt, so there is no model turn and no transcript.
 */
const PROBE_NAME = "joya-internal-usage-probe"; // lib/targets.js isInternal: never shown as a session
function probe(cliPath, { timeoutMs = 25000, cwd = os.tmpdir(), env = process.env, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Named, so the session registry lists it as Joya's own (not "tmp-9c", derived from the cwd), and hidden by the supervisor.
      child = spawnFn(cliPath, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "-n", PROBE_NAME], { cwd, env: { ...env, CLAUDE_CODE_SESSION_NAME: PROBE_NAME, JOYA_INTERNAL: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      return reject(e);
    }
    let buf = "";
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        child.kill("SIGTERM");
      } catch (_) {
        /* gone */
      }
      if (err) reject(err);
      else resolve(val);
    };
    const t = setTimeout(() => finish(new Error("the usage check did not answer in time")), timeoutMs);
    const send = (o) => {
      try {
        child.stdin.write(JSON.stringify(o) + "\n");
      } catch (e) {
        finish(e);
      }
    };
    child.on("error", (e) => finish(e));
    child.on("exit", () => finish(new Error("the usage check ended without an answer")));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.length > 4 * 1024 * 1024) return finish(new Error("the usage check answered too much"));
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (ev.type !== "control_response" || !ev.response) continue;
        const r = ev.response;
        if (r.request_id === "usage-init") {
          if (r.subtype !== "success") return finish(new Error("the usage check could not start: " + (r.error || "unknown")));
          send({ type: "control_request", request_id: "usage-get", request: { subtype: "get_usage", skip_behaviors: true } });
        } else if (r.request_id === "usage-get") {
          if (r.subtype !== "success") return finish(new Error(r.error || "the CLI refused the usage check"));
          return finish(null, r.response || {});
        }
      }
    });
    send({ type: "control_request", request_id: "usage-init", request: { subtype: "initialize" } });
  });
}

/**
 * The cache in front of the CLI. `live()` returns a promise of the raw answer
 * from JOYA AI's CLI, or null when JOYA AI is not running; `fallback()` asks a
 * throwaway CLI. One question at a time; answers younger than `ttlMs` are
 * reused. A failure keeps the last good answer, marked stale, with the error.
 */
function createPlanUsage({ live, fallback, ttlMs = 50000, fallbackTtlMs = 120000, now = () => Date.now() }) {
  let last = null; // { plan, source, fetchedMs }
  let lastError = null; // { message, atMs }
  let inflight = null;

  async function fetchOnce() {
    let raw = null;
    let source = "joya-ai";
    const p = live ? live() : null;
    if (p) raw = await p;
    else {
      if (!fallback) throw new Error("JOYA AI is not running");
      source = "probe";
      raw = await fallback();
    }
    const at = now();
    last = { plan: shapePlan(raw, new Date(at).toISOString()), source, fetchedMs: at };
    lastError = null;
  }

  function view() {
    const t = now();
    return {
      plan: last ? last.plan : null,
      source: last ? last.source : null,
      fetched_at: last ? new Date(last.fetchedMs).toISOString() : null,
      age_s: last ? Math.round((t - last.fetchedMs) / 1000) : null,
      stale: !last || !!lastError,
      error: lastError ? lastError.message : null,
      error_at: lastError ? new Date(lastError.atMs).toISOString() : null,
    };
  }

  async function get({ refresh = true } = {}) {
    if (!refresh) return view();
    const t = now();
    const ttl = last && last.source === "probe" ? fallbackTtlMs : ttlMs;
    const fresh = last && t - last.fetchedMs < ttl;
    // After a failure, wait a TTL before asking again.
    const cooling = lastError && t - lastError.atMs < ttlMs;
    if (!fresh && !cooling) {
      if (!inflight) {
        inflight = fetchOnce()
          .catch((e) => {
            lastError = { message: str(e && e.message ? e.message : String(e), 200), atMs: now() };
          })
          .finally(() => {
            inflight = null;
          });
      }
      await inflight;
    }
    return view();
  }

  return { get, view };
}

module.exports = { shapePlan, probe, createPlanUsage, PROBE_NAME };
