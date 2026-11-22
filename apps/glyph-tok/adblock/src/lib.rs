//! glyph-tok ad blocker: Brave's engine (adblock-rust) behind a tiny C API.
//!
//! `dir` holds the filter lists (`lists/*.txt`) and the scriptlet / redirect resources: uBlock Origin's
//! (`ubo-resources.json`) and Brave's own (`resources.json`), all written by `glyph-tok-adblock-update`. The compiled engine is cached in `dir/engine.dat` and rebuilt when a list is newer than
//! the cache or the cache can't be read (other crate version, truncated file).
//!
//! Every function is null-safe and never panics across the FFI boundary: a missing or broken setup means "no
//! blocker", never a crash in glyph-tok.

use adblock::lists::ParseOptions;
use adblock::request::Request;
use adblock::resources::{PermissionMask, Resource};
use adblock::{Engine, FilterSet};
use std::ffi::{c_char, CStr, CString};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const TRUSTED: PermissionMask = PermissionMask::from_bits(1);

pub struct Blocker {
    engine: Engine,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn list_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir.join("lists"))
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect())
        .unwrap_or_default();
    v.sort();
    v
}

impl Blocker {
    /// None when there are no lists: the caller runs without a blocker
    pub fn open(dir: &Path) -> Option<Blocker> {
        let lists = list_files(dir);
        if lists.is_empty() {
            return None;
        }
        let cache = dir.join("engine.dat");
        let newest = lists.iter().filter_map(|p| mtime(p)).max();
        let mut engine = None;
        if let (Some(c), Some(n)) = (mtime(&cache), newest) {
            if c >= n {
                if let Ok(bytes) = fs::read(&cache) {
                    let mut e = Engine::default();
                    if e.deserialize(&bytes).is_ok() {
                        engine = Some(e);
                    }
                }
            }
        }
        let mut engine = match engine {
            Some(e) => e,
            None => {
                let mut set = FilterSet::new(false);
                // Brave's default lists carry permission_mask 1 in its catalog: it lets them use the scriptlets uBlock
                // marks requiresTrust (trusted-*), which YouTube's rules need
                let opts = ParseOptions { permissions: TRUSTED, ..ParseOptions::default() };
                for p in &lists {
                    if let Ok(text) = fs::read_to_string(p) {
                        set.add_filter_list(text, opts.clone());
                    }
                }
                let e = Engine::new_with_filter_set(set);
                // cache is best effort: write to a temp file, then rename, so a crash never leaves half a file
                let tmp = dir.join("engine.dat.tmp");
                if fs::write(&tmp, e.serialize()).is_ok() {
                    let _ = fs::rename(&tmp, &cache);
                }
                e
            }
        };
        let mut res: Vec<Resource> = Vec::new();
        for f in ["ubo-resources.json", "resources.json"] {
            if let Ok(text) = fs::read_to_string(dir.join(f)) {
                res.extend(serde_json::from_str::<Vec<Resource>>(&text).unwrap_or_default());
            }
        }
        engine.use_resources(res);
        Some(Blocker { engine })
    }

    /// What to do with a request: None = let it through, Some(None) = cancel it, Some(Some(url)) = answer it with
    /// `url` instead (a data: URL with a harmless stub, e.g. google-ima.js for Google's video-ad SDK, so players
    /// don't break or notice). `kind` is adblock's request type ("script", "image", "sub_frame", …)
    pub fn check(&self, url: &str, source: &str, kind: &str) -> Option<Option<String>> {
        let req = Request::new(url, source, kind, "GET").ok()?;
        let r = self.engine.check_network_request(&req);
        if r.exception.is_none() || r.important {
            if let Some(to) = r.redirect {
                return Some(Some(to));
            }
        }
        if r.should_block() {
            return Some(None);
        }
        None
    }

    pub fn block(&self, url: &str, source: &str, kind: &str) -> bool {
        self.check(url, source, kind).is_some()
    }

    /// What a page at `url` gets: CSS selectors to hide and the scriptlets to run, as JSON
    /// `{"hide":[…],"script":"…"}` (empty fields when nothing applies)
    pub fn cosmetic(&self, url: &str) -> String {
        let r = self.engine.url_cosmetic_resources(url);
        let mut hide: Vec<&String> = r.hide_selectors.iter().collect();
        hide.sort();
        serde_json::json!({ "hide": hide, "script": r.injected_script }).to_string()
    }
}

unsafe fn arg<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        None
    } else {
        CStr::from_ptr(p).to_str().ok()
    }
}

/// Opens the blocker from `dir`; null when there's nothing to block with
#[no_mangle]
pub unsafe extern "C" fn tok_ab_open(dir: *const c_char) -> *mut Blocker {
    match arg(dir).and_then(|d| Blocker::open(Path::new(d))) {
        Some(b) => Box::into_raw(Box::new(b)),
        None => std::ptr::null_mut(),
    }
}

/// 0 = allow, 1 = block, 2 = redirect: `*redirect` gets the URL to serve instead (free it with `tok_ab_free_str`)
#[no_mangle]
pub unsafe extern "C" fn tok_ab_check(
    b: *const Blocker,
    url: *const c_char,
    source: *const c_char,
    kind: *const c_char,
    redirect: *mut *mut c_char,
) -> i32 {
    let (Some(b), Some(u), Some(s), Some(k)) = (b.as_ref(), arg(url), arg(source), arg(kind)) else { return 0 };
    match b.check(u, s, k) {
        None => 0,
        Some(None) => 1,
        Some(Some(to)) => match (redirect.is_null(), CString::new(to)) {
            (false, Ok(c)) => {
                *redirect = c.into_raw();
                2
            }
            _ => 1,
        },
    }
}

/// JSON string (see `Blocker::cosmetic`), owned by the caller: release with `tok_ab_free_str`
#[no_mangle]
pub unsafe extern "C" fn tok_ab_cosmetic(b: *const Blocker, url: *const c_char) -> *mut c_char {
    match (b.as_ref(), arg(url)) {
        (Some(b), Some(u)) => CString::new(b.cosmetic(u)).map(|c| c.into_raw()).unwrap_or(std::ptr::null_mut()),
        _ => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn tok_ab_free_str(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

#[no_mangle]
pub unsafe extern "C" fn tok_ab_close(b: *mut Blocker) {
    if !b.is_null() {
        drop(Box::from_raw(b));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(test: &str, lists: &[(&str, &str)]) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tok-ab-{}-{test}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("lists")).unwrap();
        for (n, t) in lists {
            fs::write(d.join("lists").join(n), t).unwrap();
        }
        d
    }

    #[test]
    fn no_lists_no_blocker() {
        let d = setup("none", &[]);
        assert!(Blocker::open(&d).is_none());
        assert!(unsafe { tok_ab_open(std::ptr::null()) }.is_null());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn blocks_network_and_caches() {
        let d = setup("net", &[("a.txt", "||ads.example.com^\n@@||ads.example.com/ok.js\nexample.org##.banner\n")]);
        let b = Blocker::open(&d).unwrap();
        assert!(b.block("https://ads.example.com/x.js", "https://site.org/", "script"));
        assert!(!b.block("https://ads.example.com/ok.js", "https://site.org/", "script"));
        assert!(!b.block("https://cdn.example.net/x.js", "https://site.org/", "script"));
        assert!(b.cosmetic("https://example.org/page").contains(".banner"));
        assert!(d.join("engine.dat").exists());
        // second open reads the cache and behaves the same
        let b2 = Blocker::open(&d).unwrap();
        assert!(b2.block("https://ads.example.com/x.js", "https://site.org/", "script"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn redirects_to_stub() {
        use std::io::Write;
        let d = setup("redirect", &[("c.txt", "||imasdk.example.com/ima3.js$script,redirect=google-ima.js\n")]);
        // "function(){}" in base64
        fs::File::create(d.join("ubo-resources.json")).unwrap().write_all(
            br#"[{"name":"google-ima.js","aliases":["google-ima3"],"kind":{"mime":"application/javascript"},"content":"ZnVuY3Rpb24oKXt9"}]"#,
        ).unwrap();
        let b = Blocker::open(&d).unwrap();
        let r = b.check("https://imasdk.example.com/ima3.js", "https://site.org/", "script");
        assert!(matches!(&r, Some(Some(u)) if u.starts_with("data:")), "redirected to a data: stub: {r:?}");
        let c = std::ffi::CString::new("https://imasdk.example.com/ima3.js").unwrap();
        let s = std::ffi::CString::new("https://site.org/").unwrap();
        let k = std::ffi::CString::new("script").unwrap();
        let mut out: *mut c_char = std::ptr::null_mut();
        let p = Box::into_raw(Box::new(b));
        assert_eq!(unsafe { tok_ab_check(p, c.as_ptr(), s.as_ptr(), k.as_ptr(), &mut out) }, 2);
        assert!(!out.is_null());
        unsafe { tok_ab_free_str(out); tok_ab_close(p); }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn scriptlets_with_trust() {
        use std::io::Write;
        let d = setup("trust", &[("b.txt", "example.org##+js(noop)\nexample.org##+js(trusted-noop)\n")]);
        let b64 = |s: &str| {
            // tiny base64 encoder for the test fixtures
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let (b, mut o) = (s.as_bytes(), String::new());
            for c in b.chunks(3) {
                let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
                for i in 0..4 {
                    o.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
                }
            }
            o
        };
        let res = format!(
            r#"[{{"name":"noop.js","aliases":[],"kind":{{"mime":"application/javascript"}},"content":"{}"}},
               {{"name":"trusted-noop.js","aliases":[],"kind":{{"mime":"application/javascript"}},"content":"{}","permission":1}}]"#,
            b64("function noop() { window.__a = 1; }"),
            b64("function trustedNoop() { window.__b = 1; }")
        );
        fs::File::create(d.join("ubo-resources.json")).unwrap().write_all(res.as_bytes()).unwrap();
        let b = Blocker::open(&d).unwrap();
        let c = b.cosmetic("https://example.org/");
        assert!(c.contains("__a"), "plain scriptlet injected: {c}");
        assert!(c.contains("__b"), "trusted scriptlet injected for a trusted list: {c}");
        let _ = fs::remove_dir_all(&d);
    }
}
