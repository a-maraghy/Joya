//! Eye contact (2026-10-20; mockups/eye-contact/DESIGN.md): camera presence, the app's half -- pure, so
//! core-tests checks it on Linux. The camera is read by the site's page (dashboard/public/joya-presence.js,
//! a face model in the page; nothing leaves the computer); the app decides whether the page may have it:
//!
//!   - the WebView2 permission request: the camera only for the site, only while the setting is on
//!     (`permission`); never auto-granted otherwise, and nothing else new is granted;
//!   - the WebView2 profile's stored camera permission for the site follows the setting (`profile_state`):
//!     Deny while it is off (so a decision WebView2 kept from before can never let the camera open), Default
//!     while it is on (the request is raised and `permission` answers it);
//!   - the setting: off by default; the page may only switch things OFF (`page_set`); ON comes from the app's
//!     Settings window or the tray (a person at this computer), and the tray turns it on directly only once
//!     it was switched on in Settings before (`consented`, after reading the explanation there);
//!   - the page says when the camera is in use (the tray shows it); if the setting is off and the page still
//!     says so after a moment, the page is reloaded (`must_reload`) -- the camera cannot stay open by mistake.

use serde::{Deserialize, Serialize};

/// The setting (settings.json `presence`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Presence {
    /// Camera presence: the bot meets your eyes, dozes when you leave, the glance cards follow your attention.
    pub camera: bool,
    /// Look and speak: face the bot and talk, no key.
    pub look_and_speak: bool,
    /// Let go of the camera while Windows' energy saver is on.
    pub release_on_saver: bool,
    /// It was switched on in the Settings window at least once (the explanation was there): the tray may then
    /// switch it on directly; before that the tray opens Settings instead.
    pub consented: bool,
}

impl Default for Presence {
    fn default() -> Self {
        Presence { camera: false, look_and_speak: false, release_on_saver: true, consented: false }
    }
}

impl Presence {
    /// Look and speak needs the camera.
    pub fn fix(&mut self) {
        if !self.camera {
            self.look_and_speak = false;
        }
    }
}

/// What a page asked for (wry's PermissionKind, reduced to what is decided here).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Microphone,
    Camera,
    ClipboardRead,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Allow,
    Deny,
    /// WebView2's own default (its prompt): used for the clipboard only, as before.
    Default,
}

/// The permission policy: `ours` = the request comes from the site (joya.example.com), `camera_on` = the
/// setting. The microphone for the site (voice) as before; the camera for the site only while camera presence
/// is on; everything else refused.
pub fn permission(ask: Ask, ours: bool, camera_on: bool) -> Answer {
    match ask {
        Ask::Microphone if ours => Answer::Allow,
        Ask::Camera if ours && camera_on => Answer::Allow,
        Ask::ClipboardRead => Answer::Default,
        _ => Answer::Deny,
    }
}

/// The stored camera permission for the site in the WebView2 profile, for the setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfilePerm {
    Default,
    Deny,
}

pub fn profile_state(camera_on: bool) -> ProfilePerm {
    if camera_on {
        ProfilePerm::Default
    } else {
        ProfilePerm::Deny
    }
}

/// The page asked to change the setting: it may switch things off and ask for the more private choice
/// (release in energy saver), never switch the camera or look and speak on.
pub fn page_set(cur: &Presence, camera: Option<bool>, look_and_speak: Option<bool>, release_on_saver: Option<bool>) -> Presence {
    let mut p = cur.clone();
    if camera == Some(false) {
        p.camera = false;
    }
    if look_and_speak == Some(false) {
        p.look_and_speak = false;
    }
    if release_on_saver == Some(true) {
        p.release_on_saver = true;
    }
    p.fix();
    p
}

/// The tray's "Camera presence" was clicked: what happens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayClick {
    /// It was on: off, at once.
    Off,
    /// Off, switched on in Settings before: on.
    On,
    /// Off and never switched on in Settings: open Settings (the explanation and the switch).
    OpenSettings,
}

pub fn tray_click(p: &Presence) -> TrayClick {
    if p.camera {
        TrayClick::Off
    } else if p.consented {
        TrayClick::On
    } else {
        TrayClick::OpenSettings
    }
}

/// The Settings window saved: switched on there = consented (it shows the explanation next to the switch).
pub fn from_settings(old: &Presence, new: &Presence) -> Presence {
    let mut p = new.clone();
    p.consented = old.consented || new.camera;
    p.fix();
    p
}

/// The tray item's label.
pub fn tray_label(on: bool, in_use: bool) -> String {
    if on && in_use {
        "Camera presence (camera on now)".into()
    } else {
        "Camera presence".into()
    }
}

/// The tooltip's addition while the camera is open.
pub fn tooltip_note(in_use: bool) -> &'static str {
    if in_use {
        " · camera on"
    } else {
        ""
    }
}

/// Off, and the page still says the camera is in use `ms_since_off` after it was switched off: reload it.
pub const RELOAD_AFTER_MS: u64 = 3000;
pub fn must_reload(camera_on: bool, page_in_use: bool, ms_since_off: Option<u64>) -> bool {
    !camera_on && page_in_use && ms_since_off.map(|ms| ms >= RELOAD_AFTER_MS).unwrap_or(false)
}

/// What the page is told (PageState.presence): the switches and what decides whether the camera may be held now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub camera: bool,
    pub speak: bool,
    pub release_on_saver: bool,
    pub on_battery: bool,
    pub energy_saver: bool,
    pub locked: bool,
    pub meeting: bool,
    pub in_use: bool,
}

pub fn view(p: &Presence, on_battery: bool, energy_saver: bool, locked: bool, meeting: bool, in_use: bool) -> View {
    View {
        camera: p.camera,
        speak: p.camera && p.look_and_speak,
        release_on_saver: p.release_on_saver,
        on_battery,
        energy_saver,
        locked,
        meeting,
        in_use,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_by_default() {
        let p = Presence::default();
        assert!(!p.camera && !p.look_and_speak && !p.consented);
        assert!(p.release_on_saver);
        let s: Presence = serde_json::from_str("{}").unwrap();
        assert_eq!(s, p);
    }

    #[test]
    fn camera_only_for_the_site_and_only_when_on() {
        assert_eq!(permission(Ask::Camera, true, true), Answer::Allow);
        assert_eq!(permission(Ask::Camera, true, false), Answer::Deny);
        assert_eq!(permission(Ask::Camera, false, true), Answer::Deny);
        assert_eq!(permission(Ask::Camera, false, false), Answer::Deny);
    }

    #[test]
    fn the_rest_is_unchanged() {
        assert_eq!(permission(Ask::Microphone, true, false), Answer::Allow);
        assert_eq!(permission(Ask::Microphone, false, true), Answer::Deny);
        assert_eq!(permission(Ask::ClipboardRead, true, true), Answer::Default);
        assert_eq!(permission(Ask::Other, true, true), Answer::Deny);
    }

    #[test]
    fn profile_follows_the_setting() {
        assert_eq!(profile_state(false), ProfilePerm::Deny);
        assert_eq!(profile_state(true), ProfilePerm::Default);
    }

    #[test]
    fn the_page_can_only_switch_off() {
        let on = Presence { camera: true, look_and_speak: true, release_on_saver: false, consented: true };
        let off = Presence::default();
        assert_eq!(page_set(&off, Some(true), Some(true), None), off);
        assert!(!page_set(&on, Some(false), None, None).camera);
        assert!(!page_set(&on, Some(false), None, None).look_and_speak, "speak goes with the camera");
        assert!(!page_set(&on, None, Some(false), None).look_and_speak);
        assert!(page_set(&on, None, None, Some(true)).release_on_saver);
        assert!(!page_set(&on, None, None, Some(false)).release_on_saver, "it cannot make it less private");
    }

    #[test]
    fn tray() {
        let mut p = Presence::default();
        assert_eq!(tray_click(&p), TrayClick::OpenSettings);
        p.consented = true;
        assert_eq!(tray_click(&p), TrayClick::On);
        p.camera = true;
        assert_eq!(tray_click(&p), TrayClick::Off);
        assert_eq!(tray_label(true, true), "Camera presence (camera on now)");
        assert_eq!(tray_label(true, false), "Camera presence");
        assert_eq!(tooltip_note(true), " · camera on");
    }

    #[test]
    fn settings_window_consents() {
        let old = Presence::default();
        let mut new = old.clone();
        new.camera = true;
        assert!(from_settings(&old, &new).consented);
        new.camera = false;
        new.look_and_speak = true;
        let f = from_settings(&old, &new);
        assert!(!f.consented && !f.look_and_speak);
        let was = Presence { consented: true, ..Presence::default() };
        assert!(from_settings(&was, &Presence::default()).consented, "kept");
    }

    #[test]
    fn reload_when_the_page_keeps_it() {
        assert!(!must_reload(false, true, Some(1000)));
        assert!(must_reload(false, true, Some(3000)));
        assert!(!must_reload(false, false, Some(9000)));
        assert!(!must_reload(true, true, Some(9000)));
        assert!(!must_reload(false, true, None));
    }

    #[test]
    fn view_for_the_page() {
        let p = Presence { camera: false, look_and_speak: true, release_on_saver: true, consented: false };
        let v = view(&p, true, false, true, false, false);
        assert!(!v.speak, "no speak without the camera");
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j["releaseOnSaver"], true);
        assert_eq!(j["onBattery"], true);
        assert_eq!(j["locked"], true);
        assert_eq!(j["inUse"], false);
    }
}
