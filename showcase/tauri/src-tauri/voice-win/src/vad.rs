// Voice activity: Silero VAD v6 (snakers4/silero-vad v6.2.3, MIT; silero-vad.onnx next to the speech model), on the
// ONNX Runtime Parakeet already links. It says, for every 32 ms of 16 kHz sound, how likely that is a voice, which
// tells speech from room noise, a fan or a tone far better than a volume threshold, and costs well under a
// millisecond a window. The model runs as the official OnnxWrapper does (utils_vad.py): 512 new samples after the
// last 64 of the window before (its context), and a recurrent state carried from window to window. Gate turns those
// probabilities into speech and its edges as VADIterator does (start at THRESHOLD, a dip below it by 0.15 for
// MIN_SILENCE ends it), and like get_speech_timestamps a run shorter than MIN_SPEECH (a knock, a click) is no speech.
use parakeet_rs::ort;
use std::path::Path;

pub const WINDOW: usize = 512;
const CONTEXT: usize = 64;
const STATE: usize = 2 * 128;
// Silero's own threshold (VADIterator: 0.5, and 0.15 under it to end). A voice lasts 160 ms at least: shorter than
// get_speech_timestamps' 250 ms, so a quick "sí" still counts; a knock or a click is shorter still.
const THRESHOLD: f32 = 0.5;
const NEG_THRESHOLD: f32 = THRESHOLD - 0.15;
const MIN_SPEECH: usize = 2560;
// Longer than VADIterator's 100 ms, so the short gap between two words of the wake phrase doesn't cut it in two.
const MIN_SILENCE: usize = 4800;
// Speech edges are padded this much each side (VADIterator's speech_pad_ms).
const PAD: u64 = 480;
// A window quieter than -60 dBFS (RMS) is no voice, and isn't given to the model: a quiet room then costs next to
// nothing (the model's ~0.6 ms a window is most of what listening costs). The model starts afresh after it, as on a
// new stream. Room noise and the quietest speech are well above it.
const FLOOR: f32 = 0.001;

/// A speech probability for each window of WINDOW samples (16 kHz), in order.
pub trait Detector: Send {
    fn prob(&mut self, window: &[f32]) -> f32;
    /// A new stream: what came before says nothing about what comes next.
    fn reset(&mut self);
}

pub struct Silero {
    session: ort::session::Session,
    state: Vec<f32>,
    input: Vec<f32>,
}

impl Silero {
    pub fn load(path: &Path) -> Result<Silero, String> {
        if !path.is_file() {
            return Err(format!("{} not found", path.display()));
        }
        let err = |e: ort::Error<ort::session::builder::SessionBuilder>| e.to_string();
        let env = crate::ort_env()?;
        // One thread, as the official wrapper: a window is far too small to share out.
        let session = ort::session::Session::builder(&env).map_err(|e| e.to_string())?
            .with_intra_threads(1).map_err(err)?
            .with_inter_threads(1).map_err(err)?
            .commit_from_file(path).map_err(|e| e.to_string())?;
        let mut s = Silero { session, state: vec![0.0; STATE], input: vec![0.0; CONTEXT + WINDOW] };
        // A file that loads but isn't this model fails here, not mid-take.
        s.run(&[0.0; WINDOW])?;
        s.reset();
        Ok(s)
    }

    fn run(&mut self, window: &[f32]) -> Result<f32, String> {
        use ort::value::Tensor;
        let e = |e: ort::Error| e.to_string();
        self.input.copy_within(WINDOW.., 0);
        self.input[CONTEXT..].copy_from_slice(window);
        let out = self.session.run(ort::inputs![
            "input" => Tensor::from_array(([1usize, CONTEXT + WINDOW], self.input.clone())).map_err(e)?,
            "state" => Tensor::from_array(([2usize, 1, 128], std::mem::take(&mut self.state))).map_err(e)?,
            "sr" => Tensor::from_array(((), vec![crate::RATE as i64])).map_err(e)?,
        ]);
        let out = match out {
            Ok(o) => o,
            Err(x) => {
                self.state = vec![0.0; STATE];
                return Err(x.to_string());
            }
        };
        let (_, p) = out["output"].try_extract_tensor::<f32>().map_err(e)?;
        let p = p.first().copied().unwrap_or(0.0);
        let (_, st) = out["stateN"].try_extract_tensor::<f32>().map_err(e)?;
        self.state = if st.len() == STATE { st.to_vec() } else { vec![0.0; STATE] };
        Ok(p)
    }
}

impl Detector for Silero {
    fn prob(&mut self, window: &[f32]) -> f32 {
        // A failed run is no voice (and logged): the gate stays shut rather than open on garbage.
        self.run(window).unwrap_or_else(|e| {
            crate::log(&format!("vad: {e}"));
            0.0
        })
    }

    fn reset(&mut self) {
        self.state.fill(0.0);
        self.input.fill(0.0);
    }
}

/// Where speech started or ended, in samples since the stream (re)started.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Edge {
    Start(u64),
    End(u64),
}

/// One window's verdict: where it ends in the stream, whether it is voice, and an edge it made.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Step {
    pub at: u64,
    pub voice: bool,
    pub edge: Option<Edge>,
}

/// Hysteresis over the probabilities (see the top of the file).
#[derive(Default)]
struct Gate {
    triggered: bool,
    // The run reached MIN_SPEECH and its Start went out.
    confirmed: bool,
    start: u64,
    // When the voice dipped (0: it hasn't).
    temp_end: u64,
}

impl Gate {
    // at: where this window ends.
    fn push(&mut self, p: f32, at: u64) -> Step {
        let w = WINDOW as u64;
        let mut edge = None;
        if p >= THRESHOLD {
            self.temp_end = 0;
            if !self.triggered {
                (self.triggered, self.confirmed, self.start) = (true, false, (at - w).saturating_sub(PAD));
            }
        } else if p < NEG_THRESHOLD && self.triggered {
            if self.temp_end == 0 {
                self.temp_end = at;
            }
            if at - self.temp_end >= MIN_SILENCE as u64 {
                if self.confirmed {
                    edge = Some(Edge::End(self.temp_end - w + PAD));
                }
                (self.triggered, self.confirmed, self.temp_end) = (false, false, 0);
            }
        }
        // Confirmed only while it still sounds: a click followed by quiet never gets there.
        if self.triggered && !self.confirmed && self.temp_end == 0 && at - self.start >= MIN_SPEECH as u64 + PAD {
            self.confirmed = true;
            edge = Some(Edge::Start(self.start));
        }
        Step { at, voice: self.confirmed && self.temp_end == 0 && p >= NEG_THRESHOLD, edge }
    }
}

/// A detector fed with sound in pieces of any size: whole windows go through it, the rest waits for more.
pub struct Vad {
    det: Box<dyn Detector>,
    // The model has heard nothing since its last reset (quiet windows skip it).
    fresh: bool,
    gate: Gate,
    pending: Vec<f32>,
    pos: u64,
}

impl Vad {
    pub fn new(det: Box<dyn Detector>) -> Vad {
        Vad { det, fresh: true, gate: Gate::default(), pending: Vec::new(), pos: 0 }
    }

    pub fn feed(&mut self, samples: &[f32], out: &mut Vec<Step>) {
        self.pending.extend_from_slice(samples);
        let whole = self.pending.len() / WINDOW * WINDOW;
        for w in self.pending[..whole].chunks(WINDOW) {
            self.pos += WINDOW as u64;
            let quiet = w.iter().map(|s| s * s).sum::<f32>() < FLOOR * FLOOR * WINDOW as f32;
            if quiet && !self.fresh {
                self.det.reset();
            }
            self.fresh = quiet;
            let p = if quiet { 0.0 } else { self.det.prob(w) };
            out.push(self.gate.push(p, self.pos));
        }
        self.pending.drain(..whole);
    }

    /// Forget any voice under way, keeping the place in the stream (Roamies' own voice was playing).
    pub fn forget(&mut self) {
        self.gate = Gate::default();
        self.det.reset();
        self.fresh = true;
    }

    /// A new stream: the microphone (re)opened.
    pub fn restart(&mut self) {
        self.forget();
        self.pending.clear();
        self.pos = 0;
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Stands in for the model: any window louder than 0.05 is voice.
    pub struct Loud;
    impl Detector for Loud {
        fn prob(&mut self, w: &[f32]) -> f32 {
            if w.iter().any(|s| s.abs() > 0.05) { 0.9 } else { 0.01 }
        }
        fn reset(&mut self) {}
    }

    /// Counts the windows it is given.
    struct Counting(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl Detector for Counting {
        fn prob(&mut self, _: &[f32]) -> f32 {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            0.0
        }
        fn reset(&mut self) {}
    }

    #[test]
    fn a_quiet_room_is_not_given_to_the_model() {
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut v = Vad::new(Box::new(Counting(n.clone())));
        let mut out = Vec::new();
        // -70 dBFS of hiss, then -45 dBFS of room noise: only the second goes to the model.
        let hiss: Vec<f32> = (0..WINDOW * 10).map(|i| if i % 2 == 0 { 0.0003 } else { -0.0003 }).collect();
        let room: Vec<f32> = (0..WINDOW * 10).map(|i| if i % 2 == 0 { 0.0056 } else { -0.0056 }).collect();
        v.feed(&hiss, &mut out);
        assert_eq!(n.load(std::sync::atomic::Ordering::Relaxed), 0);
        v.feed(&room, &mut out);
        assert_eq!(n.load(std::sync::atomic::Ordering::Relaxed), 10);
        assert_eq!(out.len(), 20);
        assert!(out.iter().all(|s| !s.voice && s.edge.is_none()));
    }

    fn steps(v: &mut Vad, audio: &[f32], piece: usize) -> Vec<Step> {
        let mut out = Vec::new();
        for c in audio.chunks(piece) {
            v.feed(c, &mut out);
        }
        out
    }

    fn edges(s: &[Step]) -> Vec<Edge> {
        s.iter().filter_map(|s| s.edge).collect()
    }

    #[test]
    fn speech_has_edges_and_clicks_and_short_gaps_do_not() {
        let r = crate::RATE as usize;
        let tone = |n: usize| vec![0.3f32; n];
        let quiet = |n: usize| vec![0.0f32; n];
        // 0.5 s quiet, 1 s voice, a 0.2 s gap (between two words), 0.5 s voice, 1 s quiet.
        let audio = [quiet(r / 2), tone(r), quiet(r / 5), tone(r / 2), quiet(r)].concat();
        let mut v = Vad::new(Box::new(Loud));
        let s = steps(&mut v, &audio, 441);
        let e = edges(&s);
        assert_eq!(e.len(), 2, "{e:?}: one stretch of speech, the gap inside it");
        let Edge::Start(a) = e[0] else { panic!("{e:?}") };
        let Edge::End(b) = e[1] else { panic!("{e:?}") };
        assert!((a as i64 - (r / 2) as i64).abs() <= (WINDOW + PAD as usize) as i64, "starts near 0.5 s: {a}");
        assert!((b as i64 - (r * 22 / 10) as i64).abs() <= (WINDOW + PAD as usize) as i64, "ends near 2.2 s: {b}");
        assert!(s.iter().filter(|s| s.voice).count() > 40, "voice windows while it lasts");
        assert!(!v.gate.confirmed);
        // The same sound in other pieces: the same verdicts.
        let mut w = Vad::new(Box::new(Loud));
        assert_eq!(steps(&mut w, &audio, 4096), s);
        // A click (a tenth of a second): no speech at all.
        let mut c = Vad::new(Box::new(Loud));
        let s = steps(&mut c, &[quiet(r / 2), tone(r / 10), quiet(r)].concat(), 320);
        assert!(edges(&s).is_empty() && !s.iter().any(|s| s.voice), "{:?}", edges(&s));
        // forget(): a voice under way is dropped, the place in the stream kept.
        let mut f = Vad::new(Box::new(Loud));
        steps(&mut f, &tone(r), 512);
        assert!(f.gate.confirmed);
        f.forget();
        assert!(!f.gate.confirmed && f.pos + f.pending.len() as u64 == r as u64);
        f.restart();
        assert_eq!(f.pos, 0);
    }

    // Generated once with the official ONNX wrapper's logic in Python (onnxruntime 1.31.1) on the same WAV; the
    // model is the one the sidecar downloads (its SHA-256 is in the fixture). Needs the model:
    // ROAMIES_TEST_VAD=<silero-vad.onnx> cargo test vad
    fn model() -> Option<Silero> {
        let Some(path) = std::env::var_os("ROAMIES_TEST_VAD") else {
            eprintln!("skipped: set ROAMIES_TEST_VAD=<silero-vad.onnx>");
            return None;
        };
        Some(Silero::load(Path::new(&path)).expect("the model loads"))
    }

    #[test]
    fn probabilities_match_the_reference() {
        let Some(mut m) = model() else { return };
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let want: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("silero-vad-hola.json")).unwrap()).unwrap();
        let want: Vec<f64> = want["probs"].as_array().unwrap().iter().map(|p| p.as_f64().unwrap()).collect();
        let (audio, _) = crate::audio::read_wav(&dir.join("silero-vad-hola.wav")).unwrap();
        let got: Vec<f32> = audio.chunks_exact(WINDOW).map(|w| m.prob(w)).collect();
        assert_eq!(got.len(), want.len());
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert!((*g as f64 - w).abs() < 1e-3, "window {i}: {g} vs {w}");
        }
        // reset(): the same sound again gives the same numbers.
        m.reset();
        assert!((m.prob(&audio[..WINDOW]) as f64 - want[0]).abs() < 1e-3);
    }

    #[test]
    fn the_model_hears_speech_and_not_noise_or_tones() {
        let Some(m) = model() else { return };
        let r = crate::RATE as usize;
        let mut v = Vad::new(Box::new(m));
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let (speech, _) = crate::audio::read_wav(&dir.join("silero-vad-hola.wav")).unwrap();
        let s = steps(&mut v, &[speech.clone(), vec![0.0; r]].concat(), 320);
        assert!(matches!(edges(&s)[..], [Edge::Start(_), Edge::End(_)]), "{:?}", edges(&s));
        // Loud noise, a steady hum and a whistle, each 3 s: never speech (a volume gate opens on all of them).
        let mut seed = 1u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        };
        let sounds: [Vec<f32>; 3] = [
            (0..3 * r).map(|_| noise() * 0.2).collect(),
            (0..3 * r).map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 120.0 / r as f32).sin() * 0.2).collect(),
            (0..3 * r).map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 2000.0 / r as f32).sin() * 0.2).collect(),
        ];
        for (k, snd) in sounds.iter().enumerate() {
            v.restart();
            let s = steps(&mut v, snd, 320);
            assert!(edges(&s).is_empty(), "sound {k}: {:?}", edges(&s));
        }
    }
}
