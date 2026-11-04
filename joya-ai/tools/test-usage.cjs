/**
 * Claude plan usage (lib/usage.js) and the token counts (cost.tokenReport).
 *
 *     node joya-ai/tools/test-usage.cjs
 *
 * shapePlan: /usage's rows, order and labels from a get_usage answer; the
 * Sonnet row only for max/team/unknown plans; absent or null windows skipped;
 * nothing else passed on. createPlanUsage: the cache, one question at a time,
 * the throwaway-CLI fallback when JOYA AI is not running, a failure keeping
 * the last answer marked stale. probe: initialize + get_usage against the fake
 * CLI. tokenReport: per day and per session, JOYA AI's ids as one row, names
 * merged, the tail folded into "Other sessions".
 */
const path = require("path");
const { spawn } = require("child_process");
const usage = require(path.join(__dirname, "..", "lib", "usage.js"));
const cost = require(path.join(__dirname, "..", "lib", "cost.js"));

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}

// The real answer from CLI 2.1.283 on this box, 2026-09-30 09:03 CEST (trimmed of the unnamed buckets).
const REAL = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 18, resets_at: "2026-09-30T09:30:00.411748+00:00", limit_dollars: null },
    seven_day: { utilization: 39, resets_at: "2026-10-05T13:00:00.411767+00:00" },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: false, monthly_limit: null },
    limits: [{ kind: "session", percent: 18 }],
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-05T13:00:00+00:00" }],
  },
  behaviors: null,
};

/* ------------------------------------------------------------ shapePlan --- */
{
  const p = usage.shapePlan(REAL, "2026-09-30T07:03:35Z");
  check("rows in /usage's order with its labels", p.rows.map((r) => r.title).join("|") === "Current session|Current week (all models)|Current week (Fable)", JSON.stringify(p.rows));
  check("utilization and reset passed through (ISO)", p.rows[0].utilization === 18 && p.rows[0].resets_at === "2026-09-30T09:30:00.411Z" && p.rows[1].resets_at === "2026-10-05T13:00:00.411Z");
  check("session row does not force the date; weekly rows do", p.rows[0].always_date === false && p.rows.slice(1).every((r) => r.always_date));
  check("a 0% window is shown (0 is a value)", p.rows[2].utilization === 0);
  check("the null Sonnet window is skipped", !p.rows.some((r) => r.key === "seven_day_sonnet"));
  check("unnamed buckets are not passed on", !JSON.stringify(p).includes("nimbus") && !JSON.stringify(p).includes("limit_dollars"));
  check("plan type and availability", p.subscription_type === "max" && p.available === true && p.at === "2026-09-30T07:03:35.000Z");
  check("extra usage: only whether it is on", JSON.stringify(p.extra_usage) === '{"is_enabled":false}');

  const withSonnet = { ...REAL, rate_limits: { ...REAL.rate_limits, seven_day_sonnet: { utilization: 7, resets_at: "2026-10-05T13:00:00Z" } } };
  const s = usage.shapePlan(withSonnet);
  check("Sonnet row shown for a max plan, after all-models", s.rows.map((r) => r.key).join(",") === "five_hour,seven_day,seven_day_sonnet,model:Fable");
  const pro = usage.shapePlan({ ...withSonnet, subscription_type: "pro" });
  check("Sonnet row hidden for a pro plan (as /usage does)", !pro.rows.some((r) => r.key === "seven_day_sonnet"));
  const nul = usage.shapePlan({ ...withSonnet, subscription_type: null });
  check("Sonnet row shown when the plan is unknown", nul.rows.some((r) => r.key === "seven_day_sonnet"));
  const nu = usage.shapePlan({ subscription_type: "max", rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 102.5, resets_at: "bad" } } });
  check("null utilization skipped; >100 kept; a bad date becomes null", nu.rows.length === 1 && nu.rows[0].utilization === 102.5 && nu.rows[0].resets_at === null);
  const none = usage.shapePlan({ subscription_type: null, rate_limits_available: false, rate_limits: null });
  check("API-key session: not available, no rows", none.available === false && none.rows.length === 0);
  check("garbage in, empty out", usage.shapePlan(null).rows.length === 0 && usage.shapePlan("x").available === false);
}

/* ---------------------------------------------------- createPlanUsage --- */
(async () => {
  {
    let t = 1000000;
    let liveCalls = 0;
    let probeCalls = 0;
    let running = true;
    let fail = null;
    const pu = usage.createPlanUsage({
      now: () => t,
      ttlMs: 50000,
      fallbackTtlMs: 120000,
      live: () => {
        if (!running) return null;
        liveCalls++;
        return new Promise((res, rej) => setTimeout(() => (fail ? rej(new Error(fail)) : res(REAL)), 20));
      },
      fallback: () => {
        probeCalls++;
        return Promise.resolve(REAL);
      },
    });
    const a = await pu.get();
    check("first ask goes to JOYA AI's CLI", liveCalls === 1 && a.source === "joya-ai" && a.stale === false && a.plan.rows.length === 3);
    const [b, c] = await Promise.all([pu.get(), pu.get()]);
    check("within the TTL the cached answer is reused", liveCalls === 1 && b.fetched_at === a.fetched_at && c.fetched_at === a.fetched_at);
    t += 51000;
    const [d, e] = await Promise.all([pu.get(), pu.get()]);
    check("after the TTL one question, shared by concurrent askers", liveCalls === 2 && d.fetched_at === e.fetched_at && d.age_s === 0);
    const cached = await pu.get({ refresh: false });
    check("refresh:false never asks", liveCalls === 2 && cached.fetched_at === d.fetched_at);
    t += 51000;
    fail = "no answer from the CLI";
    const f = await pu.get();
    check("a failure keeps the last answer, marked stale, with the error", liveCalls === 3 && f.stale === true && f.error === "no answer from the CLI" && f.plan && f.plan.rows.length === 3 && f.age_s === 51);
    t += 10000;
    await pu.get();
    check("after a failure it waits a TTL before asking again", liveCalls === 3);
    t += 50000;
    fail = null;
    const g = await pu.get();
    check("then recovers", liveCalls === 4 && g.stale === false && g.error === null);
    running = false;
    t += 51000;
    const h = await pu.get();
    check("JOYA AI not running: a throwaway CLI is asked", probeCalls === 1 && h.source === "probe" && !h.stale);
    t += 60000;
    await pu.get();
    check("a probe answer is kept longer (2 min)", probeCalls === 1);
    const none = usage.createPlanUsage({ live: () => null, fallback: null });
    const n = await none.get();
    check("no source at all: honest unknown", n.plan === null && n.stale === true && /not running/.test(n.error));
  }

  /* ------------------------------------------------------------- probe --- */
  {
    const fake = path.join(__dirname, "fake-claude.cjs");
    let seenArgs = null, seenEnv = null;
    const spawnFn = (cmd, args, opts) => { seenArgs = args; seenEnv = opts.env; return spawn(process.execPath, [fake, ...args], opts); };
    const raw = await usage.probe("fake", { spawnFn, timeoutMs: 15000, env: { ...process.env, HOME: require("os").tmpdir() } }).catch((e) => ({ err: e.message }));
    const p = usage.shapePlan(raw);
    check("probe: initialize then get_usage against the fake CLI", p.rows.length === 3 && p.rows[1].utilization === 39.6, JSON.stringify(raw).slice(0, 300));
    check("probe: it registers as Joya's own (named joya-internal-usage-probe, never \"tmp-9c\"), so the supervisor hides it",
      seenArgs.includes("-n") && seenArgs[seenArgs.indexOf("-n") + 1] === "joya-internal-usage-probe" && seenEnv.CLAUDE_CODE_SESSION_NAME === "joya-internal-usage-probe" && seenEnv.JOYA_INTERNAL === "1" &&
      require(path.join(__dirname, "..", "lib", "targets.js")).isInternal({ name: usage.PROBE_NAME }));
    const bad = await usage.probe("/nonexistent/claude", { timeoutMs: 5000 }).then(() => "resolved", (e) => e.message);
    check("probe: a missing CLI is an error, not a hang", bad !== "resolved", bad);
  }

  /* -------------------------------------------------------- tokenReport --- */
  {
    const days = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"];
    const r = (sid, day, i, o, cr, cw) => ({ session_id: sid, day, input: i, output: o, cache_read: cr, cache_write: cw });
    const rows = [
      r("self-1", "2026-09-30", 10, 100, 1000, 50),
      r("self-2", "2026-09-30", 1, 2, 3, 4), // an older JOYA AI id: same row
      r("os-a", "2026-09-30", 5, 50, 500, 25),
      r("os-b", "2026-09-29", 5, 50, 500, 25), // another id with the same name
      r("giza", "2026-09-28", 7, 70, 700, 35),
      r("old", "2026-09-10", 9, 9, 9, 9), // outside the window
      ...Array.from({ length: 5 }, (_, i) => r("tmp-" + i, "2026-09-30", 1, 1, 1, 1)),
    ];
    const names = { "os-a": "JOYA AI OS", "os-b": "JOYA AI OS", giza: "Giza Odoo Automation" };
    const rep = cost.tokenReport(rows, { days, selfIds: new Set(["self-1", "self-2"]), selfName: "JOYA AI", nameOf: (s) => names[s] || "tmp " + s, top: 2 });
    const tt = rep.periods.today;
    check("today: JOYA AI first, its ids merged", tt.sessions[0].name === "JOYA AI" && tt.sessions[0].self && tt.sessions[0].session_count === 2 && tt.sessions[0].output === 102);
    check("today totals add every session", tt.totals.input === 10 + 1 + 5 + 5 && tt.totals.total === 1160 + 10 + 580 + 20, JSON.stringify(tt.totals));
    check("the tail is folded into Other sessions", tt.sessions.length === 3 && tt.sessions[2].other && /^Other sessions \(5\)$/.test(tt.sessions[2].name) && tt.sessions[2].total === 20 && tt.sessions[2].session_count === 5, JSON.stringify(tt.sessions.map((s) => s.name)));
    const wk = rep.periods.week;
    const os1 = wk.sessions.find((s) => s.name === "JOYA AI OS");
    check("week: sessions sharing a name are one row", os1 && os1.session_count === 2 && os1.output === 100);
    check("week: range and the out-of-window row ignored", wk.from === "2026-09-24" && wk.to === "2026-09-30" && wk.totals.input === 10 + 1 + 5 + 5 + 7 + 5);
    check("per day series covers the window, oldest first", rep.days.length === 7 && rep.days[6].day === "2026-09-30" && rep.days[4].output === 70 && rep.days[0].total === 0);
    check("cache read and write kept apart", tt.sessions[0].cache_read === 1003 && tt.sessions[0].cache_write === 54);
    const empty = cost.tokenReport([], { days });
    check("no rows: zero totals, no sessions", empty.periods.today.totals.total === 0 && empty.periods.today.sessions.length === 0);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
