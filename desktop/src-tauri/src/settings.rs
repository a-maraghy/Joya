//! The app's own settings: mode, presets, hotkeys, behaviour. A JSON file in the
//! app's config folder (%APPDATA%\com.joya.desktop\settings.json).
//! No secrets live here -- the sign-in is the webview's own cookie (its profile,
//! which Windows keeps per user).

use crate::layout::{Corner, Mode, Size};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DEFAULT_TALK: &str = "Ctrl+Space";
pub const FALLBACK_TALK: &str = "Ctrl+Alt+Space";
pub const DEFAULT_SHOW: &str = "Ctrl+Alt+M";
pub const DEFAULT_FOCUS: &str = "Ctrl+Alt+F";
/// Start / end a live (hands-free) call. Ctrl+Alt+L: no common Windows or Office binding (Win+L locks,
/// Ctrl+L is the address bar, Ctrl+Alt+L is free in Windows, Office, browsers, VS Code's default keymap).
pub const DEFAULT_LIVE: &str = "Ctrl+Alt+L";
pub const FALLBACK_LIVE: &str = "Ctrl+Alt+Shift+L";
pub const DEFAULT_ORIGIN: &str = "https://joya.example.com";
/// Laptop control: end JOYA AI's control of this computer at once (handled in the app, no server).
/// Esc is accepted only with both Ctrl and Alt (Ctrl+Esc is the Start menu, Alt+Esc switches windows).
pub const DEFAULT_STOP: &str = "Ctrl+Alt+Esc";
pub const FALLBACK_STOP: &str = "Ctrl+Alt+Shift+Esc";

/// Desktop-layer position presets (where the core sits across the screen).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Across {
    Left,
    Centre,
    Right,
}

impl Across {
    pub fn as_str(&self) -> &'static str {
        match self {
            Across::Left => "left",
            Across::Centre => "centre",
            Across::Right => "right",
        }
    }
}

/// Where the glance cards were pinned in the Desktop layer: their top left as fractions (0..1) of the
/// monitor's work area, so a change of scaling or resolution keeps them in the same part of the screen.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pin {
    pub x: f64,
    pub y: f64,
}

impl Pin {
    /// A pin the page sent, made safe: finite, inside the work area; None if it is not a position.
    pub fn clean(x: f64, y: f64) -> Option<Pin> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        Some(Pin { x: x.clamp(0.0, 0.98), y: y.clamp(0.0, 0.95) })
    }
}

/// What is remembered per monitor (keyed by the monitor's name and size).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PerMonitor {
    pub corner: Corner,
    pub across: Across,
    pub size: Size,
    pub opacity: u8,
    /// The glance cards pinned on the desktop (Desktop layer) here; None: beside the core.
    pub glance_pin: Option<Pin>,
}

impl Default for PerMonitor {
    fn default() -> Self {
        PerMonitor { corner: Corner::Br, across: Across::Right, size: Size::M, opacity: 100, glance_pin: None }
    }
}

/// Companion mode (companion.rs): the bot at the top centre of the monitor you are working on, or -- with
/// `stay_on_monitor` -- of the one it is on when this is switched on. (0.1.12's "perch", "session_bots" and
/// "side" are gone: an old settings file still loads, and they are dropped the next time it is saved.)
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Companion {
    pub stay_on_monitor: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hotkeys {
    pub talk: String,
    pub show: String,
    pub focus: String,
    /// Start / end a live call (hands-free), pressed once.
    pub live: String,
    /// Laptop control: stop it now.
    pub stop: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Hotkeys { talk: DEFAULT_TALK.into(), show: DEFAULT_SHOW.into(), focus: DEFAULT_FOCUS.into(), live: DEFAULT_LIVE.into(), stop: DEFAULT_STOP.into() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub mode: Mode,
    pub focus: bool,
    pub hotkeys: Hotkeys,
    pub do_not_disturb: bool,
    /// Lower frame rate / still core on battery and during full-screen apps.
    pub battery_saver: bool,
    /// Real blur (acrylic) behind the cards, pills and panels (blur.rs, acrylic.rs); off: the tinted look.
    pub real_blur: bool,
    /// The glance cards beside the core (approvals, sessions, today's tokens, alerts). Focus mode hides them.
    pub glance: bool,
    pub autostart: bool,
    /// The monitor JOYA AI lives on (its name); empty = the primary.
    pub monitor: String,
    pub per_monitor: BTreeMap<String, PerMonitor>,
    /// Desktop layer behind the desktop icons (WorkerW). Retired in 0.1.14 (it made JOYA AI unclickable):
    /// kept only so older settings files still load; fix() always turns it off.
    pub experimental_behind_icons: bool,
    pub check_updates: bool,
    /// The site, for a test server only; the app refuses anything that is not https.
    pub origin: String,
    /// Laptop control: claude.exe (or claude.cmd) to run; empty = look on PATH and the usual places.
    pub claude_path: String,
    /// Companion mode's own settings.
    pub companion: Companion,
    /// The mode the tray's Companion switch goes back to when it is switched off.
    pub before_companion: Mode,
    /// Eye contact (presence.rs): camera presence and look and speak. Off by default.
    pub presence: crate::presence::Presence,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mode: Mode::Floating,
            focus: false,
            hotkeys: Hotkeys::default(),
            do_not_disturb: false,
            battery_saver: true,
            real_blur: true,
            glance: true,
            autostart: true,
            monitor: String::new(),
            per_monitor: BTreeMap::new(),
            experimental_behind_icons: false,
            check_updates: true,
            origin: DEFAULT_ORIGIN.into(),
            claude_path: String::new(),
            companion: Companion::default(),
            before_companion: Mode::Floating,
            presence: crate::presence::Presence::default(),
        }
    }
}

impl Settings {
    /// Read from JSON; anything missing or malformed falls back to its default, never fails.
    pub fn from_json(s: &str) -> Settings {
        let mut st: Settings = serde_json::from_str(s).unwrap_or_default();
        st.fix();
        st
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }
    /// Bring loaded values into range.
    pub fn fix(&mut self) {
        for pm in self.per_monitor.values_mut() {
            pm.opacity = pm.opacity.clamp(35, 100);
            pm.glance_pin = pm.glance_pin.and_then(|p| Pin::clean(p.x, p.y));
        }
        for (k, d) in [(&mut self.hotkeys.talk, DEFAULT_TALK), (&mut self.hotkeys.show, DEFAULT_SHOW), (&mut self.hotkeys.focus, DEFAULT_FOCUS), (&mut self.hotkeys.live, DEFAULT_LIVE), (&mut self.hotkeys.stop, DEFAULT_STOP)] {
            match normalize_hotkey(k) {
                Some(n) => *k = n,
                None => *k = d.into(),
            }
        }
        self.claude_path = self.claude_path.trim().trim_matches('"').chars().filter(|c| !c.is_control()).take(400).collect();
        if self.before_companion == Mode::Companion {
            self.before_companion = Mode::Floating;
        }
        self.presence.fix();
        // "Desktop layer behind the icons" was removed in 0.1.14: an older settings file that had it on loads off.
        self.experimental_behind_icons = false;
        if !origin_ok(&self.origin) {
            self.origin = DEFAULT_ORIGIN.into();
        }
        if self.per_monitor.len() > 16 {
            let keep: Vec<String> = self.per_monitor.keys().take(16).cloned().collect();
            self.per_monitor.retain(|k, _| keep.contains(k));
        }
    }
    pub fn monitor_prefs(&self, key: &str) -> PerMonitor {
        self.per_monitor.get(key).cloned().unwrap_or_default()
    }
    pub fn monitor_prefs_mut(&mut self, key: &str) -> &mut PerMonitor {
        self.per_monitor.entry(key.to_string()).or_default()
    }
}

/// The site may only be https on a host name (no paths, no credentials).
pub fn origin_ok(o: &str) -> bool {
    match url::Url::parse(o) {
        Ok(u) => u.scheme() == "https" && u.host_str().is_some() && u.username().is_empty() && u.password().is_none() && (u.path() == "/" || u.path().is_empty()) && u.query().is_none(),
        Err(_) => false,
    }
}

const MODS: [&str; 4] = ["Ctrl", "Alt", "Shift", "Win"];

/// A hotkey as the settings store it: modifiers in a fixed order, then one key ("Ctrl+Alt+M").
/// At least one modifier (a bare key would be taken from every other app); Win+ combinations
/// belong to Windows and are refused. None when it is not a valid hotkey.
pub fn normalize_hotkey(s: &str) -> Option<String> {
    let parts: Vec<String> = s.split('+').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 || parts.len() > 4 {
        return None;
    }
    let mut mods = [false; 4];
    let mut key: Option<String> = None;
    for p in &parts {
        let up = p.to_ascii_uppercase();
        let m = match up.as_str() {
            "CTRL" | "CONTROL" => Some(0),
            "ALT" | "OPTION" => Some(1),
            "SHIFT" => Some(2),
            "WIN" | "SUPER" | "META" | "CMD" => Some(3),
            _ => None,
        };
        match m {
            Some(i) => {
                if mods[i] {
                    return None;
                }
                mods[i] = true;
            }
            None => {
                if key.is_some() {
                    return None;
                }
                key = Some(normal_key(&up)?);
            }
        }
    }
    if mods[3] || !(mods[0] || mods[1]) {
        return None; // Win+ is Windows'; Shift alone types capitals
    }
    let key = key?;
    if key == "Esc" && !(mods[0] && mods[1]) {
        return None; // Ctrl+Esc is the Start menu, Alt+Esc switches windows
    }
    let mut out: Vec<String> = MODS.iter().enumerate().filter(|(i, _)| mods[*i]).map(|(_, m)| m.to_string()).collect();
    out.push(key);
    Some(out.join("+"))
}

fn normal_key(up: &str) -> Option<String> {
    let k = match up {
        "SPACE" => "Space".to_string(),
        "ENTER" | "RETURN" => "Enter".to_string(),
        "TAB" => "Tab".to_string(),
        "BACKQUOTE" | "`" => "Backquote".to_string(),
        "ESC" | "ESCAPE" => "Esc".to_string(),
        s if s.len() == 1 && s.chars().all(|c| c.is_ascii_alphanumeric()) => s.to_string(),
        s if s.starts_with('F') && s[1..].parse::<u8>().map(|n| (1..=24).contains(&n)).unwrap_or(false) => s.to_string(),
        _ => return None,
    };
    Some(k)
}

/// The hotkeys must all be different keys.
pub fn hotkeys_distinct(h: &Hotkeys) -> bool {
    let all = [&h.talk, &h.show, &h.focus, &h.live, &h.stop];
    (0..all.len()).all(|i| (i + 1..all.len()).all(|j| all[i] != all[j]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_design() {
        let s = Settings::default();
        assert_eq!(s.mode, Mode::Floating);
        assert_eq!(s.hotkeys.talk, "Ctrl+Space");
        assert_eq!(s.hotkeys.show, "Ctrl+Alt+M");
        assert_eq!(s.hotkeys.focus, "Ctrl+Alt+F");
        assert_eq!(s.hotkeys.live, "Ctrl+Alt+L");
        assert!(!s.experimental_behind_icons);
        assert!(s.real_blur, "real blur behind the cards is on by default");
        assert_eq!(s.monitor_prefs("any").corner, Corner::Br);
        assert_eq!(s.monitor_prefs("any").opacity, 100);
    }

    #[test]
    fn behind_the_icons_is_retired() {
        let mut s: Settings = serde_json::from_str(r#"{"mode":"desktop","experimental_behind_icons":true}"#).unwrap();
        s.fix();
        assert!(!s.experimental_behind_icons, "0.1.14 removed the switch: an old file that had it on loads off");
        assert_eq!(s.mode, Mode::Desktop, "the Desktop layer itself stays");
    }

    #[test]
    fn malformed_json_falls_back() {
        assert_eq!(Settings::from_json("not json"), Settings::default());
        let s = Settings::from_json(r#"{"mode":"desktop","hotkeys":{"talk":"Space"},"per_monitor":{"A":{"opacity":5}},"origin":"http://evil"}"#);
        assert_eq!(s.mode, Mode::Desktop);
        assert_eq!(s.hotkeys.talk, "Ctrl+Space", "a bare key is not a hotkey");
        assert_eq!(s.monitor_prefs("A").opacity, 35);
        assert_eq!(s.origin, DEFAULT_ORIGIN);
    }

    #[test]
    fn round_trip() {
        let mut s = Settings::default();
        s.mode = Mode::Peek;
        s.monitor_prefs_mut("DISPLAY2 2560x1440").size = Size::L;
        assert_eq!(Settings::from_json(&s.to_json()), s);
    }

    #[test]
    fn hotkeys_normalize() {
        assert_eq!(normalize_hotkey("ctrl + space").as_deref(), Some("Ctrl+Space"));
        assert_eq!(normalize_hotkey("Alt+Ctrl+m").as_deref(), Some("Ctrl+Alt+M"));
        assert_eq!(normalize_hotkey("Ctrl+Alt+Space").as_deref(), Some("Ctrl+Alt+Space"));
        assert_eq!(normalize_hotkey("Ctrl+Shift+F12").as_deref(), Some("Ctrl+Shift+F12"));
        assert_eq!(normalize_hotkey("Space"), None);
        assert_eq!(normalize_hotkey("Shift+A"), None);
        assert_eq!(normalize_hotkey("Win+D"), None);
        assert_eq!(normalize_hotkey("Ctrl+A+B"), None);
        assert_eq!(normalize_hotkey("Ctrl+Ctrl+A"), None);
        assert_eq!(normalize_hotkey("Ctrl+F25"), None);
        assert_eq!(normalize_hotkey("Ctrl+Esc"), None);
    }

    #[test]
    fn distinct_hotkeys() {
        assert!(hotkeys_distinct(&Hotkeys::default()));
        assert!(!hotkeys_distinct(&Hotkeys { talk: "Ctrl+Alt+M".into(), ..Hotkeys::default() }));
    }

    #[test]
    fn origins() {
        assert!(origin_ok("https://joya.example.com"));
        assert!(origin_ok("https://joya.example.com/"));
        assert!(!origin_ok("http://joya.example.com"));
        assert!(!origin_ok("https://user:pw@joya.example.com"));
        assert!(!origin_ok("https://joya.example.com/joya-ai"));
        assert!(!origin_ok("file:///c:/x"));
    }

    #[test]
    fn real_blur_setting() {
        // A settings file from 0.1.4 (no "real_blur") gets it on; an explicit off stays off.
        assert!(Settings::from_json(r#"{"mode":"floating"}"#).real_blur);
        assert!(!Settings::from_json(r#"{"real_blur":false}"#).real_blur);
    }

    #[test]
    fn glance_setting_and_pins() {
        // A 0.1.8 settings file (no "glance"): the cards are on; an explicit off stays off.
        assert!(Settings::from_json(r#"{"mode":"floating"}"#).glance);
        assert!(!Settings::from_json(r#"{"glance":false}"#).glance);
        assert_eq!(Settings::default().monitor_prefs("x").glance_pin, None);
        // A pin is remembered per monitor and survives a round trip; a stored one out of range is brought in.
        let mut s = Settings::default();
        s.monitor_prefs_mut("DISPLAY1 1920x1080").glance_pin = Pin::clean(0.1, 0.2);
        assert_eq!(Settings::from_json(&s.to_json()), s);
        assert_eq!(s.monitor_prefs("DISPLAY2 2560x1440").glance_pin, None, "another monitor keeps its own");
        let s = Settings::from_json(r#"{"per_monitor":{"A":{"glance_pin":{"x":4,"y":-1}}}}"#);
        assert_eq!(s.monitor_prefs("A").glance_pin, Some(Pin { x: 0.98, y: 0.0 }));
        assert_eq!(Pin::clean(f64::NAN, 0.5), None);
        assert_eq!(Pin::clean(0.5, f64::INFINITY), None);
    }

    #[test]
    fn companion_settings() {
        // A 0.1.11 settings file (no "companion"): follow the active monitor.
        let s = Settings::from_json(r#"{"mode":"floating"}"#);
        assert_eq!(s.companion, Companion::default());
        assert!(!s.companion.stay_on_monitor);
        assert_eq!(s.before_companion, Mode::Floating);
        // A 0.1.12 file: its perch, session bots and side are dropped; companion mode and "stay" are kept.
        let old = r#"{"mode":"companion","companion":{"perch":"taskbar","session_bots":false,"stay_on_monitor":true,"side":7},"before_companion":"desktop"}"#;
        let s = Settings::from_json(old);
        assert_eq!(s.mode, Mode::Companion);
        assert!(s.companion.stay_on_monitor);
        assert_eq!(s.before_companion, Mode::Desktop);
        let saved = s.to_json();
        assert!(!saved.contains("perch") && !saved.contains("session_bots") && !saved.contains("\"side\""), "{}", saved);
        assert_eq!(Settings::from_json(&saved), s);
        // Its other values do not matter to it: a 0.1.12 default file follows the active monitor.
        let s = Settings::from_json(r#"{"companion":{"perch":"both","session_bots":true,"stay_on_monitor":false,"side":0.8}}"#);
        assert_eq!(s.companion, Companion::default());
        // Garbage in the block: the default.
        assert_eq!(Settings::from_json(r#"{"companion":{"stay_on_monitor":"yes"}}"#).companion, Companion::default());
        assert_eq!(Settings::from_json(r#"{"before_companion":"companion"}"#).before_companion, Mode::Floating, "the switch never goes back to Companion");
    }

    #[test]
    fn live_hotkey() {
        // A settings file from 0.1.3 (no "live") gets the default; a bad one is put back to it.
        let s = Settings::from_json(r#"{"hotkeys":{"talk":"Ctrl+Space","show":"Ctrl+Alt+M","focus":"Ctrl+Alt+F"}}"#);
        assert_eq!(s.hotkeys.live, DEFAULT_LIVE);
        let s = Settings::from_json(r#"{"hotkeys":{"live":"L"}}"#);
        assert_eq!(s.hotkeys.live, DEFAULT_LIVE);
        let s = Settings::from_json(r#"{"hotkeys":{"live":"alt+ctrl+k"}}"#);
        assert_eq!(s.hotkeys.live, "Ctrl+Alt+K");
        assert_eq!(normalize_hotkey(FALLBACK_LIVE).as_deref(), Some(FALLBACK_LIVE));
        let mut h = Hotkeys::default();
        assert!(hotkeys_distinct(&h));
        h.live = h.show.clone();
        assert!(!hotkeys_distinct(&h), "the live key may not be another hotkey");
        h.live = h.talk.clone();
        assert!(!hotkeys_distinct(&h));
        let d = Hotkeys::default();
        assert!([&d.talk, &d.show, &d.focus].iter().all(|k| **k != DEFAULT_LIVE && **k != FALLBACK_LIVE));
    }

    #[test]
    fn stop_hotkey() {
        let d = Settings::default();
        assert_eq!(d.hotkeys.stop, "Ctrl+Alt+Esc");
        assert_eq!(d.claude_path, "");
        assert_eq!(normalize_hotkey("alt+ctrl+escape").as_deref(), Some("Ctrl+Alt+Esc"));
        assert_eq!(normalize_hotkey(FALLBACK_STOP).as_deref(), Some(FALLBACK_STOP));
        assert_eq!(normalize_hotkey("Ctrl+Esc"), None, "the Start menu");
        assert_eq!(normalize_hotkey("Alt+Esc"), None);
        // A 0.1.4 settings file has no stop key: the default; a bad one goes back to it.
        let s = Settings::from_json(r#"{"hotkeys":{"talk":"Ctrl+Space"},"claude_path":"  \"C:\\x\\claude.exe\" "}"#);
        assert_eq!(s.hotkeys.stop, DEFAULT_STOP);
        assert_eq!(s.claude_path, "C:\\x\\claude.exe");
        assert_eq!(Settings::from_json(r#"{"hotkeys":{"stop":"Esc"}}"#).hotkeys.stop, DEFAULT_STOP);
        let mut h = Hotkeys::default();
        h.stop = h.show.clone();
        assert!(!hotkeys_distinct(&h), "the stop key may not be another hotkey");
    }
}
