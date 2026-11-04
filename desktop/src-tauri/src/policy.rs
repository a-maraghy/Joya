//! Small decisions, pure so they can be tested: when a Windows toast is shown,
//! the tray dot's colour, when the core holds still.

use crate::layout::Mode;

/// What the app knows about whether you can see JOYA AI right now.
#[derive(Clone, Copy, Debug, Default)]
pub struct Seen {
    pub mode: Option<Mode>,
    /// Peek is showing.
    pub peek_open: bool,
    pub focus: bool,
    /// Floating hidden with its tool (Ctrl+Alt+M brings it back), or the window hidden for any reason.
    pub hidden: bool,
    /// Desktop layer: another window is in front (the foreground window is not the desktop or JOYA AI).
    pub covered: bool,
    /// A full-screen app or game, or presentation mode.
    pub fullscreen: bool,
    /// The workstation is locked.
    pub locked: bool,
}

/// A toast only when JOYA AI cannot be seen (DESIGN.md "Toasts"), and never in do-not-disturb.
pub fn should_toast(s: &Seen, dnd: bool) -> bool {
    if dnd {
        return false;
    }
    if s.hidden || s.focus || s.fullscreen || s.locked {
        return true;
    }
    match s.mode {
        Some(Mode::Floating) => false,
        Some(Mode::Peek) => !s.peek_open,
        Some(Mode::Desktop) => s.covered,
        // The bot on the taskbar or a window can be seen unless it ducked out (hidden, full screen, locked).
        Some(Mode::Companion) => false,
        None => true,
    }
}

/// The tray dot: amber when something needs you, green while it listens or speaks,
/// violet while it thinks or delegates, grey when offline or signed out, none when idle.
pub fn tray_dot(state: &str, needs: u32) -> Option<[u8; 3]> {
    match state {
        "offline" | "signedout" => Some([0x8A, 0x8F, 0x99]),
        _ if needs > 0 || state == "needs" => Some([0xFA, 0xBD, 0x4D]),
        "listening" | "speaking" => Some([0x00, 0xE6, 0xA5]),
        "thinking" | "delegating" => Some([0xA7, 0x6B, 0xFF]),
        _ => None,
    }
}

/// The tray tooltip / menu header line.
pub fn status_line(state: &str, needs: u32, sessions: u32) -> String {
    match state {
        "signedout" => "Signed out".into(),
        "offline" => "Offline · retrying".into(),
        _ => {
            let s = if sessions == 1 { "1 session".to_string() } else { format!("{} sessions", sessions) };
            if needs > 0 {
                format!("{} waiting on you · {}", needs, s)
            } else {
                let st = match state {
                    "listening" => "Listening",
                    "speaking" => "Speaking",
                    "thinking" => "Thinking",
                    "delegating" => "Handing over",
                    _ => "Ready",
                };
                format!("{} · {}", st, s)
            }
        }
    }
}

/// The core holds still (one frame per change, no GPU work between): battery saver on battery or with
/// Windows' energy saver; always while a full-screen app or game runs, the screen is locked, Windows'
/// "Animation effects" are off, or the window is hidden or (Desktop layer) covered by another window.
pub fn hold_still(battery_saver: bool, on_battery: bool, energy_saver: bool, s: &Seen, reduce_motion: bool) -> bool {
    (battery_saver && (on_battery || energy_saver)) || s.fullscreen || s.locked || reduce_motion || s.hidden || s.covered || (s.mode == Some(Mode::Peek) && !s.peek_open)
}

/// A mode picked from the tray while the window was hidden (Peek sent away with Esc, Floating hidden
/// with its tool): it must show at once, on top and focused -- what "Show JOYA AI" does -- and the
/// Desktop layer then goes down to the bottom when another window takes the focus. Shown plainly at
/// the bottom of the stack, it stayed out of sight (laptop test, 2026-10-08).
pub fn reveal_after_mode_change(was_visible: bool, mode: Mode) -> bool {
    !was_visible && mode != Mode::Peek
}

/// What Windows says about power, as the notifications (platform::watch_power) and the
/// fallback poll (GetSystemPowerStatus) report it. None: not heard from that source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PowerReport {
    /// GUID_ACDC_POWER_SOURCE: 0 AC, 1 battery (DC), 2 short-term (a UPS).
    pub acdc: Option<u32>,
    /// GUID_ENERGY_SAVER_STATUS (Windows 11 22H2+): 0 off, 1 standard, 2 high savings.
    pub energy_saver: Option<u32>,
    /// GUID_POWER_SAVING_STATUS (the older battery saver): 0 off, 1 on.
    pub power_saving: Option<u32>,
    /// SYSTEM_POWER_STATUS.ACLineStatus: 0 offline, 1 online, 255 unknown.
    pub ac_line: Option<u8>,
    /// SYSTEM_POWER_STATUS.SystemStatusFlag: 1 battery saver on.
    pub status_flag: Option<u8>,
}

/// (on battery, Windows' energy saver / battery saver on). The notifications win over the poll;
/// Windows 11's Energy saver status wins over the older battery-saver status, which is what
/// SystemStatusFlag mirrors (and which may not follow Energy saver).
pub fn power_state(r: &PowerReport) -> (bool, bool) {
    let on_battery = match (r.acdc, r.ac_line) {
        (Some(v), _) => v != 0,
        (None, Some(l)) => l == 0,
        (None, None) => false,
    };
    let saver = match (r.energy_saver, r.power_saving, r.status_flag) {
        (Some(v), _, _) => v != 0,
        (None, Some(v), _) => v != 0,
        (None, None, Some(f)) => f == 1,
        _ => false,
    };
    (on_battery, saver)
}

/// What SHQueryUserNotificationState said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quns {
    /// Accepting notifications, quiet hours, the lock screen, an app's own "do not disturb": nothing for us.
    Other,
    /// QUNS_BUSY: "a full-screen application is running or Presentation Settings are applied" -- on ANY
    /// monitor, and some apps raise it with nothing visibly full screen. Never trusted on its own.
    Busy,
    /// QUNS_RUNNING_D3D_FULL_SCREEN: a game (or other Direct3D app) in exclusive full-screen mode.
    D3dFullScreen,
    /// QUNS_PRESENTATION_MODE: Windows' presentation settings are on.
    Presentation,
}

impl Quns {
    pub fn as_str(&self) -> &'static str {
        match self {
            Quns::Other => "accepting notifications",
            Quns::Busy => "busy",
            Quns::D3dFullScreen => "Direct3D full screen",
            Quns::Presentation => "presentation mode",
        }
    }
}

/// (left, top, right, bottom) in screen pixels.
pub type Rect = (i32, i32, i32, i32);

/// The foreground window, as far as the full-screen check needs it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrontWin {
    /// The window itself (HWND as a number; 0 unknown): when it changes, the companion puts itself on top again.
    pub hwnd: isize,
    /// Its root owner's window class.
    pub class: String,
    /// JOYA AI's own window.
    pub ours: bool,
    /// WS_EX_TOOLWINDOW (floating palettes, overlays): never "full screen".
    pub tool: bool,
    /// The monitor it is on (HMONITOR; 0 unknown).
    pub monitor: isize,
    /// Its visible bounds (DWM's extended frame bounds, else the window rectangle).
    pub rect: Rect,
    /// The whole of its monitor (not the work area).
    pub monitor_rect: Rect,
    /// Maximized with a title bar: an ordinary maximized window (the taskbar may be hidden), not full screen.
    pub captioned_max: bool,
}

/// The desktop and the shell's own windows: the wallpaper / icon layer, the taskbars, Start and search.
pub fn is_shell_class(class: &str) -> bool {
    matches!(class, "WorkerW" | "Progman" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "SHELLDLL_DefView" | "Windows.UI.Core.CoreWindow" | "XamlExplorerHostIslandWindow" | "")
}

impl FrontWin {
    /// Someone else's app window (not ours, not the shell, not a tool window).
    pub fn is_app(&self) -> bool {
        !self.ours && !self.tool && !is_shell_class(&self.class)
    }
    /// Known to be on a monitor other than JOYA AI's.
    pub fn elsewhere(&self, our_monitor: isize) -> bool {
        self.monitor != 0 && our_monitor != 0 && self.monitor != our_monitor
    }
    /// Covers the whole of JOYA AI's monitor.
    pub fn covers(&self, our_monitor: isize) -> bool {
        let (r, m) = (self.rect, self.monitor_rect);
        self.is_app() && self.monitor != 0 && self.monitor == our_monitor && !self.captioned_max && m.2 > m.0 && m.3 > m.1 && r.0 <= m.0 && r.1 <= m.1 && r.2 >= m.2 && r.3 >= m.3
    }
}

/// Does a full-screen app hold the core still? Some(why) when it does.
///
/// Only something full screen on JOYA AI's own monitor counts: a window there that covers the whole
/// monitor; a Direct3D exclusive full screen or presentation mode, unless the window in front is known
/// to be on another monitor (a game on the second screen leaves the core moving). Windows' "busy" alone
/// never does -- it is raised for a full-screen app on any monitor, and by some apps with nothing full
/// screen at all (the frozen core of 2026-10-19: laptop + second monitor, the desktop in front).
pub fn fullscreen_hold(q: Quns, fg: Option<&FrontWin>, our_monitor: isize) -> Option<String> {
    if let Some(f) = fg {
        if f.covers(our_monitor) {
            return Some(format!("a full-screen window ({}) covers JOYA AI's monitor; Windows says {}", f.class, q.as_str()));
        }
    }
    let app_elsewhere = fg.map(|f| f.is_app() && f.elsewhere(our_monitor)).unwrap_or(false);
    match q {
        // An exclusive game is the window in front: with the desktop or JOYA AI there, it is not running.
        Quns::D3dFullScreen if !app_elsewhere && fg.map(|f| f.is_app()).unwrap_or(true) => {
            Some(format!("Windows says Direct3D full screen; the app in front ({}) is on JOYA AI's monitor or its monitor is unknown", fg.map(|f| f.class.as_str()).unwrap_or("unknown")))
        }
        Quns::Presentation if !app_elsewhere => Some("Windows' presentation mode is on".into()),
        _ => None,
    }
}

/// Desktop layer: is JOYA AI covered by the window in front? An app window in front on another monitor
/// does not cover it; where the monitors are unknown it is taken as covering (as before).
pub fn front_covers(front_other: bool, fg: Option<&FrontWin>, our_monitor: isize) -> bool {
    front_other && !fg.map(|f| f.elsewhere(our_monitor)).unwrap_or(false)
}

/// The log line for a full-screen decision (logged once per change, not every second).
pub fn fullscreen_note(q: Quns, why: &Option<String>) -> String {
    match why {
        Some(w) => format!("holds still for full screen: {}", w),
        None if q == Quns::Other => "no full screen".into(),
        None => format!("Windows says {}, ignored: nothing full screen on JOYA AI's monitor", q.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(mode: Mode) -> Seen {
        Seen { mode: Some(mode), ..Seen::default() }
    }

    #[test]
    fn toasts_only_when_it_cannot_be_seen() {
        assert!(!should_toast(&seen(Mode::Floating), false));
        assert!(should_toast(&Seen { hidden: true, ..seen(Mode::Floating) }, false));
        assert!(should_toast(&seen(Mode::Peek), false));
        assert!(!should_toast(&Seen { peek_open: true, ..seen(Mode::Peek) }, false));
        assert!(!should_toast(&seen(Mode::Desktop), false));
        assert!(should_toast(&Seen { covered: true, ..seen(Mode::Desktop) }, false));
        assert!(should_toast(&Seen { focus: true, ..seen(Mode::Floating) }, false));
        assert!(should_toast(&Seen { fullscreen: true, ..seen(Mode::Floating) }, false));
        assert!(should_toast(&Seen { locked: true, ..seen(Mode::Floating) }, false));
        // Companion: seen while it is out; a toast when it ducked out (hidden) for a full-screen app.
        assert!(!should_toast(&seen(Mode::Companion), false));
        assert!(should_toast(&Seen { hidden: true, ..seen(Mode::Companion) }, false));
        assert!(should_toast(&Seen { fullscreen: true, ..seen(Mode::Companion) }, false));
    }

    #[test]
    fn do_not_disturb_silences_toasts() {
        assert!(!should_toast(&Seen { covered: true, ..seen(Mode::Desktop) }, true));
        assert!(!should_toast(&seen(Mode::Peek), true));
    }

    #[test]
    fn tray_dot_colours() {
        assert_eq!(tray_dot("idle", 0), None);
        assert_eq!(tray_dot("idle", 1), Some([0xFA, 0xBD, 0x4D]));
        assert_eq!(tray_dot("speaking", 0), Some([0x00, 0xE6, 0xA5]));
        assert_eq!(tray_dot("delegating", 0), Some([0xA7, 0x6B, 0xFF]));
        assert_eq!(tray_dot("offline", 3), Some([0x8A, 0x8F, 0x99]));
        assert_eq!(tray_dot("signedout", 0), Some([0x8A, 0x8F, 0x99]));
    }

    #[test]
    fn status_lines() {
        assert_eq!(status_line("idle", 0, 7), "Ready · 7 sessions");
        assert_eq!(status_line("thinking", 1, 7), "1 waiting on you · 7 sessions");
        assert_eq!(status_line("idle", 0, 1), "Ready · 1 session");
        assert_eq!(status_line("signedout", 0, 0), "Signed out");
    }

    #[test]
    fn still_core() {
        let s = seen(Mode::Floating);
        assert!(!hold_still(true, false, false, &s, false));
        assert!(hold_still(true, true, false, &s, false));
        assert!(!hold_still(false, true, false, &s, false));
        assert!(hold_still(false, false, false, &Seen { fullscreen: true, ..s }, false));
        assert!(hold_still(false, false, false, &Seen { covered: true, ..seen(Mode::Desktop) }, false));
        assert!(hold_still(false, false, false, &Seen { locked: true, ..s }, false));
        assert!(hold_still(false, false, false, &s, true));
        assert!(hold_still(false, false, false, &seen(Mode::Peek), false));
    }

    /// The four power cases the laptop test walks: on battery or plugged in, Energy saver on or off,
    /// with the app's Battery saver on (it holds still on any of them but plugged-in-without-saver)
    /// and off (power never holds it still).
    #[test]
    fn still_core_power_cases() {
        let s = seen(Mode::Desktop);
        let case = |acdc: u32, es: u32| power_state(&PowerReport { acdc: Some(acdc), energy_saver: Some(es), ..Default::default() });
        let cases = [((1, 1), true), ((1, 0), true), ((0, 1), true), ((0, 0), false)];
        for ((acdc, es), want) in cases {
            let (bat, saver) = case(acdc, es);
            assert_eq!(bat, acdc == 1);
            assert_eq!(saver, es == 1);
            assert_eq!(hold_still(true, bat, saver, &s, false), want, "battery saver on, acdc {} energy saver {}", acdc, es);
            assert!(!hold_still(false, bat, saver, &s, false), "battery saver off, acdc {} energy saver {}", acdc, es);
        }
        // Energy saver's "high savings" is on too; a UPS counts as battery.
        assert_eq!(case(0, 2), (false, true));
        assert_eq!(case(2, 0), (true, false));
    }

    #[test]
    fn power_sources_in_order() {
        // Nothing heard: plugged in, no saver.
        assert_eq!(power_state(&PowerReport::default()), (false, false));
        // Only the poll (notifications not registered yet): ACLineStatus and SystemStatusFlag.
        assert_eq!(power_state(&PowerReport { ac_line: Some(0), status_flag: Some(1), ..Default::default() }), (true, true));
        assert_eq!(power_state(&PowerReport { ac_line: Some(255), status_flag: Some(0), ..Default::default() }), (false, false));
        // The notification wins over the poll (the poll can lag, or not follow Energy saver at all).
        assert_eq!(power_state(&PowerReport { acdc: Some(1), ac_line: Some(1), energy_saver: Some(1), status_flag: Some(0), ..Default::default() }), (true, true));
        assert_eq!(power_state(&PowerReport { acdc: Some(0), ac_line: Some(0), energy_saver: Some(0), status_flag: Some(1), ..Default::default() }), (false, false));
        // Before Windows 11 22H2 (no Energy saver status): the older battery-saver status.
        assert_eq!(power_state(&PowerReport { acdc: Some(1), power_saving: Some(1), status_flag: Some(0), ..Default::default() }), (true, true));
        assert_eq!(power_state(&PowerReport { acdc: Some(1), power_saving: Some(0), status_flag: Some(1), ..Default::default() }), (true, false));
    }

    #[test]
    fn mode_switch_from_hidden_shows_it() {
        // Peek hidden (Esc), then "On the desktop": shown and raised until something else takes the focus.
        assert!(reveal_after_mode_change(false, Mode::Desktop));
        assert!(reveal_after_mode_change(false, Mode::Floating));
        // Peek itself opens on top anyway; a visible window is left as it is.
        assert!(!reveal_after_mode_change(false, Mode::Peek));
        assert!(!reveal_after_mode_change(true, Mode::Desktop));
        assert!(!reveal_after_mode_change(true, Mode::Floating));
    }
    fn win(class: &str, monitor: isize, rect: Rect) -> FrontWin {
        FrontWin { class: class.into(), monitor, rect, monitor_rect: (0, 0, 1920, 1080), ..Default::default() }
    }

    #[test]
    fn busy_alone_never_holds_still() {
        // The 2026-10-19 log: Windows says busy, the desktop (or JOYA AI itself) in front.
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&win("WorkerW", 1, (0, 0, 1920, 1080))), 1), None);
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&win("Progman", 1, (0, 0, 1920, 1080))), 1), None);
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&FrontWin { ours: true, ..win("Tauri", 1, (0, 0, 1920, 1080)) }), 1), None);
        assert_eq!(fullscreen_hold(Quns::Busy, None, 1), None);
        // An ordinary window in front, not covering the monitor.
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&win("Chrome_WidgetWin_1", 1, (100, 100, 1200, 900))), 1), None);
        // A full-screen video on the second monitor.
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&FrontWin { monitor_rect: (1920, 0, 3840, 1080), ..win("Chrome_WidgetWin_1", 2, (1920, 0, 3840, 1080)) }), 1), None);
    }

    #[test]
    fn full_screen_on_our_monitor_holds_still() {
        let f = win("Chrome_WidgetWin_1", 1, (0, 0, 1920, 1080));
        assert!(fullscreen_hold(Quns::Busy, Some(&f), 1).is_some());
        // Even when Windows does not say so (and with bounds a few px larger than the monitor).
        assert!(fullscreen_hold(Quns::Other, Some(&win("UnityWndClass", 1, (-1, -1, 1921, 1081))), 1).is_some());
        // A maximized window with a title bar (hidden taskbar): not full screen.
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&FrontWin { captioned_max: true, ..f.clone() }), 1), None);
        // A tool window or the shell covering the screen: not an app.
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&FrontWin { tool: true, ..f.clone() }), 1), None);
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&win("Shell_TrayWnd", 1, (0, 0, 1920, 1080))), 1), None);
        // One pixel short of the monitor: not full screen.
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&win("X", 1, (0, 0, 1920, 1079))), 1), None);
        // Our monitor unknown: no window can be said to cover it.
        assert_eq!(fullscreen_hold(Quns::Busy, Some(&f), 0), None);
    }

    #[test]
    fn d3d_and_presentation_only_on_our_monitor() {
        let game_here = win("GameWnd", 1, (0, 0, 1280, 720));
        let game_there = FrontWin { monitor_rect: (1920, 0, 3840, 1080), ..win("GameWnd", 2, (1920, 0, 3200, 720)) };
        assert!(fullscreen_hold(Quns::D3dFullScreen, Some(&game_here), 1).is_some());
        assert!(fullscreen_hold(Quns::D3dFullScreen, None, 1).is_some());
        assert_eq!(fullscreen_hold(Quns::D3dFullScreen, Some(&game_there), 1), None);
        // The desktop in front: no exclusive game is.
        assert_eq!(fullscreen_hold(Quns::D3dFullScreen, Some(&win("WorkerW", 1, (0, 0, 1920, 1080))), 1), None);
        assert!(fullscreen_hold(Quns::Presentation, Some(&game_here), 1).is_some());
        assert!(fullscreen_hold(Quns::Presentation, Some(&win("WorkerW", 1, (0, 0, 1920, 1080))), 1).is_some());
        assert_eq!(fullscreen_hold(Quns::Presentation, Some(&game_there), 1), None);
        assert_eq!(fullscreen_hold(Quns::Other, Some(&game_here), 1), None);
    }

    #[test]
    fn covered_only_from_our_monitor() {
        let here = win("Notepad", 1, (0, 0, 800, 600));
        let there = win("Notepad", 2, (2000, 0, 2800, 600));
        assert!(front_covers(true, Some(&here), 1));
        assert!(!front_covers(true, Some(&there), 1));
        assert!(front_covers(true, Some(&there), 0)); // our monitor unknown: as before
        assert!(front_covers(true, None, 1));
        assert!(!front_covers(false, Some(&here), 1));
    }

    #[test]
    fn full_screen_notes() {
        assert_eq!(fullscreen_note(Quns::Other, &None), "no full screen");
        assert_eq!(fullscreen_note(Quns::Busy, &None), "Windows says busy, ignored: nothing full screen on JOYA AI's monitor");
        assert!(fullscreen_note(Quns::Busy, &Some("x".into())).starts_with("holds still for full screen: x"));
    }
}
