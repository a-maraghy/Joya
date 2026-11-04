//! Companion mode, made simple (user, 2026-10-21: "I just want the core showing at the centre top of the
//! screen, on top of all apps, always"). It replaces the 0.1.12 desk companion (perching on the taskbar or
//! the window in front, walking and hopping, stepping aside, the session bots gathering).
//!
//! The bot -- core E with the user's head and colours -- sits in one small topmost window at the top centre
//! of the work area of the monitor you are working on: the monitor of the window in front, else the cursor's
//! (or one monitor, with "stay on this monitor"). Switching monitors it fades out and back in on the other one
//! (no walk). It ducks out of full-screen video and games on its monitor and comes back after.
//!
//! Pure: monitors, the window in front and the cursor in; which monitor, where the window goes, when to fade
//! across, whether to duck. The app (companion_host.rs) reads Windows (platform.rs: monitor rectangles and
//! DPI, the window in front -- never what is in a window) and places the window.
//!
//! Coordinates are physical pixels (the monitors'), as Windows places windows; the sizes below are logical px
//! and scale with each monitor's DPI. The page (dashboard/public/joya-desktop-companion.js) draws the bot in
//! the window with the same numbers (dashboard/tools/test-desktop-companion.cjs checks both files).

use crate::layout::Rect;

/// The companion window: the bot at the top, room under it for the "Click to open" hint and eye contact's
/// "Camera on" pill.
pub const WIN_W: f64 = 176.0;
pub const WIN_H: f64 = 160.0;
/// The bot's hit circle (its head and backplate, about 104 px across): this radius, its centre this far below
/// the window's top (which is the work area's top).
pub const BODY_R: f64 = 52.0;
pub const BODY_CY: f64 = 66.0;
/// A new monitor must stay the active one this long before the bot moves (a quick Alt+Tab, a cursor passing).
pub const SETTLE_MS: u64 = 250;
/// The quick fade out before it moves to another monitor (and before it ducks out); the page fades back in.
pub const FADE_MS: u64 = 160;

/// A monitor: its whole rectangle, its work area (without the taskbar) and its scale (DPI / 96).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Monitor {
    pub id: isize,
    pub rect: Rect,
    pub work: Rect,
    pub scale: f64,
}

/// The window in front, as far as following goes: its monitor and what kind of window it is.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Front {
    pub hwnd: isize,
    pub monitor: isize,
    /// Someone else's app window (not JOYA AI, not the shell, not a tool window).
    pub app: bool,
    /// Full screen on its monitor (policy::FrontWin::covers).
    pub fullscreen: bool,
}

fn sc(s: f64) -> f64 {
    if s.is_finite() && s > 0.25 && s < 8.0 {
        s
    } else {
        1.0
    }
}
fn lp(v: f64, s: f64) -> i32 {
    (v * sc(s)).round() as i32
}

/// The window's size on a monitor of this scale (physical px).
pub fn window_size(scale: f64) -> (u32, u32) {
    (lp(WIN_W, scale) as u32, lp(WIN_H, scale) as u32)
}

/// Where the window goes on a monitor: centred on its work area, against the work area's top (under a top
/// taskbar, never over it).
pub fn window_rect(mon: &Monitor) -> Rect {
    let (w, h) = window_size(mon.scale);
    let wk = mon.work;
    Rect { x: wk.x + (wk.w as i32 - w as i32) / 2, y: wk.y, w, h }
}

/// The bot's hit circle (centre, radius) for the window at `win`, drawn at this scale.
pub fn body(win: &Rect, scale: f64) -> (i32, i32, i32) {
    (win.x + win.w as i32 / 2, win.y + lp(BODY_CY, scale), lp(BODY_R, scale))
}

/// The monitor it lives on: the one it is told to stay on (if still there); else the active one -- the window
/// in front's, or the cursor's when the desktop itself is in front; else where it is; else the first. A
/// full-screen window is not followed: the bot stays where it is (and ducks out only if that is its monitor).
pub fn pick_monitor<'a>(mons: &'a [Monitor], front: Option<&Front>, cursor: Option<(i32, i32)>, stay: Option<isize>, current: isize) -> Option<&'a Monitor> {
    let by_id = |id: isize| mons.iter().find(|m| m.id == id && id != 0);
    if let Some(m) = stay.and_then(by_id) {
        return Some(m);
    }
    if front.map(|f| f.fullscreen).unwrap_or(false) {
        return by_id(current).or_else(|| mons.first());
    }
    if let Some(m) = front.filter(|f| f.app).and_then(|f| by_id(f.monitor)) {
        return Some(m);
    }
    if front.map(|f| !f.app).unwrap_or(true) {
        if let Some((x, y)) = cursor {
            if let Some(m) = mons.iter().find(|m| m.rect.contains(x, y)) {
                return Some(m);
            }
        }
    }
    by_id(current).or_else(|| mons.first())
}

/// Moving to another monitor: the new one must hold for SETTLE_MS, then the page fades out (FADE_MS), then
/// the window is placed there (the page fades back in). Holding still: no fade, it is placed at once.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Switch {
    /// A different monitor became the active one, and since when.
    pending: Option<(isize, u64)>,
    /// Fading out toward this monitor, since when.
    fading: Option<(isize, u64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwitchOut {
    Nothing,
    /// Tell the page to fade out; the move follows after FADE_MS.
    FadeOut(isize),
    /// Place the window on this monitor now (and tell the page to fade back in).
    Place(isize),
}

impl Switch {
    pub fn fading(&self) -> bool {
        self.fading.is_some()
    }
    pub fn tick(&mut self, now: u64, current: isize, target: isize, still: bool) -> SwitchOut {
        if let Some((m, t)) = self.fading {
            if now.saturating_sub(t) >= FADE_MS {
                self.fading = None;
                self.pending = None;
                return SwitchOut::Place(m);
            }
            return SwitchOut::Nothing;
        }
        if target == current {
            self.pending = None;
            return SwitchOut::Nothing;
        }
        match self.pending {
            Some((m, t)) if m == target => {
                if now.saturating_sub(t) < SETTLE_MS {
                    return SwitchOut::Nothing;
                }
                self.pending = None;
                if still {
                    SwitchOut::Place(target)
                } else {
                    self.fading = Some((target, now));
                    SwitchOut::FadeOut(target)
                }
            }
            _ => {
                self.pending = Some((target, now));
                SwitchOut::Nothing
            }
        }
    }
}

/// One app's use of the camera or microphone, as Windows' privacy settings record it (CapabilityAccessManager
/// ConsentStore: LastUsedTimeStart / LastUsedTimeStop; a stop of 0 after a start means in use now). Eye
/// contact reads it (lib.rs: the page lets go of the camera in a meeting).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapUse {
    pub app: String,
    pub start: u64,
    pub stop: u64,
}

/// Is any app other than JOYA AI using it now? (`ours`: lower-case parts of JOYA AI's own names.)
pub fn in_use(list: &[CapUse], ours: &[&str]) -> bool {
    list.iter().any(|u| {
        let a = u.app.to_ascii_lowercase();
        u.start > 0 && u.stop == 0 && !ours.iter().any(|o| a.contains(o))
    })
}

/// JOYA AI's own entries in those lists: the app and its WebView2 (its voice uses the microphone).
pub const OURS: [&str; 2] = ["joya-desktop", "msedgewebview2"];

/// A meeting (or a recording): a camera in use by another app; or another app's microphone while JOYA AI
/// has no call of its own (its own call would look the same).
pub fn meeting(cam: &[CapUse], mic: &[CapUse], our_call: bool) -> bool {
    in_use(cam, &OURS) || (!our_call && in_use(mic, &OURS))
}

/// Ducks out (hides until it is over): something full screen on its monitor (policy::fullscreen_hold: a
/// full-screen video, a game, presentation mode), or the screen locked. Nothing else hides it.
pub fn duck(fullscreen: Option<&str>, locked: bool) -> Option<String> {
    if locked {
        return Some("the screen is locked".into());
    }
    fullscreen.map(|w| w.to_string())
}

/// How often the loop looks at the windows (ms): 1000 ducked out, 500 holding still, else 150.
pub fn period_ms(still: bool, ducked: bool) -> u64 {
    if ducked {
        1000
    } else if still {
        500
    } else {
        150
    }
}

/// Re-assert "on top of everything" this often (ms), besides each time the window in front changes: another
/// always-on-top window (a picture-in-picture video, Task Manager) can otherwise stay over it.
pub const TOPMOST_MS: u64 = 3000;

#[cfg(test)]
mod tests {
    use super::*;

    // The user's desk: the laptop (1920 x 1200 at 150 %, primary, taskbar at the bottom, 48 logical px = 72
    // physical) and the Samsung LF27T35 to its right (1920 x 1080 at 100 %, its own taskbar).
    const LAPTOP: Monitor = Monitor { id: 1, rect: Rect { x: 0, y: 0, w: 1920, h: 1200 }, work: Rect { x: 0, y: 0, w: 1920, h: 1128 }, scale: 1.5 };
    const SAMSUNG: Monitor = Monitor { id: 2, rect: Rect { x: 1920, y: 0, w: 1920, h: 1080 }, work: Rect { x: 1920, y: 0, w: 1920, h: 1032 }, scale: 1.0 };

    fn app(monitor: isize) -> Front {
        Front { hwnd: 3, monitor, app: true, fullscreen: false }
    }

    #[test]
    fn a_small_window_that_scales_per_monitor() {
        assert_eq!(window_size(1.0), (176, 160));
        assert_eq!(window_size(1.5), (264, 240));
        assert_eq!(window_size(f64::NAN), (176, 160), "a bad scale counts as 100 %");
        // Not a full-screen overlay: a sliver of either monitor.
        let (w, h) = window_size(1.5);
        assert!((w * h) as f64 / (1920.0 * 1200.0) < 0.03);
        // The bot about 96-128 px across (logical).
        assert!((96.0..=128.0).contains(&(2.0 * BODY_R)));
        assert!(BODY_CY - BODY_R >= 6.0 && BODY_CY + BODY_R < WIN_H, "the bot inside the window, a little under its top");
    }

    #[test]
    fn top_centre_of_each_monitor_dpi_correct() {
        // The laptop at 150 %: 264 x 240 physical, centred, against the top.
        let r = window_rect(&LAPTOP);
        assert_eq!(r, Rect { x: (1920 - 264) / 2, y: 0, w: 264, h: 240 });
        let (cx, cy, rr) = body(&r, LAPTOP.scale);
        assert_eq!((cx, cy, rr), (960, 99, 78), "the bot's centre at the monitor's middle; 52 logical px = 78 physical");
        // The Samsung at 100 %: 176 x 160, centred on its own work area.
        let s = window_rect(&SAMSUNG);
        assert_eq!(s, Rect { x: 1920 + (1920 - 176) / 2, y: 0, w: 176, h: 160 });
        assert_eq!(body(&s, 1.0), (1920 + 960, 66, 52));
        // A taskbar at the top: under it, never over it.
        let top = Monitor { work: Rect { x: 0, y: 72, w: 1920, h: 1128 }, ..LAPTOP };
        assert_eq!(window_rect(&top).y, 72);
        // A taskbar on the left: centred on what is left of the screen.
        let left = Monitor { work: Rect { x: 72, y: 0, w: 1848, h: 1200 }, ..LAPTOP };
        let l = window_rect(&left);
        assert_eq!(l.x + l.w as i32 / 2, 72 + 1848 / 2);
        // A monitor left of the primary (negative coordinates) and at 125 %.
        let west = Monitor { id: 3, rect: Rect { x: -2560, y: -200, w: 2560, h: 1440 }, work: Rect { x: -2560, y: -200, w: 2560, h: 1380 }, scale: 1.25 };
        let w = window_rect(&west);
        assert_eq!((w.w, w.h, w.y), (220, 200, -200));
        assert_eq!(w.x + w.w as i32 / 2, -1280);
    }

    #[test]
    fn it_follows_the_active_monitor() {
        let mons = [LAPTOP, SAMSUNG];
        assert_eq!(pick_monitor(&mons, Some(&app(2)), Some((10, 10)), None, 1).unwrap().id, 2, "the window in front's monitor, not the cursor's");
        // The desktop in front: where the cursor is.
        let desk = Front { app: false, ..Front::default() };
        assert_eq!(pick_monitor(&mons, Some(&desk), Some((2500, 500)), None, 1).unwrap().id, 2);
        assert_eq!(pick_monitor(&mons, None, Some((50, 50)), None, 2).unwrap().id, 1);
        // "Stay on this monitor".
        assert_eq!(pick_monitor(&mons, Some(&app(2)), Some((2500, 500)), Some(1), 1).unwrap().id, 1);
        // The monitor it stayed on was unplugged: it follows again.
        assert_eq!(pick_monitor(&mons, Some(&app(2)), None, Some(9), 1).unwrap().id, 2);
        assert_eq!(pick_monitor(&mons, None, None, None, 7).unwrap().id, 1, "nothing known: the first");
        assert!(pick_monitor(&[], None, None, None, 1).is_none());
        // A full-screen window elsewhere is not followed.
        let fs = Front { fullscreen: true, ..app(2) };
        assert_eq!(pick_monitor(&mons, Some(&fs), Some((2500, 500)), None, 1).unwrap().id, 1);
    }

    #[test]
    fn switching_monitors_settles_fades_then_moves() {
        let mut s = Switch::default();
        assert_eq!(s.tick(0, 1, 1, false), SwitchOut::Nothing, "the same monitor: nothing");
        assert_eq!(s.tick(100, 1, 2, false), SwitchOut::Nothing, "the Samsung just became active: wait");
        assert_eq!(s.tick(300, 1, 2, false), SwitchOut::Nothing);
        assert_eq!(s.tick(350, 1, 2, false), SwitchOut::FadeOut(2), "held SETTLE_MS: fade out");
        assert!(s.fading());
        assert_eq!(s.tick(400, 1, 2, false), SwitchOut::Nothing, "fading");
        assert_eq!(s.tick(350 + FADE_MS, 1, 2, false), SwitchOut::Place(2), "faded: placed there");
        assert!(!s.fading());
        assert_eq!(s.tick(600, 2, 2, false), SwitchOut::Nothing, "arrived");
    }

    #[test]
    fn a_quick_alt_tab_does_not_move_it() {
        let mut s = Switch::default();
        assert_eq!(s.tick(0, 1, 2, false), SwitchOut::Nothing);
        assert_eq!(s.tick(150, 1, 1, false), SwitchOut::Nothing, "back before SETTLE_MS");
        assert_eq!(s.tick(400, 1, 1, false), SwitchOut::Nothing);
        // Flipping between two others restarts the wait.
        let mons3 = (2, 3);
        assert_eq!(s.tick(500, 1, mons3.0, false), SwitchOut::Nothing);
        assert_eq!(s.tick(700, 1, mons3.1, false), SwitchOut::Nothing);
        assert_eq!(s.tick(800, 1, mons3.1, false), SwitchOut::Nothing);
        assert_eq!(s.tick(950, 1, mons3.1, false), SwitchOut::FadeOut(3));
    }

    #[test]
    fn holding_still_it_moves_without_a_fade() {
        let mut s = Switch::default();
        assert_eq!(s.tick(0, 1, 2, true), SwitchOut::Nothing);
        assert_eq!(s.tick(SETTLE_MS, 1, 2, true), SwitchOut::Place(2));
        assert!(!s.fading());
    }

    #[test]
    fn ducks_out_of_full_screen_and_the_lock_screen_only() {
        assert_eq!(duck(None, false), None, "an ordinary window, a meeting in a window: it stays");
        assert!(duck(Some("a full-screen window covers it"), false).unwrap().contains("full-screen"));
        assert!(duck(None, true).unwrap().contains("locked"));
        assert_eq!(period_ms(false, true), 1000);
        assert_eq!(period_ms(true, false), 500);
        assert_eq!(period_ms(false, false), 150);
    }

    #[test]
    fn ducks_for_full_screen_on_its_own_monitor_only_and_comes_back() {
        use crate::policy::{fullscreen_hold, FrontWin, Quns};
        let video = FrontWin { hwnd: 5, class: "Chrome_WidgetWin_1".into(), monitor: 2, rect: (1920, 0, 3840, 1080), monitor_rect: (1920, 0, 3840, 1080), ..Default::default() };
        // The bot on the Samsung: a full-screen video there ducks it out.
        assert!(duck(fullscreen_hold(Quns::Busy, Some(&video), 2).as_deref(), false).is_some());
        // The bot on the laptop: it stays out -- and does not follow the video to the Samsung.
        assert!(duck(fullscreen_hold(Quns::Busy, Some(&video), 1).as_deref(), false).is_none());
        // A game in exclusive full screen on its monitor, and presentation mode.
        let game = FrontWin { class: "UnityWndClass".into(), monitor: 1, rect: (0, 0, 1280, 720), monitor_rect: (0, 0, 1920, 1200), ..Default::default() };
        assert!(duck(fullscreen_hold(Quns::D3dFullScreen, Some(&game), 1).as_deref(), false).is_some());
        assert!(duck(fullscreen_hold(Quns::Presentation, None, 1).as_deref(), false).is_some());
        // Windows' "busy" alone (the 0.1.8 lesson) never does; the video closed: back.
        assert!(duck(fullscreen_hold(Quns::Busy, None, 1).as_deref(), false).is_none());
        let windowed = FrontWin { rect: (100, 100, 1200, 900), monitor: 1, monitor_rect: (0, 0, 1920, 1200), ..video };
        assert!(duck(fullscreen_hold(Quns::Other, Some(&windowed), 1).as_deref(), false).is_none());
    }

    #[test]
    fn meetings_for_eye_contact() {
        let teams = CapUse { app: "MSTeams_8wekyb3d8bbwe".into(), start: 133_000_000_000_000_000, stop: 0 };
        let done = CapUse { stop: 133_000_000_000_100_000, ..teams.clone() };
        let us = CapUse { app: "C:#Program Files#JOYA AI#joya-desktop.exe".into(), ..teams.clone() };
        let wv = CapUse { app: "C:#Program Files (x86)#Microsoft#EdgeWebView#Application#130.0#msedgewebview2.exe".into(), ..teams.clone() };
        assert!(meeting(&[teams.clone()], &[], false), "a camera in use");
        assert!(meeting(&[teams.clone()], &[], true), "a camera in use, even in our own call");
        assert!(!meeting(&[done.clone()], &[done.clone()], false), "used, then stopped");
        assert!(meeting(&[], &[teams.clone()], false), "a microphone in use by another app");
        assert!(!meeting(&[], &[teams.clone()], true), "our own call: the microphone says nothing");
        assert!(!meeting(&[us.clone()], &[us, wv], false), "JOYA AI's own use");
        assert!(!meeting(&[CapUse { start: 0, ..teams }], &[], false), "never started");
    }
}
