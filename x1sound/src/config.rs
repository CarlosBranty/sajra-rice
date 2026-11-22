//! Configuración de x1sound: ~/.config/x1sound/config.json. La escriben el panel de glyph y la CLI; el daemon la lee.
//! Todos los valores se recortan a límites duros al leer: un JSON editado a mano no puede saltarse la protección.

use crate::json::{self, Json};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const PROFILES: [&str; 4] = ["dynamic", "music", "voice", "off"];

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub enabled: bool,
    /// dynamic | music | voice | off (ver policy.rs)
    pub profile: String,
    /// realce de graves (low-shelf 150 Hz), dB
    pub bass_db: f64,
    /// realce de agudos (high-shelf 6 kHz), dB
    pub treble_db: f64,
    /// ganancia de entrada del regulador Dolby (volmax), dB. +10 = el máximo sin compresión audible (medido)
    pub boost_db: f64,
    /// loudness: a volumen bajo realza graves (y agudos a la mitad), como el ecualizador dependiente del volumen de Dolby
    pub loudness: bool,
    /// intensidad del loudness, dB de realce por cada 10 dB por debajo de la referencia
    pub loudness_amount: f64,
    /// DAC1 (tweeters, arriba) 0..87; 87 = 0 dB, paso 0.75 dB
    pub tweeter: i64,
    /// DAC2 (woofers, abajo; lo comparten los auriculares) 0..87
    pub woofer: i64,
    /// ecualizador gráfico, dB por banda: 125 250 500 1k 2k 4k 8k 16k Hz
    pub eq: [f64; EQ_BANDS],
}

pub const EQ_BANDS: usize = 8;
pub const EQ_FREQS: [u32; EQ_BANDS] = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];
pub const EQ: (f64, f64) = (-6.0, 6.0);

// límites duros
pub const BASS: (f64, f64) = (-6.0, 12.0);
pub const TREBLE: (f64, f64) = (-6.0, 8.0);
pub const BOOST: (f64, f64) = (0.0, 20.0);
pub const LOUD_AMOUNT: (f64, f64) = (0.0, 1.0);
pub const DAC: (i64, i64) = (40, 87);

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: true,
            profile: "dynamic".into(),
            bass_db: 6.0,
            treble_db: 0.0,
            boost_db: 10.0,
            loudness: false,
            loudness_amount: 0.4,
            tweeter: 87,
            woofer: 87,
            eq: [0.0; EQ_BANDS],
        }
    }
}

fn clampf(v: f64, (lo, hi): (f64, f64)) -> f64 {
    if v.is_nan() {
        lo.max(0.0).min(hi)
    } else {
        v.clamp(lo, hi)
    }
}

impl Config {
    pub fn from_json(j: &Json) -> Config {
        let d = Config::default();
        let f = |k: &str, def: f64| j.get(k).and_then(Json::as_f64).unwrap_or(def);
        let b = |k: &str, def: bool| j.get(k).and_then(Json::as_bool).unwrap_or(def);
        let profile = j
            .get("profile")
            .and_then(Json::as_str)
            .filter(|p| PROFILES.contains(p))
            .unwrap_or(&d.profile)
            .to_string();
        Config {
            enabled: b("enabled", d.enabled),
            profile,
            bass_db: clampf(f("bass_db", d.bass_db), BASS),
            treble_db: clampf(f("treble_db", d.treble_db), TREBLE),
            boost_db: clampf(f("boost_db", d.boost_db), BOOST),
            loudness: b("loudness", d.loudness),
            loudness_amount: clampf(f("loudness_amount", d.loudness_amount), LOUD_AMOUNT),
            tweeter: (f("tweeter", d.tweeter as f64).round() as i64).clamp(DAC.0, DAC.1),
            woofer: (f("woofer", d.woofer as f64).round() as i64).clamp(DAC.0, DAC.1),
            eq: {
                let mut e = d.eq;
                if let Some(Json::Arr(a)) = j.get("eq") {
                    for (i, v) in a.iter().take(EQ_BANDS).enumerate() {
                        e[i] = clampf(v.as_f64().unwrap_or(0.0), EQ);
                    }
                }
                e
            },
        }
    }

    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("enabled".into(), Json::Bool(self.enabled));
        m.insert("profile".into(), Json::Str(self.profile.clone()));
        m.insert("bass_db".into(), Json::Num(self.bass_db));
        m.insert("treble_db".into(), Json::Num(self.treble_db));
        m.insert("boost_db".into(), Json::Num(self.boost_db));
        m.insert("loudness".into(), Json::Bool(self.loudness));
        m.insert("loudness_amount".into(), Json::Num(self.loudness_amount));
        m.insert("tweeter".into(), Json::Num(self.tweeter as f64));
        m.insert("woofer".into(), Json::Num(self.woofer as f64));
        m.insert("eq".into(), Json::Arr(self.eq.iter().map(|v| Json::Num(*v)).collect()));
        Json::Obj(m)
    }

    /// Cambia una clave desde la CLI ("set bass_db 7"); el valor pasa por los mismos límites.
    pub fn set(&mut self, k: &str, v: &str) -> Result<(), String> {
        let mut j = self.to_json();
        let val = match k {
            "enabled" | "loudness" => Json::Bool(matches!(v, "true" | "on" | "1" | "yes")),
            "profile" => {
                if !PROFILES.contains(&v) {
                    return Err(format!("perfil desconocido '{v}' (usa: {})", PROFILES.join(", ")));
                }
                Json::Str(v.into())
            }
            // "set eq 1,0,-2,0,0,3,2,0" (8 valores) o "set eq3 -2" (una banda, 1..8)
            "eq" => Json::Arr(
                v.split(',').map(|x| x.trim().parse::<f64>().map(Json::Num).map_err(|_| format!("'{x}' no es un número")))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            k if k.len() == 3 && k.starts_with("eq") => {
                let i: usize = k[2..].parse().map_err(|_| format!("banda inválida '{k}'"))?;
                if !(1..=EQ_BANDS).contains(&i) {
                    return Err(format!("banda {i} fuera de 1..{EQ_BANDS}"));
                }
                let x: f64 = v.parse().map_err(|_| format!("'{v}' no es un número"))?;
                let mut e = self.eq;
                e[i - 1] = x;
                return self.set("eq", &e.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
            }
            "bass_db" | "treble_db" | "boost_db" | "loudness_amount" | "tweeter" | "woofer" => {
                Json::Num(v.parse::<f64>().map_err(|_| format!("'{v}' no es un número"))?)
            }
            _ => return Err(format!("clave desconocida '{k}'")),
        };
        if let Json::Obj(m) = &mut j {
            m.insert(k.into(), val);
        }
        *self = Config::from_json(&j);
        Ok(())
    }
}

pub fn dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"))
        .join("x1sound")
}

pub fn path() -> PathBuf {
    dir().join("config.json")
}

/// Lee la config. Si falta: valores por defecto (y se escribe para que el panel la encuentre).
/// Si está corrupta: Err, y el daemon mantiene la última válida.
pub fn load() -> Result<Config, String> {
    match std::fs::read_to_string(path()) {
        Ok(t) => json::parse(&t).map(|j| Config::from_json(&j)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let c = Config::default();
            let _ = save(&c);
            Ok(c)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Escritura atómica (tmp + rename): el daemon nunca lee un archivo a medias.
pub fn save(c: &Config) -> Result<(), String> {
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let tmp = dir().join(".config.json.tmp");
    std::fs::write(&tmp, json::to_string(&c.to_json())).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clamps_hostile_values() {
        let j = json::parse(r#"{"bass_db": 99, "treble_db": -40, "boost_db": 300, "tweeter": 200, "woofer": -5,
            "profile": "rm -rf", "loudness_amount": 7}"#)
        .unwrap();
        let c = Config::from_json(&j);
        assert_eq!(c.bass_db, BASS.1);
        assert_eq!(c.treble_db, TREBLE.0);
        assert_eq!(c.boost_db, BOOST.1);
        assert_eq!(c.tweeter, 87);
        assert_eq!(c.woofer, DAC.0);
        assert_eq!(c.profile, "dynamic");
        assert_eq!(c.loudness_amount, 1.0);
    }
    #[test]
    fn missing_keys_use_defaults() {
        let c = Config::from_json(&json::parse("{}").unwrap());
        assert_eq!(c, Config::default());
    }
    #[test]
    fn set_and_roundtrip() {
        let mut c = Config::default();
        c.set("bass_db", "7.5").unwrap();
        c.set("profile", "voice").unwrap();
        c.set("eq", "1,2,3,4,5,6,7,99").unwrap();
        assert_eq!(c.eq[7], EQ.1);
        c.set("eq3", "-2").unwrap();
        assert_eq!(c.eq[2], -2.0);
        assert!(c.set("eq9", "1").is_err());
        assert!(c.set("profile", "loud").is_err());
        assert!(c.set("nope", "1").is_err());
        let back = Config::from_json(&json::parse(&json::to_string(&c.to_json())).unwrap());
        assert_eq!(back, c);
    }
}
