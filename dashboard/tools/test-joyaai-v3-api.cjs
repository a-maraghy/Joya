/**
 * The panel's side of Command Center v3, phase 1: the request cleaners in
 * lib/joyaai.js and the /joya-ai/api routes that use them.
 *
 *     node dashboard/tools/test-joyaai-v3-api.cjs
 *
 * The cleaners turn a browser's JSON into exactly what the supervisor accepts
 * (it checks again). The route checks read server.js itself: every new route
 * needs joyaai.use, every write also needs the CSRF token, and no write goes
 * out without a cleaner in front of it.
 */
const fs = require("fs");
const path = require("path");
const m = require(path.join(__dirname, "..", "lib", "joyaai.js"));

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
const refuses = (f, re) => {
  try {
    f();
    return false;
  } catch (e) {
    return e.code === "invalid" && (!re || re.test(e.message));
  }
};

/* ------------------------------------------------------------- orders --- */
const good = { name: " Morning briefing ", schedule: { kind: "daily", at: "07:30" }, target: "joya-ai", prompt: "Check the box." };
const o = m.cleanOrder(good, false);
check("an order is trimmed and defaults to the Command Center", o.name === "Morning briefing" && o.delivery.join() === "cc" && o.schedule.at === "07:30");
check("an order needs a name", refuses(() => m.cleanOrder({ ...good, name: "" }, false), /Name/));
check("an order needs a prompt", refuses(() => m.cleanOrder({ ...good, prompt: "  " }, false)));
check("a bad time is refused", refuses(() => m.cleanOrder({ ...good, schedule: { kind: "daily", at: "7:30" } }, false)));
check("an unknown schedule kind is refused", refuses(() => m.cleanOrder({ ...good, schedule: { kind: "monthly", at: "07:30" } }, false)));
check("a cron with letters is refused", refuses(() => m.cleanOrder({ ...good, schedule: { kind: "cron", cron: "rm -rf / * * *" } }, false)));
check("unknown delivery is refused", refuses(() => m.cleanOrder({ ...good, delivery: ["email"] }, false)));
check("a target with a newline is refused", refuses(() => m.cleanOrder({ ...good, target: "a\nb" }, false)));
check("paused must be a boolean", refuses(() => m.cleanOrder({ ...good, paused: "yes" }, false)));
const part = m.cleanOrder({ name: "x" }, true);
check("a partial update carries only what was given", Object.keys(part).join() === "name");

/* -------------------------------------------------------------- rules --- */
check("a rule is cleaned", JSON.stringify(m.cleanRule({ effect: "deny", tool: "Bash", pattern: "git push --force*", note: "no" }, false)) === JSON.stringify({ effect: "deny", tool: "Bash", pattern: "git push --force*", note: "no" }));
check("an unknown effect is refused", refuses(() => m.cleanRule({ effect: "maybe", tool: "Bash", pattern: "x" }, false)));
check("a rule needs a pattern", refuses(() => m.cleanRule({ effect: "deny", tool: "Bash" }, false)));
check("a NUL byte is refused", refuses(() => m.cleanRule({ effect: "deny", tool: "Bash", pattern: "a\u0000b" }, false)));
check("Always allow: pattern and tool", JSON.stringify(m.cleanAlwaysRule({ rule: { pattern: "systemctl restart odoo", tool: "Bash" } })) === JSON.stringify({ rule_pattern: "systemctl restart odoo", rule_tool: "Bash" }));
check("Always allow: no rule means approve once", m.cleanAlwaysRule({}) === null);
check("Always allow: tool 'any' is refused (exactly this call)", refuses(() => m.cleanAlwaysRule({ rule: { pattern: "x", tool: "any" } })));

/* --------------------------------------------------------- the rest --- */
check("budget: dollars and a percentage", JSON.stringify(m.cleanBudget({ daily_usd: "40", warn_pct: "80" })) === JSON.stringify({ daily_usd: 40, warn_pct: 80 }));
check("budget: empty means none", m.cleanBudget({ daily_usd: "", warn_pct: 90 }).daily_usd === null);
check("budget: warn below 50% refused", refuses(() => m.cleanBudget({ daily_usd: 10, warn_pct: 20 })));
check("budget: negative refused", refuses(() => m.cleanBudget({ daily_usd: -1 })));
check("mission ids: 7 and M-7 both become M-7", m.missionIdOf("7") === "M-7" && m.missionIdOf("m-7") === "M-7");
check("mission ids: junk refused", refuses(() => m.missionIdOf("../7")));
check("ids: digits only", m.idOf("12", "rule") === 12 && refuses(() => m.idOf("1e3", "rule")) && refuses(() => m.idOf("0", "rule")));
check("session ids must be UUIDs", m.SESSION_ID_RE.test("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") && !m.SESSION_ID_RE.test("../../etc/passwd"));
check("five watchers", m.WATCHERS.length === 5 && m.WATCHERS.includes("odoo_errors"));

/* ------------------------------------------------------------ routes --- */
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const routes = [...src.matchAll(/app\.(get|post)\("(\/joya-ai\/api\/[^"]+)",\s*([^\n]*)/g)].map((x) => ({ method: x[1], path: x[2], rest: x[3] }));
const v3 = ["machine", "missions", "decisions", "watchers", "orders", "rules", "cost", "sessions/:sid/mirror", "rule-suggestion"];
const mine = routes.filter((r) => v3.some((k) => r.path.includes(k)));
check("the new routes are there", mine.length >= 20, String(mine.length));
check("every new GET needs joyaai.use", mine.filter((r) => r.method === "get").every((r) => /^\.\.\.joyaAiGuard/.test(r.rest)), mine.filter((r) => r.method === "get" && !/^\.\.\.joyaAiGuard/.test(r.rest)).map((r) => r.path).join(" "));
check("every new POST needs joyaai.use and CSRF", mine.filter((r) => r.method === "post").every((r) => /^\.\.\.joyaAiWrite/.test(r.rest)), mine.filter((r) => r.method === "post" && !/^\.\.\.joyaAiWrite/.test(r.rest)).map((r) => r.path).join(" "));
check("rules/test is registered before rules/:id", src.indexOf('"/joya-ai/api/rules/test"') < src.indexOf('"/joya-ai/api/rules/:id"'));
check("no route passes the raw body to the supervisor", !/joyaAiOp\([^)]*req\.body\s*[,)]/.test(src));
check("watcher-inject is not reachable from the panel", !/watcher-inject/.test(src));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
