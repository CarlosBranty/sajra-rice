//! Presets de ecualización: ~/.config/x1sound/eq-presets.json, una lista ordenada [{ "name": …, "eq": [8 dB] }].
//! La comparten la CLI (`x1sound eq <nombre>`) y el panel de glyph. Si falta, se escribe con los de serie; los que el
//! usuario añada se conservan. Bandas: 125 250 500 1k 2k 4k 8k 16k Hz, ±6 dB (se recortan al aplicar).

use crate::config::{self, EQ_BANDS};
use crate::json::{self, Json};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Pensados para estos altavoces: por debajo de 100 Hz no hay nada (HP de Dolby), así que la banda de 125 Hz es
/// "el grave" y los realces de grave son moderados; la claridad está en 2–4 kHz (tweeters).
pub const BUILTIN: [(&str, [f64; EQ_BANDS]); 10] = [
    ("flat", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    ("bass", [5.0, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    ("rock", [4.0, 3.0, -1.0, -2.0, 0.0, 2.0, 3.0, 3.0]),
    ("pop", [-1.0, 1.0, 3.0, 3.0, 1.0, -1.0, 0.0, 0.0]),
    ("electronic", [5.0, 4.0, 0.0, -2.0, 0.0, 1.0, 3.0, 4.0]),
    ("hip-hop", [5.0, 4.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0]),
    ("jazz", [3.0, 2.0, 0.0, 1.0, -1.0, 1.0, 2.0, 3.0]),
    ("acoustic", [3.0, 2.0, 1.0, 1.0, 2.0, 2.0, 3.0, 2.0]),
    ("vocal", [-2.0, -1.0, 0.0, 2.0, 4.0, 3.0, 1.0, 0.0]),
    ("clarity", [0.0, -1.0, -2.0, -1.0, 1.0, 3.0, 2.0, 1.0]),
];

pub fn path() -> PathBuf {
    config::dir().join("eq-presets.json")
}

fn to_json(list: &[(String, [f64; EQ_BANDS])]) -> Json {
    Json::Arr(
        list.iter()
            .map(|(n, e)| {
                let mut m = BTreeMap::new();
                m.insert("name".into(), Json::Str(n.clone()));
                m.insert("eq".into(), Json::Arr(e.iter().map(|x| Json::Num(*x)).collect()));
                Json::Obj(m)
            })
            .collect(),
    )
}

pub fn parse(j: &Json) -> Vec<(String, [f64; EQ_BANDS])> {
    let Json::Arr(a) = j else { return vec![] };
    a.iter()
        .filter_map(|p| {
            let name = p.get("name")?.as_str()?.trim().to_string();
            let Json::Arr(v) = p.get("eq")? else { return None };
            if name.is_empty() || v.len() != EQ_BANDS {
                return None;
            }
            let mut e = [0.0; EQ_BANDS];
            for (i, x) in v.iter().enumerate() {
                e[i] = x.as_f64()?.clamp(config::EQ.0, config::EQ.1);
            }
            Some((name, e))
        })
        .collect()
}

/// Lista de presets. Falta el archivo: se crea con los de serie. Ilegible: los de serie (sin tocar el archivo).
pub fn load() -> Vec<(String, [f64; EQ_BANDS])> {
    let builtin = || BUILTIN.iter().map(|(n, e)| (n.to_string(), *e)).collect::<Vec<_>>();
    match std::fs::read_to_string(path()) {
        Ok(t) => match json::parse(&t).map(|j| parse(&j)) {
            Ok(l) if !l.is_empty() => l,
            _ => builtin(),
        },
        Err(_) => {
            let l = builtin();
            let _ = std::fs::create_dir_all(config::dir());
            let _ = std::fs::write(path(), json::to_string(&to_json(&l)));
            l
        }
    }
}

/// Nombre del preset que coincide con `eq` (para mostrar cuál está puesto), o None si es una EQ a mano.
pub fn matching(list: &[(String, [f64; EQ_BANDS])], eq: &[f64; EQ_BANDS]) -> Option<String> {
    list.iter().find(|(_, e)| e.iter().zip(eq).all(|(a, b)| (a - b).abs() < 0.01)).map(|(n, _)| n.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builtin_roundtrip_and_limits() {
        let l: Vec<_> = BUILTIN.iter().map(|(n, e)| (n.to_string(), *e)).collect();
        assert_eq!(parse(&json::parse(&json::to_string(&to_json(&l))).unwrap()), l);
        for (n, e) in &BUILTIN {
            assert!(e.iter().all(|x| (config::EQ.0..=config::EQ.1).contains(x)), "{n}");
        }
    }
    #[test]
    fn bad_entries_skipped_and_clamped() {
        let j = json::parse(r#"[{"name": "ok", "eq": [9,0,0,0,0,0,0,-9]}, {"name": "short", "eq": [1]}, {"eq": [0,0,0,0,0,0,0,0]}, 5]"#).unwrap();
        let l = parse(&j);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].1[0], 6.0);
        assert_eq!(l[0].1[7], -6.0);
    }
    #[test]
    fn match_by_value() {
        let l: Vec<_> = BUILTIN.iter().map(|(n, e)| (n.to_string(), *e)).collect();
        assert_eq!(matching(&l, &BUILTIN[2].1).as_deref(), Some("rock"));
        assert_eq!(matching(&l, &[1.0; EQ_BANDS]), None);
    }
}
