// The panel and the setup guide in the colour scheme in use (showcase/panel, showcase/onboarding): every colour of
// their stylesheets is a variable the theme engine sets (showcase/roamies/theme.js), :root keeps Classic as the
// default, and both pages paint themselves, follow the setting and draw their Roamies in the scheme. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const failed = [];
const rule = async (name, fn) => { try { await fn(); } catch (e) { failed.push(name); console.error(`FAILED: ${name}\n  ${String(e?.message ?? e).split('\n').slice(0, 14).join('\n  ')}`); } };

// The engine by itself, as a page loads it.
const engine = () => { const window = { Roamie: {} }, ctx = vm.createContext({ window, console, setInterval, clearInterval }); vm.runInContext(read('../../../roamies/theme.js'), ctx, { filename: 'theme.js' }); return window.Roamie; };
const R = engine(), TH = R.theme, ratio = (a, b) => TH.contrast(a, b), lum = (c) => TH.luminance(c);
const CSS = { onboarding: read('../../../onboarding/onboarding.css'), panel: read('../../../panel/panel.css') };
const PANEL = read('../../../panel/panel.js'), GUIDE = read('../../../onboarding/onboarding.js');

// A stylesheet as [selector (with the @rule it is in), property, value], comments gone.
function decls(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  const body = () => {
    const list = []; let buf = '', depth = 0, q = null;
    for (; i < css.length; i++) {
      const c = css[i];
      if (q) { buf += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; buf += c; continue; }
      if (c === '(') depth++; else if (c === ')') depth--;
      if (c === '}' && !depth) { i++; break; }
      if (c === ';' && !depth) { list.push(buf); buf = ''; continue; }
      buf += c;
    }
    list.push(buf);
    return list.map((d) => d.trim()).filter(Boolean).map((d) => { const k = d.indexOf(':'); return [d.slice(0, k).trim(), d.slice(k + 1).trim().replace(/\s+/g, ' ')]; });
  };
  const rules = (prefix) => {
    let buf = '';
    while (i < css.length) {
      const c = css[i];
      if (c === '}') { i++; return; }
      if (c === '{') {
        const sel = buf.trim().replace(/\s+/g, ' '); buf = ''; i++;
        if (/^@(media|supports|keyframes)/.test(sel)) rules(`${prefix}${sel} | `); else for (const [p, v] of body()) out.push([prefix + sel, p, v]);
        continue;
      }
      buf += c; i++;
    }
  };
  rules('');
  return out;
}
const DECLS = { onboarding: decls(CSS.onboarding), panel: decls(CSS.panel) };
// Colours written out in a value: #hex (also inside a data: URL, as %23hex) and rgb(), rgba(), hsl() of numbers.
const literals = (v) => [...(v.match(/(#|%23)[0-9a-fA-F]{3,8}\b/g) ?? []), ...(v.match(/\b(rgba?|hsla?)\(\s*[\d.]+[^()]*\)/g) ?? [])];
// The variables :root gives a value (the panel loads the guide's stylesheet, then its own).
const root = (name) => Object.fromEntries(DECLS[name].filter(([s, p]) => s === ':root' && p.startsWith('--')).map(([, p, v]) => [p, v]));
const uses = (v) => (v.match(/var\(--[a-z0-9-]+/g) ?? []).map((m) => m.slice(4));
// A value with its variables put in (from `vars`) and every colour spelled one way: #rrggbb, or rgba(r,g,b,a).
const spell = (v, vars) => {
  for (let n = 0; n < 6; n++) v = v.replace(/var\((--[a-z0-9-]+)\)/g, (m, k) => vars[k] ?? m);
  return v.replace(/%23([0-9a-fA-F]{6})\b/g, '#$1').replace(/#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])\b(?![0-9a-fA-F])/g, '#$1$1$2$2$3$3')
    .replace(/\b(rgba?)\(([^()]*)\)/g, (m, f, a) => { const n = a.split(',').map((x) => parseFloat(x)); return n.length === 3 ? `#${n.map((x) => x.toString(16).padStart(2, '0')).join('')}` : `rgba(${n.join(',')})`; }).toLowerCase();
};

// ---------------------------------------------------------------- what the pages add to a scheme
// The colours the two stylesheets had beyond the engine's first roles, literal for literal, each now a role.
const PAGE = {
  field: '#061719', tip: '#08201f', bar: '#0b1f21', track: '#0b2224', press: '#0b2526', pressHi: '#0d2e2e', picked: '#0a2a28', key: '#0c2a2c', lit: '#0e3a36',
  disabled: '#1c3634', disabledInk: '#7f9f9a', bubble: '#04191b', bubbleInk: '#d6fff6',
  seg: '#14302f', segDone: '#2fae9b', ledOff: '#1e3f3d', stub: '#2b4a48', keyLine: '#2f6d66', lineOk: '#24675f',
  dangerLo: '#ff8a78', dangerInk: '#032722', halo: '#28aa96', dots: '#50d2be',
};
const FILLS = ['field', 'tip', 'bar', 'track', 'press', 'pressHi', 'picked', 'key', 'lit', 'disabled', 'bubble'];
const NOTE = { light: true, bg: '#f2e7de', surface: '#ffffff', fg: '#100a05', muted: '#786c61', line: '#e4d6cb', accent: '#9e6630', danger: '#d71921' };
const NIGHT = { light: false, bg: '#1a1410', surface: '#241c16', fg: '#f2e7de', muted: '#a39485', line: '#3a2e25', accent: '#d99a5b', danger: '#ff6b6b' };
// What the first roles came to before the pages had any (theme.js as it was), for the two fixed schemes and the note.
const WAS = {
  light: { name: 'light', light: true, bg: '#f4ecdf', panel: '#fcf7ee', ink: '#17140f', ink2: '#48443d', ink3: '#6e6558', accent: '#0c6b66', accentHi: '#0f514c', accentLo: '#3a857e', accentInk: '#e7f0f0', line: '#d9cdb9', lineHi: '#91ab9c', lineHot: '#4a887f', danger: '#b3261e', rule: '#e5dbca', hover: '#d8ddd0', well: '#e8e0d4', glass: 'rgba(244,236,223,0.94)', text: '#17140f', hot: '#123b36', mid: '#52928a', deep: '#aac3b8', faint: '#80aca3', edge: 'rgba(231,240,240,0.6)', coral: '#b3261e', note: '#944238', flash: '#0c6b66', scrim: '#100e0b', led: [[6, 17, 17], [22, 87, 84], [55, 179, 173], [133, 241, 236], [232, 252, 251]], screen: ['#061111', '#165754', '#37b3ad', '#85f1ec', '#e8fcfb'], tones: { accent: '#0c6b66', teal: '#438f7f', amber: '#a3843b', coral: '#c2695d', lilac: '#8d7dc2', sky: '#5488ad', lime: '#6d9240', red: '#e05e5e', white: '#17140f' }, glow: 0.6 },
  dark: { name: 'dark', light: false, bg: '#1c1d1f', panel: '#25272a', ink: '#eceeee', ink2: '#bec0c0', ink3: '#9ba1a0', accent: '#5fd6c3', accentHi: '#89ddd0', accentLo: '#52b1a2', accentInk: '#0d1e1b', line: '#3b3f42', lineHi: '#48746f', lineHot: '#54a99c', danger: '#ff8f80', rule: '#2d3032', hover: '#243333', well: '#121314', glass: 'rgba(28,29,31,0.94)', text: '#eceeee', hot: '#ade3db', mid: '#4b9f92', deep: '#315853', faint: '#3e7a71', edge: 'rgba(13,30,27,0.6)', coral: '#ff8f80', note: '#d2978e', flash: '#ffffff', scrim: '#0f1011', led: [[7, 16, 14], [31, 79, 71], [71, 163, 148], [147, 227, 215], [235, 250, 247]], screen: ['#07100e', '#1f4f47', '#47a394', '#93e3d7', '#ebfaf7'], tones: { accent: '#5fd6c3', teal: '#78ffe2', amber: '#ffcf5c', coral: '#ff8a7a', lilac: '#b9a4ff', sky: '#7cc8ff', lime: '#b6f36b', red: '#ff6b6b', white: '#eceeee' }, glow: 1 },
  note: { name: 'note', light: true, bg: '#f2e7de', panel: '#ffffff', ink: '#100a05', ink2: '#423b35', ink3: '#786c61', accent: '#9e6630', accentHi: '#734a23', accentLo: '#af8053', accentInk: '#faf8f5', line: '#e4d6cb', lineHi: '#ccaf95', lineHot: '#b3885f', danger: '#d71921', rule: '#eaded4', hover: '#e8d8c9', well: '#e6dbd3', glass: 'rgba(242,231,222,0.94)', text: '#100a05', hot: '#503318', mid: '#a17c58', deep: '#d7bea6', faint: '#c8a787', edge: 'rgba(250,248,245,0.6)', coral: '#d71921', note: '#ac3e3e', flash: '#9e6630', scrim: '#0b0704', led: [[15, 11, 8], [76, 54, 33], [159, 117, 76], [224, 187, 151], [249, 242, 235]], screen: ['#0f0b08', '#4c3621', '#9f754c', '#e0bb97', '#f9f2eb'], tones: { accent: '#9e6630', teal: '#438f7f', amber: '#997c37', coral: '#c2695d', lilac: '#8576b8', sky: '#5488ad', lime: '#66883c', red: '#d65a5a', white: '#100a05' }, glow: 0.6 },
};

await rule('the pages\' own colours are roles of Classic, literal for literal', () => {
  const c = TH.schemes.classic;
  for (const [k, v] of Object.entries(PAGE)) assert.equal(c[k], v, `classic.${k}`);
  // Under these names on a page, and the two that are only ever see-through also as "r, g, b".
  const v = TH.cssVars(c);
  assert.deepEqual(['--field', '--tip', '--bar', '--track', '--press', '--press-hi', '--picked', '--key', '--lit', '--disabled', '--disabled-ink', '--bubble', '--bubble-ink', '--seg', '--seg-done', '--led-off', '--stub', '--key-line', '--line-ok', '--danger-lo', '--danger-ink', '--halo', '--dots'].map((k) => v[k]), Object.values(PAGE));
  assert.equal(v['--halo-rgb'], '40, 170, 150'); assert.equal(v['--dots-rgb'], '80, 210, 190');
});

await rule('the roles there already were come to what they came to, in every scheme', () => {
  for (const [name, s] of [['light', TH.schemes.light], ['dark', TH.schemes.dark], ['note', TH.fromNote(NOTE)]]) {
    const now = JSON.parse(JSON.stringify(s));
    for (const [k, v] of Object.entries(WAS[name])) assert.deepEqual(now[k], v, `${name}.${k}`);
    assert.deepEqual(Object.keys(now).filter((k) => !(k in WAS[name])).sort(), Object.keys(PAGE).sort(), `${name}: and only the pages' roles are new`);
  }
});

await rule('the pages\' roles are made for Light, Dark and a note, and what is written on them reads', () => {
  const shown = (s, why) => {
    const on = (fg, bg, min) => assert.ok(ratio(s[fg], s[bg]) >= min, `${why}: ${fg} on ${bg} (${s[fg]} on ${s[bg]}: ${ratio(s[fg], s[bg]).toFixed(2)}, wants ${min})`);
    for (const k of Object.keys(PAGE)) assert.match(s[k], /^#[0-9a-f]{6}$/, `${why}: ${k} is a colour (${s[k]})`);
    // Words: on a field, a tooltip, a card held down or picked, a keycap, the guide's bubble and the menu bar's picture.
    for (const k of ['field', 'tip', 'press', 'pressHi', 'picked', 'key']) on('ink', k, 4.5);
    on('bubbleInk', 'bubble', 4.5); on('ink2', 'bar', 4.5);
    for (const k of ['field', 'press']) on('ink3', k, 3);
    // The accent as words or a lit dot: the picked one, a keycap, a key held down, the menu bar's icon.
    for (const k of ['picked', 'key', 'lit', 'bar']) on('accent', k, 3);
    // A switch's knob, off and on; a button that can't be pressed; Confirm, on the danger colour and its blink.
    on('ink3', 'track', 3); on('disabledInk', 'disabled', 3);
    on('dangerInk', 'danger', 4.5); on('dangerInk', 'dangerLo', 4.5);
    // Dots and lines that are not lit still show against what they sit on; a finished step is plainly lit.
    for (const k of ['seg', 'ledOff', 'keyLine', 'lineOk']) { on(k, 'bg', 1.2); on(k, 'panel', 1.2); }
    on('stub', 'bar', 1.2); on('segDone', 'bg', 3);
    assert.notEqual(s.segDone, s.accent, `${why}: a finished step is not the current one`); assert.notEqual(s.dangerLo, s.danger, `${why}: Confirm blinks`);
  };
  shown(TH.schemes.classic, 'Classic');
  const { light, dark } = TH.schemes, note = TH.fromNote(NOTE), night = TH.fromNote(NIGHT);
  for (const [s, why] of [[light, 'Light'], [dark, 'Dark'], [note, 'a light note'], [night, 'a dark note']]) {
    shown(s, why);
    // A filled button's words, also under the pointer and (briefly, so less is asked) held down.
    assert.ok(ratio(s.accentInk, s.accent) >= 4.5 && ratio(s.accentInk, s.accentHi) >= 4.5 && ratio(s.accentInk, s.accentLo) >= 3, `${why}: a filled button's words`);
    // Fills are of the scheme (paper on a light one), none of them Classic's.
    for (const k of FILLS) { assert.ok(s.light ? lum(s[k]) > 0.5 : lum(s[k]) < 0.1, `${why}: ${k} (${s[k]}) is ${s.light ? 'light' : 'dark'}`); assert.notEqual(s[k], PAGE[k], `${why}: ${k} is not Classic's`); }
  }
  // A note's accent colours what glows behind the guide's Roamie and the dots of the page.
  for (const s of [note, night]) for (const k of ['halo', 'dots', 'segDone']) { const [r, g, b] = TH.rgb(s[k]); assert.ok(r > g && g > b, `an amber accent makes an amber ${k} (${s[k]})`); }
  // A note whose own colours can't be read against each other still gives pages that can.
  shown(TH.fromNote({ light: true, bg: '#ffffff', fg: '#eeeeee', muted: '#f4f4f4', accent: '#fafafa', danger: '#ffeeee' }), 'white on white');
  shown(TH.fromNote({ light: false, bg: '#000000', fg: '#111111', muted: '#0a0a0a', accent: '#050505', danger: '#100000' }), 'black on black');
  // Light words on a dark danger, dark on a light one, whatever the accent is.
  shown(TH.fromNote({ light: false, bg: '#101010', accent: '#6a6a6a', danger: '#ffd9d9' }), 'a dim accent, a pale danger');
  shown(TH.fromNote({ light: true, bg: '#fafafa', accent: '#707070', danger: '#5a0000' }), 'a grey accent, a deep danger');
});

await rule('a page takes the scheme in use and its light or dark, now and on every change', () => {
  const w = engine(), T = w.theme;
  const el = { vars: {}, style: { setProperty(k, v) { el.vars[k] = v; } } };
  const stop = T.page(el);
  const classic = { ...T.cssVars(T.schemes.classic), 'color-scheme': 'dark' };
  assert.deepEqual(el.vars, classic, 'Classic at once, and it is a dark page');
  w.setTheme('light');
  assert.deepEqual(el.vars, { ...T.cssVars(T.schemes.light), 'color-scheme': 'light' }, 'Light: every variable and color-scheme');
  w.setTheme(NOTE); assert.equal(el.vars['--bg'], NOTE.bg); assert.equal(el.vars['--accent-rgb'], '158, 102, 48'); assert.equal(el.vars['color-scheme'], 'light');
  w.setTheme(NIGHT); assert.equal(el.vars['--bg'], NIGHT.bg); assert.equal(el.vars['color-scheme'], 'dark');
  w.setTheme('dark'); assert.equal(el.vars['--panel'], T.schemes.dark.panel); assert.equal(el.vars['color-scheme'], 'dark');
  w.setTheme('classic');
  assert.deepEqual(el.vars, classic, 'and back to Classic, exactly');
  stop(); w.setTheme('light');
  assert.deepEqual(el.vars, classic, 'until it is told to stop');
  // apply() by itself is as it was: the variables, and nothing about color-scheme (the research card uses it).
  const card = { vars: {}, style: { setProperty(k, v) { card.vars[k] = v; } } };
  T.apply(card, T.schemes.classic);
  assert.deepEqual(card.vars, { ...T.cssVars(T.schemes.classic) });
});

// ---------------------------------------------------------------- the stylesheets
await rule('no stylesheet keeps a colour of its own: variables, and what is not a colour of the scheme', () => {
  // Not colours of a scheme: the picture of the mouse pointer in the guide's drawing demo (white, edged in black),
  // and the black of the panel's dissolve masks (what a mask keeps, never seen).
  const PLAIN = {
    onboarding: [['.pen-demo .arrow', 'fill', '#ffffff'], ['.pen-demo .arrow', 'stroke', '#000000']],
    panel: [[':root', '--d1', '#000'], [':root', '--d2', '#000'], [':root', '--d2', '#000'], [':root', '--d3', '#000']],
  };
  const engineVars = TH.cssVars(TH.schemes.classic);
  for (const [name, list] of Object.entries(DECLS)) {
    const below = list.filter(([s, p]) => !(s === ':root' && p in engineVars));
    assert.deepEqual(below.flatMap(([s, p, v]) => literals(v).map((c) => [s, p, c])), PLAIN[name], `${name}.css`);
    // No colour by name either, and a see-through one is the scheme's "r, g, b" with its own alpha.
    for (const [s, p, v] of below) {
      assert.doesNotMatch(v, /(^|[\s,(])(white|black|gr[ae]y|red|teal|aqua|cyan)([\s,);]|$)/, `${name}.css ${s} { ${p} }`);
      for (const f of v.match(/\b(rgba?|hsla?)\([^()]*(\([^()]*\))?[^()]*\)/g) ?? []) assert.match(f, /^rgba?\(var\(--[a-z-]+-rgb\)(, 0?\.\d+)?\)$/, `${name}.css ${s} { ${p}: ${f} }`);
    }
  }
  assert.doesNotMatch(CSS.onboarding + CSS.panel, /color-mix|currentcolor\s*\/|#[0-9a-fA-F]{8}\b/);
});

await rule(':root is Classic, as the engine has it, and a dark page', () => {
  const vars = root('onboarding'), classic = TH.cssVars(TH.schemes.classic);
  // What it always held, as it was.
  const first = { '--bg': '#051214', '--panel': '#071a1c', '--ink': '#e8fffa', '--ink-2': '#b4d8d1', '--ink-3': '#8ab8b0', '--accent': '#78ffe2', '--accent-hi': '#a8ffed', '--accent-lo': '#5ce6c9', '--accent-ink': '#032722', '--line': '#1d4a48', '--line-hi': '#2f7c74', '--line-hot': '#4fbfa9', '--danger': '#ffb4a8' };
  assert.deepEqual(Object.keys(vars).slice(0, 13), Object.keys(first), 'the first thirteen, in their order');
  for (const [k, v] of Object.entries(first)) assert.equal(vars[k], v, k);
  for (const k of ['--ease', '--display', '--mono']) assert.ok(vars[k], `${k} is still there`);
  assert.deepEqual(DECLS.onboarding.filter(([s, p]) => s === ':root' && p === 'color-scheme').map(([, , v]) => v), ['dark']);
  // Every colour it holds is one the engine sets, with Classic's value; and every one the stylesheets use is held.
  const colours = Object.entries(vars).filter(([, v]) => /^(#[0-9a-fA-F]{3,8}|rgba?\(.*\)|\d+, \d+, \d+)$/.test(v));
  assert.ok(colours.length > 13, 'the pages\' own are there too');
  for (const [k, v] of colours) assert.equal(v, classic[k], `${k} is the engine's Classic`);
  const used = new Set([...DECLS.onboarding, ...DECLS.panel].flatMap(([, , v]) => uses(v)).filter((k) => k in classic));
  assert.deepEqual([...used].filter((k) => !(k in vars)), [], 'used but with no default');
  assert.deepEqual(colours.map(([k]) => k).filter((k) => !used.has(k)), [], 'held but never used');
  // The panel's own :root adds no colour.
  assert.deepEqual(Object.keys(root('panel')).filter((k) => k in classic), []);
});

await rule('every variable the stylesheets use is defined', () => {
  const all = [...DECLS.onboarding, ...DECLS.panel], defined = new Set(all.filter(([, p]) => p.startsWith('--')).map(([, p]) => p));
  // Set by panel.js on each row as it comes in (and read with a fallback).
  assert.match(PANEL, /style\.setProperty\('--i',/); defined.add('--i');
  const loose = [...new Set(all.flatMap(([, , v]) => uses(v)))].filter((k) => !defined.has(k));
  assert.deepEqual(loose, []);
  // A colour is never read with a fallback of its own (that would be a second copy of it).
  for (const [s, p, v] of all) assert.doesNotMatch(v, /var\(--[a-z0-9-]+\s*,\s*(#|rgb|hsl)/, `${s} { ${p} }`);
});

await rule('on Classic both pages are drawn in the colours they had', () => {
  // Every colour each stylesheet came to, and how many times, recorded from the files as they were (their own
  // :root put in for the variables they already used).
  const HAD = {
    onboarding: { '#000000': 1, '#032722': 1, '#04191b': 1, '#051214': 2, '#061719': 1, '#071a1c': 2, '#0a2a28': 2, '#0b1f21': 1, '#0b2224': 1, '#0b2526': 1, '#0c2a2c': 2, '#0d2e2e': 1, '#0e3a36': 2, '#14302f': 2, '#1c3634': 2, '#1d4a48': 4, '#1e3f3d': 2, '#24675f': 1, '#2b4a48': 1, '#2f6d66': 1, '#2f7c74': 8, '#2fae9b': 1, '#4fbfa9': 5, '#5ce6c9': 1, '#78ffe2': 32, '#7f9f9a': 1, '#8ab8b0': 10, '#a8ffed': 2, '#b4d8d1': 11, '#d6fff6': 1, '#e8fffa': 13, '#ffb4a8': 2, '#ffffff': 3, 'rgba(120,255,226,0.14)': 1, 'rgba(120,255,226,0.26)': 1, 'rgba(120,255,226,0.34)': 1, 'rgba(120,255,226,0.35)': 2, 'rgba(120,255,226,0.55)': 1, 'rgba(120,255,226,0.6)': 2, 'rgba(120,255,226,0.7)': 1, 'rgba(120,255,226,0.75)': 2, 'rgba(120,255,226,0.8)': 2, 'rgba(120,255,226,0.9)': 1, 'rgba(3,39,34,0.6)': 1, 'rgba(40,170,150,0.16)': 1, 'rgba(80,210,190,0.09)': 1 },
    panel: { '#000000': 4, '#032722': 1, '#051214': 1, '#071a1c': 3, '#08201f': 1, '#0a2a28': 2, '#1d4a48': 6, '#1e3f3d': 1, '#2f7c74': 3, '#5ce6c9': 1, '#78ffe2': 8, '#8ab8b0': 14, '#b4d8d1': 10, '#e8fffa': 12, '#ff8a78': 1, '#ffb4a8': 7, 'rgba(120,255,226,0.05)': 1, 'rgba(120,255,226,0.1)': 2, 'rgba(80,210,190,0.07)': 1 },
  };
  const vars = root('onboarding'), classic = TH.cssVars(TH.schemes.classic);
  for (const [name, list] of Object.entries(DECLS)) {
    const got = {};
    for (const [s, p, v] of list) {
      if (s === ':root' && p in classic) continue;
      for (const c of spell(v, vars).match(/#[0-9a-f]{6}\b|rgba\([^()]*\)/g) ?? []) got[c] = (got[c] ?? 0) + 1;
    }
    assert.deepEqual(Object.fromEntries(Object.entries(got).sort()), HAD[name], `${name}.css`);
  }
});

// ---------------------------------------------------------------- the pages
await rule('the panel paints itself in the scheme, follows the setting, and draws its Roamies in it', () => {
  const page = PANEL.slice(0, PANEL.indexOf('function preview()'));
  assert.match(page, /const THEME = window\.Roamie\?\.theme;\n\s+THEME\?\.page\(document\.documentElement\);/, 'its variables and color-scheme, at load and on every change');
  // The setting comes with the state: on System the shell is asked (now and every couple of seconds), on Classic
  // it is Classic. Only when the setting changed, so a state update doesn't start the asking over.
  const on = page.slice(page.indexOf('window.__panel = (m) =>'), page.indexOf("send({ type: 'panel_open' })"));
  assert.match(on, /if \(state\.theme !== themed\) \{ themed = state\.theme; THEME\?\.follow\(themed, \(\) => invoke\('theme_get'\)\); \}/);
  assert.ok(on.indexOf('THEME?.follow') > 0 && on.indexOf('THEME?.follow') < on.indexOf('render(null, first)'), 'before it is drawn');
  // The rest of a state message is handled as it was.
  assert.match(on, /if \(m\.kind === 'state'\) \{\n\s+const first = !state; state = m\.state;\n/);
  assert.match(on, /if \(ui\.arm && !document\.querySelector\(`\[data-k="\$\{CSS\.escape\(ui\.arm\)\}"\]`\)\) ui\.arm = null;\n\s+render\(null, first\);/);
  // Its live Roamies (the header's, the look tiles, Ken): the scheme's dots and glow, read every frame.
  assert.match(page, /id: 'panel', label: 'Panel', matrix: true, pixel: 1\.3, glow: \(\) => 0\.55 \* Roamie\.theme\.now\.glow, speed: 80, pal: \(\) => Roamie\.theme\.now\.led,/);
  assert.doesNotMatch(PANEL, /\[\[4, 16, 18\]|const LED\b/, 'no copy of the LED levels');
  assert.deepEqual(literals(page), [], 'and no colour of its own');
});

await rule('the setup guide does the same, and is told the setting', () => {
  const page = GUIDE.slice(0, GUIDE.indexOf('function preview()'));
  assert.match(page, /Roamie\.theme\.page\(document\.documentElement\);/);
  const on = page.slice(page.indexOf("case 'state': {"), page.indexOf("case 'login':"));
  assert.match(on, /if \(msg\.theme !== themed\) \{ themed = msg\.theme; Roamie\.theme\.follow\(themed, \(\) => invoke\('theme_get'\)\); \}/);
  assert.match(on, /const first = !state;\n\s+state = msg;\n\s+if \(Roamie\.sfx\) Roamie\.sfx\.enabled = msg\.sound !== false;\n/, 'the rest of a state message as it was');
  assert.match(on, /if \(first\) \{ sidekick\.setLook\?\.\(msg\.look\); sidekick\.setForm\?\.\(msg\.size\); \}\n\s+if \(at\('welcome'\)\) look\.render\(\);/);
  assert.match(page, /id: 'guide', label: 'Guide', matrix: true, pixel: 1\.3, glow: \(\) => 0\.55 \* Roamie\.theme\.now\.glow, speed: 80,\n\s+pal: \(\) => Roamie\.theme\.now\.led,/);
  assert.doesNotMatch(GUIDE, /\[\[4, 16, 18\]/, 'no copy of the LED levels');
  assert.deepEqual(literals(page), []);
  for (const html of [read('../../../onboarding/index.html'), read('../../../panel/index.html')]) assert.deepEqual(literals(html.replace(/&#\d+;/g, '')), [], 'nor does either page\'s markup');
  // The sidecar says which setting it is, with the rest of the guide's state.
  const side = read('../sidekick.mjs'), ob = side.slice(side.indexOf('function obState()'), side.indexOf('\n}\n', side.indexOf('function obState()')));
  assert.match(ob, /\n\s+theme: themeOf\(config\.theme\),\n/);
  assert.match(ob, /look: config\.look \?\? 'classic',\n\s+size: sizeNow\(\),\n/, 'beside its look and size, which are as they were');
  assert.match(ob, /kind: 'state',\n\s+platform: process\.platform,/);
});

await rule('opened in a browser, each page can be seen in every scheme', () => {
  // ?theme=light, dark or note: the desktop the preview pretends to have. The setting is System and the shell's answer
  // is that desktop's, so the page gets there the way it does in the app.
  const note = /\{ light: true, bg: '#f2e7de', surface: '#ffffff', fg: '#100a05', muted: '#786c61', line: '#e4d6cb', accent: '#9e6630', danger: '#d71921' \}/;
  for (const [name, src] of [['panel.js', PANEL], ['onboarding.js', GUIDE]]) {
    const pre = src.slice(src.indexOf('function preview()'));
    assert.match(pre, /const DESK = \{ light: \{ light: true \}, dark: \{ light: false \}, note: /, `${name}: the three desktops`);
    assert.match(pre, note, `${name}: the note is the one a light shell leaves`);
    assert.match(pre, /\[q\.get\('theme'\)\] \?\? null;/, `${name}: none unless asked for`);
    assert.match(pre, /if \(cmd === 'theme_get'\) return desk;/, `${name}: what the shell would answer`);
    assert.match(pre, /theme: desk \? 'system' : 'classic'/, `${name}: and the setting that follows it`);
  }
  // The panel's sample has every group of the Voice page, and its Colors picker works there.
  const pre = PANEL.slice(PANEL.indexOf('function preview()'));
  assert.match(pre, /duck: \{ on: true, level: 30, levels: \[10, 20, 30, 50\] \}, wake: \{ on: true, phrase: 'oye jarvis' \},/);
  assert.match(pre, /voice: \{ on: true, keys: null, ready: true, mac: false, mute: true, download: null \},/);
  assert.match(pre, /if \(id\.startsWith\('theme:'\)\) \{ s\.theme = id\.slice\(6\); /);
  assert.match(pre, /if \(id\.startsWith\('size:'\)\) \{ s\.size = id\.slice\(5\); setTimeout\(\(\) => window\.__panel\(\{ kind: 'state', state: s \}\), 120\); \}/, 'as Size and Look already did');
});

// Regression: the panel does not scroll, and with the Colors picker the Appearance page had grown past its height: the
// picker for this very setting was cut off at the bottom edge. The page is two tabs now, each short enough to fit.
{
  const panel = read('../../../panel/panel.js');
  const page = panel.slice(panel.indexOf('function appearancePage()'), panel.indexOf('// The looks as live tiles'));
  try {
    assert.match(page, /tabBtn\('look', 'Look'\), tabBtn\('style', 'Size and colors'\)/, 'the Appearance page has its two tabs');
    const at = (name) => page.indexOf(`const ${name} = [`);
    const look = page.slice(at('look'), at('style')), style = page.slice(at('style'));
    assert.ok(look.includes("group('Look'") && !look.includes("group('Colors'") && !look.includes("group('Size'"), 'the looks have a tab to themselves');
    assert.ok(style.includes("group('Size'") && style.includes("group('Colors'"), 'size and colours share the other');
    assert.match(page, /on === 'style' \? style : look/, 'one tab shows at a time');
  } catch (e) { failed.push('appearance tabs'); console.error(`appearance tabs: ${e.message}`); }
}

if (failed.length) { console.error(`theme pages tests: ${failed.length} failed`); process.exit(1); }
console.log('theme pages tests: passed');
