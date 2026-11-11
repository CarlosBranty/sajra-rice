// Screenshot pixels → screen points for draw / click_at. Run: npm test
import assert from 'node:assert/strict';
import { shotFits, shotMap, snapRect, toScreen, parseSipsSize } from '../pointing.mjs';

// Regression: an 1800×1066 pt Brave window at (0, 39) is captured at 3600 px and capped to 1568 px wide.
// Image pixels used to be treated as points, so points landed up and left of the target.
const brave = shotMap([0, 39, 1800, 1066], 1568, 929);
assert.deepEqual(toScreen(brave, 1026, 531), [1178, 648], 'scales up and adds the window origin');
assert.deepEqual(toScreen(brave, 0, 0), [0, 39], 'image corner is the window corner');
assert.deepEqual(toScreen(brave, 1568, 929), [1800, 1105], 'far corner is the far window corner');

// A small window isn't capped, so its Retina image is twice its size in points.
const small = shotMap([400, 300, 700, 500], 1400, 1000);
assert.deepEqual(toScreen(small, 700, 500), [750, 550], 'Retina 2x maps back to points');

assert.deepEqual(parseSipsSize('/tmp/a.jpg\n  pixelWidth: 1568\n  pixelHeight: 929\n'), [1568, 929]);
assert.equal(parseSipsSize('garbage'), null);
console.log('screenshot coordinate tests: passed');

// Regression: after navigating, id 70 was a pinned post instead of SETTINGS, so Sidekick pointed at the wrong thing.
{
  const { rematch, sameBounds } = await import('../pointing.mjs');
  const read = [
    { id: 69, role: 'link', label: 'Members', bounds: [1100, 560, 80, 20] },
    { id: 70, role: 'button', label: 'SETTINGS', bounds: [1060, 620, 230, 40] },
  ];
  const settings = read[1];
  const after = [
    { id: 70, role: 'link', label: '👾 Join our Discord here (a must)', bounds: [300, 400, 500, 30] },
    { id: 71, role: 'button', label: 'SETTINGS', bounds: [1060, 700, 230, 40] },
  ];
  const fresh = Array.from({ length: 69 }, (_, i) => ({ id: i + 1, role: 'link', label: `x${i}`, bounds: [0, 0, 1, 1] })).concat(after);
  assert.equal(rematch(settings, fresh, 70)?.id, 71, 'finds SETTINGS at its new id');
  const unchanged = Array.from({ length: 68 }, (_, i) => ({ id: i + 1, role: 'link', label: `x${i}`, bounds: [0, 0, 1, 1] })).concat(read);
  assert.equal(rematch(settings, unchanged, 70)?.label, 'SETTINGS', 'same page keeps the id');
  assert.equal(rematch(settings, fresh.filter((c) => c.label !== 'SETTINGS'), 70), null, 'gone from the page: refuse');
  assert.equal(rematch({ role: 'button', label: '', bounds: [0, 0, 1, 1] }, fresh, 70), null, 'unlabelled and changed: refuse');
  assert.equal(rematch(undefined, fresh, 70), null, 'id never read: refuse');
  // Two SETTINGS buttons: take the one nearest where it was.
  const two = [{ id: 1, role: 'button', label: 'SETTINGS', bounds: [10, 10, 50, 20] }, { id: 2, role: 'button', label: 'SETTINGS', bounds: [1070, 640, 230, 40] }];
  assert.equal(rematch(settings, two, 70)?.id, 2, 'nearest match wins');
  assert.ok(sameBounds([0, 39, 1800, 1066], [0, 40, 1800, 1066]) && !sameBounds([0, 39, 1800, 1066], [200, 39, 1800, 1066]));
  console.log('stale control id tests: passed');
}

// Regression: after switching pages or apps, Sidekick pointed using what it saw for the previous request.
{
  const { shotProblem, readProblem } = await import('../pointing.mjs');
  assert.match(shotProblem(null, 3), /Take a screenshot first/);
  assert.equal(shotProblem({ turn: 3 }, 3), null, 'a screenshot from this request is fine');
  assert.match(shotProblem({ turn: 2 }, 3), /before the user's latest message/, 'a screenshot from the last request is refused');
  assert.match(shotProblem({ turn: 3, used: true }, 3), /clicked or opened since/, 'a screenshot taken before a click is refused');
  assert.equal(readProblem({ win: 7, turn: 3 }, 7, 3), null, 'this window, this request');
  assert.match(readProblem({ win: 7, turn: 2 }, 7, 3), /before the user's latest message/, 'last request: read again');
  assert.match(readProblem({ win: 7, turn: 3 }, 9, 3), /read_window on this window first/, 'another window: read it first');
  assert.match(readProblem(null, 9, 3), /read_window on this window first/);
  console.log('freshness tests: passed');
}

// Regression: CapCut's 183×88 pt button window came back with a 1568×935 picture of the whole app, and every mark
// was squeezed into the button's corner. A picture that isn't the shape of its area isn't used to point.
assert.equal(shotFits([1625, 1029, 183, 88], 1568, 935), false, 'the button bounds with the whole-window picture');
assert.equal(shotFits([0, 39, 1800, 1066], 1568, 929), true, 'a window capped to 1568 px');
assert.equal(shotFits([0, 39, 1808, 1078], 1568, 935), true, 'a window with its child window');
assert.equal(shotFits([400, 300, 700, 500], 1400, 1000), true, 'a small Retina window');
assert.equal(shotFits([0, 0, 0, 0], 1568, 935), false, 'no area');
{
  const { shotProblem } = await import('../pointing.mjs');
  assert.match(shotProblem({ unmapped: true, turn: 1 }, 1), /doesn't line up/);
}
console.log('screenshot shape tests: passed');

// A loop guessed from screenshot pixels, a little off a real button, takes the button's exact box.
{
  const theme = [1445, 88, 37, 36], discord = [1533, 88, 37, 36];
  assert.deepEqual(snapRect([1447, 96, 37, 36], [discord, theme]), theme, 'a few points low: snapped');
  assert.equal(snapRect([1300, 300, 40, 40], [discord, theme]), null, 'nothing near: left as drawn');
  assert.equal(snapRect([1440, 85, 140, 42], [discord, theme]), null, 'round a group of icons: not shrunk to one');
  assert.equal(snapRect([1460, 100, 8, 8], [theme]), null, 'a tiny spot inside a big control: not grown');
  console.log('snap tests: passed');
}

// ---------- Linux: the app's own screenshot (the screen in use, cut out of a capture of every screen) ----------
{
  const { shellShot, createTools } = await import('../tools.mjs');
  const { shotProblem } = await import('../pointing.mjs');
  const fsp = await import('node:fs/promises');
  // A desk with two screens: a laptop's (2304×1440 at 0,0) and a monitor to its right (1920×1080 at 2304,0). What
  // the app answers for each is worked out and checked in src-tauri/src/linux.rs
  // (a_pixel_of_the_screens_picture_is_its_place_on_the_desk); from there to a place on the desk is checked here.
  const LAPTOP = { ok: true, pixels: [1568, 980], bounds: [0, 0, 2304, 1440], of: 'screen' };
  const SIDE = { ok: true, pixels: [1568, 882], bounds: [2304, 0, 1920, 1080], of: 'screen' };
  const laptop = shellShot(LAPTOP, { turn: 3 });
  assert.deepEqual(toScreen(laptop.shot, 1361, 885), [2000, 1300], 'a button low on the laptop\'s screen');
  assert.deepEqual(toScreen(laptop.shot, 0, 0), [0, 0]);
  const side = shellShot(SIDE, { turn: 3 });
  assert.deepEqual(toScreen(side.shot, 784, 441), [3264, 540], 'the middle of the monitor, past the laptop\'s width');
  assert.deepEqual(toScreen(side.shot, 100, 50), [2426, 61]);
  assert.deepEqual(toScreen(side.shot, 1568, 882), [4224, 1080], 'its far corner');
  assert.deepEqual([side.shot.bounds, side.shot.size, side.shot.win, side.shot.turn], [[2304, 0, 1920, 1080], [1568, 882], null, 3]);
  assert.equal(shotProblem(side.shot, 3), null, 'good to point by');
  assert.equal(side.text, "Screenshot of the screen in use (1568×882 px; for draw give x, y in this image's pixels).", 'one screen of several is called that');
  assert.equal(shellShot(SIDE, { turn: 3, target: 'Firefox' }).text, "Screenshot of the screen in use (one app's window can't be captured alone on Linux, so this is the screen in use) (1568×882 px; for draw give x, y in this image's pixels).");

  // As it was: the whole desktop (one screen, or the screen in use isn't known), in the same words.
  const ONE = { ok: true, pixels: [1568, 882], bounds: [0, 0, 1920, 1080] };
  const one = shellShot(ONE, { turn: 1 });
  assert.deepEqual(toScreen(one.shot, 784, 441), [960, 540]);
  assert.equal(one.text, "Screenshot of the whole desktop (1568×882 px; for draw give x, y in this image's pixels).");
  assert.equal(shellShot(ONE, { turn: 1, target: 'front' }).text, "Screenshot of the whole desktop (one app's window can't be captured alone on Linux, so this is the whole desktop) (1568×882 px; for draw give x, y in this image's pixels).");
  assert.equal(shellShot({ ok: true, pixels: [1568, 882] }, { turn: 1 }).shot, null, 'no bounds: nothing to point by');
  assert.equal(shellShot({ ok: true }, { turn: 1 }).text, 'Screenshot of the whole desktop.');

  // Regression: both screens came as one 1568×535 picture; a picture that is one screen's while its bounds are the
  // whole desk's (or any other mismatch) was mapped all the same, and the marks landed somewhere else. It is
  // refused now, as on macOS and Windows.
  const WRONG = { ok: true, pixels: [1568, 882], bounds: [0, 0, 4224, 1440] };
  const wrong = shellShot(WRONG, { turn: 5 });
  assert.deepEqual(wrong.shot, { unmapped: true, turn: 5, words: false }, 'not mapped');
  assert.equal(wrong.text, "Screenshot of the whole desktop (it doesn't line up with the screen, so don't point by its pixels).");
  // Why not, for the model: no "use its words" here, since nothing finds things by their words without the helper.
  assert.equal(shotProblem(wrong.shot, 5), "That screenshot doesn't line up with the screen, so its pixels can't be used to point. Say where the thing is in words instead.");
  assert.match(shotProblem({ unmapped: true, turn: 5 }, 5), /Point with the thing's visible words \(text\) instead\.$/, 'with the helper: as it was');
  assert.deepEqual(shellShot(WRONG, { turn: 5, words: true }).shot, { unmapped: true, turn: 5 }, 'a helper that finds words: the helpers\' own refusal');
  assert.equal(shellShot({ ok: true, pixels: [1568, 535], bounds: [0, 0, 4224, 1440] }, { turn: 5 }).shot.unmapped, undefined, 'the whole desk in its own shape still maps');

  // The tool itself on Linux (without the helper): the app's answer is asked for, and a picture that doesn't fit
  // can't be drawn by.
  if (process.platform === 'linux' && !process.env.ROAMIES_HANDS) {
    const noop = async () => {};
    let answer = SIDE;
    const askShell = async (m) => { assert.equal(m.type, 'screenshot'); await fsp.writeFile(m.file, 'jpeg'); return answer; };
    const { tools } = createTools({ allowActions: () => false, ui: () => {}, ask: noop, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'T', askShell });
    const tool = (n) => tools.find((x) => x.name === n);
    const ring = { beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { x: 784, y: 441, w: 40, h: 20 } }] }] };
    answer = WRONG;
    const bad = await tool('take_screenshot').execute({ target: 'screen' }, {});
    assert.match(bad.content[0].text, /doesn't line up with the screen/);
    assert.equal(bad.content[1].type, 'image', 'the picture is still there to look at');
    await assert.rejects(tool('draw').execute(ring, { toolCallId: 'd1' }), /doesn't line up with the screen, so its pixels can't be used to point/, 'no mark from a picture that doesn\'t fit');
    answer = SIDE;
    const good = await tool('take_screenshot').execute({ target: 'screen' }, {});
    assert.match(good.content[0].text, /^Screenshot of the screen in use \(1568×882 px/);
    // A picture that fits gets as far as the overlay (which isn't there in this test), not a refusal.
    const ac = new AbortController();
    const drawn = tool('draw').execute(ring, { toolCallId: 'd2', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    assert.equal(await drawn, 'Stopped.', 'a picture that fits is drawn by');
  }
  console.log('linux screenshot tests: passed');
}
