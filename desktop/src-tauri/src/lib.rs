//! JOYA AI on the Windows desktop (design: Joya/mockups/desktop-app/DESIGN.md).
//!
//! One transparent, frameless window shows the real Command Center in its
//! desktop render mode (https://joya.example.com/joya-ai?shell=desktop), so the
//! core, the sessions, the chat, the voice and the approval cards are the
//! site's own, and sign-in is the site's (password, then Windows Hello). This
//! process adds only what a web page cannot do:
//!   - the modes: Floating (a box in a corner, on top), Peek (hidden until
//!     called, then on top), Desktop layer (at the bottom of the window stack,
//!     above the icons; behind the icons only as an Experimental switch), and
//!     Companion (the bot alone, at the top centre of the monitor you are working on, on top of every app:
//!     companion.rs, companion_host.rs);
//!   - per-pixel click-through (hit.rs), from the regions the page reports;
//!   - global hotkeys, remappable: hold Ctrl+Space to talk, Ctrl+Alt+M show /
//!     hide, Ctrl+Alt+F focus mode (Esc is the page's, when it has focus);
//!   - the tray icon and menu, Windows toasts (Open / Deny, never Approve),
//!     battery saver, several monitors, autostart, one instance, updates;
//!   - the browser hand-off for signing in when Windows Hello cannot show here.
//!
//! The page talks to this process through a fixed list of commands
//! (capabilities/remote.json); none can run a program or read a file. The
//! webview is locked to the site: any other address opens in the browser.

#[macro_use]
pub mod log;
pub mod acrylic;
pub mod blur;
pub mod companion;
pub mod companion_host;
pub mod hands;
pub mod hit;
pub mod layout;
pub mod machine; // laptop control: the paired link, the lease, the CLI runner (machine/mod.rs)
pub mod platform;
pub mod policy;
pub mod presence; // eye contact: camera presence, the permission policy (presence.rs)
pub mod settings;
pub mod signin;
pub mod site;
pub mod trayicon;

use hit::Region;
use layout::{Corner, Mode, Rect};
use platform::{Front, Ink};
use serde::Serialize;
use settings::{Pin, Settings};
use site::{same_site, user_agent};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size as WSize, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub use site::VERSION;
const MAIN: &str = "joya";
const SETTINGS_WIN: &str = "settings";

/* ------------------------------------------------------------------ state */

pub struct App {
    pub settings: Settings,
    settings_path: PathBuf,
    regions: Vec<Region>,
    dpr: f64,
    /// Peek is showing (in Desktop layer: raised on top for a moment).
    peek_open: bool,
    /// Floating put away with its tool; the tray or Ctrl+Alt+M brings it back.
    hidden: bool,
    state: String,
    needs: u32,
    sessions: u32,
    ink: Ink,
    still: bool,
    talk_key: String,
    talk_fallback: bool,
    /// The live-call hotkey as registered ("" when it could not be), and whether it is the fallback.
    live_key: String,
    live_fallback: bool,
    talking: bool,
    /// The talk key's events, numbered (the page drops one older than one it has seen), and when it went down.
    key_seq: u64,
    pressed_at: Option<Instant>,
    signed_in: bool,
    behind_icons: bool,
    raised_for_desktop: bool,
    /// A passkey / Windows Hello sign-in is in progress (the page said so): the window is a normal,
    /// focusable, clickable window on top until it ends.
    ceremony: bool,
    ignoring: Option<bool>,
    dragging: Option<Instant>,
    last_moved: Option<Instant>,
    awaiting_ready: Option<Instant>,
    update: Option<String>,
    monitors_sig: String,
    /// The last full-screen decision logged (policy::fullscreen_note): logged once per change.
    fullscreen_note: String,
    wallpaper_sig: String,
    seen: policy::Seen,
    toasted: Vec<i64>,
    /// Companion mode: where the bot is and what it is doing (companion_host.rs).
    comp: companion_host::CompState,
    /// Eye contact (presence.rs): the page says the camera is open; when the setting went off; another app's
    /// meeting; the power state (the page lets go of the camera in energy saver, looks less often on battery).
    cam_in_use: bool,
    cam_off_at: Option<Instant>,
    meeting: bool,
    on_battery: bool,
    energy_saver: bool,
}

type Shared = Arc<Mutex<App>>;

fn origin(s: &Settings) -> Url {
    Url::parse(&s.origin).unwrap_or_else(|_| Url::parse(settings::DEFAULT_ORIGIN).unwrap())
}


/* ------------------------------------------------------------- the payloads */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PageState {
    mode: &'static str,
    focus: bool,
    size: &'static str,
    pos: &'static str,
    ink: &'static str,
    opacity: u8,
    still: bool,
    peek_open: bool,
    talk_key: String,
    live_key: String,
    hidden: bool,
    focus_composer: bool,
    /// Real blur is drawn behind the page's glass surfaces: the page uses its lighter glass tints (blur.rs).
    glass: bool,
    /// The glance cards beside the core are on (the setting; focus mode hides them on the page).
    glance: bool,
    /// Where they were pinned on this monitor (Desktop layer), as fractions of the work area; None: beside the core.
    glance_pin: Option<Pin>,
    /// Companion mode: its settings and how the bot stands (None in the other modes).
    companion: Option<companion_host::View>,
    /// Eye contact: camera presence's switches and what decides whether the page may hold the camera now.
    presence: presence::View,
}

fn page_state(a: &App, monitor: &str, focus_composer: bool) -> PageState {
    let pm = a.settings.monitor_prefs(monitor);
    let pos = match a.settings.mode {
        Mode::Floating => match pm.corner {
            Corner::Tl => "tl",
            Corner::Tr => "tr",
            Corner::Bl => "bl",
            Corner::Br => "br",
        },
        Mode::Desktop => pm.across.as_str(),
        Mode::Peek | Mode::Companion => "centre",
    };
    PageState {
        mode: a.settings.mode.as_str(),
        focus: a.settings.focus,
        size: pm.size.as_str(),
        pos,
        ink: a.ink.as_str(),
        opacity: pm.opacity,
        still: a.still,
        // A raised Desktop layer is not Peek's dimmed overlay: the page only needs to know Peek's.
        peek_open: a.peek_open && matches!(a.settings.mode, Mode::Peek | Mode::Companion),
        talk_key: a.talk_key.clone(),
        live_key: a.live_key.clone(),
        hidden: a.hidden,
        focus_composer,
        glass: blur_glass(a, pm.opacity),
        glance: a.settings.glance,
        glance_pin: if a.settings.mode == Mode::Desktop { pm.glance_pin } else { None },
        companion: companion_host::view(a),
        presence: presence_view(a),
    }
}

/// Eye contact: what the page is told (presence.rs).
fn presence_view(a: &App) -> presence::View {
    presence::view(&a.settings.presence, a.on_battery, a.energy_saver, a.seen.locked, a.meeting, a.cam_in_use)
}

/// Eye contact: the WebView2 profile's stored camera permission for the site follows the setting -- Deny while
/// it is off (a decision WebView2 kept could never open the camera), Default while it is on (the request is
/// raised, and on_permission_request answers it). And every camera request is answered for this time only
/// (SavesInProfile false), so no grant outlives the setting.
#[cfg(windows)]
fn camera_profile(app: &AppHandle, shared: &Shared) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_STATE_DEFAULT, COREWEBVIEW2_PERMISSION_STATE_DENY};
    use windows_core::Interface;
    let Some(w) = main_window(app) else { return };
    let (on, origin) = {
        let a = shared.lock().unwrap();
        (a.settings.presence.camera, origin(&a.settings).origin().ascii_serialization())
    };
    let _ = w.with_webview(move |pw| unsafe {
        let r: windows_core::Result<()> = (|| {
            let core = pw.controller().CoreWebView2()?;
            let profile = core.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile4>()?;
            let st = match presence::profile_state(on) {
                presence::ProfilePerm::Default => COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                presence::ProfilePerm::Deny => COREWEBVIEW2_PERMISSION_STATE_DENY,
            };
            let o = windows_core::HSTRING::from(origin.as_str());
            profile.SetPermissionState(COREWEBVIEW2_PERMISSION_KIND_CAMERA, &o, st, &webview2_com::SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(()))))?;
            Ok(())
        })();
        mlog!("camera presence: the profile's camera permission for {} set to {} ({})", origin, if on { "default" } else { "deny" }, if r.is_ok() { "ok" } else { "failed" });
    });
}
#[cfg(not(windows))]
fn camera_profile(_app: &AppHandle, _shared: &Shared) {}

/// Eye contact: a camera request is never kept in the profile (registered once, after wry's own handler, which
/// has set the answer by then).
#[cfg(windows)]
fn camera_once(w: &WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2PermissionRequestedEventArgs3, COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA};
    use windows_core::Interface;
    let _ = w.with_webview(|pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(
            &webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                    if let Ok(a3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                        let _ = a3.SetSavesInProfile(false);
                    }
                }
                Ok(())
            })),
            &mut token,
        );
    });
}
#[cfg(not(windows))]
fn camera_once(_w: &WebviewWindow) {}

/// Eye contact: the setting changed (the tray, the Settings window, the page switching it off).
fn presence_changed(app: &AppHandle, shared: &Shared, was_on: bool) {
    let on = {
        let mut a = shared.lock().unwrap();
        let on = a.settings.presence.camera;
        if was_on && !on {
            a.cam_off_at = Some(Instant::now());
        }
        if on {
            a.cam_off_at = None;
        }
        on
    };
    mlog!("camera presence {}", if on { "on" } else { "off" });
    save(shared);
    camera_profile(app, shared);
    let key = current_monitor_key(app, shared);
    let payload = page_state(&shared.lock().unwrap(), &key, false);
    let _ = app.emit_to(MAIN, "joya://state", payload);
    refresh_tray(app, shared);
}

/// The Floating window is widened for the glance column only while the cards can show: the setting on
/// and someone signed in (the sign-in card needs no room beside it).
fn glance_room(a: &App) -> bool {
    a.settings.glance && a.signed_in
}

/* --------------------------------------------------------------- monitors */

struct Mon {
    key: String,
    work: Rect,
    scale: f64,
}

fn mon_of(m: &tauri::Monitor) -> Mon {
    let wa = m.work_area();
    let name = m.name().cloned().unwrap_or_else(|| "display".into());
    Mon {
        key: format!("{} {}x{}", name, m.size().width, m.size().height),
        work: Rect { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height },
        scale: m.scale_factor(),
    }
}

/// The monitor JOYA AI lives on: the chosen one if it is still there, else the primary.
/// Peek opens on the monitor the mouse is on.
///
/// RULE (the 0.1.0 freeze): never call this -- or any AppHandle / window / menu method -- while
/// holding the `Shared` lock. Those calls are answered by the main thread; the main thread takes the
/// same lock in commands and in the navigation handler, so holding it there deadlocks the window
/// (it froze on the "Connecting" card while the site's first page had already arrived).
fn monitor_for(app: &AppHandle, settings: &Settings) -> Option<Mon> {
    // Companion: the monitor the bot is on (its Peek opens there too).
    if settings.mode == Mode::Companion {
        if let Some((x, y)) = companion_host::anchor() {
            if let Ok(Some(m)) = app.monitor_from_point(x as f64, y as f64) {
                return Some(mon_of(&m));
            }
        }
    }
    if settings.mode == Mode::Peek {
        if let Ok(c) = app.cursor_position() {
            if let Ok(Some(m)) = app.monitor_from_point(c.x, c.y) {
                return Some(mon_of(&m));
            }
        }
    }
    let all = app.available_monitors().unwrap_or_default();
    if !settings.monitor.is_empty() {
        if let Some(m) = all.iter().find(|m| m.name().map(|n| n == &settings.monitor).unwrap_or(false)) {
            return Some(mon_of(m));
        }
    }
    if let Ok(Some(m)) = app.primary_monitor() {
        return Some(mon_of(&m));
    }
    all.first().map(mon_of)
}

/* ----------------------------------------------------- placing the window */

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

/// Put the window where its mode says, at the right size and level, shown or not; tell the page.
fn apply(app: &AppHandle, shared: &Shared, focus_composer: bool) {
    let Some(w) = main_window(app) else { return };
    let snapshot = shared.lock().unwrap().settings.clone();
    let Some(m) = monitor_for(app, &snapshot) else { return };
    let (rect, mode, visible, on_top, key, payload, behind) = {
        let mut a = shared.lock().unwrap();
        let pm = a.settings.monitor_prefs(&m.key);
        let mode = a.settings.mode;
        // Companion: its small window where the bot is (companion_host), the work area while its Peek is open.
        let rect = if mode == Mode::Companion && !a.peek_open {
            companion_host::rect(&a, m.work, m.scale)
        } else {
            layout::window_rect(a.settings.mode, m.work, m.scale, pm.size, a.settings.focus, pm.corner, glance_room(&a))
        };
        let visible = match mode {
            Mode::Floating => !a.hidden,
            Mode::Peek => a.peek_open,
            Mode::Desktop => true,
            // Hidden only while it ducked out (a full-screen video or game on its monitor, the lock screen).
            Mode::Companion => a.peek_open || a.comp.ducked.is_none(),
        };
        // A Windows Hello sign-in in progress keeps it on top whatever the mode (webauthn_ceremony).
        let on_top = a.ceremony
            || match mode {
                Mode::Floating | Mode::Peek | Mode::Companion => true,
                Mode::Desktop => a.peek_open || a.raised_for_desktop,
            };
        let behind = mode == Mode::Desktop && a.settings.experimental_behind_icons && !a.peek_open;
        a.seen.mode = Some(mode);
        a.seen.peek_open = a.peek_open;
        a.seen.focus = a.settings.focus;
        a.seen.hidden = !visible;
        let payload = page_state(&a, &m.key, focus_composer);
        (rect, mode, visible, on_top, m.key, payload, behind)
    };
    let _ = key;
    let _ = w.set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)));
    let _ = w.set_size(WSize::Physical(PhysicalSize::new(rect.w, rect.h)));
    // Bottom of the stack (Desktop layer): Windows keeps it there (tao answers WM_WINDOWPOSCHANGING with HWND_BOTTOM).
    if on_top {
        let _ = w.set_always_on_bottom(false);
        let _ = w.set_always_on_top(true);
    } else {
        let _ = w.set_always_on_top(false);
        let _ = w.set_always_on_bottom(mode == Mode::Desktop);
    }
    behind_icons(&w, shared, behind);
    if visible {
        // Only when hidden: showing an already visible window would take the focus from whatever has it.
        if !w.is_visible().unwrap_or(false) {
            let _ = w.show();
        }
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        if focus_composer || (mode == Mode::Peek) || (mode == Mode::Companion && a_peek(shared)) {
            let _ = w.set_focus();
        }
    } else {
        let _ = w.hide();
    }
    let _ = w.emit_to(MAIN, "joya://state", payload);
    refresh_tray(app, shared);
}

fn a_peek(shared: &Shared) -> bool {
    shared.lock().unwrap().peek_open
}

/// Experimental: behind the desktop icons (platform::behind_icons). Nothing can be clicked there.
fn behind_icons(w: &WebviewWindow, shared: &Shared, on: bool) {
    let raw = hwnd(w);
    let was = shared.lock().unwrap().behind_icons;
    if on == was || raw == 0 {
        return;
    }
    if on {
        let ok = platform::behind_icons(raw);
        shared.lock().unwrap().behind_icons = ok;
        if ok {
            let _ = w.set_ignore_cursor_events(true);
        }
    } else {
        platform::leave_icons(raw);
        shared.lock().unwrap().behind_icons = false;
    }
}

#[cfg(windows)]
fn hwnd(w: &WebviewWindow) -> isize {
    w.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}
#[cfg(not(windows))]
fn hwnd(_w: &WebviewWindow) -> isize {
    0
}

fn current_monitor_key(app: &AppHandle, shared: &Shared) -> String {
    let snapshot = shared.lock().unwrap().settings.clone();
    monitor_for(app, &snapshot).map(|m| m.key).unwrap_or_default()
}

fn save(shared: &Shared) {
    let a = shared.lock().unwrap();
    if let Some(dir) = a.settings_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = a.settings_path.with_extension("json.tmp");
    if std::fs::write(&tmp, a.settings.to_json()).is_ok() {
        let _ = std::fs::rename(&tmp, &a.settings_path);
    }
}

/* ---------------------------------------------------------- show and hide */

/// Ctrl+Alt+M and the tray's "Show JOYA AI": Peek opens or closes; Floating comes back (or goes);
/// the Desktop layer is raised on top for a moment (Esc or a second press lowers it).
fn toggle_show(app: &AppHandle, shared: &Shared) {
    let focus = {
        let mut a = shared.lock().unwrap();
        match a.settings.mode {
            Mode::Peek | Mode::Desktop | Mode::Companion => {
                a.peek_open = !a.peek_open;
                a.peek_open
            }
            Mode::Floating => {
                a.hidden = !a.hidden;
                !a.hidden
            }
        }
    };
    apply(app, shared, focus);
}

/// Bring JOYA AI into view (a toast's Open, a second launch, a hotkey that needs it).
fn show(app: &AppHandle, shared: &Shared, focus_composer: bool) {
    {
        let mut a = shared.lock().unwrap();
        match a.settings.mode {
            Mode::Peek | Mode::Desktop | Mode::Companion => a.peek_open = true,
            Mode::Floating => a.hidden = false,
        }
    }
    apply(app, shared, focus_composer);
}

fn set_mode(app: &AppHandle, shared: &Shared, mode: Mode) {
    let was_visible = main_window(app).map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)).unwrap_or(true);
    let reveal = policy::reveal_after_mode_change(was_visible, mode);
    {
        let mut a = shared.lock().unwrap();
        if a.settings.mode != mode && (mode == Mode::Companion || a.settings.mode == Mode::Companion) {
            if mode == Mode::Companion {
                a.settings.before_companion = a.settings.mode;
            }
            a.comp.reset();
        }
        a.settings.mode = mode;
        a.peek_open = mode == Mode::Peek;
        a.hidden = false;
        a.ignoring = None;
        // From hidden: the Desktop layer comes up on top, as a press of the show key raises it; it goes
        // down to the bottom when another window takes the focus (env_loop).
        if reveal && mode == Mode::Desktop {
            a.raised_for_desktop = true;
        }
    }
    save(shared);
    apply(app, shared, mode == Mode::Peek);
    if reveal {
        if let Some(w) = main_window(app) {
            let _ = w.set_focus();
            mlog!("mode {:?} from a hidden window: shown and raised (visible now: {:?})", mode, w.is_visible());
        }
    }
}

fn toggle_focus(app: &AppHandle, shared: &Shared) {
    shared.lock().unwrap().settings.focus ^= true;
    save(shared);
    apply(app, shared, false);
}

/// The glance cards on or off (the tray, the button by the core, the cards' own hide): saved, and the
/// Floating window resized for them.
fn set_glance_on(app: &AppHandle, shared: &Shared, on: bool) {
    {
        let mut a = shared.lock().unwrap();
        if a.settings.glance == on {
            return;
        }
        a.settings.glance = on;
        a.ignoring = None;
    }
    save(shared);
    apply(app, shared, false);
}

/* -------------------------------------------------------------- hotkeys */

/// Register the three hotkeys. Ctrl+Space can be taken by another app (an input method, an editor):
/// then the talk key falls back to Ctrl+Alt+Space and the person is told.
fn register_hotkeys(app: &AppHandle, shared: &Shared) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let hk = shared.lock().unwrap().settings.hotkeys.clone();
    let mut talk = hk.talk.clone();
    let mut fallback = false;
    if gs.register(talk.as_str()).is_err() {
        if talk == settings::DEFAULT_TALK && gs.register(settings::FALLBACK_TALK).is_ok() {
            talk = settings::FALLBACK_TALK.into();
            fallback = true;
        } else {
            talk = String::new();
        }
    }
    let show_ok = gs.register(hk.show.as_str()).is_ok();
    let focus_ok = gs.register(hk.focus.as_str()).is_ok();
    // The live-call key: as the talk key, a taken default falls back to Ctrl+Alt+Shift+L (said in a toast).
    let mut live = hk.live.clone();
    let mut live_fallback = false;
    if gs.register(live.as_str()).is_err() {
        if live == settings::DEFAULT_LIVE && gs.register(settings::FALLBACK_LIVE).is_ok() {
            live = settings::FALLBACK_LIVE.into();
            live_fallback = true;
        } else {
            live = String::new();
        }
    }
    machine::register_stop(app, &hk.stop);
    mlog!("hotkeys: talk {:?}{}, live {:?}{}, show {}, focus {}", talk, if fallback { " (fallback)" } else { "" }, live, if live_fallback { " (fallback)" } else { "" }, show_ok, focus_ok);
    {
        let mut a = shared.lock().unwrap();
        a.talk_key = talk.clone();
        a.talk_fallback = fallback;
        a.live_key = live.clone();
        a.live_fallback = live_fallback;
    }
    if live_fallback {
        notify_plain(app, "Press Ctrl+Alt+Shift+L for a live conversation", "Ctrl+Alt+L is taken by another app on this computer, so JOYA AI uses Ctrl+Alt+Shift+L. You can change it in Settings.");
    } else if live.is_empty() {
        notify_plain(app, "The live conversation key could not be set", &format!("{} is taken by another app. Pick another in JOYA AI's Settings.", hk.live));
    }
    if fallback {
        notify_plain(app, "Hold Ctrl+Alt+Space to talk", "Ctrl+Space is taken by another app on this computer, so JOYA AI listens on Ctrl+Alt+Space. You can change it in Settings.");
    } else if talk.is_empty() {
        notify_plain(app, "The talk key could not be set", &format!("{} is taken by another app. Pick another in JOYA AI's Settings.", hk.talk));
    }
    if !show_ok || !focus_ok {
        notify_plain(app, "A JOYA AI hotkey is taken", "Another app holds one of JOYA AI's hotkeys. Pick another in Settings.");
    }
}

fn on_hotkey(app: &AppHandle, sc: &Shortcut, ev_state: ShortcutState) {
    if machine::on_hotkey(sc, ev_state == ShortcutState::Pressed) {
        return;
    }
    let shared = app.state::<Shared>().inner().clone();
    let (talk, show_k, focus_k, live_k) = {
        let a = shared.lock().unwrap();
        (a.talk_key.parse::<Shortcut>().ok(), a.settings.hotkeys.show.parse::<Shortcut>().ok(), a.settings.hotkeys.focus.parse::<Shortcut>().ok(), a.live_key.parse::<Shortcut>().ok())
    };
    // The live-call key: pressed once, it starts a hands-free call or ends the one that is on (the page
    // decides, as its live button does). Hidden or Peek closed: the layer is shown first.
    if live_k.is_some() && live_k.as_ref() == Some(sc) {
        if ev_state != ShortcutState::Pressed {
            return;
        }
        let need_show = {
            let a = shared.lock().unwrap();
            (a.settings.mode == Mode::Peek && !a.peek_open) || (a.settings.mode == Mode::Floating && a.hidden)
        };
        mlog!("live key pressed{}", if need_show { " (showing the layer)" } else { "" });
        if need_show {
            show(app, &shared, false);
        }
        let _ = app.emit_to(MAIN, "joya://live", serde_json::json!({ "at": epoch_ms() }));
        return;
    }
    if talk.as_ref() == Some(sc) {
        match ev_state {
            ShortcutState::Pressed => {
                // Every down goes to the page, even one with no up since the last (that up was lost: the
                // page ends the turn on it), numbered and timed by this clock (the page judges taps by it).
                let (need_show, seq, again) = {
                    let mut a = shared.lock().unwrap();
                    let again = a.talking;
                    a.talking = true;
                    a.key_seq += 1;
                    a.pressed_at = Some(Instant::now());
                    ((a.settings.mode == Mode::Peek && !a.peek_open) || (a.settings.mode == Mode::Floating && a.hidden), a.key_seq, again)
                };
                mlog!("talk key down (#{}){}", seq, if again { ", with no up since the last down" } else { "" });
                if need_show {
                    show(app, &shared, false);
                }
                let _ = app.emit_to(MAIN, "joya://ptt", serde_json::json!({ "down": true, "at": epoch_ms(), "seq": seq }));
            }
            ShortcutState::Released => {
                let (held, key) = {
                    let a = shared.lock().unwrap();
                    (a.pressed_at.map(|t| t.elapsed().as_millis()).unwrap_or(0), a.talk_key.clone())
                };
                // The release comes from the hotkey library polling the key; Windows is asked again here.
                // A key still down means the release was early: wait for the real one (never on the main thread).
                if let Some(vk) = platform::vk_of(&key) {
                    if platform::key_down(vk) {
                        mlog!("talk key: release reported after {} ms but Windows says the key is still down; waiting for it", held);
                        let (h, sh) = (app.clone(), shared.clone());
                        std::thread::spawn(move || {
                            let t0 = Instant::now();
                            while platform::key_down(vk) && t0.elapsed() < Duration::from_secs(120) {
                                std::thread::sleep(Duration::from_millis(20));
                            }
                            talk_up(&h, &sh);
                        });
                        return;
                    }
                }
                talk_up(app, &shared);
            }
        }
        return;
    }
    if ev_state != ShortcutState::Pressed {
        return;
    }
    if show_k.as_ref() == Some(sc) {
        toggle_show(app, &shared);
    } else if focus_k.as_ref() == Some(sc) {
        toggle_focus(app, &shared);
    }
}

/// The talk key is up: numbered, timed and logged like the down.
fn talk_up(app: &AppHandle, shared: &Shared) {
    let (seq, held) = {
        let mut a = shared.lock().unwrap();
        if !a.talking {
            return; // already sent (an early release that was waited out, then the library's own)
        }
        a.talking = false;
        a.key_seq += 1;
        (a.key_seq, a.pressed_at.map(|t| t.elapsed().as_millis()).unwrap_or(0))
    };
    mlog!("talk key up (#{}) after {} ms", seq, held);
    let _ = app.emit_to(MAIN, "joya://ptt", serde_json::json!({ "down": false, "at": epoch_ms(), "seq": seq }));
}

/// Milliseconds since 1970 (the page's Date.now() reads the same clock).
fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/* ------------------------------------------------------------ the tray */

fn tray_base() -> (Vec<u8>, u32, u32) {
    let img = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("tray icon");
    (img.rgba().to_vec(), img.width(), img.height())
}

fn refresh_tray(app: &AppHandle, shared: &Shared) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let (dot, line, cam) = {
        let a = shared.lock().unwrap();
        (policy::tray_dot(&a.state, a.needs), policy::status_line(&a.state, a.needs, a.sessions), a.cam_in_use && a.settings.presence.camera)
    };
    let (base, w, h) = tray_base();
    let px = trayicon::with_dot(&base, w, h, dot);
    let _ = tray.set_icon(Some(tauri::image::Image::new_owned(px, w, h)));
    let _ = tray.set_tooltip(Some(format!("JOYA AI · {}{}", line, presence::tooltip_note(cam))));
    if let Ok(menu) = build_menu(app, shared) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// What the menu shows, copied out of the lock (see the rule at monitor_for).
struct MenuSnap {
    state: String,
    needs: u32,
    sessions: u32,
    talk_key: String,
    signed_in: bool,
    settings: Settings,
    update: Option<String>,
    cam_in_use: bool,
}

fn build_menu(app: &AppHandle, shared: &Shared) -> tauri::Result<Menu<tauri::Wry>> {
    let a = {
        let g = shared.lock().unwrap();
        MenuSnap { state: g.state.clone(), needs: g.needs, sessions: g.sessions, talk_key: g.talk_key.clone(), signed_in: g.signed_in, settings: g.settings.clone(), update: g.update.clone(), cam_in_use: g.cam_in_use }
    };
    let line = policy::status_line(&a.state, a.needs, a.sessions);
    let talk = if a.talk_key.is_empty() { "Talk".to_string() } else { format!("Talk (hold {})", a.talk_key) };
    let head = MenuItem::with_id(app, "head", format!("JOYA AI — {}", line), false, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show", format!("Show JOYA AI\t{}", a.settings.hotkeys.show), true, None::<&str>)?;
    let talk_i = MenuItem::with_id(app, "talk", talk, a.signed_in, None::<&str>)?;
    let m_desk = CheckMenuItem::with_id(app, "mode:desktop", "On the desktop", true, a.settings.mode == Mode::Desktop, None::<&str>)?;
    let m_float = CheckMenuItem::with_id(app, "mode:floating", "Floating, always on top", true, a.settings.mode == Mode::Floating, None::<&str>)?;
    let m_peek = CheckMenuItem::with_id(app, "mode:peek", "Hidden until called (peek)", true, a.settings.mode == Mode::Peek, None::<&str>)?;
    // Companion: on and off from here (off goes back to the mode it came from).
    let m_comp = CheckMenuItem::with_id(app, "mode:companion", "Companion: JOYA AI at the top of the screen", true, a.settings.mode == Mode::Companion, None::<&str>)?;
    let focus_i = CheckMenuItem::with_id(app, "focus", format!("Focus mode: just the core\t{}", a.settings.hotkeys.focus), true, a.settings.focus, None::<&str>)?;
    let glance_i = CheckMenuItem::with_id(app, "glance", "Glance cards beside JOYA AI", true, a.settings.glance, None::<&str>)?;
    // Eye contact: the camera's one switch -- off at once; on directly only once it was switched on in Settings.
    let cam_i = CheckMenuItem::with_id(app, "presence", presence::tray_label(a.settings.presence.camera, a.cam_in_use), true, a.settings.presence.camera, None::<&str>)?;
    let dnd = CheckMenuItem::with_id(app, "dnd", "Do not disturb (no toasts)", true, a.settings.do_not_disturb, None::<&str>)?;
    let full = MenuItem::with_id(app, "open", "Open the full Command Center", true, None::<&str>)?;
    let sett = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let sign = MenuItem::with_id(app, "signout", if a.signed_in { "Sign out" } else { "Sign in with Windows Hello" }, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit JOYA AI", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    // Several monitors: which one JOYA AI lives on.
    let mons = app.available_monitors().unwrap_or_default();
    let mon_items: Vec<CheckMenuItem<tauri::Wry>> = mons
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let name = m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1));
            let chosen = if a.settings.monitor.is_empty() { i == 0 } else { a.settings.monitor == name };
            CheckMenuItem::with_id(app, format!("monitor:{}", name), format!("{} · {}×{}", name.trim_start_matches("\\\\.\\"), m.size().width, m.size().height), true, chosen, None::<&str>).ok()
        })
        .collect();
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&head];
    let s1 = sep()?;
    let s2 = sep()?;
    let s3 = sep()?;
    let s4 = sep()?;
    items.extend([&s1 as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &show_i, &talk_i, &s2, &m_desk, &m_float, &m_peek, &m_comp, &focus_i, &glance_i, &cam_i]);
    let mon_sub;
    if mon_items.len() > 1 {
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = mon_items.iter().map(|x| x as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
        mon_sub = Submenu::with_items(app, "Monitor", true, &refs)?;
        items.push(&mon_sub);
    }
    items.extend([&s3 as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &dnd, &full, &sett]);
    let upd;
    if let Some(v) = &a.update {
        upd = MenuItem::with_id(app, "update", format!("Update to {} and restart", v), true, None::<&str>)?;
        items.push(&upd);
    }
    items.extend([&s4 as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &sign, &quit]);
    Menu::with_items(app, &items)
}

fn on_menu(app: &AppHandle, id: &str) {
    let shared = app.state::<Shared>().inner().clone();
    match id {
        "show" => toggle_show(app, &shared),
        "talk" => {
            show(app, &shared, false);
            let _ = app.emit_to(MAIN, "joya://talk", serde_json::json!({}));
        }
        "mode:desktop" => set_mode(app, &shared, Mode::Desktop),
        "mode:floating" => set_mode(app, &shared, Mode::Floating),
        "mode:peek" => set_mode(app, &shared, Mode::Peek),
        "mode:companion" => {
            let (now, back) = {
                let a = shared.lock().unwrap();
                (a.settings.mode, a.settings.before_companion)
            };
            set_mode(app, &shared, if now == Mode::Companion { back } else { Mode::Companion });
        }
        "focus" => toggle_focus(app, &shared),
        "glance" => {
            let on = !shared.lock().unwrap().settings.glance;
            set_glance_on(app, &shared, on);
        }
        "presence" => {
            let click = presence::tray_click(&shared.lock().unwrap().settings.presence);
            match click {
                presence::TrayClick::OpenSettings => {
                    refresh_tray(app, &shared); // the check mark stays off
                    open_settings_eye(app);
                }
                presence::TrayClick::On | presence::TrayClick::Off => {
                    let was = {
                        let mut a = shared.lock().unwrap();
                        let was = a.settings.presence.camera;
                        a.settings.presence.camera = click == presence::TrayClick::On;
                        a.settings.presence.fix();
                        was
                    };
                    presence_changed(app, &shared, was);
                }
            }
        }
        "dnd" => {
            shared.lock().unwrap().settings.do_not_disturb ^= true;
            save(&shared);
            refresh_tray(app, &shared);
        }
        "open" => open_full(app, &shared),
        "settings" => open_settings(app),
        "update" => install_update(app.clone()),
        "signout" => {
            let signed_in = shared.lock().unwrap().signed_in;
            if signed_in {
                let _ = app.emit_to(MAIN, "joya://signout", serde_json::json!({}));
            } else {
                show(app, &shared, true);
            }
        }
        "quit" => {
            let _ = app.emit_to(MAIN, "joya://quit", serde_json::json!({}));
            let h = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                h.exit(0);
            });
        }
        other => {
            if let Some(name) = other.strip_prefix("monitor:") {
                {
                    let mut a = shared.lock().unwrap();
                    a.settings.monitor = name.to_string();
                    // Companion: it moves there (and, staying on one monitor, stays on that one).
                    a.comp.reset();
                }
                save(&shared);
                apply(app, &shared, false);
            }
        }
    }
}

/* -------------------------------------------------------------- toasts */

/// A toast with no buttons (a note to the person).
fn notify_plain(app: &AppHandle, title: &str, body: &str) {
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

/// Something needs you and JOYA AI cannot be seen: a toast with Open and Deny. Never Approve:
/// a one-click approve of a destructive step from a notification is too easy to hit by accident.
fn notify_needs(app: &AppHandle, id: i64, title: &str, body: &str) {
    #[cfg(windows)]
    {
        let app_id = app.config().identifier.clone();
        let h = app.clone();
        let _ = tauri_winrt_notification::Toast::new(&app_id)
            .title(title)
            .text1(body)
            .add_button("Open", &format!("open:{}", id))
            .add_button("Deny", &format!("deny:{}", id))
            .on_activated(move |action| {
                let shared = h.state::<Shared>().inner().clone();
                match action.as_deref() {
                    Some(a) if a.starts_with("deny:") => {
                        let n: i64 = a[5..].parse().unwrap_or(0);
                        let _ = h.emit_to(MAIN, "joya://toast-deny", serde_json::json!({ "id": n }));
                    }
                    _ => show(&h, &shared, false),
                }
                Ok(())
            })
            .show();
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, title, body);
    }
}

/* ---------------------------------------------------- browser and windows */

fn open_url(u: &str) {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        if let Ok(p) = Url::parse(u) {
            if p.scheme() == "https" || p.scheme() == "http" || p.scheme() == "mailto" {
                unsafe {
                    ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(p.as_str()), None, None, SW_SHOWNORMAL);
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = u;
    }
}

fn open_full(_app: &AppHandle, shared: &Shared) {
    let o = origin(&shared.lock().unwrap().settings);
    if let Ok(u) = o.join("/joya-ai") {
        open_url(u.as_str());
    }
}

/// The Settings window's Close (and Esc): the app closes the window -- the page's own window.close()
/// only empties the WebView2 page and leaves the window up, white. The next open builds a fresh one.
#[tauri::command]
fn settings_close(app: AppHandle) {
    mlog!("settings window closed from its page");
    // After this command has answered (the page that asked is the one going away).
    on_main(&app, |app| {
        if let Some(w) = app.get_webview_window(SETTINGS_WIN) {
            let _ = w.destroy();
        }
    });
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS_WIN) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, SETTINGS_WIN, WebviewUrl::App("settings.html".into()))
        .title("JOYA AI — Settings")
        .inner_size(560.0, 760.0)
        .resizable(true)
        .center()
        .build();
}

/// Eye contact: the tray's "Camera presence" before it was ever switched on -- Settings, at its explanation.
fn open_settings_eye(app: &AppHandle) {
    open_settings(app);
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        on_main(&h, |app| {
            if let Some(w) = app.get_webview_window(SETTINGS_WIN) {
                let _ = w.eval("var e=document.getElementById('eye-contact');if(e)e.scrollIntoView();");
            }
        });
    });
}

/* ------------------------------------------------------------- updates */

fn check_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(up) = app.updater() else { return };
        if let Ok(Some(u)) = up.check().await {
            let shared = app.state::<Shared>().inner().clone();
            let first = {
                let mut a = shared.lock().unwrap();
                let first = a.update.as_deref() != Some(u.version.as_str());
                a.update = Some(u.version.clone());
                first
            };
            let sh = shared.clone();
            on_main(&app, move |app| refresh_tray(app, &sh));
            if first {
                notify_plain(&app, &format!("JOYA AI {} is ready", u.version), "Choose \"Update and restart\" in the tray menu when it suits you.");
            }
        }
    });
}

fn install_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(up) = app.updater() else { return };
        match up.check().await {
            Ok(Some(u)) => {
                // The installer is checked against the update key before it runs; Windows closes the app for it.
                if let Err(e) = u.download_and_install(|_, _| {}, || {}).await {
                    notify_plain(&app, "The update did not install", &e.to_string());
                } else {
                    app.restart();
                }
            }
            Ok(None) => notify_plain(&app, "JOYA AI is up to date", &format!("Version {}.", VERSION)),
            Err(e) => notify_plain(&app, "Could not check for updates", &e.to_string()),
        }
    });
}

/* ------------------------------------------------------- commands (page) */

#[tauri::command]
fn get_state(app: AppHandle, shared: State<'_, Shared>) -> PageState {
    let key = current_monitor_key(&app, &shared);
    let a = shared.lock().unwrap();
    page_state(&a, &key, false)
}

#[tauri::command]
fn set_hit_regions(regions: Vec<Region>, dpr: f64, shared: State<'_, Shared>) {
    let mut a = shared.lock().unwrap();
    a.regions = hit::clean(regions);
    a.dpr = if dpr.is_finite() && dpr > 0.0 && dpr < 8.0 { dpr } else { 1.0 };
}

#[tauri::command]
fn set_status(app: AppHandle, state: String, needs: u32, sessions: u32, shared: State<'_, Shared>) {
    const STATES: [&str; 8] = ["idle", "listening", "thinking", "speaking", "delegating", "needs", "offline", "signedout"];
    {
        let mut a = shared.lock().unwrap();
        a.state = if STATES.contains(&state.as_str()) { state } else { "idle".into() };
        a.needs = needs.min(999);
        a.sessions = sessions.min(999);
    }
    refresh_tray(&app, &shared);
}

#[tauri::command]
fn needs_you(app: AppHandle, id: i64, title: String, body: String, shared: State<'_, Shared>) -> bool {
    let go = {
        let mut a = shared.lock().unwrap();
        if a.toasted.contains(&id) {
            return false;
        }
        a.toasted.push(id);
        if a.toasted.len() > 200 {
            a.toasted.remove(0);
        }
        policy::should_toast(&a.seen, a.settings.do_not_disturb)
    };
    if go {
        let t: String = title.chars().take(120).collect();
        let b: String = body.chars().take(300).collect();
        notify_needs(&app, id, &t, &b);
    }
    go
}

/// Eye contact: the page says whether it holds the camera now (the tray shows it).
#[tauri::command]
fn presence_status(app: AppHandle, in_use: bool, shared: State<'_, Shared>) {
    let changed = {
        let mut a = shared.lock().unwrap();
        let c = a.cam_in_use != in_use;
        a.cam_in_use = in_use;
        c
    };
    if changed {
        mlog!("camera presence: the page {} the camera", if in_use { "opened" } else { "let go of" });
        refresh_tray(&app, &shared);
    }
}

/// Eye contact: the page's Off (its Settings row). The page can only switch it off (presence::page_set).
#[tauri::command]
fn presence_off(app: AppHandle, shared: State<'_, Shared>) {
    let was = {
        let mut a = shared.lock().unwrap();
        let was = a.settings.presence.camera;
        a.settings.presence = presence::page_set(&a.settings.presence, Some(false), Some(false), None);
        was
    };
    presence_changed(&app, &shared, was);
}

#[tauri::command]
fn hide_peek(app: AppHandle, shared: State<'_, Shared>) {
    let changed = {
        let mut a = shared.lock().unwrap();
        let was = a.peek_open;
        a.peek_open = false;
        was
    };
    if changed {
        apply(&app, &shared, false);
    }
}

#[tauri::command]
fn start_drag(window: WebviewWindow, shared: State<'_, Shared>) {
    if shared.lock().unwrap().settings.mode != Mode::Floating {
        return;
    }
    shared.lock().unwrap().dragging = Some(Instant::now());
    acrylic::set_dragging(true);
    let _ = window.start_dragging();
}

#[tauri::command]
fn tool(app: AppHandle, name: String, shared: State<'_, Shared>) {
    match name.as_str() {
        "focus" => toggle_focus(&app, &shared),
        "size" => {
            let key = current_monitor_key(&app, &shared);
            {
                let mut a = shared.lock().unwrap();
                let pm = a.settings.monitor_prefs_mut(&key);
                pm.size = pm.size.next();
            }
            save(&shared);
            apply(&app, &shared, false);
        }
        "hide" => {
            shared.lock().unwrap().hidden = true;
            apply(&app, &shared, false);
        }
        _ => {}
    }
}

/// The glance cards, from the page: shown or hidden (`show`), pinned on the desktop where they were
/// dropped (`pin`, fractions of the work area, Desktop layer only, remembered per monitor), or back
/// beside the core (`unpin`). Nothing else: the values are clamped (settings::Pin::clean).
#[tauri::command]
fn set_glance(app: AppHandle, show: Option<bool>, pin: Option<Pin>, unpin: Option<bool>, shared: State<'_, Shared>) {
    if let Some(on) = show {
        set_glance_on(&app, &shared, on);
    }
    if pin.is_none() && unpin != Some(true) {
        return;
    }
    let key = current_monitor_key(&app, &shared);
    {
        let mut a = shared.lock().unwrap();
        if a.settings.mode != Mode::Desktop {
            return;
        }
        let next = if unpin == Some(true) { None } else { pin.and_then(|p| Pin::clean(p.x, p.y)) };
        let pm = a.settings.monitor_prefs_mut(&key);
        if pm.glance_pin == next {
            return;
        }
        pm.glance_pin = next;
    }
    save(&shared);
    // The page already shows it there; tell it the saved value (no window change: the Desktop layer is the work area).
    let payload = {
        let a = shared.lock().unwrap();
        page_state(&a, &key, false)
    };
    let _ = app.emit_to(MAIN, "joya://state", payload);
}

/// Companion mode, from the page: "open" (a click on the bot: its Command Center, Peek). Nothing else
/// (companion_host::page_says).
#[tauri::command]
fn companion(app: AppHandle, kind: String, shared: State<'_, Shared>) {
    companion_host::page_says(&app, &shared, &kind);
}

#[tauri::command]
fn open_full_cc(app: AppHandle, shared: State<'_, Shared>) {
    open_full(&app, &shared);
}

#[tauri::command]
fn page_ready(app: AppHandle, signed_in: bool, shared: State<'_, Shared>) {
    let resize = {
        let mut a = shared.lock().unwrap();
        a.awaiting_ready = None;
        let was = glance_room(&a);
        a.signed_in = signed_in;
        if !signed_in {
            a.state = "signedout".into();
        }
        // Signed in or out: the Floating window gains or loses the glance column's room.
        was != glance_room(&a) && a.settings.mode == Mode::Floating
    };
    if resize {
        apply(&app, &shared, false);
    } else {
        refresh_tray(&app, &shared);
    }
}

/// The start card (dist/index.html) found the site answering: open the Command Center.
///
/// The navigation is made here, by the app (WebView2's Navigate), not by the card's own
/// `location`: a page on http://tauri.localhost sending the window to joya.example.com is a
/// cross-site navigation, and the site's session cookie is SameSite=Strict, so it would not be
/// sent -- every start would land on the sign-in page and the new session's cookie would replace
/// the one that was still valid. A navigation the app makes has no initiating site, like a typed
/// address, and the cookie goes with it.
#[tauri::command]
fn go_site(app: AppHandle, shared: State<'_, Shared>) -> bool {
    let o = origin(&shared.lock().unwrap().settings);
    let Ok(u) = o.join("/joya-ai?shell=desktop") else { return false };
    shared.lock().unwrap().awaiting_ready = Some(Instant::now());
    match main_window(&app) {
        Some(w) => w.navigate(u).is_ok(),
        None => false,
    }
}

/// The site's sign-in page says a passkey / Windows Hello ceremony starts (`on`) or ends.
///
/// Windows Hello's dialog belongs to the window that asked: a window that is click-through,
/// bottom-most (Desktop layer) or not allowed to take the focus gets no dialog, or one hidden
/// behind everything. While it runs the window is made a plain one: clicks reach it, it is on top
/// and it has the focus. When it ends the mode's own placement comes back (apply).
#[tauri::command]
fn webauthn_ceremony(app: AppHandle, shared: State<'_, Shared>, on: bool) {
    mlog!("webauthn ceremony {}", if on { "starts" } else { "ends" });
    shared.lock().unwrap().ceremony = on;
    if on {
        if let Some(w) = main_window(&app) {
            let _ = w.set_ignore_cursor_events(false);
            shared.lock().unwrap().ignoring = Some(false);
            let _ = w.set_always_on_bottom(false);
            let _ = w.set_always_on_top(true);
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    } else {
        apply(&app, &shared, false);
    }
}

#[derive(Serialize)]
struct SigninResult {
    ok: bool,
    error: Option<String>,
}

/// "Sign in in your browser": the PKCE hand-off (signin.rs).
#[tauri::command]
fn browser_signin(app: AppHandle, shared: State<'_, Shared>) -> SigninResult {
    let o = origin(&shared.lock().unwrap().settings);
    let p = signin::pkce();
    let w = match signin::listen() {
        Ok(w) => w,
        Err(e) => return SigninResult { ok: false, error: Some(format!("Could not open the sign-in listener: {}", e)) },
    };
    let mut link = o.join("/desktop/link").unwrap();
    link.query_pairs_mut().append_pair("c", &p.challenge).append_pair("p", &w.port.to_string());
    open_url(link.as_str());
    let verifier = p.verifier;
    std::thread::spawn(move || {
        if let Some(code) = w.code(signin::WAIT) {
            let mut r = o.join("/desktop/redeem").unwrap();
            r.query_pairs_mut().append_pair("code", &code).append_pair("v", &verifier);
            if let Some(win) = main_window(&app) {
                let _ = win.navigate(r);
                let _ = win.set_focus();
            }
        }
    });
    SigninResult { ok: true, error: None }
}

/* -------------------------------------------------- commands (settings) */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    settings: Settings,
    version: &'static str,
    talk_key: String,
    talk_fallback: bool,
    live_key: String,
    live_fallback: bool,
    monitors: Vec<String>,
    /// The per-monitor key of the monitor JOYA AI is on now (size, corner, opacity are kept per monitor).
    monitor_key: String,
    update: Option<String>,
    /// Why real blur cannot be drawn on this computer (None: it can).
    blur_note: Option<&'static str>,
}

#[tauri::command]
fn settings_get(app: AppHandle, shared: State<'_, Shared>) -> SettingsView {
    let monitor_key = current_monitor_key(&app, &shared);
    let monitors: Vec<String> = app.available_monitors().unwrap_or_default().iter().filter_map(|m| m.name().cloned()).collect();
    let a = shared.lock().unwrap();
    SettingsView {
        settings: a.settings.clone(),
        version: VERSION,
        talk_key: a.talk_key.clone(),
        talk_fallback: a.talk_fallback,
        live_key: a.live_key.clone(),
        live_fallback: a.live_fallback,
        monitors,
        monitor_key,
        update: a.update.clone(),
        blur_note: blur_note(),
    }
}

/// Save the Settings window's values: checked here (hotkeys valid and distinct), then applied.
#[tauri::command]
fn settings_set(app: AppHandle, value: Settings, shared: State<'_, Shared>) -> Result<(), String> {
    let mut v = value;
    for (label, k) in [("Talk", &v.hotkeys.talk), ("Show / hide", &v.hotkeys.show), ("Focus mode", &v.hotkeys.focus), ("Live conversation", &v.hotkeys.live), ("Stop JOYA AI's control", &v.hotkeys.stop)] {
        if settings::normalize_hotkey(k).is_none() {
            return Err(format!("{}: \"{}\" is not a hotkey here. Use Ctrl or Alt with one key, e.g. Ctrl+Alt+M.", label, k));
        }
    }
    v.fix();
    if !settings::hotkeys_distinct(&v.hotkeys) {
        return Err("The hotkeys must all be different.".into());
    }
    let autostart = v.autostart;
    let (cam_was, cam_changed);
    {
        let mut a = shared.lock().unwrap();
        let mode_changed = a.settings.mode != v.mode;
        if mode_changed && (v.mode == Mode::Companion || a.settings.mode == Mode::Companion) {
            if v.mode == Mode::Companion {
                v.before_companion = a.settings.mode;
            }
            a.comp.reset();
        }
        let p_old = a.settings.presence.clone();
        v.presence = presence::from_settings(&p_old, &v.presence);
        cam_was = p_old.camera;
        cam_changed = p_old.camera != v.presence.camera;
        a.settings = v;
        if mode_changed {
            a.peek_open = a.settings.mode == Mode::Peek;
            a.hidden = false;
        }
        a.ignoring = None;
    }
    save(&shared);
    set_autostart(&app, autostart);
    register_hotkeys(&app, &shared);
    apply(&app, &shared, false);
    if cam_changed {
        presence_changed(&app, &shared, cam_was);
    }
    Ok(())
}

#[tauri::command]
fn settings_check_update(app: AppHandle) {
    install_update(app);
}

fn set_autostart(app: &AppHandle, on: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let now = al.is_enabled().unwrap_or(false);
    if on && !now {
        let _ = al.enable();
    } else if !on && now {
        let _ = al.disable();
    }
}

/* ------------------------------------------------- real blur (acrylic.rs)
   The only places the rest of the app touches real blur: the page's glass flag (page_state), its
   rectangles (set_blur_rects), drag start / end, the environment loop's re-read of what Windows
   allows, and this setup. Everything else is acrylic.rs (native) and blur.rs (pure). */

static BLUR_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// The page's glass flag -- and acrylic.rs is told the same, so the page's look and the native blur
/// never disagree (every state the page sees comes through page_state).
fn blur_glass(a: &App, opacity: u8) -> bool {
    // Behind the icons, or about to be (apply asks for the state before it moves the window there).
    let behind = a.behind_icons || (a.settings.mode == Mode::Desktop && a.settings.experimental_behind_icons && !a.peek_open);
    // Companion: never -- the bot has its own backplate, and its window moves between monitors (a shown blur window never may).
    let glass = a.settings.mode != Mode::Companion && acrylic::live() && blur::page_glass(a.settings.real_blur, &acrylic::system(), opacity, behind);
    acrylic::set_glass(glass, a.ink == Ink::Light);
    glass
}

fn blur_note() -> Option<&'static str> {
    if !cfg!(windows) {
        return Some("Real blur is drawn on Windows only.");
    }
    if !acrylic::live() {
        return Some("Real blur could not start on this computer: the tinted look is used.");
    }
    blur::unavailable(&acrylic::system())
}

/// The page's glass surfaces, in CSS px, settled (not moving), only when they change; `view` the viewport
/// (CSS px, [width, height]) they were measured in (0.1.10; a page that does not send it is taken as is).
#[tauri::command]
fn set_blur_rects(rects: Vec<Region>, dpr: f64, view: Option<(f64, f64)>) {
    acrylic::set_rects(rects, dpr, view);
}

fn blur_init(app: &AppHandle, w: &WebviewWindow) {
    let _ = BLUR_APP.set(app.clone());
    acrylic::init(hwnd(w), blur_cursor, blur_system_changed);
}

/// The cursor reached a blur window before the click-through loop noticed: the main window catches the
/// mouse now (main thread, from the blur window's hit test; never waits on the lock).
fn blur_cursor() {
    let Some(app) = BLUR_APP.get() else { return };
    let shared = app.state::<Shared>().inner().clone();
    {
        let Ok(mut a) = shared.try_lock() else { return };
        if a.ignoring != Some(true) || a.behind_icons {
            return;
        }
        a.ignoring = Some(false);
    }
    if let Some(w) = main_window(app) {
        let _ = w.set_ignore_cursor_events(false);
    }
}

/// Transparency effects or high contrast switched in Windows: the page changes look at once.
fn blur_system_changed() {
    let Some(app) = BLUR_APP.get() else { return };
    let sh = app.state::<Shared>().inner().clone();
    on_main(app, move |app| {
        let key = current_monitor_key(app, &sh);
        let payload = page_state(&sh.lock().unwrap(), &key, false);
        let _ = app.emit_to(MAIN, "joya://state", payload);
    });
}

/* ------------------------------------------------------------- the loops */

/// Run `f` on the app's main thread, without waiting for it. Background loops use this for
/// every window change, so they never block on the main thread (and it never on them).
fn on_main<F: FnOnce(&AppHandle) + Send + 'static>(app: &AppHandle, f: F) {
    let h = app.clone();
    if let Err(e) = app.run_on_main_thread(move || f(&h)) {
        mlog!("run_on_main_thread failed: {}", e);
    }
}

/// About 30 times a second: is the cursor on something interactive? Switch click-through to match.
/// Also: a Floating box that was dragged snaps to the nearest corner when the mouse is let go.
///
/// It reads the cursor and the window's rectangle straight from Windows (platform.rs) -- never
/// through the app, whose getters wait for the main thread -- and posts the one change it makes
/// (set_ignore_cursor_events) to the main thread without waiting.
fn hit_loop(app: AppHandle, shared: Shared) {
    let mut raw: isize = 0;
    loop {
        std::thread::sleep(Duration::from_millis(33));
        if raw == 0 {
            match main_window(&app) {
                Some(w) => raw = hwnd(&w),
                None => continue,
            }
            if raw == 0 && cfg!(windows) {
                continue;
            }
        }
        let (regions, dpr, behind, mode, peek_open, dragging, was, ceremony) = {
            let Ok(a) = shared.try_lock() else { continue };
            (a.regions.clone(), a.dpr, a.behind_icons, a.settings.mode, a.peek_open, a.dragging, a.ignoring, a.ceremony)
        };
        if behind {
            continue;
        }
        if let Some(t) = dragging {
            // The drag ends when the window has not moved for a moment (the button is up by then).
            let moved = shared.lock().unwrap().last_moved;
            let quiet = moved.map(|m| m.elapsed() > Duration::from_millis(350)).unwrap_or(t.elapsed() > Duration::from_millis(1500));
            if quiet && t.elapsed() > Duration::from_millis(300) {
                shared.lock().unwrap().dragging = None;
                let sh = shared.clone();
                on_main(&app, move |app| {
                    if let Some(w) = main_window(app) {
                        snap(app, &sh, &w);
                    }
                });
            }
            continue;
        }
        // Peek showing, or Windows Hello asking (the dialog needs an ordinary window under it): all of it catches the mouse.
        let want_ignore = if (matches!(mode, Mode::Peek | Mode::Companion) && peek_open) || ceremony {
            false
        } else {
            let Some((cx, cy)) = platform::cursor() else { continue };
            let Some((x0, y0, _, _)) = platform::window_rect(raw) else { continue };
            !hit::hit(&regions, (cx - x0) as f64, (cy - y0) as f64, dpr)
        };
        if was != Some(want_ignore) {
            shared.lock().unwrap().ignoring = Some(want_ignore);
            on_main(&app, move |app| {
                if let Some(w) = main_window(app) {
                    let _ = w.set_ignore_cursor_events(want_ignore);
                }
            });
        }
    }
}

fn snap(app: &AppHandle, shared: &Shared, w: &WebviewWindow) {
    let (pos, size) = match (w.outer_position(), w.outer_size()) {
        (Ok(p), Ok(s)) => (p, s),
        _ => {
            shared.lock().unwrap().dragging = None;
            acrylic::set_dragging(false);
            return;
        }
    };
    let win = Rect { x: pos.x, y: pos.y, w: size.width, h: size.height };
    // The monitor it was dropped on becomes its monitor; there it takes the nearest corner.
    let (cx, cy) = win.centre();
    let mon = app.monitor_from_point(cx as f64, cy as f64).ok().flatten().map(|m| (mon_of(&m), m.name().cloned().unwrap_or_default()));
    {
        let mut a = shared.lock().unwrap();
        a.dragging = None;
        a.last_moved = None;
        if let Some((m, name)) = mon {
            let pm = a.settings.monitor_prefs(&m.key);
            let corner = layout::nearest_corner(win, m.work, m.scale, pm.size, a.settings.focus, pm.corner);
            a.settings.monitor_prefs_mut(&m.key).corner = corner;
            a.settings.monitor = name;
        }
    }
    acrylic::set_dragging(false);
    save(shared);
    apply(app, shared, false);
}

/// Once a second: what is in front, full-screen apps, power, the lock screen, monitors plugged in or
/// out, the wallpaper's brightness; the page is told when its stillness or ink changes.
///
/// Everything it reads comes straight from Windows (platform.rs); everything it changes is posted
/// to the main thread (on_main) without waiting. It asks the app for its monitor list only every
/// 5 s, and never while holding the lock.
fn env_loop(app: AppHandle, shared: Shared) {
    let mut tick: u64 = 0;
    let mut raw: isize = 0;
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        tick += 1;
        if raw == 0 {
            if let Some(w) = main_window(&app) {
                raw = hwnd(&w);
            }
        }
        let front = platform::front(raw);
        // Full screen counts only on JOYA AI's own monitor (policy::fullscreen_hold): Windows' "busy"
        // is raised for a full-screen app on any monitor, and by some apps with nothing full screen.
        let quns = platform::quns();
        let fg = platform::front_window(raw);
        let our_monitor = platform::monitor_of(raw);
        let fs_why = policy::fullscreen_hold(quns, fg.as_ref(), our_monitor);
        let fullscreen = fs_why.is_some();
        let fs_note = policy::fullscreen_note(quns, &fs_why);
        let (on_battery, energy_saver) = platform::power();
        let locked = platform::locked();
        machine::on_locked(locked);
        let reduce = platform::reduce_motion();
        let mut reapply = false;
        let mut repaint = false;
        let sig: Option<String> = if tick % 5 == 1 {
            Some(app.available_monitors().unwrap_or_default().iter().map(|m| format!("{:?}{:?}{:?}{}", m.name(), m.position(), m.size(), m.scale_factor())).collect())
        } else {
            None
        };
        let mut stuck = false;
        let mut reload_page = false;
        // Real blur: what Windows allows (transparency effects, high contrast), every 5 s.
        if tick % 5 == 3 && acrylic::refresh_system().1 {
            repaint = true;
        }
        {
            let mut a = shared.lock().unwrap();
            a.seen.fullscreen = fullscreen;
            // Eye contact: what decides whether the page may hold the camera (repainted when it changes).
            let pv0 = presence_view(&a);
            a.on_battery = on_battery;
            a.energy_saver = energy_saver;
            a.seen.locked = locked;
            if a.settings.presence.camera && tick % 3 == 0 {
                let our_call = a.talking || a.state == "listening" || a.state == "speaking";
                a.meeting = companion::meeting(&platform::cap_use("webcam"), &platform::cap_use("microphone"), our_call);
            } else if !a.settings.presence.camera {
                a.meeting = false;
            }
            if presence_view(&a) != pv0 {
                repaint = true;
            }
            if presence::must_reload(a.settings.presence.camera, a.cam_in_use, a.cam_off_at.map(|t| t.elapsed().as_millis() as u64)) {
                mlog!("camera presence is off but the page still holds the camera: reloading it");
                a.cam_off_at = None;
                a.cam_in_use = false;
                reload_page = true;
            }
            // Covered only by a window in front on JOYA AI's own monitor (one on the second screen is not in the way).
            a.seen.covered = a.settings.mode == Mode::Desktop && !a.peek_open && policy::front_covers(front == Front::Other, fg.as_ref(), our_monitor);
            if fs_note != a.fullscreen_note {
                let f = fg.as_ref();
                mlog!(
                    "full screen: {} (in front: {}{}, its monitor {:#x} {:?}, its bounds {:?}; JOYA AI's monitor {:#x})",
                    fs_note,
                    f.map(|f| f.class.as_str()).unwrap_or("none"),
                    f.map(|f| if f.ours { " (JOYA AI)" } else if f.tool { " (tool window)" } else { "" }).unwrap_or(""),
                    f.map(|f| f.monitor).unwrap_or(0),
                    f.map(|f| f.monitor_rect).unwrap_or_default(),
                    f.map(|f| f.rect).unwrap_or_default(),
                    our_monitor
                );
                a.fullscreen_note = fs_note;
            }
            // Desktop layer and "show desktop" (Win+D) or a click on the wallpaper: up on top while the
            // desktop has the focus, back to the bottom when anything else does (Rainmeter's approach).
            if a.settings.mode == Mode::Desktop && !a.settings.experimental_behind_icons && !a.ceremony {
                // Our own window in front (typing in the raised layer) keeps it as it is.
                let raise = match front {
                    Front::Desktop => true,
                    Front::Ours | Front::Unknown => a.raised_for_desktop,
                    Front::Other => false,
                };
                if raise != a.raised_for_desktop && !a.peek_open {
                    a.raised_for_desktop = raise;
                    reapply = true;
                }
            } else if a.raised_for_desktop && a.settings.mode != Mode::Desktop {
                a.raised_for_desktop = false;
            }
            let still = policy::hold_still(a.settings.battery_saver, on_battery, energy_saver, &a.seen, reduce);
            if still != a.still {
                a.still = still;
                repaint = true;
                log_still(&a, on_battery, energy_saver, reduce, "every second");
            }
            // Monitors plugged in or out, or a resolution change: place it again.
            if let Some(sig) = sig {
                if sig != a.monitors_sig {
                    if !a.monitors_sig.is_empty() {
                        reapply = true;
                    }
                    a.monitors_sig = sig;
                }
            }
            // The page never said it was ready (a failed load shows Windows' error page): back to the start card.
            if let Some(t) = a.awaiting_ready {
                if t.elapsed() > Duration::from_secs(25) {
                    a.awaiting_ready = None;
                    stuck = true;
                }
            }
        }
        if stuck {
            mlog!("the site's page did not report ready in 25 s: back to the start card");
            on_main(&app, |app| {
                if let (Some(w), Ok(u)) = (main_window(app), Url::parse("tauri://localhost/index.html?stuck=1")) {
                    let _ = w.navigate(local_url(&u));
                }
            });
            continue;
        }
        // The wallpaper's brightness: at start, then every half minute (a changed wallpaper is caught then).
        if tick == 2 || tick % 30 == 0 {
            if let Some(w) = main_window(&app) {
                if let Some(ink) = wallpaper_ink(&app, &shared, &w) {
                    let mut a = shared.lock().unwrap();
                    if a.ink != ink {
                        a.ink = ink;
                        repaint = true;
                    }
                }
            }
        }
        if reload_page {
            on_main(&app, |app| {
                if let Some(w) = main_window(app) {
                    let _ = w.eval("location.reload()");
                }
            });
        }
        if reapply {
            let sh = shared.clone();
            on_main(&app, move |app| apply(app, &sh, false));
        } else if repaint {
            let sh = shared.clone();
            on_main(&app, move |app| {
                let key = current_monitor_key(app, &sh);
                let payload = page_state(&sh.lock().unwrap(), &key, false);
                let _ = app.emit_to(MAIN, "joya://state", payload);
            });
        }
        // A minimised layer (Win+D, Win+M) comes back.
        if raw != 0 && platform::minimized(raw) {
            let should = {
                let a = shared.lock().unwrap();
                match a.settings.mode {
                    Mode::Floating => !a.hidden,
                    Mode::Desktop => true,
                    Mode::Peek => a.peek_open,
                    Mode::Companion => a.peek_open || a.comp.ducked.is_none(),
                }
            };
            if should {
                on_main(&app, |app| {
                    if let Some(w) = main_window(app) {
                        let _ = w.unminimize();
                    }
                });
            }
        }
        if tick % (6 * 3600) == 30 && shared.lock().unwrap().settings.check_updates {
            check_update(app.clone());
        }
    }
}

fn log_still(a: &App, on_battery: bool, energy_saver: bool, reduce: bool, by: &str) {
    let s = &a.seen;
    mlog!(
        "core {} ({}): battery saver setting {}, on battery {}, energy saver {}, fullscreen {}, locked {}, reduce motion {}, hidden {}, covered {}",
        if a.still { "holds still" } else { "moves" },
        by,
        a.settings.battery_saver,
        on_battery,
        energy_saver,
        s.fullscreen,
        s.locked,
        reduce,
        s.hidden,
        s.covered
    );
}

/// A power notification from Windows (platform::watch_power): decide at once whether the core
/// holds still, and tell the page, without waiting for env_loop's next second.
fn power_changed(app: &AppHandle, shared: &Shared) {
    let (on_battery, energy_saver) = platform::power();
    let reduce = platform::reduce_motion();
    let changed = {
        let mut a = shared.lock().unwrap();
        let still = policy::hold_still(a.settings.battery_saver, on_battery, energy_saver, &a.seen, reduce);
        let changed = still != a.still;
        a.still = still;
        if changed {
            log_still(&a, on_battery, energy_saver, reduce, "power notification");
        } else {
            mlog!("power now: on battery {}, energy saver {} ({:?}); core {}", on_battery, energy_saver, platform::power_report(), if still { "holds still" } else { "moves" });
        }
        changed
    };
    if changed {
        let sh = shared.clone();
        on_main(app, move |app| {
            let key = current_monitor_key(app, &sh);
            let payload = page_state(&sh.lock().unwrap(), &key, false);
            let _ = app.emit_to(MAIN, "joya://state", payload);
        });
    }
}

/// Every second the main thread is asked to stamp a heartbeat; if it has not for more than
/// 2 s, the stall is logged (and when it ends, how long it lasted). Windows calls a window
/// that stops answering "Not Responding" after 5 s; this says when, and around what.
fn watchdog(app: AppHandle) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static BEAT: AtomicU64 = AtomicU64::new(0);
    let t0 = Instant::now();
    let now_ms = move || t0.elapsed().as_millis() as u64;
    BEAT.store(now_ms(), Ordering::Relaxed);
    let mut stalled_since: Option<u64> = None;
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        let n = now_ms();
        let _ = app.run_on_main_thread(move || BEAT.store(t0.elapsed().as_millis() as u64, Ordering::Relaxed));
        let last = BEAT.load(Ordering::Relaxed);
        let lag = n.saturating_sub(last);
        match (lag > 2000, stalled_since) {
            (true, None) => {
                stalled_since = Some(last);
                mlog!("WATCHDOG: the main thread has not answered for {} ms", lag);
            }
            (true, Some(_)) if lag % 10000 < 1000 => mlog!("WATCHDOG: still stalled, {} ms", lag),
            (false, Some(since)) => {
                mlog!("WATCHDOG: the main thread answered again after {} ms", n.saturating_sub(since));
                stalled_since = None;
            }
            _ => {}
        }
    }
}

/// The local pages (dist/): on Windows Tauri serves them at http://tauri.localhost.
fn local_url(u: &Url) -> Url {
    if cfg!(windows) {
        let mut x = Url::parse("http://tauri.localhost/").unwrap();
        x.set_path(u.path());
        x.set_query(u.query());
        x
    } else {
        u.clone()
    }
}

fn wallpaper_ink(app: &AppHandle, shared: &Shared, w: &WebviewWindow) -> Option<Ink> {
    let (l, t, r, btm) = platform::window_rect(hwnd(w))?;
    let pos = PhysicalPosition::new(l, t);
    let size = PhysicalSize::new((r - l).max(0) as u32, (btm - t).max(0) as u32);
    let (cx, cy) = (pos.x + size.width as i32 / 2, pos.y + size.height as i32 / 2);
    let m = app.monitor_from_point(cx as f64, cy as f64).ok().flatten()?;
    let (mx, my, mw, mh) = (m.position().x as f64, m.position().y as f64, m.size().width as f64, m.size().height as f64);
    // The part of the wallpaper under the core: the window's middle third.
    let fx0 = (pos.x as f64 + size.width as f64 / 3.0 - mx) / mw;
    let fx1 = (pos.x as f64 + size.width as f64 * 2.0 / 3.0 - mx) / mw;
    let fy0 = (pos.y as f64 + size.height as f64 / 4.0 - my) / mh;
    let fy1 = (pos.y as f64 + size.height as f64 * 3.0 / 4.0 - my) / mh;
    let sig = format!("{:?}{}{}{}{}", platform_wallpaper_sig(), fx0 as f32, fx1 as f32, fy0 as f32, fy1 as f32);
    {
        let mut a = shared.lock().unwrap();
        if a.wallpaper_sig == sig {
            return None;
        }
        a.wallpaper_sig = sig;
    }
    platform::wallpaper_ink(fx0, fy0, fx1, fy1)
}

#[cfg(windows)]
fn platform_wallpaper_sig() -> Option<(String, Option<std::time::SystemTime>)> {
    let p = platform::wallpaper_path()?;
    let t = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
    Some((p, t))
}
#[cfg(not(windows))]
fn platform_wallpaper_sig() -> Option<(String, Option<std::time::SystemTime>)> {
    None
}

/* ------------------------------------------------------------------ run */

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch (the Start menu, autostart twice): show the one that runs.
            let shared = app.state::<Shared>().inner().clone();
            show(app, &shared, true);
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, sc, ev| on_hotkey(app, sc, ev.state)).build())
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_hit_regions,
            set_blur_rects,
            set_status,
            needs_you,
            hide_peek,
            start_drag,
            tool,
            set_glance,
            companion,
            presence_status,
            presence_off,
            open_full_cc,
            go_site,
            webauthn_ceremony,
            page_ready,
            browser_signin,
            settings_get,
            settings_set,
            settings_close,
            settings_check_update,
            machine::machine_status,
            machine::machine_link,
            machine::machine_unlink,
            machine::machine_claude_check,

        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let log_path = log::init();
            std::panic::set_hook(Box::new(|info| {
                mlog!("PANIC: {}", info);
            }));
            mlog!("JOYA AI {} starting (log {:?})", VERSION, log_path);
            let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
            let path = dir.join("settings.json");
            let settings = std::fs::read_to_string(&path).map(|s| Settings::from_json(&s)).unwrap_or_default();
            let first_run = !path.exists();
            let shared: Shared = Arc::new(Mutex::new(App {
                peek_open: false,
                settings,
                settings_path: path,
                regions: Vec::new(),
                dpr: 1.0,
                hidden: false,
                state: "idle".into(),
                needs: 0,
                sessions: 0,
                ink: Ink::Light,
                still: false,
                talk_key: settings::DEFAULT_TALK.into(),
                talk_fallback: false,
                live_key: settings::DEFAULT_LIVE.into(),
                live_fallback: false,
                talking: false,
                key_seq: 0,
                pressed_at: None,
                signed_in: false,
                behind_icons: false,
                raised_for_desktop: false,
                ceremony: false,
                ignoring: None,
                dragging: None,
                last_moved: None,
                awaiting_ready: None,
                update: None,
                monitors_sig: String::new(),
                fullscreen_note: String::new(),
                wallpaper_sig: String::new(),
                seen: policy::Seen::default(),
                toasted: Vec::new(),
                comp: companion_host::CompState::default(),
                cam_in_use: false,
                cam_off_at: None,
                meeting: false,
                on_battery: false,
                energy_saver: false,
            }));
            app.manage(shared.clone());
            machine::setup(&handle);
            if first_run {
                save(&shared);
            }
            let (site, autostart) = {
                let a = shared.lock().unwrap();
                (origin(&a.settings), a.settings.autostart)
            };
            set_autostart(&handle, autostart);

            // The window: transparent, frameless, no taskbar button (the tray is its home), not focused on start.
            // It starts on the local card (dist/index.html), which goes to the site once it answers.
            let site_nav = site.clone();
            let h_nav = handle.clone();
            let w = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("JOYA AI")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .focused(false)
                .visible(false)
                .user_agent(&user_agent())
                .zoom_hotkeys_enabled(false)
                // wry's own defaults, plus: audio may start without a click in the page. Hold-to-talk starts a
                // call from the hotkey (an event, not a user gesture); Chromium lets audio run once the microphone
                // is open, but this window only ever shows the site, so nothing is lost by not depending on that.
                .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required")
                .on_navigation(move |u| {
                    // Locked to the site (and the app's own pages). Anything else opens in the browser.
                    let local = u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost");
                    // Scheme, host and path only: the query can carry a sign-in code.
                    mlog!("navigate {}://{}{}", u.scheme(), u.host_str().unwrap_or(""), u.path());
                    if local || same_site(u, &site_nav) {
                        if !local {
                            if let Some(s) = h_nav.try_state::<Shared>() {
                                s.lock().unwrap().awaiting_ready = Some(Instant::now());
                            }
                        }
                        return true;
                    }
                    open_url(u.as_str());
                    false
                })
                .on_new_window(|u, _| {
                    open_url(u.as_str());
                    NewWindowResponse::Deny
                })
                .on_permission_request({
                    let site = site.clone();
                    move |wv, kind| {
                        // The microphone, for the site only (voice); the camera for the site only while camera
                        // presence is on (eye contact, presence.rs); nothing else is granted.
                        let ours = wv.url().map(|u| same_site(&u, &site)).unwrap_or(false);
                        let camera_on = wv.app_handle().try_state::<Shared>().map(|s| s.lock().unwrap().settings.presence.camera).unwrap_or(false);
                        let ask = match kind {
                            PermissionKind::Microphone => presence::Ask::Microphone,
                            PermissionKind::Camera => presence::Ask::Camera,
                            PermissionKind::ClipboardRead => presence::Ask::ClipboardRead,
                            _ => presence::Ask::Other,
                        };
                        let ans = presence::permission(ask, ours, camera_on);
                        if ask == presence::Ask::Camera {
                            mlog!("camera requested by the {}: {}", if ours { "site" } else { "page (not the site)" }, if ans == presence::Answer::Allow { "allowed (camera presence is on)" } else { "refused" });
                        }
                        match ans {
                            presence::Answer::Allow => PermissionResponse::Allow,
                            presence::Answer::Deny => PermissionResponse::Deny,
                            presence::Answer::Default => PermissionResponse::Default,
                        }
                    }
                })
                .build()?;
            let _ = w.set_ignore_cursor_events(true);
            shared.lock().unwrap().ignoring = Some(true);
            blur_init(&handle, &w);
            // Eye contact: camera requests are never kept, and the profile's camera permission follows the setting.
            camera_once(&w);
            camera_profile(&handle, &shared);

            // A dragged Floating box: note each move (hit_loop snaps it when the moves stop).
            let sh = shared.clone();
            let h2 = handle.clone();
            w.on_window_event(move |ev| match ev {
                tauri::WindowEvent::Moved(_) => {
                    let mut a = sh.lock().unwrap();
                    if a.dragging.is_some() {
                        a.last_moved = Some(Instant::now());
                    }
                }
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    let dragging = sh.lock().unwrap().dragging.is_some();
                    if !dragging {
                        apply(&h2, &sh, false);
                    }
                }
                _ => {}
            });

            // The tray: the bot icon (icons/32x32.png), a click shows the menu (either button).
            let menu = build_menu(&handle, &shared)?;
            let (base, iw, ih) = tray_base();
            let _tray: TrayIcon = TrayIconBuilder::with_id("main")
                .icon(tauri::image::Image::new_owned(base, iw, ih))
                .tooltip("JOYA AI")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
                .build(app)?;

            register_hotkeys(&handle, &shared);
            apply(&handle, &shared, false);
            {
                let (a1, s1) = (handle.clone(), shared.clone());
                std::thread::spawn(move || hit_loop(a1, s1));
                let (a2, s2) = (handle.clone(), shared.clone());
                std::thread::spawn(move || env_loop(a2, s2));
                let a3 = handle.clone();
                std::thread::spawn(move || watchdog(a3));
                // Companion mode: the bot's own loop (idle in the other modes).
                let (a5, s5) = (handle.clone(), shared.clone());
                std::thread::spawn(move || companion_host::run(a5, s5));
                // Power: told by Windows, not only polled; and not slowed down by Energy saver itself.
                mlog!("power throttling (EcoQoS) off for this process: {}", platform::keep_full_speed());
                let (a4, s4) = (handle.clone(), shared.clone());
                platform::watch_power(Box::new(move || power_changed(&a4, &s4)));
                mlog!("power at start: {:?}", platform::power_report());
            }
            if shared.lock().unwrap().settings.check_updates {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(30));
                    check_update(h);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running JOYA AI")
        .run(|_app, ev| {
            if let tauri::RunEvent::Exit = ev {
                machine::on_exit();
            }
        });
}
