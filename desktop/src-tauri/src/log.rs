//! A small log file, for reading after something went wrong on a laptop:
//! %LOCALAPPDATA%\JOYA AI\logs\joya-desktop.log (rotated at 1 MB to joya-desktop.1.log).
//! One line per event, UTC time first. Never a password, cookie, code or token: callers log
//! what happened, not what was typed (the sign-in code and verifier are never passed here).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_BYTES: u64 = 1024 * 1024;

/// The folder: %LOCALAPPDATA%\JOYA AI\logs on Windows, ./logs elsewhere (tests).
pub fn dir() -> PathBuf {
    match std::env::var_os("LOCALAPPDATA") {
        Some(base) => PathBuf::from(base).join("JOYA AI").join("logs"),
        None => PathBuf::from("logs"),
    }
}

pub fn init() -> Option<PathBuf> {
    let d = dir();
    std::fs::create_dir_all(&d).ok()?;
    let p = d.join("joya-desktop.log");
    if let Ok(mut g) = FILE.lock() {
        *g = Some(p.clone());
    }
    Some(p)
}

/// "2026-10-07T13:05:22Z" from seconds since 1970 (no date library; civil-from-days).
pub fn utc(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// One line. Never fails, never blocks for long (a file append), safe from any thread.
pub fn line(msg: &str) {
    let Ok(g) = FILE.lock() else { return };
    let Some(p) = g.as_ref() else { return };
    if std::fs::metadata(p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(p, p.with_file_name("joya-desktop.1.log"));
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let tid = format!("{:?}", std::thread::current().id());
    let clean: String = msg.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).take(2000).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "{} [{}] {}", utc(now), tid.trim_start_matches("ThreadId(").trim_end_matches(')'), clean);
    }
}

#[macro_export]
macro_rules! mlog {
    ($($t:tt)*) => { $crate::log::line(&format!($($t)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc(1_791_378_322), "2026-10-07T13:05:22Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
    }
}
