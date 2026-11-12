// Checking it's the user before a protected money change: the sidecar's authorize(reason) (safety.mjs) asks the shell
// (src-tauri/src/auth.rs, PAM) and says yes only when the shell says this very request succeeded; and the overlay's
// prompt (showcase/roamies/agent-auth.js and host.js), which sends the password to the shell and never to the
// sidecar. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createAuthorize } from '../safety.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rule = async (name, fn) => { await fn(); console.log(`ok - ${name}`); };

// A shell that writes down what it is sent; reply() is the shell answering on stdin.
function shell({ platform = 'linux', timeoutMs = 400, ackMs = 200 } = {}) {
  const sent = [], logs = [];
  let n = 0;
  const authorize = createAuthorize({ send: (m) => sent.push(m), platform, timeoutMs, ackMs, log: (kind, data) => logs.push([kind, data]), newId: () => `r${++n}` });
  return { authorize, sent, logs, reply: (m) => authorize.heard(m) };
}

await rule('yes only when the shell says this request succeeded', async () => {
  const s = shell();
  const p = s.authorize('Rename category Comida to Restaurantes');
  assert.deepEqual(s.sent, [{ type: 'auth', id: 'r1', reason: 'Rename category Comida to Restaurantes' }]);
  s.reply({ type: 'auth_open', id: 'r1' });
  s.reply({ type: 'auth_result', id: 'r0', ok: true, why: 'ok' }); // another request's
  s.reply({ type: 'auth_result', id: 'r1', ok: 'yes', why: 'ok' }); // not true itself
  s.reply({ type: 'answer', id: 'r1', text: 'yes' }); // a typed answer is not an authentication
  s.reply({ type: 'auth_result', id: 'r1', ok: true, why: 'ok' });
  assert.equal(await p, false, "'yes' is not true: refused, and that ends it");
  assert.equal(s.authorize.last, 'failed');

  const q = s.authorize('Delete category Viajes');
  s.reply({ type: 'auth_open', id: 'r2' });
  s.reply({ type: 'auth_result', id: 'r2', ok: true, why: 'ok' });
  assert.equal(await q, true);
  assert.equal(s.authorize.last, 'ok');
  s.reply({ type: 'auth_result', id: 'r2', ok: true, why: 'ok' }); // a repeat changes nothing
});

await rule('cancelled, wrong too often, unavailable: no', async () => {
  for (const why of ['cancelled', 'unavailable', 'busy', 'timeout']) {
    const s = shell();
    const p = s.authorize('Unclassify 3 expenses');
    s.reply({ type: 'auth_open', id: 'r1' });
    s.reply({ type: 'auth_result', id: 'r1', ok: false, why });
    assert.equal(await p, false, why);
    assert.equal(s.authorize.last, why);
  }
});

await rule('one prompt at a time: a second request while one is open is refused at once', async () => {
  const s = shell();
  const p = s.authorize('Rename category A to B');
  assert.equal(await s.authorize('Delete category C'), false);
  assert.equal(s.authorize.last, 'busy');
  assert.equal(s.sent.length, 1, 'the shell was asked once');
  s.reply({ type: 'auth_open', id: 'r1' });
  s.reply({ type: 'auth_result', id: 'r1', ok: true });
  assert.equal(await p, true, 'the first one is not disturbed');
});

await rule('no answer in time: no, and the prompt is taken away', async () => {
  const s = shell({ timeoutMs: 120 });
  const p = s.authorize('Rename category A to B');
  s.reply({ type: 'auth_open', id: 'r1' });
  assert.equal(await p, false);
  assert.equal(s.authorize.last, 'timeout');
  assert.deepEqual(s.sent.at(-1), { type: 'auth_cancel', id: 'r1' });
  s.reply({ type: 'auth_result', id: 'r1', ok: true }); // too late
  await wait(10);
  assert.equal(s.authorize.last, 'timeout');
});

await rule('no shell to show the prompt (it never says it opened): no, soon', async () => {
  const s = shell({ ackMs: 60, timeoutMs: 5000 });
  const t0 = Date.now();
  assert.equal(await s.authorize('Rename category A to B'), false);
  assert.ok(Date.now() - t0 < 1000, 'without waiting out the whole minute');
  assert.equal(s.authorize.last, 'no_shell');
  assert.deepEqual(s.sent.at(-1), { type: 'auth_cancel', id: 'r1' });
  // And a later one is asked again.
  const p = s.authorize('Rename category A to B');
  s.reply({ type: 'auth_open', id: 'r2' }); s.reply({ type: 'auth_result', id: 'r2', ok: true });
  assert.equal(await p, true);
});

await rule('not on Linux yet: no, without asking anything', async () => {
  for (const platform of ['darwin', 'win32']) {
    const s = shell({ platform });
    assert.equal(await s.authorize('Rename category A to B'), false);
    assert.equal(s.authorize.last, 'unavailable');
    assert.deepEqual(s.sent, []);
  }
});

await rule('the log says that it was asked and how it went, not the whole reason', async () => {
  const s = shell();
  const p = s.authorize('Rename category Comida to Restaurantes Lima secret-merchant');
  s.reply({ type: 'auth_open', id: 'r1' }); s.reply({ type: 'auth_result', id: 'r1', ok: false, why: 'cancelled' });
  await p;
  const text = JSON.stringify(s.logs);
  assert.match(text, /"outcome":"cancelled"/);
  assert.doesNotMatch(text, /Restaurantes|secret-merchant/);
  assert.ok(s.logs.every(([k]) => k === 'auth'));
});

// ---------------------------------------------------------------- the overlay's prompt
// One overlay page (core.js, theme.js, agent.js, agent-auth.js, host.js) in its own realm, as ask.test.mjs builds it,
// with elements that keep their children, classes and text, and a shell that writes down every call.
const noop = () => {};
const ctx2d = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : noop), set: () => true });
const W = 1200, H = 800;
async function boot() {
  const asked = [], sent = [], keys = [], ticks = [], heard = {};
  const invoke = (cmd, args) => {
    asked.push([cmd, JSON.parse(JSON.stringify(args ?? {}))]);
    if (cmd === 'sidecar_send') sent.push(args.msg);
    if (cmd === 'set_typing') keys.push(args.on);
    return Promise.resolve(undefined);
  };
  const els = [];
  const el = (tag) => {
    const e = {
      tag, style: { setProperty: noop }, attrs: {}, kids: [], on: {}, value: '', textContent: '', className: '', hidden: false, width: 0, height: 0,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(t, f) { (this.on[t] ??= []).push(f); },
      append(...k) { this.kids.push(...k); }, appendChild(k) { this.kids.push(k); }, replaceChildren(...k) { this.kids = k; }, remove() { e.removed = true; },
      focus: noop, blur: noop, getContext: () => ctx2d, offsetWidth: 320, offsetHeight: 150,
      getBoundingClientRect() { const l = parseFloat(e.style.left) || 0, t = parseFloat(e.style.top) || 0; return { left: l, top: t, right: l + 320, bottom: t + 150, width: 320, height: 150 }; },
      classList: { s: new Set(), add(...c) { c.forEach((x) => this.s.add(x)); }, remove(...c) { c.forEach((x) => this.s.delete(x)); }, toggle(c, on) { if (on ?? !this.s.has(c)) this.s.add(c); else this.s.delete(c); }, contains(c) { return this.s.has(c); } },
    };
    els.push(e);
    return e;
  };
  const env = { w: W, h: H, dpr: 1, t: 0, unit: 400, margin: 0.05, curiosity: 0.3, transparent: true, safe: { top: 46, right: 0, bottom: 0, left: 0 }, mouse: { x: -1, y: -1, active: false } };
  const window = { __TAURI__: { core: { invoke } }, ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true };
  let raf = [];
  const ctx = {
    window, Math, Map, Set, Promise, performance, console, setTimeout, clearTimeout, clearInterval: noop, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams, Date,
    setInterval: (f) => ticks.push(f), addEventListener: (t, f) => (heard[t] ??= []).push(f),
    navigator: { platform: 'Linux' }, innerWidth: W, innerHeight: H, devicePixelRatio: 1, Event: class {}, dispatchEvent: noop, Image: class {},
    requestAnimationFrame: (f) => { raf.push(f); return raf.length; }, cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: { addEventListener: noop, head: el('head'), body: el('body'), documentElement: el('html'), createElement: (t) => el(t) },
    ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
  };
  vm.createContext(ctx);
  const load = (f) => vm.runInContext(fs.readFileSync(new URL(`../../../roamies/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
  load('core.js');
  vm.runInContext('var Roamie = window.Roamie;', ctx);
  for (const f of ['theme.js', 'glass.js', '10-dither.js', 'agent.js', 'agent-auth.js']) load(f);
  const R = window.Roamie;
  const PAL = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const c = R.ditherKit({ id: 't', label: 'T', matrix: true, pixel: 1.3, pal: PAL, plugin: (kit) => R.agentPlugin(kit) }).create(env);
  c.vanish(null, true);
  R.tiles = [{ creature: c }];
  const coreHit = R.hitTest;
  R.hitTest = (x, y) => c.hit(x, y) || !!R.authHit?.(x, y);
  R.hitBox = () => [0, 0, W, H];
  R.ptr = () => false;
  vm.runInContext('for (const k of Object.keys(window)) if (!(k in globalThis)) globalThis[k] = window[k];', ctx);
  delete heard.pointerdown; delete heard.pointermove;
  load('host.js');
  // host.js's hidden field, which collects the keys.
  const field = els.filter((e) => e.tag === 'input').at(-1);
  await wait(400);
  const run = (secs) => { for (let i = 0; i < secs * 60; i++) c.update(1 / 60, env); };
  run(1);
  const card = () => els.find((e) => e.className === 'ra');
  const texts = (e) => (e ? [e.textContent, ...e.kids.flatMap((k) => (typeof k === 'string' ? [k] : texts(k)))] : []);
  return {
    R, c, field, asked, sent, keys, card, coreHit, run,
    text: () => texts(card()).join(' '),
    host: (m) => window.__roamieHost(m),
    tick: () => { for (const f of ticks) f(); },
    frames: (n = 3) => { for (let i = 0; i < n; i++) { const q = raf; raf = []; for (const f of q) f(performance.now()); } },
    key: (k) => { for (const f of field.on.keydown ?? []) f({ key: k, preventDefault: noop }); },
    type: (s) => { field.value += s; for (const f of field.on.input ?? []) f({}); },
    click(x, y) { for (const f of heard.pointerdown ?? []) f({ clientX: x, clientY: y, target: null }); },
    calls: (cmd) => asked.filter(([c]) => c === cmd).map(([, a]) => a),
  };
}

await rule('the card keeps the Roamie on screen while it waits: an idle Roamie going away cancelled it in ~6 s', async () => {
  const p = await boot();
  p.c.agent.setAuto(true);
  p.host({ kind: 'auth', id: 'r9', reason: 'Delete category Comida', finger: true });
  for (let i = 0; i < 12; i++) { p.run(1); p.tick(); }
  assert.ok(p.card()?.classList.contains('on'), 'still up after 12 s');
  assert.deepEqual(p.calls('auth_cancel'), [], 'not cancelled');
});

await rule('the prompt: the reason, the keyboard, and a password that goes to the shell only', async () => {
  const p = await boot();
  p.host({ kind: 'auth', id: 'r1', reason: 'Rename category Comida to Restaurantes', finger: true });
  const card = p.card();
  assert.ok(card?.classList.contains('on'), 'the card is up');
  assert.match(p.text(), /Rename category Comida to Restaurantes/);
  assert.match(p.text(), /enter password or touch the reader/);
  assert.equal(p.field.type, 'password');
  assert.deepEqual(p.keys, [true], 'it takes the keyboard');
  // Clicks reach it: the card is one of the overlay's click areas.
  p.tick();
  const r = card.getBoundingClientRect();
  assert.ok(p.R.authHit(r.left + 5, r.top + 5) && p.R.authRect().length === 4);
  const areas = p.calls('set_hit_rects').at(-1).rects;
  assert.ok(areas.length >= 4, 'sent as click areas');

  p.type('hunter2');
  assert.match(p.text(), /enter password/);
  p.key('Enter');
  assert.deepEqual(p.calls('auth_password'), [{ id: 'r1', password: 'hunter2' }]);
  assert.equal(p.field.value, '', 'the field is emptied at once');
  assert.ok(!JSON.stringify(p.sent).includes('hunter2'), 'never to the sidecar');
  assert.ok(!p.text().includes('hunter2'), 'never shown');
  p.key('Enter');
  assert.equal(p.calls('auth_password').length, 1, 'an empty field sends nothing');

  // What the shell says comes out as the lock says it.
  p.host({ kind: 'auth_state', id: 'r1', busy: true });
  assert.match(p.text(), /checking…/);
  p.host({ kind: 'auth_state', id: 'r1', busy: false, fail: 'wrong' });
  assert.match(p.text(), /wrong password · try again/);
  p.host({ kind: 'auth_state', id: 'r0', busy: false, fail: 'locked' });
  assert.match(p.text(), /wrong password/, "another request's state changes nothing");
  p.host({ kind: 'auth_state', id: 'r1', fail: 'locked' });
  assert.match(p.text(), /too many attempts · use your finger or wait a few minutes/);
  p.host({ kind: 'auth_state', id: 'r1', touchFail: true });
  p.type('x');
  assert.match(p.text(), /enter password or touch the reader/, 'typing clears the failures, as on the lock');
  p.host({ kind: 'auth_state', id: 'r1', touchFail: true });
  assert.match(p.text(), /finger not recognised · try again/);
  p.host({ kind: 'auth_state', id: 'r1', finger: false });
  assert.match(p.text(), /finger not recognised/);
  p.type('y');
  assert.match(p.text(), /^(?:(?!touch the reader).)*enter password(?:(?!touch the reader).)*$/s, 'no reader: password only');

  // The shell says it's done: the prompt goes, and the keyboard with it. Nothing is sent to the sidecar from here.
  p.host({ kind: 'auth_end', id: 'r1', ok: true });
  await wait(600);
  assert.ok(!card.classList.contains('on'), 'gone');
  assert.deepEqual(p.keys, [true, false], 'the keyboard is given back');
  assert.deepEqual(p.calls('auth_cancel'), [], 'nothing to cancel');
  assert.deepEqual(p.sent.filter((m) => m.type === 'answer'), []);
});

await rule('Esc, the Cancel button or the Roamie leaving cancels it at the shell', async () => {
  const p = await boot();
  p.host({ kind: 'auth', id: 'r1', reason: 'Delete category X', finger: false });
  assert.doesNotMatch(p.text(), /touch the reader/, 'no reader: password only');
  p.key('Escape');
  assert.deepEqual(p.calls('auth_cancel'), [{ id: 'r1' }]);
  assert.deepEqual(p.keys, [true, false]);

  p.host({ kind: 'auth', id: 'r2', reason: 'Delete category X', finger: true });
  const cancel = (function find(e) { return e?.tag === 'button' ? e : e?.kids?.map(find).find(Boolean); })(p.card());
  assert.ok(cancel, 'a Cancel button');
  cancel.on.click[0]({});
  assert.deepEqual(p.calls('auth_cancel').at(-1), { id: 'r2' });

  p.host({ kind: 'auth', id: 'r3', reason: 'Delete category X', finger: true });
  p.host({ kind: 'summon' }); // ⌃⌥S while it's up: it goes, and so does the question
  assert.deepEqual(p.calls('auth_cancel').at(-1), { id: 'r3' });
  assert.equal(p.keys.at(-1), false);
});

await rule('the fingerprint mark: the lock\'s dotted arcs, scanned while waiting, in its colours', async () => {
  const p = await boot();
  const dots = JSON.parse(JSON.stringify(p.R.fingerDots())); // plain copies: they come from the page's realm
  assert.deepEqual(dots[0], { x: 26, y: 27 }, 'the centre');
  assert.equal(dots.length, 1 + [7, 13, 19, 25].reduce((n, r) => n + Math.round(r * 4.2 / 4.5) + 1, 0));
  for (const d of dots.slice(1)) {
    const a = Math.atan2(-(d.y - 27) / 1.08, d.x - 26) * 180 / Math.PI;
    assert.ok(a >= -30.01 && a <= 210.01 || a <= -149.99, `no dot in the gap at the bottom (${a.toFixed(1)}°)`);
  }
  const T = p.R.theme.now.tones;
  assert.equal(p.R.fingerColour({}), T.amber, 'waiting');
  assert.equal(p.R.fingerColour({ touchOk: true }), T.lime, 'accepted');
  assert.equal(p.R.fingerColour({ touchFail: true }), T.red, 'not recognised');
  // While waiting the band runs bottom to top: a dot near it is bright, one far from it faint.
  assert.equal(p.R.fingerAlpha(0.5, 0.5, {}), 1);
  assert.equal(p.R.fingerAlpha(0.1, 0.9, {}), 0.25);
  assert.equal(p.R.fingerAlpha(0.1, 0.9, { touchOk: true }), 1);
  assert.ok(p.R.fingerScan(0) > p.R.fingerScan(700) && p.R.fingerScan(700) > p.R.fingerScan(1400), 'upwards');
});

console.log('auth tests: passed');
