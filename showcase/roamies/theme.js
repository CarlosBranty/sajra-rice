// The colours of everything Roamies draws, in one place. A scheme names each colour by what it is for (a role), the
// five LED levels of the character and the tones drawings use. There are three fixed ones: Classic (the colours it
// always had, and the default), Light and Dark; and one can be made from the few colours a desktop leaves in its note
// ($XDG_RUNTIME_DIR/roamies/theme.json: light or dark, background, surface, text, muted text, line, accent, danger).
// Whatever draws reads Roamie.theme.now when it draws, so a change shows on the next frame.
// API on Roamie.theme: now, rev, schemes, fromNote(note), resolve(what), set(what), onChange(fn), follow(setting, ask),
// cssVars(scheme), apply(el, scheme), and the colour helpers rgb, rgba, mix, luminance, contrast. Roamie.setTheme = set.
(() => {
  const R = window.Roamie;
  if (!R) return;

  // ---------------------------------------------------------------- colour arithmetic
  // The only colour taken from outside is "#rrggbb": anything else (a name, a short form, a function) is not one.
  const hexOf = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);
  const toHex = (c) => `#${c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  // "#rrggbb" or "rgba(r,g,b,a)" as numbers.
  const rgb = (c) => (c[0] === '#' ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.slice(c.indexOf('(') + 1, -1).split(',').map(Number));
  const rgba = (h, a) => `rgba(${rgb(h).slice(0, 3).join(',')},${a})`;
  const mix = (a, b, k) => { const p = rgb(a), q = rgb(b); return toHex(p.map((v, i) => v + (q[i] - v) * k)); };
  // How light a colour is and how well two read against each other, as WCAG works them out (1 to 21).
  const luminance = (c) => { const [r, g, b] = rgb(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // c, moved toward black or white (whichever is further from the first of `on`) just far enough to read at `min`
  // against every colour in `on`. A colour that already does is returned as it is.
  const reads = (c, on, min) => {
    const ok = (x) => on.every((o) => contrast(x, o) >= min);
    if (ok(c)) return c;
    const pole = luminance(on[0]) > 0.179 ? '#000000' : '#ffffff';
    for (let k = 0.04; k < 1; k += 0.04) { const m = mix(c, pole, k); if (ok(m)) return m; }
    return pole;
  };
  const hsl = (c) => {
    const [r, g, b] = rgb(c).map((v) => v / 255), hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo;
    if (!d) return [0, 0, l];
    const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
  };
  const fromHsl = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, s), x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2, i = Math.floor(h / 60) % 6;
    return [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i].map((v) => Math.round((v + m) * 255));
  };

  const deep = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deep(v); return Object.freeze(o); };

  // ---------------------------------------------------------------- Classic: the colours Roamies always had
  const classic = deep({
    name: 'classic', light: false,
    // Pages (the panel, the setup guide) and the research card.
    bg: '#051214', panel: '#071a1c', ink: '#e8fffa', ink2: '#b4d8d1', ink3: '#8ab8b0',
    accent: '#78ffe2', accentHi: '#a8ffed', accentLo: '#5ce6c9', accentInk: '#032722',
    line: '#1d4a48', lineHi: '#2f7c74', lineHot: '#4fbfa9', danger: '#ffb4a8',
    rule: '#12302e', hover: '#0d2a2a', well: '#030c0d',
    // Drawn on the screen: bubbles, tags, chips, cards and drawings. glass: what they're made of; text: words on it;
    // hot, mid, deep, faint: the accent from its strongest to its faintest; edge: round a pen line, so it reads on
    // anything; coral: something failed; note: why; flash: a letter as it lands; scrim: what dims the screen.
    glass: 'rgba(6,22,24,0.94)', text: '#dcfff6', hot: '#e6fffa', mid: '#28c4b8', deep: '#0e5c60', faint: '#3f8f88',
    edge: 'rgba(3,39,34,0.6)', coral: '#ff8a7a', note: '#e9a196', flash: '#ffffff', scrim: '#030e10',
    // The character's LED levels, darkest to brightest, and the same for pictures shown on a card.
    led: [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]],
    screen: ['#051214', '#0e5c60', '#28c4b8', '#78ffe2', '#e6fffa'],
    // What a drawing can be drawn in.
    tones: { accent: '#78ffe2', teal: '#78ffe2', amber: '#ffcf5c', coral: '#ff8a7a', lilac: '#b9a4ff', sky: '#7cc8ff', lime: '#b6f36b', red: '#ff6b6b', white: '#e8fffa' },
    // How much of the character's own glow is kept.
    glow: 1,
  });

  // ---------------------------------------------------------------- a scheme from a few colours
  // The colours a desktop's note can name. The two fixed schemes are made from these the same way a note's is, so a
  // colour a note leaves out is simply the fixed scheme's.
  const KEYS = ['bg', 'surface', 'fg', 'muted', 'line', 'accent', 'danger'];
  const BASE = {
    // Warm paper: cream, near-black ink, a dark teal.
    light: { light: true, bg: '#f4ecdf', surface: '#fcf7ee', fg: '#17140f', muted: '#6e6558', line: '#d9cdb9', accent: '#0c6b66', danger: '#b3261e' },
    // Graphite: a charcoal with no tint (Classic's black is teal), soft white ink, a teal.
    dark: { light: false, bg: '#1c1d1f', surface: '#25272a', fg: '#eceeee', muted: '#9ba1a0', line: '#3b3f42', accent: '#5fd6c3', danger: '#ff8f80' },
  };
  // Every role from those few. The note's colours are used as they are when they can be read against its background
  // (reads() leaves them alone); the rest are mixes of them. The LED levels keep the accent's hue and run from a
  // dark shade of it to a light one, on a light scheme too, so the character is still lit dots. Tones keep their own
  // hue, darkened or lightened until they show on this glass.
  function derive(name, b) {
    const on = [b.bg, b.surface];
    const ink = reads(b.fg, on, 4.5), ink3 = reads(b.muted, on, 3), accent = reads(b.accent, on, 3), danger = reads(b.danger, on, 3);
    // Words on an accent fill: nearly black on a light accent, nearly white on a dark one.
    const accentInk = reads(luminance(accent) > 0.179 ? mix(accent, '#000000', 0.86) : mix(accent, '#ffffff', 0.9), [accent], 4.5);
    const [h, s] = hsl(accent);
    const led = [[0.045, 0.64], [0.215, 0.74], [0.46, 0.66], [0.735, 1], [0.95, 1]].map(([l, k]) => fromHsl(h, s * k, l));
    const tone = (c) => reads(c, on, 3);
    return deep({
      name, light: b.light,
      bg: b.bg, panel: b.surface, ink, ink2: reads(mix(ink, b.bg, 0.22), on, 4.5), ink3,
      accent, accentHi: reads(mix(accent, ink, 0.3), on, 3), accentLo: mix(accent, b.bg, 0.2),
      accentInk,
      line: b.line, lineHi: mix(b.line, accent, 0.35), lineHot: mix(b.line, accent, 0.7), danger,
      rule: mix(b.bg, b.line, 0.55), hover: mix(b.bg, accent, 0.12), well: mix(b.bg, '#000000', b.light ? 0.05 : 0.35),
      glass: rgba(b.bg, 0.94), text: ink, hot: reads(mix(accent, ink, 0.55), on, 3), mid: reads(mix(accent, b.bg, 0.3), on, 3),
      deep: mix(accent, b.bg, 0.68), faint: mix(accent, b.bg, 0.5),
      edge: rgba(accentInk, 0.6), coral: danger, note: reads(mix(danger, ink3, 0.45), on, 3),
      // On paper a white letter wouldn't show: it lands in the accent instead.
      flash: b.light ? accent : '#ffffff', scrim: b.light ? mix(ink, '#000000', 0.3) : mix(b.bg, '#000000', 0.45),
      led, screen: led.map(toHex),
      tones: { accent, teal: tone(classic.tones.teal), amber: tone(classic.tones.amber), coral: tone(classic.tones.coral), lilac: tone(classic.tones.lilac), sky: tone(classic.tones.sky), lime: tone(classic.tones.lime), red: tone(classic.tones.red), white: ink },
      // The glow is added light: over a bright desktop less of it keeps the dots crisp.
      glow: b.light ? 0.6 : 1,
    });
  }
  const schemes = { classic, light: derive('light', BASE.light), dark: derive('dark', BASE.dark) };

  // The scheme for a desktop's note ({ light, bg, surface, fg, muted, line, accent, danger }), or null when it isn't
  // one (light has to be true or false). Each colour is taken only if it is "#rrggbb"; one that is missing or anything
  // else is the fixed Light or Dark scheme's, and with none at all it is that scheme itself. The same note is the
  // same scheme: it is asked for every couple of seconds.
  let last = null;
  function fromNote(note) {
    if (!note || typeof note !== 'object' || typeof note.light !== 'boolean') return null;
    const kind = note.light ? 'light' : 'dark', b = { ...BASE[kind] };
    let own = 0;
    for (const k of KEYS) { const c = hexOf(note[k]); if (c) { b[k] = c; own++; } }
    if (!own) return schemes[kind];
    const key = `${kind},${KEYS.map((k) => b[k]).join(',')}`;
    if (last?.key !== key) last = { key, scheme: derive('note', b) };
    return last.scheme;
  }
  // What a setting or the shell's answer comes to: a fixed scheme by its name, a note's, and Classic for anything else.
  const resolve = (what) => (typeof what === 'string' ? (Object.hasOwn(schemes, what) ? schemes[what] : classic) : fromNote(what) ?? classic);

  // ---------------------------------------------------------------- the scheme in use
  let now = classic, rev = 0;
  const heard = new Set();
  // Changes the scheme; true when it did. Those that keep something made from the old one (a style, a cached
  // picture) are told, each on its own: one failing doesn't keep the others from hearing.
  function set(what) {
    const next = resolve(what);
    if (next === now) return false;
    now = next; rev++;
    for (const fn of [...heard]) { try { fn(now); } catch (e) { console.error('theme', e); } }
    return true;
  }
  const onChange = (fn) => { heard.add(fn); return () => heard.delete(fn); };

  // The setting, followed: 'system' asks what the desktop's scheme is (ask() resolves to a note, or to just
  // { light }) now and every couple of seconds, and uses the answer; anything else is Classic and asks nothing.
  // No answer, or one that makes no sense, leaves the scheme as it is.
  let poll = 0, turn = 0;
  function follow(setting, ask, every = 2000) {
    if (poll) { clearInterval(poll); poll = 0; }
    const mine = ++turn;
    if (setting !== 'system' || typeof ask !== 'function') { set('classic'); return; }
    const once = () => {
      let reply;
      try { reply = ask(); } catch { return; }
      Promise.resolve(reply).then((sys) => { if (mine === turn && fromNote(sys)) set(sys); }, () => {});
    };
    once();
    poll = setInterval(once, every);
  }

  // ---------------------------------------------------------------- for pages
  // A scheme as CSS custom properties: every colour role under its name (--bg, --ink-2, --accent-hi, …), and the
  // three that get mixed with transparency also as "r, g, b" (--bg-rgb, --ink-rgb, --accent-rgb) for rgba().
  const cssName = (k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\d)/, '-$1')}`;
  function cssVars(s = now) {
    const out = {};
    for (const [k, v] of Object.entries(s)) if (typeof v === 'string' && k !== 'name') out[cssName(k)] = v;
    for (const k of ['bg', 'ink', 'accent']) out[`--${k}-rgb`] = rgb(s[k]).join(', ');
    return out;
  }
  // Sets them on an element (a page's root, a card). scheme.light says which color-scheme the page is.
  const apply = (el, s = now) => { for (const [k, v] of Object.entries(cssVars(s))) el.style.setProperty(k, v); };

  R.theme = {
    get now() { return now; }, get rev() { return rev; },
    schemes, fromNote, resolve, set, onChange, follow, cssVars, apply, rgb, rgba, mix, luminance, contrast,
  };
  R.setTheme = set;
})();
