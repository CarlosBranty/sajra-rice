// Colours: Classic (what it always was), and the desktop's own on System: a fixed light and a fixed dark scheme, or
// one made from the note a bar leaves in $XDG_RUNTIME_DIR/roamies/theme.json (showcase/roamies/theme.js; the shell's
// side is tested in src-tauri). Every overlay surface reads the scheme in use when it draws. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { THEMES, themeOf } from '../speech.mjs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const noop = () => {};

// The overlay's files in a page that isn't one: canvases that remember the colours they were given, a clock and
// timers moved by hand (tick), and elements that keep their style properties.
const OVERLAY = ['theme.js', 'markdown.js', 'glass.js', 'agent.js', 'agent-tools.js', 'agent-cards.js', 'agent-panel.js', 'jarvis.js', 'people.js', '10-dither.js', '12-sidekick.js', 'ink.js', 'pen.js'];
function world(files = OVERLAY) {
  const log = [], rafs = [], timers = [], els = [];
  let clock = 1000, lastImg = null, seed = 7;
  const mk2d = () => new Proxy({}, {
    get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 })
      : k === 'createImageData' ? (w, h) => (lastImg = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      : k === 'getImageData' ? (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      : noop),
    set: (_, k, v) => { if (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') log.push(v); return true; },
    has: (_, k) => k === 'filter',
  });
  const el = (tag) => {
    const e = {
      tag, vars: {}, kids: [], style: { setProperty(k, v) { e.vars[k] = v; } }, getContext: () => mk2d(), setAttribute: noop, getAttribute: () => null, addEventListener: noop, appendChild: noop,
      append(...k) { e.kids.push(...k); }, replaceChildren(...k) { e.kids = k; },
      classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 380, bottom: 200, width: 380, height: 200 }), offsetWidth: 380, offsetHeight: 200, scrollTop: 0, scrollHeight: 0, clientHeight: 0, width: 0, height: 0,
    };
    els.push(e); return e;
  };
  // The same "random" every run, so the same things are drawn.
  const M = Object.create(Math); M.random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const window = {};
  const ctx = {
    window, Math: M, Map, Set, Promise, console, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams,
    performance: { now: () => clock },
    setTimeout: (f, ms = 0) => timers.push({ f, at: clock + ms }), clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].f = null; },
    setInterval: (f, ms) => timers.push({ f, at: clock + ms, every: ms }), clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].f = null; },
    matchMedia: () => ({ matches: false, addEventListener: noop }), addEventListener: noop, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    requestAnimationFrame: (f) => rafs.push(f), localStorage: { removeItem: noop },
    Path2D: class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} },
    document: { addEventListener: noop, createElement: el, body: { appendChild: noop, append: noop }, head: { appendChild: noop }, getElementById: () => null },
  };
  vm.createContext(ctx);
  const load = (f) => vm.runInContext(read(`../../../roamies/${f}`), ctx, { filename: f });
  load('core.js');
  vm.runInContext('var Roamie = window.Roamie;', ctx);
  for (const f of files) load(f);
  // One display frame: the clock moves on, due timers and the frame's callbacks run, then promises settle.
  const tick = async (n = 1, ms = 16) => {
    for (let i = 0; i < n; i++) {
      clock += ms;
      for (const t of timers) if (t.f && t.at <= clock) { const f = t.f; if (t.every) t.at += t.every; else t.f = null; f(); }
      for (const f of rafs.splice(0)) f(clock);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { R: window.Roamie, mk2d, els, tick, timers: () => timers.filter((t) => t.f), img: () => lastImg, take: () => [...new Set(log.splice(0))].sort(), seq: () => log.splice(0) };
}

// Each rule runs on its own, so one that fails doesn't hide the others.
const failed = [];
const rule = async (name, fn) => { try { await fn(); } catch (e) { failed.push(name); console.error(`FAILED: ${name}\n  ${String(e?.message ?? e).split('\n').slice(0, 12).join('\n  ')}`); } };

// ---------------------------------------------------------------- what Classic is: every colour as the code had it
// before there were schemes (12-sidekick.js, glass.js, agent.js, agent-cards.js, agent-panel.js, ink.js, pen.js and
// the :root of onboarding.css), literal for literal.
const CLASSIC = {
  name: 'classic', light: false,
  bg: '#051214', panel: '#071a1c', ink: '#e8fffa', ink2: '#b4d8d1', ink3: '#8ab8b0',
  accent: '#78ffe2', accentHi: '#a8ffed', accentLo: '#5ce6c9', accentInk: '#032722',
  line: '#1d4a48', lineHi: '#2f7c74', lineHot: '#4fbfa9', danger: '#ffb4a8',
  rule: '#12302e', hover: '#0d2a2a', well: '#030c0d',
  glass: 'rgba(6,22,24,0.94)', text: '#dcfff6', hot: '#e6fffa', mid: '#28c4b8', deep: '#0e5c60', faint: '#3f8f88',
  edge: 'rgba(3,39,34,0.6)', coral: '#ff8a7a', note: '#e9a196', flash: '#ffffff', scrim: '#030e10',
  // The rest of what onboarding.css and panel.css had written out (theme-pages.test.mjs is about these).
  field: '#061719', tip: '#08201f', bar: '#0b1f21', track: '#0b2224', press: '#0b2526', pressHi: '#0d2e2e', picked: '#0a2a28',
  key: '#0c2a2c', lit: '#0e3a36', disabled: '#1c3634', disabledInk: '#7f9f9a', bubble: '#04191b', bubbleInk: '#d6fff6',
  seg: '#14302f', segDone: '#2fae9b', ledOff: '#1e3f3d', stub: '#2b4a48', keyLine: '#2f6d66', lineOk: '#24675f',
  dangerLo: '#ff8a78', dangerInk: '#032722', halo: '#28aa96', dots: '#50d2be',
  led: [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]],
  screen: ['#051214', '#0e5c60', '#28c4b8', '#78ffe2', '#e6fffa'],
  tones: { accent: '#78ffe2', teal: '#78ffe2', amber: '#ffcf5c', coral: '#ff8a7a', lilac: '#b9a4ff', sky: '#7cc8ff', lime: '#b6f36b', red: '#ff6b6b', white: '#e8fffa' },
  glow: 1,
};
// What each surface gave its canvas, recorded from the code as it was (the scenes below, run before the change).
const WAS = {
  pixels: ['120,255,226', '14,92,96', '230,255,250', '4,16,18', '40,196,184'],
  chrome: ['rgba(6,22,24,0.94)', 'rgba(0,0,0,0.35)', 'rgba(120,255,226,0.7)', '#78ffe2', '#ffffff'],
  chromeFail: ['rgba(6,22,24,0.94)', 'rgba(0,0,0,0.35)', 'rgba(255,138,122,0.7)', '#ff8a7a'],
  typedHalf: ['#dcfff6', '#ffffff'], typedFull: ['#8ab8b0'],
  pen: ['rgba(3,39,34,0.6)', 'rgba(40,196,184,0.7)', '#28c4b8'],
  chipFilled: ['rgb(46,97,86)', '#78ffe2', 'rgba(255,255,255,0.55)', 'rgba(3,39,34,0.25)', '#032722'],
  chipFilledHover: ['#e6fffa', 'rgb(46,97,86)', 'rgb(161,255,235)', 'rgba(255,255,255,0.55)', 'rgba(3,39,34,0.25)', '#032722'],
  chip: ['rgba(0,0,0,0.45)', 'rgba(6,22,24,0.94)', '#78ffe2', '#dcfff6'],
  chipHover: ['rgba(0,0,0,0.45)', 'rgba(6,22,24,0.94)', 'rgba(120,255,226,0.16)', '#78ffe2', '#dcfff6'],
  say: ['#78ffe2', '#dcfff6', '#e6fffa', '#ffffff', 'rgba(0,0,0,0.35)', 'rgba(120,255,226,0.7)', 'rgba(120,255,226,0.8)', 'rgba(6,22,24,0.94)'],
  think: ['#28c4b8', '#78ffe2', '#ffffff', 'rgba(0,0,0,0.35)', 'rgba(120,255,226,0.7)', 'rgba(120,255,226,0.8)', 'rgba(40,196,184,0.9)', 'rgba(6,22,24,0.94)'],
  prompt: ['#032722', '#78ffe2', '#dcfff6', '#e6fffa', '#ffffff', 'rgb(46,97,86)', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.45)', 'rgba(120,255,226,0.7)', 'rgba(120,255,226,0.8)', 'rgba(255,255,255,0.55)', 'rgba(3,39,34,0.25)', 'rgba(6,22,24,0.94)'],
  input: ['#78ffe2', '#8ab8b0', '#e6fffa', '#ffffff', 'rgba(0,0,0,0.35)', 'rgba(120,255,226,0.7)', 'rgba(120,255,226,0.8)', 'rgba(230,255,250,1)', 'rgba(40,196,184,0.9)', 'rgba(6,22,24,0.94)'],
  tool: ['#0e5c60', '#78ffe2', '#8ab8b0', '#dcfff6', '#e6fffa', '#ffffff', 'rgba(0,0,0,0.35)', 'rgba(120,255,226,0.7)', 'rgba(120,255,226,0.8)', 'rgba(6,22,24,0.94)'],
  toolFail: ['#8ab8b0', '#ff8a7a', '#ffffff', 'rgba(0,0,0,0.35)', 'rgba(255,138,122,0.7)', 'rgba(6,22,24,0.94)'],
  trail: ['#0e5c60', '#28c4b8', '#3f8f88', '#78ffe2', '#8ab8b0', '#dcfff6', '#e6fffa', '#e9a196', '#ff8a7a', '#ffffff', 'rgba(0,0,0,0.35)', 'rgba(120,255,226,0.06)', 'rgba(120,255,226,0.07)', 'rgba(120,255,226,0.7)', 'rgba(230,255,250,0.7)', 'rgba(255,138,122,0.7)', 'rgba(3,39,34,0.6)', 'rgba(40,196,184,0.7)', 'rgba(6,22,24,0.94)', 'rgba(63,143,136,0.7)'],
  reminders: ['#0e5c60', '#28c4b8', '#78ffe2', '#8ab8b0', '#dcfff6', '#e6fffa', '#ff8a7a', '#ffffff', 'rgba(0,0,0,0.35)', 'rgba(120,255,226,0.06)', 'rgba(120,255,226,0.7)', 'rgba(3,39,34,0.6)', 'rgba(6,22,24,0.94)'],
  userPen: ['#78ffe2', 'rgba(120,255,226,0.75)', 'rgba(3,39,34,0.6)'],
  // The research card's own colours (agent-panel.js's CSS) and the pages' (onboarding.css :root).
  vars: {
    '--bg': '#051214', '--panel': '#071a1c', '--ink': '#e8fffa', '--ink-2': '#b4d8d1', '--ink-3': '#8ab8b0', '--accent': '#78ffe2', '--accent-hi': '#a8ffed', '--accent-lo': '#5ce6c9',
    '--accent-ink': '#032722', '--line': '#1d4a48', '--line-hi': '#2f7c74', '--line-hot': '#4fbfa9', '--danger': '#ffb4a8', '--rule': '#12302e', '--hover': '#0d2a2a', '--well': '#030c0d',
    '--bg-rgb': '5, 18, 20', '--accent-rgb': '120, 255, 226',
  },
};
// Not colours of a scheme: the white glint and highlight, black shadows, and a filled button's own shade and tint.
const PLAIN = (s) => s === '#ffffff' || /^rgba\((0,0,0|255,255,255),/.test(s) || /^rgb\(/.test(s);
// The desktop's note on the machine this was made on (a light shell under a dark system setting), and a dark one.
const NOTE = { light: true, bg: '#f2e7de', surface: '#ffffff', fg: '#100a05', muted: '#786c61', line: '#e4d6cb', accent: '#9e6630', danger: '#d71921' };
const NIGHT = { light: false, bg: '#1a1410', surface: '#241c16', fg: '#f2e7de', muted: '#a39485', line: '#3a2e25', accent: '#d99a5b', danger: '#ff6b6b' };
const VALUE = /^(#[0-9a-f]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+)\))$/;
const strings = (s) => [...Object.values(s).filter((v) => typeof v === 'string' && v !== s.name), ...s.screen, ...Object.values(s.tones)];

// ---------------------------------------------------------------- the engine
const E = world(['theme.js']), TH = E.R.theme;
const lumOf = (c) => TH.luminance(c), ratio = (a, b) => TH.contrast(a, b);
// Glass is see-through: what's read against is its colour, whatever is behind it.
const solid = (rgbaStr) => { const [r, g, b] = TH.rgb(rgbaStr); return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`; };
const readable = (s, why) => {
  for (const on of [s.bg, s.panel, solid(s.glass)]) {
    assert.ok(ratio(s.ink, on) >= 4.5, `${why}: ink reads on ${on} (${ratio(s.ink, on).toFixed(2)})`);
    assert.ok(ratio(s.text, on) >= 4.5, `${why}: bubble text reads on ${on} (${ratio(s.text, on).toFixed(2)})`);
    assert.ok(ratio(s.ink2, on) >= 4.5, `${why}: second ink reads on ${on} (${ratio(s.ink2, on).toFixed(2)})`);
    assert.ok(ratio(s.ink3, on) >= 3, `${why}: dim text reads on ${on} (${ratio(s.ink3, on).toFixed(2)})`);
  }
  for (const k of ['accent', 'hot', 'mid', 'coral', 'note', 'danger']) assert.ok(ratio(s[k], solid(s.glass)) >= 3, `${why}: ${k} shows on glass (${ratio(s[k], solid(s.glass)).toFixed(2)})`);
  assert.ok(ratio(s.accentInk, s.accent) >= 4.5, `${why}: a filled button's words read (${ratio(s.accentInk, s.accent).toFixed(2)})`);
  for (const [k, v] of Object.entries(s.tones)) assert.ok(ratio(v, solid(s.glass)) >= 3, `${why}: ${k} ink shows on glass (${ratio(v, solid(s.glass)).toFixed(2)})`);
  // The character: five levels, each brighter than the one before, from a dark one to a light one.
  assert.equal(s.led.length, 5);
  const lv = s.led.map((c) => lumOf(`#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`));
  for (let i = 1; i < 5; i++) assert.ok(lv[i] > lv[i - 1] + 0.01, `${why}: LED level ${i} is brighter than ${i - 1} (${lv.map((v) => v.toFixed(3))})`);
  assert.ok(lv[0] < 0.03 && lv[4] > 0.7, `${why}: from dark dots to lit ones (${lv[0].toFixed(3)} … ${lv[4].toFixed(3)})`);
  for (const c of s.led) assert.ok(c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), `${why}: LED levels are colours`);
  for (const v of strings(s)) assert.match(v, VALUE, `${why}: ${v} is a colour`);
};

await rule('Classic is today\'s colours, literal for literal, and the scheme at start', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(TH.schemes.classic)), CLASSIC);
  assert.equal(TH.now, TH.schemes.classic, 'nothing chosen: Classic');
  assert.ok(Object.isFrozen(TH.schemes.classic) && Object.isFrozen(TH.schemes.classic.tones), 'and nothing can change it');
});

await rule('Light and Dark are readable, keep the teal, and are their own', () => {
  const { light, dark, classic } = TH.schemes;
  assert.deepEqual(Object.keys(light).sort(), Object.keys(classic).sort(), 'the same roles as Classic');
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(classic).sort());
  readable(light, 'Light'); readable(dark, 'Dark');
  assert.equal(light.light, true); assert.equal(dark.light, false);
  assert.ok(lumOf(light.bg) > 0.7, 'Light is paper'); assert.ok(lumOf(dark.bg) < 0.05, 'Dark is dark');
  // Warm paper: more red than blue. Graphite: no tint to speak of, where Classic's black is teal.
  const [lr, , lb] = TH.rgb(light.bg), d = TH.rgb(dark.bg), c = TH.rgb(classic.bg);
  assert.ok(lr > lb + 8, 'Light is warm');
  assert.ok(Math.max(...d) - Math.min(...d) <= 6, 'Dark is neutral');
  assert.ok(Math.max(...c) - Math.min(...c) > 10 && dark.bg !== classic.bg && dark.glass !== classic.glass, 'and so not Classic');
  for (const s of [light, dark]) { const [r, g, b] = TH.rgb(s.accent); assert.ok(g > r && b > r && Math.abs(g - b) < 40, `${s.name}: the accent is a teal (${s.accent})`); }
  assert.ok(lumOf(light.accent) < 0.2, 'a dark teal on paper');
});

await rule('a scheme from the desktop\'s note uses its colours and derives the rest', () => {
  const s = TH.fromNote(NOTE);
  assert.equal(s.name, 'note'); assert.equal(s.light, true);
  assert.deepEqual([s.bg, s.panel, s.ink, s.text, s.ink3, s.line, s.accent, s.danger, s.coral], [NOTE.bg, NOTE.surface, NOTE.fg, NOTE.fg, NOTE.muted, NOTE.line, NOTE.accent, NOTE.danger, NOTE.danger]);
  assert.equal(s.glass, 'rgba(242,231,222,0.94)', 'bubbles are the desktop\'s background');
  assert.equal(s.tones.accent, NOTE.accent);
  assert.deepEqual(Object.keys(s).sort(), Object.keys(TH.schemes.classic).sort());
  readable(s, 'a light note');
  // The same note is the same scheme (it is asked for every couple of seconds).
  assert.equal(TH.fromNote({ ...NOTE }), s);
  const n = TH.fromNote(NIGHT);
  assert.deepEqual([n.light, n.bg, n.panel, n.ink, n.ink3, n.line, n.accent, n.danger], [false, NIGHT.bg, NIGHT.surface, NIGHT.fg, NIGHT.muted, NIGHT.line, NIGHT.accent, NIGHT.danger]);
  readable(n, 'a dark note');
  // The character takes the accent's colour, from a dark shade of it to a light one.
  const hue = (c) => { const [r, g, b] = c; return r > g && g > b; };
  assert.ok(s.led.slice(1, 4).every(hue) && n.led.slice(1, 4).every(hue), 'an amber accent makes amber dots');
  // And it is a pure function of the note: made again, it is the same colours.
  assert.deepEqual(JSON.parse(JSON.stringify(TH.fromNote(NOTE))), JSON.parse(JSON.stringify(s)));
  // A note whose own colours can't be read against each other is made readable rather than trusted.
  readable(TH.fromNote({ light: true, bg: '#ffffff', fg: '#eeeeee', muted: '#f4f4f4', accent: '#fafafa', danger: '#ffeeee' }), 'white on white');
  readable(TH.fromNote({ light: false, bg: '#000000', fg: '#111111', muted: '#0a0a0a', accent: '#050505', danger: '#100000' }), 'black on black');
});

await rule('a missing or malformed colour falls back to the fixed scheme\'s, and nothing else gets in', () => {
  const { light, dark, classic } = TH.schemes;
  assert.equal(TH.fromNote({ light: true }), light, 'no colours: the fixed Light');
  assert.equal(TH.fromNote({ light: false }), dark);
  const bad = { light: true, bg: '#f2e7de', surface: 'white', fg: 'red', muted: '#12345g', line: 'url(javascript:alert(1))', accent: '#fff', danger: '#d71921;" onload="x' };
  const s = TH.fromNote(bad);
  assert.equal(s.bg, '#f2e7de', 'the good one is used');
  assert.deepEqual([s.panel, s.ink, s.ink3, s.line, s.accent, s.danger], [light.panel, light.ink, light.ink3, light.line, light.accent, light.danger], 'the rest are Light\'s');
  for (const v of strings(s)) assert.match(v, VALUE);
  assert.doesNotMatch(strings(s).join(' '), /red|white|url|alert|onload|12345g|["';]/);
  assert.equal(strings(s).includes('#fff'), false);
  for (const v of [7, null, ['#000000'], { r: 1 }, '#F2E7DE ', ' #f2e7de', '#f2e7de\n', 'rgb(1,2,3)', '#f2e7deff']) assert.equal(TH.fromNote({ light: false, bg: v }), dark, `${JSON.stringify(v)} is no colour`);
  assert.equal(TH.fromNote({ light: true, bg: '#F2E7DE' }).bg, '#f2e7de', 'capitals are the same colour');
  // Not a note at all: light has to be said, as true or false.
  for (const n of [null, undefined, 3, 'light', [], {}, { light: 'true' }, { light: 1 }, { light: null, bg: '#000000' }]) assert.equal(TH.fromNote(n), null, JSON.stringify(n));
  // What a setting or a reply comes to: a scheme by name, a note, and Classic for anything else.
  assert.equal(TH.resolve('classic'), classic); assert.equal(TH.resolve('light'), light); assert.equal(TH.resolve('dark'), dark);
  assert.equal(TH.resolve({ light: true }), light); assert.equal(TH.resolve(NOTE), TH.fromNote(NOTE));
  for (const x of [undefined, null, 'system', 'note', 'Light', 4, {}, { light: 'yes' }]) assert.equal(TH.resolve(x), classic, JSON.stringify(x));
});

await rule('the scheme changes while it runs, and whoever keeps something hears about it', () => {
  const w = world(['theme.js']), T = w.R.theme, heard = [];
  const stop = T.onChange((s) => heard.push(s.name));
  assert.equal(w.R.setTheme('light'), true); assert.equal(T.now, T.schemes.light); assert.equal(T.rev, 1);
  assert.equal(w.R.setTheme('light'), false, 'the same again is no change'); assert.equal(T.rev, 1);
  assert.equal(w.R.setTheme(NOTE), true); assert.equal(T.now.bg, NOTE.bg);
  assert.equal(w.R.setTheme({ ...NOTE }), false, 'nor is the same note');
  assert.equal(w.R.setTheme({ ...NOTE, accent: '#0c6b66' }), true, 'one colour of it changing is');
  assert.equal(w.R.setTheme('nonsense'), true); assert.equal(T.now, T.schemes.classic);
  assert.deepEqual(heard, ['light', 'note', 'note', 'classic']);
  stop(); w.R.setTheme('dark');
  assert.equal(heard.length, 4, 'until it stops listening');
  // One listener failing doesn't keep the others from hearing.
  T.onChange(() => { throw new Error('x'); }); T.onChange((s) => heard.push(`also ${s.name}`));
  const err = console.error; console.error = noop; w.R.setTheme('light'); console.error = err;
  assert.equal(heard.at(-1), 'also light');
});

await rule('System asks the desktop now and every couple of seconds; Classic asks nothing', async () => {
  const w = world(['theme.js']), T = w.R.theme;
  let asked = 0, reply = { light: true };
  const ask = () => { asked++; return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply); };
  T.follow('classic', ask); await w.tick(200);
  assert.equal(asked, 0, 'Classic: nothing asked'); assert.equal(w.timers().length, 0, 'and nothing waiting to ask');
  assert.equal(T.now, T.schemes.classic);
  T.follow('system', ask); await w.tick(1);
  assert.equal(asked, 1, 'System: asked at once'); assert.equal(T.now, T.schemes.light, 'no note: the fixed scheme for the desktop\'s setting');
  await w.tick(130);
  assert.equal(asked, 2, 'and again about two seconds later');
  reply = NIGHT; await w.tick(130);
  assert.equal(T.now.bg, NIGHT.bg, 'a note that appears is used on the next ask');
  reply = { light: false }; await w.tick(130);
  assert.equal(T.now, T.schemes.dark, 'and when it goes, the fixed scheme again');
  // The shell not answering, or answering nonsense, changes nothing.
  reply = new Error('no shell'); await w.tick(130); assert.equal(T.now, T.schemes.dark);
  reply = { light: 'dark' }; await w.tick(130); assert.equal(T.now, T.schemes.dark);
  reply = 'classic'; await w.tick(130); assert.equal(T.now, T.schemes.dark);
  // Back to Classic: at once, and a reply still on its way is dropped.
  reply = NOTE; const before = asked;
  T.follow('system', ask); T.follow('classic', ask); await w.tick(200);
  assert.equal(T.now, T.schemes.classic); assert.equal(asked, before + 1, 'nothing more is asked'); assert.equal(w.timers().length, 0);
  // Anything that isn't "system" is Classic.
  for (const s of [undefined, null, 'dark', 'System', 1]) { T.follow('system', ask); T.follow(s, ask); await w.tick(2); assert.equal(T.now, T.schemes.classic, String(s)); assert.equal(w.timers().length, 0); }
});

await rule('a page gets the scheme as CSS variables', () => {
  const w = world(['theme.js']), T = w.R.theme;
  const v = { ...T.cssVars() };
  for (const [k, val] of Object.entries(WAS.vars)) assert.equal(v[k], val, `${k} on Classic`);
  const el = { vars: {}, style: { setProperty(k, x) { el.vars[k] = x; } } };
  T.apply(el);
  assert.deepEqual(el.vars, v, 'apply() sets every one on the element');
  T.apply(el, T.fromNote(NOTE));
  assert.equal(el.vars['--bg'], NOTE.bg); assert.equal(el.vars['--accent'], NOTE.accent); assert.equal(el.vars['--bg-rgb'], '242, 231, 222');
  for (const [k, val] of Object.entries(el.vars)) assert.match(val, /^(#[0-9a-f]{6}|rgba\(\d+,\d+,\d+,[\d.]+\)|\d+, \d+, \d+)$/, `${k}: ${val}`);
  assert.deepEqual(Object.keys(el.vars).sort(), Object.keys(v).sort());
});

// ---------------------------------------------------------------- the overlay draws with the scheme in use
const ENV = () => ({ w: 1200, h: 800, dpr: 1, t: 0, unit: 340, margin: 0.05, curiosity: 0.3, transparent: true, safe: { top: 0, right: 0, bottom: 0, left: 0 }, mouse: { x: -1, y: -1, active: false } });
const DT = 1 / 60;
// The Sidekick as the desktop makes it, and a way to run it for n frames.
const stage = (w) => {
  const env = ENV(), def = w.R.types.find((d) => d.id === 'sidekick'), c = def.create(env), cv = w.mk2d();
  c.resize(env);
  const run = async (n) => { for (let i = 0; i < n; i++) { env.t += DT; await w.tick(); c.update(DT, env); c.prepare(env); c.draw(cv, env); } };
  const pixels = () => { const d = w.img().data, s = new Set(); for (let i = 0; i < d.length; i += 4) if (d[i + 3]) s.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); return [...s].sort(); };
  return { env, def, c, a: c.agent, run, pixels };
};
const ledOf = (s) => Array.from(s.led, (c) => c.join(',')).sort();
// Nothing of Classic is left in what was drawn (a scheme that shares none of its colours), and its own are there.
const none = (got, was, why) => { const left = got.filter((s) => !PLAIN(s) && was.includes(s)); assert.deepEqual(left, [], `${why}: still Classic's ${left}`); };

await rule('the character: Classic\'s dots, the scheme\'s after a switch, Classic\'s again after switching back', async () => {
  const w = world(), T = w.R.theme, { c, a, def, run, pixels } = stage(w);
  assert.equal(def.bg, 'rgb(4,16,18)');
  a.show({ summoned: true }); await run(90);
  assert.deepEqual(pixels(), WAS.pixels, 'Classic');
  const same = c, note = T.fromNote(NOTE);
  w.R.setTheme(NOTE); await run(1);
  assert.deepEqual(pixels(), ledOf(note), 'the very next frame is the new scheme\'s');
  assert.equal(pixels().some((p) => WAS.pixels.includes(p)), false);
  assert.equal(def.bg, `rgb(${note.led[0].join(',')})`);
  assert.equal(c, same);
  w.R.setTheme('dark'); await run(1); assert.deepEqual(pixels(), ledOf(T.schemes.dark));
  w.R.setTheme('classic'); await run(1);
  assert.deepEqual(pixels(), WAS.pixels, 'and Classic again, exactly');
  // Hidden while the scheme changes: it comes back in the new one.
  a.hide({ instant: true }); await run(5); w.R.setTheme('light'); await run(5); a.show({ summoned: true }); await run(90);
  assert.deepEqual(pixels(), ledOf(T.schemes.light));
});

await rule('a creature with its own palette draws as it always did', async () => {
  const w = world(), env = ENV();
  const pal = [[1, 2, 3], [40, 50, 60], [90, 100, 110], [150, 160, 170], [240, 250, 255]];
  const def = w.R.ditherKit({ id: 't', label: 'T', matrix: true, pixel: 1.3, glow: 0.55, pal });
  assert.equal(def.bg, 'rgb(1,2,3)'); assert.equal(w.R.ditherKit({ id: 'u', label: 'U', bg: '#0f380f', pal }).bg, '#0f380f');
  const c = def.create(env); c.resize(env);
  const frame = () => { c.update(DT, env); c.prepare(env); c.draw(w.mk2d(), env); const d = w.img().data, s = new Set(); for (let i = 0; i < d.length; i += 4) if (d[i + 3]) s.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); return [...s].sort(); };
  for (let i = 0; i < 30; i++) frame();
  const before = frame();
  assert.ok(before.length >= 3 && before.every((p) => pal.some((q) => q.join(',') === p)), `its own levels (${before})`);
  w.R.setTheme('light');
  assert.deepEqual(frame(), before, 'and the scheme is not its business');
});

await rule('glass (bubbles, tags, chips): Classic as it was, then the scheme\'s', () => {
  const w = world(['theme.js', 'glass.js']), G = w.R.glass, c = w.mk2d(), T = w.R.theme;
  const draw = () => {
    const o = {}; w.seq();
    G.chrome(c, 10, 10, 200, 60); o.chrome = w.seq();
    G.chrome(c, 10, 10, 200, 60, { edge: G.CORAL, glint: false }); o.chromeFail = w.seq();
    G.typed(c, 'hello world', 0, 0, '400 12px x', G.TEXT, 0.5); o.typedHalf = w.seq();
    G.typed(c, 'hello world', 0, 0, '400 12px x', G.DIM, 1); o.typedFull = w.seq();
    G.pen(c, [[0, 0], [5, 5], [9, 2]], G.MID, 2.2, 1); o.pen = w.seq();
    G.chip(c, 0, 0, 80, 23, 'Allow', { filled: true }); o.chipFilled = w.seq();
    G.chip(c, 0, 0, 80, 23, 'Allow', { filled: true, hover: true, focus: true, down: true }); o.chipFilledHover = w.seq();
    G.chip(c, 0, 0, 80, 23, 'No'); o.chip = w.seq();
    G.chip(c, 0, 0, 80, 23, 'No', { hover: true }); o.chipHover = w.seq();
    return o;
  };
  const names = ['chrome', 'chromeFail', 'typedHalf', 'typedFull', 'pen', 'chipFilled', 'chipFilledHover', 'chip', 'chipHover'];
  const was = draw();
  for (const k of names) assert.deepEqual(was[k], WAS[k], `${k} on Classic`);
  assert.deepEqual(['ACC', 'HOT', 'MID', 'DEEP', 'EDGE', 'GLASS', 'TEXT', 'DIM', 'CORAL', 'NOTE'].map((k) => G[k]), ['#78ffe2', '#e6fffa', '#28c4b8', '#0e5c60', 'rgba(3,39,34,0.6)', 'rgba(6,22,24,0.94)', '#dcfff6', '#8ab8b0', '#ff8a7a', '#e9a196']);
  assert.equal(G.rgba('#78ffe2', 0.5), 'rgba(120,255,226,0.5)'); assert.equal(G.CHIP_H, 23);
  w.R.setTheme('light');
  const L = T.schemes.light, now = draw();
  for (const k of names) none(now[k], WAS[k], k);
  assert.deepEqual(now.chrome, [L.glass, 'rgba(0,0,0,0.35)', T.rgba(L.accent, 0.7), L.accent, '#ffffff']);
  assert.deepEqual(now.typedHalf, [L.text, L.flash], 'fresh letters land in a colour that shows on paper');
  assert.deepEqual(now.pen, [L.edge, T.rgba(L.mid, 0.7), L.mid]);
  assert.deepEqual(now.chip, ['rgba(0,0,0,0.45)', L.glass, L.accent, L.text]);
  assert.equal(now.chipFilled.at(-1), L.accentInk);
  assert.deepEqual([G.ACC, G.DIM, G.GLASS], [L.accent, L.ink3, L.glass]);
  w.R.setTheme('classic');
  assert.deepEqual(draw(), was, 'and back');
});

await rule('speech and thought bubbles, questions, task tags and the step list', async () => {
  const w = world(), T = w.R.theme, { a, run } = stage(w);
  const scenes = async () => {
    const o = {};
    a.show({ summoned: true }); await run(90); w.take();
    a.say('Hello **there**, see `code` and [a link](https://example.com) now.'); await run(150); o.say = w.take();
    a.hush(); await run(60); w.take();
    a.think('thinking about it'); await run(60); o.think = w.take();
    a.hush(); await run(60); w.take();
    const h = a.prompt({ placeholder: 'Allow this?', choices: ['Allow', 'No'], onChoose() {} }); await run(80); o.prompt = w.take();
    h.close(); await run(60); w.take();
    const p = a.prompt({ placeholder: 'Type here' }); p.focus(true); await run(80); o.input = w.take();
    p.close(); await run(60); w.take();
    const t = a.tool('read', { label: 'reading', detail: 'notes.md' }); await run(40); o.tool = w.take();
    t.done(false); await run(30); o.toolFail = w.take();
    await run(120); w.take();
    a.cards.trail({ head: 'Your request', steps: [{ text: 'Open the notes', state: 'ok' }, { text: 'Read them', state: 'now' }, { text: 'Send the email', state: 'bad', why: 'No account' }, { text: 'Tidy up', state: 'todo' }] });
    await run(120); o.trail = w.take();
    a.cards.trail({ steps: [], final: true }); a.hide({ instant: true }); await run(400); w.take();
    return o;
  };
  const names = ['say', 'think', 'prompt', 'input', 'tool', 'toolFail', 'trail'];
  const was = await scenes();
  for (const k of names) assert.deepEqual(was[k], WAS[k], `${k} on Classic`);
  w.R.setTheme(NOTE);
  const S = T.now, now = await scenes();
  for (const k of names) { none(now[k], WAS[k], k); assert.ok(now[k].includes(S.glass), `${k}: on the scheme's glass`); assert.equal(now[k].length, WAS[k].length, `${k}: as many colours as before (${now[k]})`); }
  assert.ok(now.say.includes(S.text) && now.say.includes(S.accent) && now.say.includes(S.hot));
  assert.ok(now.input.includes(T.rgba(S.mid, 0.9)) && now.input.includes(T.rgba(S.hot, 1)), 'the placeholder and the caret');
  assert.ok(now.toolFail.includes(S.coral) && now.trail.includes(S.note) && now.trail.includes(S.faint) && now.trail.includes(T.rgba(S.accent, 0.06)));
});

await rule('a bubble that is open changes with the scheme', async () => {
  const w = world(), T = w.R.theme, { a, run } = stage(w);
  a.show({ summoned: true }); await run(90);
  a.say('Still here.'); await run(50); w.take();
  await run(2); assert.ok(w.take().includes(CLASSIC.glass));
  w.R.setTheme('dark'); await run(1);
  const got = w.take();
  assert.ok(got.includes(T.schemes.dark.glass) && got.includes(T.schemes.dark.text), `the next frame (${got})`);
  assert.equal(got.includes(CLASSIC.glass) || got.includes(CLASSIC.text), false);
});

await rule('drawings, the reminders card and the pen', async () => {
  const w = world(), T = w.R.theme;
  const list = { today: [{ id: 'a', text: 'Send the launch email', when: '10:00' }, { id: 'b', text: 'Book the dentist', when: '09:00', overdue: true }], later: [{ id: 'c', text: 'Call Ana', done: true }], seconds: 60 };
  w.take();
  w.R.ink.reminders(list); await w.tick(120);
  assert.deepEqual(w.take(), WAS.reminders, 'the reminders card on Classic');
  // It is still open: the next thing painted is the new scheme's.
  w.R.setTheme(NOTE); await w.tick(3);
  const S = T.now, got = w.take();
  none(got, WAS.reminders, 'an open card'); assert.equal(got.length, WAS.reminders.length, `as many colours as before (${got})`);
  for (const k of ['glass', 'text', 'accent', 'ink3', 'mid', 'deep', 'edge']) assert.ok(got.includes(S[k]), `${k} (${S[k]}) in ${got}`);
  assert.ok(got.includes(S.tones.coral), 'what is late keeps its tone, made to show on this glass');
  w.R.setTheme('classic'); await w.tick(3);
  assert.deepEqual(w.take(), WAS.reminders, 'and back to Classic');
  // The user's pen (Windows): its line and glow.
  const p = world(['theme.js', 'glass.js', 'pen.js']);
  const stroke = async () => { p.R.pen({ ev: 'start', x: 10, y: 10 }); p.R.pen({ ev: 'pt', x: 30, y: 30 }); p.R.pen({ ev: 'pt', x: 50, y: 10 }); await p.tick(3); return p.take(); };
  assert.deepEqual(await stroke(), WAS.userPen);
  p.R.setTheme('light'); await p.tick(2);
  const L = p.R.theme.schemes.light;
  assert.deepEqual(p.take(), [L.accent, p.R.theme.rgba(L.accent, 0.75), L.edge].sort(), 'a line already drawn is repainted');
  p.R.setTheme('classic'); await p.tick(2); assert.deepEqual(p.take(), WAS.userPen);
});

await rule('the research card takes its colours from the scheme', async () => {
  const w = world(), T = w.R.theme;
  w.R.panel.open({ status: 'Searching the web' }); await w.tick(3);
  const card = w.els.find((e) => e.className === 'rp');
  assert.ok(card, 'the card');
  for (const [k, v] of Object.entries(WAS.vars)) assert.equal(card.vars[k], v, `${k} on Classic`);
  w.R.setTheme(NOTE);
  assert.equal(card.vars['--bg'], NOTE.bg, 'at once, while it is open'); assert.equal(card.vars['--ink'], NOTE.fg); assert.equal(card.vars['--accent'], NOTE.accent);
  w.R.setTheme('classic');
  for (const [k, v] of Object.entries(WAS.vars)) assert.equal(card.vars[k], v, `${k} back on Classic`);
  // Its CSS holds no colour of its own: variables, and the black shadow.
  const src = read('../../../roamies/agent-panel.js'), css = src.slice(src.indexOf('const css = `'), src.indexOf('`;'));
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
  assert.deepEqual((css.match(/rgba?\([^)]*\)/g) ?? []).filter((c) => !/var\(--[a-z-]+\)/.test(c) && !/^rgba\(0, 0, 0,/.test(c)), []);
  for (const v of css.match(/var\(--[a-z0-9-]+\)/g)) assert.ok(v === 'var(--s)' || v === 'var(--ease)' || v === 'var(--notch)' || v.slice(4, -1) in T.cssVars(), `${v} is one the engine sets`);
});

await rule('one place for the colours: no overlay file keeps its own', () => {
  // Colour literals left in the converted files, apart from the plain ones (white glints, black shadows, the letter
  // mask) and the gallery's own "Dither blob" creature, which isn't the Sidekick.
  const plain = /^(#fff|#ffffff|#000000|rgba\(0, ?0, ?0, ?0?\.\d+\)|rgba\(255,255,255,0\.\d+\))$/;
  for (const f of ['12-sidekick.js', '10-dither.js', 'glass.js', 'agent.js', 'agent-cards.js', 'agent-panel.js', 'ink.js', 'pen.js', 'host.js']) {
    let src = read(`../../../roamies/${f}`);
    if (f === '10-dither.js') src = src.slice(0, src.indexOf("id: 'dither', label: 'Dither blob'"));
    const lits = [...(src.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z])/g) ?? []), ...(src.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g) ?? [])].filter((c) => !plain.test(c));
    assert.deepEqual(lits, [], `${f} still has ${lits}`);
    assert.doesNotMatch(src, /\[\[4, 16, 18\]/, `${f}: no copy of the LED levels`);
  }
  // The engine is loaded before anything that draws, on every page.
  const page = read('../../../desktop.html'), at = (f) => page.indexOf(`roamies/${f}`);
  assert.ok(at('core.js') > 0 && at('theme.js') > at('core.js'), 'after core.js');
  for (const f of ['glass.js', 'agent.js', 'agent-cards.js', 'agent-panel.js', '10-dither.js', '12-sidekick.js', 'ink.js', 'pen.js', 'host.js']) assert.ok(at('theme.js') < at(f), `before ${f}`);
  for (const p of ['../../../panel/index.html', '../../../onboarding/index.html']) {
    const html = read(p), i = html.indexOf('roamies/theme.js');
    assert.ok(i > html.indexOf('roamies/core.js') && i < html.indexOf('roamies/10-dither.js'), `${p} loads it after core.js, before the renderer`);
  }
});

// ---------------------------------------------------------------- the setting
await rule('the setting: Classic unless System was picked', () => {
  assert.deepEqual(THEMES, [['classic', 'Classic'], ['system', 'System']]);
  assert.equal(themeOf('system'), 'system'); assert.equal(themeOf('classic'), 'classic');
  for (const v of [undefined, null, '', 'System', 'light', 'dark', 'note', 'auto', 0, 1, true, ['system'], { theme: 'system' }]) assert.equal(themeOf(v), 'classic', `${JSON.stringify(v)} is Classic`);
});

await rule('the setting is saved, shown on the Appearance page and reaches the overlay', () => {
  // Read from the source (sidekick.mjs runs the app when loaded, so it can't be called here).
  const side = read('../sidekick.mjs');
  assert.match(side, /const DEFAULTS = \{[^}]*\btheme: 'classic',/, 'Classic by default, with the other settings');
  assert.match(side, /else if \(id\.startsWith\('theme:'\) && THEMES\.some\(\(\[t\]\) => t === id\.slice\(6\)\)\) \{ config\.theme = id\.slice\(6\); saveConfig\(\); ui\(\{ kind: 'theme', theme: config\.theme \}\); menu\(\); \}/, 'only a listed choice is saved, and the overlay is told at once');
  const ready = side.slice(side.indexOf("m.type === 'ui_ready'"), side.indexOf("if (config.onboarded) ui({ kind: 'greet' })"));
  assert.match(ready, /ui\(\{ kind: 'theme', theme: themeOf\(config\.theme\) \}\);/, 'an overlay that starts is told, like its look and size');
  assert.match(ready, /ui\(\{ kind: 'size', size: sizeNow\(\) \}\);\n\s+ui\(\{ kind: 'look', look: config\.look \?\? 'classic' \}\);/, 'which are as they were');
  assert.match(side, /theme: themeOf\(config\.theme\), themes: THEMES,/, 'the panel is told the choice and the choices');
  assert.match(side, /else if \(id\.startsWith\('size:'\) && SIZES\.some\(\(\[s\]\) => s === id\.slice\(5\)\)\) \{ config\.size = id\.slice\(5\); saveConfig\(\); ui\(\{ kind: 'size', size: config\.size \}\); menu\(\); \}/, 'the Size choice is untouched');
  // The panel's Appearance page: the picker, with Look and Size.
  const panel = read('../../../panel/panel.js');
  const page = panel.slice(panel.indexOf('function appearancePage()'), panel.indexOf('// The looks as live tiles'));
  // (Look has a tab to itself since the page outgrew the panel; Size shares the other with Colors: theme-pages.test.mjs.)
  assert.match(page, /group\('Look', 'Each look has its own name and voice\.', null, lookTiles\(\)\),/, 'Look as it was');
  assert.match(page, /group\('Size', 'How big I am on your screen\.', null, picks\('Size', state\.sizes, state\.size, \(x\) => act\(`size:\$\{x\}`\), 'size'\)\),/, 'Size as it was');
  assert.match(page, /group\('Colors', [^\n]*, null, picks\('Colors', state\.themes, state\.theme, \(x\) => act\(`theme:\$\{x\}`\), 'theme'\)\)/, 'the picker');
  // The overlay: on System it follows what the shell says; the shell's answer is one command.
  const host = read('../../../roamies/host.js');
  assert.match(host, /if \(m\.kind === 'theme'\) \{ Roamie\.theme\.follow\(m\.theme, \(\) => invoke\('theme_get'\)\); return; \}/);
  assert.ok(host.indexOf("m.kind === 'theme'") < host.indexOf('if (!getAgent()) return;'), 'with or without a Roamie on this screen');
  assert.ok(host.indexOf("m.kind === 'theme'") > host.indexOf('window.__roamieHost = (m) =>'), 'in the message handler, on every platform');
  const shell = read('../../src-tauri/src/main.rs');
  assert.match(shell, /generate_handler!\[[^\]]*\bset_hit_rects, theme_get, dock_get, dock_state, talk_state, sidecar_send,/, 'the command is registered');
  assert.match(shell, /#\[tauri::command\]\nfn theme_get\(window: WebviewWindow\) -> Value \{/);
});

if (failed.length) { console.error(`theme tests: ${failed.length} failed`); process.exit(1); }
console.log('theme tests: passed');
