// The pen with the mouse (showcase/roamies/host.js, pen.js): on a Wayland layer surface nothing follows the cursor
// over other apps, so while a take is heard the whole overlay takes the mouse and a press and drag draws, as the
// helper's pen does on Windows. Each stroke goes to the shell (pen_stroke), which sends the marked part of the screen
// with the words (linux.rs pen_area, tested there). The overlay taking every click is what must never outlive the
// take: a click without a drag gives the mouse back, and so does every way a take ends. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const noop = () => {};
const ctx2d = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : noop), set: () => true });
const W = 1200, H = 800;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = { x: 2304, y: 0 }; // the overlay is the second screen: the shell hears global points

// One overlay page (core.js, agent.js, pen.js, host.js), as ask.test.mjs builds it, with a shell that writes down
// set_hit_rects in areas, pen_stroke in strokes, sidecar_send in sent, and what the page drew with its pen in inks.
async function boot(flags) {
  const keys = [], sent = [], areas = [], strokes = [], ticks = [], ptrs = [], inks = [], heard = {};
  const invoke = (cmd, args) => {
    if (cmd === 'set_typing') keys.push(args.on);
    if (cmd === 'sidecar_send') sent.push(args.msg);
    if (cmd === 'set_hit_rects') areas.push([...args.rects]);
    if (cmd === 'pen_stroke') strokes.push([...args.pts]);
    return Promise.resolve(undefined);
  };
  const el = () => ({ style: {}, attrs: {}, value: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(t, f) { (this.on ??= {})[t] = f; }, focus: noop, blur: noop, getContext: () => ctx2d });
  const field = el(), root = { style: {} };
  const env = { w: W, h: H, dpr: 1, t: 0, unit: 400, margin: 0.05, curiosity: 0.3, transparent: true, safe: { top: 46, right: 0, bottom: 0, left: 0 }, mouse: { x: -1, y: -1, active: false } };
  const window = { __TAURI__: { core: { invoke } }, ...flags };
  const ctx = {
    window, Math, Map, Set, Promise, performance, console, setTimeout, clearTimeout, clearInterval: noop, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams, Date,
    setInterval: (f) => ticks.push(f), addEventListener: (t, f) => (heard[t] ??= []).push(f),
    navigator: { platform: 'Linux' }, innerWidth: W, innerHeight: H, devicePixelRatio: 1, Event: class {}, dispatchEvent: noop, requestAnimationFrame: noop, Image: class {},
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    document: { addEventListener: noop, body: { appendChild: noop }, documentElement: root, createElement: (t) => (t === 'input' ? field : el()) },
    ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
  };
  vm.createContext(ctx);
  const load = (f) => vm.runInContext(fs.readFileSync(new URL(`../../../roamies/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
  load('core.js');
  vm.runInContext('var Roamie = window.Roamie;', ctx);
  for (const f of ['theme.js', 'glass.js', '10-dither.js', 'agent.js', 'pen.js']) load(f);
  const R = window.Roamie;
  R.origin = ORIGIN;
  const PAL = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
  const c = R.ditherKit({ id: 't', label: 'T', matrix: true, pixel: 1.3, pal: PAL, plugin: (kit) => R.agentPlugin(kit) }).create(env);
  c.vanish(null, true);
  R.tiles = [{ creature: c }];
  const body = (x, y) => !c.hidden && Math.hypot(x - c.mover.x, y - c.mover.y) < c.mover.radius * 1.1;
  R.hitTest = (x, y) => c.hit(x, y) || body(x, y);
  R.hitBox = () => [0, 0, W, H];
  R.ptr = (x, y, t) => { ptrs.push([x, y, t]); return false; };
  // What the page draws with its pen, as the helper's messages would draw it.
  const draw = R.pen;
  R.pen = (m) => { inks.push({ ...m }); draw(m); };
  vm.runInContext('for (const k of Object.keys(window)) if (!(k in globalThis)) globalThis[k] = window[k];', ctx);
  delete heard.pointerdown; delete heard.pointermove; delete heard.pointerup; // host.js's own are the ones looked at
  load('host.js');
  await wait(400);
  const run = (secs) => { for (let i = 0; i < secs * 60; i++) c.update(1 / 60, env); };
  run(1);
  // A pointer event as the page gets it; stopped: something kept it from reaching core.js.
  const fire = (type, x, y, more = {}) => { let stopped = false; for (const f of heard[type] ?? []) f({ clientX: x, clientY: y, button: 0, target: null, defaultPrevented: false, ...more, stopImmediatePropagation() { stopped = true; } }); return stopped; };
  const p = {
    R, c, a: c.agent, keys, sent, areas, strokes, inks, ptrs, run, window, root, fire,
    host: (m) => window.__roamieHost(m),
    tick: () => { for (const f of ticks) f(); },
    whole() { const r = areas.at(-1) ?? []; for (let i = 0; i < r.length; i += 4) if (r[i] <= 0 && r[i + 1] <= 0 && r[i] + r[i + 2] >= W && r[i + 1] + r[i + 3] >= H) return true; return false; },
    everWhole() { return areas.some((r) => { for (let i = 0; i < r.length; i += 4) if (r[i + 2] >= W && r[i + 3] >= H) return true; return false; }); },
    // A press, moves through pts, and a release. Returns whether core.js was kept from hearing the press.
    drag(pts) { const s = fire('pointerdown', ...pts[0]); for (const q of pts.slice(1)) fire('pointermove', ...q); fire('pointerup', ...pts.at(-1)); return s; },
    click(x, y) { const s = fire('pointerdown', x, y); fire('pointerup', x, y); if (c.hit(x, y)) c.press(x, y); return s; },
    seen(x, y) {
      const n = ptrs.length; let stopped = false;
      window.__roamiePtr(x, y, 9000 + n);
      for (const f of heard.pointermove ?? []) f({ clientX: x, clientY: y, stopImmediatePropagation() { stopped = true; } });
      return [ptrs.length > n, !stopped];
    },
    voice: (m) => window.__roamieHost({ kind: 'voice', ...m }),
    listening() { p.voice({ type: 'state', state: 'listening', mode: 'handsfree' }); run(0.3); },
  };
  return p;
}

// A circle round (cx, cy) in the overlay's px, and a short underline.
const circle = (cx, cy, r, turns = 1.05) => Array.from({ length: 61 }, (_, k) => { const t = (turns * 2 * Math.PI * k) / 60; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; });
const line = (x, y, len) => Array.from({ length: 21 }, (_, k) => [x + (len * k) / 20, y]);
const OUTSIDE = [5, 780];
const pairs = (flat) => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

// ---------- a layer surface with the setting on: the whole overlay draws while a take is heard ----------
{
  const p = await boot({ ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }), { host, tick } = p;
  host({ kind: 'pen', on: true }); tick();
  assert.equal(p.whole(), false, 'no take: only what is drawn takes clicks');
  p.listening(); tick();
  assert.equal(p.whole(), true, 'a take is heard: the whole overlay takes the mouse');
  assert.equal(p.root.style.cursor, 'crosshair', 'and the pointer says so');
  assert.deepEqual(p.seen(...OUTSIDE), [false, false], 'the Roamie does not run after the pointer meanwhile');

  // A circle: drawn as the helper's are (start, points, snapped shut), and its loop goes to the shell in global points.
  const ring = circle(600, 400, 80);
  assert.equal(p.drag(ring), true, 'the press is the pen\'s, not core.js\'s');
  const evs = p.inks.map((m) => m.ev);
  assert.equal(evs[0], 'start');
  assert.ok(evs.filter((e) => e === 'pt').length > 20, 'its points are drawn as it goes');
  assert.equal(evs.at(-1), 'snap', 'it snaps shut when it closes, as the helper\'s does');
  assert.ok(p.inks.every((m) => m.ev !== 'start' && m.ev !== 'pt' || m.x >= ORIGIN.x), 'drawn in global points, like the helper\'s messages');
  assert.equal(p.strokes.length, 1, 'one stroke handed to the shell');
  const loop = pairs(p.strokes[0]);
  assert.deepEqual(loop[0], loop.at(-1), 'the loop, closed');
  for (const [x, y] of loop) assert.ok(Math.abs(Math.hypot(x - ORIGIN.x - 600, y - 400) - 80) < 12, `on the circle drawn, in global points (${x}, ${y})`);
  assert.equal(p.whole(), true, 'a stroke keeps the mouse: more can be drawn');

  // It snaps shut the moment it closes, as the helper's does: dragging on after that draws nothing more.
  p.inks.length = 0;
  p.drag([...circle(600, 400, 80), ...line(680, 400, 300).slice(1)]);
  assert.equal(p.inks.at(-1).ev, 'snap', 'snapped while still dragging');
  assert.ok(pairs(p.strokes[1]).every(([x]) => x - ORIGIN.x < 700), 'and the line dragged after it is not part of it');
  p.strokes.pop();

  // An underline: not closed, so it stays as drawn (an open line) and goes as it is.
  p.inks.length = 0;
  p.drag(line(300, 500, 200));
  assert.deepEqual(p.inks.map((m) => m.ev).filter((e) => e !== 'pt'), ['start'], 'a line is drawn, and neither snaps nor drops');
  const under = pairs(p.strokes[1]);
  assert.ok(under.length >= 10 && under[0][0] === ORIGIN.x + 300 && Math.abs(under.at(-1)[0] - ORIGIN.x - 500) < 4 && under.every(([, y]) => y === 500), 'the line, in global points');

  // A press a drawing's own button or card took (ink.js hears it first and claims it) is not the pen's.
  const card = circle(900, 300, 60);
  p.fire('pointerdown', ...card[0], { defaultPrevented: true }); for (const q of card.slice(1)) p.fire('pointermove', ...q); p.fire('pointerup', ...card.at(-1));
  assert.equal(p.strokes.length, 2, 'nothing drawn under a drawing\'s button');
  assert.equal(p.whole(), true, 'and the pen is still on');

  // A click without a drag: the mouse goes back at once, that click is spent, and the take goes on.
  const before = p.areas.length;
  assert.equal(p.click(...OUTSIDE), true, 'the click is the pen\'s: nothing else hears it');
  assert.ok(p.areas.length > before && !p.whole(), 'the whole-overlay area goes in the same breath');
  assert.equal(p.root.style.cursor, '', 'the pointer is plain again');
  assert.equal(p.strokes.length, 2, 'a click is no stroke');
  assert.deepEqual(p.sent.filter((m) => m.type === 'listen_cancel'), [], 'the take is not cancelled');
  run2(p);
  assert.equal(p.whole(), false, 'and it stays given back for the rest of the take');
  assert.deepEqual(p.seen(...OUTSIDE), [true, true], 'the pointer is heard as before');
  p.drag(circle(200, 200, 60));
  assert.equal(p.strokes.length, 2, 'nothing draws any more in this take');

  // The take ends: its strokes fade, as the helper's do.
  p.inks.length = 0;
  p.voice({ type: 'state', state: 'processing' }); p.voice({ type: 'final', text: 'what is this' }); tick();
  assert.deepEqual(p.inks.map((m) => m.ev), ['fade'], 'what was drawn fades when the take ends');

  // The next take draws again.
  p.listening(); tick();
  assert.equal(p.whole(), true, 'a new take: the pen is back');
}

function run2(p) { p.run(1); p.tick(); p.tick(); }

// ---------- every way a take ends gives the mouse back at once ----------
{
  const p = await boot({ ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }), { host } = p;
  host({ kind: 'pen', on: true });
  const ends = {
    'sent (processing)': () => p.voice({ type: 'state', state: 'processing' }),
    'the words heard': () => p.voice({ type: 'final', text: 'that one' }),
    'cancelled': () => p.voice({ type: 'state', state: 'idle', cancelled: true }),
    'nothing new heard, or a pause': () => p.voice({ type: 'state', state: 'idle' }),
    'the helper dying (the shell says idle for it)': () => p.voice({ type: 'state', state: 'idle' }),
    'an error': () => p.voice({ type: 'state', state: 'error' }),
    'Esc': () => host({ kind: 'esc' }),
    'the setting switched off': () => host({ kind: 'pen', on: false }),
  };
  for (const [how, end] of Object.entries(ends)) {
    host({ kind: 'pen', on: true });
    p.listening(); p.tick();
    assert.equal(p.whole(), true, `${how}: drawing first`);
    const n = p.areas.length;
    end();
    assert.ok(p.areas.length > n && !p.whole(), `${how}: the whole-overlay area goes at once`);
    run2(p);
    assert.equal(p.whole(), false, `${how}: and stays gone`);
  }
  assert.ok(p.sent.some((m) => m.type === 'listen_cancel'), 'Esc cancelled its take');

  // Ended in the middle of a stroke: what was drawn is a stroke all the same, and the mouse goes back.
  host({ kind: 'pen', on: true });
  p.listening(); p.tick();
  p.strokes.length = 0;
  const ring = circle(600, 400, 80, 0.6);
  p.fire('pointerdown', ...ring[0]); for (const q of ring.slice(1)) p.fire('pointermove', ...q);
  p.voice({ type: 'state', state: 'processing' });
  assert.equal(p.whole(), false, 'mid-stroke: the mouse goes back');
  assert.equal(p.strokes.length, 1, 'and the stroke so far is handed on');
  p.fire('pointerup', ...ring.at(-1));
  assert.equal(p.strokes.length, 1, 'the release after it adds nothing');
}

// ---------- a page that starts again (reloaded mid-take) never asks for the whole overlay ----------
{
  const p = await boot({ ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true });
  p.host({ kind: 'pen', on: true });
  p.voice({ type: 'partial', text: 'what is' }); p.voice({ type: 'level', v: 0.4 }); p.tick(); p.run(1); p.tick();
  assert.equal(p.everWhole(), false, 'only the start of a take turns the pen on');
}

// ---------- a question and a take together: each lets go of its own, and the area goes with the last ----------
{
  const p = await boot({ ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }), { host, keys } = p;
  host({ kind: 'pen', on: true });
  p.listening();
  host({ kind: 'ask', id: 'q1', placeholder: 'Which one?' }); p.run(0.5); p.tick();
  assert.deepEqual(keys, [true]);
  assert.equal(p.whole(), true);
  p.click(...OUTSIDE);
  assert.deepEqual(keys, [true, false], 'the first click elsewhere gives the question\'s keyboard back');
  assert.equal(p.whole(), true, 'the take still draws');
  p.click(...OUTSIDE);
  assert.equal(p.whole(), false, 'a second click gives the mouse back');
  assert.deepEqual(keys, [true, false], 'without touching the keyboard again');
  // The other way round: the take ends first, the question keeps its click area, then lets go of it.
  host({ kind: 'cancel_ask', id: 'q1' }); p.run(1);
  p.listening();
  host({ kind: 'ask', id: 'q2', placeholder: 'Which one?' }); p.run(0.5); p.tick();
  p.voice({ type: 'final', text: 'this' }); p.tick();
  assert.equal(p.whole(), true, 'the take is over, the question still has the keyboard');
  p.click(...OUTSIDE); p.tick();
  assert.equal(p.whole(), false, 'and its click elsewhere ends that too');
}

// ---------- the setting off, or anywhere but a layer surface: no take ever takes the mouse ----------
for (const [name, flags, pen] of [
  ['a layer surface with the setting off', { ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }, false],
  ['a layer surface the sidecar said nothing to', { ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true }, null],
  ['an X11 window', { ROAMIE_LINUX: 'x11' }, true],
  ['macOS or Windows', {}, true],
]) {
  const p = await boot(flags), { host, tick } = p;
  if (pen != null) host({ kind: 'pen', on: pen });
  p.listening(); tick(); p.run(1); tick();
  p.drag(circle(600, 400, 80));
  p.click(...OUTSIDE); tick();
  assert.equal(p.everWhole(), false, `${name}: the whole overlay never takes clicks`);
  assert.deepEqual(p.strokes, [], `${name}: nothing is drawn with the mouse`);
  assert.equal(p.inks.length, 0, `${name}: nor shown`);
  p.voice({ type: 'final', text: 'hi' }); tick();
  assert.deepEqual(p.inks, [], `${name}: and nothing fades`);
  // Windows: the helper's own pen still draws through the same messages.
  p.voice({ type: 'ink', ev: 'start', x: 10, y: 10 });
  assert.deepEqual(p.inks.map((m) => m.ev), ['start'], `${name}: the helper's ink messages still reach pen.js`);
}

// ---------- the setting and the wiring, read from the source (sidekick.mjs runs the app when loaded) ----------
{
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const side = read('../sidekick.mjs');
  assert.match(side, /const DEFAULTS = \{[^}]*\bpenMouse: true,/, 'on by default, with the other settings');
  assert.match(side, /const PEN_MOUSE = VOICE_OK && mousePen\(process\.platform, process\.env\.ROAMIES_LAYER \|\| ''\);/, 'only where the mouse can draw, and there is voice to draw during');
  assert.match(side, /const penOn = \(\) => PEN_MOUSE && config\.penMouse !== false;/);
  assert.match(side, /else if \(id === 'pen' && PEN_MOUSE\) \{ config\.penMouse = !penOn\(\); saveConfig\(\); ui\(\{ kind: 'pen', on: penOn\(\) \}\); menu\(\); \}/, 'the switch is saved and told to the overlay at once');
  assert.match(side, /ui\(\{ kind: 'theme', theme: themeOf\(config\.theme\) \}\);\n\s+if \(PEN_MOUSE\) ui\(\{ kind: 'pen', on: penOn\(\) \}\);/, 'and when the overlay is ready, only where it works');
  assert.match(side, /\n\s+pen: PEN_MOUSE \? \{ on: penOn\(\) \} : null,/, 'the panel is told, only where it works');
  assert.match(side, /\$\{circleWords\(process\.platform, process\.env\.ROAMIES_LAYER \|\| '', penOn\(\)\)\}/, 'the agent is told what is true now');
  assert.match(side, /const CIRCLE_OK = canCircle\(process\.platform, process\.env\.ROAMIES_LAYER \|\| ''\);/);
  // The setup guide teaches the helper's circling (the talk keys held); in the guide the overlay hears no take.
  assert.match(side, /circle: CIRCLE_OK && !PEN_MOUSE,/, 'the setup guide is told as before');
  const panel = read('../../../panel/panel.js');
  const voicePage = panel.slice(panel.indexOf('function voicePage()'), panel.indexOf('const BIND_ROWS'));
  assert.match(voicePage, /state\.pen \? toggle\('Draw with the mouse while I listen', [^\n]*, state\.pen\.on, \(\) => act\('pen'\), 'pen'\) : null/, 'the Talking tab\'s switch, shown only where it works');
  assert.ok(voicePage.indexOf("toggle('Draw with the mouse") > voicePage.indexOf('const talking = ['), 'on the Talking tab');
  const shell = read('../../src-tauri/src/main.rs');
  assert.match(shell, /generate_handler!\[[^\]]*\bpen_stroke\b/, 'the shell hears strokes');
}

console.log('pen tests: passed');
process.exit(0);
