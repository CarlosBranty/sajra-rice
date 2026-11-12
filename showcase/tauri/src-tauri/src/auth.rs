// Checking it's the user before a protected money change (Linux): the computer password or a fingerprint, checked by
// the system's PAM as the glyph lock screen does (~/.local/share/glyph/config/quickshell/glyph/lock.qml). Two
// conversations run side by side, each with the lock's own config: the password (pam_faillock around pam_unix, so a
// wrong one counts with the system's failures) and the finger (pam_fprintd). Whichever succeeds first ends both.
//
// The sidecar asks ({type:'auth', id, reason}); the overlay shows the prompt ({kind:'auth'}, host.js, agent-auth.js)
// and sends the password straight here (auth_password, main.rs), never through the sidecar, a log or diagnostics;
// it is wiped once PAM has it. Only the shell tells the sidecar how it went ({type:'auth_result', id, ok, why}), and
// pages can't send that type (main.rs page_may_send). One request at a time: a second is refused ("busy").
//
// libpam is opened at run time, so building needs no PAM package. pam_start_confdir (Linux-PAM 1.4) reads the config
// from a folder made for each attempt under $XDG_RUNTIME_DIR/roamies/ (0700) from text compiled in here, and removed
// after: no file the user could edit between runs decides the outcome. Without it, it fails closed.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fs;
use std::io::Write as _;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{compiler_fence, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::{ptr, thread};

use serde_json::{json, Value};
use tauri::AppHandle;

/// The lock's `pam/lock`: faillock refuses while the account is locked and counts the failure, pam_unix checks it.
pub(crate) const PASSWORD_CONF: &str = "#%PAM-1.0
# Roamies: the user's password before a money change (auth.rs), as the glyph lock checks it; faillock counts failures.
auth    required                    pam_faillock.so     preauth
auth    [success=1 default=bad]     pam_unix.so         nullok
auth    [default=die]               pam_faillock.so     authfail
auth    required                    pam_faillock.so     authsucc
";
/// The lock's `pam/fprint`: no fprintd, reader or finger answers at once (finger_step stops asking then).
pub(crate) const FINGER_CONF: &str = "#%PAM-1.0
# Roamies: a fingerprint before a money change (auth.rs), alongside the password, as the glyph lock does.
auth    required    pam_fprintd.so    max-tries=3 timeout=30
";
pub(crate) const PASSWORD_SERVICE: &str = "roamies";
pub(crate) const FINGER_SERVICE: &str = "roamies-fprint";

const PAM_SUCCESS: c_int = 0;
const PAM_SYSTEM_ERR: c_int = 4;
const PAM_BUF_ERR: c_int = 5;
const PAM_AUTH_ERR: c_int = 7;
const PAM_MAXTRIES: c_int = 11;
const PAM_CONV_ERR: c_int = 19;
const PAM_PROMPT_ECHO_OFF: c_int = 1;
const PAM_PROMPT_ECHO_ON: c_int = 2;
const PAM_ERROR_MSG: c_int = 3;
const PAM_TEXT_INFO: c_int = 4;
const PAM_MAX_NUM_MSG: c_int = 32;
/// Linux-PAM's longest answer (PAM_MAX_RESP_SIZE).
const MAX_PASSWORD: usize = 512;

#[repr(C)]
struct PamMessage {
    style: c_int,
    msg: *const c_char,
}
#[repr(C)]
struct PamResponse {
    resp: *mut c_char,
    retcode: c_int,
}
type ConvFn = unsafe extern "C" fn(c_int, *mut *const PamMessage, *mut *mut PamResponse, *mut c_void) -> c_int;
#[repr(C)]
struct PamConv {
    conv: ConvFn,
    appdata: *mut c_void,
}

/// How a PAM run ended, as the lock tells them apart: success, not you (a wrong password, a finger not recognised),
/// or anything else (no reader, a timeout, a broken setup).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Outcome {
    Success,
    Failed,
    Error,
}

pub(crate) fn outcome(rc: c_int) -> Outcome {
    match rc {
        PAM_SUCCESS => Outcome::Success,
        PAM_AUTH_ERR | PAM_MAXTRIES => Outcome::Failed,
        _ => Outcome::Error,
    }
}

/// What the prompt says after a password was checked (None: it was the user). faillock says the account is locked
/// in an error message, and then even the right password fails until it unlocks.
pub(crate) fn password_state(o: Outcome, locked: bool) -> Option<&'static str> {
    match o {
        Outcome::Success => None,
        _ if locked => Some("locked"),
        Outcome::Failed => Some("wrong"),
        Outcome::Error => Some("error"),
    }
}

/// Zeroes bytes in a way the compiler keeps.
fn wipe(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        unsafe { ptr::write_volatile(b, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// A typed password: its bytes are zeroed when it is dropped (the String it came from is moved in, not copied).
pub(crate) struct Secret(Vec<u8>);

impl From<String> for Secret {
    fn from(s: String) -> Self {
        Secret(s.into_bytes())
    }
}

impl Secret {
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
    pub(crate) fn wipe(&mut self) {
        wipe(&mut self.0);
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.wipe();
    }
}

/// One conversation's side: the password to give the one hidden prompt (None for the finger's), and what to do with
/// PAM's messages (error: true for PAM_ERROR_MSG).
pub(crate) struct Conv {
    secret: Option<Secret>,
    notes: Notes,
}
type Notes = Box<dyn FnMut(bool, &str) + Send>;

impl Conv {
    pub(crate) fn new(secret: Option<Secret>, notes: Notes) -> Self {
        Conv { secret, notes }
    }

    /// The password as PAM frees it (malloc'd, NUL-ended), given once; this copy is wiped as it goes.
    fn answer(&mut self) -> Option<*mut c_char> {
        let s = self.secret.as_ref()?;
        if s.0.contains(&0) {
            return None;
        }
        let s = self.secret.take()?;
        let p = unsafe { libc::calloc(s.len() + 1, 1) } as *mut u8;
        if p.is_null() {
            return None;
        }
        unsafe { ptr::copy_nonoverlapping(s.0.as_ptr(), p, s.len()) };
        Some(p as *mut c_char)
    }
}

/// Frees a reply array and whatever answers are in it, wiping them first.
unsafe fn drop_responses(resp: *mut PamResponse, n: usize) {
    for i in 0..n {
        let r = &mut *resp.add(i);
        if !r.resp.is_null() {
            let len = libc::strlen(r.resp);
            wipe(std::slice::from_raw_parts_mut(r.resp as *mut u8, len));
            libc::free(r.resp as *mut c_void);
        }
    }
    libc::free(resp as *mut c_void);
}

/// The PAM conversation: the password for the hidden prompt (once), messages to `notes`, and an error for anything
/// else (a visible prompt, a second password prompt), with nothing handed back.
unsafe extern "C" fn converse(n: c_int, msgs: *mut *const PamMessage, resp: *mut *mut PamResponse, data: *mut c_void) -> c_int {
    if n <= 0 || n > PAM_MAX_NUM_MSG || msgs.is_null() || resp.is_null() || data.is_null() {
        return PAM_CONV_ERR;
    }
    let n = n as usize;
    let out = libc::calloc(n, std::mem::size_of::<PamResponse>()) as *mut PamResponse;
    if out.is_null() {
        return PAM_BUF_ERR;
    }
    let conv = &mut *(data as *mut Conv);
    let answered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for i in 0..n {
            let m = *msgs.add(i);
            if m.is_null() {
                return false;
            }
            let m = &*m;
            let text = if m.msg.is_null() { "".into() } else { CStr::from_ptr(m.msg).to_string_lossy() };
            match m.style {
                PAM_PROMPT_ECHO_OFF => match conv.answer() {
                    Some(p) => (*out.add(i)).resp = p,
                    None => return false,
                },
                PAM_ERROR_MSG => (conv.notes)(true, &text),
                PAM_TEXT_INFO => (conv.notes)(false, &text),
                // The user name was given to pam_start: nothing visible is ever typed here.
                PAM_PROMPT_ECHO_ON => return false,
                _ => return false,
            }
        }
        true
    }));
    if !matches!(answered, Ok(true)) {
        drop_responses(out, n);
        return PAM_CONV_ERR;
    }
    *resp = out;
    PAM_SUCCESS
}

type StartFn = unsafe extern "C" fn(*const c_char, *const c_char, *const PamConv, *const c_char, *mut *mut c_void) -> c_int;
type AuthFn = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type EndFn = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;

/// libpam's three calls, found at run time.
pub(crate) struct Pam {
    start: StartFn,
    authenticate: AuthFn,
    end: EndFn,
}

impl Pam {
    pub(crate) fn load(lib: &CStr) -> Result<Pam, String> {
        unsafe {
            let h = libc::dlopen(lib.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
            if h.is_null() {
                return Err(format!("PAM isn't available here ({} could not be loaded)", lib.to_string_lossy()));
            }
            let (s, a, e) = (libc::dlsym(h, c"pam_start_confdir".as_ptr()), libc::dlsym(h, c"pam_authenticate".as_ptr()), libc::dlsym(h, c"pam_end".as_ptr()));
            if s.is_null() || a.is_null() || e.is_null() {
                libc::dlclose(h);
                return Err("this system's PAM is older than Linux-PAM 1.4 (no pam_start_confdir)".into());
            }
            // Kept open for good: the functions are used for as long as the app runs.
            Ok(Pam { start: std::mem::transmute::<*mut c_void, StartFn>(s), authenticate: std::mem::transmute::<*mut c_void, AuthFn>(a), end: std::mem::transmute::<*mut c_void, EndFn>(e) })
        }
    }
}

fn pam() -> Result<&'static Pam, String> {
    static PAM: OnceLock<Result<Pam, String>> = OnceLock::new();
    PAM.get_or_init(|| Pam::load(c"libpam.so.0")).as_ref().map_err(Clone::clone)
}

/// $XDG_RUNTIME_DIR, the user's own private folder for the session (an absolute path to a folder), or why not.
pub(crate) fn runtime_dir_from(v: Option<std::ffi::OsString>) -> Result<PathBuf, String> {
    let p = PathBuf::from(v.ok_or("XDG_RUNTIME_DIR isn't set")?);
    if !p.is_absolute() || !p.is_dir() {
        return Err("XDG_RUNTIME_DIR isn't a folder".into());
    }
    Ok(p)
}

/// The folder the configs go in must be a real folder of this user that nobody else can enter: a symlink, or one
/// made by someone else or left open, could let another config be read in place of ours.
pub(crate) fn private_dir(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::symlink_metadata(p)?;
    let me = unsafe { libc::geteuid() };
    if !m.file_type().is_dir() || m.uid() != me || m.mode() & 0o077 != 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the runtime folder for Hanami isn't private"));
    }
    Ok(())
}

/// A folder with one PAM config in it, made for one attempt (0700, the file 0600) and removed when dropped.
pub(crate) struct ConfDir {
    pub(crate) path: PathBuf,
}

impl ConfDir {
    pub(crate) fn new(base: &Path, service: &str, text: &str) -> std::io::Result<ConfDir> {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        if !base.is_dir() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no runtime folder"));
        }
        let root = base.join("roamies");
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&root)?;
        private_dir(&root)?;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
        let path = root.join(format!("auth-{}-{}-{nanos:x}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        // Not recursive: an existing folder of that name is an error, never reused.
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        let dir = ConfDir { path };
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dir.path.join(service))?;
        f.write_all(text.as_bytes())?;
        Ok(dir)
    }
}

impl Drop for ConfDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// The user this app runs as, from the password database (not $USER).
fn user() -> Option<CString> {
    unsafe {
        let mut pw: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0 as c_char; 16384];
        let mut found: *mut libc::passwd = ptr::null_mut();
        let rc = libc::getpwuid_r(libc::getuid(), &mut pw, buf.as_mut_ptr(), buf.len(), &mut found);
        (rc == 0 && !found.is_null() && !pw.pw_name.is_null()).then(|| CStr::from_ptr(pw.pw_name).to_owned())
    }
}

/// Everything a run needs, or why it can't run at all.
fn ready() -> Result<(&'static Pam, CString, PathBuf), String> {
    let pam = pam()?;
    let user = user().ok_or("the user's name couldn't be found")?;
    let base = runtime_dir_from(std::env::var_os("XDG_RUNTIME_DIR"))?;
    Ok((pam, user, base))
}

/// One PAM authentication of the current user with this service's config: its return code.
fn run(service: &str, conf: &str, conv: &mut Conv) -> Result<c_int, String> {
    let (pam, user, base) = ready()?;
    let dir = ConfDir::new(&base, service, conf).map_err(|e| format!("the PAM config couldn't be written: {e}"))?;
    let svc = CString::new(service).map_err(|_| "bad service name")?;
    let confdir = CString::new(dir.path.as_os_str().as_bytes()).map_err(|_| "bad config folder")?;
    let pc = PamConv { conv: converse, appdata: conv as *mut Conv as *mut c_void };
    let mut h: *mut c_void = ptr::null_mut();
    let rc = unsafe { (pam.start)(svc.as_ptr(), user.as_ptr(), &pc, confdir.as_ptr(), &mut h) };
    if rc != PAM_SUCCESS || h.is_null() {
        return Ok(if rc == PAM_SUCCESS { PAM_SYSTEM_ERR } else { rc });
    }
    let rc = unsafe { (pam.authenticate)(h, 0) };
    unsafe { (pam.end)(h, rc) };
    drop(dir);
    Ok(rc)
}

/// Where pam_fprintd may be. Without it the prompt is password only from the start (the lock checks the same).
fn finger_module() -> bool {
    ["/usr/lib/security", "/usr/lib64/security", "/lib/security", "/lib64/security", "/usr/lib/x86_64-linux-gnu/security", "/lib/x86_64-linux-gnu/security", "/usr/lib/aarch64-linux-gnu/security"]
        .iter()
        .any(|d| Path::new(d).join("pam_fprintd.so").exists())
}

// ---------------------------------------------------------------- the request in progress

/// How long a reader found missing (or with no finger) keeps the prompt password only.
const FINGER_GONE_FOR: Duration = Duration::from_secs(10 * 60);
/// The shell's own limit, past the sidecar's (60 s), for when the sidecar never says it gave up.
const REQUEST_LIMIT: Duration = Duration::from_secs(90);

pub(crate) struct Req {
    id: String,
    busy: bool,
    finger: bool,
}

#[derive(Default)]
pub(crate) struct Gate {
    cur: Option<Req>,
    /// The fingerprint loop is running (it serves whichever request is current).
    finger_loop: bool,
    /// When the reader last answered "nothing to read with".
    pub(crate) finger_gone: Option<Instant>,
}

impl Gate {
    /// Starts a request; whether it asks for the finger too. Refused while another is open, or for an odd id.
    pub(crate) fn begin(&mut self, id: &str, finger_ok: bool, now: Instant) -> Result<bool, &'static str> {
        if id.is_empty() || id.len() > 64 {
            return Err("bad");
        }
        if self.cur.is_some() {
            return Err("busy");
        }
        let finger = finger_ok && !self.finger_gone.is_some_and(|t| now.saturating_duration_since(t) < FINGER_GONE_FOR);
        self.cur = Some(Req { id: id.to_owned(), busy: false, finger });
        Ok(finger)
    }
    pub(crate) fn is(&self, id: &str) -> bool {
        self.cur.as_ref().is_some_and(|r| r.id == id)
    }
    fn current(&self) -> Option<String> {
        self.cur.as_ref().map(|r| r.id.clone())
    }
    /// A password may be checked now (this request, none being checked).
    pub(crate) fn try_password(&mut self, id: &str) -> bool {
        match self.cur.as_mut() {
            Some(r) if r.id == id && !r.busy => {
                r.busy = true;
                true
            }
            _ => false,
        }
    }
    /// The password was checked; false when its request has gone meanwhile.
    pub(crate) fn password_done(&mut self, id: &str) -> bool {
        match self.cur.as_mut() {
            Some(r) if r.id == id => {
                r.busy = false;
                true
            }
            _ => false,
        }
    }
    /// Ends this request; false when it isn't the one open.
    pub(crate) fn end(&mut self, id: &str) -> bool {
        if !self.is(id) {
            return false;
        }
        self.cur = None;
        true
    }
}

/// After one fingerprint run that didn't succeed: quick is how many runs in a row ended within 2 s, miss whether a
/// finger was not recognised, again whether to ask once more (as the lock: three quick answers in a row mean there is
/// nothing to read with).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FingerStep {
    pub(crate) quick: u32,
    pub(crate) miss: bool,
    pub(crate) again: bool,
}

pub(crate) fn finger_step(o: Outcome, took: Duration, quick: u32) -> FingerStep {
    let quick = if took < Duration::from_secs(2) { quick + 1 } else { 0 };
    FingerStep { quick, miss: o == Outcome::Failed, again: quick < 3 }
}

static GATE: Mutex<Gate> = Mutex::new(Gate { cur: None, finger_loop: false, finger_gone: None });

fn gate() -> std::sync::MutexGuard<'static, Gate> {
    GATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// To the overlay the Roamie is in (host.js), from any thread.
fn overlay(app: &AppHandle, msg: Value) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || crate::to_overlays(&a, &msg));
}

fn result(app: &AppHandle, id: &str, ok: bool, why: &str) {
    crate::to_sidecar(app, &json!({ "type": "auth_result", "id": id, "ok": ok, "why": why }));
}

/// Ends the request with this id (if it is still the one open): the sidecar hears how it went, the prompt goes.
fn finish(app: &AppHandle, id: &str, ok: bool, why: &str) {
    if !gate().end(id) {
        return;
    }
    eprintln!("auth: {why}");
    overlay(app, json!({ "kind": "auth_end", "id": id, "ok": ok }));
    result(app, id, ok, why);
}

/// The sidecar asks: show the prompt with the reason, and start listening for the finger.
pub(crate) fn begin(app: &AppHandle, id: String, reason: String) {
    if let Err(e) = ready() {
        eprintln!("auth: unavailable: {e}");
        return result(app, &id, false, "unavailable");
    }
    let finger = {
        let mut g = gate();
        match g.begin(&id, finger_module(), Instant::now()) {
            Err(why) => {
                drop(g);
                return result(app, &id, false, why);
            }
            Ok(f) => {
                if f && !g.finger_loop {
                    g.finger_loop = true;
                    let a = app.clone();
                    thread::spawn(move || finger_loop(a));
                }
                f
            }
        }
    };
    let reason: String = reason.chars().take(300).collect();
    overlay(app, json!({ "kind": "auth", "id": id, "reason": reason, "finger": finger }));
    crate::to_sidecar(app, &json!({ "type": "auth_open", "id": id }));
    let a = app.clone();
    thread::spawn(move || {
        thread::sleep(REQUEST_LIMIT);
        finish(&a, &id, false, "timeout");
    });
}

/// The prompt was closed (Esc, Cancel) or the sidecar gave up.
pub(crate) fn cancel(app: &AppHandle, id: &str, why: &str) {
    finish(app, id, false, why);
}

/// A password from the overlay's prompt, checked in its own thread. Ignored (and wiped) when it isn't for the open
/// request, one is being checked already, or it is empty or too long for PAM.
pub(crate) fn password(app: &AppHandle, id: String, secret: Secret) {
    if secret.len() == 0 || secret.len() > MAX_PASSWORD || !gate().try_password(&id) {
        return;
    }
    overlay(app, json!({ "kind": "auth_state", "id": id, "busy": true }));
    let app = app.clone();
    thread::spawn(move || {
        let locked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let l = locked.clone();
        // faillock: "The account is locked due to 3 failed logins." as an error message.
        let mut conv = Conv::new(Some(secret), Box::new(move |err, t| if err && t.to_lowercase().contains("locked") { l.store(true, Ordering::Relaxed) }));
        let o = run(PASSWORD_SERVICE, PASSWORD_CONF, &mut conv).map(outcome).unwrap_or_else(|e| {
            eprintln!("auth: password not checked: {e}");
            Outcome::Error
        });
        drop(conv);
        match password_state(o, locked.load(Ordering::Relaxed)) {
            None => finish(&app, &id, true, "ok"),
            Some(state) => {
                if gate().password_done(&id) {
                    overlay(&app, json!({ "kind": "auth_state", "id": id, "busy": false, "fail": state }));
                }
            }
        }
    });
}

/// The finger, alongside the password, for as long as a request that wants it is open: as the lock, a finger not
/// recognised three times or 30 s without one starts again, and three refusals in a row at once (no fprintd, reader
/// or finger) stop it and the prompt goes password only. A success counts for the request open at that moment.
fn finger_loop(app: AppHandle) {
    let mut quick = 0;
    loop {
        // The request this run is for: a finger read for it never approves another one.
        let started = {
            let mut g = gate();
            match g.cur.as_ref().filter(|r| r.finger) {
                Some(r) => r.id.clone(),
                None => {
                    g.finger_loop = false;
                    return;
                }
            }
        };
        let began = Instant::now();
        let a = app.clone();
        // pam_fprintd's "Failed to match fingerprint" comes as an error message between tries.
        let mut conv = Conv::new(None, Box::new(move |err, _| if err { touch(&a, json!({ "touchFail": true })) }));
        let o = run(FINGER_SERVICE, FINGER_CONF, &mut conv).map(outcome).unwrap_or(Outcome::Error);
        if o == Outcome::Success {
            // Its own statement: the gate's lock must be let go before touch and finish take it again (a std Mutex
            // locked twice by one thread never returns, and the next cancel on the main thread would hang the app).
            let still_open = gate().is(&started);
            if still_open {
                touch(&app, json!({ "touchOk": true }));
                finish(&app, &started, true, "ok");
            }
            quick = 0;
            continue;
        }
        let step = finger_step(o, began.elapsed(), quick);
        quick = step.quick;
        if step.miss {
            touch(&app, json!({ "touchFail": true }));
        }
        if !step.again {
            let mut g = gate();
            g.finger_gone = Some(Instant::now());
            g.finger_loop = false;
            let id = g.cur.as_mut().map(|r| {
                r.finger = false;
                r.id.clone()
            });
            drop(g);
            if let Some(id) = id {
                overlay(&app, json!({ "kind": "auth_state", "id": id, "finger": false }));
            }
            return;
        }
        thread::sleep(Duration::from_millis(800));
    }
}

/// A fingerprint state for the request open now.
fn touch(app: &AppHandle, mut state: Value) {
    let Some(id) = gate().current() else { return };
    state["kind"] = json!("auth_state");
    state["id"] = json!(id);
    overlay(app, state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("roamies-auth-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_configs_are_the_glyph_locks_own() {
        let lines = |t: &str| t.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")).collect::<Vec<_>>();
        assert_eq!(lines(PASSWORD_CONF), [
            "auth required pam_faillock.so preauth",
            "auth [success=1 default=bad] pam_unix.so nullok",
            "auth [default=die] pam_faillock.so authfail",
            "auth required pam_faillock.so authsucc",
        ]);
        assert_eq!(lines(FINGER_CONF), ["auth required pam_fprintd.so max-tries=3 timeout=30"]);
        assert!(PASSWORD_CONF.starts_with("#%PAM-1.0\n") && FINGER_CONF.starts_with("#%PAM-1.0\n"));
    }

    #[test]
    fn pam_codes_come_to_success_a_miss_or_an_error() {
        assert_eq!(outcome(0), Outcome::Success);
        assert_eq!(outcome(7), Outcome::Failed, "PAM_AUTH_ERR");
        assert_eq!(outcome(11), Outcome::Failed, "PAM_MAXTRIES");
        for rc in [1, 2, 3, 4, 5, 6, 8, 9, 10, 19, 26, -1] {
            assert_eq!(outcome(rc), Outcome::Error, "{rc}");
        }
        // What the prompt says after a password: nothing (it's done), wrong, locked out by faillock, or not checked.
        assert_eq!(password_state(Outcome::Success, false), None);
        assert_eq!(password_state(Outcome::Failed, false), Some("wrong"));
        assert_eq!(password_state(Outcome::Failed, true), Some("locked"));
        assert_eq!(password_state(Outcome::Error, false), Some("error"));
        assert_eq!(password_state(Outcome::Error, true), Some("locked"));
    }

    // Calls the conversation as PAM does: an array of pointers to messages, a reply array it allocates.
    fn converse_with(conv: &mut Conv, msgs: &[(c_int, &str)]) -> (c_int, Vec<Option<String>>) {
        let texts: Vec<CString> = msgs.iter().map(|(_, t)| CString::new(*t).unwrap()).collect();
        let structs: Vec<PamMessage> = msgs.iter().zip(&texts).map(|((s, _), t)| PamMessage { style: *s, msg: t.as_ptr() }).collect();
        let mut ptrs: Vec<*const PamMessage> = structs.iter().map(|m| m as *const PamMessage).collect();
        let mut resp: *mut PamResponse = std::ptr::null_mut();
        let rc = unsafe { converse(msgs.len() as c_int, ptrs.as_mut_ptr(), &mut resp, conv as *mut Conv as *mut c_void) };
        let mut out = vec![];
        if rc == PAM_SUCCESS {
            assert!(!resp.is_null());
            for i in 0..msgs.len() {
                let r = unsafe { &*resp.add(i) };
                out.push((!r.resp.is_null()).then(|| unsafe { CStr::from_ptr(r.resp) }.to_string_lossy().into_owned()));
            }
            unsafe { drop_responses(resp, msgs.len()) };
        } else {
            assert!(resp.is_null(), "nothing handed back on an error");
        }
        (rc, out)
    }

    #[test]
    fn the_password_answers_the_one_hidden_prompt_and_is_wiped() {
        let notes = Arc::new(Mutex::new(vec![]));
        let n = notes.clone();
        let mut conv = Conv::new(Some(Secret::from("hunter2 ñ".to_owned())), Box::new(move |err, t| n.lock().unwrap().push((err, t.to_owned()))));
        let (rc, out) = converse_with(&mut conv, &[(PAM_TEXT_INFO, "hello"), (PAM_PROMPT_ECHO_OFF, "Password: ")]);
        assert_eq!(rc, PAM_SUCCESS);
        assert_eq!(out, [None, Some("hunter2 ñ".to_owned())]);
        assert!(conv.secret.is_none(), "given once, then gone from here");
        assert_eq!(*notes.lock().unwrap(), [(false, "hello".to_owned())]);
        // A second hidden prompt (a module asking again, or for a new password) gets nothing.
        assert_eq!(converse_with(&mut conv, &[(PAM_PROMPT_ECHO_OFF, "Password: ")]).0, PAM_CONV_ERR);
    }

    #[test]
    fn prompts_it_cannot_answer_end_the_conversation() {
        let mut conv = Conv::new(None, Box::new(|_, _| {}));
        assert_eq!(converse_with(&mut conv, &[(PAM_PROMPT_ECHO_OFF, "Password: ")]).0, PAM_CONV_ERR, "the fingerprint's has no password");
        let mut conv = Conv::new(Some(Secret::from("x".to_owned())), Box::new(|_, _| {}));
        assert_eq!(converse_with(&mut conv, &[(PAM_PROMPT_ECHO_ON, "login: ")]).0, PAM_CONV_ERR, "never a visible prompt");
        assert_eq!(converse_with(&mut conv, &[(99, "?")]).0, PAM_CONV_ERR, "nor one it doesn't know");
        // Nothing handed out on the way: the password is still unanswered (and the next prompt could take it).
        assert!(conv.secret.is_some());
        let mut none: Vec<*const PamMessage> = vec![];
        let mut resp: *mut PamResponse = std::ptr::null_mut();
        assert_eq!(unsafe { converse(0, none.as_mut_ptr(), &mut resp, &mut conv as *mut Conv as *mut c_void) }, PAM_CONV_ERR);
        assert_eq!(unsafe { converse(PAM_MAX_NUM_MSG + 1, none.as_mut_ptr(), &mut resp, &mut conv as *mut Conv as *mut c_void) }, PAM_CONV_ERR);
        // Error messages are heard (faillock's lockout, pam_fprintd's "Failed to match fingerprint").
        let heard = Arc::new(Mutex::new(vec![]));
        let h = heard.clone();
        let mut conv = Conv::new(None, Box::new(move |err, t| h.lock().unwrap().push((err, t.to_owned()))));
        assert_eq!(converse_with(&mut conv, &[(PAM_ERROR_MSG, "Failed to match fingerprint")]), (PAM_SUCCESS, vec![None]));
        assert_eq!(*heard.lock().unwrap(), [(true, "Failed to match fingerprint".to_owned())]);
    }

    #[test]
    fn a_secret_is_zeroed_when_wiped_and_refuses_nul() {
        let mut s = Secret::from("abc".to_owned());
        assert_eq!(s.len(), 3);
        s.wipe();
        assert!(s.0.iter().all(|b| *b == 0));
        let mut conv = Conv::new(Some(Secret::from("a\0b".to_owned())), Box::new(|_, _| {}));
        assert_eq!(converse_with(&mut conv, &[(PAM_PROMPT_ECHO_OFF, "Password: ")]).0, PAM_CONV_ERR, "a NUL would cut it short");
    }

    #[test]
    fn the_config_folder_is_private_fresh_and_goes_away() {
        let base = scratch("confdir");
        let a = ConfDir::new(&base, PASSWORD_SERVICE, PASSWORD_CONF).unwrap();
        let b = ConfDir::new(&base, PASSWORD_SERVICE, PASSWORD_CONF).unwrap();
        assert_ne!(a.path, b.path, "a new one each time");
        assert!(a.path.starts_with(base.join("roamies")));
        assert_eq!(fs::metadata(&a.path).unwrap().permissions().mode() & 0o777, 0o700);
        let file = a.path.join(PASSWORD_SERVICE);
        assert_eq!(fs::read_to_string(&file).unwrap(), PASSWORD_CONF);
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let (pa, pb) = (a.path.clone(), b.path.clone());
        drop(a);
        drop(b);
        assert!(!pa.exists() && !pb.exists(), "removed after use");
        assert!(ConfDir::new(&base.join("missing/deeper"), FINGER_SERVICE, FINGER_CONF).is_err(), "no runtime folder: no config");
        fs::remove_dir_all(&base).unwrap();
    }

    // Found by an independent check: a "roamies" folder that is a symlink, or open to others, is not used.
    #[test]
    fn a_runtime_folder_that_isnt_private_is_refused() {
        let base = scratch("private");
        let elsewhere = scratch("private-target");
        std::os::unix::fs::symlink(&elsewhere, base.join("roamies")).unwrap();
        assert!(ConfDir::new(&base, PASSWORD_SERVICE, PASSWORD_CONF).is_err(), "a symlink");
        fs::remove_file(base.join("roamies")).unwrap();
        fs::create_dir(base.join("roamies")).unwrap();
        fs::set_permissions(base.join("roamies"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ConfDir::new(&base, PASSWORD_SERVICE, PASSWORD_CONF).is_err(), "open to others");
        fs::set_permissions(base.join("roamies"), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(ConfDir::new(&base, PASSWORD_SERVICE, PASSWORD_CONF).is_ok(), "private: used");
        fs::remove_dir_all(&base).unwrap();
        fs::remove_dir_all(&elsewhere).unwrap();
    }

    // Found by an independent check: the finger's success held the gate's lock while touch and finish took it again,
    // which hung that thread and then the main thread at the next cancel. The lock is taken in a statement of its own.
    #[test]
    fn the_finger_success_lets_go_of_the_gate_before_finishing() {
        let src = include_str!("auth.rs");
        let body = &src[src.find("fn finger_loop").unwrap()..src.find("fn touch(").unwrap()];
        assert!(!body.contains("if let Some(id) = gate()"), "no lock held across a block");
        assert!(body.contains("let still_open = gate().is(&started);"), "the success is checked for its own request");
        assert!(body.contains("finish(&app, &started, true"), "and approves only that one");
    }

    #[test]
    fn without_pam_or_its_confdir_call_it_fails_closed() {
        let e = Pam::load(c"libroamies-no-such-pam.so.0").err().expect("no library");
        assert!(e.contains("PAM"), "{e}");
        // A library that loads but is not Linux-PAM 1.4 or later.
        let e = Pam::load(c"libc.so.6").err().expect("no pam_start_confdir");
        assert!(e.contains("1.4"), "{e}");
        assert!(runtime_dir_from(None).is_err());
        assert!(runtime_dir_from(Some("relative/dir".into())).is_err());
        assert!(runtime_dir_from(Some("/no/such/runtime/dir".into())).is_err());
        assert_eq!(runtime_dir_from(Some(std::env::temp_dir().into())).unwrap(), std::env::temp_dir());
    }

    #[test]
    fn one_request_at_a_time_and_only_its_own_id_answers() {
        let t = Instant::now();
        let mut g = Gate::default();
        assert_eq!(g.begin("r1", true, t), Ok(true));
        assert_eq!(g.begin("r2", true, t), Err("busy"), "a second waits for nothing: it is refused");
        assert!(!g.try_password("r2"), "another id");
        assert!(g.try_password("r1"));
        assert!(!g.try_password("r1"), "one password at a time");
        assert!(g.password_done("r1"));
        assert!(g.try_password("r1"), "and the next after it");
        assert!(!g.end("r2"));
        assert!(g.end("r1"));
        assert!(!g.is("r1") && !g.end("r1"), "ended once");
        assert!(!g.password_done("r1"), "a late answer finds nothing");
        assert_eq!(g.begin("", true, t), Err("bad"));
        assert_eq!(g.begin(&"x".repeat(65), true, t), Err("bad"));
        // No reader (or no finger) found lately: password only, for a while.
        assert_eq!(g.begin("r3", false, t), Ok(false));
        g.end("r3");
        g.finger_gone = Some(t);
        assert_eq!(g.begin("r4", true, t + Duration::from_secs(60)), Ok(false));
        g.end("r4");
        assert_eq!(g.begin("r5", true, t + Duration::from_secs(11 * 60)), Ok(true));
    }

    #[test]
    fn the_finger_is_asked_again_as_the_lock_does() {
        let (fast, slow) = (Duration::from_millis(300), Duration::from_secs(30));
        // Not recognised (three misses) or 30 s with no finger: again.
        assert_eq!(finger_step(Outcome::Failed, slow, 0), FingerStep { quick: 0, miss: true, again: true });
        assert_eq!(finger_step(Outcome::Error, slow, 2), FingerStep { quick: 0, miss: false, again: true });
        // Refused at once three times running: nothing to read with (no fprintd, no reader, no finger).
        assert_eq!(finger_step(Outcome::Error, fast, 0), FingerStep { quick: 1, miss: false, again: true });
        assert_eq!(finger_step(Outcome::Error, fast, 1), FingerStep { quick: 2, miss: false, again: true });
        assert_eq!(finger_step(Outcome::Error, fast, 2), FingerStep { quick: 3, miss: false, again: false });
        assert_eq!(finger_step(Outcome::Failed, fast, 2), FingerStep { quick: 3, miss: true, again: false });
    }
}
