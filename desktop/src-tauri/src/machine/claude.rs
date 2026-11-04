//! Claude Code on this laptop, headless (pure parts; unit-tested in core-tests): where claude.exe
//! is, the arguments (as joya-ai/bin/joya-session runs a hired session, never bypassPermissions),
//! the MCP config that points it at the app's hands, and the stream-json conversation -- which
//! events become permission questions, reports and action-log entries.

use serde_json::{json, Value};
use std::collections::HashMap;

/// Where to look for the CLI, in order: the setting (only it, when set), each PATH folder
/// (claude.exe, then claude.cmd), %USERPROFILE%\.local\bin\claude.exe, %APPDATA%\npm\claude.cmd.
pub fn candidates(setting: &str, path_env: &str, userprofile: &str, appdata: &str) -> Vec<String> {
    let setting = setting.trim().trim_matches('"');
    if !setting.is_empty() {
        return vec![setting.to_string()];
    }
    let mut out = Vec::new();
    for dir in path_env.split(';').map(|d| d.trim().trim_matches('"')).filter(|d| !d.is_empty()) {
        out.push(join(dir, "claude.exe"));
        out.push(join(dir, "claude.cmd"));
    }
    if !userprofile.is_empty() {
        out.push(join(userprofile, ".local\\bin\\claude.exe"));
    }
    if !appdata.is_empty() {
        out.push(join(appdata, "npm\\claude.cmd"));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.to_ascii_lowercase()));
    out
}

pub fn join(dir: &str, rest: &str) -> String {
    format!("{}\\{}", dir.trim_end_matches(['\\', '/']), rest)
}

/// The first candidate that exists.
pub fn find(cands: &[String], exists: &dyn Fn(&str) -> bool) -> Option<String> {
    cands.iter().find(|p| exists(p)).cloned()
}

/// Git Bash (Claude Code on Windows wants it; without it the PowerShell tool is used instead).
pub fn git_bash_candidates(env_override: &str, program_files: &str, program_files_x86: &str, local_appdata: &str, path_env: &str) -> Vec<String> {
    let mut out = Vec::new();
    if !env_override.trim().is_empty() {
        out.push(env_override.trim().trim_matches('"').to_string());
    }
    for base in [program_files, program_files_x86] {
        if !base.is_empty() {
            out.push(join(base, "Git\\bin\\bash.exe"));
        }
    }
    if !local_appdata.is_empty() {
        out.push(join(local_appdata, "Programs\\Git\\bin\\bash.exe"));
    }
    // git.exe on PATH lives in <Git>\cmd (or <Git>\bin): bash.exe is in <Git>\bin.
    for dir in path_env.split(';').map(|d| d.trim().trim_matches('"').trim_end_matches('\\')).filter(|d| !d.is_empty()) {
        let low = dir.to_ascii_lowercase();
        let parent = low.rsplit_once('\\').map(|(p, _)| p.rsplit('\\').next().unwrap_or("")).unwrap_or("");
        if (low.ends_with("\\cmd") || low.ends_with("\\bin")) && parent.contains("git") {
            out.push(join(&dir[..dir.len() - 4], "bin\\bash.exe"));
        }
    }
    out
}

/// An npm install (`…\npm\claude.cmd`) runs `node …\npm\node_modules\@anthropic-ai\claude-code\cli.js`;
/// the app runs that directly (a .cmd goes through cmd.exe, which cannot take every argument).
pub fn npm_cli_js(cmd_path: &str) -> Option<String> {
    let low = cmd_path.to_ascii_lowercase();
    if !low.ends_with(".cmd") {
        return None;
    }
    let dir = cmd_path.rsplit_once(['\\', '/']).map(|(d, _)| d)?;
    Some(join(dir, "node_modules\\@anthropic-ai\\claude-code\\cli.js"))
}

pub fn node_candidates(path_env: &str, program_files: &str) -> Vec<String> {
    let mut out: Vec<String> = path_env.split(';').map(|d| d.trim().trim_matches('"')).filter(|d| !d.is_empty()).map(|d| join(d, "node.exe")).collect();
    if !program_files.is_empty() {
        out.push(join(program_files, "nodejs\\node.exe"));
    }
    out
}

/// "2.1.3 (Claude Code)" -> "2.1.3".
pub fn parse_version(out: &str) -> Option<String> {
    let v = out.split_whitespace().next()?;
    if v.chars().next()?.is_ascii_digit() && v.len() <= 40 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+') {
        Some(v.to_string())
    } else {
        None
    }
}

pub struct CliOpts<'a> {
    pub name: &'a str,
    pub model: Option<&'a str>,
    pub session_id: &'a str,
    pub mcp_config: &'a str,
    pub allowed_tools: &'a [String],
    pub system_prompt: &'a str,
    pub add_dirs: &'a [String],
    /// The user's Claude in Chrome extension for this session (`--chrome`), else `--no-chrome`.
    pub chrome: bool,
}

/// The CLI's arguments. Never --dangerously-*, never bypassPermissions: every tool outside the
/// hands' own asks (stdio), and the app turns the question into an approval card.
pub fn args(o: &CliOpts) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"].iter().map(|s| s.to_string()).collect();
    a.push("-n".into());
    a.push(display_name(o.name));
    if let Some(m) = o.model.filter(|m| model_ok(m)) {
        a.push("--model".into());
        a.push(m.to_string());
    }
    for x in ["--permission-mode", "default", "--permission-prompt-tool", "stdio", "--session-id"] {
        a.push(x.into());
    }
    a.push(o.session_id.to_string());
    a.push("--strict-mcp-config".into());
    a.push("--mcp-config".into());
    a.push(o.mcp_config.to_string());
    if !o.allowed_tools.is_empty() {
        a.push("--allowedTools".into());
        a.push(o.allowed_tools.join(","));
    }
    for d in o.add_dirs {
        a.push("--add-dir".into());
        a.push(d.clone());
    }
    // Every browser step asks this app (an ask rule beats any allow rule in the user's own settings),
    // with or without the browser this session.
    a.push(if o.chrome { "--chrome" } else { "--no-chrome" }.into());
    a.push("--settings".into());
    a.push(super::browser::cli_settings());
    a.push("--append-system-prompt".into());
    a.push(o.system_prompt.to_string());
    a
}

fn display_name(n: &str) -> String {
    let n: String = n.chars().filter(|c| !c.is_control()).take(60).collect();
    if n.trim().is_empty() {
        "JOYA AI on this laptop".into()
    } else {
        n.trim().to_string()
    }
}

/// A model name as the server sends it ("claude-opus-5-5", "sonnet", "opus[1m]").
pub fn model_ok(m: &str) -> bool {
    !m.is_empty() && m.len() <= 80 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-._[]".contains(c))
}

/// The MCP config: only the hands, on loopback, with this lease's secret.
pub fn mcp_config(port: u16, secret: &str, server_name: &str) -> String {
    json!({ "mcpServers": { server_name: { "type": "http", "url": format!("http://127.0.0.1:{}/mcp", port), "headers": { "Authorization": format!("Bearer {}", secret) } } } }).to_string()
}

/// `mcp__<server>__<tool>` for every tool the hands list.
pub fn allowed_tools(server_name: &str, defs: &[Value]) -> Vec<String> {
    defs.iter().filter_map(|d| d.get("name").and_then(|n| n.as_str())).map(|n| format!("mcp__{}__{}", server_name, n)).collect()
}

/// A random UUID v4 from 16 random bytes.
pub fn uuid_v4(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{:02x}", x)).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/* ------------------------------------------------------ messages to the CLI */

pub fn initialize() -> Value {
    json!({ "type": "control_request", "request_id": "init", "request": { "subtype": "initialize" } })
}

pub fn user_message(text: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": text }, "parent_tool_use_id": null, "session_id": "" })
}

pub fn allow(request_id: &str, input: &Value) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": { "behavior": "allow", "updatedInput": input } } })
}

pub fn deny(request_id: &str, message: &str) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": { "behavior": "deny", "message": message } } })
}

pub fn unsupported(request_id: &str) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "not supported by JOYA AI's laptop runner" } })
}

/* ----------------------------------------------------- the CLI's stream */

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// The init answer came: the session runs; send the first prompt.
    Initialized,
    /// A permission question: answer it with allow / deny. For a browser step: `refuse` = the app
    /// says no at once (JOYA AI's own pages, passwords, card numbers), `hint` = what it knows of the
    /// page (element labels, tab addresses) for Joya's rules and the card.
    Ask { request_id: String, tool: String, input: Value, tool_use_id: Option<String>, reason: Option<String>, hint: Option<Value>, refuse: Option<String> },
    /// The CLI withdrew a question.
    Cancel { request_id: String },
    /// A control request we do not serve: answer unsupported().
    Unsupported { request_id: String },
    /// The end of a turn: its text goes to JOYA AI.
    Report { text: String, is_error: bool },
    /// A tool outside the hands finished: log it. decision: auto | approved | denied | error (who
    /// let it run); kind: cli | browser; ok: it worked; detail: the first line of an error.
    Logged { tool: String, summary: String, decision: String, kind: String, ok: bool, detail: String },
    /// A browser step's result says whether the Claude in Chrome extension answered.
    Browser { connected: bool, detail: String },
}

#[derive(Default)]
pub struct Stream {
    initialised: bool,
    /// tool_use id -> (tool name, summary, input)
    uses: HashMap<String, (String, String, Value)>,
    /// tool_use id -> "auto" | "approved" | "denied" (from the questions' answers)
    decided: HashMap<String, &'static str>,
    hands_prefix: String,
    browser: super::browser::Tracker,
}

impl Stream {
    pub fn new(server_name: &str) -> Stream {
        Stream { hands_prefix: format!("mcp__{}__", server_name), ..Stream::default() }
    }

    pub fn initialised(&self) -> bool {
        self.initialised
    }

    /// The answer given to a question about `tool_use_id` (for the action log's decision).
    pub fn note_answer(&mut self, tool_use_id: &str, allowed: bool) {
        self.note_decision(tool_use_id, if allowed { "approved" } else { "denied" });
    }

    /// "auto" (Joya's rules let it run), "approved" (the user did, on a card) or "denied".
    pub fn note_decision(&mut self, tool_use_id: &str, decision: &'static str) {
        if !tool_use_id.is_empty() {
            self.decided.insert(tool_use_id.to_string(), decision);
        }
    }

    pub fn on_line(&mut self, line: &str) -> Vec<Effect> {
        let Ok(ev) = serde_json::from_str::<Value>(line) else { return vec![] };
        let s = |v: &Value| v.as_str().map(|x| x.to_string());
        let mut out = Vec::new();
        match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "control_request" => {
                let rid = ev.get("request_id").map(|r| r.as_str().map(|x| x.to_string()).unwrap_or_else(|| r.to_string())).unwrap_or_default();
                let req = ev.get("request").cloned().unwrap_or(json!({}));
                if req.get("subtype").and_then(|x| x.as_str()) == Some("can_use_tool") {
                    let tool = req.get("tool_name").and_then(s).unwrap_or_else(|| "unknown".into());
                    let input = req.get("input").cloned().filter(|i| i.is_object()).unwrap_or(json!({}));
                    let (hint, refuse) = if super::browser::is_browser(&tool) { (Some(super::browser::hint(&tool, &input, &self.browser)), super::browser::refusal(&tool, &input, &self.browser)) } else { (None, None) };
                    out.push(Effect::Ask { request_id: rid, tool, input, tool_use_id: req.get("tool_use_id").and_then(s), reason: req.get("decision_reason").and_then(s), hint, refuse });
                } else {
                    out.push(Effect::Unsupported { request_id: rid });
                }
            }
            "control_cancel_request" => {
                if let Some(r) = ev.get("request_id").and_then(s) {
                    out.push(Effect::Cancel { request_id: r });
                }
            }
            "control_response" => {
                let r = ev.get("response").cloned().unwrap_or(json!({}));
                if !self.initialised && r.get("request_id").and_then(|x| x.as_str()) == Some("init") {
                    self.initialised = true;
                    out.push(Effect::Initialized);
                }
            }
            "assistant" => {
                for b in ev.pointer("/message/content").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                    if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        if let (Some(id), Some(name)) = (b.get("id").and_then(s), b.get("name").and_then(s)) {
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            let summary = if super::browser::is_browser(&name) { super::browser::summarize(&name, &input, &self.browser) } else { summarize(&name, &input) };
                            self.uses.insert(id, (name, summary, input));
                        }
                    }
                }
            }
            "user" => {
                for b in ev.pointer("/message/content").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                    if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let Some(id) = b.get("tool_use_id").and_then(s) else { continue };
                    let Some((tool, summary, input)) = self.uses.remove(&id) else { continue };
                    let decided = self.decided.remove(&id);
                    if tool.starts_with(&self.hands_prefix) {
                        continue; // the hands log their own actions
                    }
                    let is_err = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    let text = result_text(b.get("content"));
                    let browser = super::browser::is_browser(&tool);
                    if browser {
                        if !is_err {
                            self.browser.note_result(&tool, &input, &text);
                        }
                        if decided != Some("denied") {
                            if let Some((connected, detail)) = super::browser::connection_from_result(&text, is_err) {
                                out.push(Effect::Browser { connected, detail });
                            }
                        }
                    }
                    let decision = match decided {
                        Some("denied") => "denied",
                        Some(d) => d,
                        None if is_err => "error",
                        None => "auto",
                    };
                    let detail = if is_err && decision != "denied" { text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(200).collect() } else { String::new() };
                    out.push(Effect::Logged { tool, summary, decision: decision.to_string(), kind: if browser { "browser" } else { "cli" }.to_string(), ok: !is_err, detail });
                }
            }
            "result" => {
                let text = ev.get("result").and_then(s).unwrap_or_default();
                let is_error = ev.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                self.uses.clear();
                self.decided.clear();
                out.push(Effect::Report { text, is_error });
            }
            _ => {}
        }
        out
    }
}

/// A tool_result's text: a string, or the text blocks of a list (images are left out).
pub fn result_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.chars().take(400_000).collect(),
        Some(Value::Array(a)) => a.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n").chars().take(400_000).collect(),
        _ => String::new(),
    }
}

/// A short line for the action log: the tool and the one field that says what it did.
pub fn summarize(tool: &str, input: &Value) -> String {
    let pick = ["command", "file_path", "path", "url", "pattern", "query", "description", "prompt"];
    let detail = pick.iter().find_map(|k| input.get(*k).and_then(|v| v.as_str()).map(|v| v.to_string())).unwrap_or_default();
    let detail: String = detail.chars().map(|c| if c.is_control() { ' ' } else { c }).take(400).collect();
    if detail.is_empty() {
        tool.to_string()
    } else {
        format!("{}: {}", tool, detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_order() {
        let c = candidates("", "C:\\Windows;\"C:\\Tools\\\";;C:\\Users\\a\\.local\\bin", "C:\\Users\\a", "C:\\Users\\a\\AppData\\Roaming");
        assert_eq!(
            c,
            vec![
                "C:\\Windows\\claude.exe",
                "C:\\Windows\\claude.cmd",
                "C:\\Tools\\claude.exe",
                "C:\\Tools\\claude.cmd",
                "C:\\Users\\a\\.local\\bin\\claude.exe",
                "C:\\Users\\a\\.local\\bin\\claude.cmd",
                "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd",
            ]
        );
        assert_eq!(candidates(" \"D:\\x\\claude.exe\" ", "C:\\Windows", "u", "a"), vec!["D:\\x\\claude.exe"], "the setting alone");
        let exists = |p: &str| p.ends_with("npm\\claude.cmd");
        assert_eq!(find(&c, &exists).as_deref(), Some("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd"));
        assert_eq!(find(&c, &|_| false), None);
        let g = git_bash_candidates("", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\Users\\a\\AppData\\Local", "C:\\Windows;D:\\PortableGit\\cmd");
        assert_eq!(g[0], "C:\\Program Files\\Git\\bin\\bash.exe");
        assert_eq!(g[2], "C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
        assert_eq!(g[3], "D:\\PortableGit\\bin\\bash.exe");
        assert_eq!(git_bash_candidates("E:\\bash.exe", "", "", "", "")[0], "E:\\bash.exe");
        assert_eq!(npm_cli_js("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd").as_deref(), Some("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"));
        assert_eq!(npm_cli_js("C:\\x\\claude.exe"), None);
        assert_eq!(node_candidates("C:\\a;C:\\b", "C:\\Program Files"), vec!["C:\\a\\node.exe", "C:\\b\\node.exe", "C:\\Program Files\\nodejs\\node.exe"]);
        assert_eq!(parse_version("2.1.3 (Claude Code)\r\n").as_deref(), Some("2.1.3"));
        assert_eq!(parse_version("error: x"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn cli_args() {
        let tools = vec!["mcp__joya-hands__screenshot".to_string(), "mcp__joya-hands__click".to_string()];
        let dirs = vec!["C:\\Users\\a\\Desktop".to_string()];
        let cfg = mcp_config(5123, "abc", "joya-hands");
        let a = args(&CliOpts { name: "Laptop", model: Some("claude-opus-5-5"), session_id: "u-1", mcp_config: &cfg, allowed_tools: &tools, system_prompt: "rules", add_dirs: &dirs, chrome: true });
        let s = a.join(" ");
        assert!(s.starts_with("-p --input-format stream-json --output-format stream-json --verbose -n Laptop --model claude-opus-5-5 --permission-mode default --permission-prompt-tool stdio --session-id u-1 --strict-mcp-config --mcp-config "));
        assert!(s.contains("--allowedTools mcp__joya-hands__screenshot,mcp__joya-hands__click"));
        assert!(s.contains("--add-dir C:\\Users\\a\\Desktop"));
        assert_eq!(a.last().unwrap(), "rules");
        // The browser: --chrome, and the ask rule for every browser tool (beats any allow in the user's settings).
        assert!(s.contains(" --chrome --settings {\"permissions\":{\"ask\":[\"mcp__claude-in-chrome\"]}} --append-system-prompt"), "{s}");
        assert!(!s.contains("mcp__claude-in-chrome__"), "no browser tool is pre-allowed");
        assert!(!s.to_ascii_lowercase().contains("dangerously") && !s.contains("bypassPermissions"));
        let a = args(&CliOpts { name: "", model: Some("x; rm -rf"), session_id: "u", mcp_config: "{}", allowed_tools: &[], system_prompt: "", add_dirs: &[], chrome: false });
        assert!(a.contains(&"--no-chrome".to_string()) && !a.contains(&"--chrome".to_string()));
        assert!(a.contains(&"--settings".to_string()), "the ask rule even without the browser");
        assert!(!a.contains(&"--model".to_string()), "a strange model name is dropped");
        assert!(!a.contains(&"--allowedTools".to_string()));
        assert_eq!(a[7], "JOYA AI on this laptop");
        let c: Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(c, json!({"mcpServers":{"joya-hands":{"type":"http","url":"http://127.0.0.1:5123/mcp","headers":{"Authorization":"Bearer abc"}}}}));
        assert_eq!(allowed_tools("joya-hands", &[json!({"name":"a"}), json!({"x":1}), json!({"name":"b"})]), vec!["mcp__joya-hands__a", "mcp__joya-hands__b"]);
        let u = uuid_v4([0xff; 16]);
        assert_eq!(u, "ffffffff-ffff-4fff-bfff-ffffffffffff");
        assert_eq!(hex(&[0, 255]), "00ff");
    }

    #[test]
    fn cli_messages() {
        assert_eq!(initialize()["request"]["subtype"], "initialize");
        assert_eq!(user_message("hi")["message"], json!({"role":"user","content":"hi"}));
        assert_eq!(allow("r", &json!({"a":1}))["response"]["response"], json!({"behavior":"allow","updatedInput":{"a":1}}));
        assert_eq!(deny("r", "no")["response"], json!({"subtype":"success","request_id":"r","response":{"behavior":"deny","message":"no"}}));
        assert_eq!(unsupported("r")["response"]["subtype"], "error");
    }

    #[test]
    fn stream() {
        let mut st = Stream::new("joya-hands");
        assert_eq!(st.on_line("junk"), vec![]);
        assert_eq!(st.on_line(r#"{"type":"control_response","response":{"subtype":"success","request_id":"init","response":{}}}"#), vec![Effect::Initialized]);
        assert!(st.initialised());
        assert_eq!(st.on_line(r#"{"type":"control_response","response":{"request_id":"init"}}"#), vec![], "once");
        let ask = st.on_line(r#"{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"del x"},"tool_use_id":"tu1","decision_reason":"not allowed"}}"#);
        assert_eq!(ask, vec![Effect::Ask { request_id: "q1".into(), tool: "Bash".into(), input: json!({"command":"del x"}), tool_use_id: Some("tu1".into()), reason: Some("not allowed".into()), hint: None, refuse: None }]);
        assert_eq!(st.on_line(r#"{"type":"control_request","request_id":"q2","request":{"subtype":"hook_callback"}}"#), vec![Effect::Unsupported { request_id: "q2".into() }]);
        assert_eq!(st.on_line(r#"{"type":"control_cancel_request","request_id":"q1"}"#), vec![Effect::Cancel { request_id: "q1".into() }]);
        // Tool uses: a Bash that was approved, a Read that ran by itself, a hands tool (not logged here), a denied Write.
        st.on_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"del x"}},{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"C:\\a.txt"}},{"type":"tool_use","id":"tu3","name":"mcp__joya-hands__click","input":{"x":1}},{"type":"tool_use","id":"tu4","name":"Write","input":{"file_path":"C:\\b.txt"}}]}}"#);
        st.note_answer("tu1", true);
        st.note_answer("tu4", false);
        let r = st.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"},{"type":"tool_result","tool_use_id":"tu2","content":"x"},{"type":"tool_result","tool_use_id":"tu3","content":"x"},{"type":"tool_result","tool_use_id":"tu4","content":"denied","is_error":true}]}}"#);
        assert_eq!(
            r,
            vec![
                Effect::Logged { tool: "Bash".into(), summary: "Bash: del x".into(), decision: "approved".into(), kind: "cli".into(), ok: true, detail: String::new() },
                Effect::Logged { tool: "Read".into(), summary: "Read: C:\\a.txt".into(), decision: "auto".into(), kind: "cli".into(), ok: true, detail: String::new() },
                Effect::Logged { tool: "Write".into(), summary: "Write: C:\\b.txt".into(), decision: "denied".into(), kind: "cli".into(), ok: false, detail: String::new() },
            ]
        );
        st.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu5","name":"Glob","input":{"pattern":"*.md"}}]}}"#);
        assert_eq!(st.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu5","is_error":true,"content":"No such folder\nmore"}]}}"#)[0], Effect::Logged { tool: "Glob".into(), summary: "Glob: *.md".into(), decision: "error".into(), kind: "cli".into(), ok: false, detail: "No such folder".into() });
        assert_eq!(st.on_line(r#"{"type":"result","subtype":"success","result":"Done: made the PDF.","is_error":false}"#), vec![Effect::Report { text: "Done: made the PDF.".into(), is_error: false }]);
        assert_eq!(summarize("TodoWrite", &json!({"todos":[]})), "TodoWrite");
        // A command Joya's rules let run is "auto"; one the user approved on a card is "approved".
        st.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu6","name":"PowerShell","input":{"command":"dir"}}]}}"#);
        st.note_decision("tu6", "auto");
        assert_eq!(st.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu6","content":"ok"}]}}"#)[0], Effect::Logged { tool: "PowerShell".into(), summary: "PowerShell: dir".into(), decision: "auto".into(), kind: "cli".into(), ok: true, detail: String::new() });
        assert_eq!(summarize("Bash", &json!({"command":"a\nb"})), "Bash: a b");
    }

    #[test]
    fn browser_in_the_stream() {
        let mut st = Stream::new("joya-hands");
        // read_page teaches the labels; the next question about a click carries them, and the log line names them.
        st.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b1","name":"mcp__claude-in-chrome__read_page","input":{"tabId":7}}]}}"#);
        st.note_decision("b1", "auto");
        let r = st.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","content":[{"type":"text","text":"button \"Send\" [ref_12]\ntextbox \"Password\" [ref_4]"}]}]}}"#);
        assert_eq!(r[0], Effect::Browser { connected: true, detail: String::new() });
        assert!(matches!(&r[1], Effect::Logged { kind, decision, .. } if kind == "browser" && decision == "auto"));
        let ask = st.on_line(r#"{"type":"control_request","request_id":"q9","request":{"subtype":"can_use_tool","tool_name":"mcp__claude-in-chrome__computer","input":{"action":"left_click","ref":"ref_12","tabId":7,"action_summary":"Sends the reply"},"tool_use_id":"b2"}}"#);
        match &ask[0] {
            Effect::Ask { hint: Some(h), refuse: None, .. } => assert_eq!(h["targets"][0]["label"], "button \"Send\""),
            other => panic!("{other:?}"),
        }
        let ask = st.on_line(r#"{"type":"control_request","request_id":"q10","request":{"subtype":"can_use_tool","tool_name":"mcp__claude-in-chrome__form_input","input":{"ref":"ref_4","value":"x","tabId":7},"tool_use_id":"b3"}}"#);
        assert!(matches!(&ask[0], Effect::Ask { refuse: Some(_), .. }), "a password field is refused at once");
        st.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b4","name":"mcp__claude-in-chrome__tabs_context_mcp","input":{}}]}}"#);
        let r = st.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b4","is_error":true,"content":"Browser extension is not connected."}]}}"#);
        assert_eq!(r[0], Effect::Browser { connected: false, detail: "Browser extension is not connected.".into() });
        assert!(matches!(&r[1], Effect::Logged { ok: false, decision, detail, .. } if decision == "error" && detail.contains("not connected")));
    }
}
