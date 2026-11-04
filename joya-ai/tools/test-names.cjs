/**
 * The assistant's names (lib/names.js): shown as JOYA AI, and during the
 * transition every "is this name us?" check accepts the old JOYA AI (and
 * JOYA Bot) too, as well as the internal id joya-ai. Also: a mission step
 * given to the assistant by any of its names is stored as "joya-ai".
 *
 *     node joya-ai/tools/test-names.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const names = require(path.join(__dirname, "..", "lib", "names.js"));
const { Ledger } = require(path.join(__dirname, "..", "lib", "ledger.js"));
const { Missions } = require(path.join(__dirname, "..", "lib", "missions.js"));

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

check("the display name is JOYA AI", names.DISPLAY_NAME === "JOYA AI");
check("the old names are JOYA AI and JOYA Bot", names.OLD_NAMES.includes("JOYA AI") && names.OLD_NAMES.includes("JOYA Bot"));
for (const n of ["JOYA AI", "JOYA AI", "joya ai", "Joya Ai", "joya-ai", "joya-ai", "JOYA AI [a1b2c3]", "  JOYA AI  ", "JOYA Bot", "joya_bot"])
  check(`"${n}" is the assistant`, names.isSelfName(n) === true);
for (const n of ["JOYA Agent OS", "Odoo 19 VPS setup", "joya", "joya", "JOYA AI helper", "", null, undefined])
  check(`"${n}" is not the assistant`, names.isSelfName(n) === false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-names-"));
const M = new Missions(new Ledger(path.join(tmp, "ledger.db")));
const m = M.create({
  title: "Rename",
  goal: "g",
  steps: [{ title: "a", target: "JOYA AI" }, { title: "b", target: "JOYA AI" }, { title: "c", target: "joya-ai" }, { title: "d", target: "JOYA Agent OS" }],
  actor: "joya-ai",
});
check("steps given to JOYA AI / JOYA AI are stored as joya-ai", m.steps.map((s) => s.target).join("|") === "joya-ai|joya-ai|joya-ai|JOYA Agent OS", m.steps.map((s) => s.target).join("|"));
const upd = M.updateStep(m.id, 4, { target: "JOYA AI" });
check("re-targeting a step to JOYA AI stores joya-ai", upd.steps[3].target === "joya-ai", upd.steps[3].target);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
