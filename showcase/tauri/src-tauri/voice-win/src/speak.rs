// The local voice: a Piper voice (VITS, ONNX) spoken on this PC, the way upstream Piper 1.8 (OHF-Voice/piper1-gpl,
// GPL-3.0) speaks it: espeak-ng turns the text into IPA clause by clause (espeak_TextToPhonemesWithTerminator), each
// clause gets its punctuation back, the phonemes are split into Unicode code points (NFD) with the voice's vowel
// clusters ("eɪ") merged into one token, and the tokens become ids (^ _ id _ id _ … $) for the model, one run per
// sentence. Each sentence's audio is scaled to full range and sent as 16-bit PCM at the voice's rate.
//
// roamies-voice --speak <voice.onnx> [--speaker 1] [--threads 2]
// Loads the voice (its config is <voice.onnx>.json; espeak-ng's Spanish data, built into this helper, is written next
// to it as espeak-ng-data), says {"type":"ready","rate":22050,"ms":…}, then reads JSON lines:
//   {"id":"s1","text":"Hola. ¿Qué tal?"}  speaks it: {"type":"audio","id":"s1","rate":22050,"pcm":"<base64>"} per
//                                          chunk (sentence by sentence, as each is made), then {"type":"said","id":"s1"}
//   {"cmd":"cancel","id":"s1"}            drops what's still queued for s1
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

    // The data compiled with this library (build.rs): written next to the voice, as espeak-ng reads files.
    const FILES: &[(&str, &[u8])] = &[
        ("phondata", include_bytes!(concat!(env!("ROAMIES_ESPEAK_DATA"), "/phondata"))),
        ("phonindex", include_bytes!(concat!(env!("ROAMIES_ESPEAK_DATA"), "/phonindex"))),
        ("phontab", include_bytes!(concat!(env!("ROAMIES_ESPEAK_DATA"), "/phontab"))),
        ("intonations", include_bytes!(concat!(env!("ROAMIES_ESPEAK_DATA"), "/intonations"))),
        ("es_dict", include_bytes!(concat!(env!("ROAMIES_ESPEAK_DATA"), "/es_dict"))),
        ("lang/roa/es", include_bytes!(concat!(env!("ROAMIES_ESPEAK_DATA"), "/lang/roa/es"))),
    ];

    /// Writes the data (only what differs) into `dir` and starts espeak-ng on it. Once per process.
    pub fn init(dir: &Path) -> Result<(), String> {
        for (name, bytes) in FILES {
            let p = dir.join(name);
            if std::fs::read(&p).ok().as_deref() != Some(*bytes) {
                std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| format!("{}: {e}", dir.display()))?;
                std::fs::write(&p, bytes).map_err(|e| format!("{}: {e}", p.display()))?;
            }
        }
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
            let ids = to_ids(&s, &voice.cfg.ids);
            match voice.audio(ids) {
                Ok(a) => {
                    for pcm in chunks(&to_pcm(&a)) {
                        emit(json!({ "type": "audio", "id": id, "rate": rate, "pcm": pcm }));
                    }
                }
                Err(e) => emit(json!({ "type": "error", "id": id, "message": e })),
            }
        }
        if !stopped(&id) {
            emit(json!({ "type": "said", "id": id }));
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice_config() -> Config {
        Config::parse(&serde_json::from_str(include_str!("../fixtures/es_ES-sharvard-medium.onnx.json")).unwrap()).unwrap()
    }

    // The ids upstream Piper 1.8 gave for the five test lines (fixtures/piper18-ids.json, made once with its Python
    // package); espeak-ng from build.rs must give the same, token for token.
    #[cfg(not(no_espeak))]
    #[test]
    fn text_to_ids_matches_piper_1_8() {
        let cfg = voice_config();
        let dir = std::env::temp_dir().join(format!("roamies-speak-test-{}", std::process::id()));
        espeak::init(&dir).unwrap();
        espeak::set_voice(&cfg.espeak_voice).unwrap();
        let want: Value = serde_json::from_str(include_str!("../fixtures/piper18-ids.json")).unwrap();
        for line in want.as_array().unwrap() {
            let text = line["text"].as_str().unwrap();
            let got = phonemize(text, &cfg.clusters, &mut |t| espeak::clauses(t));
            let want_ph: Vec<Vec<String>> = line["sentences"].as_array().unwrap().iter().map(|s| serde_json::from_value(s["phonemes"].clone()).unwrap()).collect();
            let want_ids: Vec<Vec<i64>> = line["sentences"].as_array().unwrap().iter().map(|s| serde_json::from_value(s["ids"].clone()).unwrap()).collect();
            assert_eq!(got, want_ph, "phonemes of {text:?}");
            assert_eq!(got.iter().map(|s| to_ids(s, &cfg.ids)).collect::<Vec<_>>(), want_ids, "ids of {text:?}");
        }
        let _ = std::fs::remove_dir_all(dir);
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
