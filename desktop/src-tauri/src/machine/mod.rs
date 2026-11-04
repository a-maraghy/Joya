//! Laptop control ("Path A"): this app as JOYA AI's machine agent.
//!
//! Paired once with Joya (Settings ▸ This computer: a one-time code -> a machine token, kept in
//! Windows Credential Manager only), the app keeps one outbound WebSocket to the server (link.rs;
//! no inbound port). When the user asks JOYA AI to take over the laptop, the server sends `start`:
//! the app starts a time-limited **lease** (lease.rs), shows a glowing frame on every monitor and a
//! "JOYA AI is controlling" pill (overlay.rs), serves the hands (crate::hands) as an MCP server on
//! loopback (mcp_http.rs, a new secret per lease) and runs Claude Code headless (runner.rs,
//! claude.rs): its permission questions become approval cards in Joya (`ask` / `answer`), its
//! final text of each turn goes back to JOYA AI (`report`), every tool it uses is logged (`action`).
//!
//! Nothing runs without an active lease, and the app enforces that itself. The lease ends -- and the
//! CLI's whole process tree is killed at once (a Job Object) -- on the local stop hotkey
//! (Ctrl+Alt+Esc), the pill's Stop, its expiry, the Windows lock screen, sign-out / shutdown / app
//! exit, the link lost for 30 s, the server's `stop` / `revoked`, unlinking, or the CLI exiting.
//! The site (capabilities/remote.json) can call none of this.

pub mod browser;
pub mod claude;
pub mod lease;
pub mod mcp_http;
pub mod prompt;
pub mod wire;

mod cred;
mod link;
mod overlay;
pub mod overlay_layout;
mod runner;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use url::Url;

/// A permission question waits this long for its card to be answered, then it is denied.
const ASK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The lease ends when the link has been down this long.
const LINK_GRACE: Duration = Duration::from_secs(30);
const OUTBOX_MAX: usize = 400;
const OUTBOX_BYTES: usize = 12 * 1024 * 1024;

static CTL: OnceLock<Arc<Ctl>> = OnceLock::new();

fn ctl() -> Option<Arc<Ctl>> {
    CTL.get().cloned()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_default()
}

/* ------------------------------------------------------------------ state */

struct Out {
    ask: bool,
    action: bool,
    text: String,
}

struct Answer {
    allow: bool,
    message: Option<String>,
    /// Joya's rules allowed it without a card.
    auto: bool,
}

struct Pending {
    tx: mpsc::Sender<Answer>,
    /// The CLI's request_id, for a question from the CLI (None: the hands' request_approval).
    cli_request: Option<String>,
}

#[derive(Clone, Default)]
struct ClaudeInfo {
    checked: bool,
    path: Option<String>,
    program: String,
    pre: Vec<String>,
    version: Option<String>,
    git_bash: Option<String>,
}

struct Run {
    #[allow(dead_code)]
    lease_id: String,
    proc: Arc<runner::Proc>,
    mcp: mcp_http::Server,
}

/// What this computer has for the hands besides Claude Code: the Chrome extension, Office.
#[derive(Clone, Default)]
struct Extras {
    chrome: Option<browser::Found>,
    office: Vec<&'static str>,
}

struct St {
    online: bool,
    offline_since: Option<Instant>,
    linked: bool,
    name: String,
    machine_id: String,
    lease: lease::Lease,
    run: Option<Run>,
    stop_key: String,
    stop_fallback: bool,
    claude: ClaudeInfo,
    error: String,
    extras: Extras,
    /// What the last browser step showed about the extension.
    chrome_seen: Option<browser::SeenState>,
    /// The last action of this lease, for the pill.
    last_action: String,
}

pub struct Ctl {
    app: AppHandle,
    st: Mutex<St>,
    outbox: Mutex<VecDeque<Out>>,
    pending: Mutex<HashMap<String, Pending>>,
    gen: AtomicU64,
    seq: AtomicU64,
}

/* ------------------------------------------------------------- the hooks */

/// lib.rs setup: start the link and the lease clock. Call before register_hotkeys.
pub fn setup(app: &AppHandle) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let c = Arc::new(Ctl {
        app: app.clone(),
        st: Mutex::new(St {
            online: false,
            offline_since: None,
            linked: false,
            name: String::new(),
            machine_id: String::new(),
            lease: lease::Lease::new(),
            run: None,
            stop_key: String::new(),
            stop_fallback: false,
            claude: ClaudeInfo::default(),
            error: String::new(),
            extras: Extras::default(),
            chrome_seen: None,
            last_action: String::new(),
        }),
        outbox: Mutex::new(VecDeque::new()),
        pending: Mutex::new(HashMap::new()),
        gen: AtomicU64::new(1),
        seq: AtomicU64::new(0),
    });
    if CTL.set(c.clone()).is_err() {
        return;
    }
    let c1 = c.clone();
    let _ = std::thread::Builder::new().name("joya-machine-link".into()).spawn(move || {
        c1.detect_claude();
        link::run(c1)
    });
    let c2 = c.clone();
    let _ = std::thread::Builder::new().name("joya-machine-clock".into()).spawn(move || c2.clock());
}

/// lib.rs register_hotkeys: the local stop key (always registered, lease or not, so it can never
/// fail to register mid-lease). A taken default falls back to Ctrl+Alt+Shift+Esc (a toast says so).
pub fn register_stop(app: &AppHandle, wanted: &str) {
    let gs = app.global_shortcut();
    let mut key = wanted.to_string();
    let mut fallback = false;
    if gs.register(key.as_str()).is_err() {
        if key == crate::settings::DEFAULT_STOP && gs.register(crate::settings::FALLBACK_STOP).is_ok() {
            key = crate::settings::FALLBACK_STOP.into();
            fallback = true;
            toast(app, "Press Ctrl+Alt+Shift+Esc to stop JOYA AI's control", "Ctrl+Alt+Esc is taken by another app on this computer, so JOYA AI's stop key is Ctrl+Alt+Shift+Esc. The Stop button on the pill always works.");
        } else {
            key = String::new();
            toast(app, "JOYA AI's stop key could not be set", &format!("{} is taken by another app. Pick another in Settings; the Stop button on the pill always works.", wanted));
        }
    }
    mlog!("hotkeys: stop control {:?}{}", key, if fallback { " (fallback)" } else { "" });
    if let Some(c) = ctl() {
        let mut st = c.st.lock().unwrap();
        st.stop_key = key;
        st.stop_fallback = fallback;
    }
}

/// lib.rs on_hotkey: true when it was the stop key (handled here, locally: no server round trip).
pub fn on_hotkey(sc: &Shortcut, pressed: bool) -> bool {
    let Some(c) = ctl() else { return false };
    let key = c.st.lock().unwrap().stop_key.clone();
    if key.is_empty() || key.parse::<Shortcut>().ok().as_ref() != Some(sc) {
        return false;
    }
    if pressed {
        mlog!("stop key pressed");
        c.end_lease("stop-hotkey");
    }
    true
}

/// lib.rs env_loop, once a second: the lock screen ends a lease.
pub fn on_locked(locked: bool) {
    if locked {
        if let Some(c) = ctl() {
            c.end_lease("locked");
        }
    }
}

/// lib.rs, RunEvent::Exit (also Windows sign-out / shutdown: tao ends the loop on WM_ENDSESSION).
/// The Job Object would kill the CLI anyway when this process goes; this also tells the server.
pub fn on_exit() {
    let Some(c) = ctl() else { return };
    let reason = if shutting_down() { "signout" } else { "app-exit" };
    if c.end_lease(reason) {
        for line in crate::hands::shutdown() {
            mlog!("end of the take-over: {line}");
        }
        // Give the link a moment to send "lease ended".
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_millis(800) && c.st.lock().unwrap().online && !c.outbox.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(windows)]
fn shutting_down() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}
#[cfg(not(windows))]
fn shutting_down() -> bool {
    false
}

fn toast(app: &AppHandle, title: &str, body: &str) {
    #[cfg(windows)]
    {
        let id = app.config().identifier.clone();
        let _ = tauri_winrt_notification::Toast::new(&id).title(title).text1(body).show();
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body);
    }
}

fn on_main<F: FnOnce(&AppHandle) + Send + 'static>(app: &AppHandle, f: F) {
    let h = app.clone();
    if let Err(e) = app.run_on_main_thread(move || f(&h)) {
        mlog!("machine: run_on_main_thread failed: {}", e);
    }
}

/* ----------------------------------------------------------- the link side */

impl Ctl {
    fn settings(&self) -> crate::settings::Settings {
        self.app.try_state::<Arc<Mutex<crate::App>>>().map(|s| s.lock().unwrap().settings.clone()).unwrap_or_default()
    }

    fn origin(&self) -> Url {
        Url::parse(&self.settings().origin).unwrap_or_else(|_| Url::parse(crate::settings::DEFAULT_ORIGIN).unwrap())
    }

    fn host(&self) -> String {
        self.origin().host_str().unwrap_or("").to_string()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.gen.load(Ordering::SeqCst)
    }

    fn relink(&self) {
        self.gen.fetch_add(1, Ordering::SeqCst);
    }

    /// The origin and the token, when linked.
    pub(crate) fn origin_and_token(&self) -> Option<(Url, String)> {
        let o = self.origin();
        let t = cred::read(o.host_str().unwrap_or(""));
        self.st.lock().unwrap().linked = t.is_some();
        t.map(|t| (o, t))
    }

    pub(crate) fn set_online(&self, on: bool) {
        let was = {
            let mut st = self.st.lock().unwrap();
            let was = st.online;
            st.online = on;
            if on {
                st.offline_since = None;
            } else if was || st.offline_since.is_none() {
                st.offline_since = Some(Instant::now());
            }
            was
        };
        if was && !on {
            // Questions cannot be answered over a lost link: deny them now; queued ones are dropped.
            self.outbox.lock().unwrap().retain(|o| !o.ask);
            self.fail_pending();
        }
    }

    /// 401/403 on the upgrade, or the server's `revoked`: the token is gone.
    pub(crate) fn token_revoked(&self) {
        cred::delete(&self.host());
        {
            let mut st = self.st.lock().unwrap();
            st.linked = false;
            st.name.clear();
            st.machine_id.clear();
            st.error = "This computer was unlinked from Joya.".into();
        }
        self.end_lease("unlinked");
        self.relink();
    }

    pub(crate) fn hello(&self) -> Value {
        let (c, x, seen) = {
            let st = self.st.lock().unwrap();
            (st.claude.clone(), st.extras.clone(), st.chrome_seen.clone())
        };
        let mut h = wire::hello(crate::VERSION, &computer_name(), &env("USERNAME"), &env("USERPROFILE"), &wire::Claude { path: c.path.as_deref(), version: c.version.as_deref(), git_bash: c.git_bash.is_some() });
        // Since 0.1.11: the Claude in Chrome extension and Office, for the Computers page.
        h["chrome"] = browser::hello_json(x.chrome.as_ref(), seen.as_ref());
        h["office"] = json!(x.office);
        h
    }

    pub(crate) fn drain_outbox(&self) -> Vec<String> {
        self.outbox.lock().unwrap().drain(..).map(|o| o.text).collect()
    }

    fn push(&self, v: Value, ask: bool) {
        let text = v.to_string();
        if text.len() > wire::MAX_FRAME {
            mlog!("machine: a {} message too big to send ({} bytes) dropped", v["t"], text.len());
            return;
        }
        let action = v["t"] == "action";
        let mut q = self.outbox.lock().unwrap();
        q.push_back(Out { ask, action, text });
        // While offline it fills up: the action log goes first (oldest first), never lease / session messages.
        let mut bytes: usize = q.iter().map(|o| o.text.len()).sum();
        while q.len() > OUTBOX_MAX || bytes > OUTBOX_BYTES {
            let Some(i) = q.iter().position(|o| o.action) else { break };
            bytes -= q[i].text.len();
            q.remove(i);
        }
    }

    fn send(&self, v: Value) {
        self.push(v, false);
    }

    pub(crate) fn on_text(self: &Arc<Self>, text: &str) {
        let Some(m) = wire::parse_in(text) else {
            // Never silently: say what it was, and a `start` we cannot read is answered as failed
            // (the server ends its lease and JOYA AI hears why).
            let p = wire::peek(text);
            mlog!("machine link: could not read a {:?} message from the server (slug {:?}, lease {:?})", p.t, p.slug, p.lease_id);
            if p.t == "start" {
                if let Some(slug) = p.slug {
                    self.fail_start(&slug, None, wire::UNREADABLE_START);
                }
            }
            return;
        };
        match m {
            wire::In::Welcome { machine_id, name } => {
                let mut st = self.st.lock().unwrap();
                st.machine_id = machine_id;
                st.name = name;
                st.error.clear();
            }
            wire::In::Renamed { name } => self.st.lock().unwrap().name = name,
            wire::In::Revoked => {
                mlog!("machine link: the server revoked this computer");
                self.token_revoked();
            }
            wire::In::Start { slug, name, purpose, model, first_prompt, lease, folders, browser } => {
                mlog!("machine link: start for {} (lease {}, {:?} min, {} added folder(s), browser {:?})", slug, lease.id, lease.minutes, folders.len(), browser);
                let me = self.clone();
                std::thread::spawn(move || me.start(slug, name, purpose, model, first_prompt, lease, folders, browser));
            }
            wire::In::Extend { lease_id, expires_at } => {
                let Some(e) = wire::parse_iso(&expires_at) else { return };
                let r = {
                    let mut st = self.st.lock().unwrap();
                    if st.lease.current().map(|a| a.id == lease_id).unwrap_or(false) {
                        st.lease.extend(e, now_ms())
                    } else {
                        None
                    }
                };
                if let Some(e) = r {
                    self.send(wire::lease(&lease_id, "extended", Some(e), None));
                }
            }
            wire::In::Tell { slug, text } => {
                let proc = {
                    let st = self.st.lock().unwrap();
                    let ok = st.lease.active(now_ms()) && st.lease.current().map(|a| a.slug == slug).unwrap_or(false);
                    if ok {
                        st.run.as_ref().map(|r| r.proc.clone())
                    } else {
                        None
                    }
                };
                if let Some(p) = proc {
                    p.send(&claude::user_message(&text));
                }
            }
            wire::In::Stop { lease_id, reason } => {
                mlog!("machine link: the server stopped lease {} ({})", lease_id, reason.unwrap_or_default());
                let e = self.st.lock().unwrap().lease.current().map(|a| a.id == lease_id).unwrap_or(false);
                if e {
                    self.end_lease("server");
                }
            }
            wire::In::Answer { rid, behavior, message, auto } => {
                if let Some(p) = self.pending.lock().unwrap().remove(&rid) {
                    let _ = p.tx.send(Answer { allow: behavior == "allow", message, auto });
                }
            }
            wire::In::Unknown => {}
        }
    }

    /* ---------------------------------------------------------- the lease */

    fn lease_active_id(&self, id: &str) -> bool {
        let st = self.st.lock().unwrap();
        st.lease.active(now_ms()) && st.lease.current().map(|a| a.id == id).unwrap_or(false)
    }

    /// End the lease that is on (no-op when none): kill the CLI's tree, stop the MCP server, deny
    /// every open question, hide the frame and the pill, tell the server. True when one was ended.
    pub fn end_lease(&self, reason: &str) -> bool {
        self.finish(|l| l.end(reason))
    }

    fn finish(&self, f: impl FnOnce(&mut lease::Lease) -> Option<lease::Ended>) -> bool {
        let (ended, run) = {
            let mut st = self.st.lock().unwrap();
            let Some(e) = f(&mut st.lease) else { return false };
            (e, st.run.take())
        };
        if let Some(r) = &run {
            r.proc.kill();
            r.mcp.stop();
        }
        self.fail_pending();
        self.st.lock().unwrap().last_action.clear();
        std::thread::spawn(|| {
            for line in crate::hands::shutdown() {
                mlog!("end of the take-over: {line}");
            }
        });
        on_main(&self.app, overlay::hide);
        mlog!("control lease {} ended: {}", ended.id, ended.reason);
        self.send(wire::lease(&ended.id, "ended", None, Some(&ended.reason)));
        true
    }

    fn fail_pending(&self) {
        // Dropping the senders wakes every waiting question with "disconnected" = deny.
        self.pending.lock().unwrap().clear();
    }

    /// Once a second: expiry, and the link lost for more than 30 s.
    fn clock(&self) {
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let now = now_ms();
            if self.finish(|l| l.tick(now)) {
                continue;
            }
            let lost = {
                let st = self.st.lock().unwrap();
                st.lease.active(now) && !st.online && st.offline_since.map(|t| t.elapsed() > LINK_GRACE).unwrap_or(false)
            };
            if lost {
                self.end_lease("link-lost");
            }
        }
    }

    /* ------------------------------------------------------ questions */

    fn new_rid(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let r: u32 = rand::random();
        format!("q{}-{:08x}", n, r)
    }

    /// Raise a card and wait for it. None = no answer (timeout, link lost, lease ended).
    fn ask_wait(&self, rid: &str, rx: &mpsc::Receiver<Answer>) -> Option<Answer> {
        match rx.recv_timeout(ASK_TIMEOUT) {
            Ok(a) => Some(a),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(rid);
                self.send(wire::cancel(rid));
                None
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
        }
    }

    /// The hands' own approvals (request_approval and the risky steps): blocks until answered.
    fn approve_blocking(&self, lease_id: &str, slug: &str, tool: &str, summary: &str, why: &str, delete_paths: &[String]) -> bool {
        if !self.lease_active_id(lease_id) || !self.st.lock().unwrap().online {
            return false;
        }
        let rid = self.new_rid();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(rid.clone(), Pending { tx, cli_request: None });
        let tool = format!("mcp__{}__{}", crate::hands::SERVER_NAME, tool);
        let mut input = json!({ "summary": wire::clip(summary, 2000), "why": wire::clip(why, 2000) });
        if !delete_paths.is_empty() {
            // The server decides what these allow (exactly these files, this lease, 5 minutes); the app only passes them on.
            input["delete_paths"] = json!(delete_paths.iter().take(10).map(|p| wire::clip(p, 400)).collect::<Vec<_>>());
        }
        self.push(wire::ask(&rid, slug, &tool, &input, None, None, "hands"), true);
        let a = self.ask_wait(&rid, &rx);
        a.map(|a| a.allow).unwrap_or(false) && self.lease_active_id(lease_id)
    }

    /// One action-log entry (Joya > Computers) and the pill's "last action" line.
    fn log_action(&self, lease_id: &str, slug: &str, a: &wire::Act) {
        {
            let mut st = self.st.lock().unwrap();
            st.last_action = overlay_layout::last_action_text(a.tool, a.target, a.decision, a.ok);
        }
        self.send(wire::action_log(lease_id, slug, now_ms(), a));
    }

    /* ------------------------------------------------------------ start */

    /// The session could not start: logged, reported to the server at once with the reason (it ends
    /// its lease and the hire, and JOYA AI hears why), the local lease (when one was started) ended
    /// -- the frame and the pill go with it -- and the user told by a toast.
    fn fail_start(&self, slug: &str, lease_id: Option<&str>, why: &str) {
        mlog!("control session {} not started: {}", slug, why);
        self.send(wire::session(slug, "failed", Some(why)));
        if let Some(id) = lease_id {
            self.finish(|l| l.end_if(id, "failed"));
        }
        toast(&self.app, "JOYA AI could not take over this computer", &wire::clip(why, 240));
    }

    /// Look for Claude Code again; when what is found changed, tell the server (a new hello).
    fn recheck_claude(&self) {
        let before = self.claude_key();
        self.detect_claude();
        if self.claude_key() != before && self.st.lock().unwrap().online {
            mlog!("claude code: changed, telling Joya");
            let h = self.hello();
            self.send(h);
        }
    }

    fn claude_key(&self) -> (Option<String>, Option<String>, bool, Option<browser::Found>, Vec<&'static str>) {
        let st = self.st.lock().unwrap();
        (st.claude.path.clone(), st.claude.version.clone(), st.claude.git_bash.is_some(), st.extras.chrome.clone(), st.extras.office.clone())
    }

    #[allow(clippy::too_many_arguments)]
    fn start(self: Arc<Self>, slug: String, name: String, purpose: String, model: Option<String>, first_prompt: String, spec: wire::LeaseSpec, folders: Vec<String>, browser_ok: Option<bool>) {
        if !wire::slug_ok(&slug) {
            return self.fail_start(&slug, None, "bad session name");
        }
        let now = now_ms();
        if self.st.lock().unwrap().lease.active(now) {
            return self.fail_start(&slug, None, "already under control");
        }
        let info = {
            let c = self.st.lock().unwrap().claude.clone();
            if c.path.as_deref().map(|p| Path::new(p).is_file()).unwrap_or(false) {
                c
            } else {
                // Not found (or gone since): look again -- it may have been installed meanwhile.
                self.recheck_claude();
                self.st.lock().unwrap().claude.clone()
            }
        };
        let Some(exe) = info.path.clone() else {
            return self.fail_start(&slug, None, wire::NOT_INSTALLED);
        };
        let Some(expires) = wire::lease_expiry(&spec, now) else {
            return self.fail_start(&slug, None, "the lease has no expiry");
        };
        let started = self.st.lock().unwrap().lease.start(&spec.id, &slug, expires, now).map(|a| (a.id.clone(), a.expires_at));
        let (lease_id, expires_at) = match started {
            Ok(x) => x,
            Err(e) => return self.fail_start(&slug, None, e),
        };
        mlog!("control lease {} started for {} ({} min)", lease_id, slug, (expires_at - now) / 60_000);
        self.send(wire::lease(&lease_id, "active", Some(expires_at), None));
        self.send(wire::session(&slug, "starting", None));
        on_main(&self.app, overlay::show);

        // The hands on loopback, with a new secret for this lease.
        let mut secret = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut secret);
        let secret = claude::hex(&secret);
        // The folders the file tools may use: Documents, Desktop, Downloads, OneDrive and the user's own.
        let pd = self.app.path();
        let profile_s = env("USERPROFILE");
        let dir_s = |d: Result<PathBuf, tauri::Error>, fallback: &str| d.map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| format!("{profile_s}\\{fallback}"));
        let (docs_s, desk_s, down_s) = (dir_s(pd.document_dir(), "Documents"), dir_s(pd.desktop_dir(), "Desktop"), dir_s(pd.download_dir(), "Downloads"));
        let onedrive: Vec<String> = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].iter().map(|k| env(k)).filter(|v| !v.is_empty()).collect();
        let onedrive_refs: Vec<&str> = onedrive.iter().map(String::as_str).collect();
        let roots = crate::hands::paths::roots(&docs_s, &desk_s, &down_s, &onedrive_refs, &folders);
        let extras = self.st.lock().unwrap().extras.clone();
        let chrome = extras.chrome.is_some() && browser_ok != Some(false);
        let host = Arc::new(MachineHost { ctl: self.clone(), lease_id: lease_id.clone(), slug: slug.clone(), work_dir: self.work_dir(), roots: roots.clone(), home: profile_s.clone() });
        let srv = match mcp_http::Server::start(secret.clone(), Arc::new(HandsTools { host: host.clone() })) {
            Ok(s) => s,
            Err(e) => return self.fail_start(&slug, Some(&lease_id), &format!("could not open the hands server: {}", e)),
        };

        // Folders: cwd Documents, files into Documents\JOYA AI, and Desktop / Downloads / Pictures.
        let p = self.app.path();
        let profile = PathBuf::from(env("USERPROFILE"));
        let docs = p.document_dir().unwrap_or_else(|_| profile.join("Documents"));
        let work = host.work_dir.clone();
        let _ = std::fs::create_dir_all(&work);
        let mut add_dirs: Vec<String> = [p.desktop_dir().ok(), p.download_dir().ok(), p.picture_dir().ok()].into_iter().flatten().filter(|d| d.is_dir()).map(|d| d.to_string_lossy().to_string()).collect();
        for r in &roots {
            if !add_dirs.iter().any(|d| d.eq_ignore_ascii_case(&r.path)) && !r.path.eq_ignore_ascii_case(&docs.to_string_lossy()) && Path::new(&r.path).is_dir() {
                add_dirs.push(r.path.clone());
            }
        }

        let defs = crate::hands::tool_defs();
        let allowed = claude::allowed_tools(crate::hands::SERVER_NAME, &defs);
        let mcp = claude::mcp_config(srv.port, &secret, crate::hands::SERVER_NAME);
        let minutes = (expires_at.saturating_sub(now) + 59_999) / 60_000;
        let folder_list: Vec<String> = roots.iter().map(|r| r.path.clone()).collect();
        let work_s = work.to_string_lossy().to_string();
        let mut sys = prompt::system_prompt(&prompt::Ctx { purpose: &purpose, minutes, work_dir: &work_s, folders: &folder_list, office: &extras.office, chrome });
        if info.program.to_ascii_lowercase().ends_with(".cmd") {
            sys = sys.replace('\n', " "); // cmd.exe cannot take a newline in an argument
        }
        let mut id = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
        let session_id = claude::uuid_v4(id);
        let mut args = info.pre.clone();
        args.extend(claude::args(&claude::CliOpts { name: &name, model: model.as_deref(), session_id: &session_id, mcp_config: &mcp, allowed_tools: &allowed, system_prompt: &sys, add_dirs: &add_dirs, chrome }));
        mlog!("control session {}: browser {}, Office {:?}, {} folder(s)", slug, if chrome { "on" } else { "off" }, extras.office, roots.len());
        let mut envs: Vec<(String, String)> = Vec::new();
        match &info.git_bash {
            Some(b) => envs.push(("CLAUDE_CODE_GIT_BASH_PATH".into(), b.clone())),
            None => envs.push(("CLAUDE_CODE_USE_POWERSHELL_TOOL".into(), "1".into())),
        }
        let cwd = if docs.is_dir() { docs } else { profile };
        mlog!("control session {}: starting Claude Code ({}), session {}", slug, exe, session_id);
        let sp = match runner::spawn(&info.program, &args, &cwd, &envs) {
            Ok(s) => s,
            Err(e) => {
                srv.stop();
                return self.fail_start(&slug, Some(&lease_id), &format!("could not start Claude Code ({}): {}", exe, e));
            }
        };
        // Ready = the CLI answered `initialize`; until then an exit (or a hang) is a start failure.
        let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stderr_first: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let stderr_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let proc = Arc::new(sp.proc);
        {
            let mut st = self.st.lock().unwrap();
            // Stopped while it was starting: nothing is kept.
            if !(st.lease.active(now_ms()) && st.lease.current().map(|a| a.id == lease_id).unwrap_or(false)) {
                drop(st);
                proc.kill();
                srv.stop();
                self.send(wire::session(&slug, "exited", Some("stopped while starting")));
                return;
            }
            st.run = Some(Run { lease_id: lease_id.clone(), proc: proc.clone(), mcp: srv });
        }
        let stream = Arc::new(Mutex::new(claude::Stream::new(crate::hands::SERVER_NAME)));
        // stdout: the conversation.
        {
            let (me, proc, stream, lease_id, slug, ready) = (self.clone(), proc.clone(), stream.clone(), lease_id.clone(), slug.clone(), ready.clone());
            let first = if first_prompt.trim().is_empty() { purpose.clone() } else { first_prompt };
            let stdout = sp.stdout;
            std::thread::spawn(move || {
                let r = std::io::BufReader::new(stdout);
                for line in r.lines() {
                    let Ok(line) = line else { break };
                    let effects = stream.lock().unwrap().on_line(&line);
                    for e in effects {
                        if matches!(e, claude::Effect::Initialized) {
                            ready.store(true, Ordering::SeqCst);
                            mlog!("control session {}: Claude Code is ready", slug);
                        }
                        me.on_effect(e, &proc, &stream, &lease_id, &slug, &first);
                    }
                }
            });
        }
        // stderr: to the log, briefly (never the arguments: they hold the hands' secret). Its first
        // line is kept: when the CLI ends while starting, that is usually why (not signed in ...).
        {
            let stderr = sp.stderr;
            let (slug, first, done) = (slug.clone(), stderr_first.clone(), stderr_done.clone());
            std::thread::spawn(move || {
                let r = std::io::BufReader::new(stderr);
                for (n, line) in r.lines().enumerate() {
                    let Ok(line) = line else { break };
                    if n < 50 {
                        mlog!("claude ({}) stderr: {}", slug, line.chars().take(300).collect::<String>());
                    }
                    let mut f = first.lock().unwrap();
                    if f.is_none() && !line.trim().is_empty() {
                        *f = Some(line.chars().take(300).collect());
                    }
                }
                done.store(true, Ordering::SeqCst);
            });
        }
        // The exit.
        {
            let (me, proc, lease_id, slug, ready) = (self.clone(), proc.clone(), lease_id.clone(), slug.clone(), ready.clone());
            let (first, done) = (stderr_first.clone(), stderr_done.clone());
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(300));
                if let Some(code) = proc.exited() {
                    let killed = proc.killed();
                    mlog!("control session {}: Claude Code exited (code {}{})", slug, code, if killed { ", stopped" } else { "" });
                    if !killed && !ready.load(Ordering::SeqCst) {
                        // Ended before it was ready: a start failure, with what it said.
                        let t0 = Instant::now();
                        while !done.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_millis(1500) {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        let said = first.lock().unwrap().clone();
                        me.fail_start(&slug, Some(&lease_id), &wire::early_exit_reason(code, said.as_deref()));
                        break;
                    }
                    me.finish(|l| l.end_if(&lease_id, "runner-exited"));
                    if killed || code == 0 {
                        me.send(wire::session(&slug, "exited", None));
                    } else {
                        me.send(wire::session(&slug, "failed", Some(&format!("Claude Code exited with code {}", code))));
                    }
                    break;
                }
            });
        }
        // Not ready in time: ended as a start failure (the server has its own, longer, limit).
        {
            let (me, proc, lease_id, slug, ready) = (self.clone(), proc.clone(), lease_id.clone(), slug.clone(), ready.clone());
            std::thread::spawn(move || {
                let t0 = Instant::now();
                while t0.elapsed() < Duration::from_secs(wire::START_TIMEOUT_SECS) {
                    if ready.load(Ordering::SeqCst) || proc.exited().is_some() || !me.lease_active_id(&lease_id) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                if !ready.load(Ordering::SeqCst) && proc.exited().is_none() && me.lease_active_id(&lease_id) {
                    // Reported first; ending the lease kills the CLI (the exit watcher then sees it stopped).
                    me.fail_start(&slug, Some(&lease_id), &wire::start_timeout_reason());
                }
            });
        }
        proc.send(&claude::initialize());
    }

    #[allow(clippy::too_many_arguments)]
    fn on_effect(self: &Arc<Self>, e: claude::Effect, proc: &Arc<runner::Proc>, stream: &Arc<Mutex<claude::Stream>>, lease_id: &str, slug: &str, first: &str) {
        match e {
            claude::Effect::Initialized => {
                self.send(wire::session(slug, "running", None));
                proc.send(&claude::user_message(first));
            }
            claude::Effect::Unsupported { request_id } => {
                proc.send(&claude::unsupported(&request_id));
            }
            claude::Effect::Ask { request_id, tool, input, tool_use_id, reason, hint, refuse } => {
                if !self.lease_active_id(lease_id) {
                    proc.send(&claude::deny(&request_id, "No active control lease: the user has not handed over control (or it ended). Stop and report."));
                    return;
                }
                if let Some(why) = refuse {
                    // Never, whatever anyone would answer (a password or card field, Joya's own page).
                    if let Some(t) = &tool_use_id {
                        stream.lock().unwrap().note_decision(t, "denied");
                    }
                    let target = browser::summarize(&tool, &input, &browser::Tracker::new());
                    self.log_action(lease_id, slug, &wire::Act { tool: &tool, target: &target, decision: "refused", ok: false, detail: &why, kind: "browser" });
                    proc.send(&claude::deny(&request_id, &format!("{why} Do not try it another way.")));
                    return;
                }
                if !self.st.lock().unwrap().online {
                    proc.send(&claude::deny(&request_id, "Joya cannot be reached to ask the user, so it was denied. Do not retry it another way."));
                    return;
                }
                let rid = self.new_rid();
                let (tx, rx) = mpsc::channel();
                self.pending.lock().unwrap().insert(rid.clone(), Pending { tx, cli_request: Some(request_id.clone()) });
                let mut q = wire::ask(&rid, slug, &tool, &input, tool_use_id.as_deref(), reason.as_deref(), "cli");
                if let Some(h) = hint {
                    q["hint"] = h;
                }
                self.push(q, true);
                let (me, proc, stream, lease_id) = (self.clone(), proc.clone(), stream.clone(), lease_id.to_string());
                std::thread::spawn(move || {
                    let a = me.ask_wait(&rid, &rx);
                    let ok = a.as_ref().map(|a| a.allow).unwrap_or(false) && me.lease_active_id(&lease_id);
                    if let Some(t) = &tool_use_id {
                        let auto = a.as_ref().map(|a| a.auto).unwrap_or(false);
                        stream.lock().unwrap().note_decision(t, if !ok { "denied" } else if auto { "auto" } else { "approved" });
                    }
                    if ok {
                        proc.send(&claude::allow(&request_id, &input));
                    } else {
                        let why = match a {
                            Some(a) => a.message.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "The user denied it.".into()),
                            None => "Nobody answered the approval request in time (or control ended), so it was denied.".into(),
                        };
                        proc.send(&claude::deny(&request_id, &format!("{} Do not retry it another way; tell JOYA AI.", why)));
                    }
                });
            }
            claude::Effect::Cancel { request_id } => {
                let rid = {
                    let mut p = self.pending.lock().unwrap();
                    let rid = p.iter().find(|(_, v)| v.cli_request.as_deref() == Some(request_id.as_str())).map(|(k, _)| k.clone());
                    if let Some(r) = &rid {
                        p.remove(r);
                    }
                    rid
                };
                if let Some(r) = rid {
                    self.send(wire::cancel(&r));
                }
            }
            claude::Effect::Report { text, is_error } => {
                let text = if is_error && text.is_empty() { "The turn ended with an error.".to_string() } else { text };
                self.send(wire::report(slug, &text));
            }
            claude::Effect::Logged { tool, summary, decision, kind, ok, detail } => {
                self.log_action(lease_id, slug, &wire::Act { tool: &tool, target: &summary, decision: &decision, ok, detail: &detail, kind: &kind });
            }
            claude::Effect::Browser { connected, detail } => {
                let changed = {
                    let mut st = self.st.lock().unwrap();
                    let was = st.chrome_seen.as_ref().map(|s| s.connected);
                    st.chrome_seen = Some(browser::SeenState { connected, at: wire::iso(now_ms()), detail: detail.clone() });
                    was != Some(connected)
                };
                if changed {
                    mlog!("control session {}: Claude in Chrome {}", slug, if connected { "answered" } else { "is not connected" });
                    self.send(wire::browser_state(slug, connected, &detail, now_ms()));
                }
            }
        }
    }

    fn work_dir(&self) -> PathBuf {
        let docs = self.app.path().document_dir().unwrap_or_else(|_| PathBuf::from(env("USERPROFILE")).join("Documents"));
        docs.join("JOYA AI")
    }

    /* ---------------------------------------------------------- Claude Code */

    /// Find claude.exe / claude.cmd (the setting, PATH, the usual places), its version, Git Bash.
    /// Runs a program: never on the main thread.
    fn detect_claude(&self) {
        let s = self.settings();
        let exists = |p: &str| Path::new(p).is_file();
        let path_env = env("PATH");
        let cands = claude::candidates(&s.claude_path, &path_env, &env("USERPROFILE"), &env("APPDATA"));
        let found = claude::find(&cands, &exists);
        let extras = detect_extras();
        mlog!("this computer: Claude in Chrome {}, Office {:?}", extras.chrome.as_ref().map(|f| format!("in {} ({})", f.browser, f.profile)).unwrap_or_else(|| "not found".into()), extras.office);
        self.st.lock().unwrap().extras = extras;
        let mut info = ClaudeInfo { checked: true, ..ClaudeInfo::default() };
        if let Some(f) = found {
            let (program, pre) = runner::plan(&f, &exists, &path_env, &env("ProgramFiles"));
            info.version = runner::version(&program, &pre);
            info.path = Some(f);
            info.program = program;
            info.pre = pre;
        }
        let gb = claude::git_bash_candidates(&env("CLAUDE_CODE_GIT_BASH_PATH"), &env("ProgramFiles"), &env("ProgramFiles(x86)"), &env("LOCALAPPDATA"), &path_env);
        info.git_bash = claude::find(&gb, &exists);
        mlog!("claude code: {:?} version {:?}, git bash {}", info.path, info.version, info.git_bash.is_some());
        self.st.lock().unwrap().claude = info;
    }
}

/// The Claude in Chrome extension (in any Chromium browser profile) and the Office apps installed.
fn detect_extras() -> Extras {
    let dirs = browser::user_data_dirs(&env("LOCALAPPDATA"), &env("APPDATA"));
    let list = |p: &str| -> Vec<String> { std::fs::read_dir(p).map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default() };
    let exists = |p: &str| Path::new(p).is_dir();
    let chrome = browser::find_extension(&dirs, &list, &exists);
    use crate::hands::paths::Office;
    let office = [Office::Docx, Office::Xlsx, Office::Pptx].into_iter().filter(|k| crate::hands::office_com::installed(*k)).map(|k| k.app()).collect();
    Extras { chrome, office }
}

fn computer_name() -> String {
    let n = env("COMPUTERNAME");
    if n.is_empty() {
        "Windows computer".into()
    } else {
        n
    }
}

/* ------------------------------------------------------------- the hands */

struct MachineHost {
    ctl: Arc<Ctl>,
    lease_id: String,
    slug: String,
    work_dir: PathBuf,
    roots: Vec<crate::hands::paths::Root>,
    home: String,
}

impl crate::hands::Host for MachineHost {
    fn lease_active(&self) -> bool {
        self.ctl.lease_active_id(&self.lease_id)
    }
    fn approve(&self, tool: &str, summary: &str, why: &str) -> bool {
        self.ctl.approve_blocking(&self.lease_id, &self.slug, tool, summary, why, &[])
    }
    fn approve_deletes(&self, tool: &str, summary: &str, why: &str, delete_paths: &[String]) -> bool {
        self.ctl.approve_blocking(&self.lease_id, &self.slug, tool, summary, why, delete_paths)
    }
    fn log_action(&self, tool: &str, target: &str, decision: &str, ok: bool, detail: &str) {
        let tool = format!("mcp__{}__{}", crate::hands::SERVER_NAME, tool);
        self.ctl.log_action(&self.lease_id, &self.slug, &wire::Act { tool: &tool, target, decision, ok, detail, kind: "hands" });
    }
    fn work_dir(&self) -> PathBuf {
        self.work_dir.clone()
    }
    fn home(&self) -> String {
        self.home.clone()
    }
    fn roots(&self) -> Vec<crate::hands::paths::Root> {
        self.roots.clone()
    }
    fn contain(&self, child: &std::process::Child) -> bool {
        // Only this lease's session: when it has ended there is nothing to tie the helper to.
        let st = self.ctl.st.lock().unwrap();
        st.lease.active(now_ms()) && st.lease.current().map(|a| a.id == self.lease_id).unwrap_or(false) && st.run.as_ref().map(|r| r.proc.contain(child)).unwrap_or(false)
    }
}

struct HandsTools {
    host: Arc<MachineHost>,
}

impl mcp_http::Tools for HandsTools {
    fn list(&self) -> Vec<Value> {
        crate::hands::tool_defs()
    }
    fn call(&self, name: &str, args: &Value) -> (Vec<Value>, bool) {
        use crate::hands::Host;
        if !self.host.lease_active() {
            return (vec![json!({"type":"text","text":"No active control lease: the user has not handed over control (or it ended)."})], true);
        }
        let r = crate::hands::call(name, args, self.host.as_ref());
        (r.content, r.is_error)
    }
}

/* ------------------------------------------------- commands: Settings window */

#[derive(Serialize)]
pub struct LeaseView {
    slug: String,
    left: String,
}

#[derive(Serialize)]
pub struct ClaudeView {
    checked: bool,
    path: Option<String>,
    version: Option<String>,
    git_bash: bool,
}

#[derive(Serialize)]
pub struct Status {
    linked: bool,
    online: bool,
    name: String,
    server: String,
    computer: String,
    lease: Option<LeaseView>,
    claude: ClaudeView,
    stop_key: String,
    stop_fallback: bool,
    error: String,
    /// "Chrome (Default)" when the Claude in Chrome extension is found, else None.
    chrome: Option<String>,
    /// The Office apps installed.
    office: Vec<&'static str>,
}

fn status_of(c: &Ctl) -> Status {
    let server = c.host();
    let st = c.st.lock().unwrap();
    let now = now_ms();
    Status {
        linked: st.linked,
        online: st.online,
        name: st.name.clone(),
        server,
        computer: computer_name(),
        lease: st.lease.current().filter(|_| st.lease.active(now)).map(|a| LeaseView { slug: a.slug.clone(), left: lease::mmss(st.lease.remaining_ms(now)) }),
        claude: ClaudeView { checked: st.claude.checked, path: st.claude.path.clone(), version: st.claude.version.clone(), git_bash: st.claude.git_bash.is_some() },
        stop_key: st.stop_key.clone(),
        stop_fallback: st.stop_fallback,
        error: st.error.clone(),
        chrome: st.extras.chrome.as_ref().map(|f| format!("{} ({})", f.browser, f.profile)),
        office: st.extras.office.clone(),
    }
}

#[tauri::command]
pub fn machine_status() -> Result<Status, String> {
    ctl().map(|c| status_of(&c)).ok_or_else(|| "not ready".into())
}

/// Pair this computer: the one-time code from Joya -> a machine token, into Credential Manager.
#[tauri::command]
pub async fn machine_link(code: String, name: String) -> Result<Status, String> {
    let c = ctl().ok_or("not ready")?;
    let code = wire::normalize_code(&code).ok_or("That is not a pairing code: 8 letters and digits, like ABCD-EFGH.")?;
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect::<String>().trim().to_string();
    let name = if name.is_empty() { computer_name() } else { name };
    let origin = c.origin();
    let url = origin.join("/machines/api/claim").map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder().user_agent(crate::site::user_agent()).timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let resp = client.post(url).json(&json!({ "code": code, "name": name, "platform": "windows", "app_version": crate::VERSION })).send().await.map_err(|e| format!("Could not reach Joya: {}", e))?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(json!({}));
    if status != 200 {
        let said = body.get("error").and_then(|e| e.as_str()).map(|s| wire::clip(s, 200)).unwrap_or_default();
        let msg = match status {
            400 => "That code is not valid.",
            404 => "No such code: check it, or make a new one in Joya.",
            410 => "That code has expired or was used: make a new one in Joya.",
            429 => "Too many tries: wait a minute, then try again.",
            _ => "Joya refused the code.",
        };
        return Err(if said.is_empty() { msg.to_string() } else { format!("{} ({})", msg, said) });
    }
    let token = body.get("token").and_then(|t| t.as_str()).unwrap_or("");
    if token.is_empty() || token.len() > 4096 || !token.chars().all(|ch| ch.is_ascii_graphic()) {
        return Err("Joya answered without a usable token.".into());
    }
    cred::write(origin.host_str().unwrap_or(""), token).map_err(|e| format!("Could not save the token in Windows Credential Manager: {}", e))?;
    {
        let mut st = c.st.lock().unwrap();
        st.linked = true;
        st.name = body.get("name").and_then(|n| n.as_str()).unwrap_or(&name).to_string();
        st.machine_id = body.get("machine_id").and_then(|n| n.as_str()).unwrap_or("").to_string();
        st.error.clear();
    }
    mlog!("machine: linked to {} as {:?}", origin.host_str().unwrap_or(""), c.st.lock().unwrap().name);
    c.relink();
    Ok(status_of(&c))
}

/// Unlink: end any lease, forget the token (Joya shows the computer offline; revoke it there too).
#[tauri::command]
pub fn machine_unlink() -> Result<Status, String> {
    let c = ctl().ok_or("not ready")?;
    c.end_lease("unlinked");
    cred::delete(&c.host());
    {
        let mut st = c.st.lock().unwrap();
        st.linked = false;
        st.name.clear();
        st.machine_id.clear();
        st.error.clear();
    }
    c.relink();
    mlog!("machine: unlinked");
    Ok(status_of(&c))
}

/// Look for Claude Code again (after installing it, or changing the path).
#[tauri::command]
pub async fn machine_claude_check() -> Result<Status, String> {
    let c = ctl().ok_or("not ready")?;
    let c2 = c.clone();
    // A change (installed now, another version) reaches Joya at once: the Computers page and
    // machine_take_over read it from there.
    let _ = tauri::async_runtime::spawn_blocking(move || c2.recheck_claude()).await;
    Ok(status_of(&c))
}

/* ---------------------------------- the pill (overlay.rs draws it natively since 0.1.7) */

pub struct PillView {
    active: bool,
    left: String,
    stop_key: String,
    /// The last action, in one short line ("" before the first).
    last: String,
}

pub fn machine_pill() -> PillView {
    let Some(c) = ctl() else { return PillView { active: false, left: String::new(), stop_key: String::new(), last: String::new() } };
    let st = c.st.lock().unwrap();
    let now = now_ms();
    PillView { active: st.lease.active(now), left: lease::mmss(st.lease.remaining_ms(now)), stop_key: st.stop_key.clone(), last: st.last_action.clone() }
}

/// The same for the pill's own drawing on the main thread: never waits for the state lock (a thread
/// holding it may be waiting for the main thread), None when it is busy -- that second is skipped.
pub fn machine_pill_now() -> Option<PillView> {
    let Some(c) = ctl() else { return Some(PillView { active: false, left: String::new(), stop_key: String::new(), last: String::new() }) };
    let st = c.st.try_lock().ok()?;
    let now = now_ms();
    Some(PillView { active: st.lease.active(now), left: lease::mmss(st.lease.remaining_ms(now)), stop_key: st.stop_key.clone(), last: st.last_action.clone() })
}

/// "+15 min": extended here, then the server is told.
pub fn machine_pill_extend() -> PillView {
    if let Some(c) = ctl() {
        let r = {
            let mut st = c.st.lock().unwrap();
            let id = st.lease.current().map(|a| a.id.clone());
            st.lease.extend_step(now_ms()).zip(id)
        };
        if let Some((e, id)) = r {
            mlog!("control lease {} extended from the pill", id);
            c.send(wire::lease(&id, "extended", Some(e), None));
        }
    }
    machine_pill()
}

pub fn machine_pill_stop() {
    if let Some(c) = ctl() {
        c.end_lease("pill-stop");
    }
}
