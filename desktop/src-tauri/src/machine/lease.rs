//! The control lease (pure; unit-tested in core-tests): while it is active JOYA AI may use this
//! computer, and only then. The app enforces it locally whatever the server says: the runner, the
//! hands and every permission answer read it. Times are milliseconds since 1970 (UTC).

/// A lease never runs more than this far ahead of now (extensions included).
pub const MAX_AHEAD_MS: u64 = 60 * 60 * 1000;
/// "+15 min" on the pill.
pub const EXTEND_STEP_MS: u64 = 15 * 60 * 1000;

/// Why a lease ended (the wire's `reason`).
/// "failed": the session could not start (Claude Code missing, would not spawn, ended or hung
/// while starting); the reason itself goes with the `session failed` message.
pub const REASONS: [&str; 11] = ["stop-hotkey", "pill-stop", "timeout", "locked", "signout", "app-exit", "link-lost", "runner-exited", "server", "unlinked", "failed"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Active {
    pub id: String,
    pub slug: String,
    pub started_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub id: String,
    pub slug: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default)]
pub struct Lease {
    cur: Option<Active>,
    last: Option<Ended>,
}

impl Lease {
    pub fn new() -> Lease {
        Lease::default()
    }

    /// Start a lease. Refused while one is active; the expiry is capped at now + 60 min and must be
    /// in the future.
    pub fn start(&mut self, id: &str, slug: &str, expires_at: u64, now: u64) -> Result<&Active, &'static str> {
        if self.active(now) {
            return Err("already under control");
        }
        if id.is_empty() || id.len() > 80 {
            return Err("bad lease id");
        }
        if expires_at <= now {
            return Err("the lease has already expired");
        }
        self.cur = Some(Active { id: id.to_string(), slug: slug.to_string(), started_at: now, expires_at: expires_at.min(now + MAX_AHEAD_MS) });
        Ok(self.cur.as_ref().unwrap())
    }

    /// Move the expiry (capped at now + 60 min). Returns the new expiry, None when no lease is active.
    pub fn extend(&mut self, new_expiry: u64, now: u64) -> Option<u64> {
        if !self.active(now) {
            return None;
        }
        let a = self.cur.as_mut().unwrap();
        let e = new_expiry.min(now + MAX_AHEAD_MS);
        if e <= now {
            return None;
        }
        a.expires_at = e;
        Some(e)
    }

    /// The pill's "+15 min": from the current expiry, capped.
    pub fn extend_step(&mut self, now: u64) -> Option<u64> {
        let e = self.cur.as_ref()?.expires_at.saturating_add(EXTEND_STEP_MS);
        self.extend(e, now)
    }

    /// End it (idempotent): Some only the first time, for the lease that was on.
    pub fn end(&mut self, reason: &str) -> Option<Ended> {
        let a = self.cur.take()?;
        let reason = if REASONS.contains(&reason) { reason } else { "server" };
        let e = Ended { id: a.id, slug: a.slug, reason: reason.to_string() };
        self.last = Some(e.clone());
        Some(e)
    }

    /// End only when `id` is the lease that is on (a server `stop` for an old lease does nothing).
    pub fn end_if(&mut self, id: &str, reason: &str) -> Option<Ended> {
        if self.cur.as_ref().map(|a| a.id == id).unwrap_or(false) {
            self.end(reason)
        } else {
            None
        }
    }

    /// Once a second: a lease past its expiry ends ("timeout").
    pub fn tick(&mut self, now: u64) -> Option<Ended> {
        match &self.cur {
            Some(a) if now >= a.expires_at => self.end("timeout"),
            _ => None,
        }
    }

    pub fn active(&self, now: u64) -> bool {
        self.cur.as_ref().map(|a| now < a.expires_at).unwrap_or(false)
    }

    pub fn current(&self) -> Option<&Active> {
        self.cur.as_ref()
    }

    pub fn last_ended(&self) -> Option<&Ended> {
        self.last.as_ref()
    }

    pub fn remaining_ms(&self, now: u64) -> u64 {
        self.cur.as_ref().map(|a| a.expires_at.saturating_sub(now)).unwrap_or(0)
    }
}

/// "mm:ss" for the pill (hours folded into minutes; never negative).
pub fn mmss(ms: u64) -> String {
    let s = ms.div_ceil(1000);
    format!("{:02}:{:02}", s / 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    const M: u64 = 60_000;

    #[test]
    fn start_and_cap() {
        let mut l = Lease::new();
        assert!(!l.active(0));
        let a = l.start("L1", "laptop", 1_000 + 90 * M, 1_000).unwrap().clone();
        assert_eq!(a.expires_at, 1_000 + 60 * M, "capped at an hour");
        assert!(l.active(1_000));
        assert_eq!(l.start("L2", "x", 1_000 + 5 * M, 2_000), Err("already under control"));
        assert!(Lease::new().start("L", "s", 10, 10).is_err(), "expired");
        assert!(Lease::new().start("", "s", 100, 10).is_err());
    }

    #[test]
    fn extend_capped() {
        let mut l = Lease::new();
        l.start("L", "s", 10 * M, 0).unwrap();
        assert_eq!(l.extend(20 * M, M), Some(20 * M));
        assert_eq!(l.extend(500 * M, M), Some(61 * M), "now + 60 min");
        assert_eq!(l.extend_step(30 * M), Some(76 * M), "expiry + 15 min, under now + 60 min");
        assert_eq!(l.extend(0, 31 * M), None, "an expiry in the past is refused");
        l.end("pill-stop");
        assert_eq!(l.extend(5 * M, 0), None, "nothing to extend");
    }

    #[test]
    fn extend_step_is_from_expiry() {
        let mut l = Lease::new();
        l.start("L", "s", 10 * M, 0).unwrap();
        assert_eq!(l.extend_step(0), Some(25 * M));
        assert_eq!(l.extend_step(0), Some(40 * M));
        assert_eq!(l.extend_step(0), Some(55 * M));
        assert_eq!(l.extend_step(0), Some(60 * M), "capped");
    }

    #[test]
    fn end_is_idempotent() {
        let mut l = Lease::new();
        l.start("L", "s", 10 * M, 0).unwrap();
        let e = l.end("stop-hotkey").unwrap();
        assert_eq!(e, Ended { id: "L".into(), slug: "s".into(), reason: "stop-hotkey".into() });
        assert_eq!(l.end("pill-stop"), None);
        assert!(!l.active(1));
        assert_eq!(l.last_ended().unwrap().reason, "stop-hotkey");
        let mut l = Lease::new();
        l.start("L", "s", 10 * M, 0).unwrap();
        assert_eq!(l.end("made-up").unwrap().reason, "server");
        let mut l = Lease::new();
        l.start("L", "s", 10 * M, 0).unwrap();
        assert_eq!(l.end("failed").unwrap().reason, "failed", "a start failure is its own reason");
    }

    #[test]
    fn end_if_only_for_the_current() {
        let mut l = Lease::new();
        l.start("L2", "s", 10 * M, 0).unwrap();
        assert_eq!(l.end_if("L1", "server"), None);
        assert!(l.active(0));
        assert!(l.end_if("L2", "server").is_some());
    }

    #[test]
    fn tick_times_out() {
        let mut l = Lease::new();
        l.start("L", "s", 10 * M, 0).unwrap();
        assert_eq!(l.tick(10 * M - 1), None);
        assert_eq!(l.remaining_ms(10 * M - 1000), 1000);
        assert!(!l.active(10 * M), "inactive at the expiry even before tick");
        assert_eq!(l.tick(10 * M).unwrap().reason, "timeout");
        assert_eq!(l.tick(11 * M), None);
        // A new lease can start after one ended.
        assert!(l.start("L2", "s", 20 * M, 11 * M).is_ok());
    }

    #[test]
    fn clock() {
        assert_eq!(mmss(0), "00:00");
        assert_eq!(mmss(999), "00:01");
        assert_eq!(mmss(61_000), "01:01");
        assert_eq!(mmss(60 * M), "60:00");
    }
}
