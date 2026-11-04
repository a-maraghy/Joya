//! The Windows-only parts: what is in front, full-screen apps, power, the
//! wallpaper's brightness, the desktop's icon layer. Every function has a
//! harmless answer on other systems, so the rest of the app builds and its
//! tests run anywhere.

/// What has the keyboard focus right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Front {
    /// The desktop itself (its wallpaper / icons, or "show desktop" with Win+D).
    Desktop,
    /// JOYA AI's own window.
    Ours,
    /// Any other window.
    Other,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ink {
    /// Light text, for a dark or busy wallpaper.
    Light,
    /// Dark text, for a light wallpaper.
    Dark,
}

impl Ink {
    pub fn as_str(&self) -> &'static str {
        match self {
            Ink::Light => "light",
            Ink::Dark => "dark",
        }
    }
}

/// Mean luminance (0..1) of RGB pixels -> the ink: dark ink only on a clearly light wallpaper.
pub fn ink_for_luminance(l: f64) -> Ink {
    if l > 0.62 {
        Ink::Dark
    } else {
        Ink::Light
    }
}

pub fn luminance(r: u8, g: u8, b: u8) -> f64 {
    fn lin(c: u8) -> f64 {
        let c = c as f64 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }
    // Perceived lightness (CIE L*), 0..1, of the relative luminance.
    let y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    if y <= 0.008856 {
        y * 9.033
    } else {
        (1.16 * y.cbrt()) - 0.16
    }
}

#[cfg(windows)]
mod imp {
    use super::{Front, Ink};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use core::ffi::c_void;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::OnceLock;
    use windows::core::GUID;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Power::{GetSystemPowerStatus, PowerSettingRegisterNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, POWERBROADCAST_SETTING, SYSTEM_POWER_STATUS};
    use windows::Win32::System::Threading::{GetCurrentProcess, ProcessPowerThrottling, SetProcessInformation, PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE};
    use windows::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_POWERSETTINGCHANGE};
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS};
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetForegroundWindow, SendMessageTimeoutW, SetParent, SystemParametersInfoW, GA_ROOTOWNER,
        SMTO_NORMAL, SPI_GETCLIENTAREAANIMATION, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    use windows::Win32::Graphics::Gdi::GetSysColor;
    use windows::Win32::Graphics::Gdi::SYS_COLOR_INDEX;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GetWindowRect, IsZoomed, GWL_EXSTYLE, GWL_STYLE, WS_CAPTION, WS_EX_TOOLWINDOW};

    pub fn hwnd_of(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    pub fn front(ours: isize) -> Front {
        let fg = unsafe { GetForegroundWindow() };
        if fg.0.is_null() {
            return Front::Unknown;
        }
        let root = unsafe { GetAncestor(fg, GA_ROOTOWNER) };
        let r = if root.0.is_null() { fg } else { root };
        if r.0 as isize == ours || fg.0 as isize == ours {
            return Front::Ours;
        }
        match class_of(r).as_str() {
            "WorkerW" | "Progman" | "Shell_TrayWnd" => Front::Desktop,
            _ => Front::Other,
        }
    }

    /// What Windows says about full-screen apps (policy::fullscreen_hold decides what it means for us).
    pub fn quns() -> crate::policy::Quns {
        use crate::policy::Quns;
        match unsafe { SHQueryUserNotificationState() } {
            Ok(QUERY_USER_NOTIFICATION_STATE(s)) if s == QUNS_BUSY.0 => Quns::Busy,
            Ok(QUERY_USER_NOTIFICATION_STATE(s)) if s == QUNS_RUNNING_D3D_FULL_SCREEN.0 => Quns::D3dFullScreen,
            Ok(QUERY_USER_NOTIFICATION_STATE(s)) if s == QUNS_PRESENTATION_MODE.0 => Quns::Presentation,
            _ => Quns::Other,
        }
    }

    fn monitor_rect(m: HMONITOR) -> Option<crate::policy::Rect> {
        let mut mi = MONITORINFO { cbSize: core::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if m.0.is_null() || !unsafe { GetMonitorInfoW(m, &mut mi) }.as_bool() {
            return None;
        }
        Some((mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right, mi.rcMonitor.bottom))
    }

    /// The monitor JOYA AI's window is on (HMONITOR as a number; 0 unknown).
    pub fn monitor_of(ours: isize) -> isize {
        if ours == 0 {
            return 0;
        }
        unsafe { MonitorFromWindow(hwnd_of(ours), MONITOR_DEFAULTTONEAREST) }.0 as isize
    }

    /// The foreground window: its class, whether it is ours / a tool window, its monitor and bounds.
    pub fn front_window(ours: isize) -> Option<crate::policy::FrontWin> {
        let fg = unsafe { GetForegroundWindow() };
        if fg.0.is_null() {
            return None;
        }
        let root = unsafe { GetAncestor(fg, GA_ROOTOWNER) };
        let r = if root.0.is_null() { fg } else { root };
        let is_ours = ours != 0 && (r.0 as isize == ours || fg.0 as isize == ours);
        let ex = unsafe { GetWindowLongPtrW(fg, GWL_EXSTYLE) } as u32;
        let style = unsafe { GetWindowLongPtrW(fg, GWL_STYLE) } as u32;
        let m = unsafe { MonitorFromWindow(fg, MONITOR_DEFAULTTONULL) };
        let mut rc = RECT::default();
        let dwm = unsafe { DwmGetWindowAttribute(fg, DWMWA_EXTENDED_FRAME_BOUNDS, &mut rc as *mut RECT as *mut c_void, core::mem::size_of::<RECT>() as u32) }.is_ok();
        if !dwm {
            let _ = unsafe { GetWindowRect(fg, &mut rc) };
        }
        Some(crate::policy::FrontWin {
            hwnd: fg.0 as isize,
            class: class_of(r),
            ours: is_ours,
            tool: ex & WS_EX_TOOLWINDOW.0 != 0,
            monitor: m.0 as isize,
            rect: (rc.left, rc.top, rc.right, rc.bottom),
            monitor_rect: monitor_rect(m).unwrap_or_default(),
            captioned_max: unsafe { IsZoomed(fg) }.as_bool() && style & WS_CAPTION.0 == WS_CAPTION.0,
        })
    }

    /// (on battery, Windows' battery saver / energy saver on): what the power notifications said
    /// (watch_power), filled in from GetSystemPowerStatus where they have not (policy::power_state).
    pub fn power() -> (bool, bool) {
        crate::policy::power_state(&power_report())
    }

    pub fn power_report() -> crate::policy::PowerReport {
        let mut p = SYSTEM_POWER_STATUS::default();
        let polled = unsafe { GetSystemPowerStatus(&mut p) }.is_ok();
        let get = |a: &AtomicU32| match a.load(Ordering::SeqCst) {
            UNSET => None,
            v => Some(v),
        };
        crate::policy::PowerReport {
            acdc: get(&ACDC),
            energy_saver: get(&ES),
            power_saving: get(&PS),
            ac_line: polled.then_some(p.ACLineStatus),
            status_flag: polled.then_some(p.SystemStatusFlag),
        }
    }

    /* Power notifications: Windows calls on_power (on a thread of its own pool) when the power source,
    Energy saver (Windows 11 22H2+) or the older battery saver changes, and once at registration with
    the current value. A poll once a second missed or lagged Energy saver: the app is itself slowed
    down by it (EcoQoS), and SystemStatusFlag follows the older battery saver, not Energy saver. */
    const UNSET: u32 = u32::MAX;
    static ACDC: AtomicU32 = AtomicU32::new(UNSET);
    static ES: AtomicU32 = AtomicU32::new(UNSET);
    static PS: AtomicU32 = AtomicU32::new(UNSET);
    static HOOK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
    const GUID_ACDC_POWER_SOURCE: GUID = GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548);
    const GUID_ENERGY_SAVER_STATUS: GUID = GUID::from_u128(0x550e8400_e29b_41d4_a716_446655440000);
    const GUID_POWER_SAVING_STATUS: GUID = GUID::from_u128(0xe00958c0_c213_4ace_ac77_fecced2eeea5);

    unsafe extern "system" fn on_power(_ctx: *const c_void, kind: u32, setting: *const c_void) -> u32 {
        if kind != PBT_POWERSETTINGCHANGE || setting.is_null() {
            return 0;
        }
        let s = setting as *const POWERBROADCAST_SETTING;
        let (guid, len) = unsafe { ((*s).PowerSetting, (*s).DataLength) };
        if len < 4 {
            return 0;
        }
        let v = unsafe { core::ptr::read_unaligned(core::ptr::addr_of!((*s).Data) as *const u32) };
        let (slot, name) = if guid == GUID_ACDC_POWER_SOURCE {
            (&ACDC, "power source (0 AC, 1 battery, 2 UPS)")
        } else if guid == GUID_ENERGY_SAVER_STATUS {
            (&ES, "Energy saver (0 off, 1 standard, 2 high savings)")
        } else if guid == GUID_POWER_SAVING_STATUS {
            (&PS, "battery saver (0 off, 1 on)")
        } else {
            return 0;
        };
        let old = slot.swap(v, Ordering::SeqCst);
        if old != v {
            let was = if old == UNSET { "-".to_string() } else { old.to_string() };
            mlog!("power: {} {} -> {}", name, was, v);
            if let Some(h) = HOOK.get() {
                h();
            }
        }
        0
    }

    /// Ask Windows to tell us about power changes; `hook` runs after each one (on a Windows thread).
    pub fn watch_power(hook: Box<dyn Fn() + Send + Sync>) {
        let _ = HOOK.set(hook);
        for (g, name) in [(GUID_ACDC_POWER_SOURCE, "power source"), (GUID_ENERGY_SAVER_STATUS, "Energy saver"), (GUID_POWER_SAVING_STATUS, "battery saver")] {
            // Windows keeps the pointer for as long as the registration lives: the life of the app.
            let params: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback: Some(on_power), Context: core::ptr::null_mut() }));
            let mut reg: *mut c_void = core::ptr::null_mut();
            let r = unsafe { PowerSettingRegisterNotification(&g, DEVICE_NOTIFY_CALLBACK, HANDLE(params as *mut _ as *mut c_void), &mut reg) };
            if r.0 == 0 {
                mlog!("power: notifications for {} registered", name);
            } else {
                // Energy saver: Windows before 11 22H2 has no such setting (the battery saver one stands in).
                mlog!("power: no notifications for {} (error {})", name, r.0);
            }
        }
    }

    /// Opt this process (not WebView2's own processes, which keep their savings) out of Windows'
    /// power throttling (EcoQoS), so the watchers that hold the core still keep running on time.
    pub fn keep_full_speed() -> bool {
        let st = PROCESS_POWER_THROTTLING_STATE { Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION, ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED, StateMask: 0 };
        unsafe { SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &st as *const _ as *const c_void, core::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32) }.is_ok()
    }

    /// The screen is locked (or another desktop, like a UAC prompt, has the input).
    pub fn locked() -> bool {
        match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0100)) } {
            Ok(d) => {
                let _ = unsafe { CloseDesktop(d) };
                false
            }
            Err(_) => true,
        }
    }

    /// Windows "Animation effects" off: hold the core still.
    pub fn reduce_motion() -> bool {
        let mut on: i32 = 1;
        let ok = unsafe { SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, Some(&mut on as *mut i32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) };
        ok.is_ok() && on == 0
    }

    pub fn wallpaper_path() -> Option<String> {
        let mut buf = [0u16; 520];
        let ok = unsafe { SystemParametersInfoW(SPI_GETDESKWALLPAPER, buf.len() as u32, Some(buf.as_mut_ptr() as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) };
        if ok.is_err() {
            return None;
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
        let s = String::from_utf16_lossy(&buf[..n]);
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }

    /// The wallpaper's lightness under a part of the monitor (fractions 0..1 of its width and height),
    /// assuming it fills the screen; a solid-colour desktop uses that colour.
    pub fn wallpaper_ink(fx0: f64, fy0: f64, fx1: f64, fy1: f64) -> Option<Ink> {
        if let Some(p) = wallpaper_path() {
            if let Ok(img) = image::open(&p) {
                let img = img.thumbnail(320, 320).to_rgb8();
                let (w, h) = (img.width() as f64, img.height() as f64);
                let (x0, y0) = ((fx0.clamp(0.0, 1.0) * w) as u32, (fy0.clamp(0.0, 1.0) * h) as u32);
                let (x1, y1) = (((fx1.clamp(0.0, 1.0) * w) as u32).max(x0 + 1).min(img.width()), ((fy1.clamp(0.0, 1.0) * h) as u32).max(y0 + 1).min(img.height()));
                let (mut sum, mut n) = (0.0, 0.0);
                for y in y0..y1 {
                    for x in x0..x1 {
                        let p = img.get_pixel(x, y);
                        sum += super::luminance(p[0], p[1], p[2]);
                        n += 1.0;
                    }
                }
                if n > 0.0 {
                    return Some(super::ink_for_luminance(sum / n));
                }
            }
        }
        let c = unsafe { GetSysColor(SYS_COLOR_INDEX(1)) }; // COLOR_DESKTOP
        Some(super::ink_for_luminance(super::luminance((c & 0xFF) as u8, ((c >> 8) & 0xFF) as u8, ((c >> 16) & 0xFF) as u8)))
    }

    /// Experimental: put the window behind the desktop icons (the WorkerW trick live wallpapers use).
    /// Undocumented; Windows 11 24H2 changed the window tree, both trees are handled. No clicks reach
    /// the window there -- the icon list is on top. Returns whether it worked.
    pub fn behind_icons(ours: isize) -> bool {
        unsafe {
            let progman = match FindWindowW(windows::core::w!("Progman"), PCWSTR::null()) {
                Ok(h) => h,
                Err(_) => return false,
            };
            let mut _res = 0usize;
            // Ask Progman to create the WorkerW behind the icons.
            let _ = SendMessageTimeoutW(progman, 0x052C, WPARAM(0xD), LPARAM(0x1), SMTO_NORMAL, 1000, Some(&mut _res));
            let _ = SendMessageTimeoutW(progman, 0x052C, WPARAM(0), LPARAM(0), SMTO_NORMAL, 1000, Some(&mut _res));
            // 24H2: the WorkerW is a child of Progman.
            let mut worker = FindWindowExW(Some(progman), None, windows::core::w!("WorkerW"), PCWSTR::null()).unwrap_or_default();
            if worker.0.is_null() {
                // Before 24H2: the WorkerW after the one that holds SHELLDLL_DefView.
                static mut FOUND: isize = 0;
                unsafe extern "system" fn each(h: HWND, _: LPARAM) -> windows::core::BOOL {
                    if let Ok(def) = FindWindowExW(Some(h), None, windows::core::w!("SHELLDLL_DefView"), PCWSTR::null()) {
                        if !def.0.is_null() {
                            if let Ok(w) = FindWindowExW(None, Some(h), windows::core::w!("WorkerW"), PCWSTR::null()) {
                                FOUND = w.0 as isize;
                            }
                        }
                    }
                    windows::core::BOOL(1)
                }
                FOUND = 0;
                let _ = EnumWindows(Some(each), LPARAM(0));
                worker = HWND(FOUND as *mut core::ffi::c_void);
            }
            if worker.0.is_null() {
                return false;
            }
            SetParent(hwnd_of(ours), Some(worker)).is_ok()
        }
    }

    pub fn leave_icons(ours: isize) {
        unsafe {
            let _ = SetParent(hwnd_of(ours), None);
        }
    }

    /* ---------------------------------------------------------- Companion mode (companion.rs)
       Window geometry only: the monitors and their DPI, keeping our own small window on top, and Windows'
       record of which apps have the camera or microphone open (eye contact).
       Nothing here looks at what any window shows. */

    /// Every monitor: its rectangle, work area and scale (its effective DPI / 96). From any thread.
    pub fn monitors() -> Vec<crate::companion::Monitor> {
        use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC};
        use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
        unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows::core::BOOL {
            let out = unsafe { &mut *(data.0 as *mut Vec<isize>) };
            out.push(m.0 as isize);
            windows::core::BOOL(1)
        }
        let mut ids: Vec<isize> = Vec::new();
        let _ = unsafe { EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut ids as *mut Vec<isize> as isize)) };
        ids.into_iter()
            .filter_map(|id| {
                let m = HMONITOR(id as *mut c_void);
                let mut mi = MONITORINFO { cbSize: core::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                if !unsafe { GetMonitorInfoW(m, &mut mi) }.as_bool() {
                    return None;
                }
                let (mut dx, mut dy) = (96u32, 96u32);
                let scale = if unsafe { GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) }.is_ok() && dx > 0 { dx as f64 / 96.0 } else { 1.0 };
                let r = |rc: RECT| crate::layout::Rect { x: rc.left, y: rc.top, w: (rc.right - rc.left).max(0) as u32, h: (rc.bottom - rc.top).max(0) as u32 };
                Some(crate::companion::Monitor { id, rect: r(mi.rcMonitor), work: r(mi.rcWork), scale })
            })
            .collect()
    }

    /// Put our window on top of every other always-on-top window again (no move, no size, no activation),
    /// from any thread: posted to the window's own thread (SWP_ASYNCWINDOWPOS), never waited on.
    pub fn to_top(ours: isize) {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE};
        if ours == 0 {
            return;
        }
        let _ = unsafe { SetWindowPos(hwnd_of(ours), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS) };
    }

    /// Which apps Windows' privacy settings record as using the camera ("webcam") or the microphone now
    /// (HKCU ...\CapabilityAccessManager\ConsentStore\<kind>: each app's LastUsedTimeStart / Stop; desktop
    /// apps under NonPackaged). Names and times only.
    pub fn cap_use(kind: &str) -> Vec<crate::companion::CapUse> {
        use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ};
        fn open(parent: HKEY, sub: &str) -> Option<HKEY> {
            let w: Vec<u16> = sub.encode_utf16().chain(Some(0)).collect();
            let mut h = HKEY::default();
            let r = unsafe { RegOpenKeyExW(parent, PCWSTR(w.as_ptr()), None, KEY_READ, &mut h) };
            if r.0 == 0 {
                Some(h)
            } else {
                None
            }
        }
        fn subkeys(h: HKEY) -> Vec<String> {
            let mut out = Vec::new();
            for i in 0..256u32 {
                let mut buf = [0u16; 512];
                let mut n = buf.len() as u32;
                let r = unsafe { RegEnumKeyExW(h, i, Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut n, None, None, None, None) };
                if r.0 != 0 {
                    break;
                }
                out.push(String::from_utf16_lossy(&buf[..n as usize]));
            }
            out
        }
        fn qword(h: HKEY, name: &str) -> u64 {
            let w: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let mut v: u64 = 0;
            let mut n = 8u32;
            let r = unsafe { RegQueryValueExW(h, PCWSTR(w.as_ptr()), None, None, Some(&mut v as *mut u64 as *mut u8), Some(&mut n)) };
            if r.0 == 0 && n == 8 {
                v
            } else {
                0
            }
        }
        fn read(h: HKEY, name: &str, out: &mut Vec<crate::companion::CapUse>) {
            out.push(crate::companion::CapUse { app: name.to_string(), start: qword(h, "LastUsedTimeStart"), stop: qword(h, "LastUsedTimeStop") });
        }
        let mut out = Vec::new();
        let base = format!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{}", kind);
        let Some(root) = open(HKEY_CURRENT_USER, &base) else { return out };
        for name in subkeys(root) {
            let Some(k) = open(root, &name) else { continue };
            if name == "NonPackaged" {
                for app in subkeys(k) {
                    if let Some(a) = open(k, &app) {
                        read(a, &app, &mut out);
                        let _ = unsafe { RegCloseKey(a) };
                    }
                }
            } else {
                read(k, &name, &mut out);
            }
            let _ = unsafe { RegCloseKey(k) };
        }
        let _ = unsafe { RegCloseKey(root) };
        out
    }

    /// The cursor in screen pixels -- straight from Windows, from any thread, without asking the
    /// app's main thread (the click-through loop runs 30 times a second and must never wait on it).
    pub fn cursor() -> Option<(i32, i32)> {
        let mut p = windows::Win32::Foundation::POINT::default();
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) }.ok()?;
        Some((p.x, p.y))
    }

    /// The window's outer rectangle in screen pixels (same: from any thread, no main-thread call).
    pub fn window_rect(ours: isize) -> Option<(i32, i32, i32, i32)> {
        let mut r = windows::Win32::Foundation::RECT::default();
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd_of(ours), &mut r) }.ok()?;
        Some((r.left, r.top, r.right, r.bottom))
    }

    pub fn minimized(ours: isize) -> bool {
        unsafe { windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd_of(ours)) }.as_bool()
    }

    /// Is this virtual key down now (the physical state, from any thread)?
    pub fn key_down(vk: u16) -> bool {
        (unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Front, Ink};
    pub fn front(_ours: isize) -> Front {
        Front::Unknown
    }
    pub fn quns() -> crate::policy::Quns {
        crate::policy::Quns::Other
    }
    pub fn monitor_of(_ours: isize) -> isize {
        0
    }
    pub fn front_window(_ours: isize) -> Option<crate::policy::FrontWin> {
        None
    }
    pub fn power() -> (bool, bool) {
        (false, false)
    }
    pub fn power_report() -> crate::policy::PowerReport {
        crate::policy::PowerReport::default()
    }
    pub fn watch_power(_hook: Box<dyn Fn() + Send + Sync>) {}
    pub fn keep_full_speed() -> bool {
        false
    }
    pub fn locked() -> bool {
        false
    }
    pub fn reduce_motion() -> bool {
        false
    }
    pub fn wallpaper_ink(_: f64, _: f64, _: f64, _: f64) -> Option<Ink> {
        None
    }
    pub fn behind_icons(_ours: isize) -> bool {
        false
    }
    pub fn leave_icons(_ours: isize) {}
    pub fn cursor() -> Option<(i32, i32)> {
        None
    }
    pub fn monitors() -> Vec<crate::companion::Monitor> {
        Vec::new()
    }
    pub fn to_top(_ours: isize) {}
    pub fn cap_use(_kind: &str) -> Vec<crate::companion::CapUse> {
        Vec::new()
    }
    pub fn window_rect(_ours: isize) -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub fn minimized(_ours: isize) -> bool {
        false
    }
    pub fn key_down(_vk: u16) -> bool {
        false
    }
}

pub use imp::*;

/// The Windows virtual-key code of a shortcut's main key ("Ctrl+Space" -> 0x20), for the ones the
/// settings offer: Space, A-Z, 0-9, F1-F24, Enter, Tab, Backquote. None for anything else.
pub fn vk_of(shortcut: &str) -> Option<u16> {
    let k = shortcut.rsplit('+').next()?.trim();
    let u = k.to_ascii_uppercase();
    match u.as_str() {
        "SPACE" => return Some(0x20),
        "ENTER" | "RETURN" => return Some(0x0D),
        "TAB" => return Some(0x09),
        "BACKQUOTE" | "`" => return Some(0xC0),
        _ => {}
    }
    let k = u.strip_prefix("KEY").or_else(|| u.strip_prefix("DIGIT")).unwrap_or(&u);
    if k.len() == 1 {
        let c = k.as_bytes()[0];
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            return Some(c as u16);
        }
    }
    if let Some(n) = u.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x70 + n - 1);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn talk_key_codes() {
        assert_eq!(vk_of("Ctrl+Space"), Some(0x20));
        assert_eq!(vk_of("Ctrl+Alt+Space"), Some(0x20));
        assert_eq!(vk_of("Ctrl+Shift+K"), Some(b'K' as u16));
        assert_eq!(vk_of("Alt+KeyT"), Some(b'T' as u16));
        assert_eq!(vk_of("Ctrl+F9"), Some(0x78));
        assert_eq!(vk_of("Ctrl+7"), Some(b'7' as u16));
        assert_eq!(vk_of("Ctrl+PageUp"), None);
    }

    #[test]
    fn ink_follows_the_wallpaper() {
        assert_eq!(ink_for_luminance(luminance(255, 255, 255)), Ink::Dark);
        assert_eq!(ink_for_luminance(luminance(0, 0, 0)), Ink::Light);
        // The mockup's three wallpapers: a light lavender, a dark navy, a sunset photo.
        assert_eq!(ink_for_luminance(luminance(0xEC, 0xF0, 0xFA)), Ink::Dark);
        assert_eq!(ink_for_luminance(luminance(0x10, 0x1A, 0x3A)), Ink::Light);
        assert_eq!(ink_for_luminance(luminance(0x9A, 0x5A, 0x96)), Ink::Light);
        // A mid grey is "busy": light ink on the tinted pills.
        assert_eq!(ink_for_luminance(luminance(128, 128, 128)), Ink::Light);
        assert!((luminance(255, 255, 255) - 1.0).abs() < 1e-6);
    }
}
