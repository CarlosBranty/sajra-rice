// Builds espeak-ng for the local voice (speak.rs): the phonemizer upstream Piper 1.8 uses, at the same commit
// (OHF-Voice/piper1-gpl CMakeLists.txt, GIT_TAG 724808c), so text becomes the same phonemes. Its source is downloaded
// once into OUT_DIR and checked (the SHA-256 of the tar inside GitHub's .tar.gz, which stays the same for a commit),
// or taken from ESPEAK_NG_SOURCE (a checkout or an unpacked archive) to build offline. CMake builds the library and the
// espeak-ng tool; the tool then compiles the Spanish data (phonemes, intonations, es_dict), which speak.rs embeds, so
// the data always matches the library. Needs CMake and a C compiler.
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

    // The Spanish data, as espeak-ng's cmake/data.cmake makes it (for every language there).
    let root = out.join("espeak-data");
    let data = root.join("espeak-ng-data");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(data.join("lang").join("roa")).unwrap();
    std::fs::copy(src.join("espeak-ng-data/lang/roa/es"), data.join("lang/roa/es")).unwrap();
    let ph = root.join("phsource");
    copy_dir(&src.join("phsource"), &ph);
    let dict = root.join("dictsource");
    std::fs::create_dir_all(&dict).unwrap();
    for f in ["es_rules", "es_list", "es_emoji"] {
        std::fs::copy(src.join("dictsource").join(f), dict.join(f)).unwrap();
    }
    let run = |args: &[&str], dir: &Path| {
        let ok = Command::new(&tool).args(args).current_dir(dir).env("ESPEAK_DATA_PATH", &root).status().map(|s| s.success());
        assert!(matches!(ok, Ok(true)), "espeak-ng {args:?} failed");
    };
    run(&["--compile-intonations"], &ph);
    run(&["--compile-phonemes"], &ph);
    run(&["--compile=es"], &dict);
    println!("cargo:rustc-env=ROAMIES_ESPEAK_DATA={}", data.display());
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
