// A typed question and the keyboard (showcase/roamies/host.js): the overlay asks the shell for the keyboard while a
// question is open (set_typing) and must give it back whenever the question goes, however it goes. On a Wayland
// layer surface the keyboard is exclusive meanwhile, so one forgotten release locks typing everywhere, and a click
// anywhere else has to give it back while the question stays. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const noop = () => {};
const ctx2d = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : noop), set: () => true });
const W = 1200, H = 800;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One overlay page (core.js, agent.js, host.js) in its own realm, with what the shell sets on it (flags) and a
// shell that only writes down what it is asked: set_typing in keys, set_hit_rects in areas, dock_state in outs,
// sidecar_send in sent, everything by name in asked. dock: what dock_get answers (after dockMs).
async function boot(flags) {
  const keys = [], sent = [], areas = [], outs = [], asked = [], ticks = [], ptrs = [], heard = {};
  const page = { dock: null, dockMs: 0 };
  const invoke = (cmd, args) => {
    asked.push(cmd);
    if (cmd === 'set_typing') keys.push(args.on);
    if (cmd === 'sidecar_send') sent.push(args.msg);
    if (cmd === 'set_hit_rects') areas.push([...args.rects]);
    if (cmd === 'dock_state') outs.push(args.out);
    if (cmd === 'dock_get') return new Promise((r) => setTimeout(() => r(page.dock), page.dockMs));
    return Promise.resolve(undefined);
  };
  const el = () => ({ style: {}, attrs: {}, value: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(t, f) { (this.on ??= {})[t] = f; }, focus: noop, blur: noop, getContext: () => ctx2d });
  const field = el();
  const env = { w: W, h: H, dpr: 1, t: 0, unit: 400, margin: 0.05, curiosity: 0.3, transparent: true, safe: { top: 46, right: 0, bottom: 0, left: 0 }, mouse: { x: -1, y: -1, active: false } };
  const window = { __TAURI__: { core: { invoke } }, ...flags };
  const ctx = {
    window, Math, Map, Set, Promise, performance, console, setTimeout, clearTimeout, clearInterval: noop, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams, Date,
    // The page's own clocks and listeners are kept, for the test to run when it wants.
    setInterval: (f) => ticks.push(f), addEventListener: (t, f) => (heard[t] ??= []).push(f),
    // A resize, as core.js's desktop page takes it: the Roamie's world is as big as the page from its next frame on.
    navigator: { platform: 'Linux' }, innerWidth: W, innerHeight: H, Event: class {}, dispatchEvent: () => { env.w = ctx.innerWidth; env.h = ctx.innerHeight; }, requestAnimationFrame: noop, Image: class {},
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: { addEventListener: noop, body: { appendChild: noop }, createElement: (t) => (t === 'input' ? field : el()) },
    ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
  };
  vm.createContext(ctx);
  const load = (f) => vm.runInContext(fs.readFileSync(new URL(`../../../roamies/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
  load('core.js');
  vm.runInContext('var Roamie = window.Roamie;', ctx);
  for (const f of ['theme.js', 'glass.js', '10-dither.js', 'agent.js']) load(f);
  const R = window.Roamie;
  const PAL = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const c = R.ditherKit({ id: 't', label: 'T', matrix: true, pixel: 1.3, pal: PAL, plugin: (kit) => R.agentPlugin(kit) }).create(env);
  c.vanish(null, true);
  R.tiles = [{ creature: c }];
  // What core.js's desktop page gives the host (bootDesktop isn't run here): the Roamie's body and its bubble take
  // clicks, and everything drawn is somewhere on the overlay.
  const body = (x, y) => !c.hidden && Math.hypot(x - c.mover.x, y - c.mover.y) < c.mover.radius * 1.1;
  R.hitTest = (x, y) => c.hit(x, y) || body(x, y);
  R.hitBox = () => [0, 0, W, H];
  R.ptr = (x, y, t) => { ptrs.push([x, y, t]); return false; }; // the pointer, as the shell's samples reach core.js
  vm.runInContext('for (const k of Object.keys(window)) if (!(k in globalThis)) globalThis[k] = window[k];', ctx);
  delete heard.pointerdown; delete heard.pointermove; // host.js's own are the ones looked at
  load('host.js');
  await wait(400); // host.js ready()
  const run = (secs) => { for (let i = 0; i < secs * 60; i++) c.update(1 / 60, env); };
  run(1);
  return {
    R, c, a: c.agent, field, keys, sent, areas, outs, asked, ptrs, page, run, window, ctx,
    host: (m) => window.__roamieHost(m),
    tick: () => { for (const f of ticks) f(); },
    // A click as the page gets it: host.js hears it first, then core.js hands it to the bubble it is on.
    click(x, y) { for (const f of heard.pointerdown ?? []) f({ clientX: x, clientY: y, target: null }); if (c.hit(x, y)) c.press(x, y); },
    listens: () => (heard.pointerdown ?? []).length,
    // The pointer at a place, both ways the page hears of it: a sample from the shell (true: it reached core.js) and
    // the browser's own event (true: core.js gets to hear it).
    seen(x, y) {
      const n = ptrs.length; let stopped = false;
      window.__roamiePtr(x, y, 9000 + n);
      for (const f of heard.pointermove ?? []) f({ clientX: x, clientY: y, stopImmediatePropagation() { stopped = true; } });
      return [ptrs.length > n, !stopped];
    },
    answers: () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === 'answer'))), // plain copies: they come from the page's realm
    // The last click areas sent hold one that is the whole overlay.
    whole() { const r = areas.at(-1) ?? []; for (let i = 0; i < r.length; i += 4) if (r[i] <= 0 && r[i + 1] <= 0 && r[i] + r[i + 2] >= W && r[i + 1] + r[i + 3] >= H) return true; return false; },
    everWhole() { return areas.some((r) => { for (let i = 0; i < r.length; i += 4) if (r[i + 2] >= W && r[i + 3] >= H) return true; return false; }); },
    inBubble() { const b = c.agent.bubble; return [b.x.x + b.w.x / 2, b.y.x + b.h.x / 2]; },
    reset() { keys.length = 0; sent.length = 0; },
  };
}

const enter = (p, text) => { p.field.value = text; p.field.on.keydown({ key: 'Enter', preventDefault: noop }); };
const OUTSIDE = [5, 780]; // a corner with nothing of the Roamie's on it

// ---------- every kind of overlay: the question's life is what it was ----------
for (const [name, flags] of [['a layer surface', { ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }], ['an X11 window', { ROAMIE_LINUX: 'x11' }], ['macOS or Windows', {}]]) {
  const p = await boot(flags), { host, run, keys, a } = p;

  // As it was: a question takes the keyboard, and Enter gives the answer and the keyboard back.
  host({ kind: 'ask', id: 'q0', placeholder: 'Your name?' }); run(0.5);
  assert.deepEqual(keys, [true], `${name}: a question asks for the keyboard`);
  enter(p, 'Kai'); run(1);
  assert.deepEqual(keys, [true, false], `${name}: answered: the keyboard goes back, once`);
  assert.deepEqual(p.answers().at(-1), { type: 'answer', id: 'q0', text: 'Kai' });

  // Regression (found by an independent check): an answer streaming over an open question replaced its bubble without
  // closing the question, the Roamie then left, and the overlay kept the keyboard with nothing on screen.
  p.reset();
  host({ kind: 'agent', e: { type: 'start' } }); run(0.5);
  host({ kind: 'agent', e: { type: 'text', text: 'Here is the first part of the answer.' } }); run(1);
  host({ kind: 'ask', id: 'a1', placeholder: 'Ask me anything…' }); run(0.5);
  assert.equal(keys.at(-1), true, 'the question opened over the answer has the keyboard');
  host({ kind: 'agent', e: { type: 'text', text: ' And here is the rest of it.' } }); run(1.5);
  await wait(20); // the bubble's closing is a promise
  assert.equal(keys.at(-1), false, 'its bubble was replaced: the keyboard goes back at once');
  assert.deepEqual(p.answers().at(-1), { type: 'answer', id: 'a1', text: null }, 'and the question is answered with nothing');
  host({ kind: 'agent', e: { type: 'done' } }); run(60);
  assert.equal(a.visible, false, 'the Roamie has left');
  assert.equal(keys.at(-1), false, 'with nothing on screen the keyboard is not asked for');
  assert.deepEqual(keys, [true, false], `${name}: asked for once, given back once`);
}

// ---------- a layer surface: a click elsewhere gives the keyboard back, and the question stays ----------
{
  const p = await boot({ ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }), { host, run, keys, a, c, tick } = p;
  assert.equal(p.listens(), 1, 'the page listens for clicks');
  tick();
  assert.equal(p.whole(), false, 'no question: nothing but what is drawn takes clicks');

  host({ kind: 'ask', id: 'q1', placeholder: 'Your name?' }); run(0.5); tick();
  assert.deepEqual(keys, [true]);
  assert.equal(p.whole(), true, 'the question has the keyboard: the whole overlay takes clicks, so one elsewhere is heard');
  assert.equal(a.bubble.input.focused, true);

  // The extra area is there to hear a click, not to watch the pointer: the Roamie sees it where it always did (on
  // itself and its bubble), so it doesn't run after it across the screen while the question is open.
  assert.deepEqual(p.seen(...OUTSIDE), [false, false], 'the pointer over nothing of the Roamie\'s is not seen');
  assert.deepEqual(p.seen(...p.inBubble()), [true, true], 'on its bubble it is');
  assert.deepEqual(p.seen(c.mover.x, c.mover.y), [true, true], 'and on the Roamie');

  // On the Roamie itself and on its bubble: as before, the question keeps the keyboard.
  p.click(c.mover.x, c.mover.y);
  assert.deepEqual(keys, [true], 'a click on the Roamie releases nothing');
  p.click(...p.inBubble()); tick();
  assert.deepEqual(keys, [true, true], 'a click on the bubble asks for the keyboard, as it always did');
  assert.equal(p.whole(), true);

  // Anywhere else: the keyboard goes back, the extra click area with it and at once, and the question stays.
  keys.length = 0;
  assert.equal(p.R.hitTest(...OUTSIDE), false);
  const before = p.areas.length;
  p.click(...OUTSIDE);
  assert.deepEqual(keys, [false], 'a click elsewhere gives the keyboard back');
  assert.ok(p.areas.length > before && !p.whole(), 'and the whole-overlay click area goes in the same breath');
  assert.equal(a.bubble.input.focused, false, 'the bubble is shown unfocused');
  run(2); tick(); await wait(40); tick();
  assert.equal(p.whole(), false, 'it stays gone while the keyboard is elsewhere');
  assert.equal(a.visible && !!a.bubble?.input, true, 'the question is still on screen');
  assert.deepEqual(p.answers(), [], 'and it was not answered');
  p.click(...OUTSIDE);
  assert.deepEqual(keys, [false], 'nothing is released twice');
  assert.deepEqual(p.seen(...OUTSIDE), [true, true], 'with the extra area gone, whatever the shell says of the pointer is heard');

  // Its bubble takes the keyboard again; then it is answered as ever.
  p.click(...p.inBubble()); tick();
  assert.deepEqual(keys, [false, true], 'a click on the bubble takes the keyboard back');
  assert.equal(a.bubble.input.focused, true);
  assert.equal(p.whole(), true);
  enter(p, 'Kai'); run(1); tick();
  assert.deepEqual(keys, [false, true, false]);
  assert.equal(p.whole(), false, 'answered: only what is drawn takes clicks');
  assert.deepEqual(p.answers(), [{ type: 'answer', id: 'q1', text: 'Kai' }]);

  // However the question ends, with the keyboard or after a click elsewhere, it ends once and releases once.
  const ends = {
    Esc: () => host({ kind: 'esc' }),
    'hiding the Roamie': () => host({ kind: 'summon' }),
    'another question': () => host({ kind: 'ask', id: 'next', placeholder: 'And then?' }),
    'the sidecar taking it back': (id) => host({ kind: 'cancel_ask', id }),
    'its bubble being replaced': () => host({ kind: 'agent', e: { type: 'text', text: 'Never mind, here is the answer.' } }),
  };
  let n = 0;
  for (const [how, end] of Object.entries(ends)) {
    for (const away of [false, true]) {
      const id = `e${n++}`, why = `${how}${away ? ', after a click elsewhere' : ''}`;
      if (how === 'its bubble being replaced') { host({ kind: 'agent', e: { type: 'start' } }); run(0.5); }
      host({ kind: 'ask', id, placeholder: 'Sure?' }); run(0.5); tick();
      p.reset();
      if (away) { p.click(...OUTSIDE); assert.deepEqual(keys, [false], why); }
      end(id); run(2); await wait(20); tick();
      // The next question, when that is what ended it, asks for the keyboard itself.
      assert.deepEqual(keys.filter((on) => !on), [false], `${why}: the keyboard is given back exactly once`);
      const mine = p.answers().filter((m) => m.id === id);
      assert.deepEqual(mine, how === 'the sidecar taking it back' ? [] : [{ type: 'answer', id, text: null }], `${why}: the question ends, with no answer`);
      if (how === 'another question') { assert.equal(p.whole(), true, 'the new question has the keyboard'); host({ kind: 'esc' }); run(1); tick(); }
      assert.equal(p.whole(), false, `${why}: no click area is left over the screen`);
      host({ kind: 'agent', e: { type: 'done' } });
      if (a.visible) host({ kind: 'summon' });
      run(3); tick();
    }
  }

  // A yes/no: clicked away from, its buttons still answer, and nothing is released twice.
  host({ kind: 'ask', id: 'yn', prompt: 'Run it?', choices: ['Allow', 'Decline'] }); run(1); tick();
  p.reset();
  assert.equal(p.whole(), true);
  p.click(...OUTSIDE);
  assert.deepEqual(keys, [false]);
  // Its buttons are placed when a frame is drawn, and none is here: Allow goes in the bubble's bottom left corner.
  const bb = a.bubble, [bx, by, bw, bh] = [bb.x.x + 12, bb.y.x + bb.h.x - 34, 70, 24];
  bb.input.choices.rects = [[bx, by, bw, bh], [bx + 78, by, 80, bh]];
  p.click(bx + bw / 2, by + bh / 2); run(1); tick();
  assert.deepEqual(p.answers(), [{ type: 'answer', id: 'yn', text: 'yes' }], 'Allow still answers yes');
  assert.deepEqual(keys, [false], 'the keyboard had already gone back');
  assert.equal(p.whole(), false);

  // A yes/no stays open while the user talks: the words may answer it, and the sidecar closes it then. A typed
  // question still goes when a take starts, as before.
  host({ kind: 'ask', id: 'yn2', prompt: 'Run it?', choices: ['Allow', "Don't allow"] }); run(1); tick();
  const answered = p.answers().length;
  host({ kind: 'voice', type: 'state', state: 'listening', mode: 'hold' }); run(1); tick();
  assert.equal(p.answers().length, answered, 'not answered by starting to talk');
  host({ kind: 'cancel_ask', id: 'yn2' }); run(1); tick();
  assert.equal(p.answers().length, answered, 'closed by the sidecar without an answer of its own');
  host({ kind: 'voice', type: 'state', state: 'idle' }); run(1);
  host({ kind: 'ask', id: 'typed', prompt: 'Paste it' }); run(1); tick();
  host({ kind: 'voice', type: 'state', state: 'listening', mode: 'hold' }); run(1); tick();
  assert.deepEqual(p.answers().at(-1), { type: 'answer', id: 'typed', text: null }, 'a typed question goes, as before');
  host({ kind: 'voice', type: 'state', state: 'idle' }); run(1);

  // The bar hears whether the Roamie is out even while its slot is on another screen (the one in use): there is one
  // overlay, and the shell goes by the same word when it takes the overlay there.
  p.outs.length = 0;
  tick(); await wait(20); // the slot is asked for, and there is none here
  assert.ok(p.outs.length > 0 && p.outs.every((out) => out === a.out), 'said without a slot on this screen');
  const was = a.out;
  host({ kind: 'summon' }); run(3); tick();
  assert.deepEqual([was, a.out, p.outs.at(-1)], [true, false, false], 'and again as soon as it is back in');
}

// ---------- a layer surface taken to another screen: the slot there is known before anything is shown ----------
{
  const p = await boot({ ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }), { host, run, a, c } = p;
  // A home on the old screen, from an appearance there.
  host({ kind: 'summon', show: true }); run(2);
  assert.equal(a.visible, true);
  // The screen in use is now a wider one whose bar keeps the slot elsewhere, measured in px bigger than the page's:
  // the overlay is 1500 x 900 there, which the page knows before its next frame tells the Roamie.
  p.page.dock = { x: 640, y: 32, sw: 1920, sh: 1152, mx: 2304, my: 0 }; p.page.dockMs = 60;
  p.ctx.innerWidth = 1500; p.ctx.innerHeight = 900;
  p.asked.length = 0;
  p.window.__roamiePtr(300, 200, 5000); // where the pointer was last seen on the old screen, and when (the shell's clock)
  p.window.__roamieMoved();
  assert.equal(a.visible, false, 'dropped from its old spot');
  assert.equal(a.station.x, null, 'and its home there forgotten');
  assert.deepEqual(p.ptrs.at(-1), [-1e4, -1e4, 5001], 'the pointer is nowhere on this screen, said as one more sample of the shell\'s');
  host({ kind: 'summon', show: true });
  await wait(330); // no resize comes in this page: the wait for one runs out
  assert.equal(p.asked.includes('dock_get'), true, 'the slot on the new screen is asked for');
  await wait(100);
  assert.equal(a.visible, false, 'and nothing is shown before the Roamie has had a frame on the new screen');
  run(0.05); await wait(40);
  assert.equal(a.visible, true, 'then what was held is played');
  assert.deepEqual([c.mover.x, c.mover.y], [500, 25], 'and the Roamie comes out of the slot on this screen, in its px');
  assert.equal(a.station.x, 750, 'to a first spot picked on a screen of this size, by that slot');
  // Never held for good: a page whose frames have stopped plays what it holds all the same.
  host({ kind: 'summon' }); run(3);
  p.window.__roamieMoved();
  host({ kind: 'summon', show: true });
  await wait(800);
  assert.equal(a.visible, true, 'played without a frame, after a wait');
}

// ---------- everywhere else: no extra click area, no click listener, the held messages play as they did ----------
for (const [name, flags] of [['an X11 window', { ROAMIE_LINUX: 'x11' }], ['macOS or Windows', {}]]) {
  const p = await boot(flags), { host, run, keys, a, tick } = p;
  assert.equal(p.listens(), 0, `${name}: the page listens for no clicks of its own`);
  assert.deepEqual(p.seen(...OUTSIDE), [true, true]);
  host({ kind: 'ask', id: 'q1', placeholder: 'Your name?' }); run(0.5); tick();
  assert.deepEqual(p.seen(...OUTSIDE), [true, true], `${name}: the pointer is seen wherever the shell says it is`);
  p.click(...OUTSIDE); run(1); tick();
  assert.deepEqual(keys, [true], `${name}: a click elsewhere changes nothing`);
  assert.equal(a.bubble.input.focused, true);
  enter(p, 'Kai'); run(1); tick();
  assert.deepEqual(keys, [true, false]);
  assert.deepEqual(p.answers(), [{ type: 'answer', id: 'q1', text: 'Kai' }]);
  assert.equal(p.everWhole(), false, `${name}: the whole overlay never takes clicks`);
  assert.equal(p.areas.length > 0, !!flags.ROAMIE_LINUX, `${name}: click areas are sent only on Linux`);
  assert.deepEqual(p.outs, [], `${name}: no slot, so the bar is told nothing`);

  host({ kind: 'summon', show: true }); run(2);
  const home = a.station;
  p.page.dock = { x: 640, y: 32, sw: 1920, sh: 1280, mx: 2304, my: 0 }; p.page.dockMs = 60;
  p.asked.length = 0;
  p.window.__roamiePtr(300, 200, 5000);
  p.window.__roamieMoved();
  assert.deepEqual(p.ptrs.at(-1), [300, 200, 5000], `${name}: the pointer is where the shell last said`);
  host({ kind: 'summon', show: true });
  await wait(330);
  assert.equal(a.visible, true, `${name}: what was held is played as soon as the wait is over`);
  assert.equal(p.asked.includes('dock_get'), false, `${name}: without asking for a slot`);
  assert.deepEqual([a.station.x, a.station.y], [home.x, home.y], `${name}: and home is where it was`);
}

console.log('ask tests: passed');
process.exit(0);
