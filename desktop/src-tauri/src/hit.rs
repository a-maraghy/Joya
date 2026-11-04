//! Per-pixel click-through.
//!
//! Windows can only make a whole window ignore the mouse (WS_EX_TRANSPARENT,
//! Tauri's set_ignore_cursor_events). The page reports which parts of it are
//! interactive -- the core, the spheres, labels, bubbles, composer, cards -- as
//! rounded rectangles in CSS pixels (dashboard/public/joya-desktop.js); a loop
//! about 30 times a second checks the cursor against them and switches the
//! window between "catches the mouse" and "lets it through". Pure here.

use serde::{Deserialize, Serialize};

/// One interactive region, CSS pixels from the window's top left; `r` is the corner radius
/// (a circle is w == h == 2r).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub r: f64,
}

/// The most regions the page may report; anything past it is ignored (a page cannot make the loop slow).
pub const MAX_REGIONS: usize = 256;
/// A margin round every region, in CSS px, so a pointer on an edge does not flicker between the two states.
pub const SLOP: f64 = 2.0;

impl Region {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.w, self.h, self.r].iter().all(|v| v.is_finite()) && self.w > 0.0 && self.h > 0.0 && self.w < 1.0e5 && self.h < 1.0e5
    }

    /// Is the point (CSS px) inside the rounded rectangle, grown by `slop`?
    pub fn contains(&self, px: f64, py: f64, slop: f64) -> bool {
        let (x0, y0, x1, y1) = (self.x - slop, self.y - slop, self.x + self.w + slop, self.y + self.h + slop);
        if px < x0 || py < y0 || px >= x1 || py >= y1 {
            return false;
        }
        let r = self.r.max(0.0).min(self.w / 2.0).min(self.h / 2.0);
        if r <= 0.0 {
            return true;
        }
        // In a corner square: inside the quarter circle only.
        let r = r + slop;
        let cx = if px < x0 + r { x0 + r } else if px > x1 - r { x1 - r } else { return true };
        let cy = if py < y0 + r { y0 + r } else if py > y1 - r { y1 - r } else { return true };
        let (dx, dy) = (px - cx, py - cy);
        dx * dx + dy * dy <= r * r
    }
}

/// Keep what is usable: valid regions only, at most MAX_REGIONS.
pub fn clean(list: Vec<Region>) -> Vec<Region> {
    list.into_iter().filter(|r| r.valid()).take(MAX_REGIONS).collect()
}

/// Does the cursor, in physical pixels relative to the window's top left, fall on an interactive region?
/// `dpr`: the page's devicePixelRatio (physical px per CSS px).
pub fn hit(regions: &[Region], cursor_x: f64, cursor_y: f64, dpr: f64) -> bool {
    let dpr = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let (x, y) = (cursor_x / dpr, cursor_y / dpr);
    regions.iter().any(|r| r.contains(x, y, SLOP))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rr(x: f64, y: f64, w: f64, h: f64, r: f64) -> Region {
        Region { x, y, w, h, r }
    }

    #[test]
    fn plain_rectangle() {
        let a = [rr(10.0, 10.0, 100.0, 40.0, 0.0)];
        assert!(hit(&a, 10.0, 10.0, 1.0));
        assert!(hit(&a, 109.0, 49.0, 1.0));
        assert!(!hit(&a, 200.0, 20.0, 1.0));
        // Within the slop, just outside the edge.
        assert!(hit(&a, 8.5, 20.0, 1.0));
        assert!(!hit(&a, 7.0, 20.0, 1.0));
    }

    #[test]
    fn circle_core() {
        // The core: a circle of radius 78 at (240, 489).
        let c = [rr(162.0, 411.0, 156.0, 156.0, 78.0)];
        assert!(hit(&c, 240.0, 489.0, 1.0));
        // The corner of its bounding box is outside the circle: clicks there go through.
        assert!(!hit(&c, 164.0, 413.0, 1.0));
        // On the circle's edge, within the slop.
        assert!(hit(&c, 240.0 + 79.0, 489.0, 1.0));
        assert!(!hit(&c, 240.0 + 82.0, 489.0, 1.0));
    }

    #[test]
    fn rounded_pill_corners() {
        let p = [rr(0.0, 0.0, 200.0, 48.0, 24.0)];
        assert!(hit(&p, 100.0, 2.0, 1.0)); // the straight top edge
        assert!(!hit(&p, 1.0, 1.0, 1.0)); // the cut-off corner
        assert!(hit(&p, 24.0, 24.0, 1.0));
    }

    #[test]
    fn device_pixel_ratio() {
        // At 150 % the page's CSS px are 1.5 physical px.
        let a = [rr(100.0, 100.0, 50.0, 50.0, 0.0)];
        assert!(hit(&a, 160.0, 160.0, 1.5)); // 106.7 CSS px
        assert!(!hit(&a, 140.0, 140.0, 1.5)); // 93.3 CSS px
        assert!(hit(&a, 120.0, 120.0, f64::NAN)); // a bad ratio counts as 1
    }

    #[test]
    fn nothing_reported_lets_everything_through() {
        assert!(!hit(&[], 10.0, 10.0, 1.0));
    }

    #[test]
    fn junk_is_dropped_and_the_list_capped() {
        let mut v = vec![rr(f64::NAN, 0.0, 1.0, 1.0, 0.0), rr(0.0, 0.0, -5.0, 1.0, 0.0), rr(0.0, 0.0, 1.0e9, 1.0, 0.0)];
        for i in 0..400 {
            v.push(rr(i as f64, 0.0, 1.0, 1.0, 0.0));
        }
        let c = clean(v);
        assert_eq!(c.len(), MAX_REGIONS);
        assert!(c.iter().all(|r| r.valid()));
    }
}
