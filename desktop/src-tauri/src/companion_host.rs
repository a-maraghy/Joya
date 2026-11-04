//! Companion mode in the app (companion.rs; simplified 2026-10-21): the loop that reads which monitor you are
//! working on (platform.rs), keeps the bot's small topmost window at the top centre of it, fades it across
//! when you switch monitors (joya://companion: fade-out / fade-in), ducks it out of full-screen video and
//! games (duck / pop) and keeps it on top of every app. The page draws the bot and reports its hit region.
//!
//! The rules of lib.rs hold here too: Windows is read straight from this thread; every window change that
//! needs the app goes to the main thread (on_main) without waiting; the Shared lock is never held across
//! an AppHandle / window call.
//!
//! The acrylic blur stays off in this mode (lib.rs blur_glass): the bot has its own backplate, and a blur
//! window must never move while shown (0.1.10) -- this one moves between monitors.

use super::*;
use crate::companion::{self as cp, Switch, SwitchOut};
use serde_json::json;

/// The bot's state in the app (App::comp).
#[derive(Default)]
pub struct CompState {
    /// The monitor it is on and its window's rectangle there (0 / None: not placed yet).
    pub monitor: isize,
    pub at: Option<Rect>,
    pub switch: Switch,
    /// Ducked out (hidden) and why; and a duck under way (the page fades, the window hides after).
    pub ducked: Option<String>,
    pub duck_at: Option<u64>,
    pub duck_why: Option<String>,
}

impl CompState {
    pub fn reset(&mut self) {
        *self = CompState::default();
        set_anchor(None);
    }
}

/* Where the window is, for monitor_for() without the lock (its rule: no lock across app calls). */
static ANCHOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);
fn set_anchor(p: Option<(i32, i32)>) {
    if let Ok(mut a) = ANCHOR.lock() {
        *a = p;
    }
}
/// The point the companion window is centred on (None: not placed yet).
pub fn anchor() -> Option<(i32, i32)> {
    ANCHOR.lock().ok().and_then(|a| *a)
}

/// The companion window's rectangle (apply()): where the loop placed it, or -- before that -- the top centre
/// of this monitor's work area.
pub fn rect(a: &App, work: Rect, scale: f64) -> Rect {
    a.comp.at.unwrap_or_else(|| cp::window_rect(&cp::Monitor { id: 0, rect: work, work, scale }))
}

/// What the page is told about the companion with its state (PageState::companion).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub stay_on_monitor: bool,
    pub ducked: bool,
}

pub fn view(a: &App) -> Option<View> {
    if a.settings.mode != Mode::Companion {
        return None;
    }
    Some(View { stay_on_monitor: a.settings.companion.stay_on_monitor, ducked: a.comp.ducked.is_some() })
}

/// The page's own word (command `companion`): "open" the Command Center (a click on the bot). Anything else
/// (the 0.1.12 page's "doze" / "wake") is ignored.
pub fn page_says(app: &AppHandle, shared: &Shared, kind: &str) {
    if kind != "open" {
        return;
    }
    {
        let mut a = shared.lock().unwrap();
        if a.settings.mode != Mode::Companion {
            return;
        }
        a.peek_open = true;
        a.ignoring = None;
    }
    apply(app, shared, true);
}

fn emit(app: &AppHandle, kind: &'static str) {
    let h = app.clone();
    on_main(app, move |_| {
        let _ = h.emit_to(MAIN, "joya://companion", json!({ "kind": kind }));
    });
}

/// Place the window (main thread): position, size (a monitor of another DPI), position again (Windows may
/// have moved it while it took the new monitor's DPI); then on top of everything.
fn place(app: &AppHandle, r: Rect) {
    on_main(app, move |app| {
        if let Some(win) = main_window(app) {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(r.x, r.y)));
            let _ = win.set_size(WSize::Physical(PhysicalSize::new(r.w, r.h)));
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(r.x, r.y)));
            let _ = win.set_always_on_top(true);
        }
    });
}

/// What Windows says about the monitors and the window in front, every quarter second.
#[derive(Default)]
struct Env {
    mons: Vec<cp::Monitor>,
    front: Option<cp::Front>,
    fg: Option<policy::FrontWin>,
    quns: Option<policy::Quns>,
    at_ms: u64,
}

fn read_env(raw: isize, now: u64) -> Env {
    let fg = platform::front_window(raw);
    let front = fg.as_ref().map(|f| cp::Front { hwnd: f.hwnd, monitor: f.monitor, app: f.is_app(), fullscreen: f.covers(f.monitor) });
    Env { mons: platform::monitors(), front, fg, quns: Some(platform::quns()), at_ms: now }
}

/// The loop: 6-7 times a second; twice holding still, once a second ducked out, idle in the other modes.
pub fn run(app: AppHandle, shared: Shared) {
    let t0 = Instant::now();
    let now_ms = move || t0.elapsed().as_millis() as u64;
    let mut raw: isize = 0;
    let mut env = Env::default();
    let mut was_on = false;
    let mut top = (0isize, 0u64);
    loop {
        let now = now_ms();
        let snap = {
            let Ok(a) = shared.try_lock() else {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            };
            (a.settings.mode, a.peek_open, a.still, a.settings.companion.stay_on_monitor, a.seen.locked, a.ceremony)
        };
        let (mode, peek_open, still, stay, locked, ceremony) = snap;
        if mode != Mode::Companion {
            if was_on {
                shared.lock().unwrap().comp.reset();
                was_on = false;
            }
            std::thread::sleep(Duration::from_millis(400));
            continue;
        }
        was_on = true;
        if raw == 0 {
            raw = main_window(&app).map(|w| hwnd(&w)).unwrap_or(0);
            if raw == 0 && cfg!(windows) {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
        }
        // Peek open (a click on the bot), or Windows Hello asking: nothing moves.
        if peek_open || ceremony {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        if now.saturating_sub(env.at_ms) >= 250 {
            env = read_env(raw, now);
        }
        let current = shared.lock().unwrap().comp.monitor;
        let bot_monitor = if current != 0 { current } else { platform::monitor_of(raw) };
        // Full screen on its monitor (a video, a game, presentation mode) or the lock screen: it ducks out.
        let fs = env.quns.and_then(|q| policy::fullscreen_hold(q, env.fg.as_ref(), bot_monitor));
        if duck_step(&app, &shared, now, cp::duck(fs.as_deref(), locked)) {
            std::thread::sleep(Duration::from_millis(cp::period_ms(still, true)));
            continue;
        }
        let stay_on = if stay { Some(bot_monitor) } else { None };
        let Some(mon) = cp::pick_monitor(&env.mons, env.front.as_ref(), platform::cursor(), stay_on, bot_monitor).copied() else {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        };
        let at = shared.lock().unwrap().comp.at;
        match at {
            // The first placement: straight there.
            None => put(&app, &shared, &mon, "placed"),
            Some(r) if mon.id == current => {
                // The same monitor, but its work area or DPI changed (a taskbar moved, the scale changed): follow.
                if cp::window_rect(&mon) != r && !shared.lock().unwrap().comp.switch.fading() {
                    put(&app, &shared, &mon, "its monitor changed");
                }
                let _ = shared.lock().unwrap().comp.switch.tick(now, current, current, still);
            }
            Some(_) => {
                let out = shared.lock().unwrap().comp.switch.tick(now, current, mon.id, still);
                match out {
                    SwitchOut::FadeOut(_) => emit(&app, "fade-out"),
                    SwitchOut::Place(id) => {
                        if let Some(m) = env.mons.iter().find(|m| m.id == id).copied() {
                            put(&app, &shared, &m, "the active monitor changed");
                        }
                        emit(&app, "fade-in");
                    }
                    SwitchOut::Nothing => {}
                }
            }
        }
        // On top of every app: again whenever the window in front changes, and every few seconds.
        let fg = env.fg.as_ref().map(|f| f.hwnd).unwrap_or(0);
        if fg != top.0 || now.saturating_sub(top.1) >= cp::TOPMOST_MS {
            platform::to_top(raw);
            top = (fg, now);
        }
        std::thread::sleep(Duration::from_millis(cp::period_ms(still, false)));
    }
}

/// Put the window at the top centre of a monitor (recorded first, then placed on the main thread).
fn put(app: &AppHandle, shared: &Shared, mon: &cp::Monitor, why: &str) {
    let r = cp::window_rect(mon);
    {
        let mut a = shared.lock().unwrap();
        a.comp.monitor = mon.id;
        a.comp.at = Some(r);
    }
    set_anchor(Some(r.centre()));
    mlog!("companion: {}: top centre of monitor {:#x} at {:?} ({}x)", why, mon.id, (r.x, r.y, r.w, r.h), mon.scale);
    place(app, r);
}

/// Ducking out and coming back. Returns whether it is ducked out (or going): then nothing else moves.
fn duck_step(app: &AppHandle, shared: &Shared, now: u64, why: Option<String>) -> bool {
    let (ducked, duck_at) = {
        let a = shared.lock().unwrap();
        (a.comp.ducked.is_some(), a.comp.duck_at)
    };
    match (why, ducked, duck_at) {
        // Something came up: the page fades out, the window hides a moment later.
        (Some(w), false, None) => {
            mlog!("companion: ducks out: {}", w);
            {
                let mut a = shared.lock().unwrap();
                a.comp.duck_at = Some(now + cp::FADE_MS + 40);
                a.comp.duck_why = Some(w);
            }
            emit(app, "duck");
            true
        }
        (Some(_), false, Some(t)) => {
            if now >= t {
                {
                    let mut a = shared.lock().unwrap();
                    a.comp.ducked = a.comp.duck_why.take().or(Some("ducked".into()));
                    a.comp.duck_at = None;
                }
                let sh = shared.clone();
                on_main(app, move |app| apply(app, &sh, false));
            }
            true
        }
        (Some(_), true, _) => true,
        // Over (or it went away before the window hid): back, fading in.
        (None, true, _) | (None, false, Some(_)) => {
            mlog!("companion: back");
            {
                let mut a = shared.lock().unwrap();
                a.comp.ducked = None;
                a.comp.duck_at = None;
                a.comp.duck_why = None;
            }
            let sh = shared.clone();
            on_main(app, move |app| apply(app, &sh, false));
            emit(app, "pop");
            false
        }
        (None, false, None) => false,
    }
}
