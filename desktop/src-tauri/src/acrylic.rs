//! Real blur behind the cards: the native acrylic windows (Windows only; elsewhere every call does nothing).
//!
//! The decisions are blur.rs's; this carries them out. A pool of small borderless popup windows, one per
//! glass surface the page reports, each with Windows' acrylic accent (SetWindowCompositionAttribute,
//! ACCENT_ENABLE_ACRYLICBLURBEHIND -- the same on Windows 10 1809+ and Windows 11), a rounded window region
//! matching the CSS radius, kept **directly below the main window** in the z-order, so the acrylic blurs
//! what is behind JOYA AI (the wallpaper, other windows) and the main window's card is drawn on top of it.
//!
//! Why the accent and not Windows 11's DWMWA_SYSTEMBACKDROP_TYPE (Acrylic / "transient window"): a system
//! backdrop is drawn only while its window is active and falls back to a flat colour otherwise; these
//! windows are never active (they must not take the focus), so the accent is the one that stays blurred.
//!
//! The windows never take the focus or a click: WS_EX_NOACTIVATE, MA_NOACTIVATE, no taskbar / Alt+Tab
//! (WS_EX_TOOLWINDOW). They sit inside surfaces the page also reports as hit regions, so the main window
//! (above them) is already catching the mouse whenever the cursor is over one; should the cursor reach a
//! blur window in the ~33 ms before the click-through loop notices, the window asks the app at once to
//! make the main window catch the mouse (`on_cursor`) -- the next event goes to the page, as it would have.
//!
//! A shown blur window is never moved or resized (blur::plan): Windows draws the acrylic of a window that
//! moves or changes size late, and sometimes leaves it where it was -- 0.1.9's grey corners and strips round
//! the glance cards. A surface that moves or changes size gets a fresh window; the old one is destroyed.
//! And the page's rectangles are used only in the window size it measured them in (blur::view_matches).
//!
//! They follow the main window without any polling: the main window is subclassed and every
//! WM_WINDOWPOSCHANGED (moved, resized, shown, hidden, raised or lowered -- including Tauri's own
//! always-on-bottom, which pushes it to HWND_BOTTOM on every z-order change) re-places them under it.
//! Everything that changes them runs on the main thread (a posted message when the change comes from
//! another thread); nothing here runs per frame.

use crate::blur::{self, Place, System};
use crate::hit::Region;
use std::sync::Mutex;

/// What the rest of the app tells this module (any thread). Read by `sync` on the main thread.
#[derive(Default)]
struct Input {
    rects: Vec<Region>,
    dpr: f64,
    /// The page's viewport (CSS px) when it measured them (None: a page from before 0.1.10).
    view: Option<(f64, f64)>,
    /// blur::page_glass: the setting, the system, the opacity, not behind the icons.
    glass: bool,
    dragging: bool,
    light_ink: bool,
    system: System,
}

static INPUT: Mutex<Option<Input>> = Mutex::new(None);

fn with_input<R>(f: impl FnOnce(&mut Input) -> R) -> R {
    let mut g = INPUT.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Input::default))
}

/// The page's glass surfaces (CSS px), its devicePixelRatio and the viewport it measured them in.
pub fn set_rects(rects: Vec<Region>, dpr: f64, view: Option<(f64, f64)>) {
    let rects = blur::clean(rects);
    let changed = with_input(|i| {
        let ch = i.rects != rects || i.dpr != dpr || i.view != view;
        i.rects = rects;
        i.dpr = dpr;
        i.view = view;
        ch
    });
    if changed {
        imp::request_sync();
    }
}

/// The page's glass flag (blur::page_glass) and the ink (for the acrylic's faint own tint).
pub fn set_glass(glass: bool, light_ink: bool) {
    let changed = with_input(|i| {
        let ch = i.glass != glass || i.light_ink != light_ink;
        i.glass = glass;
        i.light_ink = light_ink;
        ch
    });
    if changed {
        imp::request_sync();
    }
}

/// The Floating box is being dragged (start_drag) or was dropped (snap).
pub fn set_dragging(on: bool) {
    let changed = with_input(|i| std::mem::replace(&mut i.dragging, on) != on);
    if changed {
        imp::request_sync();
    }
}

/// What Windows allows, read again (the environment loop, every few seconds). Returns it, and whether it changed.
pub fn refresh_system() -> (System, bool) {
    let now = imp::read_system();
    let changed = with_input(|i| std::mem::replace(&mut i.system, now) != now);
    if changed {
        imp::request_sync();
    }
    (now, changed)
}

/// The last read of what Windows allows.
pub fn system() -> System {
    with_input(|i| i.system)
}

pub use imp::{init, live};

#[cfg(windows)]
mod imp {
    use super::{blur, with_input, Place};
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use windows::core::{w, BOOL, PCSTR, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};
    use windows::Win32::Graphics::Gdi::{ClientToScreen, CreateRoundRectRgn, GetStockObject, SetWindowRgn, BLACK_BRUSH, HBRUSH};
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
    use windows::Win32::UI::Controls::MARGINS;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const WM_SYNC: u32 = WM_APP + 0x4D1;
    const SUBCLASS_ID: usize = 0x4D49_4E54; // "JOYA"

    /// The main window, the hidden message window that receives posted syncs, and whether one is queued.
    static MAIN: AtomicIsize = AtomicIsize::new(0);
    static HELPER: AtomicIsize = AtomicIsize::new(0);
    static PENDING: AtomicBool = AtomicBool::new(false);
    /// The app's two callbacks (main thread): the cursor reached a blur window (make the main window catch
    /// the mouse now); what Windows allows changed (tell the page).
    static HOOKS: std::sync::OnceLock<(fn(), fn())> = std::sync::OnceLock::new();
    thread_local! {
        /// The tint the shown windows have (main thread only).
        static TINT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }

    /// One shown acrylic window: where it was shown (it never moves -- blur::plan), its band, its tint.
    struct Win {
        hw: HWND,
        at: Place,
        topmost: bool,
    }
    /// The pool (main thread only): a slot holds a shown window or nothing.
    struct Pool {
        slots: Vec<Option<Win>>,
    }
    thread_local! {
        static POOL: RefCell<Pool> = const { RefCell::new(Pool { slots: Vec::new() }) };
    }

    fn h(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    /// Set up (on the main thread, once the main window exists): the window class, the message window,
    /// the main window's subclass. `on_cursor` runs when the pointer reaches a blur window, `on_system`
    /// when Windows' transparency effects or high contrast change.
    pub fn init(main: isize, on_cursor: fn(), on_system: fn()) {
        if main == 0 || MAIN.load(Ordering::SeqCst) != 0 {
            return;
        }
        let _ = HOOKS.set((on_cursor, on_system));
        unsafe {
            let Ok(inst) = GetModuleHandleW(PCWSTR::null()) else { return };
            let wc = WNDCLASSW {
                lpfnWndProc: Some(blur_proc),
                hInstance: inst.into(),
                lpszClassName: w!("JoyaAcrylic"),
                // Black is "nothing" under DWM's extended frame: only the acrylic shows.
                hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let helper = CreateWindowExW(WINDOW_EX_STYLE(0), w!("JoyaAcrylic"), PCWSTR::null(), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(inst.into()), None);
            let Ok(helper) = helper else {
                mlog!("acrylic: no message window; real blur is off");
                return;
            };
            HELPER.store(helper.0 as isize, Ordering::SeqCst);
            MAIN.store(main, Ordering::SeqCst);
            if !SetWindowSubclass(h(main), Some(main_proc), SUBCLASS_ID, 0).as_bool() {
                mlog!("acrylic: could not follow the main window; real blur is off");
                MAIN.store(0, Ordering::SeqCst);
                return;
            }
        }
        let (sys, _) = super::refresh_system();
        mlog!("acrylic: ready (Windows build {}, transparency {}, high contrast {})", sys.build, sys.transparency, sys.high_contrast);
        request_sync();
    }

    /// Is the module running (a main window followed)?
    pub fn live() -> bool {
        MAIN.load(Ordering::SeqCst) != 0
    }

    /// Ask for a sync on the main thread (from any thread; several requests make one sync).
    pub fn request_sync() {
        let helper = HELPER.load(Ordering::SeqCst);
        if helper == 0 {
            return;
        }
        if !PENDING.swap(true, Ordering::SeqCst) {
            unsafe {
                if PostMessageW(Some(h(helper)), WM_SYNC, WPARAM(0), LPARAM(0)).is_err() {
                    PENDING.store(false, Ordering::SeqCst);
                }
            }
        }
    }

    unsafe extern "system" fn main_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
        let r = DefSubclassProc(hwnd, msg, wp, lp);
        if msg == WM_WINDOWPOSCHANGED {
            // Right away, so the blur is never a frame out of place (or above the card).
            sync();
        } else if msg == WM_DPICHANGED || msg == WM_DISPLAYCHANGE || msg == WM_DWMCOMPOSITIONCHANGED {
            request_sync();
        }
        r
    }

    unsafe extern "system" fn blur_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_SYNC => {
                PENDING.store(false, Ordering::SeqCst);
                sync();
                LRESULT(0)
            }
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            WM_NCHITTEST => {
                if let Some((f, _)) = HOOKS.get() {
                    f();
                }
                LRESULT(HTCLIENT as isize)
            }
            WM_SETTINGCHANGE | WM_THEMECHANGED | WM_SYSCOLORCHANGE => {
                // Transparency effects or high contrast switched: read them again (the message window gets these too).
                let (_, changed) = super::refresh_system();
                if let (true, Some((_, f))) = (changed, HOOKS.get()) {
                    f();
                }
                DefWindowProcW(hwnd, msg, wp, lp)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    fn new_blur_window() -> Option<HWND> {
        unsafe {
            let inst = GetModuleHandleW(PCWSTR::null()).ok()?;
            let ex = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            let hw = CreateWindowExW(ex, w!("JoyaAcrylic"), w!("JOYA AI blur"), WS_POPUP, 0, 0, 1, 1, None, None, Some(inst.into()), None).ok()?;
            let margins = MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 };
            let _ = DwmExtendFrameIntoClientArea(hw, &margins);
            let one: u32 = 1;
            // No show / hide animation (DWMWA_TRANSITIONS_FORCEDISABLED), not shown by Aero Peek.
            let _ = DwmSetWindowAttribute(hw, DWMWINDOWATTRIBUTE(3), &one as *const u32 as _, 4);
            let _ = DwmSetWindowAttribute(hw, DWMWINDOWATTRIBUTE(12), &one as *const u32 as _, 4);
            // Windows 11: no corner rounding or border of its own (DWMWA_WINDOW_CORNER_PREFERENCE = DONOTROUND,
            // DWMWA_BORDER_COLOR = none); the region gives the CSS radius. Refused on Windows 10, harmlessly.
            let _ = DwmSetWindowAttribute(hw, DWMWINDOWATTRIBUTE(33), &one as *const u32 as _, 4);
            let none: u32 = 0xFFFF_FFFE;
            let _ = DwmSetWindowAttribute(hw, DWMWINDOWATTRIBUTE(34), &none as *const u32 as _, 4);
            Some(hw)
        }
    }

    #[repr(C)]
    struct AccentPolicy {
        state: u32,
        flags: u32,
        colour: u32,
        animation: u32,
    }
    #[repr(C)]
    struct CompositionData {
        attrib: u32,
        data: *mut core::ffi::c_void,
        size: usize,
    }
    type Swca = unsafe extern "system" fn(HWND, *mut CompositionData) -> BOOL;

    /// The acrylic accent on (state 4, with its faint tint) or off (0).
    fn accent(hw: HWND, on: bool, colour: u32) -> bool {
        unsafe {
            let Ok(user32) = GetModuleHandleW(w!("user32.dll")) else { return false };
            let Some(f) = GetProcAddress(user32, PCSTR(b"SetWindowCompositionAttribute\0".as_ptr())) else { return false };
            let f: Swca = std::mem::transmute(f);
            let mut p = AccentPolicy { state: if on { 4 } else { 0 }, flags: 0, colour, animation: 0 };
            let mut d = CompositionData { attrib: 19, data: &mut p as *mut _ as _, size: std::mem::size_of::<AccentPolicy>() };
            f(hw, &mut d).as_bool()
        }
    }

    /// Bring the pool in line with the input: blur.rs decides, this places.
    fn sync() {
        let main = MAIN.load(Ordering::SeqCst);
        if main == 0 {
            return;
        }
        let mw = h(main);
        let (rects, dpr, view, glass, dragging, light) = with_input(|i| (i.rects.clone(), i.dpr, i.view, i.glass, i.dragging, i.light_ink));
        let visible = unsafe { IsWindowVisible(mw).as_bool() && !IsIconic(mw).as_bool() };
        let dpi = unsafe { GetDpiForWindow(mw) };
        let show = blur::showing(glass, visible, dragging, blur::dpr_matches(dpr, dpi));
        let next: Vec<Place> = if show && !rects.is_empty() {
            let mut o = POINT { x: 0, y: 0 };
            let mut c = RECT::default();
            unsafe {
                let _ = ClientToScreen(mw, &mut o);
                let _ = GetClientRect(mw, &mut c);
            }
            let (cw, ch) = (c.right - c.left, c.bottom - c.top);
            // Measured in another window size (the app resized it; the page has not measured again yet):
            // nothing until it has, rather than blur out of place.
            if blur::view_matches(view, dpr, cw, ch) {
                blur::place(&rects, dpr, (o.x, o.y), cw, ch)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        let topmost = unsafe { (GetWindowLongPtrW(mw, GWL_EXSTYLE) as u32) & WS_EX_TOPMOST.0 != 0 };
        let colour = blur::accent_colour(light);
        let done = POOL.try_with(|p| {
            let Ok(mut pool) = p.try_borrow_mut() else { return false };
            apply(&mut pool, mw, &next, topmost, colour);
            true
        });
        if !matches!(done, Ok(true)) {
            request_sync(); // busy (a sync inside a sync): again from the message loop
        }
    }

    fn apply(pool: &mut Pool, main: HWND, next: &[Place], topmost: bool, colour: u32) {
        let next = &next[..next.len().min(blur::MAX_BLUR)];
        let current: Vec<Option<Place>> = pool.slots.iter().map(|w| w.as_ref().map(|w| w.at)).collect();
        let ops = blur::plan(&current, next);
        // For the laptop check: a line whenever the set of blur windows changes (not when they are only
        // re-stacked under the main window), with where they are and whether they are topmost.
        let changed = ops.iter().any(|o| !matches!(o, blur::Op::Keep { .. }));
        let band = pool.slots.iter().flatten().any(|w| w.topmost != topmost);
        if changed || band {
            let list: Vec<String> = next.iter().map(|p| format!("({}, {}) {}x{}", p.x, p.y, p.w, p.h)).collect();
            mlog!("acrylic: {} blur window(s){}{}", next.len(), if next.is_empty() { String::new() } else { format!(" at {}", list.join(", ")) }, if topmost { ", topmost" } else { "" });
        }
        unsafe {
            // Hides first (their windows destroyed: a window that showed one place never shows another);
            // then every placement, in order, right under the main window.
            for op in &ops {
                if let blur::Op::Hide { slot } = *op {
                    if let Some(w) = pool.slots.get_mut(slot).and_then(|s| s.take()) {
                        let _ = ShowWindow(w.hw, SW_HIDE);
                        let _ = DestroyWindow(w.hw);
                    }
                }
            }
            let mut after = main;
            for op in &ops {
                match *op {
                    blur::Op::Hide { .. } => {}
                    blur::Op::Keep { slot, .. } => {
                        let Some(w) = pool.slots.get_mut(slot).and_then(|s| s.as_mut()) else { continue };
                        // In the same band as the main window: topmost with it (Floating, Peek), not (Desktop layer).
                        if w.topmost != topmost {
                            let _ = SetWindowPos(w.hw, Some(if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST }), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
                            w.topmost = topmost;
                        }
                        // Re-stacked only: never moved or resized while shown.
                        let _ = SetWindowPos(w.hw, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
                        after = w.hw;
                    }
                    blur::Op::Show { slot, at } => {
                        // A fresh window: tint, rounded region and band set while it is still hidden, then
                        // shown once, at its place, right under the one before.
                        let Some(hw) = new_blur_window() else { continue };
                        let _ = accent(hw, true, colour);
                        // The region's right / bottom edges are exclusive: one more pixel each way.
                        let rgn = CreateRoundRectRgn(0, 0, at.w + 1, at.h + 1, 2 * at.r, 2 * at.r);
                        SetWindowRgn(hw, Some(rgn), false); // the system owns the region now
                        if topmost {
                            let _ = SetWindowPos(hw, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
                        }
                        let _ = SetWindowPos(hw, Some(after), at.x, at.y, at.w, at.h, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
                        if pool.slots.len() <= slot {
                            pool.slots.resize_with(slot + 1, || None);
                        }
                        pool.slots[slot] = Some(Win { hw, at, topmost });
                        after = hw;
                    }
                }
            }
            // The tint follows the ink on the windows kept (new ones were made with it).
            if TINT.with(|t| t.replace(colour)) != colour {
                for w in pool.slots.iter().flatten() {
                    let _ = accent(w.hw, true, colour);
                }
            }
        }
    }

    /// What Windows allows now: its build, transparency effects, high contrast, energy saver.
    pub fn read_system() -> blur::System {
        blur::System { build: build(), transparency: transparency(), high_contrast: high_contrast(), energy_saver: crate::platform::power().1 }
    }

    /// The real build number (RtlGetVersion; GetVersionEx lies to apps without a manifest entry).
    fn build() -> u32 {
        #[repr(C)]
        struct OsVersion {
            size: u32,
            major: u32,
            minor: u32,
            build: u32,
            platform: u32,
            csd: [u16; 128],
        }
        type RtlGetVersion = unsafe extern "system" fn(*mut OsVersion) -> i32;
        unsafe {
            let Ok(ntdll) = GetModuleHandleW(w!("ntdll.dll")) else { return 0 };
            let Some(f) = GetProcAddress(ntdll, PCSTR(b"RtlGetVersion\0".as_ptr())) else { return 0 };
            let f: RtlGetVersion = std::mem::transmute(f);
            let mut v = OsVersion { size: std::mem::size_of::<OsVersion>() as u32, major: 0, minor: 0, build: 0, platform: 0, csd: [0; 128] };
            if f(&mut v) != 0 || v.major < 10 {
                return 0;
            }
            v.build
        }
    }

    /// Settings ▸ Personalization ▸ Colours ▸ Transparency effects (on when the value is missing).
    fn transparency() -> bool {
        let mut v: u32 = 1;
        let mut n = 4u32;
        let r = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
                w!("EnableTransparency"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut v as *mut u32 as _),
                Some(&mut n),
            )
        };
        if r.is_err() {
            return true;
        }
        v != 0
    }

    fn high_contrast() -> bool {
        let mut hc = HIGHCONTRASTW { cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32, ..Default::default() };
        let ok = unsafe { SystemParametersInfoW(SPI_GETHIGHCONTRAST, hc.cbSize, Some(&mut hc as *mut _ as _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) };
        ok.is_ok() && (hc.dwFlags.0 & HCF_HIGHCONTRASTON.0) != 0
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn init(_main: isize, _on_cursor: fn(), _on_system: fn()) {}
    pub fn live() -> bool {
        false
    }
    pub fn request_sync() {}
    pub fn read_system() -> crate::blur::System {
        crate::blur::System::default()
    }
}
