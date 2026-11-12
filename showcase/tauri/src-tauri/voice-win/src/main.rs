// Voice helper for Roamies on Windows and Linux: the twin of voice/main.swift, with the same JSON lines in and out.
// Watches the talk chord (GetAsyncKeyState on Windows, the X server on Linux X11 sessions; neither needs a
// permission), records the default microphone and
// transcribes on this PC with NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX via parakeet-rs). Parakeet isn't a
// streaming model, so live text comes from re-reading the take about once a second.
// Hold the chord = push-to-talk (release sends). Quick tap = hands-free (ends on a pause or another tap).
// While the chord is held, moving the cursor round something circles it (ink.rs); the circled area goes out with
// what was said, as on macOS (Windows only). On Wayland no app can watch the keyboard, so there {"cmd":"toggle"}
// (sent for `roamies --talk`, which people bind to a key) starts a take, and sends it when it comes again or on a
// pause. Exits when stdin closes.
// A voice is told by Silero VAD (vad.rs, silero-vad.onnx in the model folder); without that file a voice is a level
// over SPEECH_LEVEL, as before. With it, a hands-free take whose voice has been quiet for TURN_SILENCE asks the
// end-of-turn check (Smart Turn, smart-turn.onnx) whether the turn sounds over, and ends as soon as it says so and a
// read has heard all the words and they sound finished (turn_may_end); otherwise the pauses below decide.
// The wake word (Linux, off unless asked): after {"cmd":"wake","on":true,"phrase":"hey roamie"} the microphone stays
// on between takes, only watched for a voice. Each stretch of voice the VAD hears is read once it ends (at the cap
// while it goes on, the next read overlapping the cut by the phrase's length, see wake_reach); without the VAD a voice gets its last few seconds
// read, about once a second at most. When the phrase is in what was read a hands-free take starts right after it, as
// {"cmd":"toggle"} starts one. {"cmd":"speaking","on":true} (a spoken reply is playing) stops that meanwhile, and for a
// moment after; with the VAD, a voice in the FOLLOW_UP seconds after that is the next question, without the phrase.
//
// roamies-voice --model <dir> [--chord control,option]   normal use (Roamies starts it)
// roamies-voice --perms                                   prints {"type":"perms","mic":…}
// roamies-voice --devices                                 prints {"type":"devices",…}: every mic, the default, formats
// roamies-voice --model <dir> --transcribe <wav>          dev: transcribe a file and exit
// roamies-voice --model <dir> --test-audio <wav>          dev: a file stands in for the mic ({"cmd":"listen"} starts;
//                                                         after {"cmd":"wake",…} it plays once, to say the phrase)
// roamies-voice --speak <voice.onnx> [--speaker 1] [--threads 2]   the local voice: text in, speech out (speak.rs)
// roamies-voice --model <dir> --bench-listen <wav> [--phrase "hey jarvis"] [--listen] [--no-vad] [--turn <p>]
//     dev: what listening costs. The WAV stands in for the mic at real speed while the wake word waits for the phrase
//     (or, with --listen, as a hands-free take); then prints {"type":"bench"} with the CPU seconds used (Linux), the
//     speech model's reads (wake_reads, take_reads), when the phrase woke it and how the take ended (seconds from the
//     start). --no-vad keeps the level gate; --turn answers every end-of-turn check with p after 60 ms (a stand-in).

mod audio;
mod ink;
mod keys;
mod speak;
mod turn;
mod vad;

use audio::{MicError, Sink, Source};
use parakeet_rs::{ExecutionConfig, ParakeetTDT, TimestampMode, Transcriber};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;

#[cfg(test)]
thread_local! {
    // What the test on this thread was told, in order (every test runs on a thread of its own).
    static SAID: std::cell::RefCell<Vec<Value>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub fn emit(v: Value) {
    #[cfg(test)]
    SAID.with(|s| s.borrow_mut().push(v.clone()));
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn log(s: &str) {
    eprintln!("[voice] {s}");
}

/// The error the app shows when the microphone can't be used; `reason` picks what the Roamie says.
fn mic_error(e: &MicError) -> Value {
    json!({ "type": "error", "code": "no_input", "reason": e.reason, "message": e.detail })
}

pub enum Ev {
    Cmd(Value),
    StdinClosed,
    Level(f64),
    AudioFailed(MicError),
    Text { take: u64, text: String, last: bool },
    // What was read while waiting for the wake word: each word and the second it ends at, from the snippet's start.
    Snippet { take: u64, words: Vec<(String, f64)> },
    EngineFailed(String),
    // Whether the take's turn sounded over (None: the check failed), for the silence that began after `voiced`.
    Turn { take: u64, voiced: f64, complete: Option<bool> },
}

// ---------- transcription (its own thread: loading and reading never stall the hotkey loop) ----------

struct Job {
    take: u64,
    audio: Vec<f32>,
    last: bool,
    // A snippet read for the wake word, answered with Ev::Snippet (words with their times) instead of Ev::Text.
    wake: bool,
}

fn model_present(dir: &Path) -> bool {
    dir.join("vocab.txt").is_file() && dir.join("encoder-model.int8.onnx").is_file() && dir.join("decoder_joint-model.int8.onnx").is_file()
}

/// ONNX Runtime allows one environment per process (a second one fails to build): Parakeet and the voice gate share it.
pub fn ort_env() -> Result<parakeet_rs::ort::environment::Environment, String> {
    static ENV: std::sync::OnceLock<Result<parakeet_rs::ort::environment::Environment, String>> = std::sync::OnceLock::new();
    ENV.get_or_init(|| parakeet_rs::ort::init().with_name("roamies-voice").build().map_err(|e| e.to_string())).clone()
}

fn load_model(dir: &Path) -> Result<ParakeetTDT, String> {
    // Half the cores: quick enough to read a minute of speech in a second or two, without starving the PC.
    let threads = thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 8);
    let t0 = Instant::now();
    let env = ort_env()?;
    let config = ExecutionConfig::new().with_environment(env).with_intra_threads(threads);
    let mut asr = ParakeetTDT::from_pretrained(dir, Some(config)).map_err(|e| e.to_string())?;
    // One short warm-up run, so the first real request doesn't pay for ONNX Runtime's setup.
    let _ = asr.transcribe_samples(vec![0.0; RATE as usize / 2], RATE, 1, None);
    log(&format!("model ready in {:.1}s ({threads} threads)", t0.elapsed().as_secs_f64()));
    Ok(asr)
}

fn transcribe(asr: &mut ParakeetTDT, audio: Vec<f32>) -> String {
    if audio.len() < RATE as usize / 5 {
        return String::new();
    }
    match asr.transcribe_samples(audio, RATE, 1, None) {
        Ok(r) => r.text.split_whitespace().collect::<Vec<_>>().join(" "),
        Err(e) => {
            log(&format!("transcribe: {e}"));
            String::new()
        }
    }
}

/// A wake snippet as words, each with the second it ends at (from the snippet's start), so a take can start
/// right after the phrase.
fn transcribe_words(asr: &mut ParakeetTDT, audio: Vec<f32>) -> Vec<(String, f64)> {
    if audio.len() < RATE as usize / 5 {
        return Vec::new();
    }
    match asr.transcribe_samples(audio, RATE, 1, Some(TimestampMode::Words)) {
        Ok(r) => r.tokens.into_iter().map(|t| (t.text, t.end as f64)).collect(),
        Err(e) => {
            log(&format!("transcribe: {e}"));
            Vec::new()
        }
    }
}

fn spawn_engine(dir: PathBuf, tx: Sender<Ev>) -> (Sender<Job>, thread::JoinHandle<()>) {
    let (jtx, jrx) = mpsc::channel::<Job>();
    let handle = thread::spawn(move || match load_model(&dir) {
        Ok(asr) => serve(asr, jrx, tx),
        Err(e) => {
            log(&format!("model failed to load: {e}"));
            let _ = tx.send(Ev::EngineFailed(e));
        }
    });
    (jtx, handle)
}

// Reads the engine ran (wake snippets, take reads), for --bench-listen.
static READS: [std::sync::atomic::AtomicUsize; 2] = [const { std::sync::atomic::AtomicUsize::new(0) }; 2];

fn serve(mut asr: ParakeetTDT, jrx: Receiver<Job>, tx: Sender<Ev>) {
    while let Ok(first) = jrx.recv() {
        // Only the newest live read matters (a wake snippet is one too); a closing read always runs.
        let mut jobs = vec![first];
        jobs.extend(jrx.try_iter());
        let job = match jobs.iter().rposition(|j| j.last) {
            Some(i) => jobs.swap_remove(i),
            None => jobs.pop().expect("at least one job"),
        };
        READS[usize::from(!job.wake)].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let answer = if job.wake {
            Ev::Snippet { take: job.take, words: transcribe_words(&mut asr, job.audio) }
        } else {
            Ev::Text { take: job.take, text: transcribe(&mut asr, job.audio), last: job.last }
        };
        if tx.send(answer).is_err() {
            return;
        }
    }
}

// ---------- the voice gate and the end of a turn ----------

// Silero VAD (vad.rs), next to the speech model. Without it (not downloaded yet, or it won't load) a voice is a level
// over SPEECH_LEVEL, as before.
const VAD_MODEL: &str = "silero-vad.onnx";

fn load_vad(dir: &Path) -> Option<vad::Vad> {
    match vad::Silero::load(&dir.join(VAD_MODEL)) {
        Ok(m) => {
            log("voice activity model ready");
            Some(vad::Vad::new(Box::new(m)))
        }
        Err(e) => {
            log(&format!("no voice activity model ({e}): a voice is told by its level"));
            None
        }
    }
}

/// Whether a turn sounds over (S2: Smart Turn in turn.rs): the probability that the speaker has finished, from the
/// take's last seconds of 16 kHz sound.
pub trait TurnCheck: Send {
    fn complete(&mut self, audio_16k: &[f32]) -> Result<f32, String>;
}

// A turn is over at this probability (Smart Turn's own threshold).
const TURN_DONE: f32 = 0.5;
// It is asked once the voice has been quiet this long (the VAD's silence, not a level's): a breath between two
// words is shorter, and a turn that is over can end here instead of on the 0.7 to 1.5 s pauses.
const TURN_SILENCE: f64 = 0.25;
// The most it is given: the model reads up to 8 s.
const TURN_AUDIO: f64 = 8.0;

struct TurnJob {
    take: u64,
    // The take's voice_at when it was asked: the answer is about the silence after it, stale once they speak again.
    voiced: f64,
    audio: Vec<f32>,
}

type TurnLoader = Box<dyn FnOnce() -> Option<Box<dyn TurnCheck>> + Send>;

/// The check on a thread of its own (it takes tens of milliseconds, never the audio's or the keys' time). Without a
/// model the thread ends, and asking it fails.
fn spawn_turn(load: TurnLoader, tx: Sender<Ev>) -> Sender<TurnJob> {
    let (jtx, jrx) = mpsc::channel::<TurnJob>();
    thread::spawn(move || {
        let Some(mut check) = load() else { return };
        while let Ok(first) = jrx.recv() {
            // Only the newest silence matters.
            let job = jrx.try_iter().last().unwrap_or(first);
            let complete = match check.complete(&job.audio) {
                Ok(p) => Some(p >= TURN_DONE),
                Err(e) => {
                    log(&format!("turn check: {e}"));
                    None
                }
            };
            if tx.send(Ev::Turn { take: job.take, voiced: job.voiced, complete }).is_err() {
                return;
            }
        }
    });
    jtx
}

// Smart Turn (turn.rs), next to the speech model.
const TURN_MODEL: &str = "smart-turn.onnx";

impl TurnCheck for turn::SmartTurn {
    fn complete(&mut self, audio_16k: &[f32]) -> Result<f32, String> {
        turn::SmartTurn::complete(self, audio_16k)
    }
}

fn load_turn(dir: &Path) -> Option<Box<dyn TurnCheck>> {
    match ort_env().and_then(|env| turn::SmartTurn::load(&dir.join(TURN_MODEL), &env)) {
        Ok(t) => {
            log("end-of-turn model ready");
            Some(Box::new(t))
        }
        Err(e) => {
            log(&format!("no end-of-turn model ({e}): pauses end a take"));
            None
        }
    }
}

// ---------- the wake word (Linux): a phrase that starts a take, heard with the same model ----------

// The stretch of sound kept while waiting for the phrase: room for a phrase said slowly plus the wait for the next
// read, and short enough to read in a fraction of a second.
const WAKE_WINDOW: f64 = 4.0;
// The buffer is cut back to the window once it is this much over, not on every bit of sound.
const WAKE_SLACK: f64 = 0.5;
// At most one read a second, however long somebody (or a video) talks.
const WAKE_EVERY: f64 = 1.0;
// A voice is read once it has gone on this long, so a short phrase is whole in the first read.
const WAKE_SETTLE: f64 = 0.6;
// A voice heard this close to a read may have been cut off mid-word: it gets one more read once it has stopped.
const WAKE_TRAIL: f64 = 0.4;
// Roamies' own voice, and its echo in the room, is never listened to: while a reply plays and this long after.
const WAKE_AFTER_SPEECH: f64 = 1.0;
// With the VAD, a voice is read once it ends, or at this length while it goes on; the next read then starts this much
// before the cut, so a phrase said across it is whole in one of the two. The phrase is a second at most.
// A longer phrase gets a longer overlap (wake_reach), and the cap stays WAKE_FRESH past it.
const WAKE_CAP: f64 = 2.5;
const WAKE_OVERLAP: f64 = 1.0;
const WAKE_FRESH: f64 = 1.0;
// A read cut at the cap whose phrase ends this close to the cut may have cut through its last word (the model's end
// times land early): no take from it; the stretch is read again from just before the phrase.
const WAKE_EDGE: f64 = 0.5;
// A stretch of voice is read with this much before it and after it: a soft first sound the model only hears from its
// second window on, and quiet before the first word (Parakeet read "oye" right at a snippet's start as "hoy").
const WAKE_PRE: f64 = 0.5;
const WAKE_POST: f64 = 0.15;
// With the VAD, after a spoken reply (and its WAKE_AFTER_SPEECH), a voice is taken as the next question without the
// phrase for this long. Without the VAD a level can't tell a voice from the room, so only the phrase starts a take.
const FOLLOW_UP: f64 = 6.0;
// A microphone that won't open is tried again this often.
const WAKE_RETRY: f64 = 15.0;
// A read that never came back (the engine dropped it for a newer one) is given up on after this.
const WAKE_READ_TIMEOUT: f64 = 15.0;
// The model's end time for a word lands well before the word stops sounding (a take cut there began with the tail of
// the phrase: "center" came through as "Enter", or whole), so a take starts this long after the phrase, or most of
// the way to the end of the word that comes right behind it.
const WAKE_CUT_MARGIN: f64 = 0.4;

/// How far a read at the cap reaches back past the last cut (seconds), and the cap: room for the whole phrase,
/// said at about 0.08 s a letter (measured with the local voice: "oye computadora" took 1.0 s).
fn wake_reach(words: &[String]) -> (f64, f64) {
    let letters: usize = words.iter().map(|w| w.chars().count()).sum();
    let overlap = (0.4 + 0.08 * letters as f64).clamp(WAKE_OVERLAP, 2.5);
    (overlap, (overlap + WAKE_FRESH).max(WAKE_CAP))
}

/// Where in a snippet (seconds) the take begins: just after the phrase's last word ended (end), keeping most of the
/// word that follows (next_end: when that one ends).
fn wake_cut(end: f64, next_end: Option<f64>) -> f64 {
    let end = end.max(0.0);
    end + next_end.map_or(WAKE_CUT_MARGIN, |n| ((n - end) * 0.7).clamp(0.0, WAKE_CUT_MARGIN))
}

/// Text as plain words, for comparing what was heard with the phrase: lower case, no accents, no punctuation
/// (speech-to-text writes "Jarvis.", "jarvis," and "JARVIS" for the same thing).
fn plain_words(text: &str) -> Vec<String> {
    // The accented letters of the languages Parakeet reads, as the letter under the accent. Other alphabets
    // pass through as they are.
    let bare = |c: char| match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'í' | 'ì' | 'î' | 'ï' | 'ī' | 'į' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ő' | 'ø' => 'o',
        'ú' | 'ù' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => 'u',
        'ý' | 'ÿ' => 'y',
        'ñ' | 'ń' | 'ň' => 'n',
        'ç' | 'ć' | 'č' => 'c',
        'ś' | 'š' | 'ș' => 's',
        'ź' | 'ż' | 'ž' => 'z',
        'ł' | 'ľ' => 'l',
        'ř' => 'r',
        'ț' | 'ť' => 't',
        'ď' | 'đ' => 'd',
        _ => c,
    };
    // An apostrophe is part of its word ("what's"); a mark typed as its own character (U+0300 to U+036F) is an
    // accent, dropped like the others. Anything else that isn't a letter or a digit ends the word.
    let kept: String = text.to_lowercase().chars().filter(|c| !matches!(c, '\'' | '’' | '\u{300}'..='\u{36f}')).map(bare).map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    kept.split_whitespace().map(str::to_owned).collect()
}

/// How many letters two words differ by (added, dropped or swapped for another), counted up to `most`: more than
/// that comes back as `most + 1`.
fn letters_apart(a: &str, b: &str, most: usize) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > most {
        return most + 1;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let swap = diagonal + usize::from(ca != cb);
            diagonal = row[j + 1];
            row[j + 1] = swap.min(row[j] + 1).min(diagonal + 1);
        }
    }
    row[b.len()].min(most + 1)
}

/// A heard word is the phrase's word when it is spelt the same or nearly: speech-to-text writes a name more than
/// one way ("jarvis", "yarvis"). Up to four letters must be exact (or "luna" would be "tuna"), five to eight may be
/// one letter off, longer ones two.
fn same_word(wanted: &str, heard: &str) -> bool {
    let most = match wanted.chars().count() {
        0..=4 => 0,
        5..=8 => 1,
        _ => 2,
    };
    letters_apart(wanted, heard, most) <= most
}

/// Where the phrase ends in what was heard: the index of its last word, or None when it wasn't said. Whole words,
/// next to each other and in order, anywhere in the text; the last time it was said counts.
fn wake_match(phrase: &[String], heard: &[String]) -> Option<usize> {
    if phrase.is_empty() || heard.len() < phrase.len() {
        return None;
    }
    (0..=heard.len() - phrase.len()).rev().find(|&at| phrase.iter().zip(&heard[at..]).all(|(w, h)| same_word(w, h))).map(|at| at + phrase.len() - 1)
}

/// What the wake word needs to remember between ticks.
#[derive(Default)]
struct Wake {
    // The phrase as plain words; empty while the wake word is off.
    words: Vec<String>,
    // A spoken reply is playing, and when listening may start again after one.
    speaking: bool,
    quiet_until: f64,
    // When the voice being heard now started (None: no voice since the last read), and when it was last heard.
    heard_at: Option<f64>,
    voice_at: f64,
    read_at: f64,
    // The read under way: the take number it went out with, when, and where its snippet starts in the stream.
    reading: Option<(u64, f64, u64)>,
    // Samples cut from the front of the buffer since the mic opened: where the buffer starts in the stream.
    dropped: u64,
    // The microphone failed (said once, until sound comes in again) and when to try it next.
    failed: bool,
    retry_at: f64,
    // The dev WAV has stood in for the microphone (once per wake command, see wake_open).
    played: bool,
    // With the VAD: where the voice being heard began (stream samples), and a stretch of voice waiting to be read.
    seg: Option<u64>,
    next: Option<(u64, u64, bool)>,
    // The read out was cut at the cap while the voice went on: how long it is (seconds).
    read_cut: Option<f64>,
    // The phrase was heard in a read the cap may have cut through: the next read only needs its last word.
    deferred: bool,
    // With the VAD: until when a voice is a new question without the phrase (after a reply, see set_speaking).
    follow_until: f64,
    // With the VAD: how far a read at the cap reaches back past the last cut, and the cap (see wake_reach).
    overlap: f64,
    cap: f64,
}

// ---------- the talk session (port of the Voice class in voice/main.swift) ----------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Idle,
    Armed,
    Holding,
    HandsFree,
    Finishing,
}

const TAP_LIMIT: f64 = 0.25;
// A release must last this long to count, so one glitchy frame of key state can't end a session.
const RELEASE_DEBOUNCE: f64 = 0.09;
const PAUSE_ENDS: f64 = 1.5;
// Words that already end like a finished sentence or question ("What time is it?") end a hands-free take on a shorter
// pause, once a read has heard past the last voiced moment (an older read's full stop says nothing about the words
// after it).
const SHORT_PAUSE: f64 = 0.7;
// Words that end on a full stop only: Parakeet puts one at the end of nearly every read, also one cut off mid-sentence,
// so it shortens the pause a little, not to SHORT_PAUSE (someone thinking between two sentences mustn't be cut off).
const MID_PAUSE: f64 = 1.1;
// A live read heard every word when its audio runs this far past the last voiced moment (a word's end is softer than
// the voice threshold).
const READ_MARGIN: f64 = 0.25;
// A last word that leaves the sentence hanging ("and.", "y.", "the."): Parakeet ends nearly every read with a full stop,
// also one cut off mid-sentence, so after these the full pause is kept.
const HANGING: &[&str] = &[
    "and", "or", "but", "so", "because", "the", "a", "an", "to", "of", "in", "on", "at", "for", "with", "from", "that", "my", "your",
    "y", "e", "o", "u", "pero", "porque", "que", "de", "del", "al", "el", "la", "los", "las", "un", "una", "en", "con", "por", "para", "mi", "tu",
    // Fillers: someone still thinking.
    "eh", "em", "ehm", "este", "mm", "mmm", "um", "uh", "er", "erm", "hmm",
];

/// Whether the words of a take, all heard, sound like a whole turn, so the end-of-turn check may end it: a finished
/// question or exclamation, or a finished sentence of four words or more. Smart Turn alone said "over" at pauses
/// mid-sentence ("Quiero saber…", "eh…"), and a short sentence with a full stop is often only its start.
fn turn_may_end(text: &str, covered: bool) -> bool {
    covered && (pause_ends(text, true) == SHORT_PAUSE || (sounds_finished(text) && text.split_whitespace().count() >= 4))
}

/// Whether a live transcript ends like a finished sentence or question: a full stop, question or exclamation mark (Parakeet
/// writes them) after a word that doesn't leave it hanging.
fn sounds_finished(text: &str) -> bool {
    let t = text.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '”' | '’' | '»' | ')'));
    if !t.ends_with(['.', '?', '!', '…', '？', '！', '。']) {
        return false;
    }
    let last = t.split_whitespace().last().unwrap_or("").trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    !last.is_empty() && !HANGING.contains(&last.as_str())
}

/// How long a quiet stretch ends a hands-free take: short when the words sound finished and the last read heard them
/// all (covered), the full pause otherwise.
fn pause_ends(text: &str, covered: bool) -> f64 {
    if !covered || !sounds_finished(text) {
        return PAUSE_ENDS;
    }
    let t = text.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '”' | '’' | '»' | ')'));
    if t.ends_with(['?', '!', '？', '！']) { SHORT_PAUSE } else { MID_PAUSE }
}

/// Whether the last live read heard every word: the audio it read (up to read_upto) runs past the last voiced moment.
fn read_covers(read_upto: f64, voice_at: f64) -> bool {
    read_upto >= voice_at + READ_MARGIN
}

// With a video or music in the room the microphone never goes quiet, so a hands-free take also ends when no new word
// has come for this long (that sound isn't the user), and gives up when not one word came in the first NOTHING_ENDS.
const STALL_ENDS: f64 = 3.0;
const NOTHING_ENDS: f64 = 12.0;
const MAX_SESSION: f64 = 60.0;
// Keep the mic open a moment after release so a word said while letting go isn't clipped.
const TAIL: f64 = 0.3;
const FINAL_TIMEOUT: f64 = 30.0;
const READ_EVERY: f64 = 0.8;
// Parakeet makes up words ("Thank you.") from silence, so a take is only read once the mic heard a voice:
// about -49 dBFS, above room noise and below quiet speech.
const SPEECH_LEVEL: f64 = 0.15;

struct Voice {
    phase: Phase,
    chord: u8,
    chord_at: f64,
    listen_at: f64,
    heard_at: f64,
    voice_at: f64,
    level_at: f64,
    released_at: Option<f64>,
    blocked: bool,
    prev_chord: bool,
    report_empty: bool,
    spoke: bool,
    best: String,
    // Each session gets a new take number; results for older takes are ignored.
    take: u64,
    buf: Arc<Mutex<Vec<f32>>>,
    source: Option<Source>,
    engine: Option<Sender<Job>>,
    engine_error: Option<String>,
    reading: bool,
    read_at: f64,
    read_len: usize,
    // Where the audio of the last live read that came back with words ends (this clock).
    read_upto: f64,
    tail_until: Option<f64>,
    final_until: Option<f64>,
    test_audio: Option<PathBuf>,
    wake: Wake,
    ink: ink::Ink,
    tx: Sender<Ev>,
    t0: Instant,
    // ROAMIES_LATENCY: each take's words go out with when the voice stopped, the take closed (and why) and the words
    // were ready, on the wall clock the app and its page share.
    latency: bool,
    ended_at: f64,
    ended_why: &'static str,
    // The take's words are the last live read's (it heard them all), not another read of the whole take.
    reused: bool,
    // The voice gate (vad.rs), None without its model: then a voice is a level over SPEECH_LEVEL, as before. It hears
    // the microphone through tap; steps is its verdicts, kept to reuse the memory.
    vad: Option<vad::Vad>,
    tap: Arc<Mutex<Vec<f32>>>,
    steps: Vec<vad::Step>,
    // The end-of-turn check, and the silence it was last asked about (its voice_at).
    turn: Option<Sender<TurnJob>>,
    turn_asked: f64,
    // The silence (its voice_at) the check said was the end of the turn.
    turn_over: f64,
}

impl Voice {
    fn new(engine: Option<Sender<Job>>, test_audio: Option<PathBuf>, tx: Sender<Ev>) -> Voice {
        Voice {
            phase: Phase::Idle,
            chord: keys::mask(&["control".into(), "option".into()]).expect("default chord"),
            chord_at: 0.0,
            listen_at: 0.0,
            heard_at: 0.0,
            voice_at: 0.0,
            level_at: 0.0,
            released_at: None,
            blocked: false,
            prev_chord: false,
            report_empty: false,
            spoke: false,
            best: String::new(),
            take: 0,
            buf: Arc::new(Mutex::new(Vec::new())),
            source: None,
            engine,
            engine_error: None,
            reading: false,
            read_at: 0.0,
            read_len: 0,
            read_upto: f64::NEG_INFINITY,
            tail_until: None,
            final_until: None,
            test_audio,
            wake: Wake::default(),
            ink: ink::Ink::default(),
            tx,
            t0: Instant::now(),
            latency: false,
            ended_at: 0.0,
            ended_why: "",
            reused: false,
            vad: None,
            tap: Arc::new(Mutex::new(Vec::new())),
            steps: Vec::new(),
            turn: None,
            turn_asked: f64::NAN,
            turn_over: f64::NAN,
        }
    }

    fn now(&self) -> f64 {
        self.t0.elapsed().as_secs_f64()
    }

    fn set_chord(&mut self, names: &[String]) {
        let Some(m) = keys::mask(names) else { return log(&format!("ignored chord {names:?}")) };
        if self.phase != Phase::Idle {
            self.cancel();
        }
        self.chord = m;
        self.blocked = true;
        log(&format!("talk chord: {}", names.join("+")));
    }

    fn tick(&mut self) {
        let now = self.now();
        self.tick_keys(now);
        self.wake_tick(now);
        self.ink.set_armed(matches!(self.phase, Phase::Armed | Phase::Holding), now);
        self.ink.follow(now);
        match self.phase {
            Phase::Holding => self.maybe_read(now),
            Phase::HandsFree => {
                self.maybe_read(now);
                self.ask_turn(now);
            }
            Phase::Finishing => {
                if self.tail_until.is_some_and(|t| now >= t) {
                    self.tail_until = None;
                    self.close_take(now);
                } else if self.final_until.is_some_and(|t| now >= t) {
                    log("final read timed out");
                    self.finalize();
                }
            }
            _ => {}
        }
    }

    fn tick_keys(&mut self, now: f64) {
        let f = keys::held();
        let held = f.mods & self.chord;
        let down = held == self.chord; // once talking, a stray extra modifier doesn't count as letting go
        let extra = f.mods & !self.chord != 0 || f.altgr;
        let chord = down && !extra;
        let prev = self.prev_chord;
        self.prev_chord = chord;
        if held == 0 {
            self.blocked = false;
        }
        let released = if down {
            self.released_at = None;
            false
        } else {
            let at = *self.released_at.get_or_insert(now);
            now - at >= RELEASE_DEBOUNCE
        };

        match self.phase {
            Phase::Idle => {
                if chord && !prev && !self.blocked {
                    self.arm(now);
                }
            }
            Phase::Armed => {
                // Only the first moment decides shortcut vs. talk: the chord plus a key or another modifier is a shortcut.
                if down && (extra || keys::other_key_down()) {
                    log("not a talk: the chord was part of a shortcut");
                    self.cancel();
                    self.blocked = true;
                } else if released {
                    self.phase = Phase::HandsFree;
                    self.show_listening("handsfree", now);
                } else if down && now - self.chord_at >= TAP_LIMIT {
                    self.phase = Phase::Holding;
                    self.show_listening("hold", now);
                }
            }
            Phase::Holding => {
                if released {
                    self.end("released", now);
                    self.finish(TAIL);
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish(TAIL);
                }
            }
            Phase::HandsFree => {
                // Pressing again switches to push-to-talk; letting go then sends.
                if chord && !prev && !self.blocked {
                    self.phase = Phase::Holding;
                    self.released_at = None;
                    return;
                }
                let pause = pause_ends(&self.best, read_covers(self.read_upto, self.voice_at));
                // The short pause runs from the last voiced moment (a read already heard every word); the full one also
                // from the last new words, which can still be coming in from a read of audio before it.
                let quiet = now - if pause < PAUSE_ENDS { self.voice_at } else { self.heard_at.max(self.voice_at) };
                let stalled = now - self.heard_at > STALL_ENDS;
                if !self.best.is_empty() && (quiet > pause || stalled) {
                    self.end(if quiet <= pause { "no new words" } else if pause < PAUSE_ENDS { "short pause" } else { "pause" }, now);
                    // A pause was the tail already: nobody is letting go of keys mid-word.
                    self.finish(if quiet > pause { 0.0 } else { TAIL });
                } else if self.best.is_empty() && !self.reading && now - self.listen_at > 8.0 && now - self.voice_at > PAUSE_ENDS {
                    self.end("nothing heard", now);
                    self.cancel();
                } else if self.best.is_empty() && now - self.listen_at > NOTHING_ENDS {
                    self.end("no words", now);
                    self.cancel();
                } else if now - self.listen_at > MAX_SESSION {
                    self.end("max length", now);
                    self.finish(TAIL);
                }
            }
            Phase::Finishing => {}
        }
    }

    fn end(&mut self, why: &'static str, now: f64) {
        log(&format!("session end: {why} after {:.1}s", now - self.listen_at));
        (self.ended_at, self.ended_why) = (now, why);
    }

    // A moment on this clock as milliseconds on the wall clock, which the app and its page read too.
    fn wall_ms(&self, t: f64) -> u64 {
        let wall = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        ((wall - (self.now() - t)) * 1000.0).round().max(0.0) as u64
    }

    fn arm(&mut self, now: f64) {
        self.begin_take(now);
        // Start the mic now so the first word isn't lost (a shortcut cancels it a moment later).
        if self.engine.is_some() && keys::mic_allowed() {
            if self.source.is_some() {
                // Waiting for the wake word, the mic is on already (opening it twice can fail): the take carries on
                // with it, from now.
                self.buf.lock().unwrap().clear();
            } else {
                self.start_audio();
            }
        }
    }

    // A new take: its number, and nothing heard yet.
    fn begin_take(&mut self, now: f64) {
        self.phase = Phase::Armed;
        self.chord_at = now;
        self.best.clear();
        self.spoke = false;
        self.take += 1;
        self.reading = false;
        self.read_len = 0;
        self.read_upto = f64::NEG_INFINITY;
        self.reused = false;
        // Any take answers the reply: the follow-up is used up.
        self.wake.follow_until = 0.0;
    }

    fn show_listening(&mut self, mode: &str, now: f64) {
        self.listen_at = now;
        self.heard_at = now;
        self.voice_at = now;
        self.read_at = now;
        if self.engine.is_none() {
            let code = if self.engine_error.is_some() { "recognition" } else { "model_missing" };
            emit(json!({ "type": "error", "code": code, "message": self.engine_error.clone().unwrap_or_default() }));
            return self.cancel();
        }
        if !keys::mic_allowed() {
            emit(json!({ "type": "error", "code": "permission", "what": "microphone" }));
            return self.cancel();
        }
        if self.source.is_none() {
            self.start_audio();
            if self.phase == Phase::Idle {
                return;
            }
        }
        emit(json!({ "type": "state", "state": "listening", "mode": mode }));
        if !self.best.is_empty() {
            emit(json!({ "type": "partial", "text": self.best }));
        }
    }

    fn start_audio(&mut self) {
        if let Err(e) = self.open_audio() {
            log(&format!("audio: {} ({})", e.detail, e.reason));
            emit(mic_error(&e));
            self.cancel();
        }
    }

    // The microphone (or the dev WAV) on, into an empty buffer.
    fn open_audio(&mut self) -> Result<(), MicError> {
        self.buf.lock().unwrap().clear();
        self.tap.lock().unwrap().clear();
        let tap = self.vad.as_mut().map(|v| {
            v.restart();
            self.tap.clone()
        });
        let sink = Sink::new(self.buf.clone(), self.tx.clone()).with_tap(tap);
        let started = match &self.test_audio {
            Some(p) => audio::play_file(p, sink).map_err(|e| MicError::new("failed", e)),
            None => audio::open_mic(sink),
        };
        self.source = Some(started?);
        Ok(())
    }

    fn stop_audio(&mut self) {
        self.source = None;
    }

    // While listening: re-read the whole take now and then, for live text and pause detection.
    fn maybe_read(&mut self, now: f64) {
        let Some(engine) = &self.engine else { return };
        // The voice just stopped and no read has heard its end yet: one goes now, not on the usual pace, so a finished
        // sentence can end the take on the short pause and be its words.
        let ended = now >= self.voice_at + READ_MARGIN && self.read_at < self.voice_at + READ_MARGIN;
        if !self.spoke || self.reading || (now - self.read_at < READ_EVERY && !ended) {
            return;
        }
        let audio = self.buf.lock().unwrap().clone();
        if audio.len() < RATE as usize / 2 || audio.len() < self.read_len + RATE as usize * 3 / 10 {
            return;
        }
        self.read_at = now;
        self.read_len = audio.len();
        self.reading = engine.send(Job { take: self.take, audio, last: false, wake: false }).is_ok();
    }

    // tail: how long the mic stays on first.
    fn finish(&mut self, tail: f64) {
        if !matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
            return;
        }
        let shown = self.phase != Phase::Armed;
        self.report_empty = shown;
        self.phase = Phase::Finishing;
        self.ink.capture(self.now());
        if shown {
            emit(json!({ "type": "state", "state": "processing" }));
        }
        if self.source.is_none() {
            return self.finalize();
        }
        self.tail_until = Some(self.now() + tail);
    }

    // Mic off, then one last read of the whole take; its result ends the session. When the last live read heard every
    // word (nothing was voiced after the audio it read), its words are the take's, without reading it all again.
    fn close_take(&mut self, now: f64) {
        self.stop_audio();
        let audio = std::mem::take(&mut *self.buf.lock().unwrap());
        if !self.best.is_empty() && read_covers(self.read_upto, self.voice_at) {
            self.reused = true;
            return self.finalize();
        }
        match &self.engine {
            Some(engine) if self.spoke && engine.send(Job { take: self.take, audio, last: true, wake: false }).is_ok() => self.final_until = Some(now + FINAL_TIMEOUT),
            _ => self.finalize(),
        }
    }

    fn on_text(&mut self, take: u64, text: String, last: bool) {
        if take != self.take {
            return;
        }
        if !last {
            // The live read out (one at a time) was sent at read_at, with the audio up to then.
            if self.reading && !text.is_empty() {
                self.read_upto = self.read_at;
            }
            self.reading = false;
        }
        // A closing read that came back empty keeps whatever the live reads heard.
        if !text.is_empty() && text != self.best {
            self.best = text;
            self.heard_at = self.now();
            if !matches!(self.phase, Phase::Idle | Phase::Armed) {
                emit(json!({ "type": "partial", "text": self.best }));
            }
        }
        if last && self.phase == Phase::Finishing {
            self.finalize();
        }
        if !last {
            self.turn_end();
        }
    }

    // A hands-free take whose voice has been quiet TURN_SILENCE (by the VAD) asks whether the turn sounds over, once
    // per silence; the answer comes back as Ev::Turn.
    fn ask_turn(&mut self, now: f64) {
        let Some(turn) = &self.turn else { return };
        if self.vad.is_none() || !self.spoke || self.turn_asked == self.voice_at || now - self.voice_at < TURN_SILENCE {
            return;
        }
        self.turn_asked = self.voice_at;
        let audio = {
            let buf = self.buf.lock().unwrap();
            buf[buf.len().saturating_sub((TURN_AUDIO * RATE as f64) as usize)..].to_vec()
        };
        if turn.send(TurnJob { take: self.take, voiced: self.voice_at, audio }).is_err() {
            self.turn = None; // no model: today's pauses
        }
    }

    // Over: the take ends as soon as a read has heard all its words and they sound like a whole turn (turn_may_end),
    // the quiet being its tail. Not over, or unknown: the pauses decide, as before.
    fn on_turn(&mut self, take: u64, voiced: f64, complete: Option<bool>) {
        if take != self.take || self.phase != Phase::HandsFree || voiced != self.voice_at || complete != Some(true) {
            return;
        }
        self.turn_over = voiced;
        self.turn_end();
    }

    // Both the check and the words agree that the turn is over (each may come last).
    fn turn_end(&mut self) {
        if self.phase == Phase::HandsFree && self.turn_over == self.voice_at && turn_may_end(&self.best, read_covers(self.read_upto, self.voice_at)) {
            let now = self.now();
            self.end("turn complete", now);
            self.finish(0.0);
        }
    }

    fn on_level(&mut self, v: f64) {
        let now = self.now();
        self.heard(v, now);
    }

    // A bit of sound came in (v: its level), at now.
    fn heard(&mut self, v: f64, now: f64) {
        self.wake_level(v, now);
        let (voiced, spoke) = match self.vad.is_some() {
            true => {
                let voiced = self.listen_vad(now);
                (voiced, voiced)
            }
            false => (v > 0.2, v > SPEECH_LEVEL),
        };
        if voiced {
            self.voice_at = now;
        }
        if spoke && self.phase != Phase::Idle {
            self.spoke = true;
        }
        if !matches!(self.phase, Phase::Holding | Phase::HandsFree) || now - self.level_at < 0.05 {
            return;
        }
        self.level_at = now;
        emit(json!({ "type": "level", "v": (v * 100.0).round() / 100.0 }));
    }

    fn finalize(&mut self) {
        if self.phase != Phase::Finishing {
            return;
        }
        self.stop_audio();
        self.tail_until = None;
        self.final_until = None;
        let take = self.take;
        self.take += 1;
        self.phase = Phase::Idle;
        let text = self.best.trim().to_string();
        let area = self.ink.take();
        if !text.is_empty() {
            // What was circled on screen while talking rides along with the words.
            let mut msg = json!({ "type": "final", "text": text });
            if let Some(a) = area {
                msg["area"] = a;
                log("sent what was said, with the circled area");
            }
            if self.latency {
                let now = self.now();
                let read = if self.reused { "live" } else { "final" };
                msg["trace"] = json!({ "take": take, "voiced": self.wall_ms(self.voice_at), "closed": self.wall_ms(self.ended_at), "final": self.wall_ms(now), "why": self.ended_why, "read": read });
                log(&format!("latency: take {take} voiced→closed {:.0}ms ({}) closed→final {:.0}ms ({read} read)", (self.ended_at - self.voice_at) * 1000.0, self.ended_why, (now - self.ended_at) * 1000.0));
            }
            emit(msg);
        } else if let Some(f) = area.as_ref().and_then(|a| a["file"].as_str()) {
            // Circled something but said nothing: drop it quietly (no "I didn't hear you").
            let _ = std::fs::remove_file(f);
            log("nothing said, dropped the circled area");
            self.report_empty = false;
        }
        emit(json!({ "type": "state", "state": "idle" }));
        // Listened but got no words: say so instead of closing silently.
        if text.is_empty() && self.report_empty {
            emit(json!({ "type": "error", "code": "nothing_heard", "spoke": self.voice_at > self.listen_at + 0.05 }));
        }
        self.report_empty = false;
    }

    fn cancel(&mut self) {
        self.stop_audio();
        self.buf.lock().unwrap().clear();
        self.tail_until = None;
        self.final_until = None;
        self.take += 1;
        self.reading = false;
        self.phase = Phase::Idle;
        self.report_empty = false;
        let now = self.now();
        self.ink.clear(now);
        emit(json!({ "type": "state", "state": "idle", "cancelled": true }));
    }

    /// Start listening hands-free without a key press (after an area snap). Ends on a pause or a tap.
    fn listen_now(&mut self) {
        if self.phase != Phase::Idle {
            return;
        }
        let now = self.now();
        self.arm(now);
        self.phase = Phase::HandsFree;
        self.blocked = true; // the snap shortcut's keys may still be held: don't read them as a tap
        self.show_listening("handsfree", now);
    }

    /// The talk shortcut where the keys can't be watched (`roamies --talk`): the first one starts listening
    /// hands-free, the next one sends what was said (so does a pause).
    fn toggle(&mut self) {
        match self.phase {
            Phase::Idle => self.listen_now(),
            Phase::Armed | Phase::Holding | Phase::HandsFree => {
                let now = self.now();
                self.end("toggled", now);
                self.finish(TAIL);
            }
            Phase::Finishing => {}
        }
    }

    // ---- the wake word ----

    /// {"cmd":"wake"}: the phrase to listen for between takes, or off (also when the phrase has no words in it).
    fn set_wake(&mut self, on: bool, phrase: &str) {
        let words = if on { plain_words(phrase) } else { Vec::new() };
        if words == self.wake.words {
            return;
        }
        log(&if words.is_empty() { "wake word off".to_owned() } else { format!("wake word on ({} words)", words.len()) });
        let (overlap, cap) = wake_reach(&words);
        self.wake = Wake { words, speaking: self.wake.speaking, quiet_until: self.wake.quiet_until, overlap, cap, ..Wake::default() };
        if self.phase != Phase::Idle {
            return; // a take under way keeps its microphone and its number
        }
        // A read still out was for the old phrase: its answer is stale.
        self.take += 1;
        // Off: the microphone it held goes, with what it heard.
        if self.wake.words.is_empty() {
            self.stop_audio();
            self.buf.lock().unwrap().clear();
        }
    }

    /// {"cmd":"speaking"}: a spoken reply started or stopped playing.
    fn set_speaking(&mut self, on: bool, now: f64) {
        if self.wake.speaking && !on {
            self.wake.quiet_until = now + WAKE_AFTER_SPEECH;
            self.wake.follow_until = self.wake.quiet_until + FOLLOW_UP;
        }
        self.wake.speaking = on;
    }

    // The microphone is the wake word's: it is on, and no take is being heard.
    fn wake_waiting(&self) -> bool {
        !self.wake.words.is_empty() && self.phase == Phase::Idle
    }

    // Roamies' own voice is in the room: a reply is playing, or just stopped.
    fn wake_deaf(&self, now: f64) -> bool {
        self.wake.speaking || now < self.wake.quiet_until
    }

    /// Every tick: keeps the microphone on while waiting for the phrase, and has what it hears read now and then.
    fn wake_tick(&mut self, now: f64) {
        if !self.wake_waiting() {
            return;
        }
        if self.engine.is_none() {
            // No speech model (or it failed to load): nothing could read what the mic hears, so it stays off.
            return self.stop_audio();
        }
        if self.source.is_none() {
            return self.wake_open(now);
        }
        if self.wake.reading.is_some_and(|(_, at, _)| now - at > WAKE_READ_TIMEOUT) {
            log("wake word: a read never came back");
            self.wake.reading = None;
            self.take += 1; // should it come back after all, it is stale
        }
        self.wake_read(now);
    }

    // Between takes the microphone goes off (finalize, cancel): this turns it back on for the wake word.
    fn wake_open(&mut self, now: f64) {
        if !keys::mic_allowed() || now < self.wake.retry_at {
            return;
        }
        // The dev WAV stands in for the microphone once per wake command: played again after every take, the
        // phrase in it would call Roamies for ever.
        if self.test_audio.is_some() && self.wake.played {
            return;
        }
        match self.open_audio() {
            Ok(()) => {
                self.wake.played = true;
                self.wake.dropped = 0;
                self.wake.heard_at = None;
                self.wake.reading = None;
                self.wake.read_at = now;
                (self.wake.seg, self.wake.next, self.wake.deferred) = (None, None, false);
            }
            Err(e) => self.wake_mic_failed(&e, now),
        }
    }

    // The microphone didn't open, or stopped, while waiting for the phrase: said as a take's mic error is, once
    // (not at every try), and tried again later.
    fn wake_mic_failed(&mut self, e: &MicError, now: f64) {
        log(&format!("wake word: audio: {} ({})", e.detail, e.reason));
        self.stop_audio();
        self.wake.retry_at = now + WAKE_RETRY;
        if !self.wake.failed {
            self.wake.failed = true;
            emit(mic_error(e));
        }
    }

    /// A bit of sound came in while waiting for the phrase: only the last few seconds are kept, and a voice is noted.
    fn wake_level(&mut self, v: f64, now: f64) {
        if !self.wake_waiting() || self.source.is_none() {
            return;
        }
        // Sound is coming in, so the microphone works: its next failure is a new one.
        self.wake.failed = false;
        let deaf = self.wake_deaf(now);
        // Nothing of Roamies' own voice is kept, so none of it is read once it has stopped.
        // With the VAD a read can reach back a cap and an overlap.
        let window = if self.vad.is_some() { WAKE_WINDOW.max(self.wake.cap + self.wake.overlap) } else { WAKE_WINDOW };
        let (keep, slack) = if deaf { (0, 0) } else { ((window * RATE as f64) as usize, (WAKE_SLACK * RATE as f64) as usize) };
        {
            let mut buf = self.buf.lock().unwrap();
            if buf.len() > keep + slack {
                let cut = buf.len() - keep;
                buf.drain(..cut);
                self.wake.dropped += cut as u64;
            }
        }
        if self.vad.is_some() {
            return; // the VAD tells a voice (wake_vad)
        }
        if deaf {
            self.wake.heard_at = None;
        } else if v > SPEECH_LEVEL {
            self.wake.voice_at = now;
            self.wake.heard_at.get_or_insert(now);
        }
    }

    // A voice was heard since the last read: its last few seconds go to be read. One read at a time and one a
    // second at most, so a video playing for hours costs a read a second and nothing piles up.
    fn wake_read(&mut self, now: f64) {
        if self.vad.is_some() {
            return self.wake_read_vad(now);
        }
        let Some(engine) = &self.engine else { return };
        if self.wake_deaf(now) || self.wake.reading.is_some() || now - self.wake.read_at < WAKE_EVERY {
            return;
        }
        if !self.wake.heard_at.is_some_and(|at| now - at >= WAKE_SETTLE) {
            return;
        }
        let (audio, start) = {
            let buf = self.buf.lock().unwrap();
            let from = buf.len().saturating_sub((WAKE_WINDOW * RATE as f64) as usize);
            (buf[from..].to_vec(), self.wake.dropped + from as u64)
        };
        if audio.len() < RATE as usize / 2 {
            return;
        }
        // Still talking: what was read may end mid-word, so it is read once more, a second on, quiet or not.
        self.wake.heard_at = (now - self.wake.voice_at < WAKE_TRAIL).then_some(now);
        self.wake.read_at = now;
        if engine.send(Job { take: self.take, audio, last: false, wake: true }).is_ok() {
            self.wake.reading = Some((self.take, now, start));
        }
    }

    /// What came into the tap goes through the VAD: whether any of it was a voice. While waiting for the phrase the
    /// stretches of voice are noted to be read, and after a reply a voice starts a take.
    fn listen_vad(&mut self, now: f64) -> bool {
        let Some(vad) = self.vad.as_mut() else { return false };
        let mut steps = std::mem::take(&mut self.steps);
        steps.clear();
        {
            let mut tap = self.tap.lock().unwrap();
            vad.feed(&tap, &mut steps);
            tap.clear();
        }
        let voiced = steps.iter().any(|s| s.voice);
        if self.wake_waiting() && self.source.is_some() {
            self.wake_vad(&steps, now);
        }
        self.steps = steps;
        voiced
    }

    fn wake_vad(&mut self, steps: &[vad::Step], now: f64) {
        let rate = RATE as f64;
        if self.wake_deaf(now) {
            // Roamies' own voice: none of it is a stretch to read, nor the start of one that goes on after it.
            if let Some(vad) = self.vad.as_mut() {
                vad.forget();
            }
            (self.wake.seg, self.wake.next, self.wake.deferred) = (None, None, false);
            return;
        }
        for s in steps {
            if s.voice {
                self.wake.voice_at = now;
            }
            match s.edge {
                Some(vad::Edge::Start(at)) => {
                    let from = at.saturating_sub((WAKE_PRE * rate) as u64);
                    if now < self.wake.follow_until {
                        log("follow-up heard");
                        return self.wake_take(from, true, now);
                    }
                    self.wake.seg = Some(from);
                }
                Some(vad::Edge::End(at)) => {
                    if let Some(from) = self.wake.seg.take() {
                        self.wake_segment(from, (at + (WAKE_POST * rate) as u64).min(s.at), false);
                    }
                }
                None => {}
            }
            if let Some(from) = self.wake.seg.filter(|&f| s.at >= f + (self.wake.cap * rate) as u64) {
                self.wake_segment(from, s.at, true);
                self.wake.seg = Some(s.at - (self.wake.overlap * rate) as u64);
            }
        }
    }

    // A stretch of voice (stream samples) to be read; one waiting already is joined with it, so nothing said is
    // skipped while a read is out, up to the cap and its overlap.
    // cut: at the cap, the voice going on.
    fn wake_segment(&mut self, from: u64, to: u64, cut: bool) {
        if to <= from {
            return; // ended in the overlap of a read already made
        }
        let from = self.wake.next.map_or(from, |(f, _, _)| f.min(from));
        self.wake.next = Some((from.max(to.saturating_sub(((self.wake.cap + self.wake.overlap) * RATE as f64) as u64)), to, cut));
    }

    // With the VAD: the stretch of voice waiting goes to be read, one read at a time.
    fn wake_read_vad(&mut self, now: f64) {
        let Some(engine) = &self.engine else { return };
        if self.wake_deaf(now) || self.wake.reading.is_some() {
            return;
        }
        let Some((from, to, cut)) = self.wake.next.take() else { return };
        let (audio, start) = {
            let buf = self.buf.lock().unwrap();
            let at = |p: u64| (p.saturating_sub(self.wake.dropped) as usize).min(buf.len());
            (buf[at(from)..at(to).max(at(from))].to_vec(), self.wake.dropped + at(from) as u64)
        };
        if audio.len() < RATE as usize / 5 {
            return;
        }
        self.wake.read_at = now;
        self.wake.read_cut = cut.then_some(audio.len() as f64 / RATE as f64);
        if engine.send(Job { take: self.take, audio, last: false, wake: true }).is_ok() {
            self.wake.reading = Some((self.take, now, start));
        }
    }

    /// A snippet was read: when the phrase is in it, a hands-free take starts where the phrase ended. What was
    /// heard is never logged.
    fn on_snippet(&mut self, take: u64, heard: Vec<(String, f64)>, now: f64) {
        let Some((sent, read_at, start)) = self.wake.reading else { return };
        if take != sent {
            return;
        }
        self.wake.reading = None;
        // A take began meanwhile, the wake word went off, or a reply is playing: the answer is for nobody.
        if take != self.take || !self.wake_waiting() || self.source.is_none() || self.wake_deaf(now) {
            return;
        }
        // One timed word can be two plain ones ("twenty-one"): each gets the time the whole ends at.
        let said: Vec<(String, f64)> = heard.iter().flat_map(|(w, end)| plain_words(w).into_iter().map(move |p| (p, *end))).collect();
        let plain: Vec<String> = said.iter().map(|(w, _)| w.clone()).collect();
        let read_cut = self.wake.read_cut.take();
        let deferred = std::mem::take(&mut self.wake.deferred);
        let last = wake_match(&self.wake.words, &plain).or_else(|| {
            // Read again whole after a cut through it: it was said, and its last word says where it ends ("oye" can
            // come back as "oye y" the second time).
            let end = self.wake.words.last()?;
            plain.iter().rposition(|w| deferred && same_word(end, w))
        });
        let Some(last) = last else { return };
        if read_cut.is_some_and(|secs| said[last].1 > secs - WAKE_EDGE) {
            // Maybe cut through: the stretch is read again from just before the phrase (where the word before it
            // ended), so its end times are whole; the take waits for that read.
            self.wake.deferred = true;
            let first = (last + 1).saturating_sub(self.wake.words.len());
            let before = if first > 0 { said[first - 1].1 } else { 0.0 };
            let begins = start + ((before - WAKE_PRE).max(0.0) * RATE as f64) as u64;
            if let Some(seg) = self.wake.seg.as_mut() {
                *seg = (*seg).min(begins);
            } else if let Some(next) = self.wake.next.as_mut() {
                next.0 = next.0.min(begins);
            } else {
                let end = self.wake.dropped + self.buf.lock().unwrap().len() as u64;
                self.wake_segment(begins, end, false);
            }
            return;
        }
        log("wake word heard");
        // Words after the phrase in the same breath ("jarvis, what time is it") are already in the buffer, or came
        // in while the snippet was read: the take starts where the phrase ended, so none are lost.
        let from = start + (wake_cut(said[last].1, said.get(last + 1).map(|w| w.1)) * RATE as f64) as u64;
        let said_more = last + 1 < said.len() || self.wake.voice_at > read_at;
        self.wake_take(from, said_more, now);
    }

    // The take {"cmd":"toggle"} starts (see listen_now), on the microphone that is already on. from: where in the
    // stream it begins. said_more: a voice is already in it, so it is read even if nothing else is said.
    fn wake_take(&mut self, from: u64, said_more: bool, now: f64) {
        self.begin_take(now);
        {
            let mut buf = self.buf.lock().unwrap();
            let cut = (from.saturating_sub(self.wake.dropped) as usize).min(buf.len());
            buf.drain(..cut);
        }
        (self.wake.seg, self.wake.next, self.wake.deferred) = (None, None, false);
        self.spoke = said_more;
        self.phase = Phase::HandsFree;
        self.blocked = true;
        self.show_listening("handsfree", now);
    }

    /// Roamies saw its show/hide shortcut: that chord press was a shortcut, not a request to talk.
    fn external_cancel(&mut self) {
        if matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
            self.cancel();
        }
        self.blocked = true;
    }

    /// Returns true when Roamies has gone (stdin closed) and the helper should exit.
    fn handle(&mut self, ev: Ev) -> bool {
        match ev {
            Ev::Cmd(msg) => match msg.get("cmd").and_then(Value::as_str) {
                Some("cancel") => self.external_cancel(),
                Some("listen") => self.listen_now(),
                Some("toggle") => self.toggle(),
                Some("wake") => self.set_wake(msg.get("on").and_then(Value::as_bool) == Some(true), msg.get("phrase").and_then(Value::as_str).unwrap_or("")),
                Some("speaking") => {
                    let now = self.now();
                    self.set_speaking(msg.get("on").and_then(Value::as_bool) == Some(true), now);
                }
                Some("gain") => audio::set_gain(msg.get("value").and_then(Value::as_f64).unwrap_or(1.0)),
                Some("chord") => {
                    let mods: Vec<String> = msg.get("mods").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                    self.set_chord(&mods);
                }
                // Muting the speakers while listening is macOS-only for now.
                _ => {}
            },
            Ev::StdinClosed => return true,
            Ev::Level(v) => self.on_level(v),
            Ev::AudioFailed(e) => {
                log(&format!("audio stream: {} ({})", e.detail, e.reason));
                if matches!(self.phase, Phase::Armed | Phase::Holding | Phase::HandsFree) {
                    emit(mic_error(&e));
                    self.cancel();
                } else if self.wake_waiting() && self.source.is_some() {
                    let now = self.now();
                    self.wake_mic_failed(&e, now);
                }
            }
            Ev::Text { take, text, last } => self.on_text(take, text, last),
            Ev::Snippet { take, words } => {
                let now = self.now();
                self.on_snippet(take, words, now);
            }
            Ev::Turn { take, voiced, complete } => self.on_turn(take, voiced, complete),
            Ev::EngineFailed(e) => {
                self.engine = None;
                self.engine_error = Some(e);
            }
        }
        false
    }
}

/// One turn of the main loop: what came in, then a tick. True when Roamies has gone.
fn pump(voice: &mut Voice, rx: &Receiver<Ev>) -> bool {
    let quit = match rx.recv_timeout(Duration::from_millis(16)) {
        Ok(ev) => {
            let mut quit = voice.handle(ev);
            while let Ok(ev) = rx.try_recv() {
                quit |= voice.handle(ev);
            }
            quit
        }
        Err(RecvTimeoutError::Timeout) => false,
        Err(RecvTimeoutError::Disconnected) => true,
    };
    if !quit {
        voice.tick();
    }
    quit
}

/// The voice gate and the end-of-turn check, when their models are there (with the speech model's).
fn gate(voice: &mut Voice, dir: &Path, tx: &Sender<Ev>) {
    voice.vad = load_vad(dir);
    if voice.vad.is_some() {
        let dir = dir.to_path_buf();
        voice.turn = Some(spawn_turn(Box::new(move || load_turn(&dir)), tx.clone()));
    }
}

// This process's CPU time in seconds (Linux: utime and stime, fields 14 and 15 of /proc/self/stat, in 1/100 s).
fn cpu_seconds() -> f64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let f: Vec<f64> = stat.rsplit(')').next().unwrap_or("").split_whitespace().map(|x| x.parse().unwrap_or(f64::NAN)).collect();
    f.get(11).zip(f.get(12)).map_or(f64::NAN, |(u, s)| (u + s) / 100.0)
}

/// --bench-listen <wav> (see the top of the file): what listening costs, with the WAV for the microphone at real speed.
fn bench_listen(dir: &Path, wav: &Path, args: &[String]) {
    let asr = load_model(dir).unwrap_or_else(|e| panic!("model: {e}"));
    let (samples, _) = audio::read_wav(wav).unwrap_or_else(|e| panic!("{}: {e}", wav.display()));
    let (tx, rx) = mpsc::channel();
    let (jobs, jrx) = mpsc::channel();
    let engine_tx = tx.clone();
    thread::spawn(move || serve(asr, jrx, engine_tx));
    let mut voice = Voice::new(Some(jobs), Some(wav.to_path_buf()), tx.clone());
    if !args.iter().any(|a| a == "--no-vad") {
        gate(&mut voice, dir, &tx);
    }
    if let Some(p) = arg(args, "--turn").and_then(|p| p.parse::<f32>().ok()) {
        // A stand-in for Smart Turn: always this answer, in about the time it takes.
        struct Fixed(f32);
        impl TurnCheck for Fixed {
            fn complete(&mut self, _: &[f32]) -> Result<f32, String> {
                thread::sleep(Duration::from_millis(60));
                Ok(self.0)
            }
        }
        voice.turn = Some(spawn_turn(Box::new(move || Some(Box::new(Fixed(p)) as Box<dyn TurnCheck>)), tx.clone()));
    }
    let listen = args.iter().any(|a| a == "--listen");
    let secs = samples.len() as f64 / RATE as f64;
    let (cpu0, t0) = (cpu_seconds(), Instant::now());
    if listen {
        voice.listen_now();
    } else {
        voice.set_wake(true, &arg(args, "--phrase").unwrap_or_else(|| "hey jarvis".into()));
    }
    let mut woke = None;
    while t0.elapsed().as_secs_f64() < secs + 2.0 && !pump(&mut voice, &rx) {
        if !listen && woke.is_none() && voice.phase != Phase::Idle {
            woke = Some(t0.elapsed().as_secs_f64());
        }
    }
    let reads = |i: usize| READS[i].load(std::sync::atomic::Ordering::Relaxed);
    let ended = (!voice.ended_why.is_empty()).then(|| json!({ "why": voice.ended_why, "at": voice.ended_at - voice.listen_at }));
    emit(json!({ "type": "bench", "audio_s": secs, "cpu_s": cpu_seconds() - cpu0, "wake_reads": reads(0), "take_reads": reads(1), "vad": voice.vad.is_some(), "woke_at": woke, "ended": ended }));
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--perms") {
        emit(json!({ "type": "perms", "mic": if keys::mic_allowed() { "granted" } else { "denied" }, "input": audio::has_input() }));
        return;
    }
    if args.iter().any(|a| a == "--devices") {
        let mut v = audio::devices();
        v["mic_allowed"] = json!(keys::mic_allowed());
        emit(v);
        return;
    }
    // The local voice runs as a process of its own (the sidecar starts it only when it's picked), so it never slows
    // down this one's start or its speech-to-text. Two threads by default, to leave Parakeet room.
    if let Some(voice) = arg(&args, "--speak") {
        let speaker = arg(&args, "--speaker").and_then(|s| s.parse().ok());
        let threads = arg(&args, "--threads").and_then(|s| s.parse().ok()).unwrap_or(2);
        std::process::exit(speak::run(Path::new(&voice), speaker, threads));
    }
    let model = arg(&args, "--model").map(PathBuf::from);
    // Cursor positions and captures in real pixels on every monitor (ink.rs turns them into screen points).
    #[cfg(windows)]
    // SAFETY: a plain call at startup, before any window or thread exists.
    unsafe {
        windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    if let Some(wav) = arg(&args, "--transcribe") {
        let dir = model.expect("--transcribe needs --model <dir>");
        let mut asr = load_model(&dir).unwrap_or_else(|e| panic!("model: {e}"));
        let (samples, rate) = audio::read_wav(Path::new(&wav)).unwrap_or_else(|e| panic!("{wav}: {e}"));
        let t0 = Instant::now();
        let text = transcribe(&mut asr, samples.clone());
        emit(json!({ "text": text, "seconds": (t0.elapsed().as_secs_f64() * 100.0).round() / 100.0, "audio": samples.len() as f64 / rate as f64 }));
        return;
    }

    if let Some(wav) = arg(&args, "--bench-listen") {
        return bench_listen(&model.expect("--bench-listen needs --model <dir>"), Path::new(&wav), &args);
    }

    let (tx, rx): (Sender<Ev>, Receiver<Ev>) = mpsc::channel();
    let (engine, engine_thread) = match &model {
        Some(dir) if model_present(dir) => {
            let (jobs, handle) = spawn_engine(dir.clone(), tx.clone());
            (Some(jobs), Some(handle))
        }
        _ => {
            log("speech model not downloaded yet");
            (None, None)
        }
    };
    let mut voice = Voice::new(engine, arg(&args, "--test-audio").map(PathBuf::from), tx.clone());
    if let Some(dir) = model.as_ref().filter(|d| model_present(d)) {
        gate(&mut voice, dir, &tx);
    }
    voice.latency = std::env::var_os("ROAMIES_LATENCY").is_some();
    if let Some(c) = arg(&args, "--chord") {
        voice.set_chord(&c.split(',').map(str::to_owned).collect::<Vec<_>>());
    }

    let stdin_tx = tx.clone();
    thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = stdin_tx.send(Ev::Cmd(v));
            }
        }
        let _ = stdin_tx.send(Ev::StdinClosed);
    });

    emit(json!({ "type": "ready", "engine": "parakeet", "model": voice.engine.is_some() }));
    while !pump(&mut voice, &rx) {}
    // Let the engine thread finish (a model still loading included) before exiting: tearing ONNX Runtime
    // down under it crashes.
    drop(voice);
    if let Some(h) = engine_thread {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A Voice with a stand-in engine (the test reads its jobs) and a short WAV in place of the microphone.
    fn voice() -> (Voice, Receiver<Job>, PathBuf) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let wav = std::env::temp_dir().join(format!("roamies-voice-test-{}-{}.wav", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let spec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&wav, spec).expect("test wav");
        for i in 0..RATE / 2 {
            w.write_sample(((i as f32 * 0.2).sin() * 8000.0) as i16).expect("sample");
        }
        w.finalize().expect("wav written");
        let (jobs, jrx) = mpsc::channel();
        let (tx, _events) = mpsc::channel();
        (Voice::new(Some(jobs), Some(wav.clone()), tx), jrx, wav)
    }

    #[test]
    fn toggle_starts_a_take_and_the_next_one_sends_it() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree, "the first toggle listens hands-free");
        assert!(v.source.is_some(), "the microphone is on");
        v.on_level(0.5);
        v.on_text(v.take, "hello there".into(), false);
        v.toggle();
        assert_eq!(v.phase, Phase::Finishing, "the second toggle ends the take");
        v.toggle();
        assert_eq!(v.phase, Phase::Finishing, "a third one while it finishes changes nothing");
        // The mic's tail is over: the whole take goes for one last read.
        v.tail_until = Some(0.0);
        v.tick();
        let job = jobs.try_recv().expect("a closing read");
        assert!(job.last && job.take == v.take);
        assert!(v.source.is_none(), "the microphone is off");
        v.on_text(job.take, "hello there friend".into(), true);
        assert_eq!(v.phase, Phase::Idle);
        assert_eq!(v.best, "hello there friend");
        // And it's ready to go again.
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn toggle_without_a_speech_model_stays_idle() {
        let (tx, _events) = mpsc::channel();
        let mut v = Voice::new(None, None, tx);
        v.toggle();
        assert_eq!(v.phase, Phase::Idle);
        assert!(v.source.is_none());
    }

    // Regression: with a video playing in the room the microphone never goes quiet, so a hands-free take never saw
    // its pause and ran to the 60 s limit ("it stays there listening and does nothing").
    #[test]
    fn a_take_ends_when_the_words_stop_coming_even_if_the_room_is_never_quiet() {
        let (mut v, _jobs, wav) = voice();
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        let t = v.listen_at;
        // The user said something two seconds in; a video keeps sounding the whole time.
        v.best = "what is on my screen".into();
        v.heard_at = t + 2.0;
        v.voice_at = t + 4.0;
        v.tick_keys(t + 4.0);
        assert_eq!(v.phase, Phase::HandsFree, "two seconds without a new word: could be a breath");
        v.voice_at = t + 5.2;
        v.tick_keys(t + 5.2);
        assert_eq!(v.phase, Phase::Finishing, "no new word for over three seconds: that sound isn't them");
        let _ = std::fs::remove_file(wav);

        // Nothing but that sound, never a word: the take gives up instead of waiting out the minute.
        let (mut v, _jobs, wav) = voice();
        v.toggle();
        let t = v.listen_at;
        v.voice_at = t + 11.0;
        v.tick_keys(t + 11.0);
        assert_eq!(v.phase, Phase::HandsFree, "still inside the time to start talking");
        v.voice_at = t + 12.5;
        v.tick_keys(t + 12.5);
        assert_eq!(v.phase, Phase::Idle, "twelve seconds and not a word");
        let _ = std::fs::remove_file(wav);

        // As before: a real pause still ends it after a second and a half, and a quiet room with no words after eight.
        let (mut v, _jobs, wav) = voice();
        v.toggle();
        let t = v.listen_at;
        v.best = "hello".into();
        v.heard_at = t + 1.0;
        v.voice_at = t + 1.0;
        v.tick_keys(t + 2.4);
        assert_eq!(v.phase, Phase::HandsFree);
        v.tick_keys(t + 2.6);
        assert_eq!(v.phase, Phase::Finishing, "the pause rule is unchanged");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn words_that_sound_finished_end_a_hands_free_take_on_a_shorter_pause() {
        for done in ["¿qué hora es?", "what time is it?", "What time is it?\"", "Open it!"] {
            assert!(sounds_finished(done), "{done}");
            assert_eq!(pause_ends(done, true), SHORT_PAUSE, "{done}");
            assert_eq!(pause_ends(done, false), PAUSE_ENDS, "{done}: an older read's ending says nothing about the words after it");
        }
        // Parakeet ends nearly every read with a full stop, also one cut off mid-sentence ("Front left" read as "Front."),
        // so a full stop alone only shortens the pause a little: someone thinking between two sentences isn't cut off.
        for told in ["dime qué ves en pantalla.", "Front.", "open the settings."] {
            assert!(sounds_finished(told), "{told}");
            assert_eq!(pause_ends(told, true), MID_PAUSE, "{told}");
            assert!(MID_PAUSE > SHORT_PAUSE && MID_PAUSE < PAUSE_ENDS);
        }
        for open in ["y luego", "the thing is", "Y luego y.", "I want to open the.", ""] {
            assert!(!sounds_finished(open), "{open}");
            assert_eq!(pause_ends(open, true), PAUSE_ENDS, "{open}");
        }
        assert!(read_covers(2.0, 1.5) && !read_covers(1.6, 1.5), "a read heard every word once it ran past the voice");

        // Live: the voice stopped a second in, and a read sent after that came back with the words.
        let take = |text: &str, read_upto: f64| {
            let (mut v, _jobs, wav) = voice();
            v.toggle();
            let t = v.listen_at;
            (v.voice_at, v.read_upto, v.heard_at, v.best) = (t + 1.0, t + read_upto, t + 1.6, text.into());
            let _ = std::fs::remove_file(wav);
            (v, t)
        };
        let (mut v, t) = take("what time is it?", 1.4);
        v.tick_keys(t + 1.6);
        assert_eq!(v.phase, Phase::HandsFree, "0.6 s of quiet: not yet");
        v.tick_keys(t + 1.75);
        assert_eq!(v.phase, Phase::Finishing, "0.75 s after a finished question");
        assert!(v.tail_until.is_some_and(|u| u <= v.now()), "the pause was the tail: it closes at once");
        for (text, read_upto) in [("the thing is", 1.4), ("what time is it?", 1.1)] {
            let (mut v, t) = take(text, read_upto);
            v.tick_keys(t + 2.5);
            assert_eq!(v.phase, Phase::HandsFree, "{text} (read to {read_upto}): the full pause, from the last new words");
            v.tick_keys(t + 3.2);
            assert_eq!(v.phase, Phase::Finishing, "{text}");
        }
    }

    #[test]
    fn a_read_goes_out_as_soon_as_the_voice_stops() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        let t = v.listen_at;
        v.spoke = true;
        v.buf.lock().unwrap().extend(std::iter::repeat(0.1f32).take(RATE as usize * 2));
        // A live read went out while they were still talking; the voice stopped a moment later.
        (v.read_at, v.read_len, v.voice_at) = (t + 1.5, RATE as usize, t + 1.7);
        v.maybe_read(t + 1.9);
        assert!(jobs.try_recv().is_err(), "within the margin after the voice: not yet");
        v.maybe_read(t + 2.0);
        assert!(jobs.try_recv().is_ok_and(|j| !j.last), "a read now, not 0.8 s after the last one: it hears every word");
        v.reading = false;
        v.maybe_read(t + 2.3);
        assert!(jobs.try_recv().is_err(), "then the usual pace");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn the_last_live_read_is_the_take_when_it_heard_every_word() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        v.on_level(0.5);
        // A read sent after the voice stopped comes back with the words.
        v.read_at = v.voice_at + 0.5;
        v.reading = true;
        v.on_text(v.take, "what time is it?".into(), false);
        let _ = said();
        v.toggle();
        v.tail_until = Some(0.0);
        v.tick();
        assert!(jobs.try_recv().is_err(), "no other read of the whole take");
        assert_eq!(v.phase, Phase::Idle);
        assert!(said().iter().any(|e| e["type"] == "final" && e["text"] == "what time is it?"), "the live read's words are sent");

        // The voice went on after the last read: the whole take is read again, as before.
        v.toggle();
        v.read_at = v.now();
        v.reading = true;
        v.on_text(v.take, "what time".into(), false);
        v.on_level(0.5);
        v.toggle();
        v.tail_until = Some(0.0);
        v.tick();
        assert!(jobs.try_recv().is_ok_and(|j| j.last), "a closing read");
        assert_eq!(v.phase, Phase::Finishing);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_take_carries_its_stage_times_only_with_the_latency_trace_on() {
        let (mut v, jobs, wav) = voice();
        assert!(!v.latency, "off unless ROAMIES_LATENCY is set");
        let sent = |v: &mut Voice| {
            v.toggle();
            v.on_level(0.5);
            v.read_at = v.voice_at + 0.5;
            v.reading = true;
            v.on_text(v.take, "hi there.".into(), false);
            let _ = said();
            v.toggle();
            v.tail_until = Some(0.0);
            v.tick();
            if let Ok(j) = jobs.try_recv() {
                v.on_text(j.take, "hi there.".into(), true);
            }
            said().into_iter().find(|e| e["type"] == "final").expect("the words")
        };
        assert!(sent(&mut v).get("trace").is_none(), "nothing extra when off");
        v.latency = true;
        let f = sent(&mut v);
        let tr = &f["trace"];
        assert_eq!((tr["why"].as_str(), tr["read"].as_str()), (Some("toggled"), Some("live")));
        let ms = |k: &str| tr[k].as_u64().unwrap_or_else(|| panic!("{k} in {tr}"));
        assert!(ms("voiced") <= ms("closed") && ms("closed") <= ms("final"), "in order: {tr}");
        assert!(ms("final") > 1_600_000_000_000, "on the wall clock (ms), which the app and its page share");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_toggled_take_with_nothing_said_ends_without_a_read() {
        let (mut v, jobs, wav) = voice();
        v.toggle();
        v.toggle();
        v.tail_until = Some(0.0);
        v.tick();
        assert!(jobs.try_recv().is_err(), "silence isn't read (Parakeet makes words up from it)");
        assert_eq!(v.phase, Phase::Idle);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_mic_error_tells_the_app_why() {
        let v = mic_error(&MicError::new("busy", "device in use"));
        assert_eq!(v["code"], "no_input", "the code older app builds already handle");
        assert_eq!(v["reason"], "busy");
        assert_eq!(v["message"], "device in use");
    }

    #[test]
    fn losing_the_mic_mid_take_ends_it_and_idle_ignores_it() {
        let (mut v, _jobs, wav) = voice();
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(v.phase, Phase::Idle, "nothing to end while idle");
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(v.phase, Phase::Idle, "the take ends");
        assert!(v.source.is_none(), "the microphone is off");
        let _ = std::fs::remove_file(wav);
    }

    // ---- the wake word ----

    // What the app was told since the last look, without the level meter (it depends on the clock).
    fn said() -> Vec<Value> {
        SAID.with(|s| std::mem::take(&mut *s.borrow_mut())).into_iter().filter(|e| e["type"] != "level").collect()
    }

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    // What reading a snippet came back with: its words, one ending every half second.
    fn heard(text: &str) -> Vec<(String, f64)> {
        text.split_whitespace().enumerate().map(|(i, w)| (w.to_owned(), (i + 1) as f64 * 0.5)).collect()
    }

    // A Voice waiting for "hey jarvis", the stand-in microphone on.
    fn waiting() -> (Voice, Receiver<Job>, PathBuf) {
        let (mut v, jobs, wav) = voice();
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": true, "phrase": "Hey Jarvis" })));
        v.wake_tick(0.0);
        (v, jobs, wav)
    }

    // Sound coming in while waiting: so many seconds of it, at a level.
    fn sound(v: &mut Voice, secs: f64, level: f64, now: f64) {
        v.buf.lock().unwrap().extend(std::iter::repeat(0.1f32).take((secs * RATE as f64) as usize));
        v.wake_level(level, now);
    }

    // The rest of a take once it is listening: something is said, it is sent, and the closing read comes back.
    fn say_and_send(v: &mut Voice, jobs: &Receiver<Job>) -> Vec<Value> {
        v.on_level(0.5);
        v.on_text(v.take, "what time is it".into(), false);
        v.toggle();
        v.tail_until = Some(0.0);
        v.tick();
        let job = jobs.try_recv().expect("a closing read");
        assert!(job.last && !job.wake && job.take == v.take);
        v.on_text(job.take, "what time is it".into(), true);
        assert_eq!(v.phase, Phase::Idle);
        said()
    }

    #[test]
    fn words_are_compared_without_case_accents_or_punctuation() {
        assert_eq!(plain_words("Hey, JARVIS."), words("hey jarvis"));
        assert_eq!(plain_words("¡Oye, Señorita Ángela!"), words("oye senorita angela"));
        assert_eq!(plain_words("  what's   up?  "), words("whats up"), "an apostrophe is part of its word");
        assert_eq!(plain_words("twenty-one agents (47)"), words("twenty one agents 47"));
        assert_eq!(plain_words("Привет, ДРУГ!"), words("привет друг"), "any alphabet");
        assert_eq!(plain_words("... ?! —"), Vec::<String>::new());
        assert_eq!(plain_words(""), Vec::<String>::new());
    }

    #[test]
    fn the_phrase_is_found_as_whole_words_in_order_anywhere() {
        let m = |phrase: &str, text: &str| wake_match(&plain_words(phrase), &plain_words(text));
        assert_eq!(m("jarvis", "Jarvis."), Some(0));
        assert_eq!(m("Hey Jarvis", "hey, JARVIS!"), Some(1), "case and punctuation don't matter");
        assert_eq!(m("oye señorita", "Oye senorita, ¿qué hora es?"), Some(1), "nor do accents");
        assert_eq!(m("hey jarvis", "so I said hey Jarvis what time is it"), Some(4), "anywhere, and the index is its last word's");
        assert_eq!(m("jarvis", "jarvis no wait jarvis lights on"), Some(3), "the last time it was said");
        // Speech-to-text spells a name more than one way: a longer word may be one letter off.
        for near in ["yarvis", "Jarvi", "jarviss", "jervis", "Jarvis's"] {
            assert_eq!(m("jarvis", near), Some(0), "{near}");
        }
        assert_eq!(m("hey jarvis", "hey yarvis"), Some(1));
        assert_eq!(m("hey computadora", "hey computadoras"), Some(1));
        assert_eq!(m("hey computadora", "hey conputadoras"), Some(1), "a long word may be two off");
        // But not so loosely that other words are it.
        for other in ["service", "harvest", "jar", "travis", "java is", "ja", "paris", "jarring"] {
            assert_eq!(m("jarvis", other), None, "{other}");
        }
        assert_eq!(m("luna", "lunar"), None, "a short word is that word and no other");
        assert_eq!(m("luna", "tuna"), None);
        assert_eq!(m("luna", "Luna!"), Some(0));
        assert_eq!(m("ok luna", "ok luna"), Some(1));
        // Every word of it, next to each other, in order.
        assert_eq!(m("hey jarvis", "hey"), None, "half the phrase");
        assert_eq!(m("hey jarvis", "jarvis"), None);
        assert_eq!(m("hey jarvis", "jarvis hey"), None, "out of order");
        assert_eq!(m("hey jarvis", "hey there jarvis"), None, "something in between");
        assert_eq!(m("hey jarvis", "they jarvis"), None);
        for ordinary in ["the service was very nice today", "it is hard to say what he meant", "and then he said to me", "thank you", ""] {
            assert_eq!(m("hey jarvis", ordinary), None, "{ordinary}");
            assert_eq!(m("jarvis", ordinary), None, "{ordinary}");
        }
        assert_eq!(wake_match(&[], &plain_words("hey jarvis")), None, "no phrase never matches");
    }

    #[test]
    fn the_wake_command_sets_the_phrase_and_takes_it_away() {
        let (mut v, _jobs, wav) = voice();
        assert!(v.wake.words.is_empty(), "off until asked");
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": true, "phrase": "Hey, Jarvis!" })));
        assert_eq!(v.wake.words, words("hey jarvis"));
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": false, "phrase": "Hey Jarvis" })));
        assert!(v.wake.words.is_empty(), "off");
        for odd in [json!({ "cmd": "wake" }), json!({ "cmd": "wake", "on": true }), json!({ "cmd": "wake", "on": true, "phrase": "?!" }), json!({ "cmd": "wake", "on": "yes", "phrase": "jarvis" }), json!({ "cmd": "wake", "on": true, "phrase": 7 })] {
            v.handle(Ev::Cmd(odd.clone()));
            assert!(v.wake.words.is_empty(), "{odd} leaves it off");
        }
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn with_the_wake_word_off_the_microphone_stays_off_and_nothing_is_read() {
        let (mut v, jobs, wav) = voice();
        v.wake_tick(0.0);
        assert!(v.source.is_none(), "the microphone is off between takes");
        sound(&mut v, 2.0, 0.5, 1.0);
        v.on_level(0.5);
        v.wake_tick(2.0);
        v.on_snippet(v.take, heard("hey jarvis"), 2.1);
        assert!(jobs.try_recv().is_err(), "nothing is read");
        assert_eq!(v.phase, Phase::Idle);
        assert!(v.source.is_none());
        assert_eq!(said(), Vec::<Value>::new(), "and the app is told nothing");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn the_wake_word_needs_the_speech_model() {
        let (mut v, _jobs, wav) = voice();
        v.engine = None;
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": true, "phrase": "jarvis" })));
        v.wake_tick(0.0);
        v.wake_tick(60.0);
        assert!(v.source.is_none(), "nothing could read what it hears, so the microphone stays off");
        assert_eq!(said(), Vec::<Value>::new());
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_voice_gets_a_bounded_snippet_read_and_silence_gets_none() {
        let (mut v, jobs, wav) = waiting();
        assert!(v.source.is_some(), "the microphone is on, waiting for the phrase");
        // Quiet: the sound is kept for a moment and never read.
        sound(&mut v, 3.0, 0.05, 1.0);
        v.wake_tick(2.0);
        v.wake_tick(9.0);
        assert!(jobs.try_recv().is_err(), "room noise isn't read");
        // A voice: read once it has gone on a moment, and only the last few seconds of it.
        sound(&mut v, 3.0, 0.5, 10.0);
        v.wake_tick(10.1);
        assert!(jobs.try_recv().is_err(), "not at its first sound");
        v.wake_tick(10.01 + WAKE_SETTLE);
        let job = jobs.try_recv().expect("a read of what was heard");
        assert!(job.wake && !job.last && job.take == v.take);
        assert!(job.audio.len() <= (WAKE_WINDOW * RATE as f64) as usize, "{} samples", job.audio.len());
        assert!(job.audio.len() >= 3 * RATE as usize);
        // While that read is out, and for a second after it, no other is asked for.
        sound(&mut v, 0.5, 0.5, 10.8);
        v.wake_tick(12.0);
        assert!(jobs.try_recv().is_err(), "one read at a time");
        v.on_snippet(job.take, heard("and then he said to me"), 10.9);
        assert_eq!(v.phase, Phase::Idle, "not the phrase: nothing starts");
        sound(&mut v, 0.3, 0.5, 11.0);
        v.wake_tick(11.5);
        assert!(jobs.try_recv().is_err(), "at most one read a second");
        v.wake_tick(10.02 + WAKE_SETTLE + WAKE_EVERY);
        assert!(jobs.try_recv().expect("the next read").wake);
        assert_eq!(said(), Vec::<Value>::new(), "the app hears nothing of all this");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_voice_cut_off_by_a_read_gets_one_more_when_it_stops() {
        let (mut v, jobs, wav) = waiting();
        // Somebody is mid-word when the read goes out: what it reads may end in half a word.
        sound(&mut v, 0.5, 0.5, 10.0);
        sound(&mut v, 0.5, 0.5, 10.5);
        v.wake_tick(10.61);
        let job = jobs.try_recv().expect("a read of what was heard");
        v.on_snippet(job.take, heard("hey jar"), 10.8);
        assert_eq!(v.phase, Phase::Idle, "half the phrase starts nothing");
        // Nothing more is said. The whole of it, with the quiet after, is read once more.
        sound(&mut v, 1.0, 0.02, 11.5);
        v.wake_tick(11.0);
        assert!(jobs.try_recv().is_err(), "not before its second is up");
        v.wake_tick(11.62);
        let job = jobs.try_recv().expect("one more read, now that the voice has stopped");
        v.on_snippet(job.take, heard("hey jarvis"), 11.8);
        assert_eq!(v.phase, Phase::HandsFree);
        // A voice that had stopped before the read is read once, and that is that.
        let (mut q, jobs_q, wav_q) = waiting();
        sound(&mut q, 1.0, 0.5, 10.0);
        sound(&mut q, 1.0, 0.02, 11.0);
        q.wake_tick(11.0);
        let job = jobs_q.try_recv().expect("a read of what was heard");
        q.on_snippet(job.take, heard("thank you"), 11.2);
        sound(&mut q, 3.0, 0.02, 14.0);
        q.wake_tick(14.0);
        q.wake_tick(60.0);
        assert!(jobs_q.try_recv().is_err(), "quiet is never read");
        for wav in [wav, wav_q] {
            let _ = std::fs::remove_file(wav);
        }
    }

    #[test]
    fn the_phrase_starts_the_take_a_toggle_starts() {
        // A toggled take with the wake word off, start to end: what the app is told today.
        let (mut a, jobs_a, wav_a) = voice();
        a.toggle();
        let mut toggled = said();
        assert_eq!(toggled, vec![json!({ "type": "state", "state": "listening", "mode": "handsfree" })]);
        toggled.extend(say_and_send(&mut a, &jobs_a));
        assert_eq!(toggled.last(), Some(&json!({ "type": "state", "state": "idle" })));
        assert!(a.source.is_none(), "and the microphone goes off after it, as ever");

        // The same take, started by the phrase.
        let (mut b, jobs_b, wav_b) = waiting();
        sound(&mut b, 2.0, 0.5, 1.0);
        b.wake_tick(2.0);
        let job = jobs_b.try_recv().expect("a read of what was heard");
        b.on_snippet(job.take, heard("Hey, Jarvis."), 2.3);
        assert_eq!(b.phase, Phase::HandsFree, "listening hands-free, as the toggle does");
        assert!(b.source.is_some());
        let mut woken = said();
        woken.extend(say_and_send(&mut b, &jobs_b));
        assert_eq!(woken, toggled, "the app is told exactly what a toggled take tells it");

        // And a toggle while it waits for the phrase is still that take, on the microphone that is already on.
        let (mut c, jobs_c, wav_c) = waiting();
        sound(&mut c, 2.0, 0.5, 1.0);
        c.toggle();
        assert_eq!(c.phase, Phase::HandsFree);
        assert!(c.buf.lock().unwrap().len() < RATE as usize, "the take starts from now, not from what was heard before");
        let mut both = said();
        both.extend(say_and_send(&mut c, &jobs_c));
        assert_eq!(both, toggled);
        for wav in [wav_a, wav_b, wav_c] {
            let _ = std::fs::remove_file(wav);
        }
    }

    #[test]
    fn the_take_starts_a_moment_after_the_phrase_but_not_far_into_the_next_word() {
        assert_eq!(wake_cut(1.0, None), 1.4, "nothing follows: the whole margin");
        assert_eq!(wake_cut(1.0, Some(3.0)), 1.4, "the next word is far off");
        assert!((wake_cut(1.0, Some(1.3)) - 1.21).abs() < 1e-9, "a word right behind it: most of the way to its end");
        // Measured with the real model: "center" was given 2.96 s and "rear" 3.44 s, and "center" was still sounding
        // at 3.15 s (a cut there read "Center, rear, left." one time in three).
        assert!(wake_cut(2.96, Some(3.44)) >= 3.29, "past the tail of the phrase");
        assert_eq!(wake_cut(1.0, Some(1.0)), 1.0, "two words out of one timed word: no room");
        assert_eq!(wake_cut(-0.5, None), 0.4, "a time before the snippet counts as its start");
    }

    #[test]
    fn what_is_said_after_the_phrase_begins_the_take() {
        let (mut v, jobs, wav) = waiting();
        // Six seconds of sound, each sample saying where it is, so what is kept can be told.
        {
            let mut buf = v.buf.lock().unwrap();
            buf.clear();
            buf.extend((0..6 * RATE).map(|i| i as f32));
        }
        v.wake_level(0.5, 1.0);
        v.wake_tick(2.0);
        let job = jobs.try_recv().expect("a read of what was heard");
        assert!(job.audio[0] >= (2 * RATE) as f32, "only the last seconds are read");
        // "Hey Jarvis, what time": the phrase ends one second into the snippet, and more follows it.
        v.on_snippet(job.take, vec![("Hey".into(), 0.4), ("Jarvis,".into(), 1.0), ("what".into(), 1.3), ("time".into(), 1.6)], 2.3);
        assert_eq!(v.phase, Phase::HandsFree);
        // The phrase ends at 1.0 s and the next word at 1.3 s: the take starts a little after the phrase (the model's end
        // time lands early: the tail of "center" came through as "Enter"), without eating far into "what".
        let first = v.buf.lock().unwrap()[0] - job.audio[0];
        assert!((first - 1.21 * RATE as f32).abs() <= 1.0, "the take starts just after the phrase ended ({first})");
        assert!(v.spoke, "words are already in it, so it is read even if nothing more is said");
        v.cancel();

        // Only the phrase, then a pause: the take is open, with nothing to read until a voice comes.
        v.wake.played = false; // the stand-in microphone plays once per wake command
        v.wake_tick(20.0);
        sound(&mut v, 2.0, 0.5, 21.0);
        v.wake_tick(22.0);
        let job = jobs.try_recv().expect("a read of what was heard");
        v.on_snippet(job.take, heard("hey jarvis"), 22.3);
        assert_eq!(v.phase, Phase::HandsFree);
        assert!(!v.spoke);
        v.cancel();

        // The phrase had only just been said when it was read, and nothing came after: still nothing to read.
        v.wake.played = false;
        v.wake_tick(40.0);
        sound(&mut v, 1.0, 0.5, 41.0);
        sound(&mut v, 1.0, 0.5, 41.9);
        v.wake_tick(42.0);
        let job = jobs.try_recv().expect("a read of what was heard");
        sound(&mut v, 0.2, 0.02, 42.2);
        v.on_snippet(job.take, heard("hey jarvis"), 42.3);
        assert_eq!(v.phase, Phase::HandsFree);
        assert!(!v.spoke, "quiet is not a voice");
        v.cancel();

        // The phrase, and a voice went on while it was being read: that voice is in the take.
        v.wake.played = false;
        v.wake_tick(60.0);
        sound(&mut v, 2.0, 0.5, 61.0);
        v.wake_tick(62.0);
        let job = jobs.try_recv().expect("a read of what was heard");
        sound(&mut v, 0.2, 0.5, 62.2);
        v.on_snippet(job.take, heard("hey jarvis"), 62.3);
        assert_eq!(v.phase, Phase::HandsFree);
        assert!(v.spoke);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_take_under_way_is_never_watched_for_the_phrase() {
        let (mut v, jobs, wav) = waiting();
        v.toggle();
        assert_eq!(v.phase, Phase::HandsFree);
        said();
        // Seconds of talk in the take: all of it stays in the take, and none of it is read as a snippet.
        sound(&mut v, 6.0, 0.5, 1.0);
        v.on_level(0.5);
        v.wake_tick(2.0);
        v.wake_tick(8.0);
        assert!(v.buf.lock().unwrap().len() >= 6 * RATE as usize, "a take keeps everything said");
        assert!(jobs.try_recv().is_err(), "no snippet is read");
        // A snippet read that was out when the take began comes back with the phrase: it changes nothing.
        let take = v.take;
        v.on_snippet(take - 1, heard("hey jarvis"), 8.1);
        v.on_snippet(take, heard("hey jarvis"), 8.1);
        assert_eq!((v.phase, v.take), (Phase::HandsFree, take));
        assert_eq!(said(), Vec::<Value>::new());
        // When it ends the microphone goes off, and the wake word takes it back.
        v.external_cancel();
        assert!(v.source.is_none());
        v.wake.played = false; // the stand-in microphone plays once per wake command
        v.wake_tick(9.0);
        assert!(v.source.is_some(), "waiting for the phrase again");
        v.on_snippet(take, heard("hey jarvis"), 9.1);
        assert_eq!(v.phase, Phase::Idle, "an answer from before the take is stale");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn roamies_own_voice_is_not_listened_to() {
        let (mut v, jobs, wav) = waiting();
        // A read is out when the reply starts playing: its answer starts nothing.
        sound(&mut v, 2.0, 0.5, 1.0);
        v.wake_tick(2.0);
        let job = jobs.try_recv().expect("a read of what was heard");
        v.set_speaking(true, 2.1);
        v.on_snippet(job.take, heard("hey jarvis"), 2.2);
        assert_eq!(v.phase, Phase::Idle);
        // While it plays: nothing is kept and nothing is read.
        sound(&mut v, 3.0, 0.5, 3.0);
        v.wake_tick(5.0);
        assert!(jobs.try_recv().is_err());
        assert!(v.buf.lock().unwrap().len() < RATE as usize, "what the reply sounded like isn't kept");
        // And for a moment after it stops (its echo, the speakers' delay).
        v.set_speaking(false, 10.0);
        sound(&mut v, 0.5, 0.5, 10.0 + WAKE_AFTER_SPEECH - 0.1);
        v.wake_tick(10.0 + WAKE_AFTER_SPEECH - 0.05);
        assert!(v.buf.lock().unwrap().len() < RATE as usize);
        // Then it listens again.
        sound(&mut v, 2.0, 0.5, 12.0);
        v.wake_tick(13.0);
        let job = jobs.try_recv().expect("listening again");
        v.on_snippet(job.take, heard("hey jarvis"), 13.2);
        assert_eq!(v.phase, Phase::HandsFree);
        // The command is how the app says so.
        let (mut w, _jobs, wav2) = waiting();
        w.handle(Ev::Cmd(json!({ "cmd": "speaking", "on": true })));
        assert!(w.wake.speaking);
        w.handle(Ev::Cmd(json!({ "cmd": "speaking", "on": false })));
        assert!(!w.wake.speaking && w.wake.quiet_until > 0.0);
        for wav in [wav, wav2] {
            let _ = std::fs::remove_file(wav);
        }
    }

    #[test]
    fn an_hour_of_talk_keeps_a_few_seconds_and_one_read_a_second() {
        let (mut v, jobs, wav) = waiting();
        let chunk = vec![0.1f32; RATE as usize / 50];
        // The stand-in microphone adds its own sound meanwhile, so a little room on top.
        let most = ((WAKE_WINDOW + WAKE_SLACK) * RATE as f64) as usize + RATE as usize;
        let (mut reads, mut now) = (0, 0.0);
        // An hour of somebody talking, 20 ms at a time, every read answered a little later with other words.
        for step in 0..3600 * 50 {
            now = step as f64 * 0.02;
            v.buf.lock().unwrap().extend_from_slice(&chunk);
            v.wake_level(0.5, now);
            v.wake_tick(now);
            assert!(v.buf.lock().unwrap().len() <= most, "the buffer grew to {}", v.buf.lock().unwrap().len());
            while let Ok(job) = jobs.try_recv() {
                assert!(job.wake && !job.last && job.audio.len() <= (WAKE_WINDOW * RATE as f64) as usize);
                reads += 1;
                v.on_snippet(job.take, heard("and then he said to me"), now + 0.3);
            }
        }
        assert!((3000..=3601).contains(&reads), "{reads} reads in an hour");
        // The engine stops answering: one read stays out, and no others pile up behind it.
        for step in 0..10 * 50 {
            let later = now + 0.02 + step as f64 * 0.02;
            v.buf.lock().unwrap().extend_from_slice(&chunk);
            v.wake_level(0.5, later);
            v.wake_tick(later);
        }
        assert_eq!(jobs.try_iter().count(), 1, "one read at a time");
        assert!(v.buf.lock().unwrap().len() <= most);
        assert_eq!(v.phase, Phase::Idle);
        assert_eq!(said(), Vec::<Value>::new());
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_microphone_that_fails_while_waiting_is_said_once_and_tried_again_slowly() {
        // It won't open (the stand-in file isn't there).
        let (jobs, _jrx) = mpsc::channel();
        let (tx, _events) = mpsc::channel();
        let mut v = Voice::new(Some(jobs), Some(PathBuf::from("/nonexistent/roamies-no-mic.wav")), tx);
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": true, "phrase": "jarvis" })));
        v.wake_tick(0.0);
        let told = said();
        assert_eq!(told.len(), 1, "{told:?}");
        assert_eq!((&told[0]["type"], &told[0]["code"], &told[0]["reason"]), (&json!("error"), &json!("no_input"), &json!("failed")), "as a take's mic error is");
        assert_eq!(v.phase, Phase::Idle);
        assert_eq!(v.wake.retry_at, WAKE_RETRY);
        v.wake_tick(1.0);
        v.wake_tick(WAKE_RETRY - 0.1);
        assert_eq!(v.wake.retry_at, WAKE_RETRY, "not tried again before its time");
        v.wake_tick(WAKE_RETRY + 0.1);
        assert_eq!(v.wake.retry_at, 2.0 * WAKE_RETRY + 0.1, "tried again, slowly");
        assert_eq!(said(), Vec::<Value>::new(), "and the app isn't told twice");

        // It was on and stops (unplugged).
        let (mut v, _jobs, wav) = waiting();
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert!(v.source.is_none(), "the dead stream is let go");
        assert_eq!(said(), vec![mic_error(&MicError::new("lost", "unplugged"))], "said once, and no take was cancelled");
        v.wake.played = false; // the stand-in microphone plays once per wake command
        let at = v.wake.retry_at;
        v.wake_tick(at - 0.1);
        assert!(v.source.is_none());
        v.wake_tick(at + 0.1);
        assert!(v.source.is_some(), "tried again later");
        // It dies again before any sound came in: the same failure, not said again.
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(said(), Vec::<Value>::new());
        // Sound came in, so it worked: the next failure is a new one.
        v.wake.played = false;
        let at = v.wake.retry_at;
        v.wake_tick(at + 0.1);
        sound(&mut v, 0.1, 0.05, at + 0.2);
        v.handle(Ev::AudioFailed(MicError::new("lost", "unplugged")));
        assert_eq!(said().len(), 1);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn switching_the_wake_word_off_lets_the_microphone_go() {
        let (mut v, jobs, wav) = waiting();
        sound(&mut v, 2.0, 0.5, 1.0);
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": false })));
        assert!(v.source.is_none(), "the microphone is off");
        assert!(v.buf.lock().unwrap().is_empty(), "and nothing it heard is kept");
        v.wake_tick(2.0);
        assert!(v.source.is_none());
        assert!(jobs.try_recv().is_err());
        // Off in the middle of a take: the take keeps its microphone.
        let (mut t, _jobs, wav2) = waiting();
        t.toggle();
        t.handle(Ev::Cmd(json!({ "cmd": "wake", "on": false })));
        assert_eq!(t.phase, Phase::HandsFree);
        assert!(t.source.is_some());
        for wav in [wav, wav2] {
            let _ = std::fs::remove_file(wav);
        }
    }

    // ---- the voice gate (vad.rs), the end of a turn and the follow-up ----

    fn with_vad(v: &mut Voice) {
        v.vad = Some(vad::Vad::new(Box::new(vad::tests::Loud)));
    }

    // A Voice whose microphone only hears what the test feeds it, its voice told by the VAD (here: anything loud).
    fn gated() -> (Voice, Receiver<Job>, PathBuf) {
        let (mut v, jobs, wav) = voice();
        with_vad(&mut v);
        v.source = Some(Source::idle());
        (v, jobs, wav)
    }

    // Waiting for "hey jarvis" that way.
    fn waiting_gated() -> (Voice, Receiver<Job>, PathBuf) {
        let (mut v, jobs, wav) = gated();
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": true, "phrase": "Hey Jarvis" })));
        v.wake.played = true; // never the stand-in WAV: its tone would be a voice
        (v, jobs, wav)
    }

    fn talk(secs: f64) -> Vec<f32> {
        vec![0.3; (secs * RATE as f64) as usize]
    }

    fn hush(secs: f64) -> Vec<f32> {
        vec![0.0; (secs * RATE as f64) as usize]
    }

    // Sound as the microphone brings it, 20 ms at a time from `at`, always at a level the volume gate takes for a voice
    // (only the VAD may decide), the wake word looked after at every step. Returns when it ends.
    fn feed(v: &mut Voice, audio: &[f32], at: f64) -> f64 {
        let mut now = at;
        for c in audio.chunks(RATE as usize / 50) {
            v.buf.lock().unwrap().extend_from_slice(c);
            v.tap.lock().unwrap().extend_from_slice(c);
            v.heard(0.5, now);
            v.wake_tick(now);
            now += 0.02;
        }
        now
    }

    #[test]
    fn without_the_voice_activity_model_a_voice_is_still_a_level() {
        let dir = std::env::temp_dir().join(format!("roamies-voice-novad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load_vad(&dir).is_none(), "not downloaded");
        std::fs::write(dir.join(VAD_MODEL), b"not a model").unwrap();
        assert!(load_vad(&dir).is_none(), "a broken file");
        let _ = std::fs::remove_dir_all(&dir);
        // And then the level decides, as before (the tests above all run that way).
        let (mut v, _jobs, wav) = voice();
        assert!(v.vad.is_none());
        v.source = Some(Source::idle());
        v.toggle();
        v.heard(0.5, v.listen_at + 1.0);
        assert!(v.spoke && v.voice_at == v.listen_at + 1.0);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn with_the_vad_a_take_hears_a_voice_by_its_sound_not_its_level() {
        let (mut v, _jobs, wav) = gated();
        v.toggle();
        let t = v.listen_at;
        let end = feed(&mut v, &hush(2.0), t);
        assert!(!v.spoke && v.voice_at == t, "loud but no voice: nothing was said");
        let end = feed(&mut v, &talk(1.0), end);
        assert!(v.spoke, "a voice");
        assert!(v.voice_at > end - 0.1, "heard to its end");
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn with_the_vad_the_wake_word_reads_only_stretches_of_voice() {
        let (mut v, jobs, wav) = waiting_gated();
        let at = feed(&mut v, &hush(5.0), 1.0);
        assert!(jobs.try_recv().is_err(), "room noise, however loud, is never read");
        let at = feed(&mut v, &talk(1.0), at);
        assert!(jobs.try_recv().is_err(), "not while the voice goes on");
        let at = feed(&mut v, &hush(0.6), at);
        let job = jobs.try_recv().expect("the stretch of voice is read once it ended");
        assert!(job.wake && !job.last);
        let secs = job.audio.len() as f64 / RATE as f64;
        assert!((1.0 + WAKE_PRE..1.5 + WAKE_PRE).contains(&secs), "the voice, a little before and after it: {secs} s");
        assert!(job.audio.iter().take(RATE as usize / 10).all(|&s| s == 0.0) && job.audio.iter().any(|&s| s > 0.0));
        v.on_snippet(job.take, heard("thank you"), at);
        feed(&mut v, &hush(5.0), at);
        assert!(jobs.try_recv().is_err(), "and nothing more until another voice");
        assert_eq!(v.phase, Phase::Idle);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_long_voice_is_read_at_the_cap_and_the_phrase_across_the_cut_is_still_found() {
        let (mut v, jobs, wav) = waiting_gated();
        let at = feed(&mut v, &hush(0.5), 0.0);
        // Four seconds of talk, each sample saying where it is in the stream.
        let start = RATE as usize / 2;
        let speech: Vec<f32> = (0..4 * RATE as usize).map(|i| 0.1 + i as f32 * 1e-6).collect();
        let place = |x: f32| start as f64 / RATE as f64 + (x as f64 - 0.1) * 1e6 / RATE as f64;
        let mut now = at;
        let mut first = None;
        for c in speech.chunks(RATE as usize / 50) {
            now = feed(&mut v, c, now);
            if first.is_none() {
                first = jobs.try_recv().ok();
            }
        }
        let first = first.expect("read at the cap, while it still goes on");
        assert!(first.audio.len() as f64 <= (v.wake.cap + 0.1) * RATE as f64, "{} samples", first.audio.len());
        let cut = place(*first.audio.last().unwrap());
        assert!((2.5..3.2).contains(&cut), "cut at {cut} s");
        let now = feed(&mut v, &hush(0.6), now);
        assert!(jobs.try_recv().is_err(), "one read at a time");
        v.on_snippet(first.take, heard("and then hey"), now);
        v.wake_tick(now);
        let second = jobs.try_recv().expect("the rest, from a second before the cut");
        let from = place(second.audio[0]);
        assert!((from - (cut - v.wake.overlap)).abs() < 0.05, "from {from} s");
        // "hey jarvis" said across the cut (around it) is whole in the second read.
        v.on_snippet(second.take, vec![("hey".into(), 0.6), ("jarvis".into(), 1.0)], now);
        assert_eq!(v.phase, Phase::HandsFree, "the phrase was found");
        let begins = place(v.buf.lock().unwrap().iter().copied().find(|&s| s > 0.0).unwrap());
        assert!((begins - (from + 1.4)).abs() < 0.05, "the take begins after it: {begins} s");
        // A voice that ended inside the overlap of a read already made: nothing more to read.
        v.wake_segment(5 * RATE as u64, 4 * RATE as u64, false);
        assert_eq!(v.wake.next, None);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn with_the_vad_roamies_own_voice_is_not_read_and_after_it_a_voice_is_a_new_question() {
        let (mut v, jobs, wav) = waiting_gated();
        v.set_speaking(true, 1.0);
        let at = feed(&mut v, &talk(3.0), 1.0);
        assert!(jobs.try_recv().is_err() && v.phase == Phase::Idle, "the reply itself");
        v.set_speaking(false, at);
        // Its echo, just after: still not taken, and not carried over into what comes next.
        let at = feed(&mut v, &talk(WAKE_AFTER_SPEECH - 0.2), at);
        let at = feed(&mut v, &hush(0.5), at);
        assert!(jobs.try_recv().is_err() && v.phase == Phase::Idle, "its echo");
        let _ = said();
        // Then, within the follow-up, a voice starts a take without the phrase, from its first word.
        feed(&mut v, &talk(0.4), at);
        assert_eq!(v.phase, Phase::HandsFree, "a follow-up question");
        assert!(jobs.try_recv().is_err(), "without reading it for the phrase");
        assert_eq!(said(), vec![json!({ "type": "state", "state": "listening", "mode": "handsfree" })], "as a toggled take");
        assert!(v.spoke);
        assert!(v.buf.lock().unwrap().iter().take(RATE as usize / 20).any(|&s| s == 0.0), "a moment before the first word is kept");
        v.cancel();
        // Later than the follow-up: only the phrase starts one.
        let (mut w, jobs, wav2) = waiting_gated();
        w.set_speaking(true, 1.0);
        w.set_speaking(false, 2.0);
        let at = feed(&mut w, &hush(WAKE_AFTER_SPEECH + FOLLOW_UP + 0.2), 2.0);
        let at = feed(&mut w, &talk(1.0), at);
        feed(&mut w, &hush(0.6), at);
        assert_eq!(w.phase, Phase::Idle, "too late for a follow-up");
        assert!(jobs.try_recv().is_ok_and(|j| j.wake), "read for the phrase instead");
        // A take of its own also uses the follow-up up.
        let (mut x, _jobs, wav3) = waiting_gated();
        x.set_speaking(true, 0.5);
        x.set_speaking(false, 1.0);
        assert!(x.wake.follow_until > 1.0);
        x.toggle();
        x.cancel();
        assert_eq!(x.wake.follow_until, 0.0);
        for wav in [wav, wav2, wav3] {
            let _ = std::fs::remove_file(wav);
        }
    }

    // A hands-free take with the VAD and a stand-in turn check (the test answers its questions): one second of talk.
    fn turn_take() -> (Voice, Receiver<TurnJob>, PathBuf, f64) {
        let (mut v, _jobs, wav) = gated();
        let (ttx, turns) = mpsc::channel();
        v.turn = Some(ttx);
        v.toggle();
        let t = v.listen_at;
        feed(&mut v, &talk(1.0), t);
        (v.best, v.heard_at) = ("the thing is".into(), v.voice_at);
        let voiced = v.voice_at;
        (v, turns, wav, voiced)
    }

    #[test]
    fn a_turn_that_sounds_over_ends_the_take_at_once() {
        let (mut v, turns, wav, voiced) = turn_take();
        v.ask_turn(voiced + TURN_SILENCE - 0.05);
        assert!(turns.try_recv().is_err(), "not before a quarter second of quiet");
        v.ask_turn(voiced + TURN_SILENCE + 1e-9);
        let job = turns.try_recv().expect("asked once the voice stopped");
        assert_eq!((job.take, job.voiced), (v.take, voiced));
        assert!(job.audio.len() >= RATE as usize && job.audio.len() <= (TURN_AUDIO * RATE as f64) as usize);
        v.ask_turn(voiced + 0.6);
        assert!(turns.try_recv().is_err(), "once per silence");
        // Over, and the live read sent after the voice stopped heard a finished question: it ends there.
        v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: Some(true) });
        assert_eq!(v.phase, Phase::HandsFree, "the words so far (\"the thing is\") don't sound finished");
        (v.read_at, v.reading) = (voiced + READ_MARGIN, true);
        v.on_text(v.take, "what time is it?".into(), false);
        assert_eq!(v.phase, Phase::Finishing, "over: no waiting out the pause");
        assert_eq!(v.ended_why, "turn complete");
        // In the other order (the words first, then the check) the same.
        let (mut v, turns, wav3, voiced) = turn_take();
        (v.read_at, v.reading) = (voiced + READ_MARGIN, true);
        v.on_text(v.take, "Open the browser and look up tomorrow's weather.".into(), false);
        v.ask_turn(voiced + 0.3);
        let job = turns.try_recv().expect("asked");
        v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: Some(true) });
        assert_eq!((v.phase, v.ended_why), (Phase::Finishing, "turn complete"), "a whole request ends at once too");
        let _ = std::fs::remove_file(wav3);
        // Only the last eight seconds of a long take go to the check.
        let (mut v, turns, wav2, _) = turn_take();
        let from = v.voice_at;
        let at = feed(&mut v, &talk(9.0), from);
        v.ask_turn(at + 0.3);
        assert_eq!(turns.try_recv().expect("asked").audio.len(), (TURN_AUDIO * RATE as f64) as usize);
        for wav in [wav, wav2] {
            let _ = std::fs::remove_file(wav);
        }
    }

    #[test]
    fn a_turn_not_over_or_unknown_keeps_todays_pauses() {
        // Not over: the full pause, as before.
        let (mut v, turns, wav, voiced) = turn_take();
        v.ask_turn(voiced + 0.3);
        let job = turns.try_recv().expect("asked");
        v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: Some(false) });
        v.tick_keys(voiced + PAUSE_ENDS - 0.05);
        assert_eq!(v.phase, Phase::HandsFree);
        v.tick_keys(voiced + PAUSE_ENDS + 0.05);
        assert_eq!((v.phase, v.ended_why), (Phase::Finishing, "pause"), "the cap");
        // The check failed: the same.
        let (mut v, turns, wav2, voiced) = turn_take();
        v.ask_turn(voiced + 0.3);
        let job = turns.try_recv().expect("asked");
        v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: None });
        v.tick_keys(voiced + PAUSE_ENDS - 0.05);
        assert_eq!(v.phase, Phase::HandsFree);
        // An answer about an older silence (they spoke again since) or an older take changes nothing.
        let (mut v, turns, wav3, voiced) = turn_take();
        v.ask_turn(voiced + 0.3);
        let job = turns.try_recv().expect("asked");
        feed(&mut v, &talk(0.5), voiced + 0.4);
        v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: Some(true) });
        v.handle(Ev::Turn { take: job.take - 1, voiced: v.voice_at, complete: Some(true) });
        assert_eq!(v.phase, Phase::HandsFree);
        // No check (no model): never asked, today's timings; the punctuation rule still shortens the pause.
        let (mut v, _turns, wav4, voiced) = turn_take();
        v.turn = None;
        v.ask_turn(voiced + 0.3);
        v.tick_keys(voiced + PAUSE_ENDS - 0.05);
        assert_eq!(v.phase, Phase::HandsFree);
        let (mut v, turns, wav5, voiced) = turn_take();
        (v.best, v.read_upto) = ("what time is it?".into(), voiced + 0.3);
        v.ask_turn(voiced + 0.3);
        let job = turns.try_recv().expect("asked");
        v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: Some(false) });
        v.tick_keys(voiced + SHORT_PAUSE + 0.05);
        assert_eq!((v.phase, v.ended_why), (Phase::Finishing, "short pause"));
        // Without the VAD there is no quarter second of quiet to ask about.
        let (mut v, _jobs, wav6) = voice();
        let (ttx, turns) = mpsc::channel();
        v.turn = Some(ttx);
        v.source = Some(Source::idle());
        v.toggle();
        v.heard(0.5, v.listen_at + 0.5);
        v.ask_turn(v.listen_at + 2.0);
        assert!(turns.try_recv().is_err());
        for wav in [wav, wav2, wav3, wav4, wav5, wav6] {
            let _ = std::fs::remove_file(wav);
        }
    }

    // Regression (verifier B2): Smart Turn said "over" at a pause mid-sentence and the take was sent as "Quiero
    // saber." / "…gastos y..." / "Yeah." (a filler). The check only ends a take whose words, all heard, sound like a
    // finished turn: a question or exclamation, or a full stop after four words or more that don't end hanging.
    #[test]
    fn a_turn_check_never_cuts_off_words_that_do_not_sound_finished() {
        for text in ["", "Quiero saber.", "Necesito que me digas el total de gastos y...", "Yeah.", "Eh.", "Sí.", "quiero ver mis gastos de", "Necesito que me digas el total de gastos y", "Dime cuánto gasté este."] {
            let (mut v, turns, wav, voiced) = turn_take();
            (v.read_at, v.reading) = (voiced + READ_MARGIN, true);
            v.on_text(v.take, text.into(), false);
            v.ask_turn(voiced + 0.3);
            let job = turns.try_recv().expect("asked");
            v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: Some(true) });
            assert_eq!(v.phase, Phase::HandsFree, "{text:?}");
            let _ = std::fs::remove_file(wav);
        }
        // A finished question whose last read didn't hear its end: not until a read has.
        let (mut v, turns, wav, voiced) = turn_take();
        (v.read_at, v.reading) = (voiced - 0.3, true);
        v.on_text(v.take, "what time is it?".into(), false);
        v.ask_turn(voiced + 0.3);
        let job = turns.try_recv().expect("asked");
        v.handle(Ev::Turn { take: job.take, voiced: job.voiced, complete: Some(true) });
        assert_eq!(v.phase, Phase::HandsFree, "the read may have missed words");
        let _ = std::fs::remove_file(wav);
        // Fillers leave a sentence hanging, as "and" does: the full pause.
        for filler in ["Quiero ver, eh.", "so um.", "Y este."] {
            assert_eq!(pause_ends(filler, true), PAUSE_ENDS, "{filler}");
        }
    }

    // Regression (verifier B1): the 2.5 s cap cut "…ahora mismo oye computa|dora", the read still matched the
    // phrase, and the take began with its tail ("Mm-hmm.", or nothing heard), losing the question after it.
    #[test]
    fn a_phrase_the_cap_may_have_cut_is_read_again_whole_before_a_take_starts() {
        let (mut v, jobs, wav) = waiting_gated();
        let at = feed(&mut v, &hush(0.5), 0.0);
        // Talk, each sample saying where it is in the stream (from 0.5 s).
        let speech: Vec<f32> = (0..5 * RATE as usize).map(|i| 0.1 + i as f32 * 1e-6).collect();
        let place = |x: f32| 0.5 + (x as f64 - 0.1) * 1e6 / RATE as f64;
        let starts = |a: &[f32]| {
            let k = a.iter().position(|&x| x > 0.0).unwrap();
            place(a[k]) - k as f64 / RATE as f64
        };
        let (mut now, mut fed, mut first) = (at, 0, None);
        for c in speech.chunks(RATE as usize / 50) {
            now = feed(&mut v, c, now);
            fed += c.len();
            if let Ok(j) = jobs.try_recv() {
                first = Some(j);
                break;
            }
        }
        let first = first.expect("read at the cap");
        let secs = first.audio.len() as f64 / RATE as f64;
        // The phrase ends a moment before the cut: its last word may have been cut through.
        v.on_snippet(first.take, vec![("te".into(), secs - 1.6), ("digo".into(), secs - 1.2), ("hey".into(), secs - 0.6), ("jarvis".into(), secs - 0.1)], now);
        assert_eq!(v.phase, Phase::Idle, "no take from a phrase that may be cut");
        let phrase_at = starts(&first.audio) + secs - 1.2;
        let now = feed(&mut v, &speech[fed..fed + RATE as usize / 2], now);
        let now = feed(&mut v, &hush(0.6), now);
        let second = jobs.try_recv().expect("read again, with all of the phrase");
        let from = starts(&second.audio);
        assert!((from - (phrase_at - WAKE_PRE)).abs() < 0.05, "from {from} s, the phrase at {phrase_at} s");
        let into = phrase_at - from;
        // The second read misheard its first word ("hey" as "they"): the phrase was heard already, its last word is
        // enough to know where it ends.
        v.on_snippet(second.take, vec![("they".into(), into + 0.6), ("jarvis".into(), into + 1.1)], now);
        assert_eq!(v.phase, Phase::HandsFree, "now the take starts");
        let begins = place(v.buf.lock().unwrap().iter().copied().find(|&s| s > 0.0).unwrap());
        assert!((begins - (from + into + 1.5)).abs() < 0.05, "after the phrase: {begins} s");
        let _ = std::fs::remove_file(wav);
        // A phrase well inside the read still starts the take at once.
        let (mut v, jobs, wav) = waiting_gated();
        let mut now = feed(&mut v, &hush(0.5), 0.0);
        let mut first = None;
        for c in speech.chunks(RATE as usize / 50) {
            now = feed(&mut v, c, now);
            if let Ok(j) = jobs.try_recv() {
                first = Some(j);
                break;
            }
        }
        let first = first.expect("read at the cap");
        let secs = first.audio.len() as f64 / RATE as f64;
        v.on_snippet(first.take, vec![("hey".into(), secs - 1.6), ("jarvis".into(), secs - 1.1), ("what".into(), secs - 0.7)], now);
        assert_eq!(v.phase, Phase::HandsFree);
        let _ = std::fs::remove_file(wav);
    }

    #[test]
    fn a_longer_phrase_gets_a_longer_overlap_and_the_buffer_keeps_it() {
        let (mut v, _jobs, wav) = waiting_gated();
        assert!((1.0..1.5).contains(&v.wake.overlap) && v.wake.cap >= WAKE_CAP, "{} {}", v.wake.overlap, v.wake.cap);
        v.handle(Ev::Cmd(json!({ "cmd": "wake", "on": true, "phrase": "Oye asistente de la casa por favor" })));
        v.wake.played = true;
        assert!(v.wake.overlap >= 2.2 && v.wake.cap >= v.wake.overlap + 0.9, "{} {}", v.wake.overlap, v.wake.cap);
        feed(&mut v, &talk(9.0), 0.0);
        assert!(v.buf.lock().unwrap().len() as f64 >= (v.wake.cap + v.wake.overlap) * RATE as f64, "what a read needs is kept");
        let _ = std::fs::remove_file(wav);
    }

    // ONNX Runtime builds one environment per process: Parakeet, the VAD and Smart Turn must all load in it.
    // ROAMIES_TEST_MODEL=<dir with the Parakeet files, silero-vad.onnx and smart-turn.onnx> cargo test together
    #[test]
    fn the_speech_vad_and_turn_models_load_together() {
        let Some(dir) = std::env::var_os("ROAMIES_TEST_MODEL").map(PathBuf::from) else {
            return eprintln!("skipped: set ROAMIES_TEST_MODEL=<model dir>");
        };
        let mut asr = load_model(&dir).expect("Parakeet");
        let mut gate = load_vad(&dir).expect("Silero VAD");
        let mut turn = load_turn(&dir).expect("Smart Turn");
        let mut steps = Vec::new();
        gate.feed(&[0.0; 2048], &mut steps);
        assert_eq!(steps.len(), 4);
        assert!(turn.complete(&[0.0; 16_000]).is_ok_and(|p| (0.0..=1.0).contains(&p)));
        assert_eq!(transcribe(&mut asr, vec![0.0; 100]), "");
    }

    #[test]
    fn the_turn_check_runs_on_its_own_thread_and_answers_with_its_threshold() {
        struct Says(Result<f32, String>);
        impl TurnCheck for Says {
            fn complete(&mut self, _: &[f32]) -> Result<f32, String> {
                self.0.clone()
            }
        }
        for (says, complete) in [(Ok(0.8), Some(true)), (Ok(0.3), Some(false)), (Err("boom".to_owned()), None)] {
            let (tx, rx) = mpsc::channel();
            let jobs = spawn_turn(Box::new(move || Some(Box::new(Says(says)) as Box<dyn TurnCheck>)), tx);
            jobs.send(TurnJob { take: 3, voiced: 1.5, audio: vec![0.0; 100] }).unwrap();
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ev::Turn { take: 3, voiced, complete: c }) => assert!(voiced == 1.5 && c == complete),
                _ => panic!("no answer"),
            }
        }
        // No model: the thread ends, and asking fails (the take keeps today's rules).
        let (tx, _rx) = mpsc::channel();
        let jobs = spawn_turn(Box::new(|| None), tx);
        thread::sleep(Duration::from_millis(50));
        assert!(jobs.send(TurnJob { take: 1, voiced: 0.0, audio: Vec::new() }).is_err());
    }
}
