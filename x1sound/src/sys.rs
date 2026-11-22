//! Acceso al sistema: PipeWire (pw-cli, wpctl) y ALSA (amixer, /proc/asound). Solo procesos y archivos; sin libs.

use std::collections::BTreeMap;
use std::process::{Command, Stdio};

pub const FILTER: &str = "effect_input.x1sound";

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// id del nodo `name` en `pw-cli ls Node` ("\tid 38, type ..." seguido de sus props).
pub fn node_id(name: &str) -> Option<u32> {
    parse_node_id(&run("pw-cli", &["ls", "Node"])?, name)
}

pub fn parse_node_id(ls: &str, name: &str) -> Option<u32> {
    let mut cur: Option<u32> = None;
    let want = format!("node.name = \"{name}\"");
    for line in ls.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("id ") {
            cur = rest.split(',').next().and_then(|n| n.trim().parse().ok());
        } else if t == want {
            return cur;
        }
    }
    None
}

/// Lee los Props actuales del filtro: nombre de control → valor.
pub fn read_params(id: u32) -> BTreeMap<String, f64> {
    run("pw-cli", &["enum-params", &id.to_string(), "Props"]).map(|t| parse_params(&t)).unwrap_or_default()
}

pub fn parse_params(t: &str) -> BTreeMap<String, f64> {
    let mut m = BTreeMap::new();
    let mut key: Option<String> = None;
    for line in t.lines() {
        let l = line.trim();
        if let Some(s) = l.strip_prefix("String \"") {
            key = s.strip_suffix('"').map(str::to_string);
        } else if let Some(k) = key.take() {
            let v = l.strip_prefix("Float ").or_else(|| l.strip_prefix("Double ")).or_else(|| l.strip_prefix("Int "));
            if let Some(v) = v.and_then(|v| v.trim().parse::<f64>().ok()) {
                m.insert(k, v);
            }
        }
    }
    m
}

/// Escribe controles con una sola llamada a pw-cli. Solo claves de la whitelist (policy::allowed).
pub fn write_params(id: u32, params: &[(String, f64)]) -> bool {
    let body: Vec<String> = params
        .iter()
        .filter(|(k, v)| crate::policy::allowed(k) && v.is_finite())
        .map(|(k, v)| format!("\"{k}\" {v}"))
        .collect();
    if body.is_empty() {
        return true;
    }
    let arg = format!("{{ params = [ {} ] }}", body.join(" "));
    run("pw-cli", &["s", &id.to_string(), "Props", &arg]).is_some()
}

/// Volumen del sink por defecto (wpctl: "Volume: 0.55" o "Volume: 0.55 [MUTED]") → (volumen, mute).
pub fn sink_volume() -> Option<(f64, bool)> {
    parse_volume(&run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"])?)
}

pub fn parse_volume(t: &str) -> Option<(f64, bool)> {
    let v = t.trim().strip_prefix("Volume: ")?;
    let n = v.split_whitespace().next()?.parse().ok()?;
    Some((n, v.contains("[MUTED]")))
}

/// ¿Está la tarjeta en la ruta dividida (DAC1/DAC2) y los woofers lejos del DAC 0x06 sin volumen?
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Routing {
    /// tweeters y woofers en DACs separados con volumen (configuración de fábrica X1)
    Split,
    /// los dos pares en el mismo DAC (fixup yoga9): no hay balance
    Shared,
    /// 0x17 puede alcanzar o tiene seleccionado el DAC 0x06 (sin volumen): no tocar nada
    Unsafe,
    Unknown,
}

pub fn routing() -> Routing {
    match std::fs::read_to_string("/proc/asound/card0/codec#0") {
        Ok(t) => parse_routing(&t, has_ctl("DAC2 Playback Volume")),
        Err(_) => Routing::Unknown,
    }
}

pub fn parse_routing(codec: &str, has_dac2: bool) -> Routing {
    let Some(start) = codec.find("Node 0x17 ") else { return Routing::Unknown };
    let block = &codec[start..];
    let block = &block[..block[1..].find("\nNode ").map(|i| i + 1).unwrap_or(block.len())];
    // la lista que usa el driver ("In-driver Connection") manda; si no existe, la de hardware
    let lines: Vec<&str> = block.lines().collect();
    let conn = |label: &str| -> Option<String> {
        let i = lines.iter().position(|l| l.trim_start().starts_with(label))?;
        lines.get(i + 1).map(|s| s.trim().to_string())
    };
    let hw = conn("Connection:").unwrap_or_default();
    let drv = conn("In-driver Connection:");
    let selected = hw.split_whitespace().find(|t| t.ends_with('*')).map(|t| t.trim_end_matches('*').to_string());
    let reachable = drv.clone().unwrap_or_else(|| hw.replace('*', ""));
    if selected.as_deref() == Some("0x06") || (drv.is_some() && reachable.split_whitespace().any(|t| t == "0x06")) {
        return Routing::Unsafe;
    }
    match selected.as_deref() {
        Some("0x03") if has_dac2 => Routing::Split,
        Some("0x02") => Routing::Shared,
        _ => Routing::Unknown,
    }
}

pub fn has_ctl(name: &str) -> bool {
    run("amixer", &["-c0", "cget", &format!("name={name}")]).is_some()
}

/// Valor entero de un control ALSA ("  : values=87,87").
pub fn ctl_get(name: &str) -> Option<i64> {
    let t = run("amixer", &["-c0", "cget", &format!("name={name}")])?;
    t.lines()
        .find_map(|l| l.trim().strip_prefix(": values="))
        .and_then(|v| v.split(',').next())
        .and_then(|v| v.parse().ok())
}

pub fn ctl_set(name: &str, v: i64) -> bool {
    run("amixer", &["-c0", "-q", "cset", &format!("name={name}"), &v.to_string()]).is_some()
}

/// ¿Auriculares enchufados? ('Headphone Jack' = on)
pub fn headphones() -> bool {
    run("amixer", &["-c0", "cget", "name=Headphone Jack"])
        .map(|t| t.lines().any(|l| l.trim() == ": values=on"))
        .unwrap_or(false)
}

/// Cuántos smart filters apuntan al sink de los altavoces (debe ser exactamente 1: x1sound).
pub fn filters_on_speaker() -> Vec<String> {
    let Some(t) = run("pw-cli", &["ls", "Node"]) else { return vec![] };
    t.lines()
        .filter_map(|l| l.trim().strip_prefix("node.name = \""))
        .filter_map(|n| n.strip_suffix('"'))
        .filter(|n| n.starts_with("effect_input."))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LS: &str = "\tid 37, type PipeWire:Interface:Node/3\n \t\tnode.name = \"Freewheel-Driver\"\n\tid 38, type PipeWire:Interface:Node/3\n \t\tobject.serial = \"38\"\n \t\tnode.name = \"effect_input.x1sound\"\n";

    #[test]
    fn node_ids() {
        assert_eq!(parse_node_id(LS, "effect_input.x1sound"), Some(38));
        assert_eq!(parse_node_id(LS, "nope"), None);
    }

    #[test]
    fn params() {
        let t = "    Prop: key Spa:Pod:Object:Param:Props:params\n      Struct: size 1, type Spa:Struct\n        String \"bass_l:Gain\"\n        Float 6.000000\n        String \"reg:g_in\"\n        Float 7.943300\n        String \"x:flag\"\n        Bool true\n";
        let m = parse_params(t);
        assert_eq!(m.get("bass_l:Gain"), Some(&6.0));
        assert_eq!(m.get("reg:g_in"), Some(&7.9433));
        assert!(!m.contains_key("x:flag"));
    }

    #[test]
    fn volume() {
        assert_eq!(parse_volume("Volume: 0.55\n"), Some((0.55, false)));
        assert_eq!(parse_volume("Volume: 0.55 [MUTED]\n"), Some((0.55, true)));
        assert_eq!(parse_volume("garbage"), None);
    }

    fn codec(hw: &str, drv: Option<&str>) -> String {
        let d = drv.map(|d| format!("  In-driver Connection: 2\n     {d}\n")).unwrap_or_default();
        format!("Node 0x14 [Pin Complex]\n  Connection: 1\n     0x02\nNode 0x17 [Pin Complex] wcaps\n  Pin Default 0x90170111\n  Connection: 4\n     {hw}\n{d}Node 0x18 [Pin Complex]\n  Connection: 1\n     0x06*\n")
    }

    #[test]
    fn routing_cases() {
        // estado real tras la fase 2
        assert_eq!(parse_routing(&codec("0x02 0x03* 0x06 0x08", Some("0x02 0x03")), true), Routing::Split);
        // fixup yoga9
        assert_eq!(parse_routing(&codec("0x02* 0x03 0x06 0x08", Some("0x02 0x03")), false), Routing::Shared);
        // woofers en el DAC sin volumen
        assert_eq!(parse_routing(&codec("0x02 0x03 0x06* 0x08", None), true), Routing::Unsafe);
        // el driver permite 0x06
        assert_eq!(parse_routing(&codec("0x02 0x03* 0x06 0x08", Some("0x02 0x03 0x06")), true), Routing::Unsafe);
        // el 0x06* de otro nodo (0x18) no cuenta
        assert_eq!(parse_routing("Node 0x18 x\n  Connection: 1\n     0x06*\n", true), Routing::Unknown);
    }
}
