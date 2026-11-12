// End of turn from the voice: Pipecat Smart Turn v3.2 (github.com/pipecat-ai/smart-turn, BSD-2-Clause; the model is
// huggingface.co/pipecat-ai/smart-turn-v3 smart-turn-v3.2-cpu.onnx, int8, downloaded by sidecar/voicemodel.mjs as
// smart-turn.onnx). A Whisper Tiny encoder with a small classifier: it hears whether the intonation and the words
// sound finished, in 23 languages (Spanish included), from up to the last 8 s of a turn.
//
// This is the reference inference (inference.py) step for step, since the model only knows features made exactly
// that way: the last 8 s with silence put before shorter audio, zero mean and unit variance over those 8 s (padding
// included), then transformers' WhisperFeatureExtractor on its numpy path: a reflect-padded STFT (Hann window of 400,
// hop 160, 400-point FFT), the power through 80 Slaney mel filters (0-8 kHz, Slaney-normalised), log10 with a floor
// of 1e-10, the last frame dropped, everything clamped to 8 below the loudest value, then (x + 4) / 4. The model's
// output is already a probability (its sigmoid is in the graph). tests/turn.rs checks this against the Python
// reference's features and probabilities.
use parakeet_rs::ort;
use std::path::Path;

const RATE: usize = 16_000;
/// The audio the model hears: the last 8 s.
pub const SAMPLES: usize = 8 * RATE;
const N_FFT: usize = 400;
const HOP: usize = 160;
const BINS: usize = N_FFT / 2 + 1;
pub const MELS: usize = 80;
/// Frames per input: one per hop (the STFT's extra last frame is dropped, as Whisper does).
pub const FRAMES: usize = SAMPLES / HOP;

pub struct SmartTurn {
    session: ort::session::Session,
}

impl SmartTurn {
    /// Loads the model in `env`: ONNX Runtime allows one environment per process, so it's the one Parakeet runs in.
    /// One thread: a call takes a few milliseconds, and it runs while the user is quiet.
    pub fn load(path: &Path, env: &ort::environment::Environment) -> Result<SmartTurn, String> {
        let err = |e: ort::Error<ort::session::builder::SessionBuilder>| e.to_string();
        let session = ort::session::Session::builder(env).map_err(|e| e.to_string())?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::All).map_err(err)?
            .with_intra_threads(1).map_err(err)?
            .with_inter_threads(1).map_err(err)?
            .commit_from_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(SmartTurn { session })
    }

    /// The probability (0-1) that the turn in `audio_16k` (16 kHz mono, the turn so far; only its last 8 s count)
    /// is complete. The reference takes more than 0.5 as complete.
    pub fn complete(&mut self, audio_16k: &[f32]) -> Result<f32, String> {
        use ort::value::Tensor;
        let e = |e: ort::Error| e.to_string();
        let input = Tensor::from_array(([1usize, MELS, FRAMES], log_mel(audio_16k))).map_err(e)?;
        let out = self.session.run(ort::inputs!["input_features" => input]).map_err(e)?;
        let (_, p) = out[0].try_extract_tensor::<f32>().map_err(e)?;
        p.first().copied().ok_or_else(|| "Smart Turn gave no output".to_string())
    }
}

/// The last 8 s of `audio`, with silence before it when it's shorter (the end of a turn is what's judged).
pub fn last_8s(audio: &[f32]) -> Vec<f32> {
    if audio.len() >= SAMPLES {
        return audio[audio.len() - SAMPLES..].to_vec();
    }
    let mut v = vec![0.0; SAMPLES - audio.len()];
    v.extend_from_slice(audio);
    v
}

/// The model's input for `audio_16k`: MELS x FRAMES log-mel values, mel-major.
pub fn log_mel(audio_16k: &[f32]) -> Vec<f32> {
    let x = last_8s(audio_16k);
    // Zero mean, unit variance (numpy's: population variance, + 1e-7), kept in f32 as the extractor keeps it.
    let n = x.len() as f64;
    let mean = x.iter().map(|&v| v as f64).sum::<f64>() / n;
    let var = x.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / n;
    let scale = 1.0 / (var + 1e-7).sqrt();
    let x: Vec<f64> = x.iter().map(|&v| ((v as f64 - mean) * scale) as f32 as f64).collect();
    // Centred frames: N_FFT / 2 reflected samples on each side (numpy's "reflect": the edge sample isn't repeated).
    let half = (N_FFT / 2) as isize;
    let last = x.len() as isize - 1;
    let at = |i: isize| {
        let j = i - half;
        x[if j < 0 { -j } else if j > last { 2 * last - j } else { j } as usize]
    };
    // Periodic Hann: numpy's hanning(N_FFT + 1) without its last point.
    let window: Vec<f64> = (0..N_FFT).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / N_FFT as f64).cos()).collect();
    let filters = mel_filters();
    let fft = Fft::new(N_FFT);
    let (mut frame, mut spectrum, mut power) = (vec![(0.0, 0.0); N_FFT], vec![(0.0, 0.0); N_FFT], [0.0f64; BINS]);
    let mut mel = vec![0.0f64; MELS * FRAMES];
    for t in 0..FRAMES {
        for (i, c) in frame.iter_mut().enumerate() {
            *c = (at((t * HOP + i) as isize) * window[i], 0.0);
        }
        fft.run(&frame, &mut spectrum);
        for (p, &(re, im)) in power.iter_mut().zip(&spectrum) {
            // The extractor keeps the spectrum as complex64 before squaring its magnitude in f64.
            let a = (re as f32 as f64).hypot(im as f32 as f64);
            *p = a * a;
        }
        for (m, (start, w)) in filters.iter().enumerate() {
            let e: f64 = w.iter().zip(&power[*start..]).map(|(a, b)| a * b).sum();
            mel[m * FRAMES + t] = e.max(1e-10).log10();
        }
    }
    let top = mel.iter().copied().fold(f64::MIN, f64::max);
    mel.iter().map(|&v| ((v.max(top - 8.0) + 4.0) / 4.0) as f32).collect()
}

/// The 80 Slaney mel filters over the FFT bins, as transformers' mel_filter_bank(201, 80, 0, 8000, 16000, "slaney",
/// "slaney") makes them: each as its first non-zero bin and its weights from there.
fn mel_filters() -> Vec<(usize, Vec<f64>)> {
    // Slaney's scale: linear below 1 kHz, logarithmic above.
    let log_step = 6.4f64.ln() / 27.0;
    let to_mel = |f: f64| if f >= 1000.0 { 15.0 + (f / 1000.0).ln() / log_step } else { 3.0 * f / 200.0 };
    let to_hz = |m: f64| if m >= 15.0 { 1000.0 * (log_step * (m - 15.0)).exp() } else { 200.0 * m / 3.0 };
    let top = to_mel(RATE as f64 / 2.0);
    // numpy's linspace: i * step, the last point exactly the end.
    let step = top / (MELS + 1) as f64;
    let edges: Vec<f64> = (0..MELS + 2).map(|i| to_hz(if i == MELS + 1 { top } else { i as f64 * step })).collect();
    let bin_hz = (RATE / 2) as f64 / (BINS - 1) as f64;
    (0..MELS)
        .map(|m| {
            let (lo, mid, hi) = (edges[m], edges[m + 1], edges[m + 2]);
            let norm = 2.0 / (hi - lo);
            let w: Vec<f64> = (0..BINS)
                .map(|k| {
                    let f = k as f64 * bin_hz;
                    ((f - lo) / (mid - lo)).min((hi - f) / (hi - mid)).max(0.0) * norm
                })
                .collect();
            let start = w.iter().position(|&v| v > 0.0).unwrap_or(0);
            let end = w.iter().rposition(|&v| v > 0.0).map_or(start, |e| e + 1);
            (start, w[start..end].to_vec())
        })
        .collect()
}

/// A mixed-radix FFT (400 = 2^4 * 5^2: a few thousand multiplies a frame where a plain DFT takes 160 000), in f64
/// like numpy's.
struct Fft {
    n: usize,
    twiddles: Vec<(f64, f64)>,
    /// Each stage's radix p and its p x p DFT matrix W_p^(r*q).
    stages: Vec<(usize, Vec<(f64, f64)>)>,
}

fn mul(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}

impl Fft {
    fn new(n: usize) -> Fft {
        let twiddles: Vec<(f64, f64)> = (0..n)
            .map(|k| {
                let a = -2.0 * std::f64::consts::PI * k as f64 / n as f64;
                (a.cos(), a.sin())
            })
            .collect();
        let (mut factors, mut rest) = (vec![], n);
        for p in 2..=n {
            while rest % p == 0 {
                factors.push(p);
                rest /= p;
            }
        }
        assert!(factors.iter().all(|&p| p <= 8), "an FFT size with a prime factor over 8");
        let stages = factors.iter().map(|&p| (p, (0..p * p).map(|i| twiddles[((i / p) * (i % p) * (n / p)) % n]).collect())).collect();
        Fft { n, twiddles, stages }
    }

    fn run(&self, input: &[(f64, f64)], out: &mut [(f64, f64)]) {
        self.step(input, 0, 1, out, 0);
    }

    /// Decimation in time: `out` gets the DFT of input[offset], input[offset + stride], ... (out.len() of them).
    fn step(&self, input: &[(f64, f64)], offset: usize, stride: usize, out: &mut [(f64, f64)], depth: usize) {
        let n = out.len();
        if n == 1 {
            out[0] = input[offset];
            return;
        }
        let (p, wp) = (self.stages[depth].0, &self.stages[depth].1);
        let m = n / p;
        for r in 0..p {
            self.step(input, offset + r * stride, stride * p, &mut out[r * m..(r + 1) * m], depth + 1);
        }
        // X[k + q*m] = sum over r of W_n^(r*k) * Y_r[k] * W_p^(r*q), where W_n^j = twiddles[j * N / n]
        // (r*k < n, so no wrapping there).
        let scale = self.n / n;
        let mut t = [(0.0, 0.0); 8];
        for k in 0..m {
            for (r, t) in t[..p].iter_mut().enumerate() {
                *t = mul(out[r * m + k], self.twiddles[r * k * scale]);
            }
            for q in 0..p {
                let mut s = (0.0, 0.0);
                for (r, &t) in t[..p].iter().enumerate() {
                    let w = mul(t, wp[r * p + q]);
                    s = (s.0 + w.0, s.1 + w.1);
                }
                out[q * m + k] = s;
            }
        }
    }
}
