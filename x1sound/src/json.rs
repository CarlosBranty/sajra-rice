//! JSON mínimo (solo std) para la config de x1sound: objetos, números, strings, bools, null y arrays.
//! No es un parser general de rendimiento; la config y el estado son de unos cientos de bytes.

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(BTreeMap<String, Json>),
}

impl Json {
    pub fn get(&self, k: &str) -> Option<&Json> {
        match self {
            Json::Obj(m) => m.get(k),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
}

pub fn parse(s: &str) -> Result<Json, String> {
    let mut p = P { b: s.as_bytes(), i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("basura tras el JSON en {}", p.i));
    }
    Ok(v)
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) -> Result<(), String> {
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("se esperaba '{}' en {}", c as char, self.i))
        }
    }
    fn lit(&mut self, w: &str, v: Json) -> Result<Json, String> {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            Ok(v)
        } else {
            Err(format!("literal inválido en {}", self.i))
        }
    }
    fn value(&mut self) -> Result<Json, String> {
        match self.b.get(self.i) {
            Some(b'{') => self.obj(),
            Some(b'[') => self.arr(),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'n') => self.lit("null", Json::Null),
            Some(c) if *c == b'-' || c.is_ascii_digit() => self.num(),
            _ => Err(format!("valor inesperado en {}", self.i)),
        }
    }
    fn obj(&mut self) -> Result<Json, String> {
        self.eat(b'{')?;
        let mut m = BTreeMap::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Json::Obj(m));
        }
        loop {
            self.ws();
            let k = self.string()?;
            self.ws();
            self.eat(b':')?;
            self.ws();
            let v = self.value()?;
            m.insert(k, v);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(m));
                }
                _ => return Err(format!("se esperaba ',' o '}}' en {}", self.i)),
            }
        }
    }
    fn arr(&mut self) -> Result<Json, String> {
        self.eat(b'[')?;
        let mut v = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Json::Arr(v));
        }
        loop {
            self.ws();
            v.push(self.value()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(v));
                }
                _ => return Err(format!("se esperaba ',' o ']' en {}", self.i)),
            }
        }
    }
    fn string(&mut self) -> Result<String, String> {
        self.eat(b'"')?;
        let mut out = String::new();
        loop {
            let c = *self.b.get(self.i).ok_or("string sin cerrar")?;
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or("escape sin cerrar")?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        b'r' => out.push('\r'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'u' => {
                            let h = std::str::from_utf8(self.b.get(self.i..self.i + 4).ok_or("\\u corto")?)
                                .map_err(|e| e.to_string())?;
                            let cp = u32::from_str_radix(h, 16).map_err(|e| e.to_string())?;
                            self.i += 4;
                            out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        }
                        _ => return Err("escape inválido".into()),
                    }
                }
                _ => {
                    // UTF-8: copiar el byte; reconstruir al final
                    let start = self.i - 1;
                    let mut end = self.i;
                    while end < self.b.len() && self.b[end] & 0xC0 == 0x80 {
                        end += 1;
                    }
                    out.push_str(std::str::from_utf8(&self.b[start..end]).map_err(|e| e.to_string())?);
                    self.i = end;
                }
            }
        }
    }
    fn num(&mut self) -> Result<Json, String> {
        let s = self.i;
        while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
            self.i += 1;
        }
        let t = std::str::from_utf8(&self.b[s..self.i]).map_err(|e| e.to_string())?;
        t.parse::<f64>().map(Json::Num).map_err(|_| format!("número inválido '{t}'"))
    }
}

pub fn to_string(v: &Json) -> String {
    let mut s = String::new();
    write(v, &mut s, 0);
    s.push('\n');
    s
}

fn write(v: &Json, s: &mut String, ind: usize) {
    match v {
        Json::Null => s.push_str("null"),
        Json::Bool(b) => s.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                let _ = write!(s, "{}", *n as i64);
            } else {
                let _ = write!(s, "{}", (n * 1000.0).round() / 1000.0);
            }
        }
        Json::Str(t) => {
            s.push('"');
            for c in t.chars() {
                match c {
                    '"' => s.push_str("\\\""),
                    '\\' => s.push_str("\\\\"),
                    '\n' => s.push_str("\\n"),
                    c if (c as u32) < 0x20 => {
                        let _ = write!(s, "\\u{:04x}", c as u32);
                    }
                    c => s.push(c),
                }
            }
            s.push('"');
        }
        Json::Arr(a) => {
            s.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                write(x, s, ind);
            }
            s.push(']');
        }
        Json::Obj(m) => {
            s.push_str("{\n");
            for (i, (k, x)) in m.iter().enumerate() {
                s.push_str(&"    ".repeat(ind + 1));
                write(&Json::Str(k.clone()), s, 0);
                s.push_str(": ");
                write(x, s, ind + 1);
                if i + 1 < m.len() {
                    s.push(',');
                }
                s.push('\n');
            }
            s.push_str(&"    ".repeat(ind));
            s.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let t = r#"{"a": 1, "b": -2.5, "c": "x\"y", "d": true, "e": null, "f": [1, 2], "g": {"h": "ñ"}}"#;
        let v = parse(t).unwrap();
        assert_eq!(v.get("b").unwrap().as_f64(), Some(-2.5));
        assert_eq!(v.get("c").unwrap().as_str(), Some("x\"y"));
        assert_eq!(v.get("g").unwrap().get("h").unwrap().as_str(), Some("ñ"));
        assert_eq!(parse(&to_string(&v)).unwrap(), v);
    }
    #[test]
    fn errors() {
        assert!(parse("{").is_err());
        assert!(parse(r#"{"a": }"#).is_err());
        assert!(parse(r#"{"a": 1} x"#).is_err());
        assert!(parse("").is_err());
    }
}
