//! Política: función PURA (config, volumen) → parámetros objetivo de la cadena x1sound.conf.
//! Reglas de seguridad:
//!  - toda ganancia positiva va antes del regulador y del limitador Dolby (lo garantiza la conf);
//!  - el limitador, el HP de 100 Hz y el FIR nunca se escriben (no están en la whitelist);
//!  - presupuesto: graves + agudos + voz + loudness positivos ≤ BUDGET_DB.

use crate::config::{self, Config};
use std::collections::BTreeMap;

/// suma máxima de realces de ecualización positivos (dB)
pub const BUDGET_DB: f64 = 14.0;
/// por encima de este volumen (dB, 0 = máximo) el loudness no actúa
pub const LOUD_REF_DB: f64 = -10.0;
pub const LOUD_MAX_BASS: f64 = 6.0;

/// Controles que x1sound puede escribir. Nada más pasa a pw-cli.
pub const WHITELIST: [&str; 9] = [
    "mix_l:Gain 1", "mix_l:Gain 2", "mix_r:Gain 1", "mix_r:Gain 2",
    "bass_l:Gain", "bass_r:Gain", "treble_l:Gain", "treble_r:Gain", "reg:g_in",
];
pub const VOICE: [&str; 2] = ["voice_l:Gain", "voice_r:Gain"];

pub fn allowed(k: &str) -> bool {
    WHITELIST.contains(&k) || VOICE.contains(&k) || is_eq(k)
}

/// "eq1_l:Gain" … "eq8_r:Gain"
pub fn is_eq(k: &str) -> bool {
    let Some(rest) = k.strip_prefix("eq").and_then(|r| r.strip_suffix(":Gain")) else { return false };
    let (n, ch) = rest.split_at(rest.len().saturating_sub(2));
    matches!(ch, "_l" | "_r") && n.parse::<usize>().is_ok_and(|i| (1..=config::EQ_BANDS).contains(&i))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub params: BTreeMap<String, f64>,
    /// realce de loudness aplicado (para el estado)
    pub loud_bass: f64,
    pub budget_used: f64,
}

/// Volumen de wpctl (0..1.5, escala cúbica) → dB. 0 → -inf (se usa -90).
pub fn vol_db(v: f64) -> f64 {
    if v <= 0.0 { -90.0 } else { 60.0 * v.log10() }
}

pub fn target(c: &Config, vol: Option<f64>) -> Target {
    // perfil → deltas. off = señal seca (sin corrección Dolby) con la protección intacta
    let (ao, dry, mut bass, mut treble, mut voice, mut boost) = match c.profile.as_str() {
        "off" => (0.0, 1.0, 0.0, 0.0, 0.0, 6.0),
        // music: realce en V (graves y agudos); voice: menos graves, presencia de voz a 2.5 kHz y algo de aire
        "music" => (1.0, 0.0, c.bass_db + 3.0, c.treble_db + 3.0, 0.0, c.boost_db),
        "voice" => (1.0, 0.0, c.bass_db - 6.0, c.treble_db + 1.0, 6.0, c.boost_db),
        _ => (1.0, 0.0, c.bass_db, c.treble_db, 0.0, c.boost_db),
    };
    if !c.enabled {
        // desactivado = cadena neutra en el grafo (los mismos valores que el perfil off)
        return target(&Config { enabled: true, profile: "off".into(), ..c.clone() }, None);
    }

    // loudness: por debajo de LOUD_REF_DB, realce de graves proporcional (y la mitad en agudos)
    let mut loud_bass = 0.0;
    if c.loudness && c.profile != "off" {
        if let Some(v) = vol {
            let below = (LOUD_REF_DB - vol_db(v)).max(0.0);
            loud_bass = (c.loudness_amount * below / 10.0 * 3.0).min(LOUD_MAX_BASS);
        }
    }
    bass += loud_bass;
    treble += loud_bass / 2.0;

    // límites por etapa antes del presupuesto (el presupuesto se mide sobre lo que de verdad se escribe)
    bass = bass.clamp(config::BASS.0, config::BASS.1);
    treble = treble.clamp(config::TREBLE.0, config::TREBLE.1);

    // presupuesto de realces positivos: se recorta primero el loudness, luego agudos, graves y voz.
    // En pasos de 0.05 dB recalculando siempre la suma real de lo positivo (los negativos no cuentan ni descuentan).
    let pos = |x: f64| x.max(0.0);
    // el ecualizador cuenta por su banda más alta (las bandas no se solapan mucho: octavas, Q 1.41)
    let mut eq = if c.profile == "off" { [0.0; config::EQ_BANDS] } else { c.eq.map(|x| x.clamp(config::EQ.0, config::EQ.1)) };
    let eq_max = |e: &[f64; config::EQ_BANDS]| e.iter().copied().fold(0.0, f64::max);
    let over = |b: f64, t: f64, v: f64, e: &[f64; config::EQ_BANDS]| pos(b) + pos(t) + pos(v) + eq_max(e) - BUDGET_DB;
    const STEP: f64 = 0.05;
    let mut guard = 0;
    while over(bass, treble, voice, &eq) > 1e-9 && guard < 2000 {
        guard += 1;
        if loud_bass > 1e-9 {
            let s = STEP.min(loud_bass);
            loud_bass -= s;
            bass -= s;
            treble -= s / 2.0;
        } else if treble > 1e-9 {
            treble -= STEP.min(treble);
        } else if bass > 1e-9 {
            bass -= STEP.min(bass);
        } else if voice > 1e-9 {
            voice -= STEP.min(voice);
        } else if eq_max(&eq) > 1e-9 {
            let m = eq_max(&eq);
            for x in eq.iter_mut() {
                if *x >= m - 1e-9 {
                    *x -= STEP.min(*x);
                }
            }
        } else {
            break;
        }
    }
    // el redondeo a 2 decimales no debe empujar por encima del presupuesto
    let floor2 = |x: f64| if x > 0.0 { (x * 100.0).floor() / 100.0 } else { x };
    bass = floor2(bass);
    treble = floor2(treble);
    voice = floor2(voice);
    boost = boost.clamp(config::BOOST.0, config::BOOST.1);

    let mut p = BTreeMap::new();
    for ch in ["l", "r"] {
        p.insert(format!("mix_{ch}:Gain 1"), ao);
        p.insert(format!("mix_{ch}:Gain 2"), dry);
        p.insert(format!("bass_{ch}:Gain"), round2(bass));
        p.insert(format!("treble_{ch}:Gain"), round2(treble));
        p.insert(format!("voice_{ch}:Gain"), round2(voice));
        for (i, g) in eq.iter().enumerate() {
            p.insert(format!("eq{}_{ch}:Gain", i + 1), floor2(*g));
        }
    }
    p.insert("reg:g_in".into(), round4(10f64.powf(boost / 20.0)));
    let budget_used = pos(bass) + pos(treble) + pos(voice) + eq_max(&eq.map(floor2));
    Target { params: p, loud_bass: round2(loud_bass), budget_used: round2(budget_used) }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

/// Rampa asimétrica de un paso: bajar realces es inmediato (protege), subirlos va de a `step` dB por tick.
pub fn ramp(cur: f64, tgt: f64, key: &str, step: f64) -> f64 {
    let gain_db = key.ends_with(":Gain") && !key.starts_with("mix_");
    if !gain_db || tgt <= cur {
        return tgt;
    }
    (cur + step).min(tgt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(profile: &str, bass: f64, treble: f64, loud: bool) -> Config {
        Config { profile: profile.into(), bass_db: bass, treble_db: treble, loudness: loud, loudness_amount: 1.0, ..Config::default() }
    }

    #[test]
    fn every_written_key_is_whitelisted() {
        for p in crate::config::PROFILES {
            for k in target(&cfg(p, 6.0, 2.0, true), Some(0.1)).params.keys() {
                assert!(allowed(k), "{k}");
                assert!(!k.starts_with("limiter") && !k.starts_with("peq") && !k.starts_with("conv"), "{k}");
            }
        }
    }

    #[test]
    fn budget_never_exceeded_grid() {
        for p in crate::config::PROFILES {
            for b in [-6.0, 0.0, 6.0, 12.0] {
                for t in [-6.0, 0.0, 4.0, 8.0] {
                    for loud in [false, true] {
                        for v in [0.0, 0.05, 0.2, 0.5, 1.0] {
                          for e in [0.0, 3.0, 6.0] {
                            let mut c = cfg(p, b, t, loud);
                            c.eq = [e, -3.0, e, 0.0, 6.0, e, 2.0, e];
                            let tg = target(&c, Some(v));
                            assert!(tg.budget_used <= BUDGET_DB + 0.01, "{p} {b} {t} {loud} {v}: {}", tg.budget_used);
                            let g = tg.params["reg:g_in"];
                            assert!(g <= 10f64.powf(config::BOOST.1 / 20.0) + 1e-3);
                          }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn off_is_dry_and_flat_but_keeps_chain() {
        let t = target(&cfg("off", 10.0, 5.0, true), Some(0.05));
        assert_eq!(t.params["mix_l:Gain 1"], 0.0);
        assert_eq!(t.params["mix_l:Gain 2"], 1.0);
        assert_eq!(t.params["bass_l:Gain"], 0.0);
        assert_eq!(t.loud_bass, 0.0);
    }

    #[test]
    fn disabled_equals_off() {
        let mut c = cfg("music", 8.0, 3.0, true);
        c.enabled = false;
        assert_eq!(target(&c, Some(0.1)).params, target(&cfg("off", 0.0, 0.0, false), None).params);
    }

    #[test]
    fn loudness_only_below_reference() {
        let c = cfg("dynamic", 0.0, 0.0, true);
        assert_eq!(target(&c, Some(1.0)).loud_bass, 0.0); // 0 dB
        assert_eq!(target(&c, Some(0.7)).loud_bass, 0.0); // -9.3 dB
        assert!(target(&c, Some(0.3)).loud_bass > 0.0); // -31 dB
        assert!(target(&c, Some(0.01)).loud_bass <= LOUD_MAX_BASS);
    }

    #[test]
    fn eq_keys() {
        assert!(allowed("eq1_l:Gain") && allowed("eq8_r:Gain"));
        assert!(!allowed("eq9_l:Gain") && !allowed("eq0_l:Gain") && !allowed("eq1_x:Gain") && !allowed("eq1_l:Freq"));
        let mut c = cfg("dynamic", 0.0, 0.0, false);
        c.eq = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, -1.0, -2.0];
        let t = target(&c, None);
        assert_eq!(t.params["eq6_r:Gain"], 6.0);
        assert_eq!(t.params["eq8_l:Gain"], -2.0);
        assert_eq!(target(&cfg("off", 0.0, 0.0, false), None).params["eq3_l:Gain"], 0.0);
    }

    #[test]
    fn ramp_is_asymmetric() {
        assert_eq!(ramp(6.0, 2.0, "bass_l:Gain", 1.0), 2.0); // bajar: inmediato
        assert_eq!(ramp(2.0, 6.0, "bass_l:Gain", 1.0), 3.0); // subir: un paso
        assert_eq!(ramp(1.0, 0.0, "mix_l:Gain 1", 0.1), 0.0);
        assert_eq!(ramp(0.0, 1.0, "mix_l:Gain 1", 0.1), 1.0); // el mezclador conmuta directo
        assert_eq!(ramp(2.0, 7.9, "reg:g_in", 1.0), 7.9);
    }

    #[test]
    fn vol_db_cubic() {
        assert!((vol_db(1.0)).abs() < 1e-9);
        assert!((vol_db(0.5) + 18.06).abs() < 0.01);
        assert_eq!(vol_db(0.0), -90.0);
    }
}
