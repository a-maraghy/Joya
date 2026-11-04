//! The tray icon: the bot icon (JOYA AI's head with the cap, 0.1.9) with a small status dot (policy::tray_dot)
//! drawn into its lower right corner. Pure pixel work on RGBA.

/// Draw a dot of `rgb` with a dark ring into a copy of `base` (w x h RGBA).
pub fn with_dot(base: &[u8], w: u32, h: u32, rgb: Option<[u8; 3]>) -> Vec<u8> {
    let mut px = base.to_vec();
    let Some(c) = rgb else { return px };
    if px.len() != (w * h * 4) as usize {
        return px;
    }
    let r = (w.min(h) as f64) * 0.19;
    let ring = r + (w as f64 / 32.0).max(1.0);
    let cx = w as f64 - ring - 0.5;
    let cy = h as f64 - ring - 0.5;
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
            let i = ((y * w + x) * 4) as usize;
            if d <= r {
                px[i] = c[0];
                px[i + 1] = c[1];
                px[i + 2] = c[2];
                px[i + 3] = 255;
            } else if d <= ring {
                px[i] = 16;
                px[i + 1] = 16;
                px[i + 2] = 24;
                px[i + 3] = 230;
            }
        }
    }
    px
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_in_the_corner_only() {
        let base = vec![10u8; 32 * 32 * 4];
        let out = with_dot(&base, 32, 32, Some([250, 189, 77]));
        let at = |x: u32, y: u32| &out[((y * 32 + x) * 4) as usize..((y * 32 + x) * 4 + 4) as usize];
        assert_eq!(at(25, 25), &[250, 189, 77, 255]);
        assert_eq!(at(2, 2), &[10, 10, 10, 10]);
        assert_eq!(with_dot(&base, 32, 32, None), base);
        assert_eq!(with_dot(&base[..10], 32, 32, Some([1, 2, 3])), base[..10].to_vec());
    }
}
