// Linux: a native panel (the glyph dotfiles' Quickshell one) talks to the shell over a Unix socket at
// $XDG_RUNTIME_DIR/roamies/panel.sock, in the same private 0700 folder auth.rs uses. One JSON object per line, both
// ways. Shell → client: every msg the web panel gets through window.__panel(msg), verbatim, plus {"kind":"open"} and
// {"kind":"close"}. Client → shell: what the web panel passes to sidecar_send, through the same page_may_send gate
// (never anything auth*), plus {"type":"panel_hide"} (it closed) and {"type":"hello"} (a greeting, not forwarded).
// One client at a time: a new connection replaces the old one. While one is connected (and ROAMIES_WEB_PANEL isn't
// 1), opening the panel opens it instead of the web panel (main.rs show_panel).

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

/// The longest line read from a client (without its newline). A longer one drops the connection.
pub(crate) const MAX_LINE: usize = 1 << 20;
/// A client that stops reading mustn't hold the shell up: a write that blocks this long drops it.
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);

/// The connected client (a connection number, its write half) and whether its panel is open.
pub(crate) struct Server {
    client: Mutex<Option<(u64, UnixStream)>>,
    open: AtomicBool,
    seq: AtomicU64,
}

pub(crate) static SERVER: Server = Server::new();

/// What a line from the client asks for.
#[derive(Debug, PartialEq)]
pub(crate) enum Incoming {
    /// Goes to the sidecar, as sidecar_send would send it.
    Forward(Value),
    /// The client's panel closed.
    Hide,
    /// A greeting: nothing to do.
    Hello,
    /// Not allowed from a page (auth*): dropped.
    Drop,
}

/// What opening the panel does.
#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) enum Route {
    /// No native client (or ROAMIES_WEB_PANEL=1): the web panel, as always.
    Web,
    /// Send {"kind":"open"} to the client.
    Open,
    /// Send {"kind":"close"} to the client (a toggle while it's open).
    Close,
}

/// The routing decision, on its own so it can be tested.
pub(crate) fn route(connected: bool, web_forced: bool, native_open: bool, toggle: bool) -> Route {
    if !connected || web_forced {
        Route::Web
    } else if native_open && toggle {
        Route::Close
    } else {
        Route::Open
    }
}

/// ROAMIES_WEB_PANEL=1 keeps the web panel even with a native one connected.
pub(crate) fn web_forced() -> bool {
    std::env::var("ROAMIES_WEB_PANEL").is_ok_and(|v| v == "1")
}

/// A line as a message: only a JSON object counts.
pub(crate) fn parse_line(line: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(line).ok()?;
    let v: Value = serde_json::from_str(text.trim_end_matches('\r')).ok()?;
    v.is_object().then_some(v)
}

/// What a message from the client asks for. The gate is main.rs page_may_send, the same as sidecar_send's.
pub(crate) fn incoming(msg: Value) -> Incoming {
    match msg.get("type").and_then(Value::as_str) {
        Some("panel_hide") => Incoming::Hide,
        Some("hello") => Incoming::Hello,
        _ if !crate::page_may_send(&msg) => Incoming::Drop,
        _ => Incoming::Forward(msg),
    }
}

/// Reads one line into `buf` (cleared first, newline left out). Ok(false) at the end of the stream (a last line
/// without a newline is still given), and an error when a line runs past MAX_LINE.
pub(crate) fn read_line<R: BufRead>(r: &mut R, buf: &mut Vec<u8>) -> io::Result<bool> {
    buf.clear();
    let n = r.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', buf)?;
    if n == 0 {
        return Ok(false);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    } else if buf.len() > MAX_LINE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
    }
    Ok(true)
}

/// The socket's folder: $XDG_RUNTIME_DIR/roamies, made 0700 if it's missing or ours and open, refused otherwise (auth.rs).
pub(crate) fn socket_dir(base: &Path) -> io::Result<PathBuf> {
    let root = base.join("roamies");
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&root)?;
    crate::auth::own_private_dir(&root)?;
    Ok(root)
}

/// Binds the socket in `dir` (a stale socket file there is removed first), mode 0600.
pub(crate) fn bind(dir: &Path) -> io::Result<(UnixListener, PathBuf)> {
    let path = dir.join("panel.sock");
    if let Ok(m) = fs::symlink_metadata(&path) {
        if !m.file_type().is_socket() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "panel.sock is there and isn't a socket"));
        }
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    Ok((listener, path))
}

impl Server {
    pub(crate) const fn new() -> Server {
        Server { client: Mutex::new(None), open: AtomicBool::new(false), seq: AtomicU64::new(0) }
    }

    pub(crate) fn connected(&self) -> bool {
        self.client.lock().unwrap().is_some()
    }

    pub(crate) fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    pub(crate) fn set_open(&self, on: bool) -> bool {
        self.open.swap(on, Ordering::SeqCst)
    }

    /// Sends one message to the client, if there is one. A client that can't take it is dropped.
    pub(crate) fn send(&self, msg: &Value) {
        let mut client = self.client.lock().unwrap();
        if let Some((_, s)) = client.as_mut() {
            if writeln!(s, "{msg}").and_then(|_| s.flush()).is_err() {
                if let Some((_, s)) = client.take() {
                    let _ = s.shutdown(std::net::Shutdown::Both);
                }
            }
        }
    }

    /// Takes connections for good: each replaces the one before, and its lines go to `on_msg`. `on_gone` is called
    /// when the current client's stream ends (not when a newer one replaced it).
    pub(crate) fn serve(
        &'static self,
        listener: UnixListener,
        on_msg: Arc<dyn Fn(Incoming) + Send + Sync>,
        on_gone: Arc<dyn Fn() + Send + Sync>,
    ) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let Ok(writer) = stream.try_clone() else { continue };
            let _ = writer.set_write_timeout(Some(WRITE_TIMEOUT));
            let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some((_, old)) = self.client.lock().unwrap().replace((id, writer)) {
                let _ = old.shutdown(std::net::Shutdown::Both);
            }
            // A new client starts closed: it says panel_open itself when it shows.
            self.open.store(false, Ordering::SeqCst);
            let (on_msg, on_gone) = (on_msg.clone(), on_gone.clone());
            thread::spawn(move || {
                let mut r = BufReader::new(stream);
                let mut buf = Vec::new();
                while let Ok(true) = read_line(&mut r, &mut buf) {
                    if let Some(msg) = parse_line(&buf) {
                        on_msg(incoming(msg));
                    }
                }
                let mut client = self.client.lock().unwrap();
                if client.as_ref().is_some_and(|(cur, _)| *cur == id) {
                    if let Some((_, s)) = client.take() {
                        let _ = s.shutdown(std::net::Shutdown::Both);
                    }
                    drop(client);
                    on_gone();
                }
            });
        }
    }
}

/// Starts the socket for the app. Without a private runtime folder there's no socket (and the web panel as always).
pub(crate) fn start(app: &AppHandle) {
    let dir = match crate::auth::runtime_dir_from(std::env::var_os("XDG_RUNTIME_DIR"))
        .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))
        .and_then(|base| socket_dir(&base))
    {
        Ok(d) => d,
        Err(e) => return eprintln!("native panel socket off: {e}"),
    };
    let (listener, path) = match bind(&dir) {
        Ok(l) => l,
        Err(e) => return eprintln!("native panel socket off: {e}"),
    };
    *SOCKET_PATH.lock().unwrap() = Some(path);
    let (a, b) = (app.clone(), app.clone());
    let on_msg: Arc<dyn Fn(Incoming) + Send + Sync> = Arc::new(move |m| match m {
        Incoming::Forward(msg) => {
            if msg.get("type").and_then(Value::as_str) == Some("panel_open") {
                SERVER.set_open(true);
            }
            crate::to_sidecar(&a, &msg);
        }
        Incoming::Hide => {
            SERVER.set_open(false);
            crate::to_sidecar(&a, &json!({ "type": "panel_closed", "why": "native" }));
        }
        Incoming::Hello | Incoming::Drop => {}
    });
    let on_gone: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        if SERVER.set_open(false) {
            crate::to_sidecar(&b, &json!({ "type": "panel_closed", "why": "native-gone" }));
        }
    });
    thread::spawn(move || SERVER.serve(listener, on_msg, on_gone));
}

static SOCKET_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Removes the socket file as the app quits.
pub(crate) fn stop() {
    if let Some(p) = SOCKET_PATH.lock().unwrap().take() {
        let _ = fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc;

    /// A fresh folder under the system temp dir, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Scratch {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("hanami-{tag}-{}-{nanos:x}", std::process::id()));
            fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lines_are_split_and_a_too_long_one_is_an_error() {
        let mut r = Cursor::new(b"{\"a\":1}\n{\"b\":2}\r\nlast".to_vec());
        let mut buf = Vec::new();
        assert!(read_line(&mut r, &mut buf).unwrap());
        assert_eq!(buf, b"{\"a\":1}");
        assert!(read_line(&mut r, &mut buf).unwrap());
        assert_eq!(parse_line(&buf), Some(json!({ "b": 2 })), "a CR before the newline is fine");
        assert!(read_line(&mut r, &mut buf).unwrap());
        assert_eq!(buf, b"last");
        assert!(!read_line(&mut r, &mut buf).unwrap(), "end of the stream");

        let mut exact = vec![b'x'; MAX_LINE];
        exact.push(b'\n');
        assert!(read_line(&mut Cursor::new(exact), &mut buf).unwrap(), "MAX_LINE bytes is allowed");
        assert_eq!(buf.len(), MAX_LINE);
        let over = vec![b'x'; MAX_LINE + 1];
        assert!(read_line(&mut Cursor::new(over), &mut buf).is_err(), "one more drops the connection");
    }

    #[test]
    fn only_json_objects_are_messages() {
        assert_eq!(parse_line(b"{\"type\":\"menu\"}"), Some(json!({ "type": "menu" })));
        for bad in [&b"[1,2]"[..], b"\"text\"", b"42", b"null", b"not json", b"", b"\xff\xfe{}"] {
            assert_eq!(parse_line(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_client_goes_through_the_same_gate_as_a_page() {
        for ty in ["auth_result", "auth", "authorize", "auth_password"] {
            assert_eq!(incoming(json!({ "type": ty, "id": "a1", "ok": true })), Incoming::Drop, "{ty}");
        }
        for ty in ["menu", "panel_open", "panel_key", "panel_money", "open_link", "copy_bind"] {
            let m = json!({ "type": ty, "x": 1 });
            assert_eq!(incoming(m.clone()), Incoming::Forward(m), "{ty}");
        }
        assert_eq!(incoming(json!({ "type": "panel_hide" })), Incoming::Hide);
        assert_eq!(incoming(json!({ "type": "hello", "client": "glyph" })), Incoming::Hello);
    }

    #[test]
    fn opening_goes_to_the_native_panel_only_while_one_is_connected() {
        for toggle in [false, true] {
            for open in [false, true] {
                assert_eq!(route(false, false, open, toggle), Route::Web, "no client: the web panel");
                assert_eq!(route(true, true, open, toggle), Route::Web, "ROAMIES_WEB_PANEL=1");
            }
        }
        assert_eq!(route(true, false, false, true), Route::Open);
        assert_eq!(route(true, false, false, false), Route::Open);
        assert_eq!(route(true, false, true, true), Route::Close, "a toggle closes it");
        assert_eq!(route(true, false, true, false), Route::Open, "an open only opens");
    }

    #[test]
    fn a_runtime_folder_that_isnt_private_is_refused() {
        // Ours but left open (glyph's bar makes it with mkdir -p): closed to others, then used.
        let s = Scratch::new("dir");
        let open = s.0.join("roamies");
        fs::DirBuilder::new().mode(0o755).create(&open).unwrap();
        fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(socket_dir(&s.0).is_ok(), "0755 and ours: used");
        assert_eq!(fs::metadata(&open).unwrap().permissions().mode() & 0o777, 0o700, "after it is closed to others");

        let s2 = Scratch::new("link");
        std::os::unix::fs::symlink(&s.0, s2.0.join("roamies")).unwrap();
        assert!(socket_dir(&s2.0).is_err(), "a symlink");

        let s3 = Scratch::new("ok");
        let dir = socket_dir(&s3.0).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700, "made private");
    }

    #[test]
    fn a_stale_socket_is_replaced_but_another_file_is_not() {
        let s = Scratch::new("bind");
        let (l, path) = bind(&s.0).unwrap();
        drop(l);
        assert!(path.exists(), "the old socket file is left behind");
        let (_l, path) = bind(&s.0).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

        let s2 = Scratch::new("file");
        fs::write(s2.0.join("panel.sock"), "x").unwrap();
        assert!(bind(&s2.0).is_err());
    }

    #[test]
    fn a_client_talks_to_the_shell_over_a_real_socket() {
        let s = Scratch::new("sock");
        let dir = socket_dir(&s.0).unwrap();
        let (listener, path) = bind(&dir).unwrap();
        let server: &'static Server = Box::leak(Box::new(Server::new()));
        let (tx, rx) = mpsc::channel::<Incoming>();
        let tx = Mutex::new(tx);
        let (gtx, grx) = mpsc::channel::<()>();
        let gtx = Mutex::new(gtx);
        let on_msg: Arc<dyn Fn(Incoming) + Send + Sync> = Arc::new(move |m| tx.lock().unwrap().send(m).unwrap());
        let on_gone: Arc<dyn Fn() + Send + Sync> = Arc::new(move || gtx.lock().unwrap().send(()).unwrap());
        thread::spawn(move || server.serve(listener, on_msg, on_gone));
        let wait = Duration::from_secs(5);

        let mut c = UnixStream::connect(&path).unwrap();
        c.write_all(b"{\"type\":\"hello\",\"client\":\"glyph\"}\nnot json\n[1]\n{\"type\":\"auth_result\",\"ok\":true}\n{\"type\":\"panel_open\"}\n").unwrap();
        assert_eq!(rx.recv_timeout(wait).unwrap(), Incoming::Hello);
        assert_eq!(rx.recv_timeout(wait).unwrap(), Incoming::Drop, "auth* never reaches the sidecar");
        assert_eq!(rx.recv_timeout(wait).unwrap(), Incoming::Forward(json!({ "type": "panel_open" })));
        assert!(server.connected());

        // Shell → client: a panel message, verbatim, one per line.
        let state = json!({ "kind": "state", "state": { "voice": true } });
        server.send(&state);
        server.send(&json!({ "kind": "close" }));
        let mut r = BufReader::new(c.try_clone().unwrap());
        r.get_ref().set_read_timeout(Some(wait)).unwrap();
        let mut buf = Vec::new();
        assert!(read_line(&mut r, &mut buf).unwrap());
        assert_eq!(parse_line(&buf), Some(state));
        assert!(read_line(&mut r, &mut buf).unwrap());
        assert_eq!(parse_line(&buf), Some(json!({ "kind": "close" })));

        // A second client replaces the first, whose stream is closed; that isn't "gone".
        let mut c2 = UnixStream::connect(&path).unwrap();
        assert!(!read_line(&mut r, &mut buf).unwrap(), "the first client's stream ends");
        c2.write_all(b"{\"type\":\"panel_hide\"}\n").unwrap();
        assert_eq!(rx.recv_timeout(wait).unwrap(), Incoming::Hide);
        assert!(grx.try_recv().is_err(), "a replaced client isn't the current one going");

        // An overlong line drops the connection: the client is gone.
        let big = vec![b'a'; MAX_LINE + 2];
        let _ = c2.write_all(&big);
        grx.recv_timeout(wait).expect("dropped");
        assert!(!server.connected());
        drop(c);
    }
}
