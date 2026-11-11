// Windows on Hyprland (hypr.mjs): where each window is, which one is in use, read off the compositor's own JSON
// (test/hypr.fixture.json: real `hyprctl -j` output of a two-monitor desktop, titles and app names replaced), and
// the three things it turns on in the draw tool (tools.mjs): frames fitted to the window, cards beside it, marks
// cleared when the window or workspace changes. Nothing else of the hands helper's. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHypr, hyprFront, hyprWindows, hyprctl, shownWorkspaces } from '../hypr.mjs';
import { drawWords, hasHands, onHyprland, promptWords } from '../platform.mjs';

const REAL = JSON.parse(fs.readFileSync(new URL('./hypr.fixture.json', import.meta.url), 'utf8'));
const copy = (v) => JSON.parse(JSON.stringify(v));

// ---------- the capability: Linux in a Hyprland session, nowhere else ----------
assert.ok(onHyprland('linux', { HYPRLAND_INSTANCE_SIGNATURE: 'abc_123' }));
assert.ok(!onHyprland('linux', {}) && !onHyprland('linux', { HYPRLAND_INSTANCE_SIGNATURE: '' }), 'another Linux desktop: nothing turns on');
assert.ok(!onHyprland('darwin', { HYPRLAND_INSTANCE_SIGNATURE: 'abc' }) && !onHyprland('win32', { HYPRLAND_INSTANCE_SIGNATURE: 'abc' }));
// It is not the hands helper: what the agent reads stays the no-hands wording (point by position, look first).
assert.ok(!hasHands('linux', ''));
assert.deepEqual(drawWords({ hands: hasHands('linux', ''), waits: 'chip' }), drawWords({ hands: false, waits: 'chip' }));
assert.deepEqual(promptWords({ hands: hasHands('linux', ''), waits: 'chip' }), promptWords({ hands: false, waits: 'chip' }));

// ---------- the real desktop: eDP-1 (2304×1440 logical at 0,0, scale 1.67) on workspace 1, HDMI-A-1 (1920×1080
// at 2304,0) on workspace 3; four windows, on workspaces 1, 2, 3 and 4 ----------
{
  const s = shownWorkspaces(REAL.monitors);
  assert.deepEqual([...s.shown].sort(), [1, 3], 'each monitor shows its own workspace');
  assert.equal(s.front, 1, 'the focused monitor\'s is the one in use');
  assert.equal(s.special.size, 0, 'a closed special workspace reads { address: "", name: "" }: none open');
  const wins = hyprWindows(REAL.clients, REAL.monitors);
  assert.deepEqual(wins.map((w) => [w.id, w.bounds]), [['0x55793c3bdae0', [10, 57, 2284, 1373]], ['0x55793d6af0f0', [2314, 50, 1900, 1020]]],
    'only the windows on shown workspaces, both monitors, at/size as x, y, w, h, the most recently focused first');
  assert.deepEqual(wins.map((w) => w.app), ['app-b', 'app-c']);
  const f = hyprFront(REAL.clients, REAL.monitors);
  assert.equal(f.workspace, 1);
  assert.deepEqual(f.window, { id: '0x55793c3bdae0@1', app: 'app-b', bounds: [10, 57, 2284, 1373] }, 'the active window (focusHistoryID 0) on the workspace in use');
  assert.equal(REAL.activewindow.address, '0x55793c3bdae0', 'which is what hyprctl activewindow says');
  assert.equal(REAL.activeworkspace.id, f.workspace, 'on the workspace activeworkspace says');
}

// ---------- the shapes the real one doesn't show (made from it) ----------
const mk = (address, ws, more = {}) => ({ ...copy(REAL.clients[1]), address, workspace: { id: ws, name: String(ws) }, focusHistoryID: 5, ...more });
const mons = (special) => copy(REAL.monitors).map((m, i) => (i === 0 && special ? { ...m, specialWorkspace: { id: -98, name: 'special:magic' } } : m));
{
  const clients = [
    mk('0xa', 1, { focusHistoryID: 3 }),
    mk('0xhidden', 1, { hidden: true, focusHistoryID: 0 }),
    mk('0xunmapped', 1, { mapped: false, focusHistoryID: 0 }),
    mk('0xnosize', 1, { size: [0, 0], focusHistoryID: 0 }),
    mk('0xother', 2, { focusHistoryID: 0 }),
    mk('0xfloat', 1, { floating: true, at: [400, 300], size: [600, 400], focusHistoryID: 4 }),
    mk('0xfull', 1, { fullscreen: 2, at: [0, 0], size: [2304, 1440], focusHistoryID: 6 }),
    mk('0xx11', 3, { xwayland: true, monitor: 1, at: [2400, 100], size: [800, 600], focusHistoryID: 1 }),
    mk('0xpin', 5, { pinned: true, floating: true, monitor: 0, at: [50, 900], size: [300, 200], focusHistoryID: 7 }),
    mk('0xroamies', 1, { class: 'roamies', initialClass: 'roamies', focusHistoryID: 0 }),
    mk('0xself', 1, { pid: 4242, class: 'something', focusHistoryID: 0 }),
  ];
  const ids = hyprWindows(clients, REAL.monitors, [4242]).map((w) => w.id);
  assert.deepEqual(ids, ['0xfull', '0xfloat', '0xpin', '0xx11', '0xa'], 'hidden, unmapped, sizeless, other-workspace and Roamies\' own left out; fullscreen, then floating, then by focus');
  // The front: never Roamies' own, even when it has the focus (focusHistoryID 0); the next most recent on this workspace.
  assert.equal(hyprFront(clients, REAL.monitors, [4242]).window.id, '0xa@1');
  // An XWayland window on the other monitor isn't the one in use while that monitor isn't focused…
  const other = copy(REAL.monitors).map((m) => ({ ...m, focused: m.id === 1 }));
  const f = hyprFront(clients, other, [4242]);
  assert.deepEqual([f.workspace, f.window.id, f.window.bounds], [3, '0xx11@3', [2400, 100, 800, 600]], '…and is once it is');
  // A special workspace open over the focused monitor: its windows are on top, and it is the workspace in use
  // (opening it focuses its window).
  const sp = [...clients, mk('0xscratch', -98, { floating: true, focusHistoryID: 0 })];
  assert.equal(hyprWindows(sp, mons(true), [4242])[0].id, '0xscratch');
  assert.deepEqual(hyprFront(sp, mons(true), [4242]), { workspace: -98, window: { id: '0xscratch@-98', app: 'app-b', bounds: REAL.clients[1].at.concat(REAL.clients[1].size) } });
  // A pinned window shows on every workspace of its monitor: on an otherwise empty one it is the front.
  const pinnedOnly = [mk('0xpin', 5, { pinned: true, monitor: 0, focusHistoryID: 2 })];
  assert.equal(hyprFront(pinnedOnly, REAL.monitors).window.id, '0xpin@1', 'keyed with the workspace in use: switching keeps the address but is a change');
  // Nothing on the workspace in use: no window, still which workspace (switching to an empty one is a change).
  assert.deepEqual(hyprFront([mk('0xother', 2)], REAL.monitors), { workspace: 1, window: null });
  // Answers that aren't what they should be: nothing, never a throw.
  assert.deepEqual(hyprWindows(null, null), []);
  assert.deepEqual(hyprWindows([null, { address: '0x1' }, { at: 'x', size: [1, 1], workspace: { id: 1 } }], REAL.monitors), []);
  assert.equal(hyprFront(REAL.clients, []), null, 'no monitors: the workspace in use can\'t be told');
  assert.equal(hyprFront(REAL.clients, [{ ...REAL.monitors[0], focused: true, disabled: true }]), null);
}

// ---------- the source: the helper's reply shapes, and nothing when hyprctl doesn't answer ----------
{
  const asked = [];
  const src = createHypr({ ask: async (w) => { asked.push(w); return copy(REAL[w]); }, self: [] });
  assert.deepEqual(await src.windows(), { ok: true, windows: [{ id: '0x55793c3bdae0', app: 'app-b', bounds: [10, 57, 2284, 1373] }, { id: '0x55793d6af0f0', app: 'app-c', bounds: [2314, 50, 1900, 1020] }] });
  assert.deepEqual(await src.front(), { ok: true, workspace: 1, window: { id: '0x55793c3bdae0@1', app: 'app-b', bounds: [10, 57, 2284, 1373] } });
  assert.deepEqual([...new Set(asked)].sort(), ['clients', 'monitors'], 'only read-only queries');
  const dead = createHypr({ ask: async () => null });
  assert.equal(await dead.windows(), null);
  assert.equal(await dead.front(), null);
  assert.equal(await createHypr({ ask: async (w) => (w === 'clients' ? copy(REAL.clients) : { error: 'x' }) }).front(), null);
}

// ---------- hyprctl itself: bounded in time, only reads ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-hypr-test-'));
  const bin = path.join(dir, 'hyprctl'), log = path.join(dir, 'args');
  const PATH = process.env.PATH;
  try {
    // A hung compositor: hyprctl never answers (and something it started holds its output open). Given up on within
    // the timeout, as no windows.
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\nsleep 3 & wait\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${PATH}`;
    const t = Date.now();
    assert.equal(await hyprctl('clients', 300), null);
    assert.ok(Date.now() - t < 1500, `a hung hyprctl is dropped in time (${Date.now() - t} ms)`);
    // A good answer, and one that isn't JSON.
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\necho '[{"id":1}]'\n`, { mode: 0o755 });
    assert.deepEqual(await hyprctl('monitors'), [{ id: 1 }]);
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\necho 'Couldn'"'"'t connect'\n`, { mode: 0o755 });
    assert.equal(await hyprctl('clients'), null);
    // Anything but a read is never run.
    assert.equal(await hyprctl('dispatch'), null);
    assert.equal(await hyprctl('keyword'), null);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['-j clients', '-j monitors', '-j clients']);
    // No hyprctl at all.
    process.env.PATH = dir.replace(/[^/]+$/, 'roamies-no-such-dir');
    assert.equal(await hyprctl('clients'), null);
  } finally { process.env.PATH = PATH; fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- the draw tool with a window source (Linux: the picture comes from the app) ----------
if (process.platform === 'linux' && !process.env.ROAMIES_HANDS) {
  const { createTools, drawDescription } = await import('../tools.mjs');
  const noop = () => {};
  // The screen in use, 1920×1080 at 0,0, sent as 1568×882: x, y in the picture × 1920/1568 on screen.
  const SHOT = { ok: true, pixels: [1568, 882], bounds: [0, 0, 1920, 1080], of: 'screen' };
  const askShell = async (m) => { if (m.type === 'screenshot') fs.writeFileSync(m.file, 'jpeg'); return SHOT; };
  const WIN = [100, 80, 1200, 800];
  const make = (winSource) => {
    const seen = { segs: [], stale: 0, gone: [], clicks: [], src: winSource };
    const made = createTools({
      allowActions: () => false, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Kai', askShell, waits: 'chip', winSource,
      onInkGone: (why) => seen.gone.push(why), watchClicks: (on) => seen.clicks.push(on),
      ui: (m) => {
        if (m.kind !== 'agent') return;
        if (m.e.type === 'ink_stale') seen.stale++;
        if (m.e.type !== 'draw') return;
        seen.segs.push(m.e);
        setImmediate(() => made.ink.started(m.e.id, m.e.seg));
      },
    });
    seen.tool = (n) => made.tools.find((t) => t.name === n);
    return seen;
  };
  // A fake source: the window in use can be swapped, and it can stop answering.
  const fake = () => {
    const s = { front: { ok: true, workspace: 1, window: { id: '0xa@1', app: 'app-a', bounds: WIN } }, asked: 0 };
    s.windows = async () => { s.asked++; return { ok: true, windows: [{ id: '0xa', app: 'app-a', bounds: WIN }, { id: '0xb', app: 'app-b', bounds: [1320, 80, 600, 900] }] }; };
    s.frontNow = async () => s.front;
    return { src: { windows: s.windows, front: () => s.frontNow() }, s };
  };
  // A frame drawn a little off round the window (in picture pixels), and a card.
  const px = (v) => (v * 1568) / 1920;
  const frame = { kind: 'frame', at: { x: px(100 + 600 + 12), y: px(80 + 400 - 10), w: px(1200 - 20), h: px(800 + 16) } };
  const draw = async (t, marks) => { await t.tool('take_screenshot').execute({ target: 'screen' }, {}); return t.tool('draw').execute({ beats: [{ say: 'This window.', marks }] }, { toolCallId: `d${Date.now()}` }); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1. The frame takes the window's own edges.
  {
    const { src } = fake(), t = make(src);
    await draw(t, [frame]);
    assert.deepEqual(t.segs[0].beats[0].marks[0].at.rect, WIN, 'fitted to the window Hyprland says is there');
  }
  // 2. Cards: the overlay is told where the window in use is, to keep them beside it.
  {
    const { src } = fake(), t = make(src);
    await draw(t, [{ kind: 'card', heading: 'About this', text: 'Words.' }]);
    assert.deepEqual(t.segs[0].win, WIN);
  }
  // 3. Marks go when another window comes to the front, or another workspace (empty) is shown; not while it stays.
  {
    const { src, s } = fake(), t = make(src);
    await draw(t, [{ kind: 'ring', at: { x: 300, y: 300 } }]);
    await wait(1700);
    assert.equal(t.stale, 0, 'same window, same place: the drawing stays');
    // hyprctl stops answering for a while: never counts as a change.
    s.frontNow = async () => null;
    await wait(1600);
    assert.equal(t.stale, 0, 'no answer is not a change');
    s.frontNow = async () => s.front;
    s.front = { ok: true, workspace: 1, window: { id: '0xb@1', app: 'app-b', bounds: [1320, 80, 600, 900] } };
    await wait(1600);
    assert.equal(t.stale, 1, 'another window in front: the drawing goes');
    assert.deepEqual(t.gone, ['window']);
    assert.ok(!t.clicks.includes(true), 'no click watching: Hyprland gives no clicks');
  }
  {
    const { src, s } = fake(), t = make(src);
    await draw(t, [{ kind: 'ring', at: { x: 300, y: 300 } }]);
    s.front = { ok: true, workspace: 2 };
    await wait(1700);
    assert.equal(t.stale, 1, 'an empty workspace shown: the drawing goes');
  }
  // Without a source (any other Linux desktop), as it was: the frame as drawn, no window for cards, no watching.
  {
    const t = make(null);
    await draw(t, [frame, { kind: 'card', heading: 'About this', text: 'Words.' }]);
    const r = t.segs[0].beats[0].marks[0].at.rect;
    assert.notDeepEqual(r, WIN, 'not fitted');
    assert.deepEqual(r, [122, 62, 1180, 816], 'the box as drawn');
    assert.equal(t.segs[0].win, null);
    await wait(1700);
    assert.equal(t.stale, 0);
  }
  // The draw tool and the tools listed are the no-hands ones on Hyprland too: no list_windows, read_window, act_in_app.
  {
    const { src } = fake(), t = make(src);
    assert.equal(t.tool('draw').description, drawDescription({ hands: false, waits: 'chip' }));
    assert.ok(!t.tool('list_windows') && !t.tool('read_window') && !t.tool('act_in_app'));
  }
  // With a hands helper (macOS and Windows; test/hands.test.mjs there), as it was: its windows and locate front win
  // over any source, and a click in the window is watched. A fake helper, in a second copy of tools.mjs that reads it.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-hypr-helper-'));
    const fakeHelper = path.join(dir, 'hands.mjs'), swap = path.join(dir, 'front.json');
    fs.writeFileSync(fakeHelper, `import fs from 'node:fs'; const a = process.argv.slice(2);
const win = fs.existsSync(${JSON.stringify(swap)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(swap)}, 'utf8')) : { id: 7, app: 'Editor', bounds: ${JSON.stringify(WIN)} };
let o = { ok: true };
if (a[0] === 'windows') o = { ok: true, windows: [win] };
if (a[0] === 'locate') o = { ok: true, window: win };
console.log(JSON.stringify(o));
`);
    process.env.ROAMIES_HANDS = fakeHelper;
    const helped = await import('../tools.mjs?helper');
    delete process.env.ROAMIES_HANDS;
    const segs = [], clicks = [];
    let stale = 0;
    const made = helped.createTools({
      allowActions: () => false, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Kai', askShell, waits: 'chip',
      winSource: { windows: async () => ({ ok: true, windows: [] }), front: async () => null }, watchClicks: (on) => clicks.push(on),
      ui: (m) => { if (m.kind !== 'agent') return; if (m.e.type === 'ink_stale') stale++; if (m.e.type === 'draw') { segs.push(m.e); setImmediate(() => made.ink.started(m.e.id, m.e.seg)); } },
    });
    const tool = (n) => made.tools.find((x) => x.name === n);
    await tool('take_screenshot').execute({ target: 'screen' }, {});
    await tool('draw').execute({ beats: [{ say: 'This window.', marks: [frame, { kind: 'card', heading: 'About this', text: 'Words.' }] }] }, { toolCallId: 'h1' });
    assert.deepEqual(segs[0].beats[0].marks[0].at.rect, WIN, 'fitted to the helper\'s window');
    assert.deepEqual(segs[0].win, WIN, 'cards beside the helper\'s front window');
    assert.deepEqual(clicks, [true], 'clicks in the window are watched');
    fs.writeFileSync(swap, JSON.stringify({ id: 9, app: 'Other', bounds: [0, 0, 900, 700] }));
    // The watch looks every 1.5 s and asks the helper (a node process) each time: wait for it rather than a fixed
    // time, which was too tight on a loaded machine (CI, Windows).
    for (const t0 = Date.now(); stale < 1 && Date.now() - t0 < 8000;) await wait(100);
    assert.equal(stale, 1, 'another window in front: the drawing goes');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('hypr tests passed');
