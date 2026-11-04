//! Chrome for the laptop session: the user's own Claude in Chrome extension, reached through the
//! Claude Code CLI's Chrome integration (`claude --chrome`; its tools are mcp__claude-in-chrome__*).
//! Pure (unit-tested in core-tests): whether the extension is installed, the CLI setting that makes
//! every browser step a question to this app, what the app knows about the page (element labels
//! from read_page / find, tab addresses), the steps it refuses at once, the hint it sends with a
//! question and the action-log line.
//!
//! The rule (also in the session's instructions, and decided again on the server, machine-gate.js):
//! anything that submits a form, sends, buys, posts or deletes waits for the user's approval (an
//! approval card, Windows Hello); passwords and payment details are never typed; JOYA AI's own pages
//! are never touched. How it is enforced: the CLI is started with `--settings` holding an `ask` rule
//! for every browser tool, and `ask` beats any `allow` the user's own settings may have, so no
//! browser step runs without this app's answer (the permission prompt is this app, stdio); the app
//! refuses the never-cases itself and asks Joya about the rest.

use serde_json::{json, Value};
use std::collections::HashMap;

use crate::hands::risk;

pub const SERVER: &str = "claude-in-chrome";
pub const PREFIX: &str = "mcp__claude-in-chrome__";
/// The Claude in Chrome extension's id in the Chrome Web Store (the CLI looks for the same).
pub const EXTENSION_ID: &str = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
pub const INSTALL_URL: &str = "https://claude.ai/chrome";

pub fn is_browser(tool: &str) -> bool {
    tool.starts_with(PREFIX)
}

pub fn short(tool: &str) -> &str {
    tool.strip_prefix(PREFIX).unwrap_or(tool)
}

/// The `--settings` value: every browser tool asks (an ask rule wins over any allow rule).
pub fn cli_settings() -> String {
    json!({ "permissions": { "ask": [format!("mcp__{SERVER}")] } }).to_string()
}

/* ------------------------------------------------------------------ is the extension installed */

/// Where Chromium browsers keep their profiles on Windows: (browser, "User Data" folder).
pub fn user_data_dirs(local_appdata: &str, appdata: &str) -> Vec<(&'static str, String)> {
    let mut v = Vec::new();
    if !local_appdata.is_empty() {
        for (b, p) in [("Chrome", "Google\\Chrome\\User Data"), ("Edge", "Microsoft\\Edge\\User Data"), ("Brave", "BraveSoftware\\Brave-Browser\\User Data"), ("Chromium", "Chromium\\User Data"), ("Vivaldi", "Vivaldi\\User Data"), ("Arc", "Arc\\User Data")] {
            v.push((b, format!("{}\\{}", local_appdata.trim_end_matches('\\'), p)));
        }
    }
    if !appdata.is_empty() {
        v.push(("Opera", format!("{}\\Opera Software\\Opera Stable", appdata.trim_end_matches('\\'))));
    }
    v
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub browser: String,
    pub profile: String,
}

/// The first browser profile that has the extension. `list` lists a folder's subfolders, `exists`
/// says whether a folder exists (the CLI's own check: <User Data>\<Default|Profile N>\Extensions\<id>).
pub fn find_extension(dirs: &[(&str, String)], list: &dyn Fn(&str) -> Vec<String>, exists: &dyn Fn(&str) -> bool) -> Option<Found> {
    for (b, ud) in dirs {
        let mut profiles: Vec<String> = list(ud).into_iter().filter(|n| n == "Default" || n.starts_with("Profile ")).collect();
        profiles.sort_by_key(|p| if p == "Default" { 0 } else { 1 });
        for p in profiles {
            if exists(&format!("{ud}\\{p}\\Extensions\\{EXTENSION_ID}")) {
                return Some(Found { browser: b.to_string(), profile: p });
            }
        }
    }
    None
}

/// The hello's `chrome` field: installed or not, where, and what the last session saw.
pub fn hello_json(found: Option<&Found>, last: Option<&SeenState>) -> Value {
    let mut v = json!({ "extension": found.is_some(), "browser": found.map(|f| f.browser.clone()), "profile": found.map(|f| f.profile.clone()) });
    if let Some(s) = last {
        v["last"] = json!({ "connected": s.connected, "at": s.at, "detail": s.detail });
    }
    v
}

#[derive(Clone, Debug, PartialEq)]
pub struct SeenState {
    pub connected: bool,
    pub at: String,
    pub detail: String,
}

/// A browser tool's result -> did the extension answer? Some(true) when it worked, Some(false, why)
/// when the result says the browser is not connected, None when it says nothing about that.
pub fn connection_from_result(text: &str, is_error: bool) -> Option<(bool, String)> {
    let low = text.to_lowercase();
    const NOT: &[&str] = &["not connected", "no browser", "extension is not", "browser extension isn't", "is not installed", "could not connect to the browser", "no connected browser", "failed to connect", "connection to the browser"];
    if NOT.iter().any(|p| low.contains(p)) {
        let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(200).collect::<String>();
        return Some((false, line));
    }
    if !is_error {
        return Some((true, String::new()));
    }
    None
}

/* ------------------------------------------------------------------ what the app knows of the page */

#[derive(Default, Debug)]
pub struct Tracker {
    /// ref_12 -> "button \"Send\""
    refs: HashMap<String, String>,
    /// tab id -> its address
    tabs: HashMap<i64, String>,
}

fn ref_ids(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = line.as_bytes();
    let mut i = 0;
    while let Some(k) = line[i..].find("ref_") {
        let s = i + k;
        let mut e = s + 4;
        while e < b.len() && b[e].is_ascii_digit() {
            e += 1;
        }
        if e > s + 4 && (s == 0 || !(b[s - 1] as char).is_ascii_alphanumeric()) {
            out.push(line[s..e].to_string());
        }
        i = e.max(s + 4);
    }
    out
}

/// The label a line gives an element: its role word(s) and the first quoted text.
fn line_label(line: &str) -> String {
    let t = line.trim().trim_start_matches(['-', '*', ' ', '•']);
    let label = t.split('[').next().unwrap_or(t).trim();
    label.chars().take(160).collect()
}

fn walk_tabs(v: &Value, out: &mut HashMap<i64, String>) {
    match v {
        Value::Object(o) => {
            let id = o.get("tabId").or_else(|| o.get("id")).and_then(Value::as_i64);
            let url = o.get("url").and_then(Value::as_str);
            if let (Some(id), Some(u)) = (id, url) {
                out.insert(id, u.to_string());
            }
            for x in o.values() {
                walk_tabs(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| walk_tabs(x, out)),
        _ => {}
    }
}

impl Tracker {
    pub fn new() -> Tracker {
        Tracker::default()
    }

    /// A browser tool finished: learn the element labels (read_page / find) and the tab addresses.
    pub fn note_result(&mut self, tool: &str, input: &Value, text: &str) {
        let t = short(tool);
        if t == "read_page" || t == "find" {
            if t == "read_page" && input.get("ref_id").is_none() {
                self.refs.clear(); // a whole new page tree
            }
            for line in text.lines().take(20_000) {
                for r in ref_ids(line) {
                    self.refs.insert(r, line_label(line));
                }
            }
        }
        if t == "navigate" {
            self.refs.clear();
            if let (Some(id), Some(u)) = (input.get("tabId").and_then(Value::as_i64), input.get("url").and_then(Value::as_str)) {
                self.tabs.insert(id, full_url(u));
            }
        }
        // Tab lists (tabs_context_mcp, tabs_create_mcp, navigate's appended context): JSON in the text.
        let trimmed = text.trim();
        let mut found = HashMap::new();
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            walk_tabs(&v, &mut found);
        } else {
            for chunk in trimmed.split(['\n']) {
                let c = chunk.trim();
                if c.starts_with('{') || c.starts_with('[') {
                    if let Ok(v) = serde_json::from_str::<Value>(c) {
                        walk_tabs(&v, &mut found);
                    }
                }
            }
        }
        self.tabs.extend(found);
        if self.refs.len() > 5000 {
            self.refs.clear();
        }
    }

    pub fn label(&self, r: &str) -> Option<&str> {
        self.refs.get(r).map(String::as_str)
    }

    pub fn tab_url(&self, id: i64) -> Option<&str> {
        self.tabs.get(&id).map(String::as_str)
    }
}

fn full_url(u: &str) -> String {
    let u = u.trim();
    if u.contains("://") || u == "back" || u == "forward" {
        u.to_string()
    } else {
        format!("https://{u}")
    }
}

/* ------------------------------------------------------------------ the steps */

/// One step of a browser tool, as the rules see it (a browser_batch has several).
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub tool: String,
    pub input: Value,
}

pub fn steps(tool: &str, input: &Value) -> Vec<Step> {
    if short(tool) == "browser_batch" {
        return input.get("actions").and_then(Value::as_array).map(|a| a.iter().take(100).map(|x| Step { tool: format!("{PREFIX}{}", x.get("name").and_then(Value::as_str).unwrap_or("?")), input: x.get("input").cloned().unwrap_or(json!({})) }).collect()).unwrap_or_default();
    }
    vec![Step { tool: tool.to_string(), input: input.clone() }]
}

const SECRET_WORDS: &[&str] = &["password", "passcode", "passwort", "mot de passe", "pin", "cvv", "cvc", "csc", "security code", "card number", "credit card", "debit card", "iban", "one time code", "otp", "verification code", "2fa", "كلمة المرور", "كلمه السر", "الرقم السري", "رقم البطاقة"];

/// Does a label or a summary say it is a password / payment field?
pub fn mentions_secret(s: &str) -> bool {
    let f = risk::fold(s);
    let padded = format!(" {} ", f.split_whitespace().collect::<Vec<_>>().join(" "));
    SECRET_WORDS.iter().any(|w| padded.contains(&format!(" {} ", risk::fold(w).split_whitespace().collect::<Vec<_>>().join(" "))))
}

/// The steps the app refuses at once, whatever anyone would answer: JOYA AI's own pages, typing into
/// password / payment fields, card numbers. Some(why).
pub fn refusal(tool: &str, input: &Value, tr: &Tracker) -> Option<String> {
    for st in steps(tool, input) {
        let i = &st.input;
        let t = short(&st.tool);
        let tab = i.get("tabId").and_then(Value::as_i64);
        if let Some(u) = tab.and_then(|id| tr.tab_url(id)) {
            if risk::is_own_surface_url(u) && t != "tabs_context_mcp" && t != "tabs_close_mcp" {
                return Some("That tab is Joya itself; JOYA AI never acts on its own approval pages.".into());
            }
        }
        if t == "navigate" {
            if let Some(u) = i.get("url").and_then(Value::as_str) {
                if risk::is_own_surface_url(&full_url(u)) {
                    return Some("Joya's own pages are for the user; JOYA AI does not open them in the browser.".into());
                }
            }
        }
        let typed = match t {
            "form_input" => i.get("value").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())),
            "computer" if i.get("action").and_then(Value::as_str) == Some("type") => i.get("text").and_then(Value::as_str).map(str::to_string),
            _ => None,
        };
        if let Some(text) = typed {
            if risk::contains_card_number(&text) {
                return Some("That looks like a payment card number; JOYA AI never types card numbers. The user must enter it.".into());
            }
            let target = i.get("ref").and_then(Value::as_str).and_then(|r| tr.label(r)).unwrap_or("");
            let summary = i.get("action_summary").and_then(Value::as_str).unwrap_or("");
            if mentions_secret(target) || mentions_secret(summary) {
                return Some("That is a password, PIN, code or payment field; JOYA AI never types those. The user must fill it in.".into());
            }
        }
    }
    None
}

/// What the app adds to a browser question for the server's rules and the card: the labels of the
/// elements it targets (from the last read_page / find) and the tabs' addresses.
pub fn hint(tool: &str, input: &Value, tr: &Tracker) -> Value {
    let mut targets = Vec::new();
    let mut urls = Vec::new();
    for st in steps(tool, input) {
        if let Some(r) = st.input.get("ref").and_then(Value::as_str) {
            if let Some(l) = tr.label(r) {
                targets.push(json!({ "ref": r, "label": l }));
            }
        }
        if let Some(u) = st.input.get("tabId").and_then(Value::as_i64).and_then(|id| tr.tab_url(id)) {
            if !urls.iter().any(|x: &String| x == u) {
                urls.push(u.to_string());
            }
        }
    }
    json!({ "targets": targets, "tab_urls": urls })
}

/// The action-log line for a browser step ("Chrome: click \"Send\" — Sends the reply").
pub fn summarize(tool: &str, input: &Value, tr: &Tracker) -> String {
    let parts: Vec<String> = steps(tool, input).iter().map(|st| one_line(st, tr)).collect();
    let s = if short(tool) == "browser_batch" { format!("Chrome batch: {}", parts.join("; ")) } else { format!("Chrome: {}", parts.join("; ")) };
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(480).collect()
}

fn one_line(st: &Step, tr: &Tracker) -> String {
    let i = &st.input;
    let t = short(&st.tool);
    let target = i.get("ref").and_then(Value::as_str).map(|r| tr.label(r).map(|l| l.to_string()).unwrap_or_else(|| r.to_string()));
    let summary = i.get("action_summary").and_then(Value::as_str).map(|s| format!(" — {}", s.chars().take(120).collect::<String>())).unwrap_or_default();
    match t {
        "navigate" => format!("open {}", i.get("url").and_then(Value::as_str).unwrap_or("?")),
        "computer" => {
            let a = i.get("action").and_then(Value::as_str).unwrap_or("?");
            match a {
                "type" => format!("{}{}", risk::typed_summary(i.get("text").and_then(Value::as_str).unwrap_or(""), false), summary),
                "key" => format!("press {}{}", i.get("text").and_then(Value::as_str).unwrap_or("?"), summary),
                "screenshot" | "zoom" | "scroll" | "scroll_to" | "wait" | "hover" => a.replace('_', " "),
                _ => format!("{} {}{}", a.replace('_', " "), target.unwrap_or_else(|| "at a point".into()), summary),
            }
        }
        "form_input" => format!("fill {} ({}){}", target.unwrap_or_else(|| "a field".into()), risk::typed_summary(&i.get("value").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default(), false), summary),
        "find" => format!("find \"{}\"", i.get("query").and_then(Value::as_str).unwrap_or("").chars().take(80).collect::<String>()),
        "javascript_tool" => format!("run a script on the page ({} characters)", i.get("text").and_then(Value::as_str).map(|s| s.chars().count()).unwrap_or(0)),
        "file_upload" => format!("upload {}", i.get("paths").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default()),
        "tabs_create_mcp" => "open a new tab".into(),
        "tabs_close_mcp" => "close a tab".into(),
        "tabs_context_mcp" => "list the tabs".into(),
        "read_page" => "read the page".into(),
        "get_page_text" => "read the page's text".into(),
        other => other.replace('_', " "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_ask_for_every_browser_tool() {
        let s: Value = serde_json::from_str(&cli_settings()).unwrap();
        assert_eq!(s, json!({"permissions": {"ask": ["mcp__claude-in-chrome"]}}));
        assert!(is_browser("mcp__claude-in-chrome__navigate") && !is_browser("mcp__joya-hands__wait"));
    }

    #[test]
    fn finds_the_extension() {
        let dirs = user_data_dirs("C:\\Users\\a\\AppData\\Local", "C:\\Users\\a\\AppData\\Roaming");
        assert_eq!(dirs[0], ("Chrome", "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data".to_string()));
        assert!(dirs.iter().any(|d| d.0 == "Opera"));
        let list = |p: &str| -> Vec<String> { if p.ends_with("Chrome\\User Data") { vec!["System Profile".into(), "Profile 2".into(), "Default".into(), "Crashpad".into()] } else { vec![] } };
        let has = |p: &str| p.ends_with("Profile 2\\Extensions\\fcoeoabgfenejglbffodgkkbkcdhcgfn");
        assert_eq!(find_extension(&dirs, &list, &has), Some(Found { browser: "Chrome".into(), profile: "Profile 2".into() }));
        assert_eq!(find_extension(&dirs, &list, &|_| false), None);
        let h = hello_json(None, Some(&SeenState { connected: false, at: "2026-10-20T10:00:00Z".into(), detail: "Browser extension is not connected".into() }));
        assert_eq!(h["extension"], false);
        assert_eq!(h["last"]["connected"], false);
    }

    #[test]
    fn connection_from_results() {
        assert_eq!(connection_from_result("[{\"tabId\":1}]", false), Some((true, String::new())));
        assert_eq!(connection_from_result("Browser extension is not connected. Ask the user…", true).map(|x| x.0), Some(false));
        assert_eq!(connection_from_result("Element not found", true), None);
    }

    #[test]
    fn tracks_labels_and_tabs() {
        let mut tr = Tracker::new();
        tr.note_result("mcp__claude-in-chrome__tabs_context_mcp", &json!({}), r#"{"availableTabs":[{"tabId":11,"title":"Inbox","url":"https://mail.google.com/mail/u/0/"},{"tabId":12,"title":"Joya","url":"https://joya.example.com/joya-ai"}],"tabGroupId":3}"#);
        tr.note_result("mcp__claude-in-chrome__read_page", &json!({"tabId": 11}), "- main\n  - textbox \"To\" [ref_3]\n  - button \"Send\" [ref_12]\n  - link \"Sent mail\" [ref=ref_13]\n");
        assert_eq!(tr.label("ref_12"), Some("button \"Send\""));
        assert_eq!(tr.label("ref_13"), Some("link \"Sent mail\""));
        assert_eq!(tr.tab_url(11), Some("https://mail.google.com/mail/u/0/"));
        // A click on Joya's own tab: refused at once.
        assert!(refusal("mcp__claude-in-chrome__computer", &json!({"action": "left_click", "coordinate": [1, 2], "tabId": 12}), &tr).unwrap().contains("Joya"));
        assert!(refusal("mcp__claude-in-chrome__navigate", &json!({"url": "joya.example.com/approvals"}), &tr).is_some());
        assert!(refusal("mcp__claude-in-chrome__navigate", &json!({"url": "https://example.com"}), &tr).is_none());
        // A whole new read_page forgets the old refs; navigate too.
        tr.note_result("mcp__claude-in-chrome__navigate", &json!({"url": "https://example.com", "tabId": 11}), "Navigated");
        assert_eq!(tr.label("ref_12"), None);
        assert_eq!(tr.tab_url(11), Some("https://example.com"));
        let h = hint("mcp__claude-in-chrome__computer", &json!({"action": "left_click", "ref": "ref_99", "tabId": 11}), &tr);
        assert_eq!(h["tab_urls"], json!(["https://example.com"]));
    }

    #[test]
    fn never_types_secrets() {
        let mut tr = Tracker::new();
        tr.note_result("mcp__claude-in-chrome__find", &json!({"tabId": 1}), "textbox \"Password\" [ref_4]\ntextbox \"Card number\" [ref_5]\ntextbox \"Search\" [ref_6]");
        let fi = |r: &str, v: &str| refusal("mcp__claude-in-chrome__form_input", &json!({"ref": r, "value": v, "tabId": 1}), &tr);
        assert!(fi("ref_4", "hunter2").is_some());
        assert!(fi("ref_5", "x").is_some());
        assert!(fi("ref_6", "4111 1111 1111 1111").unwrap().contains("card"));
        assert!(fi("ref_6", "weather in Cairo").is_none());
        assert!(refusal("mcp__claude-in-chrome__computer", &json!({"action": "type", "text": "x", "action_summary": "Types the password", "tabId": 1}), &tr).is_some());
        assert!(refusal("mcp__claude-in-chrome__computer", &json!({"action": "type", "text": "hello", "action_summary": "Types the search words", "tabId": 1}), &tr).is_none());
        // Inside a batch too.
        assert!(refusal("mcp__claude-in-chrome__browser_batch", &json!({"actions": [{"name": "navigate", "input": {"url": "https://shop.example", "tabId": 1}}, {"name": "form_input", "input": {"ref": "ref_4", "value": "x", "tabId": 1}}]}), &tr).is_some());
        assert!(mentions_secret("Enter your PIN") && mentions_secret("كلمة المرور") && !mentions_secret("Pinterest board") && !mentions_secret("Spinning"));
    }

    #[test]
    fn log_lines() {
        let mut tr = Tracker::new();
        tr.note_result("mcp__claude-in-chrome__read_page", &json!({"tabId": 1}), "button \"Send\" [ref_12]");
        assert_eq!(summarize("mcp__claude-in-chrome__computer", &json!({"action": "left_click", "ref": "ref_12", "action_summary": "Sends the reply", "tabId": 1}), &tr), "Chrome: left click button \"Send\" — Sends the reply");
        assert_eq!(summarize("mcp__claude-in-chrome__navigate", &json!({"url": "https://example.com"}), &tr), "Chrome: open https://example.com");
        let typed = summarize("mcp__claude-in-chrome__computer", &json!({"action": "type", "text": "Pa55word!", "tabId": 1}), &tr);
        assert!(!typed.contains("Pa55word"), "{typed}");
        assert!(summarize("mcp__claude-in-chrome__browser_batch", &json!({"actions": [{"name": "navigate", "input": {"url": "https://a.example"}}, {"name": "computer", "input": {"action": "screenshot"}}]}), &tr).starts_with("Chrome batch: open https://a.example; screenshot"));
    }
}
