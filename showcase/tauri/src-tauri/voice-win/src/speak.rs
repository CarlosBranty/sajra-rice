// The local voice: a Piper voice (VITS, ONNX) spoken on this PC, the way upstream Piper 1.8 (OHF-Voice/piper1-gpl,
// GPL-3.0) speaks it: espeak-ng turns the text into IPA clause by clause (espeak_TextToPhonemesWithTerminator), each
// clause gets its punctuation back, the phonemes are split into Unicode code points (NFD) with the voice's vowel
// clusters ("eɪ") merged into one token, and the tokens become ids (^ _ id _ id _ … $) for the model, one run per
// sentence. Each sentence's audio is scaled to full range and sent as 16-bit PCM at the voice's rate. A sentence
// longer than MAX_PHONEMES is made in pieces cut at spaces (Piper makes it whole: memory grows with its length).
//
// roamies-voice --speak <voice.onnx> [--speaker 1] [--threads 2]
// Loads the voice (its config is <voice.onnx>.json; espeak-ng's data, built into this helper, is unpacked next to it
// as espeak-ng-data the first time), says {"type":"ready","rate":22050,"ms":…}, then reads JSON lines:
//   {"id":"s1","text":"Hola. ¿Qué tal?"}  speaks it: {"type":"audio","id":"s1","rate":22050,"pcm":"<base64>"} per
//                                          chunk (sentence by sentence, as each is made), then {"type":"said","id":"s1"}
//                                          (texts are spoken in the order they come, each ends with its "said")
//   {"cmd":"cancel","id":"s1"}            drops what's still queued for s1 (its texts still end with "said")
// Exits when stdin closes. Errors: {"type":"error","message":…} (and exit 1 when the voice can't load).
use crate::emit;
use parakeet_rs::ort;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::BufRead;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;
use unicode_normalization::UnicodeNormalization;

/// At most this many samples per audio message (about a third of a second at 22 050 Hz).
pub const CHUNK: usize = 8192;

/// At most this many phoneme tokens (2n + 3 ids) go to the model at once. Its memory and time grow with the length:
/// measured on a 4-core i7-1185G7 with 2 threads, peak RSS 407 MB and 1.4 s at 583 ids, 696 MB and 4.1 s at 1167,
/// 1.4 GB at 2357, 2.8 GB and 18 s at 4709. In pieces of at most 1003 ids the peak stays at 0.55 to 0.8 GB however long
/// the sentence (400 words: 2.8 GB before; 930 characters with no space: 1.9 GB and 16 s to the first audio before,
/// 1.6 s now), and that's twice what the sidecar's longest sentences make (it cuts at 220 characters: about 490 ids
/// of Spanish), so those stay whole.
pub const MAX_PHONEMES: usize = 500;

/// What the voice's .onnx.json says, as Piper reads it (config.py PiperConfig.from_dict).
#[derive(Debug)]
pub struct Config {
    pub sample_rate: u32,
    pub num_speakers: i64,
    pub default_speaker: i64,
    pub noise_scale: f32,
    pub length_scale: f32,
    pub noise_w: f32,
    pub espeak_voice: String,
    pub ids: HashMap<String, Vec<i64>>,
    pub clusters: Vec<Vec<String>>,
}

impl Config {
    pub fn parse(v: &Value) -> Result<Config, String> {
        let f = |o: &Value, k: &str, d: f64| o.get(k).and_then(Value::as_f64).unwrap_or(d) as f32;
        let inf = v.get("inference").cloned().unwrap_or(json!({}));
        if v.get("phoneme_type").and_then(Value::as_str).unwrap_or("espeak") != "espeak" {
            return Err("only espeak voices are supported".into());
        }
        let ids = v["phoneme_id_map"].as_object().ok_or("no phoneme_id_map")?.iter()
            .map(|(k, ids)| (k.clone(), ids.as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default()))
            .collect();
        let clusters = v.get("vowel_clusters").and_then(Value::as_array).map(|a| {
            a.iter().filter_map(Value::as_array).map(|c| c.iter().filter_map(|p| p.as_str().map(str::to_owned)).collect()).collect()
        }).unwrap_or_default();
        Ok(Config {
            sample_rate: v["audio"]["sample_rate"].as_u64().ok_or("no sample_rate")? as u32,
            num_speakers: v["num_speakers"].as_i64().unwrap_or(1),
            default_speaker: v.get("default_speaker_id").and_then(Value::as_i64).unwrap_or(0),
            noise_scale: f(&inf, "noise_scale", 0.667),
            length_scale: f(&inf, "length_scale", 1.0),
            noise_w: f(&inf, "noise_w", 0.8),
            espeak_voice: v["espeak"]["voice"].as_str().ok_or("no espeak voice")?.to_owned(),
            ids,
            clusters,
        })
    }
}

/// `\([^)]+\)` removed: espeak-ng's (lang) switch flags around words from another language.
fn drop_flags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('(') {
        let after = &rest[i + 1..];
        match after.find(')') {
            Some(j) if j > 0 => {
                out.push_str(&rest[..i]);
                rest = &after[j + 1..];
            }
            _ => {
                out.push_str(&rest[..=i]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Adjacent phonemes that make one of the voice's clusters become one token, longest first (_merge_known_vowel_clusters).
pub fn merge_clusters(phones: Vec<String>, clusters: &[Vec<String>]) -> Vec<String> {
    let Some(max) = clusters.iter().map(Vec::len).max() else { return phones };
    let mut out = Vec::with_capacity(phones.len());
    let mut i = 0;
    while i < phones.len() {
        let hit = (2..=max.min(phones.len() - i)).rev().find(|&n| clusters.iter().any(|c| c.as_slice() == &phones[i..i + n]));
        match hit {
            Some(n) => {
                out.push(phones[i..i + n].concat());
                i += n;
            }
            None => {
                out.push(phones[i].clone());
                i += 1;
            }
        }
    }
    out
}

/// espeak-ng's clauses (phonemes, terminator, ends a sentence) as sentences of phoneme tokens (EspeakPhonemizer.phonemize).
pub fn sentences(clauses: &[(String, String, bool)], clusters: &[Vec<String>]) -> Vec<Vec<String>> {
    let mut all = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    for (phonemes, term, end) in clauses {
        let mut s = drop_flags(phonemes);
        s.push_str(term);
        if matches!(term.as_str(), "," | ":" | ";") {
            s.push(' ');
        }
        cur.extend(s.nfd().map(String::from));
        if *end {
            all.push(merge_clusters(std::mem::take(&mut cur), clusters));
        }
    }
    if !cur.is_empty() {
        all.push(merge_clusters(cur, clusters));
    }
    all
}

/// Text split on Piper's raw phoneme blocks `[[ … ]]`, the blocks kept (re.split of `(\[\[.*?\]\])`: the first `]]`
/// after `[[`, never across a newline).
fn split_blocks(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut p) = (0, 0);
    while let Some(k) = text[p..].find("[[") {
        let i = p + k;
        let body = &text[i + 2..];
        match body.find("]]") {
            Some(j) if !body[..j].contains('\n') => {
                parts.push(&text[start..i]);
                parts.push(&text[i..i + j + 4]);
                start = i + j + 4;
                p = start;
            }
            _ => p = i + 1,
        }
    }
    parts.push(&text[start..]);
    parts
}

/// Text to sentences of phoneme tokens, as PiperVoice.phonemize does for an espeak voice. `clauses` is espeak-ng.
pub fn phonemize(text: &str, clusters: &[Vec<String>], clauses: &mut dyn FnMut(&str) -> Vec<(String, String, bool)>) -> Vec<Vec<String>> {
    let parts = split_blocks(text);
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut prev_raw = false;
    for (i, part) in parts.iter().enumerate() {
        if part.starts_with("[[") {
            prev_raw = true;
            if out.is_empty() {
                out.push(Vec::new());
            }
            if i > 0 && parts[i - 1].ends_with(' ') {
                out.last_mut().unwrap().push(" ".into());
            }
            out.last_mut().unwrap().extend(part[2..part.len() - 2].trim().chars().map(String::from));
            if i + 1 < parts.len() && parts[i + 1].starts_with(' ') {
                out.last_mut().unwrap().push(" ".into());
            }
            continue;
        }
        let mut got = sentences(&clauses(part), clusters);
        if prev_raw && !got.is_empty() {
            let first = got.remove(0);
            out.last_mut().unwrap().extend(first);
        }
        out.extend(got);
        prev_raw = false;
    }
    if out.last().is_some_and(Vec::is_empty) {
        out.pop();
    }
    out
}

/// A sentence's tokens in pieces of at most `max`, each cut at the last space that fits (the spaces at a cut dropped),
/// or at `max` when there's none. A sentence that fits is one piece, as it was.
pub fn pieces(tokens: &[String], max: usize) -> Vec<&[String]> {
    let mut out = Vec::new();
    let mut rest = tokens;
    while rest.len() > max {
        let cut = rest[..=max].iter().rposition(|t| t == " ").filter(|&i| i > 0).unwrap_or(max);
        out.push(&rest[..cut]);
        rest = &rest[cut..];
        while rest.first().is_some_and(|t| t == " ") {
            rest = &rest[1..];
        }
    }
    if !rest.is_empty() || out.is_empty() {
        out.push(rest);
    }
    out
}

/// Phoneme tokens to the model's ids: ^ _ then each token's ids and _, then $ (phoneme_ids.phonemes_to_ids).
/// Tokens the voice doesn't know are left out, as Piper does (it logs a warning).
pub fn to_ids(phonemes: &[String], map: &HashMap<String, Vec<i64>>) -> Vec<i64> {
    let get = |k: &str| map.get(k).cloned().unwrap_or_default();
    let pad = get("_");
    let mut ids = get("^");
    ids.extend(&pad);
    for p in phonemes {
        if let Some(v) = map.get(p) {
            ids.extend(v);
            ids.extend(&pad);
        }
    }
    ids.extend(get("$"));
    ids
}

/// The model's float audio as 16-bit samples: scaled so the loudest is full range, clipped, then truncated toward
/// zero as numpy's astype(int16) does (AudioChunk.audio_int16_array with normalize_audio on).
pub fn to_pcm(audio: &[f32]) -> Vec<i16> {
    let peak = audio.iter().fold(0f32, |m, x| m.max(x.abs()));
    if peak < 1e-8 {
        return vec![0; audio.len()];
    }
    audio.iter().map(|x| ((x / peak).clamp(-1.0, 1.0) * 32767.0).clamp(-32767.0, 32767.0) as i16).collect()
}

/// Samples as base64 little-endian 16-bit PCM, at most CHUNK samples a piece.
pub fn chunks(pcm: &[i16]) -> Vec<String> {
    pcm.chunks(CHUNK).map(|c| base64(&c.iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<u8>>())).collect()
}

pub fn base64(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for (k, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            s.push(if k <= c.len() { A[(n >> shift & 63) as usize] as char } else { '=' });
        }
    }
    s
}

// ---------- espeak-ng (built by build.rs, linked statically) ----------

#[cfg(not(no_espeak))]
mod espeak {
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::path::Path;

    extern "C" {
        fn espeak_Initialize(output: c_int, buflength: c_int, path: *const c_char, options: c_int) -> c_int;
        fn espeak_SetVoiceByName(name: *const c_char) -> c_int;
        fn espeak_TextToPhonemesWithTerminator(textptr: *mut *const c_void, textmode: c_int, phonememode: c_int, terminator: *mut c_int) -> *const c_char;
    }
    const AUDIO_OUTPUT_SYNCHRONOUS: c_int = 2;
    const INITIALIZE_DONT_EXIT: c_int = 0x8000;
    const CHARS_AUTO: c_int = 0;
    const PHONEMES_IPA: c_int = 0x02;

    // The data compiled with this library (build.rs: phonemes, intonations, every dictionary, the Spanish voice file),
    // deflated: PACK, its FILES (name, size) and the SUM of the unpacked stream.
    mod data {
        include!(concat!(env!("OUT_DIR"), "/espeak_data.rs"));
    }
    const STAMP: &str = "roamies-data";

    /// Unpacks the data into `dir`, as espeak-ng reads files, unless it's already there: the stamp file (written last)
    /// holds this build's SUM and every file has its size. Returns whether it wrote anything.
    pub fn unpack(dir: &Path) -> Result<bool, String> {
        let there = std::fs::read_to_string(dir.join(STAMP)).is_ok_and(|s| s == data::SUM)
            && data::FILES.iter().all(|(name, len)| std::fs::metadata(dir.join(name)).is_ok_and(|m| m.len() == *len));
        if there {
            return Ok(false);
        }
        let io = |p: &Path, e: std::io::Error| format!("{}: {e}", p.display());
        let _ = std::fs::remove_file(dir.join(STAMP));
        let mut z = std::io::BufReader::new(flate2::read::ZlibDecoder::new(data::PACK));
        let mut take = |n: usize| -> Result<Vec<u8>, String> {
            let mut b = vec![0; n];
            std::io::Read::read_exact(&mut z, &mut b).map_err(|e| format!("espeak-ng data: {e}"))?;
            Ok(b)
        };
        for _ in data::FILES {
            let n = u32::from_le_bytes(take(4)?.try_into().unwrap()) as usize;
            let name = String::from_utf8(take(n)?).map_err(|e| e.to_string())?;
            let len = u64::from_le_bytes(take(8)?.try_into().unwrap()) as usize;
            let p = dir.join(&name);
            std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| io(dir, e))?;
            std::fs::write(&p, take(len)?).map_err(|e| io(&p, e))?;
        }
        std::fs::write(dir.join(STAMP), data::SUM).map_err(|e| io(dir, e))?;
        Ok(true)
    }

    /// Unpacks the data into `dir` (unless it's there) and starts espeak-ng on it. Once per process.
    pub fn init(dir: &Path) -> Result<(), String> {
        unpack(dir)?;
        let path = CString::new(dir.to_string_lossy().into_owned()).map_err(|e| e.to_string())?;
        // SAFETY: a NUL-terminated path; espeak-ng copies it. Called once, from the one thread that uses espeak-ng.
        let rate = unsafe { espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, path.as_ptr(), INITIALIZE_DONT_EXIT) };
        if rate < 0 {
            return Err(format!("espeak-ng couldn't start on {}", dir.display()));
        }
        Ok(())
    }

    pub fn set_voice(name: &str) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        // SAFETY: a NUL-terminated name, after init.
        match unsafe { espeak_SetVoiceByName(n.as_ptr()) } {
            0 => Ok(()),
            e => Err(format!("espeak-ng has no voice {name} ({e})")),
        }
    }

    /// The text's clauses: (IPA, terminator, ends a sentence), as piper's espeakbridge.c get_phonemes.
    pub fn clauses(text: &str) -> Vec<(String, String, bool)> {
        const PERIOD: c_int = 40 | 0x80000;
        const COMMA: c_int = 20 | 0x1000 | 0x40000;
        const QUESTION: c_int = 40 | 0x2000 | 0x80000;
        const EXCLAMATION: c_int = 45 | 0x3000 | 0x80000;
        const COLON: c_int = 30 | 0x40000;
        const SEMICOLON: c_int = 30 | 0x1000 | 0x40000;
        let text = CString::new(text.replace('\0', "")).unwrap();
        let mut ptr = text.as_ptr() as *const c_void;
        let mut out = Vec::new();
        while !ptr.is_null() {
            let mut term: c_int = 0;
            // SAFETY: ptr walks the NUL-terminated `text`, which outlives the loop; espeak-ng sets it to NULL at the end.
            // The returned string is espeak-ng's own buffer, copied before the next call.
            let ph = unsafe {
                let p = espeak_TextToPhonemesWithTerminator(&mut ptr, CHARS_AUTO, PHONEMES_IPA, &mut term);
                if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
            };
            let term = term & 0x000F_FFFF;
            let t = match term {
                PERIOD => ".",
                QUESTION => "?",
                EXCLAMATION => "!",
                COMMA => ",",
                COLON => ":",
                SEMICOLON => ";",
                _ => "",
            };
            out.push((ph, t.to_owned(), term & 0x80000 == 0x80000));
        }
        out
    }
}

#[cfg(no_espeak)]
mod espeak {
    use std::path::Path;
    pub fn init(_: &Path) -> Result<(), String> {
        Err("this helper was built without the local voice (cross-compiled)".into())
    }
    pub fn set_voice(_: &str) -> Result<(), String> {
        Ok(())
    }
    pub fn clauses(_: &str) -> Vec<(String, String, bool)> {
        Vec::new()
    }
}

// ---------- the voice ----------

pub struct Voice {
    session: ort::session::Session,
    pub cfg: Config,
    speaker: Option<i64>,
}

impl Voice {
    /// Loads the model and its config, and starts espeak-ng (once per process).
    pub fn load(model: &Path, speaker: Option<i64>, threads: usize) -> Result<Voice, String> {
        let json_path = format!("{}.json", model.display());
        let text = std::fs::read_to_string(&json_path).map_err(|e| format!("{json_path}: {e}"))?;
        let cfg = Config::parse(&serde_json::from_str(&text).map_err(|e| format!("{json_path}: {e}"))?)?;
        espeak::init(&model.parent().unwrap_or(Path::new(".")).join("espeak-ng-data"))?;
        espeak::set_voice(&cfg.espeak_voice)?;
        let err = |e: ort::Error<ort::session::builder::SessionBuilder>| e.to_string();
        let env = ort::init().with_name("roamies-speak").build().map_err(|e| e.to_string())?;
        let session = ort::session::Session::builder(&env).map_err(|e| e.to_string())?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::All).map_err(err)?
            .with_intra_threads(threads).map_err(err)?
            .with_inter_threads(1).map_err(err)?
            .commit_from_file(model).map_err(|e| e.to_string())?;
        // One speaker for a one-speaker voice; else the one asked for, or the voice's default.
        let speaker = (cfg.num_speakers > 1).then(|| speaker.filter(|s| (0..cfg.num_speakers).contains(s)).unwrap_or(cfg.default_speaker));
        Ok(Voice { session, cfg, speaker })
    }

    pub fn phonemize(&self, text: &str) -> Vec<Vec<String>> {
        phonemize(text, &self.cfg.clusters, &mut |t| espeak::clauses(t))
    }

    /// One sentence's ids to audio (floats, as the model makes them).
    pub fn audio(&mut self, ids: Vec<i64>) -> Result<Vec<f32>, String> {
        use ort::value::Tensor;
        let e = |e: ort::Error| e.to_string();
        let n = ids.len();
        let mut inputs = ort::inputs![
            "input" => Tensor::from_array(([1usize, n], ids)).map_err(e)?,
            "input_lengths" => Tensor::from_array(([1usize], vec![n as i64])).map_err(e)?,
            "scales" => Tensor::from_array(([3usize], vec![self.cfg.noise_scale, self.cfg.length_scale, self.cfg.noise_w])).map_err(e)?,
        ];
        if let Some(sid) = self.speaker {
            inputs.push(("sid".into(), Tensor::from_array(([1usize], vec![sid])).map_err(e)?.into()));
        }
        let out = self.session.run(inputs).map_err(e)?;
        let (_, audio) = out[0].try_extract_tensor::<f32>().map_err(e)?;
        Ok(audio.to_vec())
    }
}

/// The --speak loop (see the top of this file). Returns the exit code.
pub fn run(model: &Path, speaker: Option<i64>, threads: usize) -> i32 {
    let t0 = Instant::now();
    let mut voice = match Voice::load(model, speaker, threads) {
        Ok(v) => v,
        Err(e) => {
            emit(json!({ "type": "error", "message": e }));
            return 1;
        }
    };
    // One short run, so the first real sentence doesn't pay for ONNX Runtime's setup.
    for s in voice.phonemize("Hola.") {
        let ids = to_ids(&s, &voice.cfg.ids);
        let _ = voice.audio(ids);
    }
    let rate = voice.cfg.sample_rate;
    crate::log(&format!("local voice ready in {:.1}s ({threads} threads)", t0.elapsed().as_secs_f64()));
    emit(json!({ "type": "ready", "rate": rate, "ms": t0.elapsed().as_millis() as u64 }));

    // Ids of replies that were stopped (the last few): what's queued for them is skipped.
    let cancelled: Arc<Mutex<VecDeque<String>>> = Arc::default();
    let (tx, rx) = mpsc::channel::<(String, String)>();
    let c2 = cancelled.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let id = v["id"].as_str().unwrap_or_default().to_owned();
            if v["cmd"] == "cancel" {
                let mut c = c2.lock().unwrap();
                c.push_back(id);
                if c.len() > 64 {
                    c.pop_front();
                }
            } else if let Some(t) = v["text"].as_str() {
                let _ = tx.send((id, t.to_owned()));
            }
        }
    });
    let stopped = |id: &str| cancelled.lock().unwrap().iter().any(|c| c == id);
    for (id, text) in rx {
        for s in voice.phonemize(&text) {
            if stopped(&id) {
                break;
            }
            if s.is_empty() {
                continue;
            }
            for piece in pieces(&s, MAX_PHONEMES) {
                if stopped(&id) {
                    break;
                }
                match voice.audio(to_ids(piece, &voice.cfg.ids)) {
                    Ok(a) => {
                        for pcm in chunks(&to_pcm(&a)) {
                            emit(json!({ "type": "audio", "id": id, "rate": rate, "pcm": pcm }));
                        }
                    }
                    Err(e) => emit(json!({ "type": "error", "id": id, "message": e })),
                }
            }
        }
        // Every text ends with "said", a cancelled one too: the sidecar knows from it which text is being spoken.
        emit(json!({ "type": "said", "id": id }));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice_config() -> Config {
        Config::parse(&serde_json::from_str(include_str!("../fixtures/es_ES-sharvard-medium.onnx.json")).unwrap()).unwrap()
    }

    // espeak-ng is one state for the process: the tests that use it take turns, on its data unpacked once (OUT_DIR).
    #[cfg(not(no_espeak))]
    fn espeak_ready() -> std::sync::MutexGuard<'static, ()> {
        static TURN: Mutex<()> = Mutex::new(());
        static INIT: std::sync::Once = std::sync::Once::new();
        let turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        INIT.call_once(|| {
            espeak::init(&Path::new(env!("OUT_DIR")).join("speak-test")).unwrap();
            espeak::set_voice(&voice_config().espeak_voice).unwrap();
        });
        turn
    }

    #[cfg(not(no_espeak))]
    fn matches_piper(fixture: &str) {
        let cfg = voice_config();
        let _turn = espeak_ready();
        let want: Value = serde_json::from_str(fixture).unwrap();
        for line in want.as_array().unwrap() {
            let text = line["text"].as_str().unwrap();
            let got = phonemize(text, &cfg.clusters, &mut |t| espeak::clauses(t));
            let want_ph: Vec<Vec<String>> = line["sentences"].as_array().unwrap().iter().map(|s| serde_json::from_value(s["phonemes"].clone()).unwrap()).collect();
            let want_ids: Vec<Vec<i64>> = line["sentences"].as_array().unwrap().iter().map(|s| serde_json::from_value(s["ids"].clone()).unwrap()).collect();
            assert_eq!(got, want_ph, "phonemes of {text:?}");
            assert_eq!(got.iter().map(|s| to_ids(s, &cfg.ids)).collect::<Vec<_>>(), want_ids, "ids of {text:?}");
        }
    }

    // The ids upstream Piper 1.8 gave for the five test lines (fixtures/piper18-ids.json, made once with its Python
    // package); espeak-ng from build.rs must give the same, token for token.
    #[cfg(not(no_espeak))]
    #[test]
    fn text_to_ids_matches_piper_1_8() {
        matches_piper(include_str!("../fixtures/piper18-ids.json"));
    }

    // Letters outside the Spanish alphabet make espeak-ng switch to another language (English for “ ² →, Greek for π,
    // Korean, Hebrew…): the same ids as Piper 1.8, which ships every dictionary (fixtures/piper18-ids-switch.json).
    #[cfg(not(no_espeak))]
    #[test]
    fn text_in_other_alphabets_matches_piper_1_8() {
        matches_piper(include_str!("../fixtures/piper18-ids-switch.json"));
    }

    // espeak-ng crashed on a language switch whose dictionary wasn't there. Every character there is, one by one and
    // run together, and the lines that crashed it, go through without a crash; each of those lines makes ids.
    #[cfg(not(no_espeak))]
    #[test]
    fn no_text_crashes_espeak() {
        let cfg = voice_config();
        let _turn = espeak_ready();
        let lines: Vec<String> = serde_json::from_str::<Value>(include_str!("../fixtures/piper18-ids-switch.json")).unwrap()
            .as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().to_owned()).collect();
        for text in &lines {
            let ids: usize = phonemize(text, &cfg.clusters, &mut |t| espeak::clauses(t)).iter().map(|s| to_ids(s, &cfg.ids).len()).sum();
            assert!(ids > 10, "no ids for {text:?}");
        }
        let all: Vec<char> = (1..=0x10FFFFu32).filter_map(char::from_u32).collect();
        for block in all.chunks(64) {
            let apart: String = block.iter().flat_map(|c| [*c, ' ']).collect();
            let together: String = block.iter().collect();
            for text in [format!("Hola {apart}."), format!("Hola {together} adiós.")] {
                for s in phonemize(&text, &cfg.clusters, &mut |t| espeak::clauses(t)) {
                    to_ids(&s, &cfg.ids);
                }
            }
        }
    }

    // The data is unpacked once: again only when a file is missing or another size, or the stamp is another build's.
    #[cfg(not(no_espeak))]
    #[test]
    fn espeak_data_is_unpacked_once_and_mended() {
        let dir = Path::new(env!("OUT_DIR")).join("unpack-test");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(espeak::unpack(&dir).unwrap());
        assert!(!espeak::unpack(&dir).unwrap(), "already there");
        let ru = std::fs::metadata(dir.join("ru_dict")).unwrap().len();
        std::fs::remove_file(dir.join("ru_dict")).unwrap();
        std::fs::write(dir.join("es_dict"), b"x").unwrap();
        assert!(espeak::unpack(&dir).unwrap(), "a file missing, one cut short");
        assert_eq!(std::fs::metadata(dir.join("ru_dict")).unwrap().len(), ru);
        std::fs::write(dir.join("roamies-data"), "another build").unwrap();
        assert!(espeak::unpack(&dir).unwrap());
        assert!(dir.join("en_dict").is_file() && dir.join("lang/roa/es").is_file() && !dir.join("lang/roa/it").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn long_sentences_are_made_in_pieces_cut_at_spaces() {
        let s = |x: &str| x.chars().map(String::from).collect::<Vec<_>>();
        let short = s("ola, ke tal.");
        assert_eq!(pieces(&short, 12), vec![&short[..]], "one that fits stays whole");
        assert_eq!(pieces(&[], 5), vec![&[] as &[String]]);
        let long = s("uno dos tres, kwatro.");
        assert_eq!(pieces(&long, 9), vec![&s("uno dos")[..], &s("tres,")[..], &s("kwatro.")[..]]);
        assert_eq!(pieces(&long, 13), vec![&s("uno dos tres,")[..], &s("kwatro.")[..]], "the space after the cut is dropped");
        let word = s("abcdefghij");
        assert_eq!(pieces(&word, 4), vec![&s("abcd")[..], &s("efgh")[..], &s("ij")[..]], "no space: a hard cut");
        // Whatever the size, every piece fits, none starts with a space, and nothing but the spaces at the cuts is lost.
        let unspaced = |t: &[String]| t.iter().filter(|x| *x != " ").cloned().collect::<Vec<_>>();
        for max in 1..25 {
            let p = pieces(&long, max);
            assert!(p.iter().all(|x| !x.is_empty() && x.len() <= max && x[0] != " "), "{max}");
            assert_eq!(unspaced(&p.concat()), unspaced(&long), "{max}");
        }
    }

    #[test]
    fn config_reads_the_voice() {
        let c = voice_config();
        assert_eq!((c.sample_rate, c.num_speakers, c.default_speaker, c.espeak_voice.as_str()), (22050, 2, 0, "es"));
        assert_eq!((c.noise_scale, c.length_scale, c.noise_w), (0.5, 1.0, 0.333));
        assert_eq!(c.ids["eɪ"], vec![164]);
        assert!(c.clusters.contains(&vec!["e".to_string(), "ɪ".to_string()]));
    }

    #[test]
    fn clauses_become_sentences_as_piper_makes_them() {
        let cl = |p: &str, t: &str, e: bool| (p.to_string(), t.to_string(), e);
        let s = |x: &str| x.chars().map(String::from).collect::<Vec<_>>();
        let clusters = vec![s("eɪ")];
        // Flags dropped, punctuation kept (a space after , : ;), NFD splits accents, a cluster merges, a sentence ends.
        let got = sentences(&[cl("(en)hˈaɪ(es) bé beɪ", ",", false), cl("ola", ".", true), cl("si", "", false)], &clusters);
        let mut first = s("hˈaɪ be\u{301} b");
        first.push("eɪ".into());
        first.extend(s(", ola."));
        assert_eq!(got, vec![first, s("si")]);
        // "()" isn't a flag; one with no closing bracket stays.
        assert_eq!(drop_flags("a()b(c"), "a()b(c");
        assert_eq!(drop_flags("(x)a(yz)b"), "ab");
    }

    #[test]
    fn raw_phoneme_blocks_are_split_out() {
        assert_eq!(split_blocks("a [[xy]] b"), vec!["a ", "[[xy]]", " b"]);
        assert_eq!(split_blocks("[[a\n]] [[b]]"), vec!["[[a\n]] ", "[[b]]", ""]);
        assert_eq!(split_blocks("no blocks"), vec!["no blocks"]);
        // A block's characters go in as they are, with the spaces around it, joined to the next text's first sentence.
        let got = phonemize("a [[xy]] b", &[], &mut |t| vec![(t.trim().to_string(), ".".into(), true)]);
        assert_eq!(got, vec![vec!["a", ".", " ", "x", "y", " ", "b", "."]]);
    }

    #[test]
    fn ids_are_padded_and_unknown_tokens_dropped() {
        let map: HashMap<String, Vec<i64>> = [("^", 1), ("_", 0), ("$", 2), ("a", 14), ("eɪ", 164)].iter().map(|(k, v)| (k.to_string(), vec![*v])).collect();
        assert_eq!(to_ids(&["a".into(), "?unknown".into(), "eɪ".into()], &map), vec![1, 0, 14, 0, 164, 0, 2]);
    }

    #[test]
    fn audio_is_scaled_to_full_range_and_truncated() {
        assert_eq!(to_pcm(&[0.5, -0.25, 0.1]), vec![32767, -16383, 6553]);
        assert_eq!(to_pcm(&[0.0, 1e-9]), vec![0, 0]);
        assert_eq!(to_pcm(&[]), Vec::<i16>::new());
    }

    #[test]
    fn pcm_goes_out_in_whole_little_endian_chunks() {
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(chunks(&[1, -2]), vec![base64(&[1, 0, 254, 255])]);
        let long: Vec<i16> = (0..(CHUNK * 2 + 5) as i32).map(|i| i as i16).collect();
        let c = chunks(&long);
        assert_eq!(c.len(), 3);
        assert_eq!(c[2], base64(&long[CHUNK * 2..].iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<u8>>()));
        assert!(chunks(&[]).is_empty());
    }
}
