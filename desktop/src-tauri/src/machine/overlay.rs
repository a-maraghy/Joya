//! "JOYA AI is controlling" -- always visible while a lease is on: a glowing frame round every
//! monitor and the pill at the top of the primary monitor (time left, +15 min, Stop).
//!
//! Since 0.1.7 both are plain Win32 layered windows drawn by the app itself (the layout and the
//! shading are overlay_layout.rs, pure and unit-tested), not WebView2 pages: 0.1.6's full-monitor
//! WebView2 frame and its WebView2 pill could show as a white block over the screen (2026-10-08). Now:
//!
//! * the frame is four thin strips per monitor along its edges, each click-through (WS_EX_TRANSPARENT)
//!   and never activated -- nothing of it is over the middle of any screen;
//! * the pill is a window exactly its own rounded shape, click-through as well; its two buttons
//!   (+15 min, Stop) are their own small windows on top of it, the only parts that take a click, and
//!   they never take the focus (WS_EX_NOACTIVATE, MA_NOACTIVATE);
//! * every pixel is drawn into the window (UpdateLayeredWindow, per-pixel alpha) BEFORE it is shown,
//!   so nothing ever flashes white; outside the shapes the pixels are fully transparent;
//! * all of them are excluded from screen capture (WDA_EXCLUDEFROMCAPTURE), topmost, and kept out of
//!   the taskbar and Alt+Tab (WS_EX_TOOLWINDOW).
//!
//! Each show logs where every window went ("control frame ..." / "control pill ..."), for the laptop check.
//! Call show / hide on the main thread.

use super::overlay_layout::{self as ol, Rect};
use tauri::AppHandle;

/// Show the frame and the pill (replacing any shown before).
pub fn show(app: &AppHandle) {
    hide(app);
    let mons = app.available_monitors().unwrap_or_default();
    let frames: Vec<(Rect, f64)> = mons
        .iter()
        .map(|m| (Rect::new(m.position().x, m.position().y, m.size().width as i32, m.size().height as i32), m.scale_factor()))
        .collect();
    let primary = app.primary_monitor().ok().flatten().or_else(|| mons.first().cloned());
    let pill = primary.map(|m| {
        let wa = m.work_area();
        (Rect::new(wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32), m.scale_factor())
    });
    imp::show(app, &frames, pill);
}

/// Take the frame and the pill away (nothing happens when none is shown).
pub fn hide(_app: &AppHandle) {
    imp::hide();
}

#[cfg(not(windows))]
mod imp {
    use super::Rect;
    pub fn show(_app: &tauri::AppHandle, frames: &[(Rect, f64)], pill: Option<(Rect, f64)>) {
        mlog!("control overlay: not drawn on this platform ({} monitor(s), pill {:?})", frames.len(), pill.map(|p| p.0));
    }
    pub fn hide() {}
}

#[cfg(windows)]
mod imp {
    use super::{ol, Rect};
    use std::cell::RefCell;
    use std::sync::OnceLock;
    use tauri::AppHandle;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, GdiFlush, GetDC, GetTextExtentPoint32W, ReleaseDC, SelectObject, SetBkMode, SetTextColor, TextOutW, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS, HDC, HFONT, HGDIOBJ, OUT_DEFAULT_PRECIS, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const CLASS: PCWSTR = w!("JoyaControlOverlay");
    const TIMER_TICK: usize = 1;
    const WM_REFRESH: u32 = WM_APP + 0x4D2;
    /// WM_MOUSELEAVE (winuser.h), asked for with TrackMouseEvent(TME_LEAVE).
    const MOUSE_LEFT: u32 = 0x02A3;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static CLASS_OK: OnceLock<bool> = OnceLock::new();

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Btn {
        More,
        Stop,
    }

    struct Fonts {
        label: HFONT,
        text: HFONT,
        bold: HFONT,
        button: HFONT,
        key: HFONT,
    }

    struct Pill {
        body: HWND,
        more: HWND,
        stop: HWND,
        layout: ol::PillLayout,
        fonts: Fonts,
        hover: Option<Btn>,
        /// The "Last: …" line under the pill (click-through; shown from the first action on).
        last: Option<HWND>,
        last_rect: Rect,
        last_shown: String,
    }

    #[derive(Default)]
    struct State {
        frames: Vec<HWND>,
        pill: Option<Pill>,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::new(State::default());
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
    fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16)
    }

    // The pill's colours (0.1.6's CSS): navy fill, joya border, light text.
    const FILL: (u8, u8, u8) = (16, 18, 40);
    const FILL_A: u8 = 240;
    const INK: (u8, u8, u8) = (242, 243, 250);
    const DIM: (u8, u8, u8) = (128, 130, 146);
    const KEY: (u8, u8, u8) = (176, 178, 192);
    const ENDED_EDGE: (u8, u8, u8) = (96, 98, 116);
    const MORE: (u8, u8, u8) = (44, 46, 72);
    const MORE_HOVER: (u8, u8, u8) = (64, 66, 96);
    const MORE_EDGE: (u8, u8, u8) = (98, 100, 128);
    const STOP: (u8, u8, u8) = (0xD9, 0x2D, 0x4F);
    const STOP_HOVER: (u8, u8, u8) = (0xF0, 0x33, 0x5A);

    fn register() -> bool {
        *CLASS_OK.get_or_init(|| unsafe {
            let Ok(inst) = GetModuleHandleW(PCWSTR::null()) else { return false };
            let wc = WNDCLASSW {
                lpfnWndProc: Some(proc_),
                hInstance: inst.into(),
                lpszClassName: CLASS,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                ..Default::default()
            };
            RegisterClassW(&wc) != 0
        })
    }

    fn create(ex: WINDOW_EX_STYLE, r: Rect, owner: Option<HWND>, title: PCWSTR) -> Option<HWND> {
        unsafe {
            let inst = GetModuleHandleW(PCWSTR::null()).ok()?;
            CreateWindowExW(ex | WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, CLASS, title, WS_POPUP, r.x, r.y, r.w.max(1), r.h.max(1), owner, None, Some(inst.into()), None).ok()
        }
    }

    /// Out of every capture (screenshots, screen sharing), then shown without activating.
    fn reveal(h: HWND) {
        unsafe {
            if SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE).is_err() {
                mlog!("control overlay: could not exclude a window from capture (older Windows?)");
            }
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }

    /// A 32-bit top-down DIB of w x h on a memory DC, handed to `draw` (DC and BGRA pixels), then put
    /// into the window with per-pixel alpha (the pixels must be premultiplied by then).
    fn paint(hwnd: HWND, r: Rect, draw: impl FnOnce(HDC, &mut [u32])) -> bool {
        if r.w <= 0 || r.h <= 0 {
            return false;
        }
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: r.w, biHeight: -r.h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let ok = match CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(bmp) if !bits.is_null() => {
                    let old = SelectObject(mem, HGDIOBJ(bmp.0));
                    let px = std::slice::from_raw_parts_mut(bits as *mut u32, (r.w * r.h) as usize);
                    draw(mem, px);
                    let _ = GdiFlush();
                    let blend = BLENDFUNCTION { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 1 };
                    let at = POINT { x: r.x, y: r.y };
                    let size = SIZE { cx: r.w, cy: r.h };
                    let src = POINT { x: 0, y: 0 };
                    let res = UpdateLayeredWindow(hwnd, Some(screen), Some(&at), Some(&size), Some(mem), Some(&src), COLORREF(0), Some(&blend), ULW_ALPHA);
                    SelectObject(mem, old);
                    let _ = DeleteObject(HGDIOBJ(bmp.0));
                    if let Err(e) = &res {
                        mlog!("control overlay: drawing a window failed: {}", e);
                    }
                    res.is_ok()
                }
                _ => {
                    mlog!("control overlay: no bitmap for a {}x{} window", r.w, r.h);
                    false
                }
            };
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            ok
        }
    }

    fn bgra(c: (u8, u8, u8, u8)) -> u32 {
        (c.3 as u32) << 24 | (c.0 as u32) << 16 | (c.1 as u32) << 8 | c.2 as u32
    }
    fn rgb_of(p: u32) -> (u8, u8, u8) {
        ((p >> 16) as u8, (p >> 8) as u8, p as u8)
    }

    /* ------------------------------------------------------------- the frame */

    fn frame_strip(mon: Rect, scale: f64, strip: Rect) -> Option<HWND> {
        let h = create(WS_EX_TRANSPARENT, strip, None, w!("JOYA AI is controlling this computer"))?;
        let (r, g, b) = ol::JOYA;
        let drawn = paint(h, strip, |_, px| {
            for y in 0..strip.h {
                for x in 0..strip.w {
                    let d = ol::edge_distance(strip.x - mon.x + x, strip.y - mon.y + y, mon.w, mon.h);
                    let a = ol::frame_alpha(d, scale) as u32;
                    let pm = |c: u8| ((c as u32 * a + 127) / 255) as u8;
                    px[(y * strip.w + x) as usize] = bgra((pm(r), pm(g), pm(b), a as u8));
                }
            }
        });
        if !drawn {
            unsafe {
                let _ = DestroyWindow(h);
            }
            return None;
        }
        reveal(h);
        Some(h)
    }

    /* -------------------------------------------------------------- the pill */

    fn font(px: f64, weight: i32, face: PCWSTR) -> HFONT {
        unsafe { CreateFontW(-(px.round() as i32).max(8), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, 0, face) }
    }

    fn fonts(s: f64) -> Fonts {
        Fonts {
            label: font(13.0 * s, 600, w!("Segoe UI")),
            text: font(13.0 * s, 400, w!("Segoe UI")),
            bold: font(13.0 * s, 600, w!("Segoe UI")),
            button: font(12.5 * s, 600, w!("Segoe UI")),
            key: font(11.5 * s, 400, w!("Consolas")),
        }
    }

    fn free_fonts(f: &Fonts) {
        unsafe {
            for h in [f.label, f.text, f.bold, f.button, f.key] {
                let _ = DeleteObject(HGDIOBJ(h.0));
            }
        }
    }

    fn measure(dc: HDC, f: HFONT, s: &str) -> SIZE {
        let mut sz = SIZE::default();
        unsafe {
            let old = SelectObject(dc, HGDIOBJ(f.0));
            let _ = GetTextExtentPoint32W(dc, &wide(s), &mut sz);
            SelectObject(dc, old);
        }
        sz
    }

    const LABEL: &str = "JOYA AI is controlling";
    const SEP: &str = "\u{00B7}";
    const MORE_T: &str = "+15 min";
    const STOP_T: &str = "Stop";

    /// The time and the stop key from the lease, now; None when the state is busy this moment.
    fn view() -> Option<(bool, String, String)> {
        let v = super::super::machine_pill_now()?;
        let key = if v.stop_key.is_empty() { "Ctrl+Alt+Esc".to_string() } else { v.stop_key.clone() };
        Some((v.active, ol::time_text(v.active, &v.left), key))
    }

    fn text_at(dc: HDC, f: HFONT, colour: (u8, u8, u8), x: i32, box_h: i32, s: &str) {
        unsafe {
            let old = SelectObject(dc, HGDIOBJ(f.0));
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, rgb(colour.0, colour.1, colour.2));
            let wv = wide(s);
            let mut sz = SIZE::default();
            let _ = GetTextExtentPoint32W(dc, &wv, &mut sz);
            let _ = TextOutW(dc, x, (box_h - sz.cy) / 2, &wv);
            SelectObject(dc, old);
        }
    }

    /// Fill a w x h buffer with an opaque base colour (the text is drawn over it), then shape it:
    /// the rounded outline with its border, everything outside fully transparent, premultiplied.
    fn shape(px: &mut [u32], w: i32, h: i32, radius: i32, border: i32, fill_a: u8, edge: (u8, u8, u8), dot: Option<(Rect, (u8, u8, u8))>) {
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) as usize;
                let mut c = rgb_of(px[i]);
                if let Some((d, dc)) = dot {
                    let dd = ol::rounded_distance(x - d.x, y - d.y, d.w, d.h, d.w / 2);
                    let k = ol::coverage(dd);
                    if k > 0.0 {
                        let m = |a: u8, b: u8| (a as f64 * (1.0 - k) + b as f64 * k).round() as u8;
                        c = (m(c.0, dc.0), m(c.1, dc.1), m(c.2, dc.2));
                    }
                }
                px[i] = bgra(ol::shade(ol::rounded_distance(x, y, w, h, radius), border, c, fill_a, edge));
            }
        }
    }

    fn fill(px: &mut [u32], c: (u8, u8, u8)) {
        let v = bgra((c.0, c.1, c.2, 0));
        px.iter_mut().for_each(|p| *p = v);
    }

    fn draw_body(p: &Pill) {
        let l = p.layout;
        let Some((active, time, key)) = view() else { return };
        let edge = if active { ol::JOYA } else { ENDED_EDGE };
        let dot_c = if active { ol::JOYA } else { (136, 136, 136) };
        paint(p.body, l.window, |dc, px| {
            fill(px, FILL);
            if let Some(r) = l.label {
                text_at(dc, p.fonts.label, INK, r.x, l.window.h, LABEL);
            }
            if let Some(r) = l.sep {
                text_at(dc, p.fonts.text, DIM, r.x, l.window.h, SEP);
            }
            text_at(dc, p.fonts.bold, INK, l.time.x, l.window.h, &time);
            if let Some(r) = l.key {
                text_at(dc, p.fonts.key, KEY, r.x, l.window.h, &key);
            }
            unsafe {
                let _ = GdiFlush();
            }
            shape(px, l.window.w, l.window.h, l.radius, l.border, FILL_A, edge, Some((l.dot, dot_c)));
        });
    }

    /// The last action under the pill: drawn when it changed, hidden while there is none.
    fn draw_last(p: &mut Pill) {
        let Some(h) = p.last else { return };
        let Some(v) = super::super::machine_pill_now() else { return };
        let text = if v.active { v.last.clone() } else { String::new() };
        if text == p.last_shown {
            return;
        }
        let first = p.last_shown.is_empty();
        p.last_shown = text.clone();
        if text.is_empty() {
            unsafe {
                let _ = ShowWindow(h, SW_HIDE);
            }
            return;
        }
        let r = p.last_rect;
        let f = p.fonts.text;
        let drawn = paint(h, r, |dc, px| {
            fill(px, FILL);
            // Cut to fit the line (with "…"), measured in the line's own font.
            let pad = (r.h / 2).max(6);
            let mut s = text.clone();
            let mut n = s.chars().count();
            while n > 4 && measure(dc, f, &s).cx > r.w - 2 * pad {
                n -= 4;
                s = ol::clip_chars(&text, n);
            }
            text_at(dc, f, KEY, pad, r.h, &s);
            unsafe {
                let _ = GdiFlush();
            }
            shape(px, r.w, r.h, r.h / 2, 1, FILL_A, ENDED_EDGE, None);
        });
        if drawn && first {
            reveal(h);
        }
    }

    fn draw_button(p: &Pill, b: Btn) {
        let l = p.layout;
        let (h, part, text, base, hover_c, edge) = match b {
            Btn::More => (p.more, l.more, MORE_T, MORE, MORE_HOVER, MORE_EDGE),
            Btn::Stop => (p.stop, l.stop, STOP_T, STOP, STOP_HOVER, STOP),
        };
        let c = if p.hover == Some(b) { hover_c } else { base };
        let r = ol::on_screen(l.window, part);
        paint(h, r, |dc, px| {
            fill(px, c);
            let tw = measure(dc, p.fonts.button, text).cx;
            text_at(dc, p.fonts.button, (255, 255, 255), (r.w - tw) / 2, r.h, text);
            unsafe {
                let _ = GdiFlush();
            }
            shape(px, r.w, r.h, r.h / 2, 1, 255, if p.hover == Some(b) { hover_c } else { edge }, None);
        });
    }

    fn make_pill(work: Rect, scale: f64) -> Option<Pill> {
        let f = fonts(scale);
        let (_, time, key) = view().unwrap_or((true, "--:-- left".to_string(), "Ctrl+Alt+Esc".to_string()));
        let widths = unsafe {
            let dc = CreateCompatibleDC(None);
            // The widest the time can be ("59:59 left") so the pill never resizes while it counts down.
            let time_w = measure(dc, f.bold, "59:59 left").cx.max(measure(dc, f.bold, &time).cx);
            let t = ol::TextWidths {
                label: measure(dc, f.label, LABEL).cx,
                sep: measure(dc, f.text, SEP).cx,
                time: time_w,
                more: measure(dc, f.button, MORE_T).cx,
                stop: measure(dc, f.button, STOP_T).cx,
                key: measure(dc, f.key, &key).cx,
            };
            let _ = DeleteDC(dc);
            t
        };
        let layout = ol::pill_layout(work, scale, widths);
        let title = w!("JOYA AI is controlling this computer");
        // The body takes no click at all; the two buttons, owned by it (always above it), do.
        let Some(body) = create(WS_EX_TRANSPARENT, layout.window, None, title) else {
            free_fonts(&f);
            return None;
        };
        let more = create(WINDOW_EX_STYLE(0), ol::on_screen(layout.window, layout.more), Some(body), w!("Give JOYA AI 15 more minutes"));
        let stop = create(WINDOW_EX_STYLE(0), ol::on_screen(layout.window, layout.stop), Some(body), w!("Stop JOYA AI's control now"));
        let (Some(more), Some(stop)) = (more, stop) else {
            unsafe {
                let _ = DestroyWindow(body); // destroys the owned buttons too
            }
            free_fonts(&f);
            mlog!("control pill: its buttons could not be created");
            return None;
        };
        let last_rect = ol::last_line_rect(layout.window, work, scale);
        let last = create(WS_EX_TRANSPARENT, last_rect, Some(body), w!("JOYA AI's last action"));
        let mut p = Pill { body, more, stop, layout, fonts: f, hover: None, last, last_rect, last_shown: String::new() };
        draw_last(&mut p);
        draw_body(&p);
        draw_button(&p, Btn::More);
        draw_button(&p, Btn::Stop);
        reveal(body);
        reveal(more);
        reveal(stop);
        unsafe {
            SetTimer(Some(body), TIMER_TICK, 1000, None);
        }
        Some(p)
    }

    /* ------------------------------------------------------------ show / hide */

    pub fn show(app: &AppHandle, frames: &[(Rect, f64)], pill: Option<(Rect, f64)>) {
        let _ = APP.set(app.clone());
        if !register() {
            mlog!("control overlay: the window class could not be registered; no frame or pill");
            return;
        }
        let mut wins = Vec::new();
        for (i, (mon, scale)) in frames.iter().enumerate() {
            let strips = ol::frame_strips(*mon, *scale);
            let mut n = 0;
            for s in &strips {
                if let Some(h) = frame_strip(*mon, *scale, *s) {
                    wins.push(h);
                    n += 1;
                }
            }
            mlog!(
                "control frame {}: monitor at ({}, {}) {}x{} px, scale {:.2}: {} of {} edge strips {} px deep (click-through, nothing over the middle)",
                i,
                mon.x,
                mon.y,
                mon.w,
                mon.h,
                scale,
                n,
                strips.len(),
                ol::frame_thickness(*scale)
            );
        }
        let p = pill.and_then(|(work, scale)| {
            let p = make_pill(work, scale);
            match &p {
                Some(p) => {
                    let l = p.layout;
                    let (m, s) = (ol::on_screen(l.window, l.more), ol::on_screen(l.window, l.stop));
                    mlog!(
                        "control pill: at ({}, {}) {}x{} px on the work area ({}, {}) {}x{} at scale {:.2}; +15 min at ({}, {}) {}x{}, Stop at ({}, {}) {}x{}; label {}, key hint {}",
                        l.window.x, l.window.y, l.window.w, l.window.h, work.x, work.y, work.w, work.h, scale, m.x, m.y, m.w, m.h, s.x, s.y, s.w, s.h,
                        if l.label.is_some() { "shown" } else { "dropped (narrow screen)" },
                        if l.key.is_some() { "shown" } else { "dropped" }
                    );
                }
                None => mlog!("control pill not shown"),
            }
            p
        });
        STATE.with(|st| {
            let mut st = st.borrow_mut();
            st.frames = wins;
            st.pill = p;
        });
    }

    pub fn hide() {
        let (frames, pill) = STATE.with(|st| {
            let mut st = st.borrow_mut();
            (std::mem::take(&mut st.frames), st.pill.take())
        });
        unsafe {
            for h in frames {
                let _ = DestroyWindow(h);
            }
            if let Some(p) = pill {
                let _ = KillTimer(Some(p.body), TIMER_TICK);
                let _ = DestroyWindow(p.body); // and its buttons
                free_fonts(&p.fonts);
            }
        }
    }

    /* -------------------------------------------------------- window messages */

    /// Which pill window `h` is, if any: (is the body, which button).
    fn role(h: HWND) -> Option<Option<Btn>> {
        STATE.with(|st| {
            let st = st.try_borrow().ok()?;
            let p = st.pill.as_ref()?;
            if h == p.body {
                Some(None)
            } else if h == p.more {
                Some(Some(Btn::More))
            } else if h == p.stop {
                Some(Some(Btn::Stop))
            } else {
                None
            }
        })
    }

    fn with_pill(f: impl FnOnce(&mut Pill)) {
        STATE.with(|st| {
            if let Ok(mut st) = st.try_borrow_mut() {
                if let Some(p) = st.pill.as_mut() {
                    f(p);
                }
            }
        });
    }

    fn set_hover(b: Option<Btn>) {
        with_pill(|p| {
            if p.hover != b {
                let was = p.hover;
                p.hover = b;
                for x in [was, b].into_iter().flatten() {
                    draw_button(p, x);
                }
            }
        });
    }

    fn click(b: Btn) {
        // Off the main thread: the lease, the server message and (Stop) the runner's end take a moment,
        // and ending the lease takes these windows away -- not from inside their own message.
        let body = STATE.with(|st| st.try_borrow().ok().and_then(|s| s.pill.as_ref().map(|p| p.body.0 as isize)));
        std::thread::spawn(move || {
            match b {
                Btn::More => {
                    let _ = super::super::machine_pill_extend();
                }
                Btn::Stop => super::super::machine_pill_stop(),
            }
            if let Some(h) = body {
                unsafe {
                    let _ = PostMessageW(Some(HWND(h as *mut core::ffi::c_void)), WM_REFRESH, WPARAM(0), LPARAM(0));
                }
            }
        });
    }

    unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            WM_NCHITTEST => {
                // The body and the frame strips are WS_EX_TRANSPARENT (clicks pass through); the buttons take them.
                match role(hwnd) {
                    Some(Some(_)) => LRESULT(HTCLIENT as isize),
                    _ => LRESULT(HTTRANSPARENT as isize),
                }
            }
            WM_SETCURSOR => {
                if let Some(Some(_)) = role(hwnd) {
                    if let Ok(c) = LoadCursorW(None, IDC_HAND) {
                        SetCursor(Some(c));
                        return LRESULT(1);
                    }
                }
                DefWindowProcW(hwnd, msg, wp, lp)
            }
            WM_MOUSEMOVE => {
                if let Some(Some(b)) = role(hwnd) {
                    let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, dwHoverTime: 0 };
                    let _ = TrackMouseEvent(&mut t);
                    set_hover(Some(b));
                }
                LRESULT(0)
            }
            MOUSE_LEFT => {
                set_hover(None);
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                if let Some(Some(b)) = role(hwnd) {
                    mlog!("control pill: {} pressed", if b == Btn::More { "+15 min" } else { "Stop" });
                    click(b);
                }
                LRESULT(0)
            }
            WM_TIMER if wp.0 == TIMER_TICK => {
                with_pill(|p| {
                    draw_body(p);
                    draw_last(p);
                });
                LRESULT(0)
            }
            WM_REFRESH => {
                with_pill(|p| {
                    draw_body(p);
                    draw_last(p);
                });
                LRESULT(0)
            }
            _ if msg == WM_DISPLAYCHANGE || msg == WM_DPICHANGED || (msg == WM_SETTINGCHANGE && wp.0 == SPI_SETWORKAREA.0 as usize) => {
                // Monitors, resolution, scale or the work area changed while in control: lay everything out again.
                if role(hwnd) == Some(None) && super::super::machine_pill_now().map(|v| v.active).unwrap_or(true) {
                    if let Some(app) = APP.get() {
                        let a = app.clone();
                        let _ = app.run_on_main_thread(move || super::show(&a));
                    }
                }
                DefWindowProcW(hwnd, msg, wp, lp)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}
