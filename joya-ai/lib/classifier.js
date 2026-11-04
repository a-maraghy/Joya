"use strict";
/**
 * The destructive-action classifier behind JOYA AI's approval gate.
 *
 * Two entry points:
 *
 *   classifyCommand(cmd)   a shell command (the Bash and Monitor tools)
 *   classifyMessage(text)  a delegation text (SendMessage to another session)
 *
 * Each returns { destructive, category, label, reason, matches[] }.
 *
 * Conservative by design. A false positive costs the administrator one click
 * on an Approve card; a false negative is a deleted file, a pushed branch or a
 * restarted database. So wherever the gate cannot tell -- SQL fed on stdin, an
 * inline script, a heredoc -- it asks. It is a tripwire, not a sandbox: a model
 * determined to hide a deletion inside a script file it wrote first will get
 * past it, which is why the charter tells JOYA AI to ask as well, and why the
 * gate exists at all rather than trusting the charter alone.
 *
 * No dependencies and no I/O: it is required by the PreToolUse hook, which runs
 * once per tool call and has to be quick.
 */

const CATEGORIES = {
  delete: "Deletes files or records",
  service: "Stops or restarts a service or the machine",
  git: "Pushes to a remote or rewrites git history",
  database: "Writes to or drops a database",
  kill: "Kills processes",
  permissions: "Changes permissions, accounts, credentials or the firewall",
  disk: "Overwrites a disk or filesystem",
  packages: "Removes installed software",
  remote_exec: "Runs a script straight from the network",
  delegation: "Tells another session to do something destructive",
  opaque: "Runs code the gate cannot read",
};

function result(matches) {
  if (!matches.length) return { destructive: false, category: null, label: null, reason: null, matches: [] };
  const first = matches[0];
  return {
    destructive: true,
    category: first.category,
    label: CATEGORIES[first.category] || first.category,
    reason: first.reason,
    matches,
  };
}

/* ----------------------------------------------------------- tokenising --- */

/**
 * Split a shell command into simple commands.
 *
 * Not a shell parser, and it does not need to be: it separates on the control
 * operators (; && || | & newline), keeps quoted strings whole, and pulls the
 * inside of $( ) and backticks out as commands of their own. Heredoc bodies
 * end up as separate "commands", one per line, which is the conservative
 * reading -- a line of a heredoc that says `systemctl restart odoo` is asked
 * about whether it is a script or a note.
 *
 * Returns [{ words: [..], redirects: [..], pipeNext: bool }].
 */
function splitCommands(input) {
  const text = String(input == null ? "" : input);
  const out = [];
  const nested = [];
  let words = [];
  let redirects = [];
  let cur = "";
  let has = false; // cur holds a word, even an empty quoted one
  let pendingRedirect = false;
  let i = 0;

  const pushWord = () => {
    if (!has) return;
    if (pendingRedirect) {
      redirects.push(cur);
      pendingRedirect = false;
    } else {
      words.push(cur);
    }
    cur = "";
    has = false;
  };
  const pushCmd = (pipeNext) => {
    pushWord();
    if (words.length || redirects.length) out.push({ words, redirects, pipeNext: !!pipeNext });
    words = [];
    redirects = [];
    pendingRedirect = false;
  };

  // Read a balanced $( ... ) starting after "$(".
  const readParen = () => {
    let depth = 1;
    let start = i;
    let q = null;
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === "\\" && q === '"') i++;
        else if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          const inner = text.slice(start, i);
          i++;
          return inner;
        }
      }
      i++;
    }
    return text.slice(start);
  };

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (c === "\\" && i + 1 < text.length) {
      if (n === "\n") {
        i += 2;
        continue;
      }
      cur += n;
      has = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const chunk = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      cur += chunk;
      has = true;
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let chunk = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          chunk += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === "$" && text[j + 1] === "(") {
          const save = i;
          i = j + 2;
          nested.push(readParen());
          j = i;
          i = save;
          chunk += "$()";
          continue;
        }
        if (text[j] === "`") {
          const end = text.indexOf("`", j + 1);
          nested.push(end === -1 ? text.slice(j + 1) : text.slice(j + 1, end));
          j = end === -1 ? text.length : end + 1;
          chunk += "``";
          continue;
        }
        chunk += text[j];
        j++;
      }
      cur += chunk;
      has = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && n === "(") {
      i += 2;
      nested.push(readParen());
      cur += "$()";
      has = true;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      nested.push(end === -1 ? text.slice(i + 1) : text.slice(i + 1, end));
      i = end === -1 ? text.length : end + 1;
      cur += "``";
      has = true;
      continue;
    }
    if (c === "#" && !has) {
      // A comment runs to the end of the line.
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === "\n" || c === ";") {
      pushCmd(false);
      i++;
      continue;
    }
    if (c === "&" && n === "&") {
      pushCmd(false);
      i += 2;
      continue;
    }
    if (c === "|" && n === "|") {
      pushCmd(false);
      i += 2;
      continue;
    }
    if (c === "|") {
      pushCmd(true);
      i += n === "&" ? 2 : 1;
      continue;
    }
    if (c === "&" && n !== ">") {
      pushCmd(false);
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      // Subshells and groups: the commands inside are commands like any other.
      if (!has) {
        pushCmd(false);
        i++;
        continue;
      }
    }
    if (c === ">" || (c === "&" && n === ">") || (/[0-9]/.test(c) && n === ">" && !has)) {
      pushWord();
      // Consume the operator: >, >>, &>, 2>, >|, >&
      if (c !== ">") i++;
      i++;
      if (text[i] === ">") i++;
      if (text[i] === "|") i++;
      if (text[i] === "&") {
        // 2>&1 -- a descriptor, not a file
        i++;
        while (i < text.length && /[0-9-]/.test(text[i])) i++;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    if (c === "<") {
      pushWord();
      // Input redirection and heredoc markers name no output; skip the word.
      i++;
      while (text[i] === "<" || text[i] === "-") i++;
      while (text[i] === " " || text[i] === "\t") i++;
      // swallow the following word
      let q = null;
      while (i < text.length) {
        const d = text[i];
        if (q) {
          if (d === q) q = null;
        } else if (d === "'" || d === '"') q = d;
        else if (/[\s;&|()<>]/.test(d)) break;
        i++;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  pushCmd(false);
  for (const inner of nested) out.push(...splitCommands(inner));
  return out;
}

const base = (w) => {
  const s = String(w || "").replace(/^\\/, "");
  const slash = s.lastIndexOf("/");
  return slash === -1 ? s : s.slice(slash + 1);
};

/**
 * Peel off everything that runs another command: sudo, env, nohup, timeout,
 * xargs and the like. Returns the words of the command actually being run, or
 * a list of strings to classify recursively (bash -c, su -c, ssh host cmd).
 */
function unwrap(words) {
  let w = words.slice();
  const recurse = [];
  for (let guard = 0; guard < 20 && w.length; guard++) {
    // leading assignments: FOO=bar cmd
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    if (!w.length) break;
    const cmd = base(w[0]);

    if (cmd === "sudo" || cmd === "doas") {
      w.shift();
      while (w.length && w[0].startsWith("-")) {
        const opt = w.shift();
        if (/^-(u|g|h|p|C|D|r|t|U)$/.test(opt) || /^--(user|group|host|prompt|chdir|role|type|other-user)$/.test(opt)) w.shift();
        if (opt === "--") break;
      }
      continue;
    }
    if (cmd === "env") {
      w.shift();
      while (w.length && (w[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) {
        const opt = w.shift();
        if (/^-(u|C|S)$/.test(opt) || /^--(unset|chdir)$/.test(opt)) w.shift();
      }
      continue;
    }
    if (["nohup", "time", "exec", "command", "builtin", "setsid", "stdbuf", "unbuffer", "caffeinate", "chronic"].includes(cmd)) {
      w.shift();
      while (w.length && w[0].startsWith("-")) w.shift();
      continue;
    }
    if (cmd === "nice" || cmd === "ionice" || cmd === "taskset" || cmd === "chrt" || cmd === "cpulimit") {
      w.shift();
      while (w.length && (w[0].startsWith("-") || /^[0-9,.-]+$/.test(w[0]))) {
        const opt = w.shift();
        if (/^-(n|c|p|l)$/.test(opt)) w.shift();
      }
      continue;
    }
    if (cmd === "timeout") {
      w.shift();
      while (w.length && w[0].startsWith("-")) {
        const opt = w.shift();
        if (/^-(s|k)$/.test(opt) || /^--(signal|kill-after)$/.test(opt)) w.shift();
      }
      if (w.length) w.shift(); // duration
      continue;
    }
    if (cmd === "watch") {
      w.shift();
      while (w.length && w[0].startsWith("-")) {
        const opt = w.shift();
        if (/^-(n|d)$/.test(opt)) w.shift();
      }
      if (w.length === 1) recurse.push(w[0]);
      continue;
    }
    if (cmd === "flock") {
      w.shift();
      while (w.length && w[0].startsWith("-")) {
        const opt = w.shift();
        if (/^-(w|E)$/.test(opt)) w.shift();
        if (opt === "-c" && w.length) recurse.push(w.shift());
      }
      if (w.length) w.shift(); // lock file
      continue;
    }
    if (cmd === "xargs") {
      w.shift();
      while (w.length && w[0].startsWith("-")) {
        const opt = w.shift();
        if (/^-(I|L|n|P|d|E|s|a)$/.test(opt)) w.shift();
      }
      continue;
    }
    if (cmd === "runuser" || cmd === "su") {
      w.shift();
      let userSeen = false;
      const rest = [];
      while (w.length) {
        const opt = w.shift();
        if (opt === "-c" || opt === "--command") {
          if (w.length) recurse.push(w.shift());
          continue;
        }
        if (/^(-u|-g|-G|-s|--shell|--user|--group)$/.test(opt)) {
          w.shift();
          continue;
        }
        if (opt === "--") {
          rest.push(...w);
          break;
        }
        if (opt.startsWith("-")) continue;
        // su takes a user name; runuser -u USER -- CMD takes a command.
        if (cmd === "su" && !userSeen) {
          userSeen = true;
          continue;
        }
        rest.push(opt, ...w);
        break;
      }
      if (!rest.length) return { words: [], recurse };
      w = rest;
      continue;
    }
    if (["bash", "sh", "zsh", "dash", "ksh", "fish", "busybox"].includes(cmd)) {
      const idx = w.indexOf("-c");
      const combined = w.findIndex((x, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(x));
      const at = idx !== -1 ? idx : combined;
      if (at !== -1 && w[at + 1] !== undefined) {
        recurse.push(w[at + 1]);
        return { words: [], recurse };
      }
      return { words: w, recurse };
    }
    if (cmd === "eval") {
      recurse.push(w.slice(1).join(" "));
      return { words: [], recurse };
    }
    if (cmd === "ssh") {
      // ssh [opts] host [command...]: the command runs somewhere -- on this
      // box `ssh contabo` loops straight back to 127.0.0.1 -- so read it.
      w.shift();
      while (w.length && w[0].startsWith("-")) {
        const opt = w.shift();
        if (/^-[bcDEeFIiJLlmOoPpQRSWw]$/.test(opt)) w.shift();
      }
      if (w.length) w.shift(); // host
      if (w.length) recurse.push(w.join(" "));
      return { words: [], recurse };
    }
    if ((cmd === "docker" || cmd === "podman" || cmd === "kubectl") && w[1] === "exec") {
      let k = 2;
      while (k < w.length && w[k].startsWith("-")) {
        if (/^-(u|w|e|c|n)$/.test(w[k]) || /^--(user|workdir|env|container|namespace)$/.test(w[k])) k++;
        k++;
      }
      k++; // container
      if (w[k] === "--") k++;
      if (k < w.length) recurse.push(w.slice(k).join(" "));
      return { words: [], recurse };
    }
    break;
  }
  return { words: w, recurse };
}

/* ---------------------------------------------------------------- rules --- */

const SQL_WRITE = [
  /\bdelete\s+from\b/i,
  /\binsert\s+into\b/i,
  /\bupdate\s+[\w."]+\s+set\b/i,
  /\bdrop\s+(table|database|schema|index|view|materialized|role|user|owned|sequence|function|trigger|extension|type)\b/i,
  /\btruncate\s+(table\s+)?[\w."]+/i,
  /\balter\s+(table|database|role|user|schema|system|sequence|index|view)\b/i,
  /\bcreate\s+(table|database|schema|role|user|index|unique|view|extension|or\s+replace)\b/i,
  /\b(grant|revoke)\s+[\w, ]+\s+(on|to|from)\b/i,
  /\breplace\s+into\b/i,
  /\bvacuum\s+full\b/i,
  /\bcopy\s+[\w."]+(\s*\([^)]*\))?\s+from\b/i,
  /\bflushall\b|\bflushdb\b/i,
];

const ORM_WRITE = [
  /\.unlink\(\s*\)/, // odoo recordset delete
  /\.write\(\s*\{/, // odoo recordset write
  /\.create\(\s*[\[{]/, // odoo create
  /\bcr\.commit\(\s*\)/,
  /\.sudo\(\)\.(unlink|write|create)\b/,
];

const INLINE_DESTRUCTIVE = [
  [/\bos\.(remove|unlink|rmdir|removedirs)\s*\(/, "delete", "removes files from inline code"],
  [/\bshutil\.rmtree\s*\(/, "delete", "removes a directory tree from inline code"],
  [/\.(unlink|rmdir)\(\s*(missing_ok\s*=\s*\w+)?\s*\)/, "delete", "removes a path from inline code"],
  [/\bfs(\.promises)?\.(rm|rmdir|unlink|rmSync|rmdirSync|unlinkSync)\s*\(/, "delete", "removes files from inline code"],
  [/\bFileUtils\.rm/, "delete", "removes files from inline code"],
  [/\.(rmSync|rmdirSync|unlinkSync)\s*\(|\bunlink\s*\(\s*["'`\/]/, "delete", "removes files from inline code"],
  [/\bos\.kill(pg)?\s*\(|\bprocess\.kill\s*\(|\bsignal\.SIGKILL\b/, "kill", "signals a process from inline code"],
  [/\bos\.(chmod|chown|lchown|setuid)\s*\(|\bfs\.(chmod|chown)(Sync)?\s*\(/, "permissions", "changes permissions from inline code"],
  [/\bsubprocess\.|child_process|\bos\.system\s*\(|\bos\.popen\s*\(|\bexecSync\s*\(|\bspawnSync\s*\(/, "opaque", "starts other programs from inline code"],
];

// Paths whose modification is a credential or access change.
const SENSITIVE_PATH =
  /(^|\/)(shadow|gshadow|sudoers(\.d\/\S*)?|passwd|group)$|authorized_keys|\/\.ssh\/|(^|\/)\.env(\.|$)|credentials|\.pgpass|\.netrc|openai_key|odoo-master-password|(^|\/)id_(rsa|ed25519|ecdsa)|\/etc\/ssh\/|\/etc\/odoo\/|\.claude\/settings(\.local)?\.json|\/etc\/joya-ai\/|db\.env$|\.credentials\.json/;

const INTERPRETERS = /^(python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|Rscript|osascript)$/;
const SQL_CLIENTS = /^(psql|mysql|mariadb|sqlite3|sqlite|clickhouse-client|cqlsh|mongo|mongosh|duckdb)$/;

const PKG_REMOVE = /^(remove|purge|autoremove|autopurge|erase|uninstall)$/;

function ruleFor(words, add) {
  if (!words.length) return;
  const cmd = base(words[0]);
  const args = words.slice(1);
  const flags = args.filter((a) => a.startsWith("-"));
  const plain = args.filter((a) => !a.startsWith("-"));
  const has = (re) => args.some((a) => re.test(a));
  const sub = plain[0];

  // --- deleting -------------------------------------------------------------
  if (/^(rm|rmdir|unlink|shred|srm|wipe|trash|trash-put|trash-rm)$/.test(cmd))
    return add("delete", `${cmd} ${plain.slice(0, 3).join(" ")}`.trim());
  if (cmd === "gio" && /^(trash|remove)$/.test(sub || "")) return add("delete", `gio ${sub}`);
  if (cmd === "truncate") return add("delete", "truncate empties a file");
  if (cmd === "find" && has(/^-delete$/)) return add("delete", "find -delete");
  if ((cmd === "mv" || cmd === "cp") && plain.length && plain[plain.length - 1] === "/dev/null")
    return add("delete", `${cmd} to /dev/null`);
  if (cmd === "cp" && plain[0] === "/dev/null") return add("delete", "cp /dev/null empties a file");
  if (cmd === "rsync" && has(/^--(delete|remove-source-files)/)) return add("delete", "rsync --delete removes files at the destination");
  if (cmd === "tar" && has(/^--remove-files$/)) return add("delete", "tar --remove-files");
  if (cmd === "journalctl" && has(/^--vacuum-/)) return add("delete", "journalctl --vacuum deletes logs");
  if ((cmd === "aws" && plain[0] === "s3" && /^(rm|rb)$/.test(plain[1] || "")) || (cmd === "gsutil" && /^(rm|rb)$/.test(sub || "")))
    return add("delete", `${cmd} ${plain.slice(0, 2).join(" ")}`);
  if (cmd === "rclone" && /^(delete|deletefile|purge|rmdir|rmdirs|sync|move|cleanup)$/.test(sub || ""))
    return add("delete", `rclone ${sub}`);
  if (cmd === "crontab" && flags.some((f) => /r/.test(f))) return add("delete", "crontab -r removes the crontab");
  if (cmd === "atrm") return add("delete", "atrm");
  if (cmd === "ipcrm") return add("delete", "ipcrm");

  // --- git ------------------------------------------------------------------
  if (cmd === "git") {
    let k = 0;
    while (k < args.length && args[k].startsWith("-")) {
      if (/^-(C|c)$/.test(args[k]) || /^--(git-dir|work-tree|namespace|exec-path)$/.test(args[k])) k++;
      k++;
    }
    const g = args[k];
    const rest = args.slice(k + 1);
    const r = (re) => rest.some((a) => re.test(a));
    if (g === "push") return add("git", r(/^(-f|--force|--force-with-lease.*|--mirror|--delete|-d)$/) || rest.some((a) => a.startsWith("+")) ? "git push --force" : "git push");
    if (g === "reset" && r(/^--(hard|merge|keep)$/)) return add("git", "git reset --hard discards work");
    if (g === "clean" && !r(/^(-n|--dry-run)$/)) return add("git", "git clean deletes untracked files");
    if (g === "checkout" && (r(/^(-f|--force)$/) || rest.includes("--") || rest.includes(".")))
      return add("git", "git checkout discards local changes");
    if (g === "restore" && !r(/^(--staged|-S)$/)) return add("git", "git restore discards local changes");
    if (g === "restore" && r(/^(--worktree|-W)$/)) return add("git", "git restore discards local changes");
    if (g === "branch" && r(/^(-D|-d|--delete|-M|-f|--force)$/)) return add("git", "git branch delete/force");
    if (g === "tag" && r(/^(-d|--delete|-f|--force)$/)) return add("git", "git tag delete/force");
    if (g === "stash" && /^(drop|clear)$/.test(rest[0] || "")) return add("git", `git stash ${rest[0]}`);
    if (g === "rebase") return add("git", "git rebase rewrites history");
    if (g === "filter-branch" || g === "filter-repo") return add("git", `git ${g} rewrites history`);
    if (g === "update-ref" && r(/^-d$/)) return add("git", "git update-ref -d");
    if (g === "reflog" && /^(expire|delete)$/.test(rest[0] || "")) return add("git", `git reflog ${rest[0]}`);
    if (g === "gc" && r(/^--prune/)) return add("git", "git gc --prune");
    if (g === "rm") return add("delete", "git rm");
    if (g === "commit" && r(/^--amend$/)) return add("git", "git commit --amend rewrites history");
    if (g === "remote" && /^(remove|rm|set-url)$/.test(rest[0] || "")) return add("git", `git remote ${rest[0]}`);
    if (g === "worktree" && /^(remove|prune)$/.test(rest[0] || "")) return add("delete", `git worktree ${rest[0]}`);
    return;
  }
  if (cmd === "gh" && ((sub === "repo" && /^(delete|archive)$/.test(plain[1] || "")) || (sub === "release" && plain[1] === "delete") || (sub === "secret") || (sub === "auth" && /^(logout|refresh|token)$/.test(plain[1] || ""))))
    return add(sub === "secret" || sub === "auth" ? "permissions" : "delete", `gh ${plain.slice(0, 2).join(" ")}`);

  // --- services and the machine ---------------------------------------------
  if (cmd === "systemctl") {
    const verb = plain.find((a) => a !== "--user" && a !== "--system");
    if (/^(stop|restart|try-restart|reload-or-restart|try-reload-or-restart|condrestart|force-reload|kill|disable|mask|isolate|poweroff|reboot|halt|kexec|suspend|hibernate|hybrid-sleep|rescue|emergency|default|exit|soft-reboot|daemon-reexec|clean|freeze|revert)$/.test(verb || ""))
      return add(verb === "kill" ? "kill" : "service", `systemctl ${plain.slice(0, 2).join(" ")}`);
    if (verb === "set-property" || verb === "edit" || verb === "link" || verb === "preset") return add("service", `systemctl ${verb}`);
    return;
  }
  if (cmd === "service" && /^(stop|restart|force-reload|try-restart|condrestart)$/.test(plain[1] || ""))
    return add("service", `service ${plain[0]} ${plain[1]}`);
  if (/^(reboot|shutdown|poweroff|halt|telinit)$/.test(cmd)) return add("service", `${cmd} affects the whole machine`);
  if (cmd === "init" && /^[0126sS]$/.test(sub || "")) return add("service", `init ${sub}`);
  if (cmd === "loginctl" && /^(terminate|kill|poweroff|reboot)/.test(sub || "")) return add("kill", `loginctl ${sub}`);
  if ((cmd === "docker" || cmd === "podman" || cmd === "nerdctl") && sub) {
    const s2 = plain[1] || "";
    if (/^(stop|kill|rm|rmi|restart|down|prune|pause|update)$/.test(sub)) return add(sub === "kill" ? "kill" : sub === "rm" || sub === "rmi" || sub === "prune" ? "delete" : "service", `${cmd} ${sub}`);
    if (/^(compose|container|image|volume|network|system|builder|swarm|service|stack)$/.test(sub) && /^(stop|kill|rm|down|prune|restart|remove|leave)$/.test(s2))
      return add(/^(rm|prune|remove)$/.test(s2) ? "delete" : "service", `${cmd} ${sub} ${s2}`);
    return;
  }
  if (cmd === "docker-compose" && /^(stop|kill|rm|down|restart)$/.test(sub || "")) return add("service", `docker-compose ${sub}`);
  if (cmd === "pm2" && /^(stop|restart|delete|kill|reload|flush)$/.test(sub || "")) return add("service", `pm2 ${sub}`);
  if (cmd === "supervisorctl" && /^(stop|restart|shutdown|remove|reload)$/.test(sub || "")) return add("service", `supervisorctl ${sub}`);
  if ((cmd === "nginx" || cmd === "apache2" || cmd === "httpd") && args.includes("-s")) return add("service", `${cmd} -s ${args[args.indexOf("-s") + 1] || ""}`);
  if ((cmd === "apachectl" || cmd === "apache2ctl") && /^(stop|restart|graceful|graceful-stop)$/.test(sub || "")) return add("service", `${cmd} ${sub}`);
  if (cmd === "pg_ctl" || cmd === "pg_ctlcluster") return add("service", `${cmd} controls a database server`);
  if (cmd === "pg_dropcluster") return add("database", "pg_dropcluster");
  if ((cmd === "snap" && /^(stop|restart|disable|remove)$/.test(sub || "")))
    return add(sub === "remove" ? "packages" : "service", `snap ${sub}`);

  // --- killing processes ------------------------------------------------------
  if (/^(kill|pkill|killall|killall5|skill|slay|xkill|pkexec-kill)$/.test(cmd)) {
    if (cmd === "kill" && (args.includes("-l") || args.includes("-L"))) return;
    return add("kill", `${cmd} ${args.slice(0, 3).join(" ")}`.trim());
  }
  if (cmd === "fuser" && flags.some((f) => /k/.test(f))) return add("kill", "fuser -k");
  if (cmd === "tmux" && /^(kill-server|kill-session|kill-window|kill-pane)$/.test(sub || "")) return add("kill", `tmux ${sub}`);
  if (cmd === "screen" && args.includes("-X") && args.includes("quit")) return add("kill", "screen -X quit");

  // --- databases --------------------------------------------------------------
  if (/^(dropdb|dropuser|createdb|createuser|pg_restore|mysqladmin|mongorestore|pg_resetwal|pg_upgrade|pg_createcluster)$/.test(cmd))
    return add("database", `${cmd} changes a database`);
  if (SQL_CLIENTS.test(cmd)) {
    const joined = args.join(" ");
    if (SQL_WRITE.some((re) => re.test(joined))) return add("database", `${cmd} with a write statement`);
    const cIdx = args.findIndex((a) => /^(-c|--command|-e|--execute|--eval|-q|--query)$/.test(a) || /^--(command|execute|eval|query)=/.test(a));
    if (args.some((a) => /^(-f|--file|--file=.*|-i)$/.test(a))) return add("database", `${cmd} runs SQL from a file the gate cannot read`);
    if (cmd === "sqlite3" || cmd === "sqlite" || cmd === "duckdb") {
      // sqlite3 DB "SQL": the statement is the second plain argument.
      const stmt = plain.slice(1).join(" ");
      if (!stmt) return add("database", `${cmd} reads SQL from its input, which the gate cannot see`);
      if (/^\s*\./.test(stmt) && !/^\s*\.(import|restore|read|shell|system|save|backup|output|once|clone)\b/.test(stmt)) return;
      if (/^\s*(select|pragma\s+\w+\s*;?\s*$|explain|with\b[\s\S]*\bselect\b)/i.test(stmt) && !SQL_WRITE.some((re) => re.test(stmt))) return;
      return add("database", `${cmd} statement may write`);
    }
    if (cIdx === -1) {
      if (args.some((a) => /^(-l|--list|--version|-V|--help|-\?)$/.test(a))) return;
      return add("database", `${cmd} reads SQL from its input, which the gate cannot see`);
    }
    const stmt = /=/.test(args[cIdx]) ? args[cIdx].split("=").slice(1).join("=") : args[cIdx + 1] || "";
    if (/^\s*(\\d|\\l|\\dt|\\du|\\dn|\\x|\\conninfo|select|show|explain(?!\s+analyze)|with\b[\s\S]*\bselect\b|table\b|values\b)/i.test(stmt) && !SQL_WRITE.some((re) => re.test(stmt)) && !/;\s*\S/.test(stmt.replace(/;\s*$/, "")))
      return;
    return add("database", `${cmd} statement may write`);
  }
  if (cmd === "redis-cli" || cmd === "valkey-cli") {
    const verb = (plain.find((a, k) => k === 0 || !/^-/.test(args[args.indexOf(a) - 1] || "")) || "").toUpperCase();
    const reads = /^(GET|MGET|KEYS|SCAN|INFO|PING|TTL|PTTL|TYPE|EXISTS|HGET|HGETALL|HKEYS|HLEN|LRANGE|LLEN|SMEMBERS|SCARD|ZRANGE|ZCARD|DBSIZE|STRLEN|MONITOR|CLIENT|MEMORY|LATENCY|SLOWLOG|--STAT|XRANGE|XLEN)$/;
    if (!verb) return add("database", `${cmd} reads commands from its input`);
    if (!reads.test(verb)) return add("database", `${cmd} ${verb.toLowerCase()} writes`);
    return;
  }
  if (/^(odoo|odoo-bin|odoo\.py)$/.test(cmd)) {
    if (args.some((a) => /^(--version|--help|-h)$/.test(a))) return;
    return add("database", `${cmd} can write to the Odoo database`);
  }
  if (cmd === "manage.py" || (INTERPRETERS.test(cmd) && /manage\.py$/.test(plain[0] || "") && /^(migrate|flush|loaddata|dbshell|shell|createsuperuser|changepassword)$/.test(plain[1] || "")))
    return add("database", "manage.py command writes to the database");

  // --- permissions, accounts, credentials, firewall --------------------------
  if (/^(chmod|chown|chgrp|chattr|setfacl|setcap|chcon|restorecon)$/.test(cmd)) return add("permissions", `${cmd} ${plain.slice(0, 2).join(" ")}`.trim());
  if (/^(passwd|chpasswd|usermod|useradd|userdel|adduser|deluser|addgroup|delgroup|groupadd|groupdel|groupmod|gpasswd|newusers|chage|chsh|visudo|vipw|vigr|pwconv|grpconv)$/.test(cmd))
    return add("permissions", `${cmd} changes accounts`);
  if (cmd === "ssh-copy-id") return add("permissions", "ssh-copy-id adds an authorized key");
  if (cmd === "ssh-keygen" && flags.some((f) => /^-(R|p|f|t|b|N)$/.test(f))) return add("permissions", "ssh-keygen changes keys");
  if (cmd === "htpasswd" || cmd === "smbpasswd") return add("permissions", `${cmd} changes a password`);
  if (cmd === "ufw" && sub && !/^(status|show|app)$/.test(sub)) return add("permissions", `ufw ${sub} changes the firewall`);
  if (/^(iptables|ip6tables|nft|iptables-restore|ip6tables-restore|ipset|firewall-cmd)$/.test(cmd)) {
    if (args.every((a) => /^(-L|-S|--list.*|-n|-v|--line-numbers|-t|nat|filter|mangle|raw|list|ruleset|--state|--get-.*|--query-.*)$/.test(a) || /^[A-Z_]+$/.test(a))) return;
    return add("permissions", `${cmd} changes the firewall`);
  }
  if (cmd === "fail2ban-client" && /^(set|unban|ban|stop|reload|restart|add|flushlogs)$/.test(sub || "")) return add("permissions", `fail2ban-client ${sub}`);
  if (cmd === "certbot" && /^(delete|revoke|renew)$/.test(sub || "")) return add("permissions", `certbot ${sub}`);
  if (cmd === "update-alternatives" && has(/^--(set|install|remove|remove-all|config)$/)) return add("permissions", "update-alternatives");
  if (cmd === "loginctl" && /^(enable-linger|disable-linger)$/.test(sub || "")) return add("permissions", `loginctl ${sub}`);

  // --- disks ------------------------------------------------------------------
  if (/^mkfs(\..+)?$|^(wipefs|fdisk|sfdisk|cfdisk|gdisk|sgdisk|parted|mkswap|swapoff|lvremove|vgremove|pvremove|lvreduce|resize2fs|cryptsetup|blkdiscard|mdadm|zpool|zfs|losetup|umount|mount)$/.test(cmd)) {
    if ((cmd === "zfs" || cmd === "zpool") && /^(list|status|get|iostat)$/.test(sub || "")) return;
    if ((cmd === "mount" || cmd === "umount") && !plain.length) return;
    return add("disk", `${cmd} works on disks or filesystems`);
  }
  if (cmd === "dd" && args.some((a) => a.startsWith("of="))) return add("disk", "dd writes raw bytes");

  // --- packages ---------------------------------------------------------------
  if (/^(apt|apt-get|aptitude|yum|dnf|zypper|pacman|apk)$/.test(cmd) && PKG_REMOVE.test(sub || ""))
    return add("packages", `${cmd} ${sub}`);
  if (cmd === "pacman" && flags.some((f) => /^-R/.test(f))) return add("packages", "pacman -R");
  if (cmd === "dpkg" && flags.some((f) => /^(-r|-P|--remove|--purge)$/.test(f))) return add("packages", "dpkg remove");
  if (/^(pip|pip3|pipx|uv|poetry|conda|mamba|gem|cargo)$/.test(cmd) && /^(uninstall|remove)$/.test(sub || ""))
    return add("packages", `${cmd} ${sub}`);
  if (cmd === "uv" && sub === "pip" && /^(uninstall)$/.test(plain[1] || "")) return add("packages", "uv pip uninstall");
  if (INTERPRETERS.test(cmd) && args[0] === "-m" && /^pip[0-9]*$/.test(args[1] || "") && /^(uninstall)$/.test(args[2] || ""))
    return add("packages", "pip uninstall");
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd) && /^(uninstall|remove|rm|un|r|unlink|prune|dedupe)$/.test(sub || ""))
    return add("packages", `${cmd} ${sub}`);

  // --- other agents ---------------------------------------------------------
  if (cmd === "claude") {
    if (!args.length) return add("opaque", "starts another Claude session");
    if (/^(agents|--version|-v|--help|-h|doctor|config|mcp)$/.test(args[0]) && !(args[0] === "mcp" && /^(add|remove|add-json)$/.test(args[1] || ""))) return;
    return add("opaque", "runs another Claude session, which the gate cannot see into");
  }

  // --- interpreters with inline code ------------------------------------------
  if (INTERPRETERS.test(cmd)) {
    const codeIdx = args.findIndex((a) => /^(-c|-e|--eval|-p|--print|-r|-E)$/.test(a));
    const code = codeIdx !== -1 ? args[codeIdx + 1] || "" : "";
    if (codeIdx === -1 && (plain.length === 0 || plain[0] === "-")) {
      // Code on stdin (a heredoc or a pipe). Its lines are classified as they
      // stand, and the global scan below reads them for destructive APIs.
      return;
    }
    if (code) {
      for (const [re, cat, why] of INLINE_DESTRUCTIVE) if (re.test(code)) return add(cat, why);
    }
  }
}

/** Output redirections to places that matter. */
function redirectRules(cmd, add) {
  for (const target of cmd.redirects) {
    if (/^\/dev\/(sd|nvme|vd|xvd|hd|mmcblk|md|dm-|loop|mapper\/)/.test(target)) add("disk", `writes directly to ${target}`);
    else if (SENSITIVE_PATH.test(target)) add("permissions", `writes to ${target}`);
  }
  const cmdWord = base(cmd.words[0] || "");
  if (/^(tee|cp|mv|install|ln|rsync|sed|perl|dd)$/.test(cmdWord)) {
    const writes = cmdWord !== "sed" && cmdWord !== "perl" ? true : cmd.words.some((w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place");
    if (writes) {
      const hit = cmd.words.slice(1).find((w) => !w.startsWith("-") && SENSITIVE_PATH.test(w));
      if (hit) add("permissions", `${cmdWord} modifies ${hit}`);
    }
  }
}

/**
 * Classify a shell command.
 * @param {string} command
 * @param {number} [depth] recursion guard
 */
function classifyCommand(command, depth = 0) {
  const text = String(command == null ? "" : command);
  const matches = [];
  const seen = new Set();
  const add = (category, reason) => {
    const key = category + "|" + reason;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ category, reason });
  };

  if (!text.trim()) return result(matches);
  if (depth > 6) {
    add("opaque", "nesting too deep to read");
    return result(matches);
  }

  let cmds;
  try {
    cmds = splitCommands(text);
  } catch (_) {
    add("opaque", "the command could not be read");
    return result(matches);
  }

  for (let k = 0; k < cmds.length; k++) {
    const c = cmds[k];
    const { words, recurse } = unwrap(c.words);
    for (const inner of recurse) for (const m of classifyCommand(inner, depth + 1).matches) add(m.category, m.reason);

    // find -exec / -execdir / -ok: the command after it is a command.
    if (words.length && base(words[0]) === "find") {
      const e = words.findIndex((w) => /^-(exec|execdir|ok|okdir)$/.test(w));
      if (e !== -1) {
        const end = words.findIndex((w, j) => j > e && (w === ";" || w === "+" || w === "\\;"));
        const inner = words.slice(e + 1, end === -1 ? undefined : end);
        for (const m of classifyCommand(inner.map(quoteWord).join(" "), depth + 1).matches) add(m.category, "find -exec " + m.reason);
      }
    }

    ruleFor(words, add);
    redirectRules({ words, redirects: c.redirects }, add);

    // curl ... | sh
    if (c.pipeNext && words.length && /^(curl|wget|fetch|http|aria2c)$/.test(base(words[0]))) {
      const next = cmds[k + 1];
      if (next) {
        const nw = unwrap(next.words).words;
        if (nw.length && /^(sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node|php|source)$/.test(base(nw[0])))
          add("remote_exec", `${base(words[0])} piped into ${base(nw[0])}`);
      }
    }
  }

  // Whole-text scans: SQL and ORM writes and destructive APIs wherever they
  // appear -- inline scripts, heredocs, strings handed to another program.
  if (SQL_WRITE.some((re) => re.test(text))) add("database", "contains a SQL write statement");
  if (ORM_WRITE.some((re) => re.test(text))) add("database", "contains an ORM write");
  for (const [re, cat, why] of INLINE_DESTRUCTIVE) {
    if (cat === "opaque") continue; // only meaningful for inline interpreter code, handled above
    if (re.test(text)) add(cat, why);
  }
  if (/\b(subprocess|child_process)\b[\s\S]{0,200}["'`](rm|kill|pkill|systemctl|dropdb|shutdown|reboot)["'`\s]/.test(text))
    add("opaque", "starts a destructive program from inline code");

  return result(matches);
}

function quoteWord(w) {
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(w) ? w : "'" + String(w).replace(/'/g, "'\\''") + "'";
}

/* ------------------------------------------------------------ delegation --- */

// Natural-language instructions that ask for something destructive. Loose on
// purpose: asking the administrator about "restart the tests" is cheap, and a
// peer quietly told to "clean up the old dumps" is not.
const NL_RULES = [
  ["delete", /\b(delete|deleting|deletion|remove|removing|erase|erasing|wipe|wiping|purge|purging|destroy|destroying|shred|unlink|discard|get rid of|clean\s*up|cleanup|overwrite|overwriting|truncate|truncating|empty (the|out)|rm\s+-|rmdir)\b/i],
  ["delete", /\bdrop\s+(the\s+|a\s+|all\s+|this\s+|that\s+)?(tables?|databases?|dbs?|schemas?|columns?|index(es)?|collections?|records?|rows?|data|users?|roles?)\b|\bdropdb\b/i],
  ["service", /\b(restart|restarting|reboot|rebooting|shut\s*down|shutting down|power\s*off|poweroff|halt)\b/i],
  ["service", /\b(stop|stopping|disable|disabling|mask)\s+(the\s+|a\s+|all\s+|every\s+|that\s+|this\s+)?([\w@.-]+\s+){0,2}(service|server|process(es)?|daemon|container|unit|timer|cron|worker|bot|agent|session|odoo|nginx|postgres(ql)?|database|dashboard|gateway)s?\b/i],
  ["service", /\bsystemctl\s+(stop|restart|disable|mask|kill)\b|\bservice\s+\S+\s+(stop|restart)\b/i],
  ["git", /\b(git\s+push|push(ing)?\s+(it|this|that|the|your|to|upstream|origin|changes|commits?|branch)|force[- ]push|push\s+--force|reset\s+--hard|hard\s+reset|rebase|rewrite\s+(the\s+)?history|squash|amend)\b/i],
  ["database", /\b(write|writes|writing|update|updating|insert|inserting|delete|modify|modifying|change|changing|alter|altering|migrate|migrating|upgrade|upgrading|restore|restoring|import|importing|reset|resetting|repair|fix)\b[^.\n]{0,60}\b(database|db|tables?|records?|rows?|postgres(ql)?|psql|sqlite|odoo\s+(data|module|modules|records?)|modules?)\b/i],
  ["database", /\b(-u|--update|-i|--init)\s+[a-z_]+\b|\bmodule\s+upgrade\b|\bodoo(-bin)?\s+(shell|-u|-i|--update)/i],
  ["kill", /\b(kill|killing|pkill|killall|terminate|terminating|end\s+the\s+process|sigkill|sigterm)\b/i],
  ["permissions", /\b(chmod|chown|chgrp|sudoers|visudo|usermod|useradd|userdel|passwd|authorized_keys|iptables|ufw|firewall|fail2ban)\b/i],
  ["permissions", /\b(change|changing|set|setting|update|updating|rotate|rotating|revoke|revoking|grant|granting|reset|resetting|replace|replacing|add|adding|remove|removing|edit|editing|disable|disabling|open|opening|write|writing|regenerate)\b[^.\n]{0,60}\b(password|passwd|credentials?|secrets?|tokens?|api[- ]?keys?|ssh[- ]?keys?|keys?|permissions?|access|roles?|sudo|privileges?|certificates?|certs?)\b/i],
];

/**
 * Classify a delegation text for SendMessage.
 *
 * Commands quoted in the message -- `code`, fenced blocks, or bare lines that
 * read as commands -- are run through the shell classifier; the prose is read
 * for destructive instructions.
 */
function classifyMessage(message) {
  const text = String(message == null ? "" : message);
  const matches = [];
  const seen = new Set();
  const add = (category, reason) => {
    const key = category + "|" + reason;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ category, reason });
  };
  if (!text.trim()) return result(matches);

  const snippets = [];
  for (const m of text.matchAll(/```[a-z]*\n?([\s\S]*?)```/gi)) snippets.push(m[1]);
  const noFences = text.replace(/```[\s\S]*?```/g, " ");
  for (const m of noFences.matchAll(/`([^`\n]+)`/g)) snippets.push(m[1]);
  for (const line of noFences.split("\n")) {
    const l = line.replace(/^\s*(\$|#|>)\s+/, "").trim();
    if (l) snippets.push(l);
  }
  for (const s of snippets) {
    for (const m of classifyCommand(s).matches) add(m.category === "opaque" ? "opaque" : m.category, "quoted command: " + m.reason);
  }

  for (const [category, re] of NL_RULES) {
    const m = text.match(re);
    if (m) add(category, `asks the session to "${m[0].trim().slice(0, 60)}"`);
  }

  const r = result(matches);
  if (r.destructive) {
    r.inner = r.category;
    r.label = "Tells another session to: " + (CATEGORIES[r.category] || r.category).toLowerCase();
    r.category = "delegation";
  }
  return r;
}

/**
 * The gate's decision for one PreToolUse event.
 * Returns null (let it through) or { decision: 'ask'|'deny', category, label, reason }.
 */
function gateDecision(toolName, toolInput, config = {}) {
  const input = toolInput || {};
  if (toolName === "Bash" || toolName === "Monitor" || toolName === "PowerShell") {
    const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
    const r = classifyCommand(cmd);
    return r.destructive ? { decision: "ask", category: r.category, label: r.label, reason: r.reason } : null;
  }
  if (toolName === "SendMessage") {
    const to = String(input.to || "");
    const allow = Array.isArray(config.delegation_allow) ? config.delegation_allow : [];
    if (allow.length && !allow.some((p) => safeRegex(p).test(to))) {
      return {
        decision: "deny",
        category: "delegation",
        label: "Target not on the delegation allow-list",
        reason: `"${to}" is not on the allow-list in /etc/joya-ai/config.json`,
      };
    }
    const r = classifyMessage(input.message);
    return r.destructive ? { decision: "ask", category: r.category, label: r.label, reason: r.reason } : null;
  }
  if (/^mcp__memory__memory_forget$/.test(toolName)) {
    return { decision: "ask", category: "delete", label: CATEGORIES.delete, reason: "retracts a long-term memory fact" };
  }
  if (toolName === "CronCreate" || toolName === "RemoteTrigger") {
    // A scheduled prompt runs later through this same gate, so it is not asked
    // about now; the text is still read in case it plainly says to destroy.
    const r = classifyMessage(JSON.stringify(input));
    return r.destructive ? { decision: "ask", category: r.category, label: r.label, reason: "schedules: " + r.reason } : null;
  }
  return null;
}

function safeRegex(p) {
  try {
    return new RegExp(String(p));
  } catch (_) {
    return /$^/;
  }
}

module.exports = { CATEGORIES, classifyCommand, classifyMessage, gateDecision, splitCommands, unwrap };
