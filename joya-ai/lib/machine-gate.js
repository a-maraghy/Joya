"use strict";
/**
 * The gate for a session JOYA AI runs on one of the user's own computers
 * (Path A laptop control, 2026-10-08). Pure: the supervisor's machine-ask op
 * calls decide() for every permission question the laptop's Claude Code CLI
 * asks (relayed by the desktop app -> the dashboard -> here).
 *
 *   allow  answered at once (recorded in the action log, no card)
 *   ask    an approval card in Joya, attributed to the laptop session
 *   deny   refused, with the reason
 *
 * The laptop session's hands (screen, mouse, keyboard, UI Automation, the
 * browser, document creation) are the desktop app's own MCP tools; they are
 * pre-allowed in the CLI and gate themselves on the laptop (an active lease,
 * risky targets such as Send / Buy / Delete -> an approval with origin
 * "hands"). Those approvals come here too, as tool mcp__joya-hands__*: always
 * a card.
 *
 * What needs a card: deleting, installing, sending or posting over the
 * network, changing the system (services, registry, scheduled tasks, power),
 * writing outside the user's own files, reading the user's hidden or app data
 * folders. What is refused outright: wiping disks, switching off security,
 * obfuscated or downloaded-and-run code, credential dumping, elevation (UAC
 * prompts are for the user).
 *
 * "The user's own files": under their profile folder (ctx.home, from the
 * app's hello), not AppData, not a hidden (dot) folder, not NTUSER*; or in a
 * folder the user added for that computer on the Computers page (ctx.folders).
 *
 * The browser (0.1.11): the user's own Chrome through their Claude in Chrome
 * extension, tools mcp__claude-in-chrome__*. The CLI asks about every one of
 * them (the app gives it an `ask` rule for the whole server), the app refuses
 * passwords, card numbers and Joya's own pages at once and sends the rest
 * here with a hint (the labels of the elements a step targets, the tabs'
 * addresses). decideBrowser(): reading, scrolling, opening pages and plain
 * typing run; a step that submits, sends, buys, pays, posts, publishes,
 * or deletes -- a click or a form choice whose description or
 * target says so, Enter, a script, an upload, a saved shortcut, another
 * computer's browser -- is a card (Windows Hello); passwords, payment details
 * and Joya's own pages are refused here too.
 */

const HANDS_PREFIX = "mcp__joya-hands__";
const BROWSER_PREFIX = "mcp__claude-in-chrome__";

/* -------------------------------------------------------------- paths --- */

/** "C:/Users/A/x" / "~\x" / "%USERPROFILE%\x" / "$env:USERPROFILE\x" -> "c:\users\a\x" (lower case, backslashes, no trailing \). */
function normPath(p, home) {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "");
  const h = String(home || "");
  if (h) {
    s = s.replace(/^~(?=[\\/]|$)/, h).replace(/^%userprofile%/i, h).replace(/^\$env:userprofile/i, h).replace(/^\$home(?=[\\/]|$)/i, h);
  }
  s = s.replace(/\//g, "\\").replace(/\\+/g, "\\");
  // Git Bash style /c/Users/A -> c:\users\a
  const gb = /^\\([a-z])(\\|$)/i.exec(s);
  if (gb) s = gb[1] + ":\\" + s.slice(3);
  const parts = [];
  for (const part of s.split("\\")) {
    if (part === "." || (part === "" && parts.length)) continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("\\").toLowerCase().replace(/\\$/, "");
}

/** Is `p` (absolute, or relative to the session's Documents folder) one of the user's own files? */
function inUserFiles(p, home, folders) {
  if (!home) return false;
  const h = normPath(home, home);
  let n = normPath(p, home);
  if (!/^[a-z]:\\|^\\\\/.test(n)) n = normPath(home + "\\Documents\\" + p, home); // relative: the CLI's cwd
  // A folder the user added on the Computers page (a full local path, checked when it was added).
  for (const f of Array.isArray(folders) ? folders : []) {
    const fn = normPath(f, home);
    if (/^[a-z]:\\./.test(fn) && (n === fn || n.startsWith(fn + "\\")) && !n.slice(fn.length).split("\\").some((x) => x.startsWith("."))) return true;
  }
  if (n !== h && !n.startsWith(h + "\\")) return false;
  const rest = n.slice(h.length + 1).split("\\").filter(Boolean);
  if (!rest.length) return true;
  if (rest[0] === "appdata" || /^ntuser/.test(rest[0])) return false;
  return !rest.some((x) => x.startsWith("."));
}

/** Absolute Windows paths (and UNC paths) named in a command line. */
function pathsIn(cmd) {
  const out = [];
  const re = /(?:"([a-z]:[\\/][^"]*)"|'([a-z]:[\\/][^']*)'|(\\\\[^\s"'|;]+)|\b([a-z]:[\\/][^\s"'|;,)]*))/gi;
  let m;
  while ((m = re.exec(String(cmd || "")))) out.push(m[1] || m[2] || m[3] || m[4]);
  return out;
}

/* ----------------------------------------------------------- commands --- */

const DENY = [
  [/\b(format(-volume)?\s|diskpart\b|bcdedit\b|vssadmin\s+delete|wbadmin\s+delete|cipher(\.exe)?\s+\/w|clear-disk\b|initialize-disk\b|remove-partition\b|mkfs\b|dd\s+if=)/i, "wipes a disk or the boot setup"],
  [/(set-mppreference\b[^|;]*-disable|add-mppreference\b[^|;]*-exclusion|disable-windowsoptionalfeature\b|set-netfirewallprofile\b[^|;]*-enabled\s+(false|0)|netsh\s+(adv)?firewall\b[^|;]*\b(off|disable))/i, "switches off security"],
  [/(-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{24,}|frombase64string\b[^|;]*\|\s*(iex|invoke-expression)\b)/i, "runs obfuscated code"],
  [/((iex|invoke-expression)\b[^;]*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient|curl|wget)\b|\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^;]*\|\s*(iex|invoke-expression|bash|sh|powershell|pwsh)\b)/i, "downloads and runs code"],
  [/\b(mimikatz|vaultcmd|get-storedcredential|cmdkey\s+\/list|procdump[^|;]*lsass|reg(\.exe)?\s+save\s+hklm\\(sam|security|system))\b/i, "reads stored passwords"],
  [/(-verb\s+runas\b|\brunas(\.exe)?\s|\bsudo\s|\bgsudo\b)/i, "asks for administrator rights (a UAC prompt is for the user)"],
];

const ASK = [
  [/(^|[\s;|&(])(remove-item|ri|rm|rmdir|rd|del|erase|clear-recyclebin|remove-appxpackage)(\s|$)/i, "delete", "Delete files"],
  [/(\b(winget|choco|scoop)\s+(install|upgrade|uninstall|remove)\b|\bmsiexec\b|\binstall-(module|package|script)\b|\badd-appxpackage\b|\bnpm\s+(i|install|add)\b[^|;]*\s(-g|--global)\b|\bpip3?\s+install\b|\.msi\b|\bsetup\.exe\b|\buninstall(-package)?\b)/i, "install", "Install or remove software"],
  [/(\bsend-mailmessage\b|\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b[^|;]*-(method\s+(post|put|patch|delete)|body|infile|form)\b|\bcurl(\.exe)?\b[^|;]*\s(-x\s*(post|put|patch|delete)|-d\b|--data|-f\b|--form|-t\b|--upload-file)|\b(ftp|scp|sftp|rsync)\s|\bnet\s+use\b|\bgit\s+push\b|\bgh\s+(pr|issue|release)\s+create\b)/i, "network", "Send data over the network"],
  [/(\b(stop-computer|restart-computer|shutdown|logoff|stop-process|taskkill|kill)\b|\b(set|new|remove)-itemproperty\b|\breg(\.exe)?\s+(add|delete|import|copy)\b|\b(set|stop|start|new|remove|restart)-service\b|\bsc(\.exe)?\s+(config|delete|create|stop|start)\b|\bschtasks\b|\b(register|unregister|set)-scheduledtask\b|\bset-executionpolicy\b|\bnetsh\b|\bset-netipaddress\b|\bnew-netfirewallrule\b|\bbitsadmin\b|\bwmic\b)/i, "system", "Change the system"],
];

// Verbs that write: a path outside the user's files after one of these needs a card.
const WRITE_VERB = /\b(new-item|ni|set-content|sc|add-content|ac|out-file|copy-item|copy|cp|cpi|move-item|move|mv|mi|rename-item|ren|rni|mkdir|md|expand-archive|compress-archive|tee-object|tee|export-csv|touch)\b|>>?/i;

/** One shell command line (PowerShell or Git Bash). */
function decideCommand(cmd, ctx) {
  const c = String(cmd || "");
  for (const [re, why] of DENY) if (re.test(c)) return { decision: "deny", category: "refused", label: "Refused on this computer", reason: `This command ${why}; JOYA AI never does that on your computer.` };
  for (const [re, category, label] of ASK) if (re.test(c)) return { decision: "ask", category, label, reason: `${label}: needs your approval.` };
  if (WRITE_VERB.test(c)) {
    const outside = pathsIn(c).filter((p) => !inUserFiles(p, ctx.home, ctx.folders));
    if (outside.length) return { decision: "ask", category: "outside", label: "Change files outside your own", reason: `It writes to ${outside.slice(0, 2).join(", ")}, outside your own files.` };
  }
  return { decision: "allow", category: "command", label: "Command on your computer", reason: null };
}

/* ------------------------------------------- approved deletes (2026-10-08) --- */
/*
 * The laptop session sometimes asks request_approval ("Delete the file X") and
 * then runs the delete -- which the gate would put on a second card. An
 * approved request_approval that names files to delete leaves a narrow
 * allowance on the supervisor (lib/machines.js keeps it: this lease's session
 * only, 5 minutes, each file once). The gate honours it only for a command
 * that does nothing but delete exactly those files (and, at most, check them
 * with Test-Path): one literal path per delete, no wildcards, no variables
 * other than the profile folder, no pipes, no redirection, no sub-commands,
 * no -Recurse. Anything else is a card as before; deny rules are checked
 * first and still win.
 */

const ALLOWANCE_MS = 5 * 60 * 1000;
const MAX_ALLOWED_PATHS = 10;
const DELETE_CMDS = new Set(["remove-item", "ri", "rm", "del", "erase"]);
const PROFILE_FOLDERS = new Set(["documents", "desktop", "downloads", "pictures", "music", "videos", "onedrive"]);
const WILDCARD = /[*?[\]]/;

/** Expand the profile-folder spellings and normalise against `base` when relative; null unless absolute. */
function absPath(p, home, base) {
  const raw = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (!raw || !home || WILDCARD.test(raw)) return null;
  let n = normPath(raw, home);
  if (/[$%]/.test(n)) return null; // a variable other than the profile folder: its value is unknown here
  if (!/^[a-z]:\\|^\\\\/.test(n)) n = normPath(base + "\\" + raw, home);
  return /^[a-z]:\\./.test(n) ? n : null;
}

/**
 * A file an approval names, resolved as a person reads it: absolute, or under the profile
 * ("Documents\JOYA AI\x.xlsx", "~\Desktop\a.txt"), else under Documents (the session's folder).
 * null unless it is one of the user's own files.
 */
function approvalPath(p, home) {
  const raw = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/[.\s]+$/, "");
  const first = raw.split(/[\\/]/)[0].toLowerCase();
  const n = absPath(raw, home, PROFILE_FOLDERS.has(first) ? home : home + "\\Documents");
  return n && inUserFiles(n, home) ? n : null;
}

/**
 * The deletes an approved request_approval allows, or null: its `delete_paths` (the app's
 * request_approval from 0.1.7) or, from an older app, a one-file summary "Delete the file <path>".
 */
function approvalScope(input, home) {
  const i = input && typeof input === "object" ? input : {};
  let list = null;
  if (Array.isArray(i.delete_paths) && i.delete_paths.length) {
    if (i.delete_paths.length > MAX_ALLOWED_PATHS || i.delete_paths.some((x) => typeof x !== "string")) return null;
    list = i.delete_paths;
  } else {
    const m = /^\s*delete\s+(?:the\s+)?(?:file\s+)?("[^"]+"|'[^']+'|[^"'\n]+?)\s*(?:\((?:only|just)\s+(?:that|this)\s+file\))?\s*\.?\s*$/i.exec(String(i.summary || i.action || ""));
    if (!m || /\s(and|or)\s|,|;/i.test(m[1])) return null; // one file, said plainly
    list = [m[1]];
  }
  const paths = list.map((p) => approvalPath(p, home));
  if (!paths.length || paths.some((p) => !p)) return null;
  return { kind: "delete", paths: [...new Set(paths)] };
}

/** A command line split into words (quoted words keep their content); null on unbalanced quotes. */
function words(stmt) {
  const out = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/y;
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const m = re.exec(stmt);
    if (!m || !m[0].trim()) break;
    out.push({ text: m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3], quoted: m[3] === undefined });
    at = re.lastIndex;
  }
  return stmt.slice(at).trim() ? null : out;
}

/**
 * If the command does nothing but delete files (and check them with Test-Path), the files it
 * deletes (normalised); otherwise null. Paths are literal, one per statement, relative ones
 * resolved against Documents (the CLI's working folder).
 */
function deleteTargets(cmd, home) {
  const c = String(cmd || "");
  if (!home || /[|&`<>{}()@]|\$\(/.test(c)) return null;
  const stmts = c.split(/[;\r\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!stmts.length || stmts.length > 2 * MAX_ALLOWED_PATHS) return null;
  const base = home + "\\Documents";
  const targets = [];
  for (const st of stmts) {
    const w = words(st);
    if (!w || !w.length || w[0].quoted) return null;
    const verb = w[0].text.toLowerCase();
    const isDelete = DELETE_CMDS.has(verb);
    if (!isDelete && verb !== "test-path") return null;
    const paths = [];
    for (let k = 1; k < w.length; k++) {
      const t = w[k];
      const f = t.quoted ? "" : t.text.toLowerCase();
      if (f === "-literalpath" || f === "-path") continue; // the next word is the path
      if (isDelete && (f === "-force" || f === "-f" || f === "-confirm:$false")) continue;
      if (f === "-erroraction" || f === "-ea") {
        const v = w[++k];
        if (!v || !/^(stop|silentlycontinue|continue|ignore)$/i.test(v.text)) return null;
        continue;
      }
      if (!isDelete && f === "-pathtype") {
        const v = w[++k];
        if (!v || !/^(leaf|any)$/i.test(v.text)) return null;
        continue;
      }
      if (f.startsWith("-")) return null; // -Recurse, -Include, -Filter ...: not a plain one-file delete
      const n = absPath(t.text, home, base);
      if (!n || !inUserFiles(n, home)) return null;
      paths.push(n);
    }
    if (paths.length !== 1) return null;
    if (isDelete) targets.push(paths[0]);
  }
  return targets.length ? targets : null;
}

/**
 * Does an allowance { paths, used: Set, expires_at: ms } cover this command? The files it would
 * use (each allowed, not used yet, named once), or null.
 */
function allowanceCovers(allowance, cmd, home, nowMs) {
  if (!allowance || !(nowMs <= allowance.expires_at)) return null;
  const t = deleteTargets(cmd, home);
  if (!t) return null;
  const uniq = [...new Set(t)];
  if (uniq.length !== t.length) return null;
  for (const p of uniq) if (!allowance.paths.includes(p) || allowance.used.has(p)) return null;
  return uniq;
}

/* ------------------------------------------------------------ the browser --- */

const B_READ = new Set(["tabs_context_mcp", "read_page", "find", "get_page_text", "read_console_messages", "read_network_requests", "list_connected_browsers", "shortcuts_list", "gif_creator", "resize_window", "tabs_create_mcp", "tabs_close_mcp"]);
const B_LOOK = new Set(["screenshot", "zoom", "scroll", "scroll_to", "wait", "hover"]);
const B_CLICK = new Set(["left_click", "right_click", "double_click", "triple_click", "left_click_drag"]);
// This install's own address (JOYA_PUBLIC_HOST, set by the installer).
const OWN_HOST = new RegExp("(^|\\.)" + String(process.env.JOYA_PUBLIC_HOST || "localhost").toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/\./g, "\\.") + "$", "i");

/** Words on a target (or in what a step says it does) that mean it cannot be taken back. */
const RISKY_WORDS = [
  "send", "submit", "post", "publish", "reply", "share", "tweet", "repost", "comment",
  "pay", "buy", "purchase", "checkout", "check out", "place order", "order now", "complete order", "book", "reserve", "transfer", "donate", "subscribe", "unsubscribe",
  "delete", "remove", "discard", "erase", "empty trash",
  "confirm", "sign", "approve", "authorize", "authorise", "agree", "accept", "allow", "grant", "invite", "upload", "install", "register", "apply",
  "sign up", "signup",
  // the step's own words ("Sends the reply", "Submits the form", "Places the order")
  "sends", "submits", "posts", "publishes", "pays", "buys", "purchases", "books", "deletes", "removes", "confirms", "signs", "approves", "accepts", "agrees", "uploads", "subscribes", "transfers", "shares", "replies", "registers", "applies", "authorizes", "places the order", "places an order",
  "ارسال", "ارسل", "ابعت", "نشر", "انشر", "شراء", "اشتر", "ادفع", "دفع", "حذف", "احذف", "تاكيد", "اكد", "تحويل", "مشاركه", "شارك", "اطلب", "اوافق", "توقيع",
];
/**
 * Signing in / logging in is not a card (the user, 2026-10-20): these phrases are taken out of a step's
 * words before RISKY_WORDS are looked for, so "Sign in" or "Log in with Google" runs, while "Sign in and
 * send" still asks and "Sign the contract" / "Sign up" still ask. Typing into a password, PIN, code or
 * payment field is refused whatever the button says (SECRET_WORDS, card numbers).
 */
const SIGN_IN_PHRASES = [
  "sign in", "signin", "sign into", "signs in", "signing in", "sign me in", "log in", "login", "log into", "logs in", "logging in", "log on", "logon", "log me in",
  "continue with google", "continue with microsoft", "continue with apple",
  "تسجيل الدخول", "سجل الدخول", "سجل دخول", "دخول",
];
function withoutSignIn(text) {
  let f = fold(text);
  const phrases = SIGN_IN_PHRASES.map((p) => fold(p).trim()).sort((a, b) => b.length - a.length);
  for (const p of phrases) {
    const forms = /[؀-ۿ]/.test(p) ? ["", "ال", "وال", "بال", "و", "ف", "ب", "ل"].map((pre) => pre + p) : [p];
    for (const w of forms) {
      while (f.includes(` ${w} `)) f = f.replace(` ${w} `, " ");
    }
  }
  return f;
}
/** The risky word a step's words carry, once signing in is set aside (null = none). */
function riskyWord(text) {
  return hasWord(withoutSignIn(text), RISKY_WORDS);
}
const SECRET_WORDS = ["password", "passcode", "passwort", "pin", "cvv", "cvc", "csc", "security code", "card number", "credit card", "debit card", "iban", "one time code", "otp", "verification code", "2fa", "كلمة المرور", "كلمه السر", "الرقم السري", "رقم البطاقة"];

/** Lower case, accents and Arabic marks folded, everything but letters / digits -> one space. */
function fold(s) {
  return ` ${String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}
function hasWord(text, words) {
  const f = fold(text);
  return words.find((w) => {
    const fw = fold(w).trim();
    if (!fw) return false;
    if (f.includes(` ${fw} `)) return true;
    // Arabic proclitics (و ف ب ل ال) on the first word.
    return /[\u0600-\u06ff]/.test(fw) && ["ال", "وال", "بال", "و", "ف", "ب", "ل"].some((pre) => f.includes(` ${pre}${fw} `));
  }) || null;
}
/** A Luhn-valid 13-19 digit run (single spaces / dashes allowed). */
function hasCardNumber(text) {
  const runs = String(text || "").match(/\d(?:[ -]?\d){12,18}/g) || [];
  return runs.some((r) => {
    const d = r.replace(/\D/g, "");
    if (d.length < 13 || d.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let x = Number(d[d.length - 1 - i]);
      if (i % 2) {
        x *= 2;
        if (x > 9) x -= 9;
      }
      sum += x;
    }
    return sum % 10 === 0;
  });
}
function hostOf(u) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/:?#]+)/i.exec(String(u || "").trim());
  return m ? m[1].toLowerCase().replace(/\.$/, "") : null;
}

/** The steps of a browser call (browser_batch runs several). */
function browserSteps(tool, input) {
  const t = String(tool).slice(BROWSER_PREFIX.length);
  if (t === "browser_batch") {
    const list = Array.isArray(input.actions) ? input.actions.slice(0, 100) : [];
    return list.map((a) => ({ t: String((a && a.name) || "?").replace(BROWSER_PREFIX, ""), i: a && a.input && typeof a.input === "object" ? a.input : {} }));
  }
  return [{ t, i: input }];
}

/** One step: { decision, why }. labels = what the app knows of the target elements. */
function browserStep(t, i, labels) {
  const summary = typeof i.action_summary === "string" ? i.action_summary : "";
  const target = i.ref && labels[i.ref] ? labels[i.ref] : "";
  const said = `${summary} ${target}`;
  if (B_READ.has(t)) return { decision: "allow" };
  if (t === "navigate") {
    const u = String(i.url || "").trim();
    if (u === "back" || u === "forward") return { decision: "allow" };
    const full = /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(u) ? u : "https://" + u;
    if (OWN_HOST.test(hostOf(full) || "")) return { decision: "deny", why: "Joya's own pages are for the user; JOYA AI does not open them in the browser." };
    if (!/^https?:\/\//i.test(full)) return { decision: "ask", why: `It opens a non-web address (${full.slice(0, 80)}).` };
    return { decision: "allow" };
  }
  if (t === "computer") {
    const a = String(i.action || "");
    if (B_LOOK.has(a)) return { decision: "allow" };
    if (a === "type") {
      const text = String(i.text || "");
      if (hasCardNumber(text)) return { decision: "deny", why: "That looks like a payment card number; JOYA AI never types card numbers." };
      if (hasWord(said, SECRET_WORDS)) return { decision: "deny", why: "That is a password, PIN, code or payment field; JOYA AI never types those." };
      if (/[\r\n]/.test(text)) return { decision: "ask", why: "The text ends a line with Enter, which can submit or send." };
      return { decision: "allow" };
    }
    if (a === "key") {
      const keys = String(i.text || "").toLowerCase().split(/\s+/).filter(Boolean);
      const sends = keys.some((k) => {
        const parts = k.split("+");
        const main = parts[parts.length - 1];
        if (main === "enter" || main === "return" || main === "kp_enter") return !parts.includes("shift") || parts.includes("ctrl") || parts.includes("cmd");
        return main === "s" && parts.includes("alt") && !parts.includes("ctrl");
      });
      if (sends) return { decision: "ask", why: `It presses ${String(i.text).slice(0, 40)}, which can submit or send.` };
      const risky = summary && riskyWord(summary);
      return risky ? { decision: "ask", why: `It ${summary.slice(0, 160)}.` } : { decision: "allow" };
    }
    if (B_CLICK.has(a)) {
      const risky = riskyWord(said);
      if (risky) return { decision: "ask", why: `It clicks ${target ? target.slice(0, 120) : "on the page"}${summary ? ` (${summary.slice(0, 160)})` : ""}: that can send, submit, buy, post or delete.` };
      if (!summary && !target) return { decision: "ask", why: "A click JOYA AI did not describe." };
      return { decision: "allow" };
    }
    return { decision: "ask", why: `Browser action "${a.slice(0, 40)}".` };
  }
  if (t === "form_input") {
    const v = typeof i.value === "string" ? i.value : JSON.stringify(i.value);
    if (hasCardNumber(v)) return { decision: "deny", why: "That looks like a payment card number; JOYA AI never types card numbers." };
    if (hasWord(said, SECRET_WORDS)) return { decision: "deny", why: "That is a password, PIN, code or payment field; JOYA AI never fills those." };
    if (riskyWord(said)) return { decision: "ask", why: `It sets ${target ? target.slice(0, 120) : "a field"}${summary ? ` (${summary.slice(0, 160)})` : ""}.` };
    return { decision: "allow" };
  }
  if (t === "javascript_tool") return { decision: "ask", why: "It runs a script on the page, which can do anything the page can (submit, send, buy)." };
  if (t === "file_upload" || t === "upload_image") return { decision: "ask", why: "It uploads a file from your computer to a website." };
  if (t === "shortcuts_execute") return { decision: "ask", why: "It runs one of your saved Claude in Chrome shortcuts." };
  if (t === "switch_browser" || t === "select_browser") return { decision: "ask", why: "It switches to a browser on another of your computers." };
  return { decision: "ask", why: `Browser tool ${t.slice(0, 60)}.` };
}

/** A browser call (one tool, or a browser_batch): the strictest of its steps. hint: { targets: [{ref, label}], tab_urls }. */
function decideBrowser(tool, input, hint) {
  const h = hint && typeof hint === "object" ? hint : {};
  const labels = {};
  for (const x of Array.isArray(h.targets) ? h.targets.slice(0, 100) : []) if (x && typeof x.ref === "string" && typeof x.label === "string") labels[x.ref] = x.label.slice(0, 200);
  if ((Array.isArray(h.tab_urls) ? h.tab_urls : []).some((u) => OWN_HOST.test(hostOf(u) || ""))) {
    return { decision: "deny", category: "refused", label: "Not on Joya's own pages", reason: "That tab is Joya itself; JOYA AI never acts on its own approval pages." };
  }
  const steps = browserSteps(tool, input);
  if (!steps.length) return { decision: "ask", category: "browser", label: "Act in your browser", reason: "An empty browser batch." };
  const asks = [];
  for (const s of steps) {
    const d = browserStep(s.t, s.i, labels);
    if (d.decision === "deny") return { decision: "deny", category: "refused", label: "Refused in your browser", reason: d.why };
    if (d.decision === "ask") asks.push(d.why);
  }
  if (asks.length) return { decision: "ask", category: "browser", label: "Act in your browser", reason: asks.slice(0, 3).join(" ") };
  return { decision: "allow", category: "browser", label: "Browse", reason: null };
}

/** The card's line for a browser call: what it does, to what, where. */
function browserSummary(tool, input, hint) {
  const h = hint && typeof hint === "object" ? hint : {};
  const labels = {};
  for (const x of Array.isArray(h.targets) ? h.targets : []) if (x && x.ref) labels[x.ref] = String(x.label || "").slice(0, 120);
  const one = (s) => {
    const i = s.i;
    const summary = typeof i.action_summary === "string" ? ` — ${i.action_summary.slice(0, 200)}` : "";
    const target = i.ref ? ` ${labels[i.ref] || i.ref}` : "";
    if (s.t === "navigate") return `open ${String(i.url || "").slice(0, 200)}`;
    if (s.t === "computer") return `${String(i.action || "").replace(/_/g, " ")}${target}${i.action === "key" ? " " + String(i.text || "").slice(0, 40) : ""}${summary}`;
    if (s.t === "form_input") return `fill${target || " a field"}${summary}`;
    if (s.t === "javascript_tool") return `run a script: ${String(i.text || "").replace(/\s+/g, " ").slice(0, 300)}`;
    if (s.t === "file_upload") return `upload ${(Array.isArray(i.paths) ? i.paths : []).join(", ").slice(0, 300)}`;
    return s.t.replace(/_/g, " ") + summary;
  };
  const where = (Array.isArray(h.tab_urls) ? h.tab_urls : []).map(hostOf).filter(Boolean);
  return `Chrome: ${browserSteps(tool, input).map(one).join("; ")}${where.length ? ` (on ${[...new Set(where)].join(", ")})` : ""}`.slice(0, 1500);
}

/* ---------------------------------------------------------------- tools --- */

const ALWAYS_ALLOW = new Set(["TodoWrite", "Task", "Agent", "WebSearch", "ToolSearch", "ExitPlanMode", "EnterPlanMode", "TaskOutput", "KillShell", "BashOutput", "Skill", "SlashCommand", "AskUserQuestion"]);
const NEVER = new Set(["SendMessage", "CronCreate", "CronDelete", "RemoteTrigger", "ScheduleWakeup", "PushNotification"]);

/**
 * decide(tool, input, ctx) -> { decision: allow|ask|deny, category, label, reason }
 * ctx: { home: "C:\\Users\\name" (the laptop's profile folder, from the app's hello), folders: [the folders the
 * user added], origin: "cli" | "hands", hint: the app's hint for a browser step }.
 */
function decide(tool, input, ctx = {}) {
  const t = String(tool || "");
  const i = input && typeof input === "object" ? input : {};
  if (t.startsWith(HANDS_PREFIX) || ctx.origin === "hands") {
    // The hands' own approvals: writing over a file, or the session's request_approval: always a card.
    const files = /__(office_edit|pdf_merge|pdf_export|create_document)$/.test(t);
    return { decision: "ask", category: files ? "file" : "approval", label: files ? "Replace a file" : "Your approval", reason: i.why ? String(i.why).slice(0, 500) : "JOYA AI wants to do something on your computer that needs your approval." };
  }
  if (NEVER.has(t)) return { decision: "deny", category: "refused", label: "Not on this computer", reason: `${t} is not available to the laptop session; it reports to JOYA AI with its final message.` };
  if (t.startsWith(BROWSER_PREFIX) && t.length > BROWSER_PREFIX.length && ctx.origin !== "hands") return decideBrowser(t, i, ctx.hint);
  if (t.startsWith("mcp__")) return { decision: "deny", category: "refused", label: "Unknown tool", reason: "Only the desktop app's own tools and your Claude in Chrome extension are allowed on this computer." };
  if (t === "PowerShell" || t === "Bash" || t === "Monitor") return decideCommand(i.command || i.script || "", ctx);
  if (t === "Write" || t === "Edit" || t === "MultiEdit" || t === "NotebookEdit") {
    const p = i.file_path || i.notebook_path || i.path || "";
    if (p && inUserFiles(p, ctx.home, ctx.folders)) return { decision: "allow", category: "file", label: "Write your files", reason: null };
    return { decision: "ask", category: "outside", label: "Change files outside your own", reason: `It writes ${p || "a file"}, outside your own files.` };
  }
  if (t === "Read" || t === "Glob" || t === "Grep" || t === "LS") {
    const p = i.file_path || i.path || "";
    if (!p || inUserFiles(p, ctx.home, ctx.folders)) return { decision: "allow", category: "file", label: "Read your files", reason: null };
    return { decision: "ask", category: "outside", label: "Read outside your own files", reason: `It reads ${p}, outside your own files (app data, hidden folders or the system).` };
  }
  if (t === "WebFetch") return { decision: "ask", category: "network", label: "Fetch a web address", reason: `It fetches ${String(i.url || "a web page").slice(0, 300)}.` };
  if (ALWAYS_ALLOW.has(t)) return { decision: "allow", category: "tool", label: t, reason: null };
  return { decision: "ask", category: "unknown", label: "Needs permission", reason: `${t.slice(0, 80)} is not on the laptop session's list.` };
}

/** The card's one-line summary for a laptop question (never a secret: the supervisor redacts again). */
function summaryOf(tool, input, hint) {
  const i = input && typeof input === "object" ? input : {};
  if (String(tool).startsWith(HANDS_PREFIX)) return String(i.summary || tool.slice(HANDS_PREFIX.length)).slice(0, 500);
  if (String(tool).startsWith(BROWSER_PREFIX)) return browserSummary(tool, i, hint);
  if (typeof i.command === "string") return i.command.slice(0, 2000);
  if (i.file_path || i.path) return `${tool} ${i.file_path || i.path}`;
  if (i.url) return `${tool} ${i.url}`;
  return `${tool} ${JSON.stringify(i).slice(0, 500)}`;
}

module.exports = { HANDS_PREFIX, BROWSER_PREFIX, riskyWord, ALLOWANCE_MS, normPath, inUserFiles, pathsIn, decideCommand, decide, decideBrowser, browserSummary, summaryOf, approvalPath, approvalScope, deleteTargets, allowanceCovers, hasCardNumber };
