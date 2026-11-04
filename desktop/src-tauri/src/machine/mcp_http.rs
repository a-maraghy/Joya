//! The hands as an MCP server for the Claude Code CLI on this laptop: JSON-RPC 2.0 over HTTP on
//! 127.0.0.1 (a random port), one POST per message, `Authorization: Bearer <secret>` (a new 256-bit
//! secret per lease, compared in constant time). No SSE: every answer is `application/json`;
//! GET is 405. The parsing, the auth check and the dispatch are pure and unit-tested in
//! core-tests; the listener below is std::net only.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const PROTOCOL: &str = "2025-06-18";
pub const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_HEAD: usize = 16 * 1024;

/// What the server serves (the hands, in the app; a fake in the tests).
pub trait Tools: Send + Sync {
    fn list(&self) -> Vec<Value>;
    /// (MCP content blocks, is_error)
    fn call(&self, name: &str, args: &Value) -> (Vec<Value>, bool);
}

#[derive(Debug, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, PartialEq)]
pub enum Parsed {
    /// Need more bytes.
    Incomplete,
    Done(Request),
    /// Answer with this status and close.
    Bad(u16),
}

/// One HTTP/1.1 request from the bytes read so far (Content-Length bodies only; no chunked).
pub fn parse(buf: &[u8]) -> Parsed {
    let Some(end) = find(buf, b"\r\n\r\n") else {
        return if buf.len() > MAX_HEAD { Parsed::Bad(431) } else { Parsed::Incomplete };
    };
    if end > MAX_HEAD {
        return Parsed::Bad(431);
    }
    let Ok(head) = std::str::from_utf8(&buf[..end]) else { return Parsed::Bad(400) };
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (Some(method), Some(path), Some(ver)) = (parts.next(), parts.next(), parts.next()) else { return Parsed::Bad(400) };
    if !ver.starts_with("HTTP/1.") || method.is_empty() || !path.starts_with('/') {
        return Parsed::Bad(400);
    }
    let mut headers = Vec::new();
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { return Parsed::Bad(400) };
        headers.push((k.trim().to_string(), v.trim().to_string()));
    }
    let req = |body: Vec<u8>| Request { method: method.to_string(), path: path.to_string(), headers: headers.clone(), body };
    if headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && !v.eq_ignore_ascii_case("identity")) {
        return Parsed::Bad(411);
    }
    let cl = headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("content-length")).map(|(_, v)| v.parse::<usize>()).collect::<Vec<_>>();
    let len = match cl.as_slice() {
        [] => 0,
        [Ok(n)] => *n,
        _ => return Parsed::Bad(400),
    };
    if len > MAX_BODY {
        return Parsed::Bad(413);
    }
    let start = end + 4;
    if buf.len() < start + len {
        return Parsed::Incomplete;
    }
    Parsed::Done(req(buf[start..start + len].to_vec()))
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

/// Equal without leaking where they differ (the length is not secret).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn auth_ok(req: &Request, secret: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    match req.header("authorization") {
        Some(v) if v.len() > 7 && v[..7].eq_ignore_ascii_case("bearer ") => ct_eq(v[7..].trim().as_bytes(), secret.as_bytes()),
        _ => false,
    }
}

#[derive(Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    fn json(status: u16, v: &Value) -> Response {
        Response { status, body: v.to_string().into_bytes() }
    }
    fn empty(status: u16) -> Response {
        Response { status, body: Vec::new() }
    }
    pub fn to_bytes(&self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            411 => "Length Required",
            413 => "Payload Too Large",
            431 => "Request Header Fields Too Large",
            _ => "Error",
        };
        let mut out = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n", self.status, reason, self.body.len());
        if !self.body.is_empty() {
            out.push_str("Content-Type: application/json\r\n");
        }
        if self.status == 405 {
            out.push_str("Allow: POST\r\n");
        }
        if self.status == 401 {
            out.push_str("WWW-Authenticate: Bearer\r\n");
        }
        out.push_str("\r\n");
        let mut b = out.into_bytes();
        b.extend_from_slice(&self.body);
        b
    }
}

/// The whole of one request: path, method, Origin (a browser page may not call it), auth, then JSON-RPC.
pub fn handle(req: &Request, secret: &str, tools: &dyn Tools) -> Response {
    let path = req.path.split('?').next().unwrap_or("");
    if path != "/mcp" {
        return Response::empty(404);
    }
    if let Some(o) = req.header("origin") {
        if !o.is_empty() && o != "null" {
            return Response::empty(403);
        }
    }
    if !auth_ok(req, secret) {
        return Response::empty(401);
    }
    match req.method.as_str() {
        "POST" => {}
        "DELETE" => return Response::empty(405),
        _ => return Response::empty(405),
    }
    let msg: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return Response::json(400, &rpc_error(Value::Null, -32700, "Parse error")),
    };
    match dispatch(&msg, tools) {
        Some(v) => Response::json(200, &v),
        None => Response::empty(202),
    }
}

fn rpc_error(id: Value, code: i64, msg: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
}

/// One JSON-RPC message -> its response (None for a notification or a response sent to us).
pub fn dispatch(msg: &Value, tools: &dyn Tools) -> Option<Value> {
    if !msg.is_object() {
        return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
    }
    let id = msg.get("id").cloned();
    let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
        // A response (result / error) from the client: nothing to say.
        return if id.is_some() && (msg.get("result").is_some() || msg.get("error").is_some()) { None } else { Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Invalid Request")) };
    };
    let Some(id) = id.filter(|i| !i.is_null()) else {
        return None; // notifications/* and anything else without an id
    };
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let ok = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id.clone(), "result": result }));
    match method {
        "initialize" => {
            let pv = params.get("protocolVersion").and_then(|v| v.as_str()).filter(|v| v.len() <= 32).unwrap_or(PROTOCOL).to_string();
            ok(json!({
                "protocolVersion": pv,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "joya-hands", "title": "JOYA AI hands", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "The hands of JOYA AI on this Windows laptop. Every tool works only while the user's control lease is active."
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools.list() })),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(|n| n.as_str()) else {
                return Some(rpc_error(id, -32602, "Invalid params: name"));
            };
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let (content, is_error) = tools.call(name, &args);
            ok(json!({ "content": content, "isError": is_error }))
        }
        _ => Some(rpc_error(id, -32601, "Method not found")),
    }
}

/* ------------------------------------------------------------- the listener */

pub struct Server {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Server {
    /// Bind 127.0.0.1:0 and serve until stop(). Each connection on its own thread (a tool call can
    /// wait minutes for an approval card).
    pub fn start(secret: String, tools: Arc<dyn Tools>) -> std::io::Result<Server> {
        let l = TcpListener::bind("127.0.0.1:0")?;
        let port = l.local_addr()?.port();
        l.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let st = stop.clone();
        let secret = Arc::new(secret);
        std::thread::Builder::new().name("joya-hands-mcp".into()).spawn(move || {
            while !st.load(Ordering::SeqCst) {
                match l.accept() {
                    Ok((s, addr)) => {
                        if !addr.ip().is_loopback() {
                            continue;
                        }
                        let (secret, tools, st2) = (secret.clone(), tools.clone(), st.clone());
                        let _ = std::thread::Builder::new().name("joya-hands-call".into()).spawn(move || serve_one(s, &secret, tools.as_ref(), &st2));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
                    Err(_) => std::thread::sleep(Duration::from_millis(200)),
                }
            }
        })?;
        Ok(Server { port, stop })
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn serve_one(mut s: TcpStream, secret: &str, tools: &dyn Tools, stop: &AtomicBool) {
    let _ = s.set_nonblocking(false);
    let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(30)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let resp = loop {
        match parse(&buf) {
            Parsed::Done(req) => {
                if stop.load(Ordering::SeqCst) {
                    break Response::empty(403);
                }
                break handle(&req, secret, tools);
            }
            Parsed::Bad(code) => break Response::empty(code),
            Parsed::Incomplete => match s.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            },
        }
    };
    let _ = s.write_all(&resp.to_bytes());
    let _ = s.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Tools for Fake {
        fn list(&self) -> Vec<Value> {
            vec![json!({"name":"screenshot","description":"d","inputSchema":{"type":"object"}})]
        }
        fn call(&self, name: &str, args: &Value) -> (Vec<Value>, bool) {
            (vec![json!({"type":"text","text":format!("{name} {args}")})], name == "fail")
        }
    }

    fn post(body: &str, auth: Option<&str>) -> Vec<u8> {
        let mut s = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:5\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", body.len());
        if let Some(a) = auth {
            s.push_str(&format!("Authorization: {a}\r\n"));
        }
        s.push_str("\r\n");
        s.push_str(body);
        s.into_bytes()
    }

    fn req(b: &[u8]) -> Request {
        match parse(b) {
            Parsed::Done(r) => r,
            x => panic!("{x:?}"),
        }
    }

    #[test]
    fn parses_http() {
        let b = post(r#"{"a":1}"#, Some("Bearer k"));
        let r = req(&b);
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/mcp");
        assert_eq!(r.header("content-length"), Some("7"));
        assert_eq!(r.body, br#"{"a":1}"#);
        assert_eq!(parse(&b[..b.len() - 2]), Parsed::Incomplete);
        assert_eq!(parse(&b[..20]), Parsed::Incomplete);
        assert_eq!(parse(b"GARBAGE\r\n\r\n"), Parsed::Bad(400));
        assert_eq!(parse(b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"), Parsed::Bad(411));
        assert_eq!(parse(format!("POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1).as_bytes()), Parsed::Bad(413));
        assert_eq!(parse(b"POST /mcp HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab"), Parsed::Bad(400));
        assert_eq!(parse(&vec![b'a'; MAX_HEAD + 10]), Parsed::Bad(431));
        assert!(matches!(parse(b"GET /mcp HTTP/1.1\r\n\r\n"), Parsed::Done(_)));
    }

    #[test]
    fn auth_and_routes() {
        let k = "s3cret";
        let h = |b: Vec<u8>| handle(&req(&b), k, &Fake).status;
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(h(post(ping, Some("Bearer s3cret"))), 200);
        assert_eq!(h(post(ping, Some("bearer s3cret"))), 200);
        assert_eq!(h(post(ping, None)), 401);
        assert_eq!(h(post(ping, Some("Bearer s3cres"))), 401);
        assert_eq!(h(post(ping, Some("Bearer s3cret2"))), 401);
        assert_eq!(h(post(ping, Some("Basic s3cret"))), 401);
        assert_eq!(handle(&req(&post(ping, Some("Bearer "))), "", &Fake).status, 401, "an empty secret never matches");
        assert_eq!(h(b"GET /mcp HTTP/1.1\r\nAuthorization: Bearer s3cret\r\n\r\n".to_vec()), 405);
        assert_eq!(h(b"POST /other HTTP/1.1\r\nAuthorization: Bearer s3cret\r\n\r\n".to_vec()), 404);
        let mut with_origin = post(ping, Some("Bearer s3cret"));
        let at = find(&with_origin, b"\r\n").unwrap() + 2;
        with_origin.splice(at..at, b"Origin: https://evil.example\r\n".iter().cloned());
        assert_eq!(h(with_origin), 403, "a web page may not call it");
        assert_eq!(h(post("{nope", Some("Bearer s3cret"))), 400);
        assert!(ct_eq(b"abc", b"abc") && !ct_eq(b"abc", b"abd") && !ct_eq(b"ab", b"abc"));
        let r = handle(&req(&post(ping, Some("Bearer s3cret"))), k, &Fake);
        let bytes = String::from_utf8(r.to_bytes()).unwrap();
        assert!(bytes.starts_with("HTTP/1.1 200 OK\r\n") && bytes.contains("Content-Type: application/json") && bytes.contains("Connection: close"));
    }

    #[test]
    fn json_rpc() {
        let d = |s: &str| dispatch(&serde_json::from_str(s).unwrap(), &Fake);
        let init = d(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-code"}}}"#).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26", "echoed");
        assert_eq!(init["result"]["capabilities"], json!({"tools":{}}));
        assert_eq!(init["result"]["serverInfo"]["name"], "joya-hands");
        let init = d(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#).unwrap();
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL);
        assert_eq!(d(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#), None);
        assert_eq!(d(r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#).unwrap(), json!({"jsonrpc":"2.0","id":"a","result":{}}));
        let l = d(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).unwrap();
        assert_eq!(l["result"]["tools"][0]["name"], "screenshot");
        let c = d(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"screenshot","arguments":{"x":1}}}"#).unwrap();
        assert_eq!(c["result"]["isError"], false);
        assert_eq!(c["result"]["content"][0]["text"], "screenshot {\"x\":1}");
        let c = d(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"fail"}}"#).unwrap();
        assert_eq!(c["result"]["isError"], true);
        assert_eq!(d(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{}}"#).unwrap()["error"]["code"], -32602);
        assert_eq!(d(r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#).unwrap()["error"]["code"], -32601);
        assert_eq!(d(r#"[1]"#).unwrap()["error"]["code"], -32600);
        assert_eq!(d(r#"{"jsonrpc":"2.0","id":7,"result":{}}"#), None);
        // Over HTTP a notification is 202 with no body.
        let r = handle(&req(&post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, Some("Bearer k"))), "k", &Fake);
        assert_eq!(r, Response { status: 202, body: vec![] });
    }

    #[test]
    fn serves_over_loopback() {
        let srv = Server::start("k1".into(), Arc::new(Fake)).unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
        s.write_all(&post(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, Some("Bearer k1"))).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.contains("\"screenshot\""));
        srv.stop();
        std::thread::sleep(Duration::from_millis(150));
        // After stop nothing is served (the connection is refused or closed unanswered).
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", srv.port)) {
            let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = s.write_all(&post(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, Some("Bearer k1")));
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            assert!(!out.contains("200 OK"));
        }
    }
}
