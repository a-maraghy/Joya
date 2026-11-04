//! "JOYA AI is controlling": where the take-over frame and the pill go, and how they are shaded.
//! Pure -- no Windows, no Tauri -- so it is unit-tested on the build box (core-tests); overlay.rs
//! draws it with plain Win32 windows.
//!
//! Why no WebView here (0.1.7): 0.1.6 drew the frame as one transparent WebView2 window covering each
//! whole monitor and the pill as another WebView2 window. A WebView2 surface that is not (yet) drawn
//! transparent shows white, and one of them showed as a white block over the user's screen during a
//! take-over (2026-10-08). Now nothing of ours covers the middle of any screen: the frame is four thin
//! strips along each monitor's edges (click-through), and the pill is a small window exactly the size
//! of its own shape (click-through, with its two buttons as their own small windows). Every pixel is
//! drawn by the app before the window is shown, so nothing can flash white. (Which of the two 0.1.6
//! windows showed white could not be seen from here -- they are excluded from screenshots -- so both
//! were replaced.)

/// A rectangle in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && px < self.right() && py < self.bottom()
    }
    pub fn inside(&self, outer: &Rect) -> bool {
        self.x >= outer.x && self.y >= outer.y && self.right() <= outer.right() && self.bottom() <= outer.bottom()
    }
}

/* ------------------------------------------------------------------ the frame */

/// The frame's depth in logical px: a solid edge, then the glow fading inwards.
pub const FRAME_EDGE: f64 = 3.0;
pub const FRAME_DEPTH: f64 = 14.0;
/// Joya (#00C98F).
pub const JOYA: (u8, u8, u8) = (0x00, 0xC9, 0x8F);

/// The frame strips' thickness in physical px for a monitor at `scale`.
pub fn frame_thickness(scale: f64) -> i32 {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    ((FRAME_DEPTH * s).round() as i32).max(4)
}

/// The four strips (top, bottom, left, right) along a monitor's edges, in physical px. They never
/// overlap and together they cover only the band of `frame_thickness` round the edge: nothing of the
/// frame is over the middle of the screen. A monitor too small for a frame gets none.
pub fn frame_strips(mon: Rect, scale: f64) -> Vec<Rect> {
    let t = frame_thickness(scale);
    if mon.w < 4 * t || mon.h < 4 * t {
        return Vec::new();
    }
    vec![
        Rect::new(mon.x, mon.y, mon.w, t),
        Rect::new(mon.x, mon.bottom() - t, mon.w, t),
        Rect::new(mon.x, mon.y + t, t, mon.h - 2 * t),
        Rect::new(mon.right() - t, mon.y + t, t, mon.h - 2 * t),
    ]
}

/// The frame's opacity (0..=255) at a pixel `d` physical px in from the nearest monitor edge: solid
/// for the edge, then a soft glow fading to nothing at the strip's inner side.
pub fn frame_alpha(d: i32, scale: f64) -> u8 {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let t = frame_thickness(s) as f64;
    let edge = (FRAME_EDGE * s).max(1.0);
    let d = d.max(0) as f64 + 0.5;
    if d <= edge {
        return 242;
    }
    if d >= t {
        return 0;
    }
    let k = 1.0 - (d - edge) / (t - edge); // 1 at the edge, 0 inside
    (150.0 * k * k).round().clamp(0.0, 255.0) as u8
}

/// Distance of a pixel (monitor-relative) to the monitor's nearest edge.
pub fn edge_distance(px: i32, py: i32, mon_w: i32, mon_h: i32) -> i32 {
    px.min(py).min(mon_w - 1 - px).min(mon_h - 1 - py).max(0)
}

/* ------------------------------------------------------------------- the pill */

/// The pill's measures in logical px (the 0.1.6 pill's look, now drawn natively).
pub const PILL_H: f64 = 40.0;
pub const PILL_TOP: f64 = 10.0;
pub const PAD_L: f64 = 14.0;
pub const PAD_R: f64 = 8.0;
pub const GAP: f64 = 9.0;
pub const DOT: f64 = 9.0;
pub const BTN_H: f64 = 26.0;
pub const BTN_PAD: f64 = 11.0;
pub const BORDER: f64 = 1.5;

/// The pill's texts, measured by the caller in physical px at the pill's font size.
#[derive(Clone, Copy, Debug, Default)]
pub struct TextWidths {
    pub label: i32,
    pub sep: i32,
    pub time: i32,
    pub more: i32,
    pub stop: i32,
    pub key: i32,
}

/// Where everything goes. `window` in screen px; the parts relative to the window's top left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PillLayout {
    pub window: Rect,
    pub dot: Rect,
    pub label: Option<Rect>,
    pub sep: Option<Rect>,
    pub time: Rect,
    pub more: Rect,
    pub stop: Rect,
    pub key: Option<Rect>,
    pub radius: i32,
    pub border: i32,
}

fn px(v: f64, s: f64) -> i32 {
    (v * s).round() as i32
}

/// Lay the pill out at the top centre of `work` (the primary monitor's work area, physical px) at
/// `scale`. When it does not fit the work area's width, the stop-key hint goes first, then the label;
/// the time and the two buttons always stay. The pill is never wider than the work area and always
/// sits inside it.
pub fn pill_layout(work: Rect, scale: f64, t: TextWidths) -> PillLayout {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let h = px(PILL_H, s);
    let gap = px(GAP, s);
    let dot = px(DOT, s);
    let btn_h = px(BTN_H, s);
    let btn_pad = px(BTN_PAD, s);
    let more_w = t.more + 2 * btn_pad;
    let stop_w = t.stop + 2 * btn_pad;
    let margin = px(8.0, s);
    let max_w = (work.w - 2 * margin).max(1);
    let width = |label: bool, key: bool| -> i32 {
        let mut w = px(PAD_L, s) + dot + gap;
        if label {
            w += t.label + gap + t.sep + gap;
        }
        w += t.time + gap + more_w + gap + stop_w;
        if key {
            w += gap + t.key;
        }
        w + px(PAD_R, s) + if key { px(4.0, s) } else { 0 }
    };
    let (label, key) = if width(true, true) <= max_w {
        (true, true)
    } else if width(true, false) <= max_w {
        (true, false)
    } else {
        (false, false)
    };
    let w = width(label, key).min(max_w);
    let window = Rect::new(work.x + (work.w - w) / 2, work.y + px(PILL_TOP, s), w, h);
    let cy = |hh: i32| (h - hh) / 2;
    let mut x = px(PAD_L, s);
    let dot_r = Rect::new(x, cy(dot), dot, dot);
    x += dot + gap;
    let (mut label_r, mut sep_r) = (None, None);
    if label {
        label_r = Some(Rect::new(x, 0, t.label, h));
        x += t.label + gap;
        sep_r = Some(Rect::new(x, 0, t.sep, h));
        x += t.sep + gap;
    }
    let time_r = Rect::new(x, 0, t.time, h);
    x += t.time + gap;
    let more_r = Rect::new(x, cy(btn_h), more_w, btn_h);
    x += more_w + gap;
    let stop_r = Rect::new(x, cy(btn_h), stop_w, btn_h);
    x += stop_w;
    let key_r = if key { Some(Rect::new(x + gap, 0, t.key, h)) } else { None };
    PillLayout { window, dot: dot_r, label: label_r, sep: sep_r, time: time_r, more: more_r, stop: stop_r, key: key_r, radius: h / 2, border: px(BORDER, s).max(1) }
}

/// A button's own window, in screen px.
pub fn on_screen(win: Rect, part: Rect) -> Rect {
    Rect::new(win.x + part.x, win.y + part.y, part.w, part.h)
}

/* ------------------------------------------------------- rounded shapes, shaded */

/// Signed distance from the centre of pixel (x, y) to a w x h rounded rectangle with radius r
/// (negative inside, positive outside), all in px.
pub fn rounded_distance(x: i32, y: i32, w: i32, h: i32, r: i32) -> f64 {
    let r = r.clamp(0, w.min(h) / 2) as f64;
    let (hw, hh) = (w as f64 / 2.0, h as f64 / 2.0);
    let qx = ((x as f64 + 0.5) - hw).abs() - (hw - r);
    let qy = ((y as f64 + 0.5) - hh).abs() - (hh - r);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - r
}

/// How much of the pixel the shape covers (0..1), with a one-pixel anti-aliased edge.
pub fn coverage(dist: f64) -> f64 {
    (0.5 - dist).clamp(0.0, 1.0)
}

/// The shape's own colour at a pixel: the fill, the border band (`border` px wide) blended over it
/// at the edge. Returns (r, g, b, a) premultiplied by `a`, as UpdateLayeredWindow takes it.
/// `fill_a` is the fill's opacity (0..=255); the border is solid.
pub fn shade(dist: f64, border: i32, fill: (u8, u8, u8), fill_a: u8, edge: (u8, u8, u8)) -> (u8, u8, u8, u8) {
    let cov = coverage(dist);
    if cov <= 0.0 {
        return (0, 0, 0, 0);
    }
    // 1 inside the border band, 0 in the fill, soft between.
    let b = (dist + border as f64 + 0.5).clamp(0.0, 1.0);
    let mix = |f: u8, e: u8| f as f64 * (1.0 - b) + e as f64 * b;
    let a = (fill_a as f64 * (1.0 - b) + 255.0 * b) * cov;
    let pm = |c: f64| (c * a / 255.0).round().clamp(0.0, 255.0) as u8;
    (pm(mix(fill.0, edge.0)), pm(mix(fill.1, edge.1)), pm(mix(fill.2, edge.2)), a.round().clamp(0.0, 255.0) as u8)
}

/// "mm:ss left", or "ended" once the lease is over.
pub fn time_text(active: bool, left: &str) -> String {
    if active {
        format!("{} left", left)
    } else {
        "ended".to_string()
    }
}

/* ------------------------------------------------------------ the last action, under the pill */

/// The "last action" line's height in logical px, and its gap under the pill.
pub const LAST_H: f64 = 24.0;
pub const LAST_GAP: f64 = 4.0;

/// The line under the pill: as wide as the pill (never past the work area), just below it.
pub fn last_line_rect(pill: Rect, work: Rect, scale: f64) -> Rect {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let h = px(LAST_H, s);
    let y = (pill.bottom() + px(LAST_GAP, s)).min(work.bottom() - h).max(work.y);
    Rect::new(pill.x, y, pill.w.min(work.w), h)
}

/// The line's text: what was done, shortly. "Chrome: open https://…", "Edited Report.docx", "✓" / "✗".
pub fn last_action_text(tool: &str, target: &str, decision: &str, ok: bool) -> String {
    let short = tool.rsplit("__").next().unwrap_or(tool);
    let what = match short {
        "office_edit" => format!("Edited {}", file_name(target.split(" -> ").next().unwrap_or(target))),
        "office_read" | "pdf_read" => format!("Read {}", file_name(target)),
        "create_document" => format!("Created {}", file_name(target)),
        "pdf_merge" => "Merged PDFs".to_string(),
        "pdf_export" => format!("Made a PDF of {}", file_name(target.split(" -> ").next().unwrap_or(target))),
        "request_approval" => format!("Asked: {target}"),
        "wait" => "Waited".to_string(),
        _ => target.to_string(),
    };
    let mark = match decision {
        "denied" => " — not approved",
        "refused" => " — refused",
        _ if !ok => " — failed",
        "approved" => " — approved",
        _ => "",
    };
    let mut s: String = what.chars().filter(|c| !c.is_control()).collect();
    if s.trim().is_empty() {
        s = short.replace('_', " ");
    }
    clip_chars(&format!("Last: {}{}", s.trim(), mark), 90)
}

fn file_name(p: &str) -> &str {
    p.rsplit(['\\', '/']).next().unwrap_or(p)
}

/// At most `n` characters, with "…" when cut.
pub fn clip_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut o: String = s.chars().take(n.saturating_sub(1)).collect();
    o.push('…');
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_action_line() {
        let pill = Rect::new(500, 10, 600, 40);
        let work = Rect::new(0, 0, 1920, 1040);
        let r = last_line_rect(pill, work, 1.0);
        assert_eq!(r, Rect::new(500, 54, 600, 24));
        assert!(r.inside(&work));
        assert_eq!(last_line_rect(pill, work, 1.5).h, 36);
        assert_eq!(last_action_text("mcp__joya-hands__office_edit", "C:\\Users\\a\\Documents\\Report.docx -> C:\\Users\\a\\Documents\\Report (edited).docx", "auto", true), "Last: Edited Report.docx");
        assert_eq!(last_action_text("mcp__claude-in-chrome__navigate", "Chrome: open https://example.com", "auto", true), "Last: Chrome: open https://example.com");
        assert_eq!(last_action_text("mcp__claude-in-chrome__computer", "Chrome: left click button \"Send\"", "denied", false), "Last: Chrome: left click button \"Send\" — not approved");
        assert_eq!(last_action_text("PowerShell", "PowerShell: dir", "auto", false), "Last: PowerShell: dir — failed");
        let long = last_action_text("Bash", &"x".repeat(300), "auto", true);
        assert_eq!(long.chars().count(), 90);
        assert!(long.ends_with('…'));
    }

    fn widths() -> TextWidths {
        TextWidths { label: 150, sep: 5, time: 64, more: 52, stop: 30, key: 120 }
    }

    #[test]
    fn the_frame_is_four_thin_strips_round_the_edge() {
        for (mon, scale) in [(Rect::new(0, 0, 1920, 1080), 1.0), (Rect::new(0, 0, 2084, 1302), 1.5), (Rect::new(-1920, -300, 1920, 1200), 1.0), (Rect::new(2084, 0, 3840, 2160), 1.5)] {
            let t = frame_thickness(scale);
            let st = frame_strips(mon, scale);
            assert_eq!(st.len(), 4);
            let area: i64 = st.iter().map(|r| r.w as i64 * r.h as i64).sum();
            // Exactly the band round the edge: no overlap, nothing over the middle.
            assert_eq!(area, mon.w as i64 * mon.h as i64 - (mon.w - 2 * t) as i64 * (mon.h - 2 * t) as i64);
            for r in &st {
                assert!(r.inside(&mon), "{r:?} outside {mon:?}");
                assert!(r.w <= t || r.h <= t, "a strip is thin: {r:?}");
            }
            let mid = (mon.x + mon.w / 2, mon.y + mon.h / 2);
            assert!(!st.iter().any(|r| r.contains(mid.0, mid.1)), "the middle of the screen is free");
            // The top right corner (where the white block was) is only the band.
            let tr = (mon.right() - 2 * t, mon.y + 2 * t);
            assert!(!st.iter().any(|r| r.contains(tr.0, tr.1)));
        }
        assert!(frame_strips(Rect::new(0, 0, 20, 20), 1.0).is_empty(), "no frame on a sliver");
        assert_eq!(frame_thickness(1.5), 21);
        assert_eq!(frame_thickness(f64::NAN), 14);
    }

    #[test]
    fn the_frame_glows_inwards_and_ends_transparent() {
        for s in [1.0, 1.25, 1.5, 2.0] {
            let t = frame_thickness(s);
            assert!(frame_alpha(0, s) > 200, "solid at the edge");
            assert_eq!(frame_alpha(t - 1, s), 0, "nothing at the inner side of the strip ({s})");
            let mut last = 255;
            for d in 0..t {
                let a = frame_alpha(d, s);
                assert!(a <= last, "fades monotonically");
                last = a;
            }
        }
        assert_eq!(edge_distance(0, 500, 1920, 1080), 0);
        assert_eq!(edge_distance(1919, 500, 1920, 1080), 0);
        assert_eq!(edge_distance(10, 3, 1920, 1080), 3);
    }

    #[test]
    fn the_pill_is_small_and_at_the_top_centre() {
        // The user's laptop: 150 % (1389 x 868 logical work area -> about 2084 x 1302 physical).
        let work = Rect::new(0, 0, 2084, 1230);
        let l = pill_layout(work, 1.5, TextWidths { label: 225, sep: 8, time: 96, more: 78, stop: 45, key: 180 });
        assert_eq!(l.window.h, 60);
        assert_eq!(l.window.y, 15);
        assert!(l.window.inside(&work));
        assert!((l.window.x + l.window.w / 2 - work.w / 2).abs() <= 1, "centred: {:?}", l.window);
        assert!(l.window.w < work.w / 2, "small: {:?}", l.window);
        assert!(l.label.is_some() && l.key.is_some());
        // The buttons sit inside the pill, apart, and inside its height.
        let pill = Rect::new(0, 0, l.window.w, l.window.h);
        for b in [l.more, l.stop] {
            assert!(b.inside(&pill), "{b:?}");
        }
        assert!(l.more.right() <= l.stop.x);
        assert!(l.time.right() <= l.more.x);
        assert_eq!(l.radius, 30);
        // The buttons' own windows on screen.
        let sb = on_screen(l.window, l.stop);
        assert_eq!((sb.x, sb.y), (l.window.x + l.stop.x, l.window.y + l.stop.y));
    }

    #[test]
    fn a_narrow_screen_drops_the_hint_then_the_label_never_the_buttons() {
        let t = widths();
        let full = pill_layout(Rect::new(0, 0, 1920, 1040), 1.0, t).window.w;
        let no_key = pill_layout(Rect::new(0, 0, full - 10, 1040), 1.0, t);
        assert!(no_key.key.is_none() && no_key.label.is_some());
        let tiny = pill_layout(Rect::new(100, 50, 330, 600), 1.0, t);
        assert!(tiny.key.is_none() && tiny.label.is_none());
        assert!(tiny.window.inside(&Rect::new(100, 50, 330, 600)));
        assert!(tiny.stop.w > 0 && tiny.more.w > 0);
    }

    #[test]
    fn rounded_shapes_are_shaded_and_clear_outside() {
        // Inside, on the edge, outside.
        assert!(rounded_distance(50, 20, 100, 40, 20) < -10.0);
        assert!(rounded_distance(0, 0, 100, 40, 20) > 0.0, "the corner is cut");
        assert!(rounded_distance(50, 0, 100, 40, 20).abs() < 1.0);
        assert_eq!(coverage(5.0), 0.0);
        assert_eq!(coverage(-5.0), 1.0);
        let fill = (16, 18, 40);
        let edge = JOYA;
        assert_eq!(shade(3.0, 2, fill, 240, edge), (0, 0, 0, 0), "outside: fully transparent");
        let inside = shade(-10.0, 2, fill, 240, edge);
        assert_eq!(inside.3, 240);
        assert!(inside.0 <= 16 && inside.1 <= 18 && inside.2 <= 40, "the fill, premultiplied: {inside:?}");
        let rim = shade(-1.0, 2, fill, 240, edge);
        assert_eq!(rim.3, 255, "the border is solid");
        assert!(rim.1 > 150, "the border is joya: {rim:?}");
        // Premultiplied: no channel above alpha.
        for d in [-3.0, -1.5, -0.5, 0.0, 0.4] {
            let (r, g, b, a) = shade(d, 2, fill, 240, edge);
            assert!(r <= a && g <= a && b <= a, "{d}: {r} {g} {b} {a}");
        }
    }

    #[test]
    fn the_time() {
        assert_eq!(time_text(true, "14:59"), "14:59 left");
        assert_eq!(time_text(false, "00:00"), "ended");
    }
}
