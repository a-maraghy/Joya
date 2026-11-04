//! Real blur (acrylic) behind the cards: the bookkeeping. Pure -- no Windows, no Tauri.
//!
//! The main window is one transparent WebView2 window, and CSS `backdrop-filter` inside it only sees the
//! page itself, never the desktop behind the window. So the app puts a small native acrylic window
//! (acrylic.rs) under each card, pill and panel the page reports, directly below the main window in the
//! z-order, the same size and corner radius as the CSS shape. This module decides *whether* there is blur
//! and *where* each of those windows goes; acrylic.rs only carries it out.
//!
//! The page reports its glass surfaces (dashboard/public/joya-desktop.js, `set_blur_rects`) in CSS pixels
//! from the window's top left, only once they hold still and only when the list changes -- never per frame.

use crate::hit::Region;

/// The most acrylic windows at once; surfaces past it simply keep their tinted look.
pub const MAX_BLUR: usize = 24;
/// Each blur window sits this many CSS px inside its surface, so the window region's hard (not
/// anti-aliased) edge stays under the surface's own border and never peeks out round a corner.
pub const INSET: f64 = 1.0;
/// Smaller than this (CSS px, after the inset) is not worth a window.
pub const MIN_SIDE: f64 = 6.0;
/// Below this opacity (Settings ▸ Opacity, %) JOYA AI is meant to be faint: no blur, the tinted look.
pub const MIN_OPACITY: u8 = 70;
/// Windows 10 1809: SetWindowCompositionAttribute's acrylic accent works from here (17134 had bugs).
pub const MIN_BUILD: u32 = 17763;
/// Windows' energy saver: keep the blur (DWM draws it once, it costs nothing per frame). Flip this
/// if the laptop test finds Windows paints acrylic solid under energy saver.
pub const OFF_IN_ENERGY_SAVER: bool = false;

/// What the system allows (read by acrylic.rs from Windows, every few seconds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct System {
    /// The Windows build number (0: unknown, e.g. not Windows).
    pub build: u32,
    /// Settings ▸ Personalization ▸ Colours ▸ Transparency effects.
    pub transparency: bool,
    /// High contrast: no blur, no tints of ours (Windows' colours win).
    pub high_contrast: bool,
    /// Windows' battery / energy saver.
    pub energy_saver: bool,
}

/// Why there is no blur (shown in Settings) -- or None when there is.
pub fn unavailable(sys: &System) -> Option<&'static str> {
    if sys.build == 0 {
        Some("Real blur needs Windows 10 (version 1809) or Windows 11.")
    } else if sys.build < MIN_BUILD {
        Some("Real blur needs Windows 10 version 1809 or later: the tinted look is used.")
    } else if sys.high_contrast {
        Some("High contrast is on: the tinted look is used.")
    } else if !sys.transparency {
        Some("Windows' transparency effects are off (Settings ▸ Personalization ▸ Colours): the tinted look is used.")
    } else if OFF_IN_ENERGY_SAVER && sys.energy_saver {
        Some("Energy saver is on: the tinted look is used until it ends.")
    } else {
        None
    }
}

/// Is the page to draw its glass look (lighter tints over real blur)? The setting, what Windows allows,
/// the opacity, and not behind the icons (nothing of ours is above the wallpaper there).
pub fn page_glass(setting_on: bool, sys: &System, opacity: u8, behind_icons: bool) -> bool {
    setting_on && unavailable(sys).is_none() && opacity >= MIN_OPACITY && !behind_icons
}

/// Are the acrylic windows to be shown right now? `glass` is page_glass; the rest is the moment:
/// the main window must be visible and not minimised, not being dragged (acrylic windows that move
/// lag behind on Windows 10 1903+ and Windows 11, so they hide while the box moves and come back when
/// it snaps), and the page's rectangles must be in this monitor's scale (after a move to another
/// monitor the page measures again; until then nothing is shown rather than the wrong size).
pub fn showing(glass: bool, main_visible: bool, dragging: bool, dpr_ok: bool) -> bool {
    glass && main_visible && !dragging && dpr_ok
}

/// The page's devicePixelRatio against the window's DPI (96 = 1.0).
pub fn dpr_matches(page_dpr: f64, window_dpi: u32) -> bool {
    if !(page_dpr.is_finite() && page_dpr > 0.0) || window_dpi == 0 {
        return false;
    }
    (page_dpr - window_dpi as f64 / 96.0).abs() < 0.02
}

/// The page's list made usable: valid, inset, big enough, at most MAX_BLUR, no exact duplicates.
pub fn clean(list: Vec<Region>) -> Vec<Region> {
    let mut out: Vec<Region> = Vec::new();
    for r in list.into_iter().filter(|r| r.valid()) {
        let w = r.w - 2.0 * INSET;
        let h = r.h - 2.0 * INSET;
        if w < MIN_SIDE || h < MIN_SIDE {
            continue;
        }
        let g = Region { x: r.x + INSET, y: r.y + INSET, w, h, r: (r.r - INSET).max(0.0).min(w / 2.0).min(h / 2.0) };
        if out.iter().any(|o| o == &g) {
            continue;
        }
        out.push(g);
        if out.len() == MAX_BLUR {
            break;
        }
    }
    out
}

/// One acrylic window, in physical screen pixels; `r` the corner radius in physical px.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub r: i32,
}

/// CSS rectangles -> screen rectangles: scaled by `dpr`, offset by the main window's client origin
/// (screen px), clipped to its client area (`cw` x `ch` physical px). Edges are rounded to whole pixels
/// (each edge on its own, so neighbours never overlap or gap by a pixel).
pub fn place(rects: &[Region], dpr: f64, origin: (i32, i32), cw: i32, ch: i32) -> Vec<Place> {
    let dpr = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let mut out = Vec::new();
    for r in rects {
        let x0 = ((r.x * dpr).round() as i64).max(0);
        let y0 = ((r.y * dpr).round() as i64).max(0);
        let x1 = (((r.x + r.w) * dpr).round() as i64).min(cw as i64);
        let y1 = (((r.y + r.h) * dpr).round() as i64).min(ch as i64);
        let (w, h) = (x1 - x0, y1 - y0);
        if w < 2 || h < 2 {
            continue;
        }
        let rad = ((r.r * dpr).round() as i64).clamp(0, w.min(h) / 2);
        out.push(Place { x: origin.0 + x0 as i32, y: origin.1 + y0 as i32, w: w as i32, h: h as i32, r: rad as i32 });
    }
    out
}

/// Do the page's rectangles belong to the window as it is now? `view` is the page's viewport (CSS px)
/// when it measured them (None: a page from before 0.1.10, which does not say); the client area is
/// `cw` x `ch` physical px at `dpr`. The window can be resized or moved by the app (the glance column,
/// a mode or monitor change) before the page has measured again: until it has, the old rectangles
/// would be placed against the new window -- out of place, or hanging past their cards -- so no blur.
pub fn view_matches(view: Option<(f64, f64)>, dpr: f64, cw: i32, ch: i32) -> bool {
    let Some((vw, vh)) = view else { return true };
    if !(vw.is_finite() && vh.is_finite() && dpr.is_finite() && dpr > 0.0) || cw <= 0 || ch <= 0 {
        return false;
    }
    (cw as f64 / dpr - vw).abs() <= 1.5 && (ch as f64 / dpr - vh).abs() <= 1.5
}

/// What to do with the pool. A shown acrylic window is **never moved or resized**: Windows draws the
/// accent's blur of a window that moves or changes size late, and sometimes not again at all -- the
/// frosted patch stays where (and as big as) the window was, round a card that has moved or shrunk
/// (0.1.9's grey corners and strips round the glance cards). So a window keeps exactly the place it was
/// shown at, or goes; a new place always gets a fresh window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    /// Already shown exactly here: left in place, only put back right under the main window (z-order).
    Keep { slot: usize, at: Place },
    /// Not needed (or needed somewhere else): hidden and its window destroyed.
    Hide { slot: usize },
    /// A new window, created for this place and shown there (in a slot that holds no window).
    Show { slot: usize, at: Place },
}

/// The pool's next state. `current`: what each slot shows now (None: no window). Every placement of
/// `next` that a slot already shows exactly is kept; every other shown slot hides; the remaining
/// placements get new windows in free slots (the lowest first, a hidden one included). The ops come as
/// all the hides first, then one Keep or Show per placement in `next`'s order (the z-order: each right
/// under the one before, the first right under the main window).
pub fn plan(current: &[Option<Place>], next: &[Place]) -> Vec<Op> {
    let mut used = vec![false; current.len()];
    let mut keep: Vec<Option<usize>> = Vec::with_capacity(next.len());
    for at in next {
        let k = (0..current.len()).find(|&s| !used[s] && current[s] == Some(*at));
        if let Some(s) = k {
            used[s] = true;
        }
        keep.push(k);
    }
    let mut ops = Vec::new();
    let mut free: Vec<usize> = Vec::new();
    for (s, was) in current.iter().enumerate() {
        if was.is_some() && !used[s] {
            ops.push(Op::Hide { slot: s });
        }
        if !used[s] {
            free.push(s);
        }
    }
    let mut free = free.into_iter();
    let mut extra = current.len();
    for (at, k) in next.iter().zip(keep) {
        match k {
            Some(slot) => ops.push(Op::Keep { slot, at: *at }),
            None => {
                let slot = free.next().unwrap_or_else(|| {
                    extra += 1;
                    extra - 1
                });
                ops.push(Op::Show { slot, at: *at });
            }
        }
    }
    ops
}

/// The acrylic's own tint, as SetWindowCompositionAttribute takes it (0xAABBGGRR). Almost clear: the
/// page draws the tint (light or dark, per the wallpaper) over it, so the CSS keeps the one source of
/// truth for colour. Alpha 0 is avoided -- some Windows builds then draw the acrylic opaque.
pub fn accent_colour(light_ink: bool) -> u32 {
    if light_ink {
        0x0A1E_0C0A // a trace of the dark navy, alpha 0x0A
    } else {
        0x0AFF_FFFF // a trace of white
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rr(x: f64, y: f64, w: f64, h: f64, r: f64) -> Region {
        Region { x, y, w, h, r }
    }
    fn ok_sys() -> System {
        System { build: 22631, transparency: true, high_contrast: false, energy_saver: false }
    }

    #[test]
    fn the_system_decides_first() {
        assert_eq!(unavailable(&ok_sys()), None);
        assert!(unavailable(&System { build: 0, ..ok_sys() }).is_some());
        assert!(unavailable(&System { build: 17134, ..ok_sys() }).is_some(), "Windows 10 1803 is too old");
        assert_eq!(unavailable(&System { build: 17763, ..ok_sys() }), None, "1809 is the first");
        assert_eq!(unavailable(&System { build: 19045, ..ok_sys() }), None, "Windows 10 22H2");
        assert!(unavailable(&System { transparency: false, ..ok_sys() }).unwrap().contains("transparency"));
        assert!(unavailable(&System { high_contrast: true, ..ok_sys() }).unwrap().contains("High contrast"));
        // Energy saver keeps the blur (it costs nothing per frame).
        assert_eq!(unavailable(&System { energy_saver: true, ..ok_sys() }), None);
    }

    #[test]
    fn the_page_glass_flag() {
        let s = ok_sys();
        assert!(page_glass(true, &s, 100, false));
        assert!(!page_glass(false, &s, 100, false), "the setting off");
        assert!(!page_glass(true, &System { transparency: false, ..s }, 100, false));
        assert!(page_glass(true, &s, MIN_OPACITY, false));
        assert!(!page_glass(true, &s, MIN_OPACITY - 1, false), "a faint JOYA AI is not frosted");
        assert!(!page_glass(true, &s, 100, true), "behind the icons");
    }

    #[test]
    fn showing_follows_the_moment() {
        assert!(showing(true, true, false, true));
        assert!(!showing(false, true, false, true));
        assert!(!showing(true, false, false, true), "hidden (Peek closed, Floating put away, minimised)");
        assert!(!showing(true, true, true, true), "while the box is dragged");
        assert!(!showing(true, true, false, false), "rectangles of another monitor's scale");
    }

    #[test]
    fn scale_matching() {
        assert!(dpr_matches(1.0, 96));
        assert!(dpr_matches(1.5, 144));
        assert!(dpr_matches(1.25, 120));
        assert!(!dpr_matches(1.0, 144), "moved to a 150 % monitor, not measured again yet");
        assert!(!dpr_matches(f64::NAN, 96));
        assert!(!dpr_matches(1.0, 0));
    }

    #[test]
    fn cleaning_insets_drops_and_caps() {
        let c = clean(vec![rr(10.0, 20.0, 100.0, 40.0, 18.0)]);
        assert_eq!(c, vec![rr(11.0, 21.0, 98.0, 38.0, 17.0)]);
        // A pill: radius half the height stays half the (inset) height.
        let p = clean(vec![rr(0.0, 0.0, 120.0, 28.0, 14.0)]);
        assert_eq!(p[0].r, 13.0);
        assert_eq!(p[0].h, 26.0);
        // Junk, slivers and duplicates go.
        let c = clean(vec![rr(f64::NAN, 0.0, 10.0, 10.0, 0.0), rr(0.0, 0.0, 7.0, 50.0, 0.0), rr(0.0, 0.0, 50.0, 50.0, 4.0), rr(0.0, 0.0, 50.0, 50.0, 4.0), rr(0.0, 0.0, 50.0, 50.0, -3.0)]);
        assert_eq!(c.len(), 2);
        assert_eq!(c[1].r, 0.0, "a negative radius is square");
        let many: Vec<Region> = (0..100).map(|i| rr(i as f64 * 10.0, 0.0, 40.0, 40.0, 0.0)).collect();
        assert_eq!(clean(many).len(), MAX_BLUR);
    }

    #[test]
    fn placing_on_screen() {
        // The chat panel of a Floating M box at 100 %, the window's client at (1400, 200).
        let p = place(&[rr(15.0, 400.0, 450.0, 445.0, 17.0)], 1.0, (1400, 200), 480, 860);
        assert_eq!(p, vec![Place { x: 1415, y: 600, w: 450, h: 445, r: 17 }]);
        // At 150 % every CSS px is 1.5 physical px, the radius too.
        let p = place(&[rr(15.0, 400.0, 450.0, 445.0, 17.0)], 1.5, (2100, 300), 720, 1290);
        assert_eq!(p, vec![Place { x: 2100 + 23, y: 300 + 600, w: 675, h: 668, r: 26 }]);
        // Clipped to the window; wholly outside: dropped; a bad ratio counts as 1.
        let p = place(&[rr(400.0, 800.0, 200.0, 100.0, 60.0), rr(900.0, 0.0, 50.0, 50.0, 0.0)], f64::NAN, (0, 0), 480, 860);
        assert_eq!(p, vec![Place { x: 400, y: 800, w: 80, h: 60, r: 30 }], "the radius never exceeds half the clipped side");
        // Two neighbours at 125 % meet exactly: no overlap, no gap.
        let p = place(&[rr(0.0, 0.0, 10.3, 10.0, 0.0), rr(10.3, 0.0, 10.0, 10.0, 0.0)], 1.25, (0, 0), 100, 100);
        assert_eq!(p[0].x + p[0].w, p[1].x);
    }

    #[test]
    fn the_pool_plan() {
        let a = Place { x: 0, y: 0, w: 100, h: 40, r: 12 };
        let b = Place { x: 0, y: 50, w: 100, h: 40, r: 12 };
        // From nothing: two new windows, in order.
        assert_eq!(plan(&[], &[a, b]), vec![Op::Show { slot: 0, at: a }, Op::Show { slot: 1, at: b }]);
        // Nothing changed: both kept (re-stacked only).
        assert_eq!(plan(&[Some(a), Some(b)], &[a, b]), vec![Op::Keep { slot: 0, at: a }, Op::Keep { slot: 1, at: b }]);
        // One moved: its window goes and a fresh one takes the new place (never a shown window moved).
        let a2 = Place { x: 30, ..a };
        assert_eq!(plan(&[Some(a), Some(b)], &[a2, b]), vec![Op::Hide { slot: 0 }, Op::Show { slot: 0, at: a2 }, Op::Keep { slot: 1, at: b }]);
        // One goes: its slot hides; a slot already empty is left alone.
        assert_eq!(plan(&[Some(a), Some(b), None], &[a]), vec![Op::Hide { slot: 1 }, Op::Keep { slot: 0, at: a }]);
        // A new size: a new window.
        let big = Place { h: 300, ..a };
        assert_eq!(plan(&[Some(a)], &[big]), vec![Op::Hide { slot: 0 }, Op::Show { slot: 0, at: big }]);
        // Blur off: everything shown hides.
        assert_eq!(plan(&[Some(a), None, Some(b)], &[]), vec![Op::Hide { slot: 0 }, Op::Hide { slot: 2 }]);
        assert!(plan(&[None, None], &[]).is_empty());
        // The order of `next` is kept (z-order), whichever slots the windows are in.
        assert_eq!(plan(&[Some(a), Some(b)], &[b, a]), vec![Op::Keep { slot: 1, at: b }, Op::Keep { slot: 0, at: a }]);
    }

    /// Apply a plan to a pool and check the rule: a shown window keeps its exact place or goes.
    fn run(pool: &mut Vec<Option<Place>>, next: &[Place]) -> (usize, usize) {
        let ops = plan(pool, next);
        let (mut made, mut kept) = (0, 0);
        let mut order = Vec::new();
        for op in &ops {
            match *op {
                Op::Hide { slot } => {
                    assert!(pool[slot].is_some(), "only a shown window hides");
                    pool[slot] = None;
                }
                Op::Keep { slot, at } => {
                    assert_eq!(pool[slot], Some(at), "a kept window is exactly where it was: never moved or resized");
                    kept += 1;
                    order.push(at);
                }
                Op::Show { slot, at } => {
                    if slot >= pool.len() {
                        pool.resize(slot + 1, None);
                    }
                    assert!(pool[slot].is_none(), "a new place gets a fresh window, in a slot with none");
                    pool[slot] = Some(at);
                    made += 1;
                    order.push(at);
                }
            }
        }
        assert_eq!(order, next, "every placement once, in the page's order");
        let mut shown: Vec<Place> = pool.iter().flatten().copied().collect();
        let mut want = next.to_vec();
        shown.sort_by_key(|p| (p.x, p.y, p.w, p.h, p.r));
        want.sort_by_key(|p| (p.x, p.y, p.w, p.h, p.r));
        assert_eq!(shown, want, "nothing else is shown: no blur outlives its card");
        (made, kept)
    }

    /// 0.1.9 on the laptop (150 %): the glance column -- the header pill, "No approvals", Sessions, Today,
    /// Live. A card's text changes, so the page drops it from the report while it settles (80 ms) and
    /// sends it again. 0.1.9 gave placement i to slot i, so every card after the dropped one had its
    /// shown window moved into its neighbour's place and back (and resized and re-shaped), and Windows
    /// left the acrylic where it had been: grey corners round Today, a strip under Live.
    #[test]
    fn the_glance_cards_settling_never_move_a_shown_window() {
        let card = |y: f64, h: f64, r: f64| Region { x: 30.0, y, w: 320.0, h, r };
        let page = |cards: &[Region]| place(&clean(cards.to_vec()), 1.5, (0, 0), 2880, 1620);
        let hd = card(40.0, 30.0, 15.0);
        let noap = card(78.0, 44.0, 14.0);
        let se = card(130.0, 158.0, 14.0);
        let co = card(296.0, 114.0, 14.0);
        let al = card(418.0, 98.0, 14.0);
        let mut pool: Vec<Option<Place>> = Vec::new();
        assert_eq!(run(&mut pool, &page(&[hd, noap, se, co, al])), (5, 0));
        // Sessions redrawn (same size): out while it settles, then back. Only its own window changes.
        assert_eq!(run(&mut pool, &page(&[hd, noap, co, al])), (0, 4));
        assert_eq!(run(&mut pool, &page(&[hd, noap, se, co, al])), (1, 4));
        // Live grows by an alert, then shrinks back to "Nothing new": a new window each time, the others stay.
        let al2 = card(418.0, 140.0, 14.0);
        assert_eq!(run(&mut pool, &page(&[hd, noap, se, co])), (0, 4));
        assert_eq!(run(&mut pool, &page(&[hd, noap, se, co, al2])), (1, 4));
        assert_eq!(run(&mut pool, &page(&[hd, noap, se, co, al])), (1, 4));
        // The approval card arrives above: every card below moves down -- fresh windows, none dragged along.
        let ap = card(78.0, 120.0, 14.0);
        let down = |c: Region| Region { y: c.y + 76.0, ..c };
        let (made, kept) = run(&mut pool, &page(&[hd, ap, down(se), down(co), down(al)]));
        assert_eq!((made, kept), (4, 1), "the header stays; the moved cards get new windows");
        // The old rule (slot i takes placement i) on the same step moved shown windows: that is the bug.
        let before = page(&[hd, noap, se, co, al]);
        let after = page(&[hd, noap, co, al]);
        let moved = (0..after.len()).filter(|&i| before[i] != after[i]).count();
        assert_eq!(moved, 2, "0.1.9: Today's and Live's shown windows were moved into their neighbours' places");
    }

    #[test]
    fn the_page_must_have_measured_this_window() {
        // A page from before 0.1.10 does not say: as before.
        assert!(view_matches(None, 1.5, 100, 100));
        // 150 %: a 1920 x 1080 CSS page in a 2880 x 1620 client; WebView2 rounding is allowed.
        assert!(view_matches(Some((1920.0, 1080.0)), 1.5, 2880, 1620));
        assert!(view_matches(Some((1919.33, 1080.0)), 1.5, 2880, 1621));
        // The window was resized (the glance column, a mode change) before the page measured again: no blur.
        assert!(!view_matches(Some((748.0, 860.0)), 1.5, 1122 + 450, 1290));
        assert!(!view_matches(Some((748.0, 860.0)), 1.5, 1122, 1290 - 30));
        assert!(!view_matches(Some((f64::NAN, 860.0)), 1.5, 1122, 1290));
        assert!(!view_matches(Some((748.0, 860.0)), 1.5, 0, 0));
    }

    #[test]
    fn the_accent_tint_is_nearly_clear() {
        for light in [true, false] {
            let a = accent_colour(light) >> 24;
            assert!(a > 0 && a < 0x20);
        }
    }
}
