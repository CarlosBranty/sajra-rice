// Builds espeak-ng for the local voice (speak.rs): the phonemizer upstream Piper 1.8 uses, at the same commit
// (OHF-Voice/piper1-gpl CMakeLists.txt, GIT_TAG 724808c), so text becomes the same phonemes. Its source is downloaded
// once into OUT_DIR and checked (the SHA-256 of the tar inside GitHub's .tar.gz, which stays the same for a commit),
// or taken from ESPEAK_NG_SOURCE (a checkout or an unpacked archive) to build offline. CMake builds the library and the
// espeak-ng tool; the tool then compiles the data (phonemes, intonations and every dictionary espeak-ng's own build
// makes, as Piper ships them all), which speak.rs embeds deflated, so the data always matches the library.
// Every dictionary, not just Spanish: for a letter outside the Spanish alphabet (π, ², “, Москва, 안녕…) espeak-ng
// switches to another language's translator, and with that language's dictionary missing it crashes (translator2 and
// translator3 are used even when their dictionary didn't load: translate.c SetAlternateTranslator, readclause.c,
// translateword.c). check_switches() fails the build if a language espeak-ng can switch to has no dictionary.
// Needs CMake and a C compiler.
// Cross-compiling (cargo xwin check from a Mac) can't run the tool: espeak-ng is left out and the local voice reports
// that it isn't built in (cfg no_espeak).
use std::path::{Path, PathBuf};
use std::process::Command;

const COMMIT: &str = "724808c5a83f9ef95fdd0db886ba7ba537ff224a";
const TAR_SHA256: &str = "e9781f9f9a510a58284220826cffd525a0c5478826dbd12558669c2f2b11337a";

fn main() {
    println!("cargo:rustc-check-cfg=cfg(no_espeak)");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=ESPEAK_NG_SOURCE");
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    if env("HOST") != env("TARGET") {
        println!("cargo:warning=cross-compiling: the local voice (espeak-ng) is left out of this build");
        println!("cargo:rustc-cfg=no_espeak");
        return;
    }
    let out = PathBuf::from(env("OUT_DIR"));
    let src = match std::env::var_os("ESPEAK_NG_SOURCE") {
        Some(p) => PathBuf::from(p),
        None => fetch(&out),
    };

    // Piper's options (no audio output, no async, no extra synthesizers): only text to phonemes is used.
    let mut cfg = cmake::Config::new(&src);
    for (k, v) in [
        ("BUILD_SHARED_LIBS", "OFF"), ("USE_ASYNC", "OFF"), ("USE_MBROLA", "OFF"), ("USE_LIBSONIC", "OFF"), ("USE_LIBPCAUDIO", "OFF"),
        ("USE_KLATT", "OFF"), ("USE_SPEECHPLAYER", "OFF"), ("ENABLE_TESTS", "OFF"), ("COMPILE_INTONATIONS", "OFF"),
    ] {
        cfg.define(k, v);
    }
    // Always optimised (and the release C runtime on Windows, as Rust links): a debug espeak-ng gains nothing.
    let dst = cfg.profile("Release").build_target("espeak-ng-bin").build();
    let build = dst.join("build");
    let exe = if cfg!(windows) { "espeak-ng.exe" } else { "espeak-ng" };
    let tool = find(&build, exe).expect("espeak-ng tool not built");
    for lib in ["espeak-ng", "ucd"] {
        let file = if env("CARGO_CFG_TARGET_ENV") == "msvc" { format!("{lib}.lib") } else { format!("lib{lib}.a") };
        let at = find(&build, &file).unwrap_or_else(|| panic!("{file} not built"));
        println!("cargo:rustc-link-search=native={}", at.parent().unwrap().display());
        println!("cargo:rustc-link-lib=static={lib}");
    }

    // The data, as espeak-ng's cmake/data.cmake makes it: every dictionary in its list (with the extra ones it adds by
    // default: extra/<lang>_listx). Compiling one reads its language's voice file, so they're all there; only the
    // Spanish one (the voice set by name) is shipped.
    let root = out.join("espeak-data");
    let data = root.join("espeak-ng-data");
    let _ = std::fs::remove_dir_all(&root);
    copy_dir(&src.join("espeak-ng-data/lang"), &data.join("lang"));
    let ph = root.join("phsource");
    copy_dir(&src.join("phsource"), &ph);
    let dict = root.join("dictsource");
    std::fs::create_dir_all(&dict).unwrap();
    let ds = src.join("dictsource");
    let langs = dict_list(&std::fs::read_to_string(src.join("cmake/data.cmake")).unwrap());
    for l in &langs {
        for f in [format!("{l}_rules"), format!("{l}_list")] {
            std::fs::copy(ds.join(&f), dict.join(&f)).unwrap_or_else(|e| panic!("dictsource/{f}: {e}"));
        }
        let listx = format!("{l}_listx");
        if let Some(from) = [ds.join("extra").join(&listx), ds.join(&listx)].into_iter().find(|p| p.is_file()) {
            std::fs::copy(from, dict.join(&listx)).unwrap();
        }
        let emoji = format!("{l}_emoji");
        if ds.join(&emoji).is_file() {
            std::fs::copy(ds.join(&emoji), dict.join(&emoji)).unwrap();
        }
    }
    let run = |args: &[&str], dir: &Path| {
        let o = Command::new(&tool).args(args).current_dir(dir).env("ESPEAK_DATA_PATH", &root).output().unwrap_or_else(|e| panic!("espeak-ng {args:?}: {e}"));
        assert!(o.status.success(), "espeak-ng {args:?} failed: {}", String::from_utf8_lossy(&o.stderr));
    };
    run(&["--compile-intonations"], &ph);
    run(&["--compile-phonemes"], &ph);
    // Each dictionary is its own file, so they compile side by side.
    let next = std::sync::atomic::AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                while let Some(l) = langs.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) {
                    run(&[&format!("--compile={l}")], &dict);
                }
            });
        }
    });
    check_switches(&src, &data, &langs);
    pack(&out, &data);
}

/// The dictionaries espeak-ng's build compiles: the `_dict_compile_list` in cmake/data.cmake.
fn dict_list(cmake: &str) -> Vec<String> {
    let start = cmake.find("_dict_compile_list").expect("no _dict_compile_list in cmake/data.cmake");
    let body = &cmake[start + "_dict_compile_list".len()..];
    let langs: Vec<String> = body[..body.find(')').unwrap()].split_whitespace().map(str::to_owned).collect();
    assert!(langs.iter().any(|l| l == "es") && langs.len() > 50, "unexpected _dict_compile_list: {langs:?}");
    langs
}

/// Every language espeak-ng can switch to while reading text must have its dictionary, or it crashes: English (the
/// fallback for letters and numbers: ESPEAKNG_DEFAULT_VOICE), the alphabets' languages and alt_alphabet_lang
/// (tr_languages.c), and every `_^_<lang>` in the dictionaries' sources. A switch only happens to a language with a
/// phoneme table (SelectPhonemeTableName), so those are the ones checked. Croatian, Bosnian and Serbian read the
/// dictionary "hbs", which espeak-ng doesn't build: a switch to them would crash too.
fn check_switches(src: &Path, data: &Path, langs: &[String]) {
    let tr = std::fs::read_to_string(src.join("src/libespeak-ng/tr_languages.c")).unwrap();
    let pairs = |s: &str| -> Vec<String> {
        s.match_indices("L('").filter_map(|(i, _)| {
            let b = s[i..].as_bytes();
            (b.len() > 9 && b[4] == b'\'' && b[7] == b'\'' && b[9] == b')').then(|| format!("{}{}", b[3] as char, b[8] as char))
        }).collect()
    };
    let table = &tr[tr.find("alphabets[] = {").expect("no alphabets table")..];
    let mut targets = pairs(&table[..table.find("};").unwrap()]);
    targets.extend(tr.lines().filter(|l| l.contains("alt_alphabet_lang =")).flat_map(pairs));
    targets.push("en".into());
    for l in langs {
        for f in [format!("{l}_rules"), format!("{l}_list"), format!("{l}_listx"), format!("{l}_emoji")] {
            let Ok(text) = std::fs::read_to_string(data.parent().unwrap().join("dictsource").join(&f)) else { continue };
            for (i, _) in text.match_indices("_^_") {
                let name: String = text[i + 3..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
                targets.push(name.to_ascii_lowercase());
            }
        }
    }
    let phonemes = std::fs::read_to_string(src.join("phsource/phonemes")).unwrap();
    let tables: Vec<&str> = phonemes.lines().filter_map(|l| l.trim().strip_prefix("phonemetable")).filter_map(|l| l.split_whitespace().next()).collect();
    targets.sort();
    targets.dedup();
    for t in targets.iter().filter(|t| tables.contains(&t.as_str())) {
        assert!(!["hr", "bs", "sr"].contains(&t.as_str()), "espeak-ng can switch to {t}, whose dictionary (hbs) isn't built");
        assert!(data.join(format!("{t}_dict")).is_file(), "espeak-ng can switch to {t}, but {t}_dict wasn't built");
    }
}

/// The data for speak.rs: its files one after another (name length u32, name, length u64, bytes; little-endian,
/// sorted by name) as one zlib stream, `espeak-data.z`, and `espeak_data.rs` with the list of files and sizes and the
/// SHA-256 of the unpacked stream (written next to the unpacked files, so they're only unpacked again when they change).
fn pack(out: &Path, data: &Path) {
    use std::io::Write;
    let mut files = Vec::new();
    walk(data, data, &mut files);
    // phondata-manifest is a list for tools; of the voice files only Spanish is read (espeak_SetVoiceByName).
    files.retain(|(name, _)| name != "phondata-manifest" && (!name.starts_with("lang/") || name == "lang/roa/es"));
    files.sort();
    let mut raw = Vec::new();
    let mut list = String::new();
    for (name, bytes) in &files {
        raw.extend((name.len() as u32).to_le_bytes());
        raw.extend(name.as_bytes());
        raw.extend((bytes.len() as u64).to_le_bytes());
        raw.extend(bytes);
        list.push_str(&format!("    ({name:?}, {}),\n", bytes.len()));
    }
    let sum: String = hmac_sha256::Hash::hash(&raw).iter().map(|b| format!("{b:02x}")).collect();
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    z.write_all(&raw).unwrap();
    std::fs::write(out.join("espeak-data.z"), z.finish().unwrap()).unwrap();
    let rs = format!("pub const PACK: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/espeak-data.z\"));\npub const SUM: &str = \"{sum}\";\npub const FILES: &[(&str, u64)] = &[\n{list}];\n");
    std::fs::write(out.join("espeak_data.rs"), rs).unwrap();
}

fn walk(base: &Path, dir: &Path, files: &mut Vec<(String, Vec<u8>)>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(base, &p, files);
        } else {
            let name = p.strip_prefix(base).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            files.push((name, std::fs::read(&p).unwrap()));
        }
    }
}

/// The pinned source, downloaded and checked once (a stamp marks a checked copy).
fn fetch(out: &Path) -> PathBuf {
    let dir = out.join(format!("espeak-ng-{COMMIT}"));
    let stamp = out.join("espeak-ng.checked");
    if std::fs::read_to_string(&stamp).is_ok_and(|s| s == TAR_SHA256) && dir.join("CMakeLists.txt").is_file() {
        return dir;
    }
    let url = format!("https://github.com/espeak-ng/espeak-ng/archive/{COMMIT}.tar.gz");
    let gz = out.join("espeak-ng.tar.gz");
    // curl comes with Linux, macOS and Windows 10 and later.
    let ok = Command::new("curl").args(["-fsSL", "--retry", "3", "-o"]).arg(&gz).arg(&url).status().map(|s| s.success());
    assert!(matches!(ok, Ok(true)), "couldn't download {url}; set ESPEAK_NG_SOURCE to an espeak-ng checkout at {COMMIT} to build offline");
    let mut tar = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(std::fs::File::open(&gz).unwrap()), &mut tar).expect("espeak-ng archive: bad gzip");
    let sum: String = hmac_sha256::Hash::hash(&tar).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(sum, TAR_SHA256, "espeak-ng archive didn't match its checksum");
    let tar_file = out.join("espeak-ng.tar");
    std::fs::write(&tar_file, &tar).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // tar comes with them too (bsdtar on Windows); the archive's top folder is dropped.
    let ok = Command::new("tar").arg("-xf").arg(&tar_file).arg("--strip-components=1").arg("-C").arg(&dir).status().map(|s| s.success());
    assert!(matches!(ok, Ok(true)), "couldn't unpack the espeak-ng archive");
    let _ = std::fs::remove_file(&tar_file);
    let _ = std::fs::remove_file(&gz);
    std::fs::write(&stamp, TAR_SHA256).unwrap();
    dir
}

fn find(dir: &Path, name: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find(&p, name) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == name) {
            return Some(p);
        }
    }
    None
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()));
        } else {
            std::fs::copy(&p, to.join(e.file_name())).unwrap();
        }
    }
}
