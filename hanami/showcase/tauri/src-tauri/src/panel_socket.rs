// Linux: a native panel (the glyph dotfiles' Quickshell one) talks to the shell over a Unix socket at
// $XDG_RUNTIME_DIR/roamies/panel.sock, in the same private 0700 folder auth.rs uses. One JSON object per line, both
// ways. Shell → client: every msg the web panel gets through window.__panel(msg), verbatim, plus {"kind":"open"} and
// {"kind":"close"}. Client → shell: what the web panel passes to sidecar_send, through the same page_may_send gate
// (never anything auth*), plus {"type":"panel_hide"} (it closed) and {"type":"hello"} (a greeting, not forwarded).
// One client at a time: a new connection replaces the old one. While one is connected (and ROAMIES_WEB_PANEL isn't
// 1), opening the panel opens it instead of the web panel (main.rs show_panel).
//
// The looks, drawn: a native panel can't run the drawing code, so it asks {"type":"panel_looks","form","looks":[ids]}
// (handled here, never forwarded) while it is open, and the sidekick's overlay draws each look at that size into a
// PNG of frames (roamies/looksheet.js: left to right in rows of `columns`) that comes back through the look_sheet
// command (main.rs). Each is written to $XDG_RUNTIME_DIR/roamies/looks/<look>-<form>-<n>.png (0600, the folder 0700,
// emptied of older sheets on the first one) and the client gets {"kind":"looks","form","sheets":[{id, file, frames,
// columns, fps, width, height}]} (one frame width × height px, at 2x). A sheet held with the same colours (its
// signature) isn't drawn again, only announced again.

use std::collections::HashMap;
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
use tauri::{AppHandle, Manager};

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
    /// The client wants these looks drawn at this size (panel_looks): the shell's own business, not the sidecar's.
    Looks { form: String, looks: Vec<String> },
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

/// What the settings panel sends (panel.js's send()): the only messages a client may pass to the sidecar. Any
/// other process of the user's could connect, so nothing else goes through, e.g. a forged spoken "sí" that would
/// answer an Allow / Don't allow question, a typed request, or a shell-only report.
const PANEL_TYPES: &[&str] = &["menu", "panel_open", "panel_key", "panel_fishkey", "panel_wake", "panel_mail_add", "panel_money", "open_link", "copy_bind"];

/// What a message from the client asks for: the panel's own messages only, and never authentication (main.rs
/// page_may_send, sidecar_send's gate, is kept as a second check).
pub(crate) fn incoming(msg: Value) -> Incoming {
    match msg.get("type").and_then(Value::as_str) {
        Some("panel_hide") => Incoming::Hide,
        Some("hello") => Incoming::Hello,
        Some("panel_looks") => looks_request(&msg).map_or(Incoming::Drop, |(form, looks)| Incoming::Looks { form, looks }),
        Some(t) if PANEL_TYPES.contains(&t) && crate::page_may_send(&msg) => Incoming::Forward(msg),
        _ => Incoming::Drop,
    }
}

/// The sizes a look is drawn at (the panel's Size picks).
pub(crate) const FORMS: &[&str] = &["default", "small", "cursor"];
/// The most looks one request may ask for.
pub(crate) const MAX_LOOKS: usize = 12;
/// The most sheets held at once: every look at every size. More new ids (the socket's client asks for them) would
/// keep adding files of up to MAX_PNG to the runtime folder, which is memory.
pub(crate) const MAX_HELD: usize = MAX_LOOKS * 3;
/// A sheet's limits: frames, frames a second, one frame's size in px, and the PNG's size.
pub(crate) const MAX_FRAMES: u32 = 120;
pub(crate) const MAX_FPS: u32 = 30;
pub(crate) const MAX_FRAME_PX: u32 = 512;
pub(crate) const MAX_PNG: usize = 4 << 20;

/// A look id as the app names them (classic, jarvis, anime…): it becomes part of a file name.
pub(crate) fn look_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=24).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

fn form_ok(form: &str) -> bool {
    FORMS.contains(&form)
}

/// A sheet's signature (looksheet.js lookSig: base 36).
fn sig_ok(sig: &str) -> bool {
    (1..=16).contains(&sig.len()) && sig.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// panel_looks: a size and 1..=MAX_LOOKS valid look ids (repeats dropped), or nothing.
pub(crate) fn looks_request(msg: &Value) -> Option<(String, Vec<String>)> {
    let form = msg.get("form")?.as_str().filter(|f| form_ok(f))?;
    let ids = msg.get("looks")?.as_array()?;
    if ids.is_empty() || ids.len() > MAX_LOOKS {
        return None;
    }
    let mut looks: Vec<String> = Vec::new();
    for id in ids {
        let id = id.as_str().filter(|i| look_id_ok(i))?;
        if !looks.iter().any(|l| l == id) {
            looks.push(id.to_owned());
        }
    }
    Some((form.to_owned(), looks))
}

/// Standard base64 (padding optional), as canvas.toDataURL gives it. None on anything else.
pub(crate) fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let body = text.trim_end_matches('=');
    if text.len() - body.len() > 2 || body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() / 4 * 3 + 2);
    for chunk in body.as_bytes().chunks(4) {
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c)? << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

/// A PNG's width and height (its IHDR), or None when it isn't one.
pub(crate) fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || b[..8] != *b"\x89PNG\r\n\x1a\n" || &b[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    Some((be(16), be(20)))
}

/// One sheet from the overlay (look_sheet's arguments). png: base64, or None when the shell holds it already.
#[derive(Debug, Clone)]
pub(crate) struct SheetIn {
    pub(crate) look: String,
    pub(crate) form: String,
    pub(crate) sig: String,
    pub(crate) frames: u32,
    pub(crate) columns: u32,
    pub(crate) fps: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) png: Option<String>,
}

/// The sheets written so far, by (look, form): their signature, file and what the client is told.
pub(crate) struct Sheets {
    held: Mutex<Option<HashMap<(String, String), (String, PathBuf, Value)>>>,
    seq: AtomicU64,
}

pub(crate) static SHEETS: Sheets = Sheets::new();

/// The sheets' folder: $XDG_RUNTIME_DIR/roamies/looks, private like the socket's (0700, ours).
pub(crate) fn looks_dir(base: &Path) -> io::Result<PathBuf> {
    let dir = socket_dir(base)?.join("looks");
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    crate::auth::own_private_dir(&dir)?;
    Ok(dir)
}

impl Sheets {
    pub(crate) const fn new() -> Sheets {
        Sheets { held: Mutex::new(None), seq: AtomicU64::new(0) }
    }

    /// The signature of each sheet held at this size, for the overlay: {look: sig}.
    pub(crate) fn have(&self, form: &str) -> Value {
        let held = self.held.lock().unwrap();
        let mut map = serde_json::Map::new();
        for ((l, f), (sig, _, _)) in held.iter().flatten() {
            if f == form {
                map.insert(l.clone(), Value::from(sig.clone()));
            }
        }
        Value::Object(map)
    }

    /// Checks one sheet and writes it into `base`'s looks folder (or, without a PNG, finds the one held with the same
    /// signature). Returns what the client is told about it.
    pub(crate) fn take(&self, base: &Path, s: SheetIn) -> Result<Value, String> {
        if !look_id_ok(&s.look) || !form_ok(&s.form) || !sig_ok(&s.sig) {
            return Err("bad look, size or signature".into());
        }
        if !(1..=MAX_FRAMES).contains(&s.frames) || !(1..=s.frames).contains(&s.columns) || !(1..=MAX_FPS).contains(&s.fps)
            || !(1..=MAX_FRAME_PX).contains(&s.width) || !(1..=MAX_FRAME_PX).contains(&s.height)
        {
            return Err("bad frames, rate or size".into());
        }
        let key = (s.look.clone(), s.form.clone());
        let mut held = self.held.lock().unwrap();
        let held = held.get_or_insert_with(HashMap::new);
        if s.png.is_some() && !held.contains_key(&key) && held.len() >= MAX_HELD {
            return Err("too many sheets".into());
        }
        let Some(b64) = s.png else {
            return match held.get(&key) {
                Some((sig, path, meta)) if *sig == s.sig && path.is_file() => Ok(meta.clone()),
                _ => Err("not held".into()),
            };
        };
        if b64.len() > MAX_PNG / 3 * 4 + 4 {
            return Err("sheet too big".into());
        }
        let png = base64_decode(&b64).ok_or("not base64")?;
        if png.len() > MAX_PNG {
            return Err("sheet too big".into());
        }
        if png_size(&png) != Some((s.width * s.columns, s.height * s.frames.div_ceil(s.columns))) {
            return Err("not a PNG of those frames".into());
        }
        let dir = looks_dir(base).map_err(|e| e.to_string())?;
        // The first sheet of this run: what an earlier run left is nobody's now.
        if held.is_empty() {
            for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                if e.file_name().to_string_lossy().ends_with(".png") {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let path = sheet_path(&dir, &s.look, &s.form, n);
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e| e.to_string())?;
            f.write_all(&png).map_err(|e| {
                let _ = fs::remove_file(&path);
                e.to_string()
            })?;
        }
        let meta = json!({
            "id": s.look, "file": path.to_string_lossy(), "frames": s.frames, "columns": s.columns, "fps": s.fps, "width": s.width, "height": s.height,
        });
        if let Some((_, old, _)) = held.insert(key, (s.sig, path, meta.clone())) {
            let _ = fs::remove_file(old);
        }
        Ok(meta)
    }
}

/// Where sheet number `n` of a look at a size goes: a new name each time, so the panel never shows an old one it
/// cached under the same name.
pub(crate) fn sheet_path(dir: &Path, look: &str, form: &str, n: u64) -> PathBuf {
    dir.join(format!("{look}-{form}-{n}.png"))
}

/// Asks the sidekick's overlay to draw these looks (looksheet.js __roamieLooks), passing the sheets already held.
fn ask_looks(app: &AppHandle, form: &str, looks: &[String]) {
    let Some(label) = crate::SIDEKICK_OVERLAY.lock().unwrap().clone() else { return };
    let Some(w) = app.get_webview_window(&label) else { return };
    let req = json!({ "form": form, "looks": looks, "have": SHEETS.have(form) });
    let _ = w.eval(format!("window.__roamieLooks&&__roamieLooks({req})"));
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
        // Drawn only while the panel shows, where they're seen.
        Incoming::Looks { form, looks } => {
            if SERVER.is_open() {
                ask_looks(&a, &form, &looks);
            }
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
        for ty in ["panel_fishkey", "panel_wake", "panel_mail_add"] {
            let m = json!({ "type": ty });
            assert_eq!(incoming(m.clone()), Incoming::Forward(m), "{ty}");
        }
        // Only the panel's own messages: not what the overlay, the voice helper or the shell report.
        for ty in ["voice", "cli", "user_click", "voice_state", "panel_closed", "answer", "AUTH_result", "ask"] {
            assert_eq!(incoming(json!({ "type": ty, "text": "sí" })), Incoming::Drop, "{ty}");
        }
        assert_eq!(incoming(json!({ "type": 7 })), Incoming::Drop, "a type that isn't text");
        assert_eq!(incoming(json!({ "type": "panel_hide" })), Incoming::Hide);
        assert_eq!(incoming(json!({ "type": "hello", "client": "glyph" })), Incoming::Hello);
    }

    #[test]
    fn asking_for_the_looks_is_the_shells_own_and_never_reaches_the_sidecar() {
        let m = json!({ "type": "panel_looks", "form": "small", "looks": ["classic", "anime", "classic", "ken"] });
        assert_eq!(
            incoming(m),
            Incoming::Looks { form: "small".into(), looks: vec!["classic".into(), "anime".into(), "ken".into()] },
            "repeats dropped"
        );
        let bad = [
            json!({ "type": "panel_looks", "form": "huge", "looks": ["classic"] }),
            json!({ "type": "panel_looks", "looks": ["classic"] }),
            json!({ "type": "panel_looks", "form": "default", "looks": [] }),
            json!({ "type": "panel_looks", "form": "default", "looks": "classic" }),
            json!({ "type": "panel_looks", "form": "default", "looks": ["../x"] }),
            json!({ "type": "panel_looks", "form": "default", "looks": ["Classic"] }),
            json!({ "type": "panel_looks", "form": "default", "looks": [7] }),
            json!({ "type": "panel_looks", "form": "default", "looks": vec!["a"; MAX_LOOKS + 1] }),
        ];
        for m in bad {
            assert_eq!(incoming(m.clone()), Incoming::Drop, "{m}");
        }
        for id in ["classic", "jarvis", "a", "x_1-b"] {
            assert!(look_id_ok(id), "{id}");
        }
        for id in ["", "1a", "-a", "a/b", "a.b", "a b", "ÁB", &"a".repeat(25)] {
            assert!(!look_id_ok(id), "{id}");
        }
    }

    #[test]
    fn base64_and_png_sizes_are_read() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("aGVsbG8").unwrap(), b"hello", "no padding");
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("+/8=").unwrap(), [0xfb, 0xff]);
        for bad in ["a", "aGVsbG8===", "aGV*bG8=", "aGV sbG8="] {
            assert_eq!(base64_decode(bad), None, "{bad}");
        }
        assert_eq!(png_size(&png(416, 152)), Some((416, 152)));
        assert_eq!(png_size(b"GIF89a................................"), None);
        assert_eq!(png_size(&png(1, 1)[..20]), None, "cut short");
    }

    /// The start of a PNG of w×h (signature and IHDR): what png_size reads.
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        b
    }

    fn b64(bytes: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in bytes.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..=c.len() {
                out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            }
        }
        out
    }

    fn sheet(look: &str, form: &str, sig: &str, png: Option<String>) -> SheetIn {
        SheetIn { look: look.into(), form: form.into(), sig: sig.into(), frames: 3, columns: 2, fps: 12, width: 208, height: 152, png }
    }

    #[test]
    fn a_sheet_is_checked_and_kept_privately_and_only_drawn_again_when_its_colours_change() {
        let s = Scratch::new("looks");
        let sheets = Sheets::new();
        // An earlier run's sheet is cleared on the first one.
        let dir = s.0.join("roamies").join("looks");
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).unwrap();
        fs::write(dir.join("classic-default-9.png"), "old").unwrap();
        // 3 frames in rows of 2: 2 × 2 frames of 208 × 152.
        let strip = b64(&png(416, 304));
        let meta = sheets.take(&s.0, sheet("anime", "small", "k1", Some(strip.clone()))).unwrap();
        let file = PathBuf::from(meta["file"].as_str().unwrap());
        assert!(!dir.join("classic-default-9.png").exists(), "an earlier run's sheet is gone");
        assert_eq!(file.parent(), Some(dir.as_path()), "inside the private folder");
        assert_eq!(file.file_name().unwrap().to_str().unwrap(), "anime-small-1.png");
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read(&file).unwrap(), png(416, 304));
        assert_eq!(meta, json!({ "id": "anime", "file": file.to_string_lossy(), "frames": 3, "columns": 2, "fps": 12, "width": 208, "height": 152 }));
        assert_eq!(sheets.have("small"), json!({ "anime": "k1" }));
        assert_eq!(sheets.have("default"), json!({}));

        // Held with the same colours: announced again without a PNG. Other colours: it needs one.
        assert_eq!(sheets.take(&s.0, sheet("anime", "small", "k1", None)).unwrap(), meta);

        // No more than MAX_HELD sheets: new ids past it are refused, one already held is still replaced.
        let (cap, many) = (Scratch::new("lookcap"), Sheets::new());
        for i in 0..MAX_HELD {
            many.take(&cap.0, sheet(&format!("l{i}"), "small", "k1", Some(strip.clone()))).unwrap();
        }
        assert!(many.take(&cap.0, sheet("onemore", "small", "k1", Some(strip.clone()))).is_err(), "past the cap");
        assert!(many.take(&cap.0, sheet("l0", "small", "k2", Some(strip.clone()))).is_ok(), "a held one is redrawn");
        assert_eq!(fs::read_dir(cap.0.join("roamies").join("looks")).unwrap().count(), MAX_HELD, "no more files than the cap");
        assert!(sheets.take(&s.0, sheet("anime", "small", "k2", None)).is_err());
        assert!(sheets.take(&s.0, sheet("sarah", "small", "k1", None)).is_err(), "never drawn");

        // Drawn again: a new file, and the old one goes.
        let again = sheets.take(&s.0, sheet("anime", "small", "k2", Some(strip.clone()))).unwrap();
        assert_ne!(again["file"], meta["file"]);
        assert!(!file.exists());
        assert_eq!(sheets.have("small"), json!({ "anime": "k2" }));

        // Refused: names that aren't looks or sizes, a PNG that isn't those frames, not a PNG, too big, bad limits.
        for bad in [
            sheet("../anime", "small", "k1", Some(strip.clone())),
            sheet("anime", "big", "k1", Some(strip.clone())),
            sheet("anime", "small", "K!", Some(strip.clone())),
            sheet("anime", "small", "k1", Some(b64(&png(624, 152)))),
            sheet("anime", "small", "k1", Some(b64(&png(416, 152)))),
            sheet("anime", "small", "k1", Some(b64(b"GIF89a, not a png at all, no"))),
            sheet("anime", "small", "k1", Some("not base64!".into())),
            sheet("anime", "small", "k1", Some("A".repeat(MAX_PNG / 3 * 4 + 8))),
            SheetIn { frames: MAX_FRAMES + 1, ..sheet("anime", "small", "k1", Some(strip.clone())) },
            SheetIn { columns: 0, ..sheet("anime", "small", "k1", Some(strip.clone())) },
            SheetIn { columns: 4, ..sheet("anime", "small", "k1", Some(strip.clone())) },
            SheetIn { fps: 0, ..sheet("anime", "small", "k1", Some(strip.clone())) },
            SheetIn { width: MAX_FRAME_PX + 1, ..sheet("anime", "small", "k1", Some(strip.clone())) },
        ] {
            assert!(sheets.take(&s.0, bad.clone()).is_err(), "{bad:?}");
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "nothing else written");

        // A looks folder that is a symlink is refused.
        let s2 = Scratch::new("looklink");
        fs::DirBuilder::new().mode(0o700).create(s2.0.join("roamies")).unwrap();
        std::os::unix::fs::symlink(&s.0, s2.0.join("roamies").join("looks")).unwrap();
        assert!(sheets.take(&s2.0, sheet("anime", "small", "k3", Some(strip))).is_err());
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
