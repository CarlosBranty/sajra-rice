// Linux: which kind of session this is, and the parts of the shell that are GTK, X11, Wayland or D-Bus underneath.
//
// A Wayland app can't place a window, keep it on top or see the cursor over other apps, and the overlay needs all
// three. There are two ways round that, chosen once in init(), before GTK starts (layer() says which):
//   - Wayland compositors with the layer-shell protocol (Hyprland, Sway and the others built on wlroots, KDE): GTK
//     runs on Wayland itself. Each overlay is a layer surface on the overlay layer, covering its monitor, and the
//     page's click areas are its input region; the panel is a layer surface too, and the setup guide an ordinary
//     window. The compositor places them, so nothing here moves or sizes them.
//   - everywhere else (X11 sessions, and Wayland without layer-shell, like GNOME, through XWayland): every window is
//     an X11 window. GTK is told to use X11 before it starts, and the code that places windows is the same as on the
//     other systems.
// What Wayland still takes away (the cursor over other apps, global shortcuts, grabbing the screen) is handled per
// feature below.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Session {
    X11,
    Wayland,
}

impl Session {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Session::X11 => "x11",
            Session::Wayland => "wayland",
        }
    }
}

/// Wayland when the session says so or a Wayland display is set (XWayland's DISPLAY is set there too, so it can't
/// decide). The voice helper uses the same rule (voice-win/src/keys.rs).
fn session_from(session_type: Option<&str>, wayland_display: Option<&str>) -> Session {
    let wayland = session_type.is_some_and(|s| s.eq_ignore_ascii_case("wayland")) || wayland_display.is_some_and(|s| !s.is_empty());
    if wayland { Session::Wayland } else { Session::X11 }
}

static SESSION: OnceLock<Session> = OnceLock::new();

pub(crate) fn session() -> Session {
    *SESSION.get().unwrap_or(&Session::X11)
}

/// Whether the windows are layer surfaces on Wayland itself: only on a Wayland session whose compositor offers
/// layer-shell (asked only when it matters). ROAMIES_LAYER_SHELL overrides the asking: 0 keeps the X11 windows,
/// 1 takes layer surfaces on any Wayland session; anything else decides nothing.
fn layer_from(session: Session, wanted: Option<&str>, offered: impl FnOnce() -> Option<bool>) -> bool {
    if session != Session::Wayland {
        return false;
    }
    match wanted.map(str::trim) {
        Some("0") => false,
        Some("1") => true,
        _ => offered() == Some(true),
    }
}

/// The compositor's socket: WAYLAND_DISPLAY when it is a whole path, else that name ("wayland-0" when there is
/// none) in XDG_RUNTIME_DIR.
fn wayland_socket(runtime_dir: Option<&str>, display: Option<&str>) -> Option<PathBuf> {
    let name = display.filter(|d| !d.is_empty()).unwrap_or("wayland-0");
    if name.starts_with('/') {
        return Some(PathBuf::from(name));
    }
    runtime_dir.filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name))
}

/// What a compositor has sent back so far to "list what you offer" (compositor_offers): Some(true) as soon as the
/// interface is in the list, Some(false) once the list is over without it, None while more is to come. Err when
/// the compositor reports an error or the bytes aren't Wayland messages.
fn registry_reply(buf: &[u8], interface: &str) -> Result<Option<bool>, ()> {
    let word = |at: usize| buf.get(at..at + 4).map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]));
    let mut at = 0;
    // Each message: the object it is from, then its size (the high half) and what it says (the low half).
    while let (Some(object), Some(head)) = (word(at), word(at + 4)) {
        let (size, opcode) = ((head >> 16) as usize, head & 0xffff);
        if size < 8 || size % 4 != 0 {
            return Err(());
        }
        let Some(msg) = buf.get(at..at + size) else { break };
        match (object, opcode) {
            // wl_display.error.
            (1, 0) => return Err(()),
            // wl_registry.global: a number, the interface's name (its length counts a closing zero), a version.
            (2, 0) => {
                let len = word(at + 12).ok_or(())? as usize;
                let name = msg.get(16..16 + len).and_then(|n| n.strip_suffix(&[0])).ok_or(())?;
                if name == interface.as_bytes() {
                    return Ok(Some(true));
                }
            }
            // wl_callback.done: everything asked before the sync has been answered.
            (3, 0) => return Ok(Some(false)),
            _ => {}
        }
        at += size;
    }
    Ok(None)
}

/// Asks the compositor behind this socket whether it offers an interface, without GTK (which isn't up yet, and
/// whose backend depends on the answer): the registry is asked for as object 2, then a sync as object 3 marks the
/// end of its list. None when it can't be asked or doesn't answer in time.
fn compositor_offers(socket: &Path, interface: &str) -> Option<bool> {
    use std::io::{Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(socket).ok()?;
    let wait = Some(Duration::from_millis(500));
    stream.set_read_timeout(wait).ok()?;
    stream.set_write_timeout(wait).ok()?;
    // wl_display (object 1): get_registry (1) and sync (0), each with the new object's id.
    let words: [u32; 6] = [1, 12 << 16 | 1, 2, 1, 12 << 16, 3];
    stream.write_all(&words.iter().flat_map(|w| w.to_ne_bytes()).collect::<Vec<u8>>()).ok()?;
    let (mut buf, mut chunk) = (Vec::new(), [0u8; 4096]);
    let until = Instant::now() + Duration::from_secs(2);
    // A compositor's list is a few kilobytes: one that goes on and on isn't one.
    while buf.len() < 256 * 1024 && Instant::now() < until {
        match stream.read(&mut chunk) {
            Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
            _ => return None,
        }
        if let Some(answer) = registry_reply(&buf, interface).ok()? {
            return Some(answer);
        }
    }
    None
}

static LAYER: OnceLock<bool> = OnceLock::new();

/// The windows are layer surfaces on Wayland itself (see the top of this file); false: X11 windows.
pub(crate) fn layer() -> bool {
    *LAYER.get().unwrap_or(&false)
}

/// First thing in main, before GTK starts and before any other thread exists.
pub(crate) fn init() {
    let env = |k: &str| std::env::var(k).ok();
    let s = session_from(env("XDG_SESSION_TYPE").as_deref(), env("WAYLAND_DISPLAY").as_deref());
    let _ = SESSION.set(s);
    let offered = || compositor_offers(&wayland_socket(env("XDG_RUNTIME_DIR").as_deref(), env("WAYLAND_DISPLAY").as_deref())?, "zwlr_layer_shell_v1");
    let layer = layer_from(s, env("ROAMIES_LAYER_SHELL").as_deref(), offered);
    let _ = LAYER.set(layer);
    if trace() {
        eprintln!("windows: {}", if layer { "layer surfaces on Wayland" } else { "X11" });
    }
    if layer {
        // Whatever the environment asks GTK for: the layer surfaces need Wayland itself.
        std::env::set_var("GDK_BACKEND", "wayland");
    } else if s == Session::Wayland {
        if env("DISPLAY").is_some_and(|d| !d.is_empty()) {
            std::env::set_var("GDK_BACKEND", "x11");
        } else {
            eprintln!("Roamies needs XWayland on a Wayland session (no DISPLAY is set): windows can't be placed or kept on top without it");
        }
    }
}

pub(crate) fn trace() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("ROAMIES_TRACE").is_some())
}

// ---------- a desktop bar that hosts the Roamie ----------

// A bar (Quickshell, Waybar, …) can keep a slot for the Roamie: it draws it resting there, and the Roamie comes out
// of the slot when it has something to do and goes back into it after. The two leave each other notes in
// $XDG_RUNTIME_DIR/roamies/ (gone at logout):
//   dock.json   from the bar: {"x": 1830, "y": 23, "sw": 2304, "sh": 1440, "mx": 0, "my": 0}, the slot's centre on a
//               screen sw × sh at (mx, my), all in that screen's logical px. With several screens it is the slot on
//               the one in use, written again when another comes into use: a layer surface goes there (dock_follow).
//   state.json  from Roamies: {"pid": 1234, "exe": "/usr/bin/roamies", "out": false, "keys": false, "t": 1794359725}.
//               out: the Roamie is on screen, so the slot is empty. keys: it is being typed to, so the keyboard is the
//               overlay's (when it isn't and the overlay still has the keyboard, the bar may hand it back). t: when this
//               was written (seconds); it is written again every couple of seconds (host.js), so an old one means
//               Roamies has gone.
//   theme.json  from the bar or shell, with or without a slot: {"light": true, "bg": "#f2e7de", "surface": "#ffffff",
//               "fg": "#100a05", "muted": "#786c61", "line": "#e4d6cb", "accent": "#9e6630", "danger": "#d71921"}, the
//               desktop's colours, used while Colors is on System (theme_note; showcase/roamies/theme.js).
// Nothing is written unless a bar left a dock.json.

fn dock_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()).map(|d| PathBuf::from(d).join("roamies"))
}

/// The slot in a bar's dock.json, or None when it isn't one: every number there, finite, and the slot on its screen.
fn dock_from(text: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(text).ok()?;
    let n = |k: &str| v.get(k).and_then(Value::as_f64).filter(|n| n.is_finite() && n.abs() < 100_000.0);
    let (x, y, sw, sh) = (n("x")?, n("y")?, n("sw")?, n("sh")?);
    if sw < 1.0 || sh < 1.0 || !(0.0..=sw).contains(&x) || !(0.0..=sh).contains(&y) {
        return None;
    }
    Some(json!({ "x": x, "y": y, "sw": sw, "sh": sh, "mx": n("mx").unwrap_or(0.0), "my": n("my").unwrap_or(0.0) }))
}

/// Whether the slot is on this screen ((x, y, w, h) in logical px): the only screen there is, or the one the bar
/// measured, give or take rounding.
fn dock_on(dock: &Value, screen: Option<(f64, f64, f64, f64)>, screens: usize) -> bool {
    if screens <= 1 {
        return true;
    }
    let Some((x, y, w, h)) = screen else { return false };
    let near = |k: &str, v: f64| dock[k].as_f64().is_some_and(|d| (d - v).abs() <= 2.0);
    near("mx", x) && near("my", y) && near("sw", w) && near("sh", h)
}

/// A screen as (x, y, w, h) in logical px, the units a bar measures in.
fn logical(m: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let (s, p, z) = (m.scale_factor(), m.position(), m.size());
    (p.x as f64 / s, p.y as f64 / s, z.width as f64 / s, z.height as f64 / s)
}

/// The slot in the bar's dock.json, when there is one and it is on this screen.
fn dock_read(screen: Option<(f64, f64, f64, f64)>, screens: usize) -> Option<Value> {
    let dock = dock_from(&std::fs::read_to_string(dock_dir()?.join("dock.json")).ok()?)?;
    dock_on(&dock, screen, screens).then_some(dock)
}

/// The bar's slot for the Roamie, when it is on this overlay's screen.
pub(crate) fn dock_get(window: &tauri::WebviewWindow) -> Option<Value> {
    // A layer surface: the screen it was handed to, which is known at once. Where the compositor has put a surface
    // that just went to another screen is heard a moment later, and the page asks right then (host.js).
    if layer() {
        let (tx, rx) = mpsc::channel();
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            let _ = tx.send(layer_screens(&w));
        });
        if let Ok(Some((Some(here), screens))) = rx.recv_timeout(Duration::from_millis(250)) {
            return dock_read(Some(screens[here]), screens.len());
        }
    }
    let screens = window.available_monitors().map(|m| m.len()).unwrap_or(1);
    dock_read(window.current_monitor().ok().flatten().as_ref().map(logical), screens)
}

/// How much of a screen's top and bottom the bar that keeps this slot takes, in px of an overlay `width` wide. The
/// slot is taken to sit in the middle of the bar's thickness, so the bar is twice as thick as the slot's centre is
/// far from the edge it runs along. A slot further in than that (a bar down a side) says nothing.
fn slot_insets(dock: &Value, width: f64) -> (f64, f64) {
    let n = |k: &str| dock[k].as_f64().unwrap_or(0.0);
    let (y, sw, sh) = (n("y"), n("sw"), n("sh"));
    if sw < 1.0 {
        return (0.0, 0.0);
    }
    let (top, thick) = (y < sh / 2.0, 2.0 * y.min(sh - y));
    match thick <= sh / 4.0 {
        true if top => (thick * width / sw, 0.0),
        true => (0.0, thick * width / sw),
        false => (0.0, 0.0),
    }
}

/// Layer surfaces: what a bar takes of this screen's top and bottom, in the overlay's px. Wayland doesn't tell an
/// app which part of a screen is free, so only a bar that left its slot (dock.json) is known about.
pub(crate) fn layer_insets(app: &AppHandle, mon: &tauri::Monitor) -> (f64, f64) {
    let screens = app.available_monitors().map(|m| m.len()).unwrap_or(1);
    let screen = logical(mon);
    dock_read(Some(screen), screens).map_or((0.0, 0.0), |d| slot_insets(&d, screen.2))
}

/// The desktop's colours in a theme.json, or None when it isn't one: `light` has to be true or false. Of the colours
/// only those written exactly "#rrggbb" are kept (a page puts them in its styles); nothing else in the file is passed on.
fn theme_from(text: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(text).ok()?;
    let mut note = serde_json::Map::new();
    note.insert("light".into(), Value::Bool(v.get("light")?.as_bool()?));
    let hex = |c: &&str| c.len() == 7 && c.starts_with('#') && c.bytes().skip(1).all(|b| b.is_ascii_hexdigit());
    for k in ["bg", "surface", "fg", "muted", "line", "accent", "danger"] {
        if let Some(c) = v.get(k).and_then(Value::as_str).filter(hex) {
            note.insert(k.into(), Value::String(c.to_ascii_lowercase()));
        }
    }
    Some(Value::Object(note))
}

/// The colour note the desktop's bar or shell left, when there is one that makes sense. Read each time it's asked for
/// (every couple of seconds while Colors is on System), so a desktop changing its colours shows by itself.
pub(crate) fn theme_note() -> Option<Value> {
    theme_from(&std::fs::read_to_string(dock_dir()?.join("theme.json")).ok()?)
}

/// What the bar reads back: this copy of Roamies, whether the Roamie is out of its slot, and whether it is being
/// typed to (keys).
fn dock_note(out: bool, keys: bool, exe: &str, now: u64) -> String {
    json!({ "pid": std::process::id(), "exe": exe, "out": out, "keys": keys, "t": now }).to_string()
}

static DOCK_OUT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static DOCK_KEYS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Tells the bar whether the Roamie is out of its slot. Only for a bar that asked (it left a dock.json).
pub(crate) fn dock_state(out: bool) {
    DOCK_OUT.store(out, std::sync::atomic::Ordering::Relaxed);
    dock_write();
}

/// Tells the bar whether the overlay wants the keyboard (something is being typed to the Roamie). A tiling
/// compositor leaves the keyboard with the overlay after the typing is over, where nothing can be typed any more:
/// the bar knows its compositor and can hand it back to the window that had it.
pub(crate) fn dock_keys(on: bool) {
    DOCK_KEYS.store(on, std::sync::atomic::Ordering::Relaxed);
    dock_write();
}

/// A bar keeps a slot for the Roamie (it left a dock.json), so it is there to hand the keyboard over and back.
pub(crate) fn dock_hosted() -> bool {
    dock_dir().is_some_and(|d| d.join("dock.json").is_file())
}

/// Something is still being typed to the Roamie.
pub(crate) fn dock_wants_keys() -> bool {
    DOCK_KEYS.load(std::sync::atomic::Ordering::Relaxed)
}

// What says something of the Roamie's is on screen in the sidekick's overlay. As a layer surface the overlay goes
// to the screen in use (dock_follow), but never from under any of it. UP: its page holds Esc (the Roamie, a bubble,
// a question, a drawing, a take, a voice: main.rs esc_watch). HITS: it has click areas (a card left on screen holds
// no Esc). DOCK_OUT: the Roamie is somewhere between leaving its slot and being back in it (the page of a layer
// surface says so with or without a slot on its screen). STARTED: something just began there, which the page
// takes a moment to say.
static SIDEKICK_UP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SIDEKICK_HITS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SIDEKICK_STARTED: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) fn sidekick_up(on: bool) {
    SIDEKICK_UP.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn sidekick_hits(any: bool) {
    SIDEKICK_HITS.store(any, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn sidekick_started() {
    *SIDEKICK_STARTED.lock().unwrap() = Some(Instant::now());
}

fn sidekick_busy() -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    let started = SIDEKICK_STARTED.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(1));
    SIDEKICK_UP.load(Relaxed) || SIDEKICK_HITS.load(Relaxed) || DOCK_OUT.load(Relaxed) || started
}

fn dock_write() {
    let (out, keys) = (DOCK_OUT.load(std::sync::atomic::Ordering::Relaxed), DOCK_KEYS.load(std::sync::atomic::Ordering::Relaxed));
    let Some(dir) = dock_dir() else { return };
    if !dir.join("dock.json").is_file() {
        return;
    }
    // The AppImage's own path when run from one (the program inside it lives in a mount that goes away).
    let exe = std::env::var("APPIMAGE").ok().filter(|p| !p.is_empty()).or_else(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())).unwrap_or_default();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Written in place, in one go: a bar watching the file sees the change (a rename would lose its watch).
    let _ = std::fs::write(dir.join("state.json"), dock_note(out, keys, &exe, now));
}

// ---------- click-through by region ----------

/// The page's click areas ([x, y, w, h, …] in CSS px) as whole-pixel rectangles: bad numbers and empty ones are
/// dropped, and a runaway list is cut off (a shape with thousands of pieces helps nobody).
fn hit_rects(flat: &[f64]) -> Vec<(i32, i32, i32, i32)> {
    const MAX: usize = 600;
    const LIMIT: f64 = 100_000.0;
    flat.chunks_exact(4)
        .filter(|r| r.iter().all(|v| v.is_finite() && v.abs() < LIMIT) && r[2] >= 1.0 && r[3] >= 1.0)
        .map(|r| (r[0].floor() as i32, r[1].floor() as i32, r[2].ceil() as i32, r[3].ceil() as i32))
        .take(MAX)
        .collect()
}

/// Makes the rectangles the overlay's input shape: clicks land on them and pass through everywhere else. No cursor
/// tracking is involved, so it works on Wayland too, where the cursor can't be seen over other apps.
pub(crate) fn set_hit_rects(window: &tauri::WebviewWindow, flat: &[f64]) {
    let rects = hit_rects(flat);
    // ROAMIES_TRACE=1: the shape goes to stderr, for checking click-through from outside (and for bug reports).
    if trace() {
        eprintln!("hit rects: {rects:?}");
    }
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(top) = w.gtk_window() else { return };
        apply_hit_rects(&top, &rects);
        HITS.with(|hits| hits.borrow_mut().insert(w.label().to_owned(), (Instant::now(), rects, top)));
        watch_whole();
    });
}

/// The input shape itself, on the main thread.
fn apply_hit_rects(top: &gtk::ApplicationWindow, rects: &[(i32, i32, i32, i32)]) {
    use gtk::cairo::{RectangleInt, Region};
    use gtk::prelude::WidgetExt;
    // GDK works in the same logical pixels as the page.
    let list: Vec<RectangleInt> = rects.iter().map(|&(x, y, w, h)| RectangleInt::new(x, y, w, h)).collect();
    let region = Region::create_rectangles(&list);
    if layer() {
        // Through GTK, which keeps the region and puts it back whenever it works out the window's own shape again
        // (given to GDK alone it is lost then, and the whole surface takes clicks). GDK sends it to the compositor
        // with the window's next frame, so one is asked for (a pixel of it): after a Roamie has left nothing
        // draws any more, and its last click areas would stay.
        top.input_shape_combine_region(Some(&region));
        top.queue_draw_area(0, 0, 1, 1);
        return;
    }
    let Some(win) = top.window() else { return };
    win.input_shape_combine_region(&region, 0, 0);
    // No compositor (a bare X11 window manager): the transparent parts would draw black over the whole screen,
    // so the window is cut down to the same rectangles.
    if !win.screen().is_composited() {
        win.shape_combine_region(Some(&region), 0, 0);
    }
}

thread_local! {
    // Each overlay's click areas as its page last sent them, when, and its window (main thread only).
    static HITS: std::cell::RefCell<std::collections::HashMap<String, (Instant, Vec<(i32, i32, i32, i32)>, gtk::ApplicationWindow)>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// A click area over the whole overlay (a question holding the keyboard, the pen drawing with the mouse: host.js)
/// that its page hasn't sent again for this long is dropped. The page sends its areas every couple of seconds while
/// they stay the same, so one that stopped (hung, died, or loading again) can't keep every click on the desktop.
const WHOLE_STALE: Duration = Duration::from_secs(5);

/// The click areas to keep for an overlay of `size` whose page sent `rects` `age` ago: None while they stand (sent
/// lately, or none covers the whole overlay); otherwise the same without the ones that cover it all, so the Roamie's
/// own areas stay.
fn stale_whole(rects: &[(i32, i32, i32, i32)], size: (i32, i32), age: Duration) -> Option<Vec<(i32, i32, i32, i32)>> {
    let whole = |r: &(i32, i32, i32, i32)| r.0 <= 0 && r.1 <= 0 && r.0 + r.2 >= size.0 && r.1 + r.3 >= size.1;
    if age < WHOLE_STALE || size.0 <= 0 || size.1 <= 0 || !rects.iter().any(whole) {
        return None;
    }
    Some(rects.iter().filter(|r| !whole(r)).copied().collect())
}

/// Looks every second for a whole-overlay click area its page stopped sending (stale_whole), once started. Main
/// thread only.
fn watch_whole() {
    use gtk::prelude::WidgetExt;
    thread_local!(static ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    if ON.with(|on| on.replace(true)) {
        return;
    }
    gtk::glib::timeout_add_local(Duration::from_secs(1), || {
        HITS.with(|hits| {
            for (label, (at, rects, top)) in hits.borrow_mut().iter_mut() {
                let Some(kept) = stale_whole(rects, (top.allocated_width(), top.allocated_height()), at.elapsed()) else { continue };
                eprintln!("hit rects: {label}'s page stopped sending its whole-overlay click area, dropped it: {kept:?}");
                apply_hit_rects(top, &kept);
                *rects = kept;
            }
        });
        gtk::glib::ControlFlow::Continue
    });
}

// ---------- layer surfaces (Wayland compositors with layer-shell) ----------

/// Which of the screens ((x, y, w, h) in logical px) is the one at this place, give or take rounding.
fn monitor_at(all: &[(i32, i32, i32, i32)], want: (f64, f64, f64, f64)) -> Option<usize> {
    let near = |a: i32, b: f64| (a as f64 - b).abs() <= 2.0;
    all.iter().position(|&(x, y, w, h)| near(x, want.0) && near(y, want.1) && near(w, want.2) && near(h, want.3))
}

/// Layer surfaces, one overlay for several screens: which of `screens` ((x, y, w, h) in logical px) the overlay
/// should go to from the one it is on (`here`), or None: it stays. The bar writes its note from the screen in use
/// and again when another comes into use, so the overlay goes where the note is: only to a screen the note really
/// names (no note, one that isn't a note or names no screen here: it stays), and never while something of the
/// Roamie's is on screen (`busy`).
fn dock_move(note: Option<&str>, here: Option<usize>, screens: &[(f64, f64, f64, f64)], busy: bool) -> Option<usize> {
    if busy || screens.len() <= 1 {
        return None;
    }
    let dock = dock_from(note?)?;
    let to = screens.iter().position(|&s| dock_on(&dock, Some(s), screens.len()))?;
    (Some(to) != here).then_some(to)
}

/// Every screen as GDK has it ((x, y, w, h) in logical px, the units a bar measures in), and which of them an
/// overlay's layer surface was handed to (None: the compositor chose). Main thread only.
fn layer_screens(window: &tauri::WebviewWindow) -> Option<(Option<usize>, Vec<(f64, f64, f64, f64)>)> {
    use gtk::prelude::*;
    use gtk_layer_shell::LayerShell;
    let display = gtk::gdk::Display::default()?;
    let all: Vec<gtk::gdk::Monitor> = (0..display.n_monitors()).filter_map(|i| display.monitor(i)).collect();
    let on = window.gtk_window().ok()?.monitor();
    let here = all.iter().position(|m| Some(m) == on.as_ref());
    Some((here, all.iter().map(|m| m.geometry()).map(|g| (g.x() as f64, g.y() as f64, g.width() as f64, g.height() as f64)).collect()))
}

/// Layer surfaces: where the sidekick's overlay should go now (dock_move), as the middle of that screen in global
/// logical px, which is what main.rs's move_sidekick_to takes there. None: it stays. Main thread only.
pub(crate) fn dock_follow(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    if !layer() {
        return None;
    }
    let note = std::fs::read_to_string(dock_dir()?.join("dock.json")).ok();
    let (here, screens) = layer_screens(window)?;
    let (x, y, w, h) = screens[dock_move(note.as_deref(), here, &screens, sidekick_busy())?];
    if trace() {
        eprintln!("screen in use: {w}x{h} at {x},{y}; the overlay was on {:?}", here.map(|i| screens[i]));
    }
    Some((x + w / 2.0, y + h / 2.0))
}

/// GDK's monitor for one of Tauri's: the same screen, found by where it is. Main thread only.
fn gdk_monitor(mon: &tauri::Monitor) -> Option<gtk::gdk::Monitor> {
    use gtk::prelude::*;
    let display = gtk::gdk::Display::default()?;
    let all: Vec<gtk::gdk::Monitor> = (0..display.n_monitors()).filter_map(|i| display.monitor(i)).collect();
    let places: Vec<(i32, i32, i32, i32)> = all.iter().map(|m| m.geometry()).map(|g| (g.x(), g.y(), g.width(), g.height())).collect();
    monitor_at(&places, logical(mon)).map(|i| all[i].clone())
}

/// Makes an overlay the layer surface over its monitor and shows it. The window comes hidden from Tauri's builder,
/// so not yet realized: gtk-layer-shell has to get it before that. It goes on the overlay layer (above bars and
/// fullscreen windows; no tile, no workspace), anchored to all four edges and over the whole monitor whatever bars
/// have reserved (exclusive zone -1): the page's coordinates are the monitor's. It never has the keyboard by itself
/// (layer_keys) and lets every click through until the page says where its click areas are (set_hit_rects).
/// Main thread only.
pub(crate) fn layer_overlay(window: &tauri::WebviewWindow, mon: &tauri::Monitor) {
    use gtk::prelude::*;
    use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
    let Ok(win) = window.gtk_window() else { return };
    win.init_layer_shell();
    win.set_layer(Layer::Overlay);
    win.set_namespace("roamies");
    for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
        win.set_anchor(edge, true);
    }
    win.set_exclusive_zone(-1);
    win.set_keyboard_mode(KeyboardMode::None);
    if let Some(m) = gdk_monitor(mon) {
        win.set_monitor(&m);
    }
    win.input_shape_combine_region(Some(&gtk::cairo::Region::create()));
    win.show_all();
}

/// Moves an overlay's layer surface to another monitor. Main thread only.
pub(crate) fn layer_move(window: &tauri::WebviewWindow, mon: &tauri::Monitor) {
    use gtk::prelude::*;
    use gtk_layer_shell::LayerShell;
    if let (Ok(win), Some(m)) = (window.gtk_window(), gdk_monitor(mon)) {
        // An unresizable GTK window keeps its size when the compositor configures a smaller screen, so it may resize
        // for the move. Only then: while it is resizable Tauri's edge handler takes presses near the screen's edges
        // for a resize (a click on the bar would never reach the page). Moves happen only while nothing of the
        // Roamie's takes clicks (dock_move's busy rule, or a drawing's move before it is played).
        // Being resizable is not enough by itself: GTK keeps the size it was built with (the first screen's), so a
        // smaller screen got a surface as big as the old one and the Roamie, placed by the old width, was drawn past
        // its right edge. It is asked for the new screen's size outright.
        let g = m.geometry();
        win.set_resizable(true);
        win.set_default_size(g.width(), g.height());
        win.resize(g.width(), g.height());
        win.set_monitor(&m);
        let w = win.clone();
        gtk::glib::timeout_add_local_once(Duration::from_millis(600), move || w.set_resizable(false));
    }
}

/// An overlay asks for the keyboard while something is being typed to the Roamie and gives it up after, or sooner
/// when a click lands anywhere else (host.js letGo: every key there is would be held from the user otherwise). The
/// compositor hands it over and, after, back to the window that had it; nothing is focused from here, so the
/// pointer stays where it is. Exclusive, not on demand: a surface that asks on demand gets the keyboard only when
/// it is clicked (measured on Hyprland 0.57), and a question opened from a key or by the Roamie itself would sit
/// there unable to be typed into.
pub(crate) fn layer_keys(window: &tauri::WebviewWindow, on: bool) {
    use gtk_layer_shell::{KeyboardMode, LayerShell};
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(win) = w.gtk_window() {
            win.set_keyboard_mode(if on { KeyboardMode::Exclusive } else { KeyboardMode::None });
        }
    });
}

/// The pointer has been over the panel since it was last opened (layer surfaces only).
static PANEL_ENTERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Makes the panel a layer surface (the first time, while it is still hidden) of this size in logical px, in the top
/// right corner of the screen in use, and readies it for opening. The compositor keeps it clear of bars, so the gaps
/// are from the free area's edges, where place_panel puts it on X11. It asks for the keyboard on demand: it has it
/// when it opens and when it is clicked, and loses it to a click elsewhere, which is what closes it. Main thread only.
pub(crate) fn layer_panel(window: &tauri::WebviewWindow, width: i32, height: i32) {
    use gtk::prelude::*;
    use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
    let Ok(win) = window.gtk_window() else { return };
    if !win.is_layer_window() {
        win.init_layer_shell();
        win.set_layer(Layer::Overlay);
        win.set_namespace("roamies-panel");
        win.set_anchor(Edge::Top, true);
        win.set_anchor(Edge::Right, true);
        win.set_layer_shell_margin(Edge::Top, 6);
        win.set_layer_shell_margin(Edge::Right, 8);
        win.set_keyboard_mode(KeyboardMode::OnDemand);
        // The page fills the window, so the pointer's coming is its widget's to see.
        let page = win.child().and_then(|c| c.downcast::<gtk::Container>().ok()).and_then(|c| c.children().into_iter().next());
        if let Some(page) = page {
            page.connect_enter_notify_event(|_, _| {
                PANEL_ENTERED.store(true, std::sync::atomic::Ordering::Relaxed);
                gtk::glib::Propagation::Proceed
            });
        }
    }
    PANEL_ENTERED.store(false, std::sync::atomic::Ordering::Relaxed);
    win.set_size_request(width, height);
}

/// Whether the panel losing the keyboard closes it. Where the keyboard follows the pointer (Hyprland and Sway as
/// they come), a panel opened from a key or the tray loses it as soon as the pointer moves over the window it
/// happens to be on, before it ever gets to the panel: that doesn't count. Once the pointer has been in the panel,
/// losing the keyboard means the user went elsewhere.
pub(crate) fn layer_panel_left() -> bool {
    PANEL_ENTERED.load(std::sync::atomic::Ordering::Relaxed)
}

/// The pointer while it is over an overlay: that overlay's label and the place in it, in its px. Wayland tells an
/// app where the pointer is only over its own surfaces, so None everywhere else (and over the panel). Main thread
/// only.
fn pointer_now(app: &AppHandle) -> Option<(String, f64, f64)> {
    use gtk::prelude::*;
    let pointer = gtk::gdk::Display::default()?.default_seat()?.pointer()?;
    let under = pointer.window_at_position().0?.toplevel();
    let (label, _) = app.webview_windows().into_iter().find(|(l, w)| crate::is_overlay(l) && w.gtk_window().ok().and_then(|g| g.window()).as_ref() == Some(&under))?;
    let (_, x, y, _) = under.device_position_double(&pointer);
    Some((label, x, y))
}

/// pointer_now, from any thread.
pub(crate) fn layer_pointer(app: &AppHandle) -> Option<(String, f64, f64)> {
    let (tx, rx) = mpsc::channel();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(pointer_now(&app2));
    })
    .ok()?;
    rx.recv_timeout(Duration::from_millis(250)).ok().flatten()
}

// ---------- the pointer (X11 sessions) ----------

/// Whether the left mouse button is down right now, anywhere on screen: a drawing waiting for a click polls it.
/// X11 sessions only. On Wayland the pointer can't be seen over other apps, and the sidecar asks for no such waits.
pub(crate) fn left_button_down() -> bool {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;
    use x11rb::rust_connection::RustConnection;
    static X: OnceLock<Option<(RustConnection, u32)>> = OnceLock::new();
    if session() != Session::X11 {
        return false;
    }
    let Some((conn, root)) = X
        .get_or_init(|| {
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            Some((conn, root))
        })
        .as_ref()
    else {
        return false;
    };
    // Button1 in the pointer's button and modifier state.
    conn.query_pointer(*root).ok().and_then(|c| c.reply().ok()).is_some_and(|r| u16::from(r.mask) & 0x100 != 0)
}

// ---------- screenshots ----------

/// Claude's own cap on a picture's long side: a bigger one is shrunk again on its way and its coordinates drift.
const SHOT_MAX: i32 = 1568;

/// A picture's size shrunk to fit `max` on its long side (never enlarged).
fn fit(w: i32, h: i32, max: i32) -> (i32, i32) {
    let long = w.max(h);
    if long <= max || long <= 0 {
        return (w, h);
    }
    let k = max as f64 / long as f64;
    (((w as f64 * k).round() as i32).max(1), ((h as f64 * k).round() as i32).max(1))
}

/// The rectangle round every screen, from each one's [x, y, w, h].
fn union_bounds(screens: &[[f64; 4]]) -> [f64; 4] {
    let Some(first) = screens.first() else { return [0.0; 4] };
    let (mut x0, mut y0, mut x1, mut y1) = (first[0], first[1], first[0] + first[2], first[1] + first[3]);
    for s in &screens[1..] {
        x0 = x0.min(s[0]);
        y0 = y0.min(s[1]);
        x1 = x1.max(s[0] + s[2]);
        y1 = y1.max(s[1] + s[3]);
    }
    [x0, y0, x1 - x0, y1 - y0]
}

/// The whole desktop in the overlay's points (the units of safe_js's origin): what a screenshot covers, so the
/// sidecar can turn a pixel of the picture into a place on screen.
fn desktop_bounds(app: &AppHandle) -> [f64; 4] {
    let screens: Vec<[f64; 4]> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            [m.position().x as f64 / s, m.position().y as f64 / s, m.size().width as f64 / s, m.size().height as f64 / s]
        })
        .collect();
    union_bounds(&screens)
}

/// The screen the sidekick's overlay is on, [x, y, w, h] in desktop_bounds's points: the one in use, since the
/// overlay follows it (the cursor, or the bar's note for a layer surface). None when it can't be told. Main thread
/// only.
fn sidekick_screen(app: &AppHandle) -> Option<[f64; 4]> {
    let label = crate::SIDEKICK_OVERLAY.lock().unwrap().clone()?;
    let window = app.get_webview_window(&label)?;
    // A layer surface: the screen it was handed to (the source dock_get goes by).
    let handed = if layer() { layer_screens(&window).and_then(|(here, screens)| Some(screens[here?])) } else { None };
    let (x, y, w, h) = handed.or_else(|| window.current_monitor().ok().flatten().as_ref().map(logical))?;
    Some([x, y, w, h])
}

/// A capture of the whole desktop, cut down to one screen: the pixels to keep as (x, y, w, h), and the part of the
/// desktop they show (that screen, or as much of it as is on the desktop). `capture` is the picture's size in
/// pixels, `desktop` what it shows and `screen` the screen wanted, both [x, y, w, h] in the same points. One scale
/// for the whole picture: its width in pixels over the desktop's in points; edges go to the nearest pixel. None when
/// there is nothing to cut (the screen is the whole desktop) or no telling where the screen is in the picture (it
/// isn't the desktop's shape, the screen is nowhere on it, a size makes no sense): the picture then stays whole.
fn shot_crop(capture: (i32, i32), desktop: [f64; 4], screen: [f64; 4]) -> Option<((i32, i32, i32, i32), [f64; 4])> {
    let [dx, dy, dw, dh] = desktop;
    let sizes = [capture.0 as f64, capture.1 as f64, dw, dh, screen[2], screen[3]];
    if !sizes.iter().all(|v| v.is_finite() && *v > 0.0) || ![dx, dy, screen[0], screen[1]].iter().all(|v| v.is_finite()) {
        return None;
    }
    let k = capture.0 as f64 / dw;
    // The same tolerance as the sidecar's shotFits, which refuses to point by a picture of another shape.
    if (k / (capture.1 as f64 / dh) - 1.0).abs() > 0.02 {
        return None;
    }
    let (x0, y0) = (screen[0].max(dx), screen[1].max(dy));
    let (x1, y1) = ((screen[0] + screen[2]).min(dx + dw), (screen[1] + screen[3]).min(dy + dh));
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let px = |v: f64, max: i32| ((v * k).round() as i32).clamp(0, max);
    let (left, top, right, bottom) = (px(x0 - dx, capture.0), px(y0 - dy, capture.1), px(x1 - dx, capture.0), px(y1 - dy, capture.1));
    if right <= left || bottom <= top || (left, top, right, bottom) == (0, 0, capture.0, capture.1) {
        return None;
    }
    Some(((left, top, right - left, bottom - top), [x0, y0, x1 - x0, y1 - y0]))
}

/// Where the desktop portal will answer a request made with this token: the caller's bus name (":1.42") without
/// its colon and with dots as underscores, then the token.
fn portal_request_path(unique_name: &str, token: &str) -> String {
    format!("/org/freedesktop/portal/desktop/request/{}/{token}", unique_name.trim_start_matches(':').replace('.', "_"))
}

/// The file a file:// link names (the portal answers with one), percent-escapes undone. None for anything else.
fn file_uri_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    // An empty host or "localhost", then an absolute path.
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return None;
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(a), Some(b)) => {
                out.push((a * 16 + b) as u8);
                i += 3;
            }
            (c, _, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok().map(PathBuf::from)
}

/// Shrinks the picture to Claude's cap and writes it as a JPEG. Returns its final size in pixels.
fn save_fitted(shot: &gtk::gdk_pixbuf::Pixbuf, file: &str) -> Result<(i32, i32), String> {
    save_fitted_as(shot, file, "jpeg")
}

/// save_fitted as a "jpeg" or a "png" (an area snap, which the sidecar sends on as a PNG, as the helpers save theirs).
fn save_fitted_as(shot: &gtk::gdk_pixbuf::Pixbuf, file: &str, kind: &str) -> Result<(i32, i32), String> {
    let (w, h) = fit(shot.width(), shot.height(), SHOT_MAX);
    let out = if (w, h) == (shot.width(), shot.height()) { Some(shot.clone()) } else { shot.scale_simple(w, h, gtk::gdk_pixbuf::InterpType::Bilinear) };
    let out = out.ok_or("the screenshot couldn't be resized")?;
    let options: &[(&str, &str)] = if kind == "jpeg" { &[("quality", "85")] } else { &[] };
    out.savev(file, kind, options).map_err(|e| e.to_string())?;
    Ok((w, h))
}

/// A screenshot as the sidecar gets it: its size in pixels, the part of the desktop it shows (in desktop_bounds's
/// points), and whether that is one screen of several rather than the whole desktop.
#[derive(Debug, PartialEq)]
struct Shot {
    pixels: (i32, i32),
    bounds: [f64; 4],
    screen: bool,
}

/// Saves a capture of the whole desktop for the sidecar: cut down to `screen` when that is one screen of several
/// (shot_crop), then shrunk to Claude's cap (save_fitted), so the screen in use gets all the pixels there are to
/// give instead of sharing them with the others. Both ways of capturing end here.
fn save_shot(capture: &gtk::gdk_pixbuf::Pixbuf, file: &str, desktop: [f64; 4], screen: Option<[f64; 4]>) -> Result<Shot, String> {
    let crop = screen.and_then(|s| shot_crop((capture.width(), capture.height()), desktop, s));
    let (pixels, bounds) = match crop {
        Some(((x, y, w, h), bounds)) => (save_fitted(&capture.new_subpixbuf(x, y, w, h), file)?, bounds),
        None => (save_fitted(capture, file)?, desktop),
    };
    if trace() {
        eprintln!("screenshot: captured {}x{}, kept {crop:?}, sent {}x{} for {bounds:?}", capture.width(), capture.height(), pixels.0, pixels.1);
    }
    Ok(Shot { pixels, bounds, screen: crop.is_some() })
}

/// Debug builds: ROAMIES_SHOT_DIR=<dir> keeps a copy of every screenshot handed to the sidecar there, with a .json
/// beside it saying what the sidecar was told (pixels, bounds, of), to look at what the agent sees. `roamies --shot`
/// (shot_probe) takes one without asking the agent anything. They show the user's screen: nothing is kept unless
/// the variable names a folder, and release builds have none of this.
#[cfg(debug_assertions)]
fn shot_dir() -> Option<PathBuf> {
    std::env::var_os("ROAMIES_SHOT_DIR").filter(|d| !d.is_empty()).map(PathBuf::from)
}

#[cfg(debug_assertions)]
fn shot_keep(dir: &Path, file: &str, shot: &Shot) {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let stem = format!("shot-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let note = json!({ "pixels": [shot.pixels.0, shot.pixels.1], "bounds": shot.bounds, "of": if shot.screen { "screen" } else { "desktop" } });
    let kept = std::fs::create_dir_all(dir).and_then(|_| std::fs::copy(file, dir.join(format!("{stem}.jpg")))).and_then(|_| std::fs::write(dir.join(format!("{stem}.json")), note.to_string()));
    match kept {
        Ok(()) => eprintln!("screenshot kept: {} {note}", dir.join(format!("{stem}.jpg")).display()),
        Err(e) => eprintln!("screenshot not kept in {}: {e}", dir.display()),
    }
}

/// Debug builds, `roamies --shot` to the running app: the screenshot the agent would get right now, into
/// ROAMIES_SHOT_DIR and nowhere else (the sidecar hears nothing). Main thread only.
#[cfg(debug_assertions)]
pub(crate) fn shot_probe(app: &AppHandle) {
    let Some(dir) = shot_dir() else { return eprintln!("--shot: start Roamies with ROAMIES_SHOT_DIR=<dir> first") };
    let file = dir.join(format!(".probe-{}.jpg", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let made = file.clone();
    capture(app, file.to_string_lossy().into_owned(), move |_, r| {
        // capture kept its copy already; this one was only somewhere to save to.
        let _ = std::fs::remove_file(&made);
        if let Err(e) = r {
            eprintln!("--shot: {e}");
        }
    });
}

/// X11: the root window holds the whole screen as the user sees it. Main thread only.
fn grab_root() -> Result<gtk::gdk_pixbuf::Pixbuf, String> {
    use gtk::gdk::prelude::WindowExtManual;
    let root = gtk::gdk::Window::default_root_window();
    root.pixbuf(0, 0, root.width(), root.height()).ok_or_else(|| "the X server didn't hand over the screen".to_string())
}

/// Wayland: only the desktop's own portal may read the screen. It writes a picture and answers with a link to
/// it; some desktops ask the user first, each time or once.
fn portal_screenshot() -> Result<PathBuf, String> {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as V};
    static N: AtomicU32 = AtomicU32::new(0);
    const NO_PORTAL: &str = "This desktop has no screenshot portal (install xdg-desktop-portal and the one for your desktop, e.g. xdg-desktop-portal-gnome, -kde or -wlr).";
    let err = |e: zbus::Error| e.to_string();
    let conn = Connection::session().map_err(err)?;
    let token = format!("roamies_{}_{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
    let me = conn.unique_name().map(|n| n.to_string()).ok_or("no session bus name")?;
    // Listen for the answer before asking, so a quick one isn't missed.
    let request = Proxy::new(&conn, "org.freedesktop.portal.Desktop", portal_request_path(&me, &token), "org.freedesktop.portal.Request").map_err(err)?;
    let mut answers = request.receive_signal("Response").map_err(err)?;
    let portal = Proxy::new(&conn, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot").map_err(err)?;
    let mut options: HashMap<&str, V> = HashMap::new();
    options.insert("handle_token", V::from(token.as_str()));
    options.insert("interactive", V::from(false));
    options.insert("modal", V::from(false));
    let _handle: OwnedObjectPath = portal.call("Screenshot", &("", options)).map_err(|e| match e {
        zbus::Error::MethodError(..) | zbus::Error::InterfaceNotFound => NO_PORTAL.to_string(),
        e => format!("{NO_PORTAL} ({e})"),
    })?;
    // The answer can take as long as the user takes with the desktop's "allow this?" dialog.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(answers.next());
    });
    let msg = rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "The desktop didn't answer the screenshot request.".to_string())?.ok_or("The screenshot request was dropped.")?;
    let (code, results): (u32, HashMap<String, OwnedValue>) = msg.body().deserialize().map_err(err)?;
    if code != 0 {
        return Err(if code == 1 { "The screenshot wasn't allowed (the desktop asked, and the answer was no).".into() } else { "The desktop couldn't take the screenshot.".into() });
    }
    let uri = results.get("uri").and_then(|v| v.downcast_ref::<&str>().ok()).ok_or("the portal sent no picture")?;
    file_uri_path(uri).ok_or_else(|| "the portal sent a link that isn't a file".to_string())
}

/// Overlays go clear for a moment so the Roamie isn't in its own screenshot (macOS and Windows leave them out of
/// captures instead). Main thread only.
fn fade_overlays(app: &AppHandle, opacity: f64) {
    use gtk::prelude::WidgetExt;
    for (label, w) in app.webview_windows() {
        if crate::is_overlay(&label) {
            if let Ok(g) = w.gtk_window() {
                g.set_opacity(opacity);
            }
        }
    }
}

/// Takes a screenshot into `file` (a JPEG, shrunk to Claude's cap): the screen the sidekick's overlay is on, or the
/// whole desktop when that is the only screen or can't be told. `then` hears how it went, on the main thread. Main
/// thread only.
fn capture(app: &AppHandle, file: String, then: impl FnOnce(&AppHandle, Result<Shot, String>) + Send + 'static) {
    // Asked now, while this is the main thread: the Wayland capture below runs on another.
    let (desktop, screen) = (desktop_bounds(app), sidekick_screen(app));
    #[cfg(debug_assertions)]
    let then = {
        let file = file.clone();
        move |app: &AppHandle, r: Result<Shot, String>| {
            if let (Some(dir), Ok(shot)) = (shot_dir(), &r) {
                shot_keep(&dir, &file, shot);
            }
            then(app, r);
        }
    };
    fade_overlays(app, 0.0);
    let app = app.clone();
    if session() == Session::X11 {
        gtk::glib::timeout_add_local_once(CLEAR, move || {
            let shot = grab_root();
            fade_overlays(&app, 1.0);
            then(&app, shot.and_then(|p| save_shot(&p, &file, desktop, screen)));
        });
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR);
        let shot = portal_screenshot();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || fade_overlays(&app2, 1.0));
        let r = shot.and_then(|path| load_portal_file(&path)).and_then(|p| save_shot(&p, &file, desktop, screen));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || then(&app2, r));
    });
}

/// What the sidecar is told about a screenshot: its size in pixels and the part of the desktop it covers (in the
/// overlay's points), `of: "screen"` when that is one screen of several, or what went wrong.
fn shot_reply(id: &Value, r: Result<Shot, String>) -> Value {
    match r {
        Ok(Shot { pixels: (w, h), bounds, screen: true }) => json!({ "type": "screenshot_done", "id": id, "ok": true, "pixels": [w, h], "bounds": bounds, "of": "screen" }),
        Ok(Shot { pixels: (w, h), bounds, screen: false }) => json!({ "type": "screenshot_done", "id": id, "ok": true, "pixels": [w, h], "bounds": bounds }),
        Err(e) => json!({ "type": "screenshot_done", "id": id, "ok": false, "error": e }),
    }
}

/// The sidecar's take_screenshot: the screen in use into `file` (capture), answered with screenshot_done
/// (shot_reply). Main thread only.
pub(crate) fn screenshot(app: &AppHandle, id: Value, file: String) {
    capture(app, file, move |app, r| crate::to_sidecar(app, &shot_reply(&id, r)));
}

fn remove_portal_file(path: &Path) {
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
}

/// The portal's picture, loaded. The portal keeps its picture (in Pictures, on most desktops): this one was only for
/// the question asked, so it goes.
fn load_portal_file(path: &Path) -> Result<gtk::gdk_pixbuf::Pixbuf, String> {
    let loaded = gtk::gdk_pixbuf::Pixbuf::from_file(path).map_err(|e| e.to_string());
    remove_portal_file(path);
    loaded
}

/// Long enough for the compositor to draw a frame without the overlays (or without slurp's layer, once it has gone).
const CLEAR: Duration = Duration::from_millis(150);

// ---------- Ask About an Area (Wayland: slurp) ----------
// macOS and Windows drag the area with the hands helper's `select`. On Wayland only a layer surface can take the
// pointer over the whole screen, so slurp does it (the area picker people pair with grim, on Hyprland, Sway and the
// others built on wlroots, and KDE): it prints the rectangle in the compositor's global logical points, which are
// desktop_bounds's. The picture is then cut out of a screenshot of the whole desktop the way the screen in use is
// (shot_crop), so where the area is and what the picture shows agree. `roamies --snap`, the tray menu and the panel
// start it (the sidecar's areaSnap); the sidecar offers it only with slurp there (platform.mjs canSnap).

/// The format slurp is asked for: x, y, width and height, nothing else.
const SLURP_FORMAT: &str = "%x %y %w %h";

/// How long slurp waits for the user: someone who walked away gets their screen back, and nothing is asked.
const AREA_WAIT: Duration = Duration::from_secs(180);

/// slurp on PATH, looked for once. None: Ask About an Area stays off.
pub(crate) fn slurp() -> Option<PathBuf> {
    static SLURP: OnceLock<Option<PathBuf>> = OnceLock::new();
    SLURP.get_or_init(|| on_path("slurp", std::env::var_os("PATH").as_deref())).clone()
}

/// The first `name` in a PATH's folders that is a file that may be run.
fn on_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path?).map(|dir| dir.join(name)).find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// What slurp said, asked for SLURP_FORMAT: the area as [x, y, w, h] in global logical points (below zero on a
/// screen left of or above the main one), or None when nothing was picked: Esc, or a click without a drag, ends slurp
/// with an error, "selection cancelled" and nothing printed; an area with no size is nothing to ask about either.
/// Anything else (no layer surfaces on this desktop, an answer that isn't four numbers) is an error, worded for the user.
fn slurp_area(ok: bool, stdout: &str, stderr: &str) -> Result<Option<[f64; 4]>, String> {
    let (out, why) = (stdout.trim(), stderr.trim());
    if !ok {
        if out.is_empty() && (why.is_empty() || why.contains("cancelled")) {
            return Ok(None);
        }
        return Err(format!("Couldn't pick an area: {}", why.lines().last().unwrap_or("slurp failed")));
    }
    let garbled = || format!("Couldn't pick an area: slurp answered {out:?}");
    let n: Vec<f64> = out.split_whitespace().map(str::parse).collect::<Result<_, _>>().map_err(|_| garbled())?;
    match n[..] {
        [x, y, w, h] if n.iter().all(|v| v.is_finite()) => Ok((w > 0.0 && h > 0.0).then_some([x, y, w, h])),
        _ => Err(garbled()),
    }
}

/// Runs a command that waits on the user, for `wait` at most: what it printed and how it ended, or None when the time
/// ran out (it is killed then). Not on the main thread.
fn output_within(mut cmd: Command, wait: Duration) -> Result<Option<std::process::Output>, String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let until = Instant::now() + wait;
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    child.wait_with_output().map(Some).map_err(|e| e.to_string())
}

/// The pixels of a picture of the whole desktop that show `area`, and the part of the desktop they show: shot_crop,
/// and the whole picture when the area is all of the desktop (where shot_crop has nothing to cut). None when the
/// area is nowhere on the desktop or the picture isn't the desktop's shape (so where the area is in it can't be told).
fn area_crop(capture: (i32, i32), desktop: [f64; 4], area: [f64; 4]) -> Option<((i32, i32, i32, i32), [f64; 4])> {
    shot_crop(capture, desktop, area).or_else(|| {
        let [dx, dy, dw, dh] = desktop;
        let (cw, ch) = (capture.0 as f64, capture.1 as f64);
        let shaped = cw > 0.0 && ch > 0.0 && dw > 0.0 && dh > 0.0 && ((cw / dw) / (ch / dh) - 1.0).abs() <= 0.02;
        let all = area[0] <= dx && area[1] <= dy && area[0] + area[2] >= dx + dw && area[1] + area[3] >= dy + dh;
        (shaped && all).then_some(((0, 0, capture.0, capture.1), desktop))
    })
}

/// Saves the area's part of a picture of the whole desktop to `file`, a PNG shrunk to Claude's cap: its size in
/// pixels and where it is (bounds, in desktop_bounds's points).
fn save_area(capture: &gtk::gdk_pixbuf::Pixbuf, file: &str, desktop: [f64; 4], area: [f64; 4]) -> Result<Shot, String> {
    let ((x, y, w, h), bounds) = area_crop((capture.width(), capture.height()), desktop, area).ok_or("The area picked isn't on the screenshot.")?;
    let pixels = save_fitted_as(&capture.new_subpixbuf(x, y, w, h), file, "png")?;
    if trace() {
        eprintln!("area: captured {}x{}, kept {:?}, sent {}x{} for {bounds:?}", capture.width(), capture.height(), (x, y, w, h), pixels.0, pixels.1);
    }
    Ok(Shot { pixels, bounds, screen: false })
}

/// What the sidecar is told about an area: its picture's size in pixels and where it is, that none was picked
/// (cancelled), or what went wrong.
fn area_reply(id: &Value, r: Result<Option<Shot>, String>) -> Value {
    match r {
        Ok(Some(Shot { pixels: (w, h), bounds, .. })) => json!({ "type": "area_done", "id": id, "ok": true, "pixels": [w, h], "bounds": bounds }),
        Ok(None) => json!({ "type": "area_done", "id": id, "ok": false, "cancelled": true }),
        Err(e) => json!({ "type": "area_done", "id": id, "ok": false, "error": e }),
    }
}

/// The sidecar's area snap on Wayland: the user drags a rectangle with slurp, and that part of the screen goes into
/// `file` (save_area), answered with area_done (area_reply). The overlays go clear first and stay so until the
/// screenshot is taken: the user picks from the screen as the picture will show it, nothing of the Roamie's is in
/// the picture, and slurp's own layer surface, opened after the overlay's on the same layer, is above it and takes the
/// pointer and keys. Main thread only.
pub(crate) fn area(app: &AppHandle, id: Value, file: String) {
    let Some(bin) = slurp().filter(|_| session() == Session::Wayland) else {
        return crate::to_sidecar(app, &area_reply(&id, Err("Asking about an area needs slurp, on a Wayland desktop.".into())));
    };
    let desktop = desktop_bounds(app);
    fade_overlays(app, 0.0);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut cmd = Command::new(&bin);
        cmd.args(["-f", SLURP_FORMAT]);
        let picked = output_within(cmd, AREA_WAIT).map_err(|e| format!("Couldn't start slurp ({e}).")).and_then(|out| match out {
            Some(o) => slurp_area(o.status.success(), &String::from_utf8_lossy(&o.stdout), &String::from_utf8_lossy(&o.stderr)),
            None => Ok(None),
        });
        let r = picked.and_then(|area| match area {
            Some(area) => {
                // slurp's dimmed layer off the screen before it is captured.
                std::thread::sleep(CLEAR);
                portal_screenshot().and_then(|path| load_portal_file(&path)).and_then(|p| save_area(&p, &file, desktop, area)).map(Some)
            }
            None => Ok(None),
        });
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            fade_overlays(&app2, 1.0);
            crate::to_sidecar(&app2, &area_reply(&id, r));
        });
    });
}

// ---------- the pen with the mouse (layer surfaces) ----------
// macOS and Windows: while the talk keys are held the voice helper follows the cursor and draws its trail, and when
// the take ends it sends the marked part of the screen with the words (`area`: a PNG with the strokes drawn on it, its
// rect and the strokes; voice-win/src/ink.rs). On Wayland nothing follows the cursor over other apps, but a layer
// surface gets the pointer wherever its input region is: while a take is heard the page makes that all of the
// overlay and draws with the mouse (host.js, pen.js), handing each stroke here (pen_add). When the helper says what
// was heard, the part of the screen round the strokes goes with it in the helper's own shape (pen_area, from
// voice.rs), so the sidecar takes it exactly as it takes the helper's.

/// At most this many strokes in a take (the sidecar words eight), of at most this many points each.
const PEN_STROKES: usize = 8;
const PEN_POINTS: usize = 4000;
/// The pen's radius in points (pen.js, voice-win/src/ink.rs).
const PEN: f64 = 2.8;

/// The strokes drawn in the take being heard, in global points.
static PEN_LOOPS: Mutex<Vec<Vec<(f64, f64)>>> = Mutex::new(Vec::new());

/// A stroke as the page sends it ([x, y, …] in global points): its points, or None when none makes sense.
fn pen_stroke(flat: &[f64]) -> Option<Vec<(f64, f64)>> {
    let pts: Vec<(f64, f64)> = flat.chunks_exact(2).filter(|p| p.iter().all(|v| v.is_finite() && v.abs() < 100_000.0)).map(|p| (p[0], p[1])).take(PEN_POINTS).collect();
    (!pts.is_empty()).then_some(pts)
}

/// A stroke drawn with the mouse in the take being heard (the page's pen_stroke). Layer surfaces only.
pub(crate) fn pen_add(flat: &[f64]) {
    let Some(stroke) = pen_stroke(flat).filter(|_| layer()) else { return };
    let mut loops = PEN_LOOPS.lock().unwrap();
    if loops.len() < PEN_STROKES {
        loops.push(stroke);
    }
}

/// A take starts: nothing drawn before it goes with its words.
pub(crate) fn pen_clear() {
    PEN_LOOPS.lock().unwrap().clear();
}

/// The take's strokes, taken (none: nothing was drawn).
pub(crate) fn pen_take() -> Vec<Vec<(f64, f64)>> {
    std::mem::take(&mut *PEN_LOOPS.lock().unwrap())
}

/// The part of the screen to send for these strokes, [x, y, w, h] in whole points: round them with 48 points to spare,
/// at least 320×220, and on their screen (`screen`, the same). The helper's capture_box.
fn pen_box(loops: &[Vec<(f64, f64)>], screen: [f64; 4]) -> Option<[f64; 4]> {
    let pts: Vec<&(f64, f64)> = loops.iter().flatten().collect();
    if pts.is_empty() {
        return None;
    }
    let (mut x0, mut x1) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.0), a.1.max(p.0)));
    let (mut y0, mut y1) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
    (x0, y0, x1, y1) = (x0 - 48.0, y0 - 48.0, x1 + 48.0, y1 + 48.0);
    if x1 - x0 < 320.0 {
        let d = (320.0 - (x1 - x0)) / 2.0;
        (x0, x1) = (x0 - d, x1 + d);
    }
    if y1 - y0 < 220.0 {
        let d = (220.0 - (y1 - y0)) / 2.0;
        (y0, y1) = (y0 - d, y1 + d);
    }
    let [sx, sy, sw, sh] = screen;
    let (x0, y0, x1, y1) = (x0.max(sx).floor(), y0.max(sy).floor(), x1.min(sx + sw).ceil(), y1.min(sy + sh).ceil());
    (x1 > x0 && y1 > y0).then_some([x0, y0, x1 - x0, y1 - y0])
}

/// The strokes as the sidecar gets them: at most 48 points each (plus the last), whole points. The helper's marks.
fn pen_marks(loops: &[Vec<(f64, f64)>]) -> Vec<Vec<[i64; 2]>> {
    loops.iter().map(|s| {
        let step = (s.len() / 48).max(1);
        let mut picked: Vec<(f64, f64)> = s.iter().step_by(step).copied().collect();
        if let (Some(&l), Some(&p)) = (s.last(), picked.last()) {
            if l != p {
                picked.push(l);
            }
        }
        picked.iter().map(|p| [p.0.round() as i64, p.1.round() as i64]).collect()
    }).collect()
}

/// The strokes (in the picture's pixels) drawn onto a picture's bytes (`stride` per row, `n` per pixel, RGB first) as
/// the helper draws them (voice-win/src/ink.rs draw_strokes): the pen's teal over a dark edge, smooth at the rim. Each
/// pixel is covered by its nearest segment, looked for only round each segment, so long strokes stay quick. Plain
/// bytes rather than cairo, whose GDK half wants the main thread.
fn draw_strokes(px: &mut [u8], (w, h, stride, n): (usize, usize, usize, usize), strokes: &[Vec<(f64, f64)>], r: f64) {
    let mut pass = |rad: f64, c: [f64; 3], alpha: f64| {
        let mut cover = vec![0f32; w * h];
        let span = |lo: f64, hi: f64, max: usize| ((lo - rad - 1.0).floor().clamp(0.0, max as f64) as usize, (hi + rad + 2.0).ceil().clamp(0.0, max as f64) as usize);
        for s in strokes.iter().filter(|s| !s.is_empty()) {
            for k in 0..s.len() {
                let (a, b) = (s[k], s[(k + 1).min(s.len() - 1)]);
                let ((x0, x1), (y0, y1)) = (span(a.0.min(b.0), a.0.max(b.0), w), span(a.1.min(b.1), a.1.max(b.1), h));
                let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                let len2 = dx * dx + dy * dy;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let (qx, qy) = (x as f64 + 0.5, y as f64 + 0.5);
                        let t = if len2 > 0.0 { (((qx - a.0) * dx + (qy - a.1) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
                        let d = (qx - a.0 - t * dx).hypot(qy - a.1 - t * dy);
                        let c = (rad + 0.5 - d).clamp(0.0, 1.0) as f32;
                        let at = &mut cover[y * w + x];
                        *at = at.max(c);
                    }
                }
            }
        }
        for y in 0..h {
            for x in 0..w {
                let a = cover[y * w + x] as f64 * alpha;
                if a <= 0.0 {
                    continue;
                }
                let i = y * stride + x * n;
                for k in 0..3 {
                    px[i + k] = (px[i + k] as f64 * (1.0 - a) + c[k] * a).round() as u8;
                }
            }
        }
    };
    pass(r + 1.25 * r / PEN, [3.0, 39.0, 34.0], 0.6);
    pass(r, [120.0, 255.0, 226.0], 1.0);
}

/// A picture with the strokes (in its pixels) drawn on it (draw_strokes).
fn draw_pen(pic: &gtk::gdk_pixbuf::Pixbuf, strokes: &[Vec<(f64, f64)>], r: f64) -> Result<gtk::gdk_pixbuf::Pixbuf, String> {
    use gtk::gdk_pixbuf::Pixbuf;
    let pic = pic.copy().ok_or("the marked picture couldn't be made")?;
    let (w, h, stride, n) = (pic.width(), pic.height(), pic.rowstride(), pic.n_channels());
    if pic.bits_per_sample() != 8 || n < 3 {
        return Err("the screenshot isn't in a form that can be drawn on".into());
    }
    let mut px = pic.read_pixel_bytes().to_vec();
    draw_strokes(&mut px, (w as usize, h as usize, stride as usize, n as usize), strokes, r);
    Ok(Pixbuf::from_bytes(&gtk::glib::Bytes::from_owned(px), pic.colorspace(), pic.has_alpha(), 8, w, h, stride))
}

/// Saves `area`'s part of a picture of the whole desktop to `file` with the strokes (global points) drawn on it, a PNG
/// shrunk to Claude's cap: the part of the desktop it shows (area_crop).
fn save_marked(capture: &gtk::gdk_pixbuf::Pixbuf, file: &str, desktop: [f64; 4], area: [f64; 4], loops: &[Vec<(f64, f64)>]) -> Result<[f64; 4], String> {
    let ((x, y, w, h), bounds) = area_crop((capture.width(), capture.height()), desktop, area).ok_or("The marked area isn't on the screenshot.")?;
    let k = w as f64 / bounds[2];
    let strokes: Vec<Vec<(f64, f64)>> = loops.iter().map(|s| s.iter().map(|p| ((p.0 - bounds[0]) * k, (p.1 - bounds[1]) * k)).collect()).collect();
    let marked = draw_pen(&capture.new_subpixbuf(x, y, w, h), &strokes, PEN * k)?;
    let pixels = save_fitted_as(&marked, file, "png")?;
    if trace() {
        eprintln!("pen: captured {}x{}, kept {:?}, sent {}x{} for {bounds:?}", capture.width(), capture.height(), (x, y, w, h), pixels.0, pixels.1);
    }
    Ok(bounds)
}

/// The helper's `area`: the picture, the part of the screen it shows and the strokes, in whole global points.
fn pen_reply(file: &str, bounds: [f64; 4], loops: &[Vec<(f64, f64)>]) -> Value {
    json!({ "file": file, "rect": bounds.map(|v| v.round() as i64), "strokes": pen_marks(loops) })
}

/// The part of the screen marked with the mouse in a take, captured as a screenshot is (the overlays clear, the portal)
/// with the strokes drawn on it: `then` hears the helper's `area` (pen_reply), or null when nothing could be captured,
/// on the main thread. Main thread only.
pub(crate) fn pen_area(app: &AppHandle, loops: Vec<Vec<(f64, f64)>>, then: impl FnOnce(&AppHandle, Value) + Send + 'static) {
    let desktop = desktop_bounds(app);
    let screen = sidekick_screen(app).unwrap_or(desktop);
    let Some(area) = pen_box(&loops, screen) else { return then(app, Value::Null) };
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let file = std::env::temp_dir().join(format!("sidekick-marked-{ms}.png")).to_string_lossy().into_owned();
    fade_overlays(app, 0.0);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR);
        let shot = portal_screenshot();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || fade_overlays(&app2, 1.0));
        let marked = match shot.and_then(|path| load_portal_file(&path)).and_then(|p| save_marked(&p, &file, desktop, area, &loops)) {
            Ok(bounds) => pen_reply(&file, bounds, &loops),
            Err(e) => {
                eprintln!("pen: the marked area wasn't captured: {e}");
                Value::Null
            }
        };
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || then(&app2, marked));
    });
}

// ---------- clipboard ----------

/// Copies text through GTK (no xclip or wl-copy needed; from X11 windows XWayland hands it on to Wayland apps, and
/// with layer surfaces GTK sets the Wayland selection itself). Main thread only.
pub(crate) fn set_clipboard(text: &str) {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard.set_text(text);
    clipboard.store();
}

// ---------- Open at Login, updates ----------

/// The AppImage this copy runs from (the AppImage runtime sets APPIMAGE to the file), if it is one.
pub(crate) fn appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file())
}

/// A program path as one quoted argument of a desktop entry's Exec line. Inside the quotes, `"`, `` ` ``, `$` and
/// `\` take a backslash, and every backslash is doubled again because Exec is a string value; `%` starts a field
/// code, so it's doubled too. None for a path a desktop entry can't hold (a line break).
fn exec_quoted(path: &str) -> Option<String> {
    if path.is_empty() || path.contains(['\n', '\r']) {
        return None;
    }
    let mut out = String::from("\"");
    for c in path.chars() {
        match c {
            '"' | '`' | '$' => {
                out.push_str("\\\\");
                out.push(c);
            }
            '\\' => out.push_str("\\\\\\\\"),
            '%' => out.push_str("%%"),
            c => out.push(c),
        }
    }
    out.push('"');
    Some(out)
}

/// The XDG autostart entry that starts Roamies when the user logs in.
fn autostart_entry(program: &str) -> Option<String> {
    let exec = exec_quoted(program)?;
    Some(format!("[Desktop Entry]\nType=Application\nName=Roamies\nComment=AI desktop companions\nExec={exec}\nIcon=roamies\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"))
}

/// Whether an autostart entry is switched on: desktops' own "startup apps" settings switch one off by adding
/// Hidden=true (or GNOME's own key) rather than deleting it.
fn autostart_on(entry: &str) -> bool {
    !entry.lines().map(|l| l.trim().to_ascii_lowercase().replace(' ', "")).any(|l| l == "hidden=true" || l == "x-gnome-autostart-enabled=false")
}

fn autostart_file() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("autostart").join("roamies.desktop"))
}

/// Open at Login: an entry in ~/.config/autostart, which GNOME, KDE and the other XDG desktops all run. It starts
/// the AppImage file when this is one (its inner binary lives in a mount that's gone after it quits), else this
/// binary. `set`: None just reports. Returns (supported, on).
pub(crate) fn login_item(set: Option<bool>, installed: bool) -> (bool, bool) {
    let program = appimage().or_else(|| std::env::current_exe().ok());
    let (Some(file), Some(entry)) = (autostart_file(), program.and_then(|p| autostart_entry(&p.to_string_lossy()))) else { return (false, false) };
    if !installed {
        return (false, false);
    }
    match set {
        Some(true) => {
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Err(e) = std::fs::write(&file, entry) {
                eprintln!("open at login: {e}");
            }
        }
        Some(false) => {
            let _ = std::fs::remove_file(&file);
        }
        None => {}
    }
    (true, std::fs::read_to_string(&file).is_ok_and(|e| autostart_on(&e)))
}

/// The program as a shell word, for commands people bind to keys (`<this> --talk`): plain `roamies` when that's
/// what the package installed on PATH, else the AppImage or binary's full path, single-quoted if it needs it.
fn launch_word(program: &str) -> String {
    if program == "/usr/bin/roamies" || program == "/usr/local/bin/roamies" {
        return "roamies".into();
    }
    if program.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) {
        return program.into();
    }
    format!("'{}'", program.replace('\'', "'\\''"))
}

pub(crate) fn launch_command() -> String {
    let program = appimage().or_else(|| std::env::current_exe().ok()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "roamies".into());
    launch_word(&program)
}

/// Where a copy installed from a .deb or .rpm gets its update: the package manager owns those files, so the app
/// can't swap itself as an AppImage can.
pub(crate) fn open_releases_page() {
    let _ = std::process::Command::new("xdg-open").arg("https://github.com/KenKaiii/Roamies/releases/latest").stdin(std::process::Stdio::null()).spawn();
}

// ---------- other apps' sound ----------

// With the Voice page's switch on, every other app's sound goes down while Roamies listens (the microphone hears the
// user, not the music) and while it speaks a reply, and comes back after. It goes through `pactl`, which talks to
// PulseAudio and to PipeWire's pulse server alike: each app's playback stream (a "sink input") is set to a percentage
// of the volume it has at that moment. What each one had is kept in $XDG_RUNTIME_DIR/roamies/duck.json for as long
// as it is down: {"streams": [{"index": 419, "pid": 1281, "volumes": [65536, 65536]}]}. A note still there at start
// means Roamies went away with the volumes down, so they go back up then. With the switch off pactl is never run.

/// A playback stream as `pactl -f json list sink-inputs` lists it: its index, the process that plays it (None for a
/// stream no app owns: a filter chain's output, a loopback) and each channel's volume in channel order (65536 is 100 %).
#[derive(Clone, PartialEq, Debug)]
struct Stream {
    index: u32,
    pid: Option<u32>,
    volumes: Vec<u32>,
}

/// The streams in pactl's listing, or None when it isn't one (no sound server, or a pactl too old to write JSON).
/// A stream whose volumes can't be read is left out, so it's left alone.
fn streams_from(text: &str) -> Option<Vec<Stream>> {
    let list: Value = serde_json::from_str(text).ok()?;
    let streams = list.as_array()?.iter().filter_map(|s| {
        let index = u32::try_from(s.get("index")?.as_u64()?).ok()?;
        let volume = s.get("volume")?.as_object()?;
        // By the channel map, which is the order volumes are set in (the listing's own order isn't kept on reading).
        let volumes: Vec<u32> = s.get("channel_map")?.as_str()?.split(',').map(|ch| volume.get(ch)?.get("value")?.as_u64().and_then(|v| u32::try_from(v).ok())).collect::<Option<_>>()?;
        let pid = s.pointer("/properties/application.process.id").and_then(Value::as_str).and_then(|p| p.parse().ok());
        (volumes.len() == volume.len()).then_some(Stream { index, pid, volumes })
    });
    Some(streams.collect())
}

/// The parent's pid in a /proc/<pid>/stat line. The program's name comes before it in brackets and may hold spaces
/// and brackets of its own, so the fields are counted from the last bracket.
fn stat_ppid(stat: &str) -> Option<u32> {
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

/// Whether a process is Roamies or one it started, however far down (the webview's processes play the voice and the
/// sound effects). `parent` gives a process's parent.
fn is_own(pid: u32, me: u32, parent: impl Fn(u32) -> Option<u32>) -> bool {
    let mut p = pid;
    // No process tree is this deep: the cap is for a table that changes while it's being read.
    for _ in 0..64 {
        if p == me {
            return true;
        }
        match parent(p) {
            Some(up) if up != 0 && up != p => p = up,
            _ => return false,
        }
    }
    false
}

/// A level that lowers anything: 0 is the switch off, and 100 % would change nothing.
fn duck_on(level: u32) -> bool {
    (1..100).contains(&level)
}

/// The same stream then and now. The sound server hands indexes out again after it restarts, so the process counts too.
fn same_stream(a: &Stream, b: &Stream) -> bool {
    a.index == b.index && a.pid == b.pid
}

/// What to lower, and to what: every other app's stream, to `level` percent of the volume it has now. Left alone are
/// Roamies' own streams (`own`), streams no app owns (everything may play through one, Roamies too) and the ones in
/// `held`: those are down already, and lowering them again would lose what they really had.
fn plan_lower(streams: &[Stream], level: u32, own: impl Fn(u32) -> bool, held: &[Stream]) -> Vec<(Stream, Vec<u32>)> {
    if !duck_on(level) {
        return Vec::new();
    }
    let lowered = |v: &u32| ((*v as u64 * level as u64 + 50) / 100) as u32;
    streams.iter().filter(|s| s.pid.is_some_and(|p| !own(p)) && !held.iter().any(|h| same_stream(h, s))).map(|s| (s.clone(), s.volumes.iter().map(lowered).collect())).collect()
}

/// What to give back: what each stream had, for the ones that are still there. A stream that started meanwhile was
/// never touched, and isn't now.
fn plan_restore(held: &[Stream], streams: &[Stream]) -> Vec<Stream> {
    held.iter().filter(|h| streams.iter().any(|s| same_stream(h, s) && s.volumes.len() == h.volumes.len())).cloned().collect()
}

/// duck.json: the streams that are down, with what they had.
fn duck_note(held: &[Stream]) -> String {
    json!({ "streams": held.iter().map(|s| json!({ "index": s.index, "pid": s.pid, "volumes": s.volumes })).collect::<Vec<_>>() }).to_string()
}

/// The streams in a duck.json; none from a note that can't be read.
fn duck_from(text: &str) -> Vec<Stream> {
    let Ok(note) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(list) = note.get("streams").and_then(Value::as_array) else { return Vec::new() };
    let n = |v: &Value| v.as_u64().and_then(|n| u32::try_from(n).ok());
    list.iter()
        .filter_map(|s| {
            let volumes: Vec<u32> = s.get("volumes")?.as_array()?.iter().map(n).collect::<Option<_>>()?;
            (!volumes.is_empty()).then_some(Stream { index: n(s.get("index")?)?, pid: Some(n(s.get("pid")?)?), volumes })
        })
        .collect()
}

/// Writes down what is lowered (nothing lowered, no file). False when it couldn't be written.
fn duck_save(dir: &Path, held: &[Stream]) -> bool {
    let file = dir.join("duck.json");
    if held.is_empty() {
        return std::fs::remove_file(&file).is_ok() || !file.exists();
    }
    let _ = std::fs::create_dir_all(dir);
    // Whole or not at all: half a note would give nothing back.
    let part = dir.join("duck.json.part");
    std::fs::write(&part, duck_note(held)).and_then(|()| std::fs::rename(&part, &file)).is_ok()
}

fn duck_load(dir: &Path) -> Vec<Stream> {
    std::fs::read_to_string(dir.join("duck.json")).map(|t| duck_from(&t)).unwrap_or_default()
}

/// The sound server, so the steps below can be tried without one: the streams playing now (None when they can't be
/// read), and setting one stream's volumes.
trait Mixer {
    fn streams(&mut self) -> Option<Vec<Stream>>;
    fn set(&mut self, index: u32, volumes: &[u32]);
}

struct Pactl;

impl Pactl {
    /// What pactl printed, or None when it failed (not installed, no sound server, a stream that just closed).
    fn run(args: &[String]) -> Option<String> {
        use std::process::{Command, Stdio};
        // The C locale: pactl writes its numbers with a point then, whatever the desktop's language is.
        let out = Command::new("pactl").args(args).env("LC_ALL", "C.UTF-8").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

impl Mixer for Pactl {
    fn streams(&mut self) -> Option<Vec<Stream>> {
        streams_from(&Self::run(&["-f", "json", "list", "sink-inputs"].map(String::from))?)
    }
    fn set(&mut self, index: u32, volumes: &[u32]) {
        let args: Vec<String> = ["set-sink-input-volume".to_string(), index.to_string()].into_iter().chain(volumes.iter().map(u32::to_string)).collect();
        let _ = Self::run(&args);
    }
}

/// Lowers the other apps' streams and adds them to `held`. What they had is written down before any volume moves,
/// so a crash in between still gives them back; with nowhere to write it, nothing is lowered.
fn lower(mixer: &mut impl Mixer, dir: &Path, level: u32, own: impl Fn(u32) -> bool, held: &mut Vec<Stream>) {
    if !duck_on(level) {
        return;
    }
    let Some(streams) = mixer.streams() else { return };
    let plan = plan_lower(&streams, level, own, held);
    if plan.is_empty() {
        return;
    }
    let all: Vec<Stream> = held.iter().cloned().chain(plan.iter().map(|(s, _)| s.clone())).collect();
    if !duck_save(dir, &all) {
        return;
    }
    *held = all;
    for (s, to) in &plan {
        mixer.set(s.index, to);
    }
}

/// Gives the streams in `held` back what they had and forgets them. When the streams can't be read (the sound server
/// is away) everything is kept for the next try.
fn give_back(mixer: &mut impl Mixer, dir: &Path, held: &mut Vec<Stream>) {
    if held.is_empty() {
        return;
    }
    let Some(streams) = mixer.streams() else { return };
    for s in plan_restore(held, &streams) {
        mixer.set(s.index, &s.volumes);
    }
    held.clear();
    duck_save(dir, held);
}

/// At start: a note still there means Roamies went away with the volumes down (a crash, a kill, a restart), so they
/// go back up now. Returns what couldn't be given back yet.
fn duck_recover(mixer: &mut impl Mixer, dir: &Path) -> Vec<Stream> {
    let mut held = duck_load(dir);
    give_back(mixer, dir, &mut held);
    held
}

/// How long the volumes stay down after the listening or the reply ends: a reply that starts right after the
/// listening would otherwise send them up and straight back down.
const DUCK_GRACE_MS: u64 = 500;

/// When the volumes go down and come back: down once when a take opens or a reply starts playing (`busy`) with the
/// switch on (`level` above 0), back once when neither holds any more and the wait is over. Times are milliseconds
/// on any clock that only goes forward.
#[derive(Default)]
struct Duck {
    level: u32,
    busy: bool,
    down: bool,
    restore_at: Option<u64>,
}

enum DuckEvent {
    /// The Voice page's setting: the percentage to lower to, 0 when it's switched off.
    Level(u32),
    /// A take is open or a reply is playing, or neither any more.
    Busy(bool),
    /// Time passed (see `wait`).
    Tick,
    Quit,
}

#[derive(PartialEq, Debug)]
enum DuckDo {
    Nothing,
    Lower(u32),
    Restore,
}

impl Duck {
    fn step(&mut self, event: DuckEvent, now: u64) -> DuckDo {
        match event {
            DuckEvent::Level(level) => self.level = level,
            DuckEvent::Busy(busy) => self.busy = busy,
            DuckEvent::Tick => {}
            DuckEvent::Quit => (self.level, self.busy) = (0, false),
        }
        if self.busy && duck_on(self.level) {
            self.restore_at = None;
            // Only when they aren't down yet: a new level waits for the next time.
            return if std::mem::replace(&mut self.down, true) { DuckDo::Nothing } else { DuckDo::Lower(self.level) };
        }
        if !self.down {
            return DuckDo::Nothing;
        }
        // Switched off, or quitting: back at once. Otherwise after the wait.
        let at = if duck_on(self.level) { *self.restore_at.get_or_insert(now + DUCK_GRACE_MS) } else { now };
        if now < at {
            return DuckDo::Nothing;
        }
        (self.down, self.restore_at) = (false, None);
        DuckDo::Restore
    }

    /// How long until the volumes are due back (then a Tick is owed), or None when nothing is waiting.
    fn wait(&self, now: u64) -> Option<u64> {
        self.restore_at.map(|at| at.saturating_sub(now))
    }
}

enum DuckMsg {
    Event(DuckEvent),
    /// Quitting: answered once the volumes are back.
    Quit(mpsc::Sender<()>),
}

static DUCK: OnceLock<mpsc::Sender<DuckMsg>> = OnceLock::new();

/// Everything pactl does happens on this thread, never the UI's: a sound server that is slow to answer would freeze
/// the Roamie.
fn duck_worker(dir: PathBuf, inbox: mpsc::Receiver<DuckMsg>) {
    let (mut mixer, me, start) = (Pactl, std::process::id(), Instant::now());
    let own = |pid: u32| is_own(pid, me, |p| stat_ppid(&std::fs::read_to_string(format!("/proc/{p}/stat")).ok()?));
    let now = || start.elapsed().as_millis() as u64;
    let mut held = duck_recover(&mut mixer, &dir);
    let mut duck = Duck::default();
    loop {
        let msg = match duck.wait(now()) {
            None => inbox.recv().ok(),
            Some(ms) => match inbox.recv_timeout(Duration::from_millis(ms)) {
                Err(mpsc::RecvTimeoutError::Timeout) => Some(DuckMsg::Event(DuckEvent::Tick)),
                msg => msg.ok(),
            },
        };
        let (event, quit) = match msg {
            Some(DuckMsg::Event(e)) => (e, None),
            Some(DuckMsg::Quit(done)) => (DuckEvent::Quit, Some(done)),
            None => return,
        };
        match duck.step(event, now()) {
            DuckDo::Lower(level) => lower(&mut mixer, &dir, level, own, &mut held),
            DuckDo::Restore => give_back(&mut mixer, &dir, &mut held),
            // Quitting with something still held (it couldn't be given back before): one more try.
            DuckDo::Nothing if quit.is_some() => give_back(&mut mixer, &dir, &mut held),
            DuckDo::Nothing => {}
        }
        if let Some(done) = quit {
            let _ = done.send(());
        }
    }
}

/// Once, at start. Without a runtime folder there's nowhere to keep what was lowered, so nothing ever is.
pub(crate) fn duck_start() {
    let Some(dir) = dock_dir() else { return };
    let (tx, inbox) = mpsc::channel();
    if DUCK.set(tx).is_ok() {
        std::thread::spawn(move || duck_worker(dir, inbox));
    }
}

fn duck_send(event: DuckEvent) {
    if let Some(tx) = DUCK.get() {
        let _ = tx.send(DuckMsg::Event(event));
    }
}

/// The Voice page's setting, from the sidecar: the percentage to lower other apps to, 0 when it's switched off.
pub(crate) fn duck_level(level: u32) {
    duck_send(DuckEvent::Level(level));
}

/// Roamies is quitting: the volumes go back up before it's gone. Waits for pactl, but not for long (a kill or a
/// crash gets no say at all: the note gives them back at the next start).
pub(crate) fn duck_quit() {
    let Some(tx) = DUCK.get() else { return };
    let (done, back) = mpsc::channel();
    if tx.send(DuckMsg::Quit(done)).is_ok() {
        let _ = back.recv_timeout(Duration::from_secs(2));
    }
}

/// Notes what one overlay says (a take is open there, a reply is playing there) and answers for all of them
/// together. Overlays that are gone are dropped: one that was taken down can't say it stopped.
fn talk_set(all: &mut Vec<(String, bool, bool)>, label: &str, hearing: bool, speaking: bool, alive: impl Fn(&str) -> bool) -> (bool, bool) {
    all.retain(|(l, ..)| l != label && alive(l));
    all.push((label.to_owned(), hearing, speaking));
    (all.iter().any(|t| t.1), all.iter().any(|t| t.2))
}

/// An overlay's page says a voice take opened or ended there (the microphone is on meanwhile), or a spoken reply
/// started or stopped playing there (host.js). Other apps' sound is down while either holds anywhere.
pub(crate) fn talk_state(app: &AppHandle, label: &str, hearing: bool, speaking: bool) {
    static TALK: Mutex<Vec<(String, bool, bool)>> = Mutex::new(Vec::new());
    let (hearing, speaking) = talk_set(&mut TALK.lock().unwrap(), label, hearing, speaking, |l| app.get_webview_window(l).is_some());
    duck_send(DuckEvent::Busy(hearing || speaking));
    // With the wake word on, the voice helper must not take Roamies' own voice saying the phrase for the user's.
    crate::voice::speaking(app, speaking);
}

#[cfg(test)]
mod tests {
    use super::*;

    // `pactl -f json list sink-inputs` on a PipeWire desktop, cut down to the fields that are read and a few around
    // them: a filter chain's output (no app behind it; everything that plays goes through it) and a browser's tab.
    const SINK_INPUTS: &str = r#"[{"index":38,"driver":"PipeWire","owner_module":null,"client":null,"sink":73,"sample_specification":"float32le 2ch 48000Hz","channel_map":"front-left,front-right","corked":true,"mute":false,"volume":{"front-left":{"value":65536,"value_percent":"100%","db":"0.00 dB"},"front-right":{"value":65536,"value_percent":"100%","db":"0.00 dB"}},"balance":0.00,"properties":{"node.virtual":"true","media.class":"Stream/Output/Audio","object.serial":"38"}},{"index":419,"driver":"PipeWire","owner_module":null,"client":"160","sink":37,"sample_specification":"float32le 2ch 48000Hz","channel_map":"front-left,front-right","corked":true,"mute":false,"volume":{"front-left":{"value":65536,"value_percent":"100%","db":"0.00 dB"},"front-right":{"value":65536,"value_percent":"100%","db":"0.00 dB"}},"balance":0.00,"properties":{"client.api":"pipewire-pulse","application.process.id":"1281","media.class":"Stream/Output/Audio","object.serial":"419"}}]"#;

    fn stream(index: u32, pid: Option<u32>, volumes: &[u32]) -> Stream {
        Stream { index, pid, volumes: volumes.to_vec() }
    }

    /// A sound server made of a list: what was set is applied to it and counted.
    struct FakeMixer {
        now: Option<Vec<Stream>>,
        lists: usize,
        sets: Vec<(u32, Vec<u32>)>,
    }

    impl FakeMixer {
        fn with(streams: &[Stream]) -> Self {
            FakeMixer { now: Some(streams.to_vec()), lists: 0, sets: Vec::new() }
        }
    }

    impl Mixer for FakeMixer {
        fn streams(&mut self) -> Option<Vec<Stream>> {
            self.lists += 1;
            self.now.clone()
        }
        fn set(&mut self, index: u32, volumes: &[u32]) {
            self.sets.push((index, volumes.to_vec()));
            for s in self.now.iter_mut().flatten().filter(|s| s.index == index) {
                s.volumes = volumes.to_vec();
            }
        }
    }

    /// A folder of its own for one test, outside the source tree; the test removes it when it's done.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("roamies-duck-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch folder");
        dir
    }

    #[test]
    fn pactls_list_becomes_streams() {
        assert_eq!(streams_from(SINK_INPUTS), Some(vec![stream(38, None, &[65536, 65536]), stream(419, Some(1281), &[65536, 65536])]));
        // Volumes come in the channel map's order (the order they're set in), whatever order the listing names them in.
        let surround = r#"[{"index":7,"channel_map":"front-left,front-right,rear-left,rear-right,front-center,lfe","volume":{"lfe":{"value":6},"front-center":{"value":5},"rear-right":{"value":4},"rear-left":{"value":3},"front-right":{"value":2},"front-left":{"value":1}},"properties":{"application.process.id":"900"}}]"#;
        assert_eq!(streams_from(surround), Some(vec![stream(7, Some(900), &[1, 2, 3, 4, 5, 6])]));
        assert_eq!(streams_from("[]"), Some(vec![]), "nothing is playing");
        // A stream whose volumes can't be read in order is left out (so it's left alone); the rest are kept.
        let odd = r#"[{"index":1,"channel_map":"mono","volume":{"front-left":{"value":9}},"properties":{}},{"index":2,"volume":{},"properties":{}},{"volume":{"mono":{"value":9}},"channel_map":"mono"},{"index":3,"channel_map":"mono","volume":{"mono":{"value":32768}},"properties":{"application.process.id":"x"}}]"#;
        assert_eq!(streams_from(odd), Some(vec![stream(3, None, &[32768])]));
        for bad in ["", "Connection failure: Connection refused", "{}", "3"] {
            assert_eq!(streams_from(bad), None, "{bad}");
        }
    }

    #[test]
    fn roamies_own_processes_are_found_by_their_parents() {
        assert_eq!(stat_ppid("4321 (roamies) S 1 4321 4321 0 -1 4194560 100 0"), Some(1));
        assert_eq!(stat_ppid("77 (Web Content) (x) R 4321 77 77 0"), Some(4321), "a name with spaces and brackets");
        assert_eq!(stat_ppid(""), None);
        assert_eq!(stat_ppid("77 (cut"), None);
        // 10 is Roamies, 11 its webview, 12 the webview's audio process; 20 is another app, started by 1 like Roamies.
        let parent = |p: u32| [(10, 1), (11, 10), (12, 11), (20, 1), (1, 0)].iter().find(|(c, _)| *c == p).map(|(_, up)| *up);
        assert!(is_own(10, 10, parent), "itself");
        assert!(is_own(11, 10, parent) && is_own(12, 10, parent), "what it started, and what those started");
        assert!(!is_own(20, 10, parent), "another app");
        assert!(!is_own(1, 10, parent) && !is_own(99, 10, parent), "its own parent, and a process that's gone");
        assert!(!is_own(5, 10, |p| Some(if p == 5 { 6 } else { 5 })), "a loop in the table ends");
    }

    #[test]
    fn other_apps_are_lowered_and_roamies_never_is() {
        let own = |pid: u32| pid == 500 || pid == 501;
        let streams = [stream(1, Some(1281), &[65536, 65536]), stream(2, Some(500), &[65536]), stream(3, Some(501), &[40000, 40000]), stream(4, None, &[65536, 65536]), stream(5, Some(77), &[52429, 26214])];
        // To 30 % of what each has now, each channel by itself (so its balance stays).
        assert_eq!(plan_lower(&streams, 30, own, &[]), vec![(streams[0].clone(), vec![19661, 19661]), (streams[4].clone(), vec![15729, 7864])]);
        assert_eq!(plan_lower(&streams, 10, own, &[])[0].1, vec![6554, 6554]);
        assert_eq!(plan_lower(&streams, 50, own, &[])[1].1, vec![26215, 13107]);
        // A stream that is already down isn't lowered again: what it really had would be lost.
        assert_eq!(plan_lower(&streams, 30, own, &[stream(1, Some(1281), &[65536, 65536])]), vec![(streams[4].clone(), vec![15729, 7864])]);
        // The same number on another process is another stream (the sound server started over).
        assert_eq!(plan_lower(&streams, 30, own, &[stream(1, Some(9), &[1, 1])]).len(), 2);
        // Switched off: nothing, whatever is playing. And 100 % would change nothing.
        assert_eq!(plan_lower(&streams, 0, own, &[]), vec![]);
        assert_eq!(plan_lower(&streams, 100, own, &[]), vec![]);
        assert_eq!(plan_lower(&[], 30, own, &[]), vec![]);
    }

    #[test]
    fn what_was_lowered_gets_back_what_it_had() {
        let held = [stream(1, Some(1281), &[65536, 65536]), stream(5, Some(77), &[52429, 26214]), stream(8, Some(30), &[20000])];
        // 1 is still down, 5 was changed meanwhile (it gets back what it had all the same), 8 has gone, 6 started
        // while the others were down and was never touched.
        let now = [stream(1, Some(1281), &[19661, 19661]), stream(5, Some(77), &[65536, 65536]), stream(6, Some(40), &[65536])];
        assert_eq!(plan_restore(&held, &now), vec![held[0].clone(), held[1].clone()]);
        assert_eq!(plan_restore(&held, &[stream(1, Some(2000), &[19661, 19661])]), vec![], "the number was handed to another process");
        assert_eq!(plan_restore(&held, &[stream(1, Some(1281), &[19661])]), vec![], "it isn't the stream it was (other channels)");
        assert_eq!(plan_restore(&held, &[]), vec![]);
        assert_eq!(plan_restore(&[], &now), vec![]);
    }

    #[test]
    fn what_was_lowered_is_written_down_and_read_back() {
        let held = vec![stream(419, Some(1281), &[65536, 65536]), stream(7, Some(900), &[1, 2, 3, 4, 5, 6])];
        assert_eq!(serde_json::from_str::<Value>(&duck_note(&held[..1])).unwrap(), json!({ "streams": [{ "index": 419, "pid": 1281, "volumes": [65536, 65536] }] }));
        assert_eq!(duck_from(&duck_note(&held)), held);
        for bad in ["", "[]", "{}", r#"{"streams":3}"#, r#"{"streams":[{"index":1,"pid":2}]}"#, r#"{"streams":[{"index":1,"pid":2,"volumes":[]}]}"#, r#"{"streams":[{"index":1,"volumes":[5]}]}"#, r#"{"streams":[{"index":-1,"pid":2,"volumes":[5]}]}"#, r#"{"streams":[{"index":1,"pid":2,"volumes":[5,"x"]}]}"#] {
            assert_eq!(duck_from(bad), vec![], "{bad}");
        }
        let dir = scratch("note");
        let nested = dir.join("roamies");
        assert_eq!(duck_load(&nested), vec![], "no file, nothing lowered");
        assert!(duck_save(&nested, &held), "the folder is made when it's missing");
        assert_eq!(duck_load(&nested), held);
        assert!(duck_save(&nested, &[]));
        assert!(!nested.join("duck.json").exists(), "nothing lowered, no file");
        assert_eq!(std::fs::read_dir(&nested).unwrap().count(), 0, "and nothing else left behind");
        // Nowhere to write it down: said so, for nothing to be lowered then.
        std::fs::write(dir.join("a-file"), "").unwrap();
        assert!(!duck_save(&dir.join("a-file"), &held));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lowering_writes_it_down_first_and_giving_back_clears_it() {
        let dir = scratch("lower");
        let own = |pid: u32| pid == 500;
        let playing = [stream(1, Some(1281), &[65536, 65536]), stream(2, Some(500), &[65536]), stream(5, Some(77), &[52429, 26214])];
        let mut mixer = FakeMixer::with(&playing);
        let mut held = Vec::new();
        lower(&mut mixer, &dir, 30, own, &mut held);
        assert_eq!(mixer.sets, vec![(1, vec![19661, 19661]), (5, vec![15729, 7864])]);
        assert_eq!(held, vec![playing[0].clone(), playing[2].clone()], "what they had is remembered");
        assert_eq!(duck_load(&dir), held, "and written down");
        // Asked again while they're down: nothing is lowered twice, and what they really had is still what's kept.
        lower(&mut mixer, &dir, 30, own, &mut held);
        assert_eq!(mixer.sets.len(), 2);
        assert_eq!(duck_load(&dir), vec![playing[0].clone(), playing[2].clone()]);
        // Meanwhile 5 closes and 6 starts (left alone, then and after).
        mixer.now = Some(vec![stream(1, Some(1281), &[19661, 19661]), stream(2, Some(500), &[65536]), stream(6, Some(40), &[65536])]);
        mixer.sets.clear();
        give_back(&mut mixer, &dir, &mut held);
        assert_eq!(mixer.sets, vec![(1, vec![65536, 65536])]);
        assert_eq!(held, vec![]);
        assert!(!dir.join("duck.json").exists());
        // Nothing is held: the sound server isn't even asked.
        let lists = mixer.lists;
        give_back(&mut mixer, &dir, &mut held);
        assert_eq!((mixer.lists, mixer.sets.len()), (lists, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switched_off_the_sound_server_is_never_asked() {
        let dir = scratch("off");
        let mut mixer = FakeMixer::with(&[stream(1, Some(1281), &[65536, 65536])]);
        let mut held = Vec::new();
        lower(&mut mixer, &dir, 0, |_| false, &mut held);
        assert_eq!((mixer.lists, mixer.sets.len(), held.len()), (0, 0, 0));
        assert_eq!(duck_recover(&mut mixer, &dir), vec![], "no note from last time");
        assert_eq!(mixer.lists, 0);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "and nothing is written");
        // Nowhere to write down what they had: nothing is lowered, since it couldn't be given back after a crash.
        std::fs::write(dir.join("a-file"), "").unwrap();
        lower(&mut mixer, &dir.join("a-file"), 30, |_| false, &mut held);
        assert_eq!((mixer.sets.len(), held.len()), (0, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_note_left_by_a_crash_gives_the_volumes_back_at_the_next_start() {
        let dir = scratch("recover");
        let before = [stream(1, Some(1281), &[65536, 65536]), stream(5, Some(77), &[52429, 26214])];
        // Roamies lowers them and is gone before it gives them back: the note stays.
        let mut mixer = FakeMixer::with(&before);
        lower(&mut mixer, &dir, 20, |_| false, &mut Vec::new());
        assert_eq!(mixer.now.as_deref(), Some(&[stream(1, Some(1281), &[13107, 13107]), stream(5, Some(77), &[10486, 5243])][..]));
        assert!(dir.join("duck.json").is_file());
        // The next start, with the sound server away: nothing can be given back yet, so it's all kept.
        let mut away = FakeMixer { now: None, lists: 0, sets: Vec::new() };
        assert_eq!(duck_recover(&mut away, &dir), before.to_vec());
        assert!(dir.join("duck.json").is_file());
        // The next start: back to what they had, and the note is gone.
        mixer.sets.clear();
        assert_eq!(duck_recover(&mut mixer, &dir), vec![]);
        assert_eq!(mixer.now.as_deref(), Some(&before[..]));
        assert!(!dir.join("duck.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn volumes_go_down_once_and_come_back_once_after_a_short_wait() {
        use DuckEvent::*;
        let mut d = Duck::default();
        assert_eq!(d.step(Level(30), 0), DuckDo::Nothing, "nobody is talking yet");
        assert_eq!(d.step(Busy(true), 1000), DuckDo::Lower(30), "listening starts");
        assert_eq!(d.step(Busy(true), 1100), DuckDo::Nothing, "once");
        assert_eq!(d.wait(1100), None);
        // Listening ends and the reply starts right after: the volumes stay down in between.
        assert_eq!(d.step(Busy(false), 3000), DuckDo::Nothing);
        assert_eq!(d.wait(3000), Some(DUCK_GRACE_MS));
        assert_eq!(d.wait(3200), Some(DUCK_GRACE_MS - 200));
        assert_eq!(d.step(Busy(true), 3300), DuckDo::Nothing, "no bounce");
        assert_eq!(d.wait(3300), None);
        // The reply ends and nothing follows.
        assert_eq!(d.step(Busy(false), 9000), DuckDo::Nothing);
        assert_eq!(d.step(Tick, 9000 + DUCK_GRACE_MS - 1), DuckDo::Nothing);
        assert_eq!(d.wait(9000 + DUCK_GRACE_MS), Some(0));
        assert_eq!(d.step(Tick, 9000 + DUCK_GRACE_MS), DuckDo::Restore);
        assert_eq!(d.step(Tick, 20_000), DuckDo::Nothing, "once");
        assert_eq!(d.wait(20_000), None);
        // The level changes while they're down: they stay where they are, and the next time uses the new one.
        assert_eq!(d.step(Busy(true), 30_000), DuckDo::Lower(30));
        assert_eq!(d.step(Level(10), 30_100), DuckDo::Nothing);
        assert_eq!(d.step(Busy(false), 31_000), DuckDo::Nothing);
        assert_eq!(d.step(Tick, 31_000 + DUCK_GRACE_MS), DuckDo::Restore);
        assert_eq!(d.step(Busy(true), 40_000), DuckDo::Lower(10));
    }

    #[test]
    fn switching_it_off_or_quitting_gives_the_volumes_back_at_once() {
        use DuckEvent::*;
        let mut d = Duck::default();
        // Off (as it starts): talking changes nothing.
        assert_eq!(d.step(Busy(true), 0), DuckDo::Nothing);
        assert_eq!(d.step(Busy(false), 100), DuckDo::Nothing);
        assert_eq!(d.step(Tick, 5000), DuckDo::Nothing);
        assert_eq!(d.wait(5000), None);
        // Switched on in the middle of a reply: down now.
        assert_eq!(d.step(Busy(true), 6000), DuckDo::Nothing);
        assert_eq!(d.step(Level(50), 6100), DuckDo::Lower(50));
        // Switched off in the middle of it: back now, no wait.
        assert_eq!(d.step(Level(0), 6200), DuckDo::Restore);
        assert_eq!(d.step(Busy(false), 6300), DuckDo::Nothing);
        // Quitting while they're down: back now; and nothing goes down after it.
        assert_eq!(d.step(Level(30), 7000), DuckDo::Nothing);
        assert_eq!(d.step(Busy(true), 7100), DuckDo::Lower(30));
        assert_eq!(d.step(Quit, 7200), DuckDo::Restore);
        assert_eq!(d.step(Busy(true), 7300), DuckDo::Nothing);
        assert_eq!(d.wait(7300), None);
    }

    #[test]
    fn every_overlay_has_its_say_and_a_closed_one_is_forgotten() {
        let mut all = Vec::new();
        let alive = |_: &str| true;
        assert_eq!(talk_set(&mut all, "overlay-0-0", false, false, alive), (false, false));
        assert_eq!(talk_set(&mut all, "overlay-0-0", true, false, alive), (true, false), "a take is open");
        assert_eq!(talk_set(&mut all, "overlay-0-1", false, true, alive), (true, true), "a reply plays on the other screen");
        assert_eq!(talk_set(&mut all, "overlay-0-0", false, false, alive), (false, true));
        assert_eq!(talk_set(&mut all, "overlay-0-1", false, false, alive), (false, false), "neither holds any more");
        assert_eq!(all.len(), 2, "one note per overlay");
        // An overlay that was taken down while a reply played can't say it stopped: the next report drops it.
        talk_set(&mut all, "overlay-0-1", false, true, alive);
        assert_eq!(talk_set(&mut all, "overlay-1-0", false, false, |l| l.starts_with("overlay-1-")), (false, false));
        assert_eq!(all, vec![("overlay-1-0".to_string(), false, false)]);
    }

    #[test]
    fn a_bars_slot_is_read_only_when_it_makes_sense() {
        let d = dock_from(r#"{"monitor":"eDP-1","x":1830,"y":23.5,"sw":2304,"sh":1440}"#).expect("a slot");
        assert_eq!(d, json!({ "x": 1830.0, "y": 23.5, "sw": 2304.0, "sh": 1440.0, "mx": 0.0, "my": 0.0 }));
        assert_eq!(dock_from(r#"{"x":10,"y":5,"sw":100,"sh":50,"mx":1920,"my":-40}"#).unwrap()["mx"], 1920.0);
        for bad in ["", "[]", "{}", r#"{"x":10,"y":5}"#, r#"{"x":"10","y":5,"sw":100,"sh":50}"#, r#"{"x":10,"y":5,"sw":0,"sh":50}"#, r#"{"x":101,"y":5,"sw":100,"sh":50}"#, r#"{"x":10,"y":-1,"sw":100,"sh":50}"#, r#"{"x":10,"y":5,"sw":1e9,"sh":50}"#] {
            assert_eq!(dock_from(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_colour_note_is_light_or_dark_and_only_hex_colours() {
        let real = r##"{"light":true,"bg":"#f2e7de","surface":"#ffffff","fg":"#100a05","muted":"#786c61","line":"#e4d6cb","accent":"#9e6630","danger":"#d71921"}"##;
        assert_eq!(theme_from(real), Some(json!({ "light": true, "bg": "#f2e7de", "surface": "#ffffff", "fg": "#100a05", "muted": "#786c61", "line": "#e4d6cb", "accent": "#9e6630", "danger": "#d71921" })));
        // Light or dark alone is a note; colours are optional, and capitals are the same colour.
        assert_eq!(theme_from(r#"{"light":false}"#), Some(json!({ "light": false })));
        assert_eq!(theme_from(r##"{"light":false,"accent":"#9E6630"}"##), Some(json!({ "light": false, "accent": "#9e6630" })));
        // No file content, not JSON, not an object, or light not said as true or false: no note.
        for bad in ["", " ", "{", "null", "true", "[]", "[true]", r#""light""#, "{}", r##"{"bg":"#f2e7de"}"##, r#"{"light":"true"}"#, r#"{"light":1}"#, r#"{"light":null}"#, r#"{"light":[true]}"#] {
            assert_eq!(theme_from(bad), None, "{bad}");
        }
        // A colour that isn't exactly #rrggbb is left out, whatever it is; the good one beside it stays.
        let not_colours = [
            r#""red""#, r##""#fff""##, r##""#12345g""##, r##""#1234567""##, r##""#12345""##, r##"" #123456""##, r##""#123456 ""##, r##""#123456\n""##, r##""123456#""##, r##""#éé12""##, r##""#ｆｆｆｆｆｆ""##,
            r#""url(javascript:alert(1))""#, r#""rgb(1,2,3)""#, r##""#123456;color:red""##, r##""#12345\"""##, r##""#1234';""##, r#""""#, "123456", "1193046", "null", "true", r##"["#123456"]"##, r##"{"hex":"#123456"}"##,
        ];
        for bad in not_colours {
            let got = theme_from(&format!(r##"{{"light":true,"bg":{bad},"fg":"#100a05"}}"##));
            assert_eq!(got, Some(json!({ "light": true, "fg": "#100a05" })), "{bad}");
        }
        // Nothing else in the file leaves here: no other key, and no colour under a name that isn't one of the seven.
        let extra = theme_from(r##"{"light":true,"paint":"wall","s2":"#faefe6","font":"x;}body{display:none","bg":"#f2e7de","nested":{"bg":"#000000"}}"##);
        assert_eq!(extra, Some(json!({ "light": true, "bg": "#f2e7de" })));
    }

    #[test]
    fn the_slot_belongs_to_the_screen_the_bar_measured() {
        let d = dock_from(r#"{"x":900,"y":20,"sw":1920,"sh":1080,"mx":2304,"my":0}"#).unwrap();
        assert!(dock_on(&d, None, 1), "one screen: it's that one, whatever it reports");
        assert!(dock_on(&d, Some((0.0, 0.0, 800.0, 600.0)), 1));
        assert!(dock_on(&d, Some((2304.0, 0.0, 1920.0, 1080.0)), 2));
        assert!(dock_on(&d, Some((2303.4, 0.6, 1921.0, 1079.0)), 2), "rounding");
        assert!(!dock_on(&d, Some((0.0, 0.0, 2304.0, 1440.0)), 2), "the other screen");
        assert!(!dock_on(&d, None, 2));
    }

    #[test]
    fn the_note_for_the_bar_says_who_and_whether_its_out() {
        let v: Value = serde_json::from_str(&dock_note(true, false, "/opt/Roamies.AppImage", 1794359725)).unwrap();
        assert_eq!(v, json!({ "pid": std::process::id(), "exe": "/opt/Roamies.AppImage", "out": true, "keys": false, "t": 1794359725u64 }));
        assert_eq!(serde_json::from_str::<Value>(&dock_note(false, false, "", 0)).unwrap()["out"], false);
        // keys: the Roamie is being typed to, so the keyboard is the overlay's; otherwise the bar may hand it back.
        assert_eq!(serde_json::from_str::<Value>(&dock_note(true, true, "", 0)).unwrap()["keys"], true);
    }

    #[test]
    fn the_autostart_entry_quotes_the_program() {
        let e = autostart_entry("/home/kai/Apps/Roamies 0.1.33.AppImage").expect("an entry");
        assert!(e.starts_with("[Desktop Entry]\nType=Application\nName=Roamies\n"));
        assert!(e.contains("\nExec=\"/home/kai/Apps/Roamies 0.1.33.AppImage\"\n"), "{e}");
        assert_eq!(exec_quoted("/usr/bin/roamies").as_deref(), Some("\"/usr/bin/roamies\""));
        // Characters a shell or the desktop would act on stay literal.
        assert_eq!(exec_quoted("/opt/a$b/50%/q\"t/b`t").as_deref(), Some("\"/opt/a\\\\$b/50%%/q\\\\\"t/b\\\\`t\""));
        assert_eq!(exec_quoted("/opt/back\\slash").as_deref(), Some("\"/opt/back\\\\\\\\slash\""));
        assert_eq!(exec_quoted("/opt/two\nlines"), None);
        assert_eq!(autostart_entry(""), None);
    }

    #[test]
    fn the_command_to_bind_names_this_copy() {
        assert_eq!(launch_word("/usr/bin/roamies"), "roamies", "the package's own command");
        assert_eq!(launch_word("/home/kai/Apps/Roamies_0.1.33_amd64.AppImage"), "/home/kai/Apps/Roamies_0.1.33_amd64.AppImage");
        assert_eq!(launch_word("/home/kai/My Apps/Roamies.AppImage"), "'/home/kai/My Apps/Roamies.AppImage'");
        assert_eq!(launch_word("/home/kai/it's/Roamies"), "'/home/kai/it'\\''s/Roamies'");
    }

    #[test]
    fn an_entry_the_desktop_switched_off_counts_as_off() {
        assert!(autostart_on(&autostart_entry("/usr/bin/roamies").unwrap()));
        assert!(!autostart_on("[Desktop Entry]\nExec=roamies\nHidden=true\n"));
        assert!(!autostart_on("[Desktop Entry]\nExec=roamies\nX-GNOME-Autostart-enabled=false\n"));
        assert!(!autostart_on("[Desktop Entry]\nHidden = True\n"));
        assert!(autostart_on("[Desktop Entry]\nHidden=false\n"));
    }

    #[test]
    fn screenshots_shrink_to_the_cap_and_never_grow() {
        assert_eq!(fit(1920, 1080, 1568), (1568, 882));
        assert_eq!(fit(3840, 2160, 1568), (1568, 882));
        assert_eq!(fit(1080, 2400, 1568), (706, 1568), "a tall one is capped by its height");
        assert_eq!(fit(1568, 900, 1568), (1568, 900));
        assert_eq!(fit(800, 600, 1568), (800, 600), "small ones stay as they are");
        assert_eq!(fit(5000, 1, 1568), (1568, 1), "never down to nothing");
        assert_eq!(fit(0, 0, 1568), (0, 0));
    }

    #[test]
    fn the_desktop_is_the_rectangle_round_every_screen() {
        assert_eq!(union_bounds(&[[0.0, 0.0, 1920.0, 1080.0]]), [0.0, 0.0, 1920.0, 1080.0]);
        assert_eq!(union_bounds(&[[0.0, 0.0, 1920.0, 1080.0], [1920.0, 0.0, 2560.0, 1440.0]]), [0.0, 0.0, 4480.0, 1440.0]);
        assert_eq!(union_bounds(&[[0.0, 0.0, 1920.0, 1080.0], [-1280.0, 56.0, 1280.0, 1024.0]]), [-1280.0, 0.0, 3200.0, 1080.0], "a screen to the left");
        assert_eq!(union_bounds(&[]), [0.0; 4]);
    }

    // A desk with two screens: a laptop's (scale 1.667) and a monitor to its right (scale 1), in logical px.
    const LAPTOP: [f64; 4] = [0.0, 0.0, 2304.0, 1440.0];
    const SIDE: [f64; 4] = [2304.0, 0.0, 1920.0, 1080.0];

    #[test]
    fn a_picture_of_every_screen_is_cut_down_to_the_one_in_use() {
        let desk = union_bounds(&[LAPTOP, SIDE]);
        // The compositor's picture of both, at the larger scale (1.667 px a point) and at 2.
        assert_eq!(shot_crop((7040, 2400), desk, LAPTOP), Some(((0, 0, 3840, 2400), LAPTOP)));
        assert_eq!(shot_crop((7040, 2400), desk, SIDE), Some(((3840, 0, 3200, 1800), SIDE)));
        assert_eq!(shot_crop((8448, 2880), desk, LAPTOP), Some(((0, 0, 4608, 2880), LAPTOP)));
        assert_eq!(shot_crop((8448, 2880), desk, SIDE), Some(((4608, 0, 3840, 2160), SIDE)));
        // Sizes that don't divide evenly: edges go to the nearest pixel, and two screens side by side share theirs.
        let (small, wide) = ([0.0, 0.0, 1366.0, 768.0], [1366.0, 0.0, 1920.0, 1080.0]);
        let odd = union_bounds(&[small, wide]);
        assert_eq!(shot_crop((5477, 1800), odd, small), Some(((0, 0, 2277, 1280), small)));
        assert_eq!(shot_crop((5477, 1800), odd, wide), Some(((2277, 0, 3200, 1800), wide)), "never past the picture's edge");
        // A screen to the left of the main one, or above it: the desk starts below zero.
        let (left, main) = ([-1920.0, 0.0, 1920.0, 1080.0], [0.0, 0.0, 2560.0, 1440.0]);
        let west = union_bounds(&[left, main]);
        assert_eq!(shot_crop((4480, 1440), west, left), Some(((0, 0, 1920, 1080), left)));
        assert_eq!(shot_crop((4480, 1440), west, main), Some(((1920, 0, 2560, 1440), main)));
        let (above, below) = ([0.0, -1080.0, 1920.0, 1080.0], [0.0, 0.0, 1920.0, 1080.0]);
        let north = union_bounds(&[above, below]);
        assert_eq!(shot_crop((3840, 4320), north, below), Some(((0, 2160, 3840, 2160), below)));
        // Partly off the desk (a screen just unplugged or moved): the part that is on it, and bounds to match.
        assert_eq!(shot_crop((4224, 1440), desk, [4000.0, 0.0, 1920.0, 1080.0]), Some(((4000, 0, 224, 1080), [4000.0, 0.0, 224.0, 1080.0])));
        assert_eq!(shot_crop((4224, 1440), desk, [-100.0, -50.0, 1100.0, 650.0]), Some(((0, 0, 1000, 600), [0.0, 0.0, 1000.0, 600.0])));
        assert_eq!(shot_crop((4224, 1440), desk, [5000.0, 0.0, 1920.0, 1080.0]), None, "wholly off it: the picture stays whole");
        // One screen: there is nothing to cut.
        assert_eq!(shot_crop((3840, 2400), LAPTOP, LAPTOP), None);
        // A picture that isn't the desk's shape (one screen's only, say) says nothing about where a screen is in it.
        assert_eq!(shot_crop((1920, 1080), desk, SIDE), None);
        assert_eq!(shot_crop((3840, 2400), desk, LAPTOP), None);
        // Nothing sensible to go by.
        for (capture, d, s) in [((0, 0), desk, LAPTOP), ((7040, 2400), [0.0; 4], LAPTOP), ((7040, 2400), desk, [0.0; 4]), ((7040, 2400), desk, [f64::NAN, 0.0, 100.0, 100.0]), ((-7040, 2400), desk, SIDE)] {
            assert_eq!(shot_crop(capture, d, s), None, "{capture:?} {d:?} {s:?}");
        }
    }

    /// A pixel of a picture as (r, g, b).
    fn pixel(p: &gtk::gdk_pixbuf::Pixbuf, x: i32, y: i32) -> (u8, u8, u8) {
        let (bytes, at) = (p.read_pixel_bytes(), (y * p.rowstride() + x * p.n_channels()) as usize);
        (bytes[at], bytes[at + 1], bytes[at + 2])
    }

    #[test]
    fn the_saved_picture_is_the_screen_in_use_and_says_what_it_covers() {
        use gtk::gdk_pixbuf::{Colorspace, Pixbuf};
        let dir = scratch("shot");
        let file = dir.join("shot.jpg").to_string_lossy().into_owned();
        let desk = union_bounds(&[LAPTOP, SIDE]);
        // The compositor's picture of both screens at a tenth of its size: the laptop's part red, the monitor's
        // blue, and the strip under the monitor (no screen there) black.
        let capture = Pixbuf::new(Colorspace::Rgb, false, 8, 704, 240).expect("a picture");
        capture.fill(0x000000ff);
        capture.new_subpixbuf(0, 0, 384, 240).fill(0xff0000ff);
        capture.new_subpixbuf(384, 0, 320, 180).fill(0x0000ffff);
        let saved = |screen: Option<[f64; 4]>| {
            let shot = save_shot(&capture, &file, desk, screen).expect("saved");
            let p = Pixbuf::from_file(&file).expect("a JPEG");
            assert_eq!((p.width(), p.height()), shot.pixels, "the size it says is the file's");
            (shot, p)
        };
        let red = |c: (u8, u8, u8)| c.0 > 200 && c.1 < 60 && c.2 < 60;
        let blue = |c: (u8, u8, u8)| c.0 < 60 && c.1 < 60 && c.2 > 200;
        let (shot, p) = saved(Some(LAPTOP));
        assert_eq!(shot, Shot { pixels: (384, 240), bounds: LAPTOP, screen: true });
        assert!(red(pixel(&p, 4, 4)) && red(pixel(&p, 379, 235)), "all of it is the laptop's screen");
        let (shot, p) = saved(Some(SIDE));
        assert_eq!(shot, Shot { pixels: (320, 180), bounds: SIDE, screen: true });
        assert!(blue(pixel(&p, 4, 4)) && blue(pixel(&p, 315, 175)), "all of it is the monitor");
        // As it was: the screen isn't known, so the whole desktop and its bounds.
        let (shot, p) = saved(None);
        assert_eq!(shot, Shot { pixels: (704, 240), bounds: desk, screen: false });
        assert!(red(pixel(&p, 4, 4)) && blue(pixel(&p, 700, 4)));
        // One screen: the picture as it came.
        let one = Pixbuf::new(Colorspace::Rgb, false, 8, 384, 240).expect("a picture");
        one.fill(0xff0000ff);
        assert_eq!(save_shot(&one, &file, LAPTOP, Some(LAPTOP)), Ok(Shot { pixels: (384, 240), bounds: LAPTOP, screen: false }));
        // A big one is cut first and shrunk after: the screen fills Claude's cap, not a third of it.
        let big = Pixbuf::new(Colorspace::Rgb, false, 8, 7040, 2400).expect("a picture");
        assert_eq!(save_shot(&big, &file, desk, Some(LAPTOP)), Ok(Shot { pixels: (1568, 980), bounds: LAPTOP, screen: true }));
        assert_eq!(save_shot(&big, &file, desk, Some(SIDE)), Ok(Shot { pixels: (1568, 882), bounds: SIDE, screen: true }));
        assert_eq!(save_shot(&big, &file, desk, None), Ok(Shot { pixels: (1568, 535), bounds: desk, screen: false }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sidecar_is_told_the_pictures_size_and_what_it_covers() {
        let id = json!(7);
        // As it was: the whole desktop.
        assert_eq!(shot_reply(&id, Ok(Shot { pixels: (1568, 882), bounds: [0.0, 0.0, 1920.0, 1080.0], screen: false })), json!({ "type": "screenshot_done", "id": 7, "ok": true, "pixels": [1568, 882], "bounds": [0.0, 0.0, 1920.0, 1080.0] }));
        assert_eq!(shot_reply(&id, Err("no portal".into())), json!({ "type": "screenshot_done", "id": 7, "ok": false, "error": "no portal" }));
        // One screen of several says so.
        assert_eq!(shot_reply(&id, Ok(Shot { pixels: (1568, 882), bounds: SIDE, screen: true })), json!({ "type": "screenshot_done", "id": 7, "ok": true, "pixels": [1568, 882], "bounds": [2304.0, 0.0, 1920.0, 1080.0], "of": "screen" }));
    }

    /// The sidecar's shotMap and toScreen (pointing.mjs): a pixel of the picture as a place on the desk.
    fn to_screen(bounds: [f64; 4], pixels: (i32, i32), x: f64, y: f64) -> (f64, f64) {
        ((bounds[0] + x * bounds[2] / pixels.0 as f64).round(), (bounds[1] + y * bounds[3] / pixels.1 as f64).round())
    }

    #[test]
    fn a_pixel_of_the_screens_picture_is_its_place_on_the_desk() {
        // The whole way: the capture, the screen's part of it, shrunk to Claude's cap, what the sidecar is told
        // (pixels and bounds) and from a pixel the model names back to the desk. test/pointing.test.mjs goes on
        // from the same numbers with the real shotMap and toScreen.
        let desk = union_bounds(&[LAPTOP, SIDE]);
        for capture in [(7040, 2400), (8448, 2880)] {
            assert_eq!(fit(capture.0, capture.1, SHOT_MAX), (1568, 535), "both screens in one picture, as it was: too small to read");
            let ((_, _, w, h), bounds) = shot_crop(capture, desk, LAPTOP).expect("the laptop's part");
            let pixels = fit(w, h, SHOT_MAX);
            assert_eq!((pixels, bounds), ((1568, 980), LAPTOP));
            assert_eq!(to_screen(bounds, pixels, 1361.0, 885.0), (2000.0, 1300.0), "a button low on the laptop's screen");
            assert_eq!(to_screen(bounds, pixels, 0.0, 0.0), (0.0, 0.0));
            let ((_, _, w, h), bounds) = shot_crop(capture, desk, SIDE).expect("the monitor's part");
            let pixels = fit(w, h, SHOT_MAX);
            assert_eq!((pixels, bounds), ((1568, 882), SIDE));
            assert_eq!(to_screen(bounds, pixels, 784.0, 441.0), (3264.0, 540.0), "the middle of the monitor, past the laptop's width");
            assert_eq!(to_screen(bounds, pixels, 100.0, 50.0), (2426.0, 61.0));
            assert_eq!(to_screen(bounds, pixels, 1568.0, 882.0), (4224.0, 1080.0), "its far corner");
        }
    }

    #[test]
    fn the_saved_screenshot_is_still_a_jpeg() {
        use gtk::gdk_pixbuf::{Colorspace, Pixbuf};
        let dir = scratch("jpeg");
        let file = dir.join("shot.jpg").to_string_lossy().into_owned();
        let p = Pixbuf::new(Colorspace::Rgb, false, 8, 40, 30).expect("a picture");
        p.fill(0xff0000ff);
        assert_eq!(save_fitted(&p, &file), Ok((40, 30)));
        assert_eq!(std::fs::read(&file).expect("saved")[..3], [0xff, 0xd8, 0xff], "a JPEG, as before");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slurp_says_where_the_area_is_or_that_none_was_picked() {
        // `slurp -f "%x %y %w %h"`: global logical points, below zero on a screen left of or above the main one.
        assert_eq!(slurp_area(true, "2000 100 800 600", ""), Ok(Some([2000.0, 100.0, 800.0, 600.0])));
        assert_eq!(slurp_area(true, "-1000 -50 500 400\n", ""), Ok(Some([-1000.0, -50.0, 500.0, 400.0])), "left of and above the main screen");
        // Esc, or a click without a drag: an error exit, "selection cancelled" and nothing printed.
        assert_eq!(slurp_area(false, "", "selection cancelled\n"), Ok(None));
        assert_eq!(slurp_area(false, "", ""), Ok(None));
        assert_eq!(slurp_area(true, "10 10 0 40", ""), Ok(None), "no area to ask about");
        // Anything else is said.
        assert_eq!(slurp_area(false, "", "compositor doesn't support zwlr_layer_shell_v1\n"), Err("Couldn't pick an area: compositor doesn't support zwlr_layer_shell_v1".into()));
        for garbage in ["", "10,20 30x40", "10 20 30", "10 20 30 40 50", "a b c d", "NaN 0 10 10", "inf 0 10 10"] {
            assert!(slurp_area(true, garbage, "").is_err(), "{garbage:?}");
        }
    }

    #[test]
    fn a_command_that_waits_on_the_user_is_given_up_on_in_time() {
        let started = Instant::now();
        let mut slow = Command::new("sleep");
        slow.arg("5");
        assert_eq!(output_within(slow, Duration::from_millis(200)).map(|o| o.is_none()), Ok(true), "walked away: killed, nothing back");
        assert!(started.elapsed() < Duration::from_secs(2), "not waited out");
        let mut quick = Command::new("sh");
        quick.args(["-c", "printf '1 2 3 4'; echo oops >&2; exit 0"]);
        let out = output_within(quick, Duration::from_secs(5)).expect("ran").expect("in time");
        assert!(out.status.success());
        assert_eq!((String::from_utf8_lossy(&out.stdout).as_ref(), String::from_utf8_lossy(&out.stderr).as_ref()), ("1 2 3 4", "oops\n"));
        assert!(output_within(Command::new("/nonexistent/slurp"), Duration::from_secs(1)).is_err(), "not there: an error");
    }

    #[test]
    fn slurp_is_found_on_the_path_when_it_can_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("path");
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("slurp"), "").unwrap();
        std::fs::set_permissions(a.join("slurp"), std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::write(b.join("slurp"), "").unwrap();
        std::fs::set_permissions(b.join("slurp"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([a.clone(), b.clone()]).unwrap();
        assert_eq!(on_path("slurp", Some(&path)), Some(b.join("slurp")), "the first one that can run");
        assert_eq!(on_path("slurp", Some(&std::env::join_paths([a]).unwrap())), None, "not runnable");
        assert_eq!(on_path("grim", Some(&path)), None);
        assert_eq!(on_path("slurp", None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_picked_area_is_cut_out_of_a_picture_of_every_screen() {
        // This desk (eDP-1 at scale 1.667, HDMI-A-1 to its right), captured at 7040x2400: 1.667 px a point.
        let desk = union_bounds(&[LAPTOP, SIDE]);
        assert_eq!(area_crop((7040, 2400), desk, [100.0, 200.0, 400.0, 300.0]), Some(((167, 333, 666, 500), [100.0, 200.0, 400.0, 300.0])), "on the laptop");
        assert_eq!(area_crop((7040, 2400), desk, [2500.0, 100.0, 600.0, 300.0]), Some(((4167, 167, 1000, 500), [2500.0, 100.0, 600.0, 300.0])), "on the monitor");
        assert_eq!(area_crop((7040, 2400), desk, [2000.0, 100.0, 800.0, 600.0]), Some(((3333, 167, 1334, 1000), [2000.0, 100.0, 800.0, 600.0])), "across both");
        // A screen left of the main one: the desk starts below zero.
        let west = union_bounds(&[[-1920.0, 0.0, 1920.0, 1080.0], [0.0, 0.0, 2560.0, 1440.0]]);
        assert_eq!(area_crop((4480, 1440), west, [-1000.0, 100.0, 500.0, 400.0]), Some(((920, 100, 500, 400), [-1000.0, 100.0, 500.0, 400.0])));
        // The whole desk picked: the whole picture.
        assert_eq!(area_crop((7040, 2400), desk, desk), Some(((0, 0, 7040, 2400), desk)));
        // Nowhere on the picture, or a picture that can't say where things are: none.
        assert_eq!(area_crop((7040, 2400), desk, [5000.0, 0.0, 100.0, 100.0]), None);
        assert_eq!(area_crop((1920, 1080), desk, [100.0, 100.0, 100.0, 100.0]), None);
        assert_eq!(area_crop((1920, 1080), desk, desk), None);
    }

    #[test]
    fn the_area_is_saved_shrunk_to_the_cap_with_where_it_is() {
        use gtk::gdk_pixbuf::{Colorspace, Pixbuf};
        let dir = scratch("area");
        let file = dir.join("area.png").to_string_lossy().into_owned();
        let desk = union_bounds(&[LAPTOP, SIDE]);
        // The laptop's part red, the monitor's blue: an area across both is red on its left and blue on its right.
        let capture = Pixbuf::new(Colorspace::Rgb, false, 8, 7040, 2400).expect("a picture");
        capture.fill(0x000000ff);
        capture.new_subpixbuf(0, 0, 3840, 2400).fill(0xff0000ff);
        capture.new_subpixbuf(3840, 0, 3200, 1800).fill(0x0000ffff);
        let across = [2000.0, 100.0, 800.0, 600.0];
        assert_eq!(save_area(&capture, &file, desk, across), Ok(Shot { pixels: (1334, 1000), bounds: across, screen: false }));
        assert_eq!(std::fs::read(&file).expect("saved")[..4], [0x89, b'P', b'N', b'G'], "a PNG, as the snap says");
        let p = Pixbuf::from_file(&file).expect("a PNG");
        assert_eq!((p.width(), p.height()), (1334, 1000));
        assert_eq!(pixel(&p, 4, 500), (255, 0, 0), "the laptop's side");
        assert_eq!(pixel(&p, 1330, 500), (0, 0, 255), "the monitor's side");
        // A big one is shrunk to Claude's cap, and still says where it is.
        assert_eq!(save_area(&capture, &file, desk, desk), Ok(Shot { pixels: (1568, 535), bounds: desk, screen: false }));
        assert!(save_area(&capture, &file, desk, [9000.0, 0.0, 10.0, 10.0]).is_err(), "off the desk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sidecar_is_told_the_areas_picture_and_place_or_that_none_was_picked() {
        let id = json!(3);
        assert_eq!(area_reply(&id, Ok(Some(Shot { pixels: (1334, 1000), bounds: [2000.0, 100.0, 800.0, 600.0], screen: false }))), json!({ "type": "area_done", "id": 3, "ok": true, "pixels": [1334, 1000], "bounds": [2000.0, 100.0, 800.0, 600.0] }));
        assert_eq!(area_reply(&id, Ok(None)), json!({ "type": "area_done", "id": 3, "ok": false, "cancelled": true }));
        assert_eq!(area_reply(&id, Err("no portal".into())), json!({ "type": "area_done", "id": 3, "ok": false, "error": "no portal" }));
    }

    #[test]
    fn the_portal_answers_on_a_path_made_from_the_bus_name_and_token() {
        assert_eq!(portal_request_path(":1.42", "roamies_7_0"), "/org/freedesktop/portal/desktop/request/1_42/roamies_7_0");
        assert_eq!(portal_request_path(":1.1024", "t"), "/org/freedesktop/portal/desktop/request/1_1024/t");
    }

    #[test]
    fn only_file_links_become_paths() {
        assert_eq!(file_uri_path("file:///home/kai/Pictures/Screenshot%20from%202026.png"), Some(PathBuf::from("/home/kai/Pictures/Screenshot from 2026.png")));
        assert_eq!(file_uri_path("file://localhost/tmp/a.png"), Some(PathBuf::from("/tmp/a.png")));
        assert_eq!(file_uri_path("file:///tmp/100%.png"), Some(PathBuf::from("/tmp/100%.png")), "a stray percent sign stays");
        assert_eq!(file_uri_path("file:///tmp/caf%C3%A9.png"), Some(PathBuf::from("/tmp/café.png")));
        assert_eq!(file_uri_path("https://example.com/a.png"), None);
        assert_eq!(file_uri_path("file://otherhost/tmp/a.png"), None);
        assert_eq!(file_uri_path("/tmp/a.png"), None);
    }

    #[test]
    fn click_areas_become_whole_pixel_rectangles() {
        assert_eq!(hit_rects(&[10.4, 20.6, 30.2, 40.0, 0.0, 0.0, 5.0, 5.0]), vec![(10, 20, 31, 40), (0, 0, 5, 5)]);
        assert_eq!(hit_rects(&[]), vec![]);
        // A trailing partial rectangle, an empty one and bad numbers are dropped.
        assert_eq!(hit_rects(&[1.0, 2.0, 3.0, 4.0, 9.0, 9.0]), vec![(1, 2, 3, 4)]);
        assert_eq!(hit_rects(&[1.0, 2.0, 0.0, 4.0, f64::NAN, 0.0, 5.0, 5.0, 0.0, 0.0, f64::INFINITY, 5.0, 0.0, 0.0, 1e9, 5.0]), vec![]);
        assert_eq!(hit_rects(&[-8.0, -8.0, 40.0, 40.0]), vec![(-8, -8, 40, 40)], "a pad can reach past the edge");
        assert_eq!(hit_rects(&[1.0; 4 * 1000]).len(), 600);
    }

    #[test]
    fn layer_surfaces_only_on_wayland_where_the_compositor_has_them() {
        let (yes, no, failed) = (|| Some(true), || Some(false), || None);
        assert!(layer_from(Session::Wayland, None, yes), "Wayland with layer-shell");
        assert!(!layer_from(Session::Wayland, None, no), "Wayland without it (GNOME): XWayland, as before");
        assert!(!layer_from(Session::Wayland, None, failed), "the compositor couldn't be asked: as before");
        assert!(!layer_from(Session::X11, None, yes), "an X11 session never");
        assert!(layer_from(Session::Wayland, Some(""), yes) && layer_from(Session::Wayland, Some("yes"), yes), "anything but 0 or 1 decides nothing");
        assert!(!layer_from(Session::Wayland, Some("maybe"), no));
    }

    #[test]
    fn the_override_wins_both_ways_without_asking_the_compositor() {
        let asked = std::cell::Cell::new(0);
        let ask = |answer: Option<bool>| { let asked = &asked; move || { asked.set(asked.get() + 1); answer } };
        assert!(!layer_from(Session::Wayland, Some("0"), ask(Some(true))), "0: never");
        assert!(layer_from(Session::Wayland, Some("1"), ask(Some(false))), "1: always on Wayland");
        assert!(layer_from(Session::Wayland, Some("1"), ask(None)));
        assert!(layer_from(Session::Wayland, Some(" 1 "), ask(None)), "spaces round it don't matter");
        assert!(!layer_from(Session::X11, Some("1"), ask(Some(true))), "1 can't make an X11 session Wayland");
        assert_eq!(asked.get(), 0, "the compositor is asked only when nothing was forced");
    }

    #[test]
    fn the_compositors_socket_is_a_name_in_the_runtime_dir_or_a_path() {
        assert_eq!(wayland_socket(Some("/run/user/1000"), Some("wayland-1")), Some(PathBuf::from("/run/user/1000/wayland-1")));
        assert_eq!(wayland_socket(Some("/run/user/1000"), None), Some(PathBuf::from("/run/user/1000/wayland-0")), "the default name");
        assert_eq!(wayland_socket(Some("/run/user/1000"), Some("")), Some(PathBuf::from("/run/user/1000/wayland-0")));
        assert_eq!(wayland_socket(None, Some("/tmp/sock/wl")), Some(PathBuf::from("/tmp/sock/wl")), "a whole path needs no runtime dir");
        assert_eq!(wayland_socket(Some("/run/user/1000"), Some("/tmp/sock/wl")), Some(PathBuf::from("/tmp/sock/wl")));
        assert_eq!(wayland_socket(None, Some("wayland-1")), None);
        assert_eq!(wayland_socket(Some(""), Some("wayland-1")), None);
    }

    /// One Wayland message: who it is from, what it says, and its arguments already as bytes.
    fn wl_msg(object: u32, opcode: u16, args: &[u8]) -> Vec<u8> {
        let mut m = object.to_ne_bytes().to_vec();
        m.extend((((8 + args.len()) as u32) << 16 | opcode as u32).to_ne_bytes());
        m.extend(args);
        m
    }

    /// wl_registry.global: a number, the interface's name (counted with its closing zero, padded to four bytes)
    /// and its version.
    fn wl_global(name: u32, interface: &str, version: u32) -> Vec<u8> {
        let mut args = name.to_ne_bytes().to_vec();
        args.extend((interface.len() as u32 + 1).to_ne_bytes());
        args.extend(interface.as_bytes());
        args.extend(std::iter::repeat(0u8).take(4 - interface.len() % 4));
        args.extend(version.to_ne_bytes());
        wl_msg(2, 0, &args)
    }

    fn wl_done() -> Vec<u8> {
        wl_msg(3, 0, &7u32.to_ne_bytes())
    }

    #[test]
    fn the_compositors_list_is_read_until_it_ends() {
        const LAYER: &str = "zwlr_layer_shell_v1";
        let some: Vec<u8> = [wl_global(1, "wl_compositor", 6), wl_global(2, "wl_shm", 1), wl_global(3, "xdg_wm_base", 7)].concat();
        assert_eq!(registry_reply(&[], LAYER), Ok(None), "nothing yet");
        assert_eq!(registry_reply(&some, LAYER), Ok(None), "the list isn't over");
        assert_eq!(registry_reply(&[some.clone(), wl_done()].concat(), LAYER), Ok(Some(false)), "over, and it wasn't there");
        let with: Vec<u8> = [some.clone(), wl_global(35, LAYER, 5)].concat();
        assert_eq!(registry_reply(&with, LAYER), Ok(Some(true)), "there: no need to wait for the end");
        assert_eq!(registry_reply(&[with.clone(), wl_done()].concat(), LAYER), Ok(Some(true)));
        assert_eq!(registry_reply(&with[..with.len() - 6], LAYER), Ok(None), "half a message: more is coming");
        assert_eq!(registry_reply(&[wl_global(1, "zwlr_layer_shell_v1_not", 1), wl_global(2, "zwlr_layer_shell", 1), wl_done()].concat(), LAYER), Ok(Some(false)), "the whole name or nothing");
        // Things said in between (an id being freed) are skipped; an error ends it.
        assert_eq!(registry_reply(&[wl_msg(1, 1, &9u32.to_ne_bytes()), with.clone()].concat(), LAYER), Ok(Some(true)));
        assert_eq!(registry_reply(&[wl_msg(1, 0, &[0; 12]), with.clone()].concat(), LAYER), Err(()), "wl_display.error");
        // Nonsense: a message shorter than its own header, a name longer than its message.
        assert_eq!(registry_reply(&[2u32.to_ne_bytes(), (4u32 << 16).to_ne_bytes()].concat(), LAYER), Err(()));
        let mut bad = wl_global(1, "wl_shm", 1);
        bad[12..16].copy_from_slice(&400u32.to_ne_bytes());
        assert_eq!(registry_reply(&[bad, wl_done()].concat(), LAYER), Err(()));
    }

    /// A compositor made of a socket: it waits for the two requests, says what it was told to and hangs up.
    fn fake_compositor(name: &str, reply: Vec<u8>) -> (PathBuf, std::thread::JoinHandle<Vec<u8>>) {
        use std::io::{Read, Write};
        let path = scratch(name).join("wayland-test");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let served = std::thread::spawn(move || {
            let (mut client, _) = listener.accept().unwrap();
            let mut asked = [0u8; 24];
            client.read_exact(&mut asked).unwrap();
            client.write_all(&reply).unwrap();
            asked.to_vec()
        });
        (path, served)
    }

    #[test]
    fn a_compositor_is_asked_for_layer_shell_over_its_socket() {
        const LAYER: &str = "zwlr_layer_shell_v1";
        let (path, served) = fake_compositor("wl-offers", [wl_global(1, "wl_compositor", 6), wl_global(35, LAYER, 5), wl_done()].concat());
        assert_eq!(compositor_offers(&path, LAYER), Some(true));
        // What was asked: wl_display.get_registry as object 2, then wl_display.sync as object 3.
        let asked = served.join().unwrap();
        let word = |i: usize| u32::from_ne_bytes(asked[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!([word(0), word(1), word(2), word(3), word(4), word(5)], [1, 12 << 16 | 1, 2, 1, 12 << 16, 3]);

        let (path, served) = fake_compositor("wl-lacks", [wl_global(1, "wl_compositor", 6), wl_global(2, "xdg_wm_base", 7), wl_done()].concat());
        assert_eq!(compositor_offers(&path, LAYER), Some(false), "GNOME");
        served.join().unwrap();

        let (path, served) = fake_compositor("wl-hangs-up", wl_global(1, "wl_compositor", 6));
        assert_eq!(compositor_offers(&path, LAYER), None, "hung up before the list was over");
        served.join().unwrap();

        let (path, served) = fake_compositor("wl-nonsense", vec![0xff; 64]);
        assert_eq!(compositor_offers(&path, LAYER), None);
        served.join().unwrap();

        assert_eq!(compositor_offers(&scratch("wl-none").join("wayland-9"), LAYER), None, "no socket there");
        for name in ["wl-offers", "wl-lacks", "wl-hangs-up", "wl-nonsense", "wl-none"] {
            let _ = std::fs::remove_dir_all(scratch(name));
        }
    }

    #[test]
    fn a_screen_is_found_again_by_where_it_is() {
        let all = [(0, 0, 2304, 1440), (2304, 0, 1920, 1080), (0, 1440, 1280, 720)];
        assert_eq!(monitor_at(&all, (0.0, 0.0, 2304.0, 1440.0)), Some(0));
        assert_eq!(monitor_at(&all, (2304.0, 0.0, 1920.0, 1080.0)), Some(1));
        assert_eq!(monitor_at(&all, (2303.6, 0.4, 1920.2, 1079.5)), Some(1), "give or take rounding at a fractional scale");
        assert_eq!(monitor_at(&all, (0.0, 1440.0, 1280.0, 720.0)), Some(2));
        assert_eq!(monitor_at(&all, (5000.0, 0.0, 1920.0, 1080.0)), None, "unplugged meanwhile");
        assert_eq!(monitor_at(&[], (0.0, 0.0, 1920.0, 1080.0)), None);
    }

    #[test]
    fn a_slot_is_only_its_own_screens() {
        let dock = dock_from(r#"{"x":1500,"y":23,"sw":1920,"sh":1080,"mx":2304,"my":0}"#).unwrap();
        assert!(dock_on(&dock, Some((2304.0, 0.0, 1920.0, 1080.0)), 2));
        assert!(!dock_on(&dock, Some((0.0, 0.0, 2304.0, 1440.0)), 2), "another screen's slot isn't this overlay's");
        assert!(!dock_on(&dock, None, 2), "nor an overlay's whose screen isn't known");
        assert!(dock_on(&dock, Some((0.0, 0.0, 2304.0, 1440.0)), 1) && dock_on(&dock, None, 1), "the only screen: whatever the note says of it");
    }

    #[test]
    fn the_overlay_follows_the_bars_note_to_the_screen_in_use() {
        // This desktop: a laptop panel at a fractional scale and an external screen to its right.
        let screens = [(0.0, 0.0, 2304.0, 1440.0), (2304.0, 0.0, 1920.0, 1080.0)];
        let on_laptop = r#"{"monitor":"eDP-1","x":1803,"y":23,"sw":2304,"sh":1440,"mx":0,"my":0}"#;
        let on_external = r#"{"monitor":"HDMI-A-1","x":1500,"y":23,"sw":1920,"sh":1080,"mx":2304,"my":0}"#;
        assert_eq!(dock_move(Some(on_laptop), Some(0), &screens, false), None, "the note names the overlay's screen: it stays");
        assert_eq!(dock_move(Some(on_external), Some(1), &screens, false), None);
        assert_eq!(dock_move(Some(on_external), Some(0), &screens, false), Some(1), "the other screen came into use, nothing on screen: it goes there");
        assert_eq!(dock_move(Some(on_laptop), Some(1), &screens, false), Some(0), "and back");
        assert_eq!(dock_move(Some(on_external), Some(0), &screens, true), None, "never under something of the Roamie's that is on screen");
        assert_eq!(dock_move(Some(on_laptop), Some(1), &screens, true), None);
        assert_eq!(dock_move(Some(on_external), None, &screens, false), Some(1), "an overlay the compositor placed goes where the note says");
        assert_eq!(dock_move(Some(on_external), Some(0), &screens[..1], false), None, "one screen: nowhere to go");
        assert_eq!(dock_move(Some(on_external), Some(0), &[], false), None);
        assert_eq!(dock_move(None, Some(0), &screens, false), None, "no bar left a note");
        for bad in ["", "{", "[]", r#"{"x":1500,"y":23}"#, r#"{"x":5000,"y":23,"sw":1920,"sh":1080,"mx":2304,"my":0}"#, r#"{"x":"1500","y":23,"sw":1920,"sh":1080,"mx":2304,"my":0}"#] {
            assert_eq!(dock_move(Some(bad), Some(0), &screens, false), None, "not a note: {bad}");
        }
        // A note without a place for its screen says the first one (dock_from), as it always did.
        assert_eq!(dock_move(Some(r#"{"x":1803,"y":23,"sw":2304,"sh":1440}"#), Some(1), &screens, false), Some(0));
        assert_eq!(dock_move(Some(r#"{"x":900,"y":23,"sw":1280,"sh":720,"mx":4224,"my":0}"#), Some(0), &screens, false), None, "a screen that isn't there (unplugged meanwhile)");
        assert_eq!(dock_move(Some(r#"{"x":1500,"y":23,"sw":1920.4,"sh":1079.6,"mx":2303.5,"my":0.3}"#), Some(0), &screens, false), Some(1), "give or take rounding");
    }

    #[test]
    fn a_bars_slot_says_how_much_of_the_screen_the_bar_takes() {
        let slot = |x: f64, y: f64| dock_from(&json!({ "x": x, "y": y, "sw": 2304, "sh": 1440 }).to_string()).unwrap();
        assert_eq!(slot_insets(&slot(1803.0, 23.0), 2304.0), (46.0, 0.0), "a bar along the top: twice the way down to the slot's centre");
        assert_eq!(slot_insets(&slot(400.0, 1420.0), 2304.0), (0.0, 40.0), "a bar along the bottom");
        assert_eq!(slot_insets(&slot(1803.0, 23.0), 1152.0), (23.0, 0.0), "in the overlay's px when the bar measured in others");
        assert_eq!(slot_insets(&slot(100.0, 0.0), 2304.0), (0.0, 0.0));
        assert_eq!(slot_insets(&slot(20.0, 700.0), 2304.0), (0.0, 0.0), "a bar down a side says nothing about the top or bottom");
    }

    #[test]
    fn the_session_is_wayland_when_either_sign_says_so() {
        assert_eq!(session_from(Some("x11"), None), Session::X11);
        assert_eq!(session_from(None, None), Session::X11, "Xvfb and bare X servers set nothing");
        assert_eq!(session_from(Some("x11"), Some("")), Session::X11);
        assert_eq!(session_from(Some("wayland"), Some("wayland-0")), Session::Wayland);
        assert_eq!(session_from(None, Some("wayland-1")), Session::Wayland);
        assert_eq!(session_from(Some("Wayland"), None), Session::Wayland);
        assert_eq!(session_from(Some("tty"), Some("wayland-0")), Session::Wayland, "a compositor started from a console");
    }

    #[test]
    fn a_whole_overlay_click_area_the_page_stopped_sending_is_dropped() {
        let size = (2304, 1440);
        let roamie = (1700, 30, 200, 180);
        let whole = (0, 0, 2304, 1440);
        let fresh = Duration::from_secs(2);
        let stale = WHOLE_STALE + Duration::from_millis(100);
        assert_eq!(stale_whole(&[whole, roamie], size, fresh), None, "sent again lately: it stands");
        assert_eq!(stale_whole(&[whole, roamie], size, stale), Some(vec![roamie]), "not sent again: it goes, the Roamie's own areas stay");
        assert_eq!(stale_whole(&[roamie, whole], size, stale), Some(vec![roamie]), "wherever it is in the list");
        assert_eq!(stale_whole(&[whole], size, stale), Some(vec![]), "alone: nothing takes clicks");
        assert_eq!(stale_whole(&[(-8, -8, 2320, 1456)], size, stale), Some(vec![]), "a little past the edges is the whole overlay too");
        // The Roamie's own areas never go, however old they are.
        assert_eq!(stale_whole(&[roamie], size, Duration::from_secs(3600)), None);
        assert_eq!(stale_whole(&[], size, Duration::from_secs(3600)), None);
        assert_eq!(stale_whole(&[(0, 0, 2304, 1400), (0, 0, 2000, 1440)], size, stale), None, "big, but not the whole overlay");
        assert_eq!(stale_whole(&[whole], (0, 0), stale), None, "a window with no size yet: nothing to tell");
    }

    #[test]
    fn a_stroke_from_the_page_is_its_points() {
        assert_eq!(pen_stroke(&[2400.5, 300.0, 2410.0, 310.0]), Some(vec![(2400.5, 300.0), (2410.0, 310.0)]));
        assert_eq!(pen_stroke(&[1.0, 2.0, 3.0]), Some(vec![(1.0, 2.0)]), "an odd number out is dropped");
        assert_eq!(pen_stroke(&[f64::NAN, 2.0, 3.0, 4.0, 1e9, 1.0]), Some(vec![(3.0, 4.0)]), "points that make no sense are dropped");
        assert_eq!(pen_stroke(&[]), None);
        assert_eq!(pen_stroke(&[f64::INFINITY, 0.0]), None);
        assert_eq!(pen_stroke(&vec![5.0; PEN_POINTS * 2 + 40]).map(|s| s.len()), Some(PEN_POINTS), "a runaway one is cut off");
    }

    fn arc(cx: f64, cy: f64, r: f64, turns: f64) -> Vec<(f64, f64)> {
        (0..=80).map(|k| {
            let a = turns * 2.0 * std::f64::consts::PI * k as f64 / 80.0;
            (cx + r * a.cos(), cy + r * a.sin())
        }).collect()
    }

    // The same numbers as the helper's (voice-win/src/ink.rs the_capture_is_round_the_circle_and_on_its_screen).
    #[test]
    fn the_marked_part_is_round_the_strokes_and_on_their_screen() {
        let c = arc(300.0, 300.0, 60.0, 1.0);
        assert_eq!(pen_box(&[c.clone()], [0.0, 0.0, 1920.0, 1080.0]), Some([140.0, 190.0, 320.0, 220.0]));
        let edge = arc(30.0, 30.0, 20.0, 1.0);
        assert_eq!(pen_box(&[edge], [0.0, 0.0, 1920.0, 1080.0]).map(|b| (b[0], b[1])), Some((0.0, 0.0)), "cut to the screen");
        assert_eq!(pen_box(&[arc(2604.0, 300.0, 60.0, 1.0)], SIDE), Some([2444.0, 190.0, 320.0, 220.0]), "on the second screen, in global points");
        assert_eq!(pen_box(&[], LAPTOP), None);
        assert_eq!(pen_box(&[arc(5000.0, 300.0, 60.0, 1.0)], LAPTOP), None, "nowhere on the screen");
        let long: Vec<(f64, f64)> = (0..200).map(|k| (k as f64, 0.0)).collect();
        let m = pen_marks(&[long]);
        assert!(m[0].len() <= 52 && m[0][0] == [0, 0] && m[0].last() == Some(&[199, 0]), "a long stroke is thinned, its ends kept");
    }

    #[test]
    fn the_marked_picture_has_the_strokes_drawn_on_it_and_goes_as_the_helpers_does() {
        use gtk::gdk_pixbuf::{Colorspace, Pixbuf};
        let dir = scratch("pen");
        let file = dir.join("marked.png").to_string_lossy().into_owned();
        let desk = union_bounds(&[LAPTOP, SIDE]);
        // Both screens at their real size, white: a line across the second screen at y = 300.
        let capture = Pixbuf::new(Colorspace::Rgb, false, 8, 4224, 1440).expect("a picture");
        capture.fill(0xffffffff);
        let stroke = vec![(2500.0, 300.0), (2700.0, 300.0)];
        let area = pen_box(&[stroke.clone()], SIDE).expect("a box");
        let bounds = save_marked(&capture, &file, desk, area, &[stroke.clone()]).expect("saved");
        assert_eq!(bounds, area, "the part of the screen asked for");
        let p = Pixbuf::from_file(&file).expect("a PNG");
        assert_eq!((p.width(), p.height()), (bounds[2] as i32, bounds[3] as i32), "at the screen's own scale");
        // The pen's teal on the line, white away from it (the helper's colours: voice-win/src/ink.rs draw_strokes).
        let at = |x: f64, y: f64| pixel(&p, (x - bounds[0]) as i32, (y - bounds[1]) as i32);
        assert_eq!(at(2600.0, 300.0), (0x78, 0xff, 0xe2), "the pen's teal on the line");
        assert_eq!(at(2600.0, 330.0), (255, 255, 255), "untouched away from it");
        let edge = at(2600.0, 303.5);
        assert!(edge.0 < 200 && edge.2 < 230, "a dark edge round it {edge:?}");
        // What the sidecar gets: the helper's `area`, in the same shape.
        let reply = pen_reply(&file, bounds, &[stroke]);
        assert_eq!(reply, json!({ "file": file, "rect": [2440, 190, 320, 220], "strokes": [[[2500, 300], [2700, 300]]] }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
