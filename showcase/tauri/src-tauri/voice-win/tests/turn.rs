// Smart Turn (src/turn.rs) against the official Python inference: fixtures/smart-turn-reference.json holds what
// github.com/pipecat-ai/smart-turn's inference.py (transformers' WhisperFeatureExtractor, onnxruntime) made of two
// made-up signals (their features, summarised, and probabilities) and of Spanish clips spoken by the local voice
// (fixtures/smart-turn-*.wav: probabilities). The features are checked always. The model isn't in the repository (the
// app downloads it: sidecar/voicemodel.mjs), so the probabilities run when ROAMIES_TEST_SMART_TURN names a copy of it:
//   ROAMIES_TEST_SMART_TURN=/path/to/smart-turn.onnx cargo test --release --test turn -- --nocapture
// The module isn't wired into the binary here: it's compiled into this test on its own.
#[path = "../src/turn.rs"]
mod turn;

use serde_json::Value;
use std::time::Instant;

fn reference() -> Value {
    serde_json::from_str(include_str!("../fixtures/smart-turn-reference.json")).unwrap()
}

// The made-up signal, sample for sample as the script that made the fixture builds it: two tones under a slow swell, and
// a little noise from a 32-bit LCG.
fn tone(n: usize) -> Vec<f32> {
    use std::f64::consts::PI;
    let mut s: u32 = 12345;
    (0..n)
        .map(|i| {
            let t = i as f64 / 16000.0;
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            let noise = (s >> 8) as f64 / 16777216.0 * 2.0 - 1.0;
            let env = 0.5 + 0.5 * (2.0 * PI * 1.5 * t).sin();
            (env * (0.3 * (2.0 * PI * 220.0 * t).sin() + 0.1 * (2.0 * PI * 1760.0 * t).sin()) + 0.02 * noise) as f32
        })
        .collect()
}

fn wav(name: &str) -> Vec<f32> {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    hound::WavReader::open(&path).unwrap().samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect()
}

// The features are mel-major, as the model takes them: [mel * FRAMES + frame].
const FEATURES_TOLERANCE: f64 = 1e-4;

#[test]
fn features_match_the_reference() {
    let r = reference();
    for (name, want) in r["tones"].as_object().unwrap() {
        let f = turn::log_mel(&tone(want["samples"].as_u64().unwrap() as usize));
        let want = &want["features"];
        assert_eq!(f.len(), turn::MELS * turn::FRAMES);
        assert_eq!(want["shape"], serde_json::json!([turn::MELS, turn::FRAMES]));
        let at = |m: usize, t: usize| f[m * turn::FRAMES + t] as f64;
        let mut worst = 0f64;
        let mut check = |what: String, got: f64, want: f64| {
            worst = worst.max((got - want).abs());
            assert!((got - want).abs() < FEATURES_TOLERANCE, "{name} {what}: {got} vs the reference's {want}");
        };
        for frame in [0, 400, 799] {
            for (m, v) in want[format!("frame_{frame}")].as_array().unwrap().iter().enumerate() {
                check(format!("mel {m} frame {frame}"), at(m, frame), v.as_f64().unwrap());
            }
        }
        for p in want["picks"].as_array().unwrap() {
            let (m, t) = (p[0].as_u64().unwrap() as usize, p[1].as_u64().unwrap() as usize);
            check(format!("mel {m} frame {t}"), at(m, t), p[2].as_f64().unwrap());
        }
        let min = f.iter().fold(f32::MAX, |a, &b| a.min(b)) as f64;
        let max = f.iter().fold(f32::MIN, |a, &b| a.max(b)) as f64;
        check("min".into(), min, want["min"].as_f64().unwrap());
        check("max".into(), max, want["max"].as_f64().unwrap());
        // Over 64 000 values: the mean of the differences, not each one.
        let n = f.len() as f64;
        check("mean".into(), f.iter().map(|&v| v as f64).sum::<f64>() / n, want["sum"].as_f64().unwrap() / n);
        check("mean square".into(), f.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / n, want["sum_sq"].as_f64().unwrap() / n);
        eprintln!("{name}: features within {worst:.2e} of the reference");
    }
}

#[test]
fn short_audio_is_padded_at_the_start_and_long_audio_keeps_its_end() {
    let short = turn::last_8s(&[0.5; 3]);
    assert_eq!(short.len(), turn::SAMPLES);
    assert!(short[..turn::SAMPLES - 3].iter().all(|&v| v == 0.0), "silence goes before the audio");
    assert_eq!(&short[turn::SAMPLES - 3..], &[0.5; 3]);

    let long: Vec<f32> = (0..turn::SAMPLES + 2000).map(|i| i as f32).collect();
    let kept = turn::last_8s(&long);
    assert_eq!(kept.len(), turn::SAMPLES);
    assert_eq!((kept[0], kept[turn::SAMPLES - 1]), (2000.0, (turn::SAMPLES + 1999) as f32), "the newest 8 s are kept");

    let ten = tone(160_000);
    assert_eq!(turn::log_mel(&ten), turn::log_mel(&ten[32_000..]), "only the last 8 s count");
}

// The model is int8 with dynamically quantised activations, so features a hair apart can land one quantisation step
// apart: the reference's own output for smart-turn-cut-mid-phrase.wav (0.0177) moves between 0.011 and 0.016 when its
// features get noise of 1e-6, a thousandth of what tells a finished turn from one cut off.
const PROBABILITY_TOLERANCE: f64 = 0.01;

#[test]
fn probabilities_match_the_reference() {
    let Some(model) = std::env::var_os("ROAMIES_TEST_SMART_TURN") else {
        eprintln!("skipped: set ROAMIES_TEST_SMART_TURN to the Smart Turn model (smart-turn-v3.2-cpu.onnx) to run it");
        return;
    };
    let r = reference();
    let env = parakeet_rs::ort::init().with_name("roamies-turn-test").build().unwrap();
    let mut st = turn::SmartTurn::load(model.as_ref(), &env).unwrap();
    let mut cases: Vec<(String, Vec<f32>, f64)> = r["tones"].as_object().unwrap().iter()
        .map(|(name, v)| (format!("tone {name}"), tone(v["samples"].as_u64().unwrap() as usize), v["probability"].as_f64().unwrap()))
        .collect();
    for (name, p) in r["wavs"].as_object().unwrap() {
        // "<file>[:n]": the file's first n samples.
        let (file, cut) = match name.split_once("[:") {
            Some((f, n)) => (f, Some(n.trim_end_matches(']').parse::<usize>().unwrap())),
            None => (name.as_str(), None),
        };
        let mut a = wav(file);
        if let Some(n) = cut { a.truncate(n) }
        cases.push((name.clone(), a, p.as_f64().unwrap()));
    }
    let mut worst = 0f64;
    for (name, audio, want) in &cases {
        let got = st.complete(audio).unwrap() as f64;
        eprintln!("{name}: {got:.6} (reference {want:.6})");
        worst = worst.max((got - want).abs());
        assert!((got - want).abs() < PROBABILITY_TOLERANCE, "{name}: {got} vs the reference's {want}");
    }
    eprintln!("probabilities within {worst:.2e} of the reference");
    // The clips that end a sentence are complete; the ones cut off mid-phrase aren't.
    for (name, audio, _) in cases.iter().filter(|c| !c.0.starts_with("tone")) {
        let p = st.complete(audio).unwrap();
        assert_eq!(p > 0.5, name.contains("complete-") && !name.contains("[:"), "{name}: {p}");
    }

    // The quickest of 20 calls: the machine's other work only ever adds to it.
    let audio = &cases.last().unwrap().1;
    let quickest = |f: &mut dyn FnMut()| (0..20).map(|_| { let t0 = Instant::now(); f(); t0.elapsed() }).min().unwrap();
    let call = quickest(&mut || { st.complete(audio).unwrap(); });
    let features = quickest(&mut || { std::hint::black_box(turn::log_mel(audio)); });
    eprintln!("complete(): {call:.1?} a call ({features:.1?} of it the features)");
}
