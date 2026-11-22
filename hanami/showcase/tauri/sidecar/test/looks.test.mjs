import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE } from '../fish.mjs';

// Every look the app offers has a drawing and its voice; the setup guide offers the same looks.
const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const side = src('../sidekick.mjs'), guide = src('../../../onboarding/onboarding.js');
const looks = [...side.slice(side.indexOf('const LOOKS = ['), side.indexOf('];', side.indexOf('const LOOKS = ['))).matchAll(/\['(\w+)', '([^']+)', (DEFAULT_VOICE|'(\w+)')\]/g)];
assert.deepEqual(looks.map((m) => m[1]), ['classic', 'jarvis', 'anime', 'sarah', 'adrian']);
const voices = Object.fromEntries(looks.map((m) => [m[1], m[4] ?? null]));
assert.equal(voices.classic, null, 'Roamie uses DEFAULT_VOICE');
assert.equal(DEFAULT_VOICE, '2680da81de8348a68e1f4dbaa79272f1');
assert.equal(voices.jarvis, 'e13fa398a7f445a685316a3de6089ce7');
// Regression: Roamie spoke with JARVIS's voice (the default was JARVIS's ID).
assert.equal(new Set([DEFAULT_VOICE, ...Object.values(voices).filter(Boolean)]).size, 5, 'every look has its own voice');
assert.ok(!/config\.fishVoice/.test(side), 'a saved fishVoice (the old JARVIS default) is never used');
assert.equal(voices.anime, 'd8f3b4c1199f4568a767ec54112d2b17');
assert.equal(voices.sarah, '933563129e564b19a115bedd57b7406a');
assert.equal(voices.adrian, 'bf322df2096a46f18c579d0baa36f41d');
for (const [, id, label] of looks) assert.ok(guide.includes(`['${id}', '${label}']`), `the setup guide offers ${label}`);

// The characters draw at every size without throwing, inside their area, and the sprites are well formed.
const warns = [];
globalThis.window = { Roamie: {} };
const warn = console.warn; console.warn = (m) => warns.push(m);
new Function(src('../../../roamies/people.js'))();
console.warn = warn;
assert.deepEqual(warns, [], 'every sprite row is half or whole width');
const P = window.Roamie.people;
const th = () => 0.5;
// ken: Ken Kai, on the About page (drawn the same way, though not a look you can pick).
for (const who of ['anime', 'sarah', 'adrian', 'ken']) for (const size of ['default', 'small', 'cursor']) for (const state of [{}, { mode: 'talk', voice: 0.9 }, { happy: 1 }, { open: 0 }, { dizzy: 1 }, { sleepy: 1 }, { act: 'hype', actA: 0.2 }, { act: 'upset', actA: 0.1 }]) {
  const cells = [];
  const k = { put: (x, y, l) => { assert.ok(Number.isInteger(x) && Number.isInteger(y) && l >= 0 && l <= 4, `${who} ${size} cell`); cells.push([x, y]); }, L: 4, th };
  const st = { t: 1, mode: null, voice: null, act: null, actA: 0, open: 1, look: [0.5, -0.3], vx: 0, sq: 0, wide: 0, dizzy: 0, happy: 0, sleepy: 0, mouth: null, brow: null, ...state };
  if (size === 'cursor') P[who].cursor(k, 50, 50, 46, 43, st); else P[who].body(k, 50, 50, size === 'small' ? 6.4 : 12.75, st);
  assert.ok(cells.length > 40, `${who} ${size} draws`);
  const span = Math.max(...cells.map(([x]) => x)) - Math.min(...cells.map(([x]) => x));
  assert.ok(span < (size === 'default' ? 40 : 24), `${who} ${size} stays its size (${span})`);
}
assert.ok(!looks.some((m) => m[1] === 'ken'), 'Ken is not a pickable look');
console.log('looks tests: passed');

// Regression: a selected stage canvas showed as a grey box around the Roamie (WebKit tints selected canvases).
assert.match(src('../../../desktop.html'), /canvas \{[^}]*-webkit-user-select: none; user-select: none;[^}]*\}/);

// Regression: after a drawing the Sidekick stopped following the cursor and hopped away from it instead.
{
  const agent = src('../../../roamies/agent.js'), rel = agent.slice(agent.indexOf('async release()'), agent.indexOf('place: (x, y) =>'));
  assert.match(agent, /pen\.follow = !!station\.byCursor/, 'take() remembers whether it was following the cursor');
  assert.match(rel, /if \(pen\.follow && presence\.ptr\) station\.byCursor = presence\.ptr\.slice\(\)/, 'release() goes back to following');
}

// The bubbles, tags and step list draw with glass.js, so the overlay loads it before them.
{
  const page = src('../../../desktop.html'), at = (f) => page.indexOf(`roamies/${f}`);
  assert.ok(at('glass.js') > 0 && at('glass.js') < at('agent.js') && at('glass.js') < at('agent-cards.js'), 'desktop.html loads glass.js before agent.js and agent-cards.js');
}

// The native panel's sprite sheets (roamies/looksheet.js): each look drawn by the real kit into one strip of frames,
// muted while it's drawn, and drawn again only when the colours changed (the shell says which sheets it holds).
{
  const vm = await import('node:vm');
  const noop = () => {};
  const canvases = [], draws = [], invokes = [], played = [];
  let lit = 0;
  const ctx2d = (cv) => new Proxy({}, {
    get: (_, k) => (k === 'createImageData' ? (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      : k === 'getImageData' ? (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
      : k === 'putImageData' ? (img) => { for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) { lit++; break; } }
      : k === 'drawImage' ? (src, x, y) => draws.push({ to: cv, from: src, x, y })
      : k === 'measureText' ? (s) => ({ width: String(s).length * 7 })
      : noop),
    set: () => true,
    has: (_, k) => k === 'filter',
  });
  const el = () => { const cv = { width: 0, height: 0, style: {}, getContext: () => ctx2d(cv), toDataURL: () => `data:image/png;base64,STRIP${canvases.indexOf(cv)}` }; canvases.push(cv); return cv; };
  let seed = 7;
  const M = Object.create(Math); M.random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const window = { __TAURI__: { core: { invoke: async (cmd, args) => { invokes.push([cmd, args]); } } } };
  const ctx = {
    window, Math: M, Map, Set, Promise, console, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams, JSON,
    performance: { now: () => 0 }, setTimeout: (f) => setImmediate(f), clearTimeout: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
    addEventListener: noop, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, requestAnimationFrame: noop,
    Path2D: class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} },
    document: { addEventListener: noop, createElement: el, body: { appendChild: noop }, head: { appendChild: noop }, getElementById: () => null },
  };
  vm.createContext(ctx);
  const load = (f) => vm.runInContext(src(`../../../roamies/${f}`), ctx, { filename: f });
  load('core.js');
  vm.runInContext('var Roamie = window.Roamie;', ctx);
  for (const f of ['theme.js', 'jarvis.js', 'people.js', '10-dither.js', 'looksheet.js']) load(f);
  const R = window.Roamie;
  const sfx = { play: (n) => played.push(n) };
  R.sfx = sfx;
  for (const [look, form] of [['classic', 'default'], ['anime', 'small'], ['jarvis', 'cursor'], ['ken', 'default']]) {
    draws.length = 0; lit = 0;
    const out = R.lookSheet(look, form);
    assert.equal(out.frames, 96, `${look}: 96 frames`);
    assert.equal(out.fps, 12);
    assert.deepEqual([out.width, out.height, out.scale], [208, 152, 2], 'one frame: the web tile (104×76) at 2x');
    assert.equal(out.columns, 12);
    assert.deepEqual([out.canvas.width, out.canvas.height], [208 * 12, 152 * 8], `${look}: one sheet, 8 rows of 12 frames`);
    const onStrip = draws.filter((d) => d.to === out.canvas);
    assert.deepEqual(onStrip.map((d) => [d.x, d.y]), Array.from({ length: 96 }, (_, i) => [(i % 12) * 208, Math.floor(i / 12) * 152]), `${look} ${form}: each frame in its place`);
    assert.ok(lit >= 96, `${look} ${form}: the kit drew dots in every frame (${lit})`);
  }
  assert.deepEqual(played, [], 'no sounds while a sheet is drawn');
  assert.equal(R.sfx, sfx, 'the sounds are back after');
  assert.match(src('../../../desktop.html'), /roamies\/10-dither\.js"><\/script>\s*<script src="roamies\/looksheet\.js">/, 'the overlay loads it after the kit');

  // The shell's request: a look whose sheet the shell holds with today's colours isn't drawn again.
  const sig = R.lookSig();
  window.__roamieLooks({ form: 'small', looks: ['classic', 'sarah'], have: { classic: sig, sarah: 'old' } });
  for (let i = 0; i < 20 && invokes.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(invokes.map(([c, a]) => [c, a.look, a.form, a.sig, a.frames, a.columns, a.fps, a.width, a.height]),
    [['look_sheet', 'classic', 'small', sig, 96, 12, 12, 208, 152], ['look_sheet', 'sarah', 'small', sig, 96, 12, 12, 208, 152]]);
  assert.equal(invokes[0][1].png, null, 'held with the same colours: no PNG');
  assert.match(invokes[1][1].png, /^STRIP\d+$/, 'drawn again: its PNG, base64 without the data: prefix');
  R.theme.set('light');
  assert.notEqual(R.lookSig(), sig, 'other colours, another signature');
  console.log('look sheet tests: passed');
}
