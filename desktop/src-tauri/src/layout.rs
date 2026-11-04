//! Window geometry for the three modes. Pure: monitors and sizes in, rectangles out.
//!
//! The page lays itself out inside the window (dashboard/public/joya-desktop-layout.js);
//! this decides the window itself. The Floating numbers are the same as the page's
//! (dashboard/tools/test-desktop-shell.cjs checks both files): a 480 x 580 box at
//! size M with HEADROOM px above it for a decision card, so a card grows above the
//! box and never covers its own core.

use serde::{Deserialize, Serialize};

pub const BOX_W: f64 = 480.0;
pub const BOX_H: f64 = 580.0;
pub const FOCUS: f64 = 168.0;
pub const HEADROOM: f64 = 280.0;
/// Distance from the work area's edges for the Floating corners, in logical px.
pub const MARGIN: f64 = 16.0;
/// The glance cards' column beside the Floating box (approvals, sessions, today's tokens, alerts), and
/// its gap to the box, in logical px; not scaled with S/M/L. The page has the same numbers
/// (joya-desktop-layout.js GL_W / GL_GAP). The box sits at the screen-edge end of the wider window.
pub const GLANCE_W: f64 = 256.0;
pub const GLANCE_GAP: f64 = 12.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Floating,
    Peek,
    Desktop,
    /// The bot out of its box, on the taskbar or the window in front (companion.rs places its small window).
    Companion,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Floating => "floating",
            Mode::Peek => "peek",
            Mode::Desktop => "desktop",
            Mode::Companion => "companion",
        }
    }
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "floating" => Some(Mode::Floating),
            "peek" => Some(Mode::Peek),
            "desktop" => Some(Mode::Desktop),
            "companion" => Some(Mode::Companion),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Size {
    S,
    M,
    L,
}

impl Size {
    pub fn factor(&self) -> f64 {
        match self {
            Size::S => 0.8,
            Size::M => 1.0,
            Size::L => 1.22,
        }
    }
    pub fn next(&self) -> Size {
        match self {
            Size::S => Size::M,
            Size::M => Size::L,
            Size::L => Size::S,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Size::S => "S",
            Size::M => "M",
            Size::L => "L",
        }
    }
}

/// A Floating corner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Corner {
    Tl,
    Tr,
    Bl,
    Br,
}

/// A rectangle in physical pixels (the monitor's), as Windows places windows.
#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w as i32 && y < self.y + self.h as i32
    }
    pub fn centre(&self) -> (i32, i32) {
        (self.x + self.w as i32 / 2, self.y + self.h as i32 / 2)
    }
}

/// The Floating box's logical size (without the headroom or the glance column).
pub fn box_logical(size: Size, focus: bool) -> (f64, f64) {
    let k = size.factor();
    (((if focus { FOCUS } else { BOX_W }) * k).round(), ((if focus { FOCUS } else { BOX_H }) * k).round())
}

/// The Floating window's logical size: the box, plus the headroom above it (none in focus mode), plus
/// the glance column beside it when the cards are shown (never in focus mode).
pub fn floating_logical(size: Size, focus: bool, glance: bool) -> (f64, f64) {
    let (bw, bh) = box_logical(size, focus);
    let gl = if glance && !focus { GLANCE_W + GLANCE_GAP } else { 0.0 };
    (bw + gl, bh + if focus { 0.0 } else { HEADROOM })
}

/// Where the window goes: Floating in a corner of the work area; Peek and Desktop layer cover it. Companion:
/// its small window is placed by companion.rs; this is the Peek it opens (a click on the bot).
pub fn window_rect(mode: Mode, work: Rect, scale: f64, size: Size, focus: bool, corner: Corner, glance: bool) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    match mode {
        Mode::Peek | Mode::Desktop | Mode::Companion => work,
        Mode::Floating => {
            let (lw, lh) = floating_logical(size, focus, glance);
            let w = ((lw * scale).round() as u32).min(work.w);
            let h = ((lh * scale).round() as u32).min(work.h);
            let m = (MARGIN * scale).round() as i32;
            let right = matches!(corner, Corner::Tr | Corner::Br);
            let bottom = matches!(corner, Corner::Bl | Corner::Br);
            let x = if right { work.x + work.w as i32 - m - w as i32 } else { work.x + m };
            // A bottom corner: the box at the bottom of the window, the headroom (for a card) above it.
            // A top corner: the box at the top, the headroom below it (the page mirrors this; see box_on_top).
            let y = if bottom { work.y + work.h as i32 - m - h as i32 } else { work.y + m };
            Rect { x: x.max(work.x), y: y.max(work.y), w, h }
        }
    }
}

/// In a top corner the box is at the top of the window (the card goes below it).
pub fn box_on_top(corner: Corner) -> bool {
    matches!(corner, Corner::Tl | Corner::Tr)
}

/// In a right corner the box is at the window's right end (the glance column, if any, to its left).
pub fn box_on_right(corner: Corner) -> bool {
    matches!(corner, Corner::Tr | Corner::Br)
}

/// The corner nearest to where the box was dropped. `was`: the corner it was in (which end of the window
/// the box is at, top or bottom, and -- with the glance column -- left or right).
pub fn nearest_corner(win: Rect, work: Rect, scale: f64, size: Size, focus: bool, was: Corner) -> Corner {
    let (bw, bh) = box_logical(size, focus);
    let s = scale.max(0.1);
    let bh = (bh * s).round() as i32;
    let bw = ((bw * s).round() as i32).min(win.w as i32);
    let cx = if box_on_right(was) { win.x + win.w as i32 - bw / 2 } else { win.x + bw / 2 };
    let cy = if box_on_top(was) { win.y + bh / 2 } else { win.y + win.h as i32 - bh / 2 };
    let (mx, my) = work.centre();
    match (cy < my, cx < mx) {
        (true, true) => Corner::Tl,
        (true, false) => Corner::Tr,
        (false, true) => Corner::Bl,
        (false, false) => Corner::Br,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const WORK: Rect = Rect { x: 0, y: 0, w: 1920, h: 1032 };

    #[test]
    fn floating_sizes_match_the_page() {
        assert_eq!(floating_logical(Size::M, false, false), (480.0, 860.0));
        assert_eq!(floating_logical(Size::S, false, false), (384.0, 744.0));
        assert_eq!(floating_logical(Size::L, false, false), (586.0, 988.0));
        assert_eq!(floating_logical(Size::M, true, false), (168.0, 168.0));
    }

    #[test]
    fn the_glance_column_widens_the_floating_window() {
        assert_eq!(floating_logical(Size::M, false, true), (748.0, 860.0));
        assert_eq!(floating_logical(Size::S, false, true), (652.0, 744.0));
        assert_eq!(floating_logical(Size::M, true, true), (168.0, 168.0), "never in focus mode");
        // Still anchored in its corner: a right corner grows to the left, a left one to the right.
        let r = window_rect(Mode::Floating, WORK, 1.0, Size::M, false, Corner::Br, true);
        assert_eq!(r, Rect { x: 1920 - 16 - 748, y: 1032 - 16 - 860, w: 748, h: 860 });
        let l = window_rect(Mode::Floating, WORK, 1.0, Size::M, false, Corner::Bl, true);
        assert_eq!((l.x, l.w), (16, 748));
        // 150 %: the column scales with the monitor like everything else (logical px).
        let s = window_rect(Mode::Floating, Rect { x: 1920, y: 0, w: 2560, h: 1380 }, 1.5, Size::M, false, Corner::Br, true);
        assert_eq!((s.w, s.h), (1122, 1290));
    }

    #[test]
    fn dropping_a_wide_window_snaps_by_the_box_not_the_window() {
        // The box at the right end of a 748-wide window whose middle is left of the screen's middle,
        // but whose box is right of it: a right corner.
        let win = Rect { x: 760, y: 100, w: 748, h: 860 };
        assert_eq!(nearest_corner(win, WORK, 1.0, Size::M, false, Corner::Br), Corner::Br);
        // The same window with the box at its left end (it was in a left corner): left.
        let win = Rect { x: 500, y: 100, w: 748, h: 860 };
        assert_eq!(nearest_corner(win, WORK, 1.0, Size::M, false, Corner::Bl), Corner::Bl);
        assert!(box_on_right(Corner::Tr) && !box_on_right(Corner::Bl));
    }

    #[test]
    fn floating_bottom_right_by_default() {
        let r = window_rect(Mode::Floating, WORK, 1.0, Size::M, false, Corner::Br, false);
        assert_eq!(r, Rect { x: 1920 - 16 - 480, y: 1032 - 16 - 860, w: 480, h: 860 });
    }

    #[test]
    fn per_monitor_dpi_scales_the_window() {
        let work = Rect { x: 1920, y: 0, w: 2560, h: 1380 };
        let r = window_rect(Mode::Floating, work, 1.5, Size::M, false, Corner::Br, false);
        assert_eq!((r.w, r.h), (720, 1290));
        assert_eq!(r.x, 1920 + 2560 - 24 - 720);
        assert_eq!(r.y, 1380 - 24 - 1290);
    }

    #[test]
    fn never_bigger_than_the_work_area() {
        let small = Rect { x: 0, y: 0, w: 1280, h: 680 };
        let r = window_rect(Mode::Floating, small, 1.0, Size::L, false, Corner::Br, false);
        assert!(r.h <= 680 && r.y >= 0);
    }

    #[test]
    fn top_corners_start_at_the_top() {
        let r = window_rect(Mode::Floating, WORK, 1.0, Size::M, false, Corner::Tl, false);
        assert_eq!((r.x, r.y), (16, 16));
        assert!(box_on_top(Corner::Tr) && !box_on_top(Corner::Bl));
    }

    #[test]
    fn peek_and_desktop_cover_the_work_area() {
        assert_eq!(window_rect(Mode::Peek, WORK, 1.25, Size::M, false, Corner::Br, true), WORK);
        assert_eq!(window_rect(Mode::Desktop, WORK, 1.0, Size::L, true, Corner::Tl, true), WORK);
    }

    #[test]
    fn dropping_snaps_to_the_nearest_corner() {
        let r = |x, y| Rect { x, y, w: 480, h: 860 };
        assert_eq!(nearest_corner(r(10, -300), WORK, 1.0, Size::M, false, Corner::Br), Corner::Tl);
        assert_eq!(nearest_corner(r(1400, 100), WORK, 1.0, Size::M, false, Corner::Br), Corner::Br); // the box (bottom part) is below the middle
        assert_eq!(nearest_corner(r(1400, 100), WORK, 1.0, Size::M, false, Corner::Tr), Corner::Tr); // the box (top part) is above it
        assert_eq!(nearest_corner(r(100, 150), WORK, 1.0, Size::M, false, Corner::Bl), Corner::Bl);
    }

    #[test]
    fn mode_names_round_trip() {
        for m in [Mode::Floating, Mode::Peek, Mode::Desktop, Mode::Companion] {
            assert_eq!(Mode::parse(m.as_str()), Some(m));
        }
        assert_eq!(Mode::parse("x"), None);
        assert_eq!(Size::M.next(), Size::L);
        assert_eq!(Size::L.next(), Size::S);
    }
}
