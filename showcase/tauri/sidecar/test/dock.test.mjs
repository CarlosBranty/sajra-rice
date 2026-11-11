// A desktop bar that hosts the Roamie (Linux): it comes out of the bar's slot and goes back into it
// (showcase/roamies/10-dither.js: the 'dock' performance; agent.js: setDock). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const noop = () => {};
// A drawing context that takes anything: only the text measuring has to answer.
const ctx2d = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 7 }) : noop), set: () => true });
const window = {};
const ctx = {
  window, Math, Map, Set, Promise, performance, console, setTimeout, clearTimeout, Uint32Array, Uint8ClampedArray, Uint8Array, Float32Array, URLSearchParams,
  matchMedia: () => ({ matches: false, addEventListener: noop }), addEventListener: noop, document: { addEventListener: noop, createElement: () => ({ getContext: () => ctx2d }) },
  ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
};
vm.createContext(ctx);
const load = (f) => vm.runInContext(fs.readFileSync(new URL(`../../../roamies/${f}`, import.meta.url), 'utf8'), ctx);
load('core.js');
vm.runInContext('var Roamie = window.Roamie;', ctx);
for (const f of ['theme.js', 'glass.js', '10-dither.js', 'agent.js']) load(f);
const R = window.Roamie;

const W = 1200, H = 800, BAR = 46;
const env = { w: W, h: H, dpr: 1, t: 0, unit: 400, margin: 0.05, curiosity: 0.3, transparent: true, safe: { top: BAR, right: 0, bottom: 0, left: 0 }, mouse: { x: -1, y: -1, active: false } };
const PAL = [[4, 16, 18], [14, 92, 96], [40, 196, 184], [120, 255, 226], [230, 255, 250]];
const make = (plugin) => { const c = R.ditherKit({ id: 't', label: 'T', matrix: true, pixel: 1.3, pal: PAL, plugin }).create(env); c.vanish(null, true); return c; };
const at = (c) => [c.mover.x, c.mover.y];
const dist = (c, p) => Math.hypot(c.mover.x - p[0], c.mover.y - p[1]);
const DT = 1 / 60;
// Steps the performance, checking on the way that it only ever gets closer to where it's going.
const travel = (c, to, secs, why) => {
  let d = dist(c, to);
  for (let i = 0; i < Math.ceil(secs / DT); i++) {
    c.update(DT, env);
    const n = dist(c, to);
    assert.ok(n <= d + 1e-6, `${why}: never moves away (${n.toFixed(1)} after ${d.toFixed(1)})`);
    d = n;
  }
};

// Out of the slot: it starts there, hidden behind the bar, and ends on its spot, on screen.
{
  const c = make(), slot = [1000, -20], spot = [600, 400];
  assert.equal(c.appear('dock', spot[0], spot[1], slot), true);
  assert.deepEqual(at(c), slot, 'starts at the slot');
  assert.equal(c.hidden, false, 'on its way in');
  travel(c, spot, 0.8, 'coming out');
  assert.deepEqual(at(c), spot, 'ends on its spot');
  assert.equal(c.hidden, false);

  // Back into the slot, and gone once it's there.
  assert.equal(c.vanish('dock', false, slot), true);
  assert.equal(c.gone, false, 'still on screen while it flies back');
  travel(c, slot, 0.8, 'going back');
  assert.ok(dist(c, slot) < 1, `ends in the slot (${at(c)})`);
  assert.equal(c.gone, true);
}

// No slot to come from or go to: 'dock' is the plain in-place entrance and exit.
{
  const c = make();
  assert.equal(c.appear('dock', 600, 400), true);
  assert.deepEqual(at(c), [600, 400], 'appears in place');
  for (let i = 0; i < 90; i++) c.update(DT, env);
  assert.equal(c.vanish('dock'), true);
  for (let i = 0; i < 90; i++) c.update(DT, env);
  assert.ok(dist(c, [600, 400]) < 1, 'and leaves in place');
  assert.equal(c.gone, true);
}

// The other entrances are as they were: drop falls in from above its spot, materialize appears on it,
// and a slot handed to them changes nothing.
{
  const c = make();
  c.appear('drop', 600, 400, [1000, -20]);
  assert.equal(c.mover.x, 600);
  assert.ok(c.mover.y < 0, 'drop starts above the screen');
  for (let i = 0; i < 60; i++) c.update(DT, env);
  assert.deepEqual(at(c), [600, 400]);
  const d = make();
  d.appear('materialize', 300, 500, [1000, -20]);
  assert.deepEqual(at(d), [300, 500]);
}

// The agent layer. With no dock it appears as before: on its spot, or above it for a drop.
{
  const c = make((kit) => R.agentPlugin(kit));
  c.update(DT, env);
  assert.equal(c.agent.out, false, 'hidden: not out');
  c.agent.show();
  assert.ok(c.mover.x >= 0 && c.mover.x <= W && c.mover.y <= H, 'appears over the screen');
  assert.ok(c.mover.y < 0 || c.mover.y > BAR, 'on its spot below the bar, or dropping in from above');
  assert.equal(c.agent.out, true);
}

// With a dock: it comes out from behind the bar at the slot's x, settles near the slot rather than across the
// screen, and when told to hide goes back in. `out` holds until it's fully gone (the bar draws it only then).
{
  const c = make((kit) => R.agentPlugin(kit)), a = c.agent, slot = { x: 1000, y: BAR / 2 };
  c.update(DT, env);
  a.setDock(slot);
  a.show();
  assert.equal(c.mover.x, slot.x, 'starts at the slot');
  assert.ok(c.mover.y < BAR - 40, `starts wholly behind the bar (${c.mover.y})`);
  assert.equal(a.out, true);
  for (let i = 0; i < 50; i++) c.update(DT, env);
  assert.ok(c.mover.y > BAR + 40, 'comes out below the bar');
  assert.ok(Math.abs(c.mover.x - slot.x) < W / 3 && c.mover.y < H / 2, `its first spot is near the slot (${at(c)})`);
  a.hide();
  assert.equal(a.out, true, 'still out while it flies back');
  for (let i = 0; i < 50; i++) c.update(DT, env);
  assert.equal(c.gone, true);
  assert.equal(a.out, false);
  assert.ok(Math.abs(c.mover.x - slot.x) < 1 && c.mover.y < BAR - 40, `ended in the slot (${at(c)})`);

  // Bad or cleared dock: back to the usual entrances.
  for (const bad of [null, {}, { x: NaN, y: 3 }, { x: '5', y: 3 }]) {
    a.setDock(bad);
    a.show();
    assert.ok(c.mover.y < -40 || c.mover.y > BAR, `not from the slot (${at(c)})`);
    a.hide({ instant: true });
  }
}

// Regression: hiding the Roamie with its shortcut while a typed question was open left the overlay holding the
// keyboard with nothing on screen (on a tiling desktop nothing else could be typed in until a click).
{
  const host = fs.readFileSync(new URL('../../../roamies/host.js', import.meta.url), 'utf8');
  const summon = host.slice(host.indexOf("if (m.kind === 'summon')"), host.indexOf("if (m.kind === 'say')"));
  assert.match(summon, /else \{ if \(ask\) finishAsk\(null\); a\.hide\(\); \}/, 'hiding closes an open question, which gives the keyboard back');
}

console.log('dock tests: passed');
