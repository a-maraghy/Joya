//! Screenshot <-> screen coordinates, and key-combo parsing. Pure: unit-tested in core-tests.
//!
//! Every coordinate the model sends is in the pixel space of the last screenshot of that monitor
//! (downscaled to fit 1280x800). The process is per-monitor DPI aware, so a monitor's rect from
//! GetMonitorInfo is in physical pixels of the virtual desktop; the map is a plain scale + offset.

pub const MAX_W: u32 = 1280;
pub const MAX_H: u32 = 800;

/// One monitor's screenshot mapping.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShotMap {
    /// The monitor's top-left in physical virtual-desktop pixels.
    pub origin_x: i32,
    pub origin_y: i32,
    /// The monitor's physical size.
    pub phys_w: u32,
    pub phys_h: u32,
    /// The screenshot's size.
    pub shot_w: u32,
    pub shot_h: u32,
}

/// The size a `w x h` capture is downscaled to so it fits `max_w x max_h` (never upscaled).
pub fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (w, h);
    }
    let s = (max_w as f64 / w as f64).min(max_h as f64 / h as f64).min(1.0);
    (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1))
}

impl ShotMap {
    pub fn new(origin_x: i32, origin_y: i32, phys_w: u32, phys_h: u32) -> ShotMap {
        let (shot_w, shot_h) = fit(phys_w, phys_h, MAX_W, MAX_H);
        ShotMap { origin_x, origin_y, phys_w, phys_h, shot_w, shot_h }
    }

    /// Screenshot pixels per physical pixel (<= 1).
    pub fn scale(&self) -> f64 {
        if self.phys_w == 0 {
            1.0
        } else {
            self.shot_w as f64 / self.phys_w as f64
        }
    }

    /// A screenshot point -> physical virtual-desktop pixels, or an error if it is off the shot.
    pub fn to_physical(&self, x: f64, y: f64) -> Result<(i32, i32), String> {
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x > self.shot_w as f64 || y > self.shot_h as f64 {
            return Err(format!("({x}, {y}) is outside the screenshot ({} x {}).", self.shot_w, self.shot_h));
        }
        let sx = self.phys_w as f64 / self.shot_w.max(1) as f64;
        let sy = self.phys_h as f64 / self.shot_h.max(1) as f64;
        let px = ((x * sx).floor() as i64).min(self.phys_w as i64 - 1).max(0);
        let py = ((y * sy).floor() as i64).min(self.phys_h as i64 - 1).max(0);
        Ok((self.origin_x + px as i32, self.origin_y + py as i32))
    }

    /// A physical virtual-desktop point -> screenshot pixels (may fall outside the shot).
    pub fn to_shot(&self, px: i32, py: i32) -> (i32, i32) {
        let s = self.scale();
        (((px - self.origin_x) as f64 * s).round() as i32, ((py - self.origin_y) as f64 * s).round() as i32)
    }
}

/// A physical point -> SendInput's normalised absolute coordinates (0..=65535 over the virtual desktop,
/// for MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK).
pub fn to_absolute(px: i32, py: i32, vx: i32, vy: i32, vw: i32, vh: i32) -> (i32, i32) {
    let n = |p: i32, o: i32, s: i32| -> i32 {
        if s <= 1 {
            return 0;
        }
        let v = ((p - o) as i64 * 65535 + (s as i64 - 1) / 2) / (s as i64 - 1);
        v.clamp(0, 65535) as i32
    };
    (n(px, vx, vw), n(py, vy, vh))
}

/// One key combo: modifier virtual keys (in press order) and the main key (None = modifiers only, e.g. "win").
#[derive(Clone, Debug, PartialEq)]
pub struct Combo {
    pub mods: Vec<u16>,
    pub key: Option<u16>,
    /// Names, for the risk check ("ctrl", "enter").
    pub mod_names: Vec<String>,
    pub key_name: String,
}

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_LWIN: u16 = 0x5B;

fn modifier(name: &str) -> Option<(u16, &'static str)> {
    Some(match name {
        "ctrl" | "control" | "ctl" => (VK_CONTROL, "ctrl"),
        "shift" => (VK_SHIFT, "shift"),
        "alt" | "menu" | "option" => (VK_MENU, "alt"),
        "win" | "windows" | "super" | "meta" | "cmd" | "start" => (VK_LWIN, "win"),
        _ => return None,
    })
}

/// A key name -> (virtual key, canonical name).
pub fn vk(name: &str) -> Option<(u16, String)> {
    let n = name.to_lowercase();
    let c = |v: u16, s: &str| Some((v, s.to_string()));
    match n.as_str() {
        "enter" | "return" => return c(0x0D, "enter"),
        "esc" | "escape" => return c(0x1B, "esc"),
        "tab" => return c(0x09, "tab"),
        "space" | "spacebar" => return c(0x20, "space"),
        "backspace" | "bksp" | "back" => return c(0x08, "backspace"),
        "delete" | "del" => return c(0x2E, "delete"),
        "insert" | "ins" => return c(0x2D, "insert"),
        "home" => return c(0x24, "home"),
        "end" => return c(0x23, "end"),
        "pageup" | "pgup" | "page_up" => return c(0x21, "pageup"),
        "pagedown" | "pgdn" | "page_down" => return c(0x22, "pagedown"),
        "up" | "arrowup" => return c(0x26, "up"),
        "down" | "arrowdown" => return c(0x28, "down"),
        "left" | "arrowleft" => return c(0x25, "left"),
        "right" | "arrowright" => return c(0x27, "right"),
        "printscreen" | "prtsc" | "print" => return c(0x2C, "printscreen"),
        "capslock" => return c(0x14, "capslock"),
        "apps" | "contextmenu" => return c(0x5D, "apps"),
        "plus" => return c(0xBB, "plus"),
        "minus" => return c(0xBD, "minus"),
        "comma" => return c(0xBC, ","),
        "period" | "dot" => return c(0xBE, "."),
        _ => {}
    }
    if let Some(f) = n.strip_prefix('f') {
        if let Ok(i) = f.parse::<u16>() {
            if (1..=24).contains(&i) {
                return Some((0x70 + i - 1, n.clone()));
            }
        }
    }
    let mut chars = n.chars();
    if let (Some(ch), None) = (chars.next(), chars.next()) {
        let v = match ch {
            'a'..='z' => ch.to_ascii_uppercase() as u16,
            '0'..='9' => ch as u16,
            ';' => 0xBA,
            '=' => 0xBB,
            ',' => 0xBC,
            '-' => 0xBD,
            '.' => 0xBE,
            '/' => 0xBF,
            '`' => 0xC0,
            '[' => 0xDB,
            '\\' => 0xDC,
            ']' => 0xDD,
            '\'' => 0xDE,
            _ => return None,
        };
        return Some((v, n));
    }
    None
}

/// Keys that need KEYEVENTF_EXTENDEDKEY.
pub fn is_extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x2C | 0x6F | 0x90)
}

/// "ctrl+s", "alt+f4", "enter", "win+r", "ctrl+shift+esc"; several combos separated by spaces or
/// commas are pressed in turn ("ctrl+a delete"). At most 20 combos.
pub fn parse_keys(s: &str) -> Result<Vec<Combo>, String> {
    let mut out = Vec::new();
    for part in s.split([' ', ',']).map(str::trim).filter(|p| !p.is_empty()) {
        // "ctrl++" means ctrl and plus.
        let mut names: Vec<String> = Vec::new();
        let raw = part.to_lowercase();
        let mut rest = raw.as_str();
        loop {
            match rest.find('+') {
                Some(0) => {
                    // a literal '+' key
                    names.push("plus".into());
                    rest = &rest[1..];
                    rest = rest.strip_prefix('+').unwrap_or(rest);
                }
                Some(i) => {
                    names.push(rest[..i].to_string());
                    rest = &rest[i + 1..];
                }
                None => {
                    if !rest.is_empty() {
                        names.push(rest.to_string());
                    }
                    break;
                }
            }
            if rest.is_empty() {
                break;
            }
        }
        if names.is_empty() {
            return Err(format!("Empty key combo in \"{s}\"."));
        }
        let mut combo = Combo { mods: vec![], key: None, mod_names: vec![], key_name: String::new() };
        let last = names.len() - 1;
        for (i, n) in names.iter().enumerate() {
            if let Some((v, name)) = modifier(n) {
                if i == last && combo.key.is_none() {
                    // "win" alone, or "ctrl+alt" pressed as keys.
                    combo.key = Some(v);
                    combo.key_name = name.to_string();
                } else {
                    if !combo.mods.contains(&v) {
                        combo.mods.push(v);
                        combo.mod_names.push(name.to_string());
                    }
                }
            } else if i == last {
                let (v, name) = vk(n).ok_or_else(|| format!("Unknown key \"{n}\" in \"{part}\"."))?;
                combo.key = Some(v);
                combo.key_name = name;
            } else {
                return Err(format!("\"{n}\" is not a modifier (ctrl, shift, alt, win) in \"{part}\"."));
            }
        }
        out.push(combo);
        if out.len() > 20 {
            return Err("At most 20 key combos per call.".into());
        }
    }
    if out.is_empty() {
        return Err("No keys given.".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fitting() {
        assert_eq!(fit(1920, 1080, 1280, 800), (1280, 720));
        assert_eq!(fit(2560, 1600, 1280, 800), (1280, 800));
        assert_eq!(fit(1080, 1920, 1280, 800), (450, 800));
        assert_eq!(fit(1024, 768, 1280, 800), (1024, 768));
    }

    #[test]
    fn mapping_round_trip() {
        // A 4K monitor at 150 %, to the right of the primary (physical pixels; we are DPI aware).
        let m = ShotMap::new(1920, 0, 3840, 2160);
        assert_eq!((m.shot_w, m.shot_h), (1280, 720));
        assert_eq!(m.to_physical(0.0, 0.0).unwrap(), (1920, 0));
        assert_eq!(m.to_physical(640.0, 360.0).unwrap(), (1920 + 1920, 1080));
        assert_eq!(m.to_physical(1280.0, 720.0).unwrap(), (1920 + 3839, 2159));
        assert!(m.to_physical(1281.0, 10.0).is_err());
        assert!(m.to_physical(-1.0, 10.0).is_err());
        assert_eq!(m.to_shot(3840, 1080), (640, 360));
        // A monitor left of the primary has a negative origin.
        // (1280 x 1024 fits 800 high: 1000 x 800, so 10 shot px = 12.8 physical px.)
        let l = ShotMap::new(-1280, 0, 1280, 1024);
        assert_eq!((l.shot_w, l.shot_h), (1000, 800));
        assert_eq!(l.to_physical(10.0, 10.0).unwrap(), (-1268, 12));
    }

    #[test]
    fn absolute() {
        assert_eq!(to_absolute(0, 0, 0, 0, 1920, 1080), (0, 0));
        assert_eq!(to_absolute(1919, 1079, 0, 0, 1920, 1080), (65535, 65535));
        let (x, _) = to_absolute(-1280, 0, -1280, 0, 3200, 1080);
        assert_eq!(x, 0);
        let (x, _) = to_absolute(960, 0, 0, 0, 1920, 1080);
        assert!((32700..32800).contains(&x));
    }

    #[test]
    fn keys() {
        let k = parse_keys("ctrl+s").unwrap();
        assert_eq!(k.len(), 1);
        assert_eq!(k[0].mods, vec![VK_CONTROL]);
        assert_eq!(k[0].key, Some(0x53));
        let k = parse_keys("Alt+F4").unwrap();
        assert_eq!((k[0].mods.clone(), k[0].key), (vec![VK_MENU], Some(0x73)));
        let k = parse_keys("win+r").unwrap();
        assert_eq!((k[0].mods.clone(), k[0].key), (vec![VK_LWIN], Some(0x52)));
        let k = parse_keys("win").unwrap();
        assert_eq!((k[0].mods.len(), k[0].key), (0, Some(VK_LWIN)));
        let k = parse_keys("ctrl+shift+esc").unwrap();
        assert_eq!(k[0].mods, vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(k[0].key_name, "esc");
        let k = parse_keys("ctrl+a delete").unwrap();
        assert_eq!(k.len(), 2);
        assert_eq!(k[1].key, Some(0x2E));
        let k = parse_keys("ctrl++").unwrap();
        assert_eq!(k[0].key, Some(0xBB));
        let k = parse_keys("Enter").unwrap();
        assert_eq!(k[0].key_name, "enter");
        assert!(parse_keys("ctrl+banana").is_err());
        assert!(parse_keys("s+ctrl").is_err());
        assert!(parse_keys("").is_err());
        assert!(is_extended(0x26));
        assert!(!is_extended(0x41));
    }
}
