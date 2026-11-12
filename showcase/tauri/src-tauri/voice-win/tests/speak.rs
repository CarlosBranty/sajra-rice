// The local voice end to end: `roamies-voice --speak` on the real voice. The voice isn't in the repository (the app
// downloads it: sidecar/voicemodel.mjs), so this runs when ROAMIES_TEST_VOICE names a copy of its .onnx (with the
// .onnx.json next to it; espeak-ng's data is unpacked there too) and is skipped otherwise:
//   ROAMIES_TEST_VOICE=/path/to/es_ES-sharvard-medium.onnx cargo test --release --test speak -- --nocapture
// Every line that crashed it (text outside the Spanish alphabet: fixtures/piper18-ids-switch.json) gets audio and its
// "said", the process lives through all of them and exits 0, and two sentences far past MAX_PHONEMES (400 words with no
// full stop, 930 characters with no space) are made in pieces: on Linux, its peak memory stays under 1 GB (it took
// 1.9 to 2.8 GB when a sentence went to the model whole).
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn speak_says_every_line_and_bounds_long_ones() {
    let Some(model) = std::env::var_os("ROAMIES_TEST_VOICE") else {
        eprintln!("skipped: set ROAMIES_TEST_VOICE to the local voice's .onnx to run it");
        return;
    };
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/piper18-ids-switch.json")).unwrap();
    let mut lines: Vec<String> = fixture.as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().to_owned()).collect();
    let words = "el gato de mi vecina duerme todas las tardes junto a la ventana mientras llueve sobre los tejados".split(' ').collect::<Vec<_>>();
    lines.push((0..400).map(|i| words[i % words.len()]).collect::<Vec<_>>().join(" "));
    lines.push((0..930).map(|i| (b"htg1p69nvv6z4gi27978kq0xw3"[(i * 7) % 26]) as char).collect());

    let mut p = Command::new(env!("CARGO_BIN_EXE_roamies-voice"))
        .args(["--speak".as_ref(), model.as_os_str(), "--speaker".as_ref(), "1".as_ref(), "--threads".as_ref(), "2".as_ref()])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
    let mut stdin = p.stdin.take().unwrap();
    let mut out = BufReader::new(p.stdout.take().unwrap()).lines().map(|l| serde_json::from_str::<serde_json::Value>(&l.unwrap()).unwrap());
    assert_eq!(out.next().unwrap()["type"], "ready");
    for (i, text) in lines.iter().enumerate() {
        let id = format!("t{i}");
        writeln!(stdin, "{}", serde_json::json!({ "id": id, "text": text })).unwrap();
        let mut samples = 0;
        loop {
            let m = out.next().unwrap_or_else(|| panic!("the helper died on {text:?}"));
            assert_eq!(m["id"], id.as_str(), "{m}");
            match m["type"].as_str() {
                Some("audio") => samples += m["pcm"].as_str().unwrap().trim_end_matches('=').len() * 3 / 4 / 2,
                Some("said") => break,
                _ => panic!("{text:?}: {m}"),
            }
        }
        assert!(samples > 4000, "no audio for {text:?}");
        eprintln!("{samples:>8} samples  {}", text.chars().take(50).collect::<String>());
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string(format!("/proc/{}/status", p.id())).unwrap();
        let kb: u64 = status.lines().find_map(|l| l.strip_prefix("VmHWM:")).unwrap().trim().trim_end_matches(" kB").parse().unwrap();
        eprintln!("peak memory {} MB", kb / 1024);
        assert!(kb < 1024 * 1024, "peak memory {kb} kB");
    }
    drop(stdin);
    assert_eq!(p.wait().unwrap().code(), Some(0));
}
