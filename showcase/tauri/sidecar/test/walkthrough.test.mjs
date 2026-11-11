// Walkthroughs: a draw beat with `wait` stops until the user has done the step. Where their click in another app is
// seen, that click ends the wait; on Wayland nothing is seen, so the wait is dropped, except on a layer surface
// (linux.rs), where the overlay shows a Next chip of its own and waits for a click on that. The sidecar's side
// (tools.mjs) and the overlay's (showcase/roamies/ink.js, run here in a sandbox on a clock the test turns).
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createTools, doneBeat, drawDescription } from '../tools.mjs';
import { drawWords } from '../platform.mjs';

const noop = () => {};
const settle = () => new Promise((r) => setImmediate(r));

// ---------- the sidecar: which beat's chip reads Done ----------
{
  const w = { wait: 'click' }, p = {};
  assert.equal(doneBeat([w, w, w]), 2, 'the last of several that wait');
  assert.equal(doneBeat([w, p, w, p]), 2, 'a closing beat that doesn\'t wait comes after it');
  assert.equal(doneBeat([p, w]), -1, 'one step: more may follow in another call, so it reads Next');
  assert.equal(doneBeat([p, p]), -1);
  assert.equal(doneBeat([]), -1);
}

// ---------- the sidecar: what the draw tool says about waiting ----------
{
  const chip = drawDescription({ hands: false, waits: 'chip' });
  assert.ok(chip.endsWith(" On this desktop (Wayland) clicks and hovers in other apps can't be seen, so a beat with wait shows a Next button on screen instead (Done on the last of several) and goes on when they press it: word each step's line so they do the step and then press Next. wait 'hover' works the same way."), 'a layer surface: the truth about Next');
  assert.ok(!/never use wait/.test(chip));
  assert.match(chip, /\nWalkthroughs \("how do I…"\): a screenshot shows only the step that's on screen now, so one step per call: one beat with a target on that step's control, its label and wait 'click'\./, 'a step per call, each waiting');
  // Everywhere else the words are what they were (test/platform.test.mjs and test/toolschema.test.mjs pin them).
  assert.ok(drawDescription({ hands: false, waits: 'none' }).endsWith("never use wait; beats play one after another, so say each step's line in an order that reads well without pausing."));
  assert.ok(drawDescription({ hands: true, waits: 'pointer' }).endsWith('Up to 12 beats, 40 marks each.'));
  assert.equal(drawWords({ hands: true, waits: 'chip' }).walkthroughs, drawWords({ hands: true }).walkthroughs);
}

// ---------- the sidecar: the wait is kept or dropped (Linux without the hands helper: places come from a screenshot) ----------
if (process.platform === 'linux' && !process.env.ROAMIES_HANDS) {
  const SHOT = { ok: true, pixels: [1568, 882], bounds: [0, 0, 1920, 1080] };
  const askShell = async (m) => { if (m.type === 'screenshot') fs.writeFileSync(m.file, 'jpeg'); return SHOT; };
  const step = (say, y) => ({ say, marks: [{ kind: 'target', at: { x: 100, y, w: 60, h: 20 }, label: say }], wait: 'click' });
  // One drawing through the tool: each segment the overlay is sent, answered as the overlay would (started; a
  // waiting beat answered with `press`), and what the tool told the model at the end.
  const walk = async (waits, beats, press) => {
    const segs = [];
    const made = createTools({
      allowActions: () => false, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Kai', askShell, waits,
      ui: (m) => {
        if (m.kind !== 'agent' || m.e.type !== 'draw') return;
        segs.push(m.e);
        setImmediate(() => { made.ink.started(m.e.id, m.e.seg); const b = m.e.beats.at(-1); if (b?.wait) setImmediate(() => made.ink.waitDone(m.e.id, b.n, press)); });
      },
    });
    const tool = (n) => made.tools.find((t) => t.name === n);
    await tool('take_screenshot').execute({ target: 'screen' }, {});
    const said = await tool('draw').execute({ beats }, { toolCallId: 'w' });
    return { segs, said, description: tool('draw').description };
  };

  // A layer surface: the wait reaches the overlay, and Next ends it. The next step's place was read off the
  // screenshot from before the step was done, so it is refused, as after a real click.
  const chip = await walk('chip', [step('Open the File menu.', 40), step('Choose Save.', 80)], 'next');
  assert.equal(chip.segs.length, 1, 'the second step waits for a new look');
  assert.equal(chip.segs[0].beats[0].wait, 'click', 'the wait is kept');
  assert.equal(chip.segs[0].beats[0].final, undefined, 'not the last of several: its chip reads Next');
  assert.match(chip.said, /Beat 1: Kai pressed Next\./);
  // (resolveTargets, draw.mjs, names the mark by its place in the beats it was given: "beat 1 mark 1" here.)
  assert.match(chip.said, /Stopped before beat 2: beat 1 mark 1 \(target\): Something was clicked or opened since that screenshot, so it may be out of date\. Take a new screenshot\./);
  assert.ok(!/played one after another/.test(chip.said));
  assert.equal(chip.description, drawDescription({ hands: false, waits: 'chip' }), 'and the tool says how it waits here');
  // Nobody pressed it.
  const idle = await walk('chip', [step('Open the File menu.', 40)], 'timeout');
  assert.match(idle.said, /Beat 1: nobody pressed Next/, 'an answer that isn\'t one of the overlay\'s is no press');

  // Wayland without one, as it was: the waits are dropped, every beat plays, and the model is told.
  const none = await walk('none', [step('Open the File menu.', 40), step('Choose Save.', 80)], 'next');
  assert.deepEqual(none.segs.map((e) => e.beats[0].wait), [null, null], 'no beat waits');
  assert.match(none.said, /This desktop doesn't let Roamies see clicks in other apps, so the beats played one after another instead of waiting for clicks\./);
  assert.equal(none.description, drawDescription({ hands: false, waits: 'none' }));

  // Where the pointer is seen, as it was: the wait is kept and the real click ends it, with nothing new in what
  // the overlay is sent.
  const seen = await walk('pointer', [step('Open the File menu.', 40), step('Choose Save.', 80)], 'clicked');
  assert.equal(seen.segs[0].beats[0].wait, 'click');
  assert.deepEqual(Object.keys(seen.segs[0].beats[0]).sort(), ['caption', 'marks', 'n', 'say', 'voiced', 'wait']);
  assert.match(seen.said, /Beat 1: Kai clicked\./);
  assert.equal(seen.description, drawDescription({ hands: false, waits: 'pointer' }));
}

// ---------- the overlay ----------
// ink.js in its own realm. Time is the test's: timers, frames and performance.now() all run on a clock that only
// run(ms) turns. The 2d context takes anything and keeps the words drawn on it.
async function page(flags = {}) {
  let T = 0, seq = 0;
  const timers = [], texts = [], heard = {}, sent = [], asked = [];
  const later = (f, ms = 0) => { timers.push({ id: ++seq, at: T + Math.max(0, +ms || 0), f }); return seq; };
  const never = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const every = (f, ms) => { const id = ++seq, arm = () => timers.push({ id, at: T + ms, f: () => { arm(); f(); } }); arm(); return id; };
  const ctx2d = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : k === 'fillText' ? (s) => { texts.push(String(s)); } : noop), set: () => true });
  const el = () => ({ style: {}, setAttribute: noop, appendChild: noop, getContext: () => ctx2d });
  const window = { ...flags };
  const ctx = {
    window, Math, Map, Set, Promise, console, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams,
    performance: { now: () => T }, setTimeout: later, clearTimeout: never, setInterval: every, clearInterval: never, requestAnimationFrame: (f) => later(() => f(T), 16),
    addEventListener: (t, f) => (heard[t] ??= []).push(f), innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, navigator: { platform: 'Linux' },
    // Reduced motion: strokes and fades land at once, so only the waiting takes time.
    matchMedia: () => ({ matches: true, addEventListener: noop }),
    Path2D: class { moveTo() {} lineTo() {} rect() {} closePath() {} }, Image: class {},
    document: { addEventListener: noop, body: { appendChild: noop }, documentElement: { style: {} }, getElementById: () => null, createElement: el },
    ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
  };
  vm.createContext(ctx);
  const load = (f) => vm.runInContext(fs.readFileSync(new URL(`../../../roamies/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
  load('core.js');
  vm.runInContext('var Roamie = window.Roamie;', ctx);
  for (const f of ['theme.js', 'glass.js', 'ink.js']) load(f);
  const R = window.Roamie;
  R.ink.send = (m) => sent.push(JSON.parse(JSON.stringify(m)));
  R.ink.invoke = (cmd, args) => asked.push([cmd, args?.on]);
  return {
    R, sent, asked, texts, window,
    // Turns the clock: everything due within ms runs in order, with promises settling in between.
    async run(ms) {
      const end = T + ms;
      for (;;) {
        await settle();
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift();
        T = t.at; t.f();
      }
      T = end;
      await settle();
    },
    // A click as the page gets it. True when ink.js took it (it then goes no further).
    click(x, y) { let taken = false; for (const f of heard.pointerdown ?? []) f({ clientX: x, clientY: y, stopPropagation() { taken = true; }, preventDefault: noop }); return taken; },
    areas: () => JSON.parse(JSON.stringify(R.inkRects())),
    waits: () => sent.filter((m) => m.type === 'draw_wait_done'),
  };
}
const beat = (n, rect, extra = {}) => ({ n, caption: `Step ${n}.`, voiced: false, wait: 'click', marks: [{ kind: 'target', part: `p${n}`, at: { rect }, label: `Step ${n}` }], ...extra });
const seg = (id, k, b, last = false) => ({ id, seg: k, beats: [b], edits: [], last, win: null, busy: [] });
const overlap = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
const mid = (r) => [r[0] + r[2] / 2, r[1] + r[3] / 2];
const FILE = [100, 100, 80, 24];

// A layer surface: a beat that waits shows a chip, which is one of the overlay's click areas, and stays until pressed.
{
  const p = await page({ ROAMIE_LINUX: 'wayland', ROAMIE_LAYER: true });
  p.R.ink.play(seg('d1', 0, beat(1, FILE)));
  await p.run(4000);
  assert.deepEqual(p.sent[0], { type: 'draw_started', id: 'd1', seg: 0 });
  assert.equal(p.areas().length, 1, 'the chip is a click area (the shell makes it part of the surface\'s input region)');
  const chip = p.areas()[0];
  assert.ok(chip[0] >= 0 && chip[1] >= 0 && chip[0] + chip[2] <= 1200 && chip[1] + chip[3] <= 800, `on screen (${chip})`);
  assert.equal(overlap(chip, [FILE[0] - 10, FILE[1] - 10, FILE[2] + 20, FILE[3] + 20]), 0, 'not over the step\'s mark');
  assert.ok(p.texts.includes('Next'), 'it reads Next');
  assert.ok(!p.texts.includes('Done'));
  assert.ok(!p.asked.some(([cmd]) => cmd === 'ink_wait'), 'the shell isn\'t asked to watch for a click it can\'t see');
  // It doesn't go on by itself, and a click that isn't on the chip (the shell's, on the marked thing) changes nothing.
  await p.run(60_000);
  p.R.ink.click(...mid(FILE));
  assert.equal(p.click(...mid(FILE)), false, 'a click on the mark isn\'t the overlay\'s');
  await p.run(1000);
  assert.deepEqual(p.waits(), [], 'still waiting');
  assert.equal(p.R.ink.playing, true);
  // Pressed: on to the next beat; the chip and the step's mark go.
  assert.equal(p.click(...mid(chip)), true, 'the chip takes its click');
  await p.run(1000);
  assert.deepEqual(p.waits(), [{ type: 'draw_wait_done', id: 'd1', beat: 1, result: 'next' }]);
  assert.ok(p.sent.some((m) => m.type === 'ink_closed' && m.part === 'p1'), 'that step\'s mark is done with');
  assert.deepEqual(p.areas(), [], 'the chip is gone');
  assert.equal(p.click(...mid(chip)), false, 'and nothing is left where it was');

  // The last of several steps reads Done.
  p.texts.length = 0;
  p.R.ink.play(seg('d1', 1, beat(2, [300, 200, 80, 24], { final: true }), true));
  await p.run(4000);
  assert.ok(p.texts.includes('Done') && !p.texts.includes('Next'), 'the last one reads Done');
  assert.equal(p.click(...mid(p.areas()[0])), true);
  await p.run(1000);
  assert.deepEqual(p.waits().at(-1), { type: 'draw_wait_done', id: 'd1', beat: 2, result: 'next' });
  assert.ok(p.sent.some((m) => m.type === 'draw_done' && m.id === 'd1'));
}

// The chip keeps clear of a mark at the bottom of the screen, where the chip would otherwise go.
{
  const p = await page({ ROAMIE_LAYER: true }), low = [560, 700, 80, 40];
  p.R.ink.play(seg('d2', 0, beat(1, low)));
  await p.run(4000);
  const chip = p.areas()[0];
  assert.ok(chip, 'a chip all the same');
  assert.equal(overlap(chip, [low[0] - 10, low[1] - 10, low[2] + 20, low[3] + 20]), 0, `beside the mark, not on it (${chip})`);
  assert.ok(chip[0] >= 0 && chip[1] >= 0 && chip[0] + chip[2] <= 1200 && chip[1] + chip[3] <= 800, `on screen (${chip})`);
}

// A hover step can't be seen either: it gets the chip too.
{
  const p = await page({ ROAMIE_LAYER: true });
  p.R.ink.play(seg('d3', 0, { ...beat(1, FILE, { wait: 'hover' }), marks: [{ kind: 'hover', part: 'p1', at: { rect: FILE } }] }));
  await p.run(4000);
  assert.equal(p.areas().length, 1);
  p.click(...mid(p.areas()[0]));
  await p.run(1000);
  assert.deepEqual(p.waits(), [{ type: 'draw_wait_done', id: 'd3', beat: 1, result: 'next' }]);
}

// Esc, Clear all, a new drawing, a stale window and Stop end the wait as they did: the chip goes at once, nothing is
// reported as pressed, and where it was takes no more clicks.
for (const [why, end] of [['Esc', (R) => R.ink.clear({ all: true })], ['a new drawing', (R) => R.ink.clear({})], ['Stop', (R) => R.ink.clear({ screen: true, stop: true })], ['another window in front', (R) => R.ink.stale()]]) {
  const p = await page({ ROAMIE_LAYER: true });
  p.R.ink.play(seg('d4', 0, beat(1, FILE)));
  await p.run(4000);
  const chip = p.areas()[0];
  assert.ok(chip, `${why}: waiting on a chip`);
  end(p.R);
  assert.deepEqual(p.areas(), [], `${why}: the chip goes at once`);
  assert.equal(p.click(...mid(chip)), false, `${why}: nothing left to press`);
  await p.run(2000);
  assert.deepEqual(p.waits(), [], `${why}: no press is reported`);
  assert.equal(p.R.ink.playing, false, `${why}: the drawing has stopped`);
}

// Nobody presses it: it gives up when the sidecar does.
{
  const p = await page({ ROAMIE_LAYER: true });
  p.R.ink.play(seg('d5', 0, beat(1, FILE)));
  await p.run(4000 + 126_000);
  assert.deepEqual(p.waits(), [{ type: 'draw_wait_done', id: 'd5', beat: 1, result: 'timeout' }]);
  assert.deepEqual(p.areas(), []);
}

// Without the flag (macOS, Windows, X11), as it was: no chip, the shell watches for the click, and the click on the
// marked thing goes on.
for (const flags of [{}, { ROAMIE_LINUX: 'x11' }]) {
  const p = await page(flags);
  p.R.ink.play(seg('d6', 0, beat(1, FILE)));
  await p.run(4000);
  assert.deepEqual(p.areas(), [], 'no chip');
  assert.ok(!p.texts.includes('Next') && !p.texts.includes('Done'));
  assert.deepEqual(p.asked, [['ink_wait', true]], 'the shell watches the mouse button');
  p.R.ink.click(600, 600);
  await p.run(1000);
  assert.deepEqual(p.waits(), [], 'a click elsewhere isn\'t the step');
  p.R.ink.click(...mid(FILE));
  await p.run(1000);
  assert.deepEqual(p.waits(), [{ type: 'draw_wait_done', id: 'd6', beat: 1, result: 'clicked' }]);
  assert.deepEqual(p.asked, [['ink_wait', true], ['ink_wait', false]]);
  // And a hover: the pointer resting on the thing for half a second.
  p.R.ink.play(seg('d6', 1, { ...beat(2, FILE, { wait: 'hover' }), marks: [{ kind: 'hover', part: 'p2', at: { rect: FILE } }] }, true));
  await p.run(4000);
  assert.deepEqual(p.areas(), []);
  p.R.ink.ptr(...mid(FILE));
  await p.run(700);
  p.R.ink.ptr(...mid(FILE));
  await p.run(300);
  assert.deepEqual(p.waits().at(-1), { type: 'draw_wait_done', id: 'd6', beat: 2, result: 'hovered' });
}

console.log('walkthrough tests: passed');
