// Voice helper (macOS: Apple speech; Windows: Parakeet on the PC) and the global shortcuts.

use super::*;
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::process::Child;
use std::sync::atomic::AtomicU32;

/// Id of the registered show/hide hotkey, read by the hotkey event handler.
static SUMMON_ID: AtomicU32 = AtomicU32::new(0);
/// Id of the registered "ask about an area" hotkey.
static SNAP_ID: AtomicU32 = AtomicU32::new(0);
static LIST_ID: AtomicU32 = AtomicU32::new(0);
/// Id of the Esc hotkey, held only while the Roamie is on screen (0 when it isn't).
static ESC_ID: AtomicU32 = AtomicU32::new(0);

thread_local! {
    // The hotkey manager must live on the main thread; it also owns the current show/hide hotkey.
    static HOTKEYS: RefCell<Option<(global_hotkey::GlobalHotKeyManager, [Option<global_hotkey::hotkey::HotKey>; 3])>> = const { RefCell::new(None) };
    // The overlays that have the Roamie (or its card, or its ask field) on screen right now.
    static ESC_UP: RefCell<std::collections::HashSet<String>> = RefCell::new(std::collections::HashSet::new());
}

/// The wake word (Linux): the phrase the voice helper listens for to start a take by itself (None while it's off),
/// and whether a spoken reply is playing (its own voice saying the phrase must start nothing).
#[cfg(target_os = "linux")]
static WAKE: Mutex<(Option<String>, bool)> = Mutex::new((None, false));

/// The wake phrase in the sidecar's voice_config: text when the wake word is on, nothing or "" when it's off.
#[cfg(target_os = "linux")]
pub(crate) fn wake_of(msg: &Value) -> Option<String> {
    msg.get("wake").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty() && p.chars().count() <= 40).map(str::to_owned)
}

/// What the helper must hear to be where `wake` says. fresh: it just started, with the wake word off, so only a
/// phrase needs saying; otherwise the phrase changed, and "off" is said too. With the wake word off and never
/// switched on, the helper is sent nothing it wasn't sent before.
#[cfg(target_os = "linux")]
fn wake_cmds(wake: &(Option<String>, bool), fresh: bool) -> Vec<Value> {
    match &wake.0 {
        Some(phrase) => vec![json!({ "cmd": "wake", "on": true, "phrase": phrase }), json!({ "cmd": "speaking", "on": wake.1 })],
        None if fresh => Vec::new(),
        None => vec![json!({ "cmd": "wake", "on": false })],
    }
}

/// Dictation (Linux): `roamies --dictate` on a key's press and `roamies --dictate-end` on its release (two binds in
/// the compositor, which sees the keys where no app can): the words said while the key is held are typed where the
/// keyboard is, in whatever app has it (wtype), instead of going to the agent. Pauses don't end it. Nothing extra
/// runs for it: the voice helper and its model already listen for the talk shortcut.
#[cfg(target_os = "linux")]
static DICTATE: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
pub(crate) fn dictate(app: &AppHandle) {
    // No helper (voice control off, no model yet): nothing listens, and the flag would turn the next take into one.
    if app.state::<Voice>().0.lock().unwrap().is_none() {
        eprintln!("dictation: voice control is off");
        return;
    }
    DICTATE.store(true, Ordering::Relaxed);
    to_voice(app, &json!({ "cmd": "hold" }));
    watch_dictation_key(app);
}

/// What the dictation key's watch does with one look at whether the key is held.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq)]
enum KeyWatch {
    Keep,
    Release,
    GiveUp,
}

/// The release bind fires only when the key is let go with its modifiers still down: let go of Ctrl or Alt first and
/// it never comes, and the take ran on (to MAX_HELD). So while dictating, the compositor is asked whether the key is
/// held. It is let go only once it was seen held and then seen up twice in a row; never seen held within the first
/// looks (a compositor that can't tell), the watch gives up and the release bind alone ends the take, as before.
#[cfg(target_os = "linux")]
#[derive(Default)]
struct KeyState {
    looks: u32,
    seen: bool,
    ups: u32,
}

#[cfg(target_os = "linux")]
impl KeyState {
    const FIRST_LOOKS: u32 = 8;
    fn step(&mut self, down: bool) -> KeyWatch {
        self.looks += 1;
        if down {
            self.seen = true;
            self.ups = 0;
            return KeyWatch::Keep;
        }
        if !self.seen {
            return if self.looks >= Self::FIRST_LOOKS { KeyWatch::GiveUp } else { KeyWatch::Keep };
        }
        self.ups += 1;
        if self.ups >= 2 { KeyWatch::Release } else { KeyWatch::Keep }
    }
}

/// Asks Hyprland every 150 ms whether D is held, while the dictation take is on (DICTATE), for at most 3 minutes.
#[cfg(target_os = "linux")]
fn watch_dictation_key(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let held = || {
            Command::new("hyprctl")
                .args(["repl", r#"return tostring(hl.is_key_down("d") or hl.is_key_down("D"))"#])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
                .ok()
        };
        let mut st = KeyState::default();
        let start = std::time::Instant::now();
        while DICTATE.load(Ordering::Relaxed) && start.elapsed() < Duration::from_secs(180) {
            thread::sleep(Duration::from_millis(150));
            let Some(down) = held() else { return };
            match st.step(down) {
                KeyWatch::Keep => {}
                KeyWatch::GiveUp => return,
                KeyWatch::Release => {
                    to_voice(&app, &json!({ "cmd": "release" }));
                    return;
                }
            }
        }
    });
}

/// The dictation key was let go: what was said is read and typed.
#[cfg(target_os = "linux")]
pub(crate) fn dictate_end(app: &AppHandle) {
    to_voice(app, &json!({ "cmd": "release" }));
}

/// What dictation types for a take's words: them and a space, so the next dictation doesn't run into them; nothing
/// for no words.
#[cfg(target_os = "linux")]
fn dictation_text(text: &str) -> Option<String> {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!t.is_empty()).then(|| format!("{t} "))
}

/// Types the words into the app that has the keyboard, on a thread of its own (wtype takes a moment per word).
#[cfg(target_os = "linux")]
fn type_dictation(text: String) {
    thread::spawn(move || match Command::new("wtype").arg("--").arg(&text).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).output() {
        Ok(o) if o.status.success() => {}
        Ok(o) => eprintln!("dictation: wtype failed: {}", String::from_utf8_lossy(&o.stderr).trim()),
        Err(e) => eprintln!("dictation: wtype could not run ({e}); install wtype to type dictated words"),
    });
}

/// The microphone the user picked (Linux, the Voice page): a PipeWire/PulseAudio source's name, "" for the system's
/// default. The helper records through ALSA's default device, which on PipeWire and PulseAudio desktops is their
/// plugin: it goes to the node named in PIPEWIRE_NODE (pipewire-alsa) or PULSE_SOURCE (the pulse plugin).
#[cfg(target_os = "linux")]
static MIC: Mutex<String> = Mutex::new(String::new());

/// A device name as the sound server writes them ("" for anything else: the default), as the sidecar checks it too.
#[cfg(target_os = "linux")]
pub(crate) fn device_of(msg: &Value, key: &str) -> String {
    let name = msg.get(key).and_then(Value::as_str).unwrap_or("");
    let ok = !name.is_empty() && name.len() <= 200 && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.:@+-".contains(c));
    if ok { name.to_owned() } else { String::new() }
}

/// What the helper's environment gets for a microphone: nothing for the default.
#[cfg(target_os = "linux")]
fn mic_env(mic: &str) -> Vec<(&'static str, String)> {
    if mic.is_empty() {
        Vec::new()
    } else {
        vec![("PIPEWIRE_NODE", mic.to_owned()), ("PULSE_SOURCE", mic.to_owned())]
    }
}

/// The sidecar's microphone setting: kept for the helpers that start later; a running helper is stopped when it
/// changed (the microphone is chosen when it starts), and voice_config starts it again right after.
#[cfg(target_os = "linux")]
pub(crate) fn set_mic(app: &AppHandle, mic: String) {
    {
        let mut m = MIC.lock().unwrap();
        if *m == mic {
            return;
        }
        *m = mic;
    }
    stop_voice(app);
}

/// Barge-in (Linux, the Voice page's "Interrupt me by talking"): the user's setting. It only takes effect on an
/// echo-cancelled microphone (echo_cancelled): on any other, the reply's own voice would be the user talking over it.
#[cfg(target_os = "linux")]
static BARGE: AtomicBool = AtomicBool::new(false);

/// Whether a microphone's name is an echo-cancelled source: the one Hanami's PipeWire setup makes
/// (`hanami_aec_source`), or any other whose name says echo-cancel or aec (module-echo-cancel's own names).
#[cfg(target_os = "linux")]
pub(crate) fn echo_cancelled(mic: &str) -> bool {
    let m = mic.to_ascii_lowercase();
    m.contains("echo-cancel") || m.contains("echo_cancel") || m.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "aec")
}

/// The setting in voice_config (missing: off, as an older sidecar).
#[cfg(target_os = "linux")]
pub(crate) fn barge_of(msg: &Value) -> bool {
    msg.get("barge").and_then(Value::as_bool) == Some(true)
}

/// Barge-in as the helper must have it: wanted, and the microphone echo-cancelled.
#[cfg(target_os = "linux")]
fn barge_on() -> bool {
    BARGE.load(Ordering::Relaxed) && echo_cancelled(&MIC.lock().unwrap())
}

/// What the helper hears when barge-in changes: on, with whether a reply is playing (it is told that only while the
/// wake word or barge-in is on); or off.
#[cfg(target_os = "linux")]
fn barge_cmds(on: bool, speaking: bool) -> Vec<Value> {
    if on {
        vec![json!({ "cmd": "barge", "on": true }), json!({ "cmd": "speaking", "on": speaking })]
    } else {
        vec![json!({ "cmd": "barge", "on": false })]
    }
}

/// The sidecar's barge-in setting: kept for the helpers that start later, and told to the one running when what it
/// must do changed. A changed microphone restarts the helper (set_mic), which start_voice tells.
#[cfg(target_os = "linux")]
pub(crate) fn set_barge(app: &AppHandle, on: bool) {
    let before = barge_on();
    BARGE.store(on, Ordering::Relaxed);
    let after = barge_on();
    if before != after {
        for cmd in barge_cmds(after, WAKE.lock().unwrap().1) {
            to_voice(app, &cmd);
        }
    }
}

/// The microphone boost (Linux, the Voice page), in percent: 100 is as the microphone comes.
#[cfg(target_os = "linux")]
static MIC_GAIN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(100);

/// The boost in voice_config: a percent from 100 to 400; anything else is 100.
#[cfg(target_os = "linux")]
pub(crate) fn gain_of(msg: &Value) -> u32 {
    msg.get("micGain").and_then(Value::as_u64).filter(|g| (100..=400).contains(g)).unwrap_or(100) as u32
}

#[cfg(target_os = "linux")]
fn gain_cmd(percent: u32) -> Value {
    json!({ "cmd": "gain", "value": percent as f64 / 100.0 })
}

/// The sidecar's boost: kept for the helpers that start later, and told to the one running when it changed.
#[cfg(target_os = "linux")]
pub(crate) fn set_gain(app: &AppHandle, percent: u32) {
    if MIC_GAIN.swap(percent, Ordering::Relaxed) != percent {
        to_voice(app, &gain_cmd(percent));
    }
}

/// The sidecar's wake word setting: kept for the helpers that start later, and told to the one running when it
/// changed.
#[cfg(target_os = "linux")]
pub(crate) fn set_wake(app: &AppHandle, phrase: Option<String>) {
    let cmds = {
        let mut wake = WAKE.lock().unwrap();
        if wake.0 == phrase {
            return;
        }
        wake.0 = phrase;
        wake_cmds(&wake, false)
    };
    for cmd in cmds {
        to_voice(app, &cmd);
    }
}

/// A spoken reply started or stopped playing on some overlay (linux::talk_state). The helper is told only while
/// the wake word is on (it then ignores the phrase meanwhile, and for a moment after) or barge-in (it listens for the
/// user talking over it).
#[cfg(target_os = "linux")]
pub(crate) fn speaking(app: &AppHandle, on: bool) {
    let tell = {
        let mut wake = WAKE.lock().unwrap();
        let changed = wake.1 != on;
        wake.1 = on;
        changed && (wake.0.is_some() || barge_on())
    };
    if tell {
        to_voice(app, &json!({ "cmd": "speaking", "on": on }));
    }
}

pub(crate) fn voice_binary() -> Option<PathBuf> {
    helper_binary("roamies-voice")
}

pub(crate) fn start_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    if state.0.lock().unwrap().is_some() {
        return;
    }
    let Some(bin) = voice_binary() else {
        eprintln!("voice helper not found next to the app binary");
        return;
    };
    let chord = app.state::<TalkChord>().0.lock().unwrap().join(",");
    let mut cmd = Command::new(bin);
    cmd.arg("--chord").arg(chord);
    #[cfg(target_os = "linux")]
    for (k, v) in mic_env(&MIC.lock().unwrap()) {
        cmd.env(k, v);
    }
    if let Some(dir) = app.state::<VoiceModel>().0.lock().unwrap().clone() {
        cmd.arg("--model").arg(dir);
    }
    // Debug builds: ROAMIES_TEST_AUDIO=<wav> stands in for the microphone, to test talking with no mic (CI, Docker).
    #[cfg(debug_assertions)]
    if let Some(wav) = std::env::var_os("ROAMIES_TEST_AUDIO") {
        cmd.arg("--test-audio").arg(wav);
    }
    let mut child = match hide_console(&mut cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log_stdio("sidekick-voice.log")).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("voice helper failed to start: {e}");
            return;
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let pid = child.id();
    *state.0.lock().unwrap() = Some(child);
    // A helper starts with the wake word off: this one (the first, or one restarted after it died) is told the phrase.
    #[cfg(target_os = "linux")]
    {
        let (mut cmds, speaking) = {
            let wake = WAKE.lock().unwrap();
            (wake_cmds(&wake, true), wake.1)
        };
        // It starts with barge-in off too.
        if barge_on() {
            cmds.extend(barge_cmds(true, speaking));
        }
        for cmd in cmds {
            to_voice(app, &cmd);
        }
        // It starts with no boost.
        let gain = MIC_GAIN.load(Ordering::Relaxed);
        if gain != 100 {
            to_voice(app, &gain_cmd(gain));
        }
    }
    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || handle_voice(&app2, msg));
        }
        // Exited: anything it was drawing is gone, so the page draws the sidekick again.
        {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || to_sidekick_buddy(&app2, &json!({ "state": "gone" })));
        }
        // If it is still the wanted helper, it died on its own: retry a few times.
        let state = app.state::<Voice>();
        let ours = {
            let mut slot = state.0.lock().unwrap();
            let ours = slot.as_ref().map(Child::id) == Some(pid);
            if ours {
                if let Some(mut c) = slot.take() {
                    let _ = c.wait();
                }
            }
            ours
        };
        // It may have died mid-take, and can't say listening ended: the overlays are told for it, as when it's stopped.
        if ours {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || to_overlays(&app2, &voice_idle()));
        }
        if ours && state.1.fetch_add(1, Ordering::Relaxed) < 3 {
            thread::sleep(Duration::from_secs(1));
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || start_voice(&app2));
        }
    });
}

pub(crate) fn stop_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    let child = state.0.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    to_overlays(app, &voice_idle());
}

/// What ends listening on the overlays: sent when the helper is stopped, and when it dies by itself (mid-take it
/// can't say so, and the overlays would show listening, with other apps' sound down, until the next take).
fn voice_idle() -> Value {
    json!({ "kind": "voice", "type": "state", "state": "idle" })
}

pub(crate) fn to_voice(app: &AppHandle, msg: &Value) {
    if let Some(child) = app.state::<Voice>().0.lock().unwrap().as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = writeln!(stdin, "{msg}");
        }
    }
}

/// Tell the voice helper to drop a talk-chord press that turned out to be the show/hide shortcut.
fn cancel_voice(app: &AppHandle) {
    to_voice(app, &json!({ "cmd": "cancel" }));
}

/// Show/hide shortcut (default ⌃⌥S): brings the sidekick forward, or sends it away if it's out.
/// Must run on the main thread.
pub(crate) fn init_hotkeys(app: &AppHandle) {
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
    match GlobalHotKeyManager::new() {
        Ok(m) => HOTKEYS.with(|h| *h.borrow_mut() = Some((m, [None, None, None]))),
        Err(e) => return eprintln!("hotkeys unavailable: {e}"),
    }
    let app = app.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
        if e.state() != HotKeyState::Pressed {
            return;
        }
        let summon = e.id() == SUMMON_ID.load(Ordering::Relaxed);
        let snap = e.id() == SNAP_ID.load(Ordering::Relaxed);
        let list = e.id() == LIST_ID.load(Ordering::Relaxed);
        let esc = e.id() != 0 && e.id() == ESC_ID.load(Ordering::Relaxed);
        if esc {
            // The panel has the keyboard: Esc closes it, as it would without this hotkey.
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                let panel = app2.get_webview_window(PANEL_LABEL).filter(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
                if panel.is_some() {
                    hide_panel(&app2, "esc");
                } else {
                    to_overlays(&app2, &json!({ "kind": "esc" }));
                }
            });
            return;
        }
        if !summon && !snap && !list {
            return;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Both shortcuts share modifiers with the talk chord; that press wasn't a request to talk.
            cancel_voice(&app2);
            if summon {
                to_overlays(&app2, &json!({ "kind": "summon" }));
            } else if list {
                to_sidecar(&app2, &json!({ "type": "show_list" }));
            } else {
                to_sidecar(&app2, &json!({ "type": "snap" }));
            }
        });
    }));
}

/// Swaps one global shortcut (0 = show/hide, 1 = ask about an area, 2 = show the list). On failure (bad format, or
/// another app owns it) the old one stays.
pub(crate) fn set_hotkey(slot: usize, accel: &str) -> Result<(), String> {
    use global_hotkey::hotkey::HotKey;
    let new: HotKey = accel.parse().map_err(|e| format!("{e}"))?;
    let id_slot = [&SUMMON_ID, &SNAP_ID, &LIST_ID][slot];
    HOTKEYS.with(|h| {
        let mut h = h.borrow_mut();
        let Some((manager, keys)) = h.as_mut() else { return Err("hotkeys unavailable".to_string()) };
        let current = keys[slot];
        if current.map(|c| c.id()) == Some(new.id()) {
            return Ok(());
        }
        if keys.iter().enumerate().any(|(i, k)| i != slot && k.map(|c| c.id()) == Some(new.id())) {
            return Err("already used by the other Hanami shortcut".to_string());
        }
        if let Some(old) = current {
            let _ = manager.unregister(old);
        }
        match manager.register(new) {
            Ok(()) => {
                keys[slot] = Some(new);
                id_slot.store(new.id(), Ordering::Relaxed);
                Ok(())
            }
            Err(e) => {
                if let Some(old) = current {
                    let _ = manager.register(old);
                }
                Err(format!("{e}"))
            }
        }
    })
}

/// Esc stops the Roamie's answer, or sends it away when it's idle (overlay host.js decides which). Global, so it
/// works without clicking the Roamie first; that means other apps don't get Esc meanwhile, so it's held only
/// while some overlay has the Roamie on screen. Must run on the main thread.
pub(crate) fn set_esc(app: &AppHandle, label: &str, on: bool) {
    use global_hotkey::hotkey::{Code, HotKey};
    let any = ESC_UP.with(|up| {
        let mut up = up.borrow_mut();
        if on {
            up.insert(label.to_owned());
        } else {
            up.remove(label);
        }
        // An overlay that closed (its screen went away) can't say it's done.
        up.retain(|l| app.get_webview_window(l).is_some());
        !up.is_empty()
    });
    HOTKEYS.with(|h| {
        let mut h = h.borrow_mut();
        let Some((manager, _)) = h.as_mut() else { return };
        let key = HotKey::new(None, Code::Escape);
        let held = ESC_ID.load(Ordering::Relaxed) != 0;
        if any && !held {
            match manager.register(key) {
                Ok(()) => ESC_ID.store(key.id(), Ordering::Relaxed),
                Err(e) => eprintln!("esc hotkey: {e}"),
            }
        } else if !any && held {
            let _ = manager.unregister(key);
            ESC_ID.store(0, Ordering::Relaxed);
        }
    });
}

fn handle_voice(app: &AppHandle, msg: Value) {
    let mut ui = msg.clone();
    ui["kind"] = json!("voice");
    if msg.get("type").and_then(Value::as_str) == Some("buddy") {
        to_sidekick_buddy(app, &msg);
        return;
    }
    // A click in another app while a drawing is up (see watch_clicks); not one on Roamies' own cards.
    if msg.get("type").and_then(Value::as_str) == Some("click") {
        if !crate::OVERLAY_HOT.load(Ordering::Relaxed) {
            to_sidecar(app, &json!({ "type": "user_click", "x": msg.get("x"), "y": msg.get("y"), "role": msg.get("role"), "app": msg.get("app"), "acts": msg.get("acts") }));
        }
        return;
    }
    if msg.get("type").and_then(Value::as_str) == Some("ready") {
        app.state::<Voice>().1.store(0, Ordering::Relaxed);
        return;
    }
    // Windows: the pen trail while circling something (voice-win/src/ink.rs); the overlays draw it, also during setup.
    if msg.get("type").and_then(Value::as_str) == Some("ink") {
        to_overlays(app, &ui);
        return;
    }
    // While the setup guide is open, talking is just the "try it" test: it never reaches the agent.
    if ONBOARDING.load(Ordering::Relaxed) {
        // Nothing answers here, so the listening pill goes as soon as the words are in.
        if msg.get("type").and_then(Value::as_str) == Some("final") {
            to_voice(app, &json!({ "cmd": "handoff" }));
        }
        to_onboarding(app, &ui);
        return;
    }
    match msg.get("type").and_then(Value::as_str) {
        Some("state") => {
            // A take starts: nothing drawn with the mouse before it goes with its words (linux.rs pen_add).
            #[cfg(target_os = "linux")]
            if msg.get("state").and_then(Value::as_str) == Some("listening") {
                crate::linux::pen_clear();
            }
            // A dictation that ended with no words: the next take is an ordinary one again.
            #[cfg(target_os = "linux")]
            if msg.get("state").and_then(Value::as_str) == Some("idle") {
                DICTATE.store(false, Ordering::Relaxed);
            }
            to_overlays(app, &ui);
            to_sidecar(app, &json!({ "type": "voice_state", "state": msg.get("state") }));
        }
        Some("partial") | Some("level") => to_overlays(app, &ui),
        // The user talked over a reply: the take that follows stops it (its "listening"); the sidecar logs it.
        Some("barge") => to_sidecar(app, &json!({ "type": "voice_barge" })),
        // Dictation: the words are typed, never asked.
        #[cfg(target_os = "linux")]
        Some("final") if DICTATE.swap(false, Ordering::Relaxed) => {
            if let Some(t) = dictation_text(msg.get("text").and_then(Value::as_str).unwrap_or("")) {
                type_dictation(t);
            }
        }
        Some("final") => {
            to_overlays(app, &ui);
            // Linux on a layer surface: strokes drawn with the mouse during the take make the area here, in the
            // helper's shape (linux.rs pen_area); the words go once it is captured.
            #[cfg(target_os = "linux")]
            if msg.get("area").is_none_or(Value::is_null) {
                let loops = crate::linux::pen_take();
                if !loops.is_empty() {
                    crate::linux::pen_area(app, loops, move |app, area| to_sidecar(app, &spoken(&msg, Some(&area))));
                    return;
                }
            }
            to_sidecar(app, &spoken(&msg, msg.get("area")));
        }
        Some("error") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_error");
            to_sidecar(app, &m);
        }
        _ => {}
    }
}

/// What the sidecar hears of the words of a take. area: the part of the screen marked with the pen while talking (a
/// PNG, its rect and the strokes), the helper's or the mouse's.
/// The helper's stage times (ROAMIES_LATENCY) go along when it sent them.
fn spoken(msg: &Value, area: Option<&Value>) -> Value {
    let mut v = json!({ "type": "voice", "text": msg.get("text"), "area": area, "ms": msg.get("ms"), "via": msg.get("via") });
    if let Some(t) = msg.get("trace") {
        v["trace"] = t.clone();
    }
    v
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn the_wake_phrase_is_read_from_voice_config() {
        assert_eq!(wake_of(&json!({ "type": "voice_config", "wake": "Hey Jarvis" })), Some("Hey Jarvis".to_string()));
        assert_eq!(wake_of(&json!({ "wake": "  jarvis " })), Some("jarvis".to_string()), "trimmed");
        assert_eq!(wake_of(&json!({ "wake": "" })), None, "off");
        assert_eq!(wake_of(&json!({ "wake": "   " })), None);
        assert_eq!(wake_of(&json!({ "enabled": true, "duck": 30 })), None, "an older sidecar says nothing: off");
        for odd in [json!(true), json!(1), json!(null), json!(["jarvis"]), json!({ "phrase": "jarvis" })] {
            assert_eq!(wake_of(&json!({ "wake": odd })), None, "only text is a phrase");
        }
        assert_eq!(wake_of(&json!({ "wake": "x".repeat(41) })), None, "longer than any phrase the panel takes");
        assert_eq!(wake_of(&json!({ "wake": "ñ".repeat(40) })), Some("ñ".repeat(40)), "forty letters, whatever their bytes");
    }

    #[test]
    fn the_microphone_is_a_device_name_and_reaches_the_helper_through_its_environment() {
        let usb = "alsa_input.usb-Codec-00.analog-stereo-input";
        assert_eq!(device_of(&json!({ "mic": usb }), "mic"), usb);
        for odd in [json!(""), json!("a b"), json!("x;y"), json!("$(id)"), json!(7), json!(null), json!("x".repeat(201))] {
            assert_eq!(device_of(&json!({ "mic": odd }), "mic"), "", "{odd}: the default");
        }
        assert_eq!(device_of(&json!({ "enabled": true }), "mic"), "", "an older sidecar says nothing: the default");
        assert_eq!(mic_env(""), Vec::<(&str, String)>::new(), "the default: the environment as it is");
        assert_eq!(mic_env(usb), vec![("PIPEWIRE_NODE", usb.to_string()), ("PULSE_SOURCE", usb.to_string())]);
    }

    #[test]
    fn the_dictation_key_is_let_go_only_after_it_was_seen_held_and_then_up_twice() {
        let run = |looks: &[bool]| {
            let mut st = KeyState::default();
            looks.iter().map(|&d| st.step(d)).collect::<Vec<_>>()
        };
        use KeyWatch::*;
        assert_eq!(run(&[true, true, false, false]), vec![Keep, Keep, Keep, Release], "held, then up twice");
        assert_eq!(run(&[true, false, true, false, false]), vec![Keep, Keep, Keep, Keep, Release], "one up look is a glitch");
        assert_eq!(run(&[false, false, true, false, false]), vec![Keep, Keep, Keep, Keep, Release], "seen held a little late");
        let never = run(&[false; 8]);
        assert_eq!(never.last(), Some(&GiveUp), "never seen held: the release bind decides, as before");
        assert!(never[..7].iter().all(|w| *w == Keep), "and nothing is let go before");
    }

    #[test]
    fn dictated_words_are_typed_with_a_space_after_them() {
        assert_eq!(dictation_text("Hola, ¿cómo estás?"), Some("Hola, ¿cómo estás? ".to_string()));
        assert_eq!(dictation_text("  git   status \n"), Some("git status ".to_string()), "spaces tidied");
        assert_eq!(dictation_text(""), None);
        assert_eq!(dictation_text("   "), None, "no words: nothing typed");
    }

    #[test]
    fn the_boost_is_a_percent_from_100_to_400_and_reaches_the_helper_as_a_factor() {
        assert_eq!(gain_of(&json!({ "micGain": 250 })), 250);
        for odd in [json!(99), json!(401), json!(-5), json!("200"), json!(2.5), json!(null)] {
            assert_eq!(gain_of(&json!({ "micGain": odd })), 100, "{odd}: none");
        }
        assert_eq!(gain_of(&json!({ "enabled": true })), 100, "an older sidecar says nothing: none");
        assert_eq!(gain_cmd(250), json!({ "cmd": "gain", "value": 2.5 }));
    }

    #[test]
    fn barge_in_needs_an_echo_cancelled_microphone() {
        for aec in ["hanami_aec_source", "echo-cancel-source", "alsa_input.usb-mic.echo-cancel", "my_echo_cancel_mic", "AEC.mic"] {
            assert!(echo_cancelled(aec), "{aec}");
        }
        for plain in ["", "alsa_input.pci-0000_00_1f.3.analog-stereo", "bluez_input.headset", "aecho", "spaecial"] {
            assert!(!echo_cancelled(plain), "{plain}: the reply would be heard as the user");
        }
        assert!(barge_of(&json!({ "type": "voice_config", "barge": true })));
        assert!(!barge_of(&json!({ "barge": false })) && !barge_of(&json!({ "wake": "" })), "an older sidecar says nothing: off");
        assert_eq!(barge_cmds(true, true), vec![json!({ "cmd": "barge", "on": true }), json!({ "cmd": "speaking", "on": true })], "mid-reply");
        assert_eq!(barge_cmds(true, false), vec![json!({ "cmd": "barge", "on": true }), json!({ "cmd": "speaking", "on": false })]);
        assert_eq!(barge_cmds(false, true), vec![json!({ "cmd": "barge", "on": false })]);
    }

    #[test]
    fn the_helper_hears_the_phrase_when_it_changes_and_when_it_starts() {
        let on = (Some("jarvis".to_string()), false);
        let wake = json!({ "cmd": "wake", "on": true, "phrase": "jarvis" });
        // With the phrase goes whether a reply is playing right now, so the helper never guesses.
        assert_eq!(wake_cmds(&on, false), vec![wake.clone(), json!({ "cmd": "speaking", "on": false })]);
        assert_eq!(wake_cmds(&on, true), vec![wake.clone(), json!({ "cmd": "speaking", "on": false })], "a helper that starts is told again");
        assert_eq!(wake_cmds(&(Some("jarvis".to_string()), true), true), vec![wake, json!({ "cmd": "speaking", "on": true })], "mid-reply");
        // Switched off: the running helper is told once; a new one starts with it off and is told nothing.
        assert_eq!(wake_cmds(&(None, false), false), vec![json!({ "cmd": "wake", "on": false })]);
        assert_eq!(wake_cmds(&(None, false), true), Vec::<Value>::new());
        assert_eq!(wake_cmds(&(None, true), true), Vec::<Value>::new(), "a reply playing is nobody's business while it's off");
    }

    #[test]
    fn the_words_of_a_take_reach_the_sidecar_as_they_always_did() {
        let area = json!({ "file": "/tmp/m.png", "rect": [1, 2, 320, 220], "strokes": [[[1, 2]]] });
        let msg = json!({ "type": "final", "text": "this one", "area": area, "ms": 840, "via": "keys" });
        assert_eq!(spoken(&msg, msg.get("area")), json!({ "type": "voice", "text": "this one", "area": area, "ms": 840, "via": "keys" }), "the helper's area");
        let plain = json!({ "type": "final", "text": "hi" });
        assert_eq!(spoken(&plain, plain.get("area")), json!({ "type": "voice", "text": "hi", "area": null, "ms": null, "via": null }), "none, as before");
        assert_eq!(spoken(&plain, Some(&area))["area"], area, "the mouse's, in the same place");
        // ROAMIES_LATENCY: the helper's stage times go along as they came; without them nothing is added.
        let trace = json!({ "take": 4, "voiced": 1, "closed": 2, "final": 3, "why": "pause", "read": "live" });
        assert_eq!(spoken(&json!({ "type": "final", "text": "hi", "trace": trace }), None)["trace"], trace);
        assert!(spoken(&plain, None).get("trace").is_none());
    }

    #[test]
    fn idle_is_the_message_that_ends_listening_on_the_overlays() {
        assert_eq!(voice_idle(), json!({ "kind": "voice", "type": "state", "state": "idle" }));
    }
}
