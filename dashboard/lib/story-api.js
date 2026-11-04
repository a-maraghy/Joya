"use strict";
/**
 * The panel's side of the session story and the day timeline (2026-10-20).
 *
 * Both are read-only supervisor ops (joya-ai/lib/story.js: "session-story",
 * "story-day"); the supervisor parses the transcripts and the ledger. Here the
 * request is cleaned and the answer is cached for a few seconds per key, with
 * one call in flight per key: a Command Center that polls, a scrubber that is
 * dragged and several tabs open share one answer.
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TTL = { session: 4000, day: 15000 };
const MAX_KEYS = 64;

class StoryApiError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid";
  }
}

/** ?day=YYYY-MM-DD, or nothing (today, in the supervisor's zone). */
function cleanDay(v) {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!DAY_RE.test(s)) throw new StoryApiError("The day must be YYYY-MM-DD.");
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new StoryApiError("No such day.");
  return s;
}

function cleanSession(v) {
  const s = String(v || "");
  if (!SESSION_ID_RE.test(s)) throw new StoryApiError("No such session.");
  return s;
}

/**
 * A small cache: get(kind, key, fn) answers from a fresh entry, else joins the
 * call in flight, else calls fn(). Failures are not cached.
 */
function createCache({ now = () => Date.now(), ttl = TTL } = {}) {
  const hit = new Map(); // "kind|key" -> { at, data }
  const flying = new Map(); // "kind|key" -> promise
  return {
    async get(kind, key, fn) {
      const k = kind + "|" + (key || "");
      const h = hit.get(k);
      if (h && now() - h.at < (ttl[kind] || 5000)) return h.data;
      if (flying.has(k)) return flying.get(k);
      const p = Promise.resolve()
        .then(fn)
        .then((data) => {
          hit.delete(k);
          hit.set(k, { at: now(), data });
          while (hit.size > MAX_KEYS) hit.delete(hit.keys().next().value);
          return data;
        })
        .finally(() => flying.delete(k));
      flying.set(k, p);
      return p;
    },
    size: () => hit.size,
    clear: () => hit.clear(),
  };
}

module.exports = { cleanDay, cleanSession, createCache, SESSION_ID_RE, TTL, StoryApiError };
