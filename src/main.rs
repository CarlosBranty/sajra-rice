//! x1sound — controlador de altavoces estilo Dolby para el ThinkPad X1 Carbon Gen 9 (PipeWire).
//!
//! La cadena DSP vive en ~/.config/pipewire/pipewire.conf.d/x1sound.conf (corrección Dolby de Lenovo, EQ,
//! regulador por bandas y limitador). Este programa solo ajusta sus controles en vivo y los DAC del codec:
//!   perfiles (dynamic/music/voice/off) · graves · agudos · ganancia (volmax) · loudness según el volumen ·
//!   balance arriba (DAC1, tweeters) / abajo (DAC2, woofers).
//! Si el daemon no corre, la cadena sigue sonando con sus últimos valores: nunca deja el audio sin protección.

mod config;
mod json;
mod policy;
mod presets;
mod sys;

use config::Config;
use json::Json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

const TICK: Duration = Duration::from_millis(100);
/// dB por tick al subir un realce (10 dB/s): evita saltos bruscos de graves
const RAMP_DB: f64 = 1.0;

fn usage() -> ! {
    eprintln!(
        "x1sound — controlador de altavoces (ThinkPad X1 Carbon Gen 9)

uso:
  x1sound status                 estado del daemon y config
  x1sound set <clave> <valor>    claves: profile bass_db treble_db boost_db loudness loudness_amount tweeter woofer enabled
  x1sound profile <p>            dynamic | music | voice | off
  x1sound eq list                presets de ecualización (~/.config/x1sound/eq-presets.json)
  x1sound eq <preset>            aplica un preset (flat, bass, rock, pop, electronic, hip-hop, jazz, acoustic, vocal, clarity…)
  x1sound apply                  aplica la config una vez (sin daemon)
  x1sound clamp                  pone los DAC de los altavoces en sus valores (al iniciar sesión)
  x1sound doctor                 autodiagnóstico (código de salida 0 = todo bien)
  x1sound daemon                 bucle: aplica cambios de config y el loudness según el volumen"
    );
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let code = match a.as_slice() {
        ["status"] => status(),
        ["set", k, v] => set(k, v),
        ["profile", p] => set("profile", p),
        ["eq", "list"] => eq_list(),
        ["eq", name] => eq_preset(name),
        ["apply"] => apply_once(),
        ["clamp"] => clamp(),
        ["doctor"] => doctor(),
        ["daemon"] => daemon(),
        _ => usage(),
    };
    std::process::exit(code)
}

fn set(k: &str, v: &str) -> i32 {
    let mut c = match config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config ilegible ({e}); se parte de los valores por defecto");
            Config::default()
        }
    };
    if let Err(e) = c.set(k, v) {
        eprintln!("{e}");
        return 2;
    }
    if let Err(e) = config::save(&c) {
        eprintln!("no se pudo guardar: {e}");
        return 1;
    }
    println!("{}", json::to_string(&c.to_json()).trim_end());
    0
}

fn eq_list() -> i32 {
    let l = presets::load();
    let cur = config::load().ok().and_then(|c| presets::matching(&l, &c.eq));
    for (n, e) in &l {
        let v: Vec<String> = e.iter().map(|x| format!("{x:+}")).collect();
        println!("{} {:<12} {}", if cur.as_deref() == Some(n) { "*" } else { " " }, n, v.join(" "));
    }
    0
}

fn eq_preset(name: &str) -> i32 {
    let l = presets::load();
    let Some((_, e)) = l.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) else {
        eprintln!("no hay preset '{name}' (x1sound eq list)");
        return 2;
    };
    let v: Vec<String> = e.iter().map(|x| x.to_string()).collect();
    set("eq", &v.join(","))
}

fn apply_once() -> i32 {
    let c = config::load().unwrap_or_default();
    let Some(id) = sys::node_id(sys::FILTER) else {
        eprintln!("no está el filtro {} (¿x1sound.conf instalado y PipeWire reiniciado?)", sys::FILTER);
        return 1;
    };
    let vol = sys::sink_volume().map(|v| v.0);
    let t = policy::target(&c, vol);
    let ok = sys::write_params(id, &t.params.into_iter().collect::<Vec<_>>());
    let dac = clamp();
    if ok && dac == 0 { 0 } else { 1 }
}

/// DAC1/DAC2 a los valores de la config, solo en la ruta dividida segura.
fn clamp() -> i32 {
    let c = config::load().unwrap_or_default();
    match sys::routing() {
        sys::Routing::Split => {
            set_dac("DAC1 Playback Volume", c.tweeter);
            set_dac("DAC2 Playback Volume", c.woofer);
            0
        }
        sys::Routing::Shared => 0, // sin balance hardware: nada que hacer
        r => {
            eprintln!("ruta {r:?}: no se tocan los DAC");
            1
        }
    }
}

fn set_dac(name: &str, v: i64) {
    let v = v.clamp(config::DAC.0, config::DAC.1);
    if sys::ctl_get(name) != Some(v) {
        sys::ctl_set(name, v);
    }
}

fn state_path() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("x1sound/state.json")
}

fn status() -> i32 {
    match std::fs::read_to_string(state_path()) {
        Ok(s) => print!("daemon: {s}"),
        Err(_) => println!("daemon: no está corriendo (systemctl --user status x1sound)"),
    }
    match config::load() {
        Ok(c) => {
            print!("config ({}):\n{}", config::path().display(), json::to_string(&c.to_json()));
            let bands: Vec<String> = config::EQ_FREQS.iter().zip(c.eq).map(|(f, g)| {
                let f = if *f >= 1000 { format!("{}k", f / 1000) } else { f.to_string() };
                format!("{f}:{g:+}")
            }).collect();
            println!("eq (Hz:dB): {}", bands.join("  "));
        }
        Err(e) => println!("config ilegible: {e}"),
    }
    0
}

struct Check {
    ok: bool,
    msg: String,
}

fn checks() -> Vec<Check> {
    let mut v = Vec::new();
    let mut add = |ok: bool, msg: String| v.push(Check { ok, msg });
    let filters = sys::filters_on_speaker();
    add(
        filters == [sys::FILTER],
        format!("filtros en los altavoces: {:?} (debe haber solo {})", filters, sys::FILTER),
    );
    let id = sys::node_id(sys::FILTER);
    add(id.is_some(), format!("nodo {}: {:?}", sys::FILTER, id));
    if let Some(id) = id {
        let p = sys::read_params(id);
        let eqk: Vec<String> = (1..=config::EQ_BANDS).flat_map(|i| [format!("eq{i}_l:Gain"), format!("eq{i}_r:Gain")]).collect();
        let missing: Vec<String> = policy::WHITELIST.iter().chain(policy::VOICE.iter()).map(|k| k.to_string())
            .chain(eqk).filter(|k| !p.contains_key(k)).collect();
        add(missing.is_empty(), format!("controles escribibles presentes (faltan: {missing:?})"));
    }
    let r = sys::routing();
    add(r != sys::Routing::Unsafe && r != sys::Routing::Unknown, format!("ruta del codec: {r:?}"));
    if r == sys::Routing::Split {
        let c = config::load().unwrap_or_default();
        let (d1, d2) = (sys::ctl_get("DAC1 Playback Volume"), sys::ctl_get("DAC2 Playback Volume"));
        add(d1 == Some(c.tweeter) && d2 == Some(c.woofer), format!("DAC1 {d1:?} / DAC2 {d2:?} (config {} / {})", c.tweeter, c.woofer));
    }
    match config::load() {
        Ok(_) => add(true, format!("config válida: {}", config::path().display())),
        Err(e) => add(false, format!("config ilegible: {e}")),
    }
    v
}

fn doctor() -> i32 {
    let cs = checks();
    for c in &cs {
        println!("{} {}", if c.ok { "ok  " } else { "FALLA" }, c.msg);
    }
    if cs.iter().all(|c| c.ok) { 0 } else { 1 }
}

fn mtime(p: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn daemon() -> i32 {
    let cfg_path = config::path();
    let mut cfg = config::load().unwrap_or_else(|e| {
        eprintln!("config ilegible al arrancar ({e}); valores por defecto");
        Config::default()
    });
    let mut cfg_mtime = mtime(&cfg_path);
    let mut id: Option<u32> = None;
    let mut applied: BTreeMap<String, f64> = BTreeMap::new();
    let mut vol: Option<(f64, bool)> = sys::sink_volume();
    let (mut last_vol, mut last_cfg, mut last_dac, mut last_state, mut last_id) =
        (Instant::now(), Instant::now(), Instant::now() - Duration::from_secs(60), Instant::now() - Duration::from_secs(60), Instant::now() - Duration::from_secs(60));
    let mut health = String::from("starting");
    let mut routing = sys::routing();
    let mut hp = sys::headphones();
    let mut prev_state = String::new();
    eprintln!("x1sound daemon: config {}", cfg_path.display());

    loop {
        let now = Instant::now();

        // config: cambios del panel o de la CLI
        if now - last_cfg >= Duration::from_millis(300) {
            last_cfg = now;
            let m = mtime(&cfg_path);
            if m != cfg_mtime {
                cfg_mtime = m;
                match config::load() {
                    Ok(c) => {
                        if c != cfg {
                            eprintln!("config: {}", json::to_string(&c.to_json()).replace('\n', " "));
                        }
                        cfg = c;
                        last_dac = Instant::now() - Duration::from_secs(60); // aplicar DAC ya
                    }
                    Err(e) => eprintln!("config ilegible ({e}); se mantiene la anterior"),
                }
            }
        }

        // nodo del filtro (cambia de id si PipeWire se reinicia)
        if id.is_none() && now - last_id >= Duration::from_secs(2) {
            last_id = now;
            id = sys::node_id(sys::FILTER);
            if let Some(i) = id {
                applied = sys::read_params(i).into_iter().filter(|(k, _)| policy::allowed(k)).collect();
                eprintln!("filtro {} en id {i}", sys::FILTER);
            } else {
                health = format!("waiting: no está {}", sys::FILTER);
            }
        }

        // volumen: solo hace falta para el loudness (cada 400 ms)
        if cfg.loudness && cfg.enabled && now - last_vol >= Duration::from_millis(400) {
            last_vol = now;
            vol = sys::sink_volume();
        }

        // parámetros: objetivo de la política + rampa
        if let Some(i) = id {
            let t = policy::target(&cfg, vol.map(|v| v.0));
            let mut changes = Vec::new();
            for (k, tv) in &t.params {
                // sin valor conocido: se escribe el objetivo directamente; si no, rampa asimétrica
                match applied.get(k) {
                    Some(cur) if (cur - tv).abs() <= 1e-3 => {}
                    Some(cur) => changes.push((k.clone(), policy::ramp(*cur, *tv, k, RAMP_DB))),
                    None => changes.push((k.clone(), *tv)),
                }
            }
            if !changes.is_empty() {
                if sys::write_params(i, &changes) {
                    for (k, v) in changes {
                        applied.insert(k, v);
                    }
                } else {
                    eprintln!("pw-cli falló: se vuelve a buscar el filtro");
                    id = None;
                    applied.clear();
                }
            }
            if id.is_some() {
                health = "ok".into();
            }
            // estado para el panel de glyph (como mucho cada segundo y solo si cambia)
            if now - last_state >= Duration::from_secs(1) {
                last_state = now;
                let mut m = BTreeMap::new();
                m.insert("health".into(), Json::Str(health.clone()));
                m.insert("routing".into(), Json::Str(format!("{routing:?}").to_lowercase()));
                m.insert("profile".into(), Json::Str(cfg.profile.clone()));
                m.insert("volume".into(), vol.map(|v| Json::Num(v.0)).unwrap_or(Json::Null));
                m.insert("loud_bass".into(), Json::Num(t.loud_bass));
                m.insert("budget_db".into(), Json::Num(t.budget_used));
                m.insert("bass".into(), Json::Num(t.params["bass_l:Gain"]));
                m.insert("treble".into(), Json::Num(t.params["treble_l:Gain"]));
                m.insert("voice".into(), Json::Num(t.params["voice_l:Gain"]));
                m.insert("gain_db".into(), Json::Num((20.0 * t.params["reg:g_in"].log10() * 10.0).round() / 10.0));
                m.insert("dolby".into(), Json::Bool(t.params["mix_l:Gain 1"] > 0.5));
                m.insert("headphones".into(), Json::Bool(hp));
                let s = json::to_string(&Json::Obj(m));
                if s != prev_state {
                    let p = state_path();
                    if let Some(d) = p.parent() {
                        let _ = std::fs::create_dir_all(d);
                    }
                    let tmp = p.with_extension("tmp");
                    if std::fs::write(&tmp, &s).is_ok() {
                        let _ = std::fs::rename(&tmp, &p);
                    }
                    prev_state = s;
                }
            }
        }

        // DAC del codec: cada 3 s (o al cambiar la config). Nunca en una ruta insegura
        if now - last_dac >= Duration::from_secs(3) {
            last_dac = now;
            routing = sys::routing();
            hp = sys::headphones();
            match routing {
                sys::Routing::Split => {
                    set_dac("DAC1 Playback Volume", cfg.tweeter);
                    set_dac("DAC2 Playback Volume", cfg.woofer);
                }
                sys::Routing::Unsafe => health = "unsafe: los woofers pueden ir al DAC 0x06 sin volumen".into(),
                _ => {}
            }
        }

        std::thread::sleep(TICK);
    }
}
