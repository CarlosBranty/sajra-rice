// A typed question and the keyboard (showcase/roamies/host.js): the overlay asks the shell for the keyboard while a
// question is open (set_typing) and must give it back whenever the question goes, however it goes. On a Wayland
// layer surface the keyboard is exclusive meanwhile, so one forgotten release locks typing everywhere. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const noop = () => {};
const ctx2d = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : noop), set: () => true });
const calls = [];
const sent = [];
const invoke = (cmd, args) => { if (cmd === 'set_typing') calls.push(args.on); if (cmd === 'sidecar_send') sent.push(args.msg); return Promise.resolve(cmd === 'dock_get' ? null : undefined); };
const el = () => ({ style: {}, attrs: {}, value: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(t, f) { (this.on ??= {})[t] = f; }, focus: noop, blur: noop, getContext: () => ctx2d });
const field = el();
const window = { __TAURI__: { core: { invoke } }, ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true };
const ctx = {
  window, Math, Map, Set, Promise, performance, console, setTimeout, clearTimeout, setInterval: noop, clearInterval: noop, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams, Date,
  navigator: { platform: 'Linux' }, innerWidth: 1200, innerHeight: 800, Event: class {}, dispatchEvent: noop, requestAnimationFrame: noop, Image: class {},
  matchMedia: () => ({ matches: false, addEventListener: noop }), addEventListener: noop,
  document: { addEventListener: noop, body: { appendChild: noop }, createElement: (t) => (t === 'input' ? field : el()) },
  ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
};
vm.createContext(ctx);
const load = (f) => vm.runInContext(fs.readFileSync(new URL(`../../../roamies/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
load('core.js');
vm.runInContext('var Roamie = window.Roamie;', ctx);
for (const f of ['theme.js', 'glass.js', '10-dither.js', 'agent.js']) load(f);
const R = window.Roamie;
const W = 1200, H = 800;
const env = { w: W, h: H, dpr: 1, t: 0, unit: 400, margin: 0.05, curiosity: 0.3, transparent: true, safe: { top: 46, right: 0, bottom: 0, left: 0 }, mouse: { x: -1, y: -1, active: false } };
const PAL = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
const c = R.ditherKit({ id: 't', label: 'T', matrix: true, pixel: 1.3, pal: PAL, plugin: (kit) => R.agentPlugin(kit) }).create(env);
c.vanish(null, true);
R.tiles = [{ creature: c }];
vm.runInContext('for (const k of Object.keys(window)) if (!(k in globalThis)) globalThis[k] = window[k];', ctx);
load('host.js');
const host = (m) => window.__roamieHost(m);
const run = (secs) => { for (let i = 0; i < secs * 60; i++) c.update(1 / 60, env); };
const a = c.agent;
await new Promise((r) => setTimeout(r, 400)); // host.js ready()
run(1);
const answers = () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === 'answer'))); // plain copies: they come from the page's realm

// As it was: a question takes the keyboard, and Enter gives the answer and the keyboard back.
host({ kind: 'ask', id: 'q0', placeholder: 'Your name?' }); run(0.5);
assert.deepEqual(calls, [true], 'a question asks for the keyboard');
field.value = 'Kai'; field.on.keydown({ key: 'Enter', preventDefault: noop }); run(1);
assert.equal(calls.at(-1), false, 'answered: the keyboard goes back');
assert.deepEqual(answers().at(-1), { type: 'answer', id: 'q0', text: 'Kai' });

// Regression (found by an independent check): an answer streaming over an open question replaced its bubble without
// closing the question, the Roamie then left, and the overlay kept the keyboard with nothing on screen.
calls.length = 0; sent.length = 0;
host({ kind: 'agent', e: { type: 'start' } }); run(0.5);
host({ kind: 'agent', e: { type: 'text', text: 'Here is the first part of the answer.' } }); run(1);
host({ kind: 'ask', id: 'a1', placeholder: 'Ask me anything…' }); run(0.5);
assert.equal(calls.at(-1), true, 'the question opened over the answer has the keyboard');
host({ kind: 'agent', e: { type: 'text', text: ' And here is the rest of it.' } }); run(1.5);
await new Promise((r) => setTimeout(r, 20)); // the bubble's closing is a promise
assert.equal(calls.at(-1), false, 'its bubble was replaced: the keyboard goes back at once');
assert.deepEqual(answers().at(-1), { type: 'answer', id: 'a1', text: null }, 'and the question is answered with nothing');
host({ kind: 'agent', e: { type: 'done' } }); run(60);
assert.equal(a.visible, false, 'the Roamie has left');
assert.equal(calls.at(-1), false, 'with nothing on screen the keyboard is not asked for');

console.log('ask tests: passed');
process.exit(0);
