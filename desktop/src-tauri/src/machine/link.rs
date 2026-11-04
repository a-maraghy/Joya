//! The link to Joya: one outbound WebSocket, `wss://<origin host>/machines/api/link` with
//! `Authorization: Bearer <machine token>`, on its own thread. Short read timeouts so the outbox is
//! sent within a fifth of a second; reconnects with backoff 2 s -> 60 s; 60 s without a frame (the
//! server pings every 20 s) = lost. A 401/403 on the upgrade means the token was revoked.

use super::Ctl;
use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Connector, Message, WebSocket};

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

enum Fail {
    /// The server refused the token (401/403): it is gone.
    Auth,
    Other(String),
}

pub fn run(ctl: Arc<Ctl>) {
    let mut backoff = 2u64;
    loop {
        let gen = ctl.generation();
        let Some((origin, token)) = ctl.origin_and_token() else {
            ctl.set_online(false);
            wait(&ctl, gen, Duration::from_secs(2));
            continue;
        };
        match connect(&origin, &token) {
            Ok(ws) => {
                drop(token);
                backoff = 2;
                mlog!("machine link: connected to {}", origin.host_str().unwrap_or(""));
                ctl.set_online(true);
                let why = serve(&ctl, ws, gen);
                mlog!("machine link: closed ({})", why);
                ctl.set_online(false);
            }
            Err(Fail::Auth) => {
                mlog!("machine link: the server refused the token (revoked); unlinking");
                ctl.token_revoked();
                continue;
            }
            Err(Fail::Other(e)) => {
                mlog!("machine link: could not connect ({}); retrying in {} s", e, backoff);
                ctl.set_online(false);
            }
        }
        wait(&ctl, gen, Duration::from_secs(backoff));
        backoff = (backoff * 2).min(60);
    }
}

/// Sleep, but wake at once when the link is told to start over (linked, unlinked).
fn wait(ctl: &Ctl, gen: u64, d: Duration) {
    let t0 = Instant::now();
    while t0.elapsed() < d && ctl.generation() == gen {
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn connect(origin: &url::Url, token: &str) -> Result<Ws, Fail> {
    let host = origin.host_str().ok_or_else(|| Fail::Other("no host".into()))?.to_string();
    let port = origin.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = (host.as_str(), port).to_socket_addrs().map_err(|e| Fail::Other(format!("dns: {}", e)))?.collect();
    let mut stream = None;
    for a in &addrs {
        if let Ok(s) = TcpStream::connect_timeout(a, Duration::from_secs(10)) {
            stream = Some(s);
            break;
        }
    }
    let stream = stream.ok_or_else(|| Fail::Other("no route to the server".into()))?;
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
    let hostport = if origin.port().is_some() { format!("{}:{}", host, port) } else { host.clone() };
    let mut req = format!("wss://{}/machines/api/link", hostport).into_client_request().map_err(|e| Fail::Other(e.to_string()))?;
    let auth = tungstenite::http::HeaderValue::from_str(&format!("Bearer {}", token)).map_err(|_| Fail::Other("bad token".into()))?;
    req.headers_mut().insert(tungstenite::http::header::AUTHORIZATION, auth);
    req.headers_mut().insert(tungstenite::http::header::USER_AGENT, tungstenite::http::HeaderValue::from_str(&crate::site::user_agent()).unwrap_or(tungstenite::http::HeaderValue::from_static("JoyaDesktop")));
    let cfg = WebSocketConfig::default().max_message_size(Some(super::wire::MAX_FRAME)).max_frame_size(Some(super::wire::MAX_FRAME));
    // The Windows trust store (as the updater and the pairing POST); webpki roots if that fails.
    let connector = {
        use rustls_platform_verifier::ConfigVerifierExt;
        rustls::ClientConfig::with_platform_verifier().ok().map(|c| Connector::Rustls(Arc::new(c)))
    };
    match tungstenite::client_tls_with_config(req, stream, Some(cfg), connector) {
        Ok((mut ws, _)) => {
            let short = Some(Duration::from_millis(200));
            match ws.get_mut() {
                MaybeTlsStream::Plain(s) => {
                    let _ = s.set_read_timeout(short);
                }
                MaybeTlsStream::Rustls(t) => {
                    let _ = t.sock.set_read_timeout(short);
                }
                _ => {}
            }
            Ok(ws)
        }
        Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(resp))) if resp.status() == 401 || resp.status() == 403 => Err(Fail::Auth),
        Err(tungstenite::HandshakeError::Failure(e)) => Err(Fail::Other(e.to_string())),
        Err(tungstenite::HandshakeError::Interrupted(_)) => Err(Fail::Other("the handshake timed out".into())),
    }
}

fn serve(ctl: &Arc<Ctl>, mut ws: Ws, gen: u64) -> String {
    let mut last = Instant::now();
    if ws.send(Message::text(ctl.hello().to_string())).is_err() {
        return "could not send hello".into();
    }
    loop {
        if ctl.generation() != gen {
            let _ = ws.close(None);
            let _ = ws.flush();
            return "relinking".into();
        }
        for m in ctl.drain_outbox() {
            if let Err(e) = ws.send(Message::text(m)) {
                return format!("send: {}", e);
            }
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                last = Instant::now();
                ctl.on_text(t.as_str());
            }
            Ok(Message::Close(_)) => return "closed by the server".into(),
            Ok(_) => last = Instant::now(), // pings are answered by tungstenite (flushed below)
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return format!("read: {}", e),
        }
        match ws.flush() {
            Ok(()) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return format!("flush: {}", e),
        }
        if last.elapsed() > Duration::from_secs(60) {
            return "60 s without a frame".into();
        }
    }
}
