//! "Sign in in your browser" -- the fallback for when Windows Hello cannot show
//! inside the webview (dashboard/lib/desktop.js is the other half).
//!
//! 1. A fresh secret (the verifier, 32 random bytes) lives only in this process;
//!    its SHA-256 (the challenge) goes to the site.
//! 2. A listener on 127.0.0.1 (a free port, loopback only) waits for one request.
//! 3. The default browser opens https://<site>/desktop/link?c=<challenge>&p=<port>;
//!    the person signs in there (both factors) and presses Link.
//! 4. The browser comes back to http://127.0.0.1:<port>/joya-callback?code=<code>;
//!    the listener answers "you can close this tab" and hands the code over.
//! 5. The webview opens /desktop/redeem?code=<code>&v=<verifier>: the site checks
//!    the code is unspent, unexpired and was issued for SHA-256(verifier).
//!
//! The code is useless without the verifier, and the verifier never leaves this
//! process except in that last request, to the site, over TLS.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

pub const WAIT: Duration = Duration::from_secs(5 * 60);

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Pkce {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let verifier = URL_SAFE_NO_PAD.encode(b);
    let challenge = challenge_of(&verifier);
    Pkce { verifier, challenge }
}

pub fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The code from the browser's request line, if it is exactly `GET /joya-callback?code=<43 chars> HTTP/1.x`.
pub fn code_from_request(head: &str) -> Option<String> {
    let line = head.lines().next()?;
    let mut it = line.split(' ');
    if it.next()? != "GET" {
        return None;
    }
    let target = it.next()?;
    if !it.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let q = target.strip_prefix("/joya-callback?code=")?;
    if q.len() == 43 && q.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        Some(q.to_string())
    } else {
        None
    }
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>JOYA AI</title><body style=\"font:15px system-ui;margin:3em;color:#17142b\"><h2>JOYA AI is signing in</h2><p>You can close this tab and go back to the app.</p></body>";
const PAGE_BAD: &str = "<!doctype html><meta charset=utf-8><title>JOYA AI</title><body style=\"font:15px system-ui;margin:3em\"><h2>Not this</h2><p>This address is only for JOYA AI's sign-in.</p></body>";

pub struct Waiter {
    listener: TcpListener,
    pub port: u16,
}

/// A loopback listener on a free port.
pub fn listen() -> std::io::Result<Waiter> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    Ok(Waiter { listener, port })
}

impl Waiter {
    /// Wait (on the calling thread) for the browser to come back with a code, at most `wait`.
    /// Anything else that knocks gets a short refusal and the wait goes on.
    pub fn code(self, wait: Duration) -> Option<String> {
        let end = Instant::now() + wait;
        self.listener.set_nonblocking(true).ok()?;
        while Instant::now() < end {
            match self.listener.accept() {
                Ok((stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    if let Some(c) = answer(stream) {
                        return Some(c);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        None
    }
}

fn answer(mut s: TcpStream) -> Option<String> {
    let _ = s.set_nonblocking(false);
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = [0u8; 2048];
    let mut n = 0;
    while n < buf.len() {
        match s.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => {
                n += k;
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&buf[..n]).to_string();
    let code = code_from_request(&head);
    let body = if code.is_some() { PAGE_OK } else { PAGE_BAD };
    let status = if code.is_some() { "200 OK" } else { "404 Not Found" };
    let _ = write!(
        s,
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body
    );
    let _ = s.flush();
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_the_server() {
        // The server computes base64url(sha256(verifier)) (lib/desktop.js redeem()).
        assert_eq!(challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let p = pkce();
        assert_eq!(p.verifier.len(), 43);
        assert_eq!(p.challenge.len(), 43);
        assert_eq!(challenge_of(&p.verifier), p.challenge);
        assert_ne!(pkce().verifier, p.verifier);
    }

    #[test]
    fn only_the_callback_is_taken() {
        let c = "A".repeat(43);
        assert_eq!(code_from_request(&format!("GET /joya-callback?code={} HTTP/1.1\r\nHost: x\r\n\r\n", c)), Some(c.clone()));
        assert_eq!(code_from_request(&format!("POST /joya-callback?code={} HTTP/1.1\r\n", c)), None);
        assert_eq!(code_from_request(&format!("GET /joya-callback?code={}&x=1 HTTP/1.1\r\n", c)), None);
        assert_eq!(code_from_request("GET /joya-callback?code=short HTTP/1.1\r\n"), None);
        assert_eq!(code_from_request(&format!("GET /other?code={} HTTP/1.1\r\n", c)), None);
        assert_eq!(code_from_request(&format!("GET /joya-callback?code={}<script> HTTP/1.1\r\n", &c[..35])), None);
    }

    #[test]
    fn the_listener_takes_one_code() {
        let w = listen().unwrap();
        let port = w.port;
        let t = std::thread::spawn(move || w.code(Duration::from_secs(5)));
        // Something else knocks first: refused, the wait goes on.
        let mut a = TcpStream::connect(("127.0.0.1", port)).unwrap();
        a.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").unwrap();
        let mut r = String::new();
        let _ = a.read_to_string(&mut r);
        assert!(r.starts_with("HTTP/1.1 404"));
        let code = "b".repeat(43);
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(format!("GET /joya-callback?code={} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", code).as_bytes()).unwrap();
        let mut r2 = String::new();
        let _ = s.read_to_string(&mut r2);
        assert!(r2.starts_with("HTTP/1.1 200") && r2.contains("close this tab"));
        assert_eq!(t.join().unwrap(), Some(code));
    }

    #[test]
    fn the_listener_gives_up() {
        let w = listen().unwrap();
        assert_eq!(w.code(Duration::from_millis(300)), None);
    }
}
