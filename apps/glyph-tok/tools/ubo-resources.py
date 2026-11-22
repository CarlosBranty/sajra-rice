#!/usr/bin/env python3
"""Convert uBlock Origin's scriptlets and redirect resources (from its source tree) into adblock-rust Resource JSON,
the way Brave does, by READING the source as text: nothing from uBlock is executed.

- scriptlets: every `builtinScriptlets.push({...})` / `registeredScriptlets.push({...})` entry under
  src/js/resources/ → name, aliases, dependencies, requiresTrust and the source of its `fn` function. Helpers named
  "*.fn" become "fn/javascript", entry points "application/javascript" (adblock-rust calls them with the filter's args).
- redirects: src/js/redirect-resources.js entries whose file exists in src/web_accessible_resources/ (e.g.
  google-ima.js, a stub of Google's video-ad SDK used by `redirect=` rules).

Usage: ubo-resources.py <uBlock source root> <out.json>
"""
import base64
import json
import os
import re
import sys

TRUSTED = 1  # Brave grants permission bit 1 to its default lists (list_catalog.json permission_mask)


def skip_string(src, i):
    """i at an opening quote; returns the index after the closing quote (template literals nest ${…})"""
    q = src[i]
    i += 1
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if q == "`" and c == "$" and src[i + 1:i + 2] == "{":
            i = match_brace(src, i + 1) + 1
            continue
        if c == q:
            return i + 1
        i += 1
    return i


def regex_allowed(src, i):
    """Is a '/' at i the start of a regex literal (vs division)? Look at the previous significant character."""
    j = i - 1
    while j >= 0 and src[j] in " \t\r\n":
        j -= 1
    if j < 0:
        return True
    if src[j] in "(,=:[!&|?{};+-*%<>~^":
        return True
    m = re.search(r"[A-Za-z_$]+$", src[:j + 1])
    return bool(m and m.group(0) in ("return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else"))


def skip_regex(src, i):
    i += 1
    cls = False
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            cls = True
        elif c == "]":
            cls = False
        elif c == "/" and not cls:
            i += 1
            while i < len(src) and src[i].isalpha():
                i += 1
            return i
        elif c == "\n":
            return i
        i += 1
    return i


def match_brace(src, i):
    """i at '{' (or '('/'['); returns the index of the matching closer, skipping strings, comments and regexes"""
    pairs = {"{": "}", "(": ")", "[": "]"}
    stack = [pairs[src[i]]]
    i += 1
    while i < len(src):
        c = src[i]
        if c in "'\"`":
            i = skip_string(src, i)
            continue
        if c == "/" and src[i + 1:i + 2] == "/":
            i = src.find("\n", i)
            if i < 0:
                return len(src)
            continue
        if c == "/" and src[i + 1:i + 2] == "*":
            i = src.find("*/", i) + 2
            continue
        if c == "/" and regex_allowed(src, i):
            i = skip_regex(src, i)
            continue
        if c in pairs:
            stack.append(pairs[c])
        elif stack and c == stack[-1]:
            stack.pop()
            if not stack:
                return i
        i += 1
    raise ValueError("unbalanced source")


def strings(text):
    return re.findall(r"""['"]([^'"]+)['"]""", text or "")


def field(obj, name):
    m = re.search(r"\b" + name + r"\s*:\s*", obj)
    if not m:
        return None
    i = m.end()
    if obj[i] in "[{(":
        return obj[i:match_brace(obj, i) + 1]
    if obj[i] in "'\"`":
        return obj[i:skip_string(obj, i)]
    return re.match(r"[A-Za-z0-9_$.]+", obj[i:]).group(0)


def functions(src):
    """name → full source of every top-level `function name(…) {…}` (also `async function`) and `class Name {…}`"""
    out = {}
    for m in re.finditer(r"^(?:export\s+)?class\s+([A-Za-z0-9_$]+)[^{]*\{", src, re.M):
        start = src.index("class", m.start())
        out[m.group(1)] = src[start:match_brace(src, m.end() - 1) + 1]
    for m in re.finditer(r"^(?:export\s+)?(async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(", src, re.M):
        start = m.start() + (len("export ") if src[m.start():].startswith("export") else 0)
        start = src.index("function", start) if not m.group(1) else src.index("async", start)
        params_end = match_brace(src, m.end() - 1)
        body = src.index("{", params_end)
        out[m.group(2)] = src[start:match_brace(src, body) + 1]
    return out


def main(root, out):
    rdir = os.path.join(root, "src/js/resources")
    srcs = {f: open(os.path.join(rdir, f), encoding="utf-8").read() for f in sorted(os.listdir(rdir)) if f.endswith(".js")}
    # helpers some scriptlets import from uBlock's main code (../arglist-parser.js, ../jsonpath.js, ../urlskip.js)
    for s in list(srcs.values()):
        for imp in re.findall(r"from\s+'\.\./([A-Za-z0-9_.-]+\.js)'", s):
            f = os.path.join(root, "src/js", imp)
            if imp not in srcs and os.path.isfile(f):
                srcs["../" + imp] = open(f, encoding="utf-8").read()
    fns = {}
    for s in srcs.values():
        fns.update(functions(s))

    # two ways to register: builtinScriptlets.push({ name, fn: f, … }) and registerScriptlet(f, { name, … }). In the
    # second, dependencies may be the functions themselves: they resolve to the name each one registered under
    entries = []  # (fn identifier, details object source)
    for s in srcs.values():
        for m in re.finditer(r"(?:builtinScriptlets|registeredScriptlets)\.push\(\s*\{", s):
            obj = s[m.end() - 1:match_brace(s, m.end() - 1) + 1]
            entries.append((field(obj, "fn"), obj))
        for m in re.finditer(r"\bregisterScriptlet\(\s*([A-Za-z0-9_$]+)\s*,\s*\{", s):
            obj = s[m.end() - 1:match_brace(s, m.end() - 1) + 1]
            entries.append((m.group(1), obj))
    reg = {fn: strings(field(obj, "name"))[0] for fn, obj in entries}

    def deps(obj):
        d = field(obj, "dependencies") or ""
        return [x[1:-1] if x[0] in "'\"" else reg.get(x, x)
                for x in re.findall(r"""'[^']+'|"[^"]+"|[A-Za-z_$][A-Za-z0-9_$]*""", d)]

    resources, missing = [], []
    for fn, obj in entries:
        name = reg[fn]
        if fn not in fns:
            missing.append(name)
            continue
        r = {
            "name": name,
            "aliases": strings(field(obj, "aliases")),
            "kind": {"mime": "fn/javascript" if name.endswith(".fn") else "application/javascript"},
            "content": base64.b64encode(fns[fn].encode()).decode(),
            "dependencies": deps(obj),
        }
        if (field(obj, "requiresTrust") or "") == "true":
            r["permission"] = TRUSTED
        resources.append(r)
    n_scriptlets = len(resources)

    red = open(os.path.join(root, "src/js/redirect-resources.js"), encoding="utf-8").read()
    war = os.path.join(root, "src/web_accessible_resources")
    mimes = {"js": "application/javascript", "html": "text/html", "txt": "text/plain", "css": "text/css",
             "json": "application/json", "png": "image/png", "gif": "image/gif", "jpg": "image/jpeg",
             "svg": "image/svg+xml", "mp3": "audio/mp3", "mp4": "video/mp4", "xml": "text/xml"}
    for m in re.finditer(r"\[\s*'([^']+)'\s*,\s*\{", red):
        name = m.group(1)
        props = red[m.end() - 1:match_brace(red, m.end() - 1) + 1]
        f = os.path.join(war, name)
        if not os.path.isfile(f):
            continue
        r = {
            "name": name,
            "aliases": strings(field(props, "alias")),
            "kind": {"mime": mimes.get(name.rsplit(".", 1)[-1], "application/octet-stream")},
            "content": base64.b64encode(open(f, "rb").read()).decode(),
        }
        if (field(props, "requiresTrust") or "") == "true":
            r["permission"] = TRUSTED
        resources.append(r)

    with open(out, "w") as fh:
        json.dump(resources, fh)
    print(f"ubo resources: {n_scriptlets} scriptlets, {len(resources) - n_scriptlets} redirect files"
          + (f", skipped (fn not found): {', '.join(missing)}" if missing else ""))
    return 0 if n_scriptlets else 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
