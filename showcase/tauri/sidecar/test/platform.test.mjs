// What the model is told about each system, and which features each one gets. Run: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { bindCommands, canCircle, canSnap, circleWords, mousePen, hasHands, hasHotkeys, hasVoice, linuxSession, micTrouble, needsVoiceModel, platformLine, seesPointer } from '../platform.mjs';

const win = platformLine('win32', { arch: 'x64', release: '10.0.22631' });
assert.match(win, /^Platform: Windows 11 on x64\./);
assert.match(win, /Ctrl, not Cmd/, 'Windows keys, not Mac ones');
assert.match(win, /Ctrl\+End and Ctrl\+Home/);
assert.match(win, /cmd\.exe/, 'commands run in cmd, not a Unix shell');
assert.ok(!/Cmd\+Down|BSD/.test(win), 'none of the Mac advice');
assert.match(platformLine('win32', { release: '10.0.19045' }), /^Platform: Windows 10 /);
const mac = platformLine('darwin', { macVersion: '15.1', arch: 'arm64' });
assert.match(mac, /^Platform: macOS 15\.1 on Apple silicon\. Use Mac keys: Cmd, not Ctrl/);
assert.equal(platformLine('freebsd'), 'Platform: freebsd.');

// Linux: PC keys and GNU tools, and on Wayland what the app can't see there.
const x11 = platformLine('linux', { arch: 'x64', session: 'x11', desktop: 'XFCE', distro: 'Linux Mint 22' });
assert.match(x11, /^Platform: Linux \(Linux Mint 22\) on x64, the XFCE desktop on X11\./);
assert.match(x11, /Ctrl, not Cmd/);
assert.match(x11, /Ctrl\+End and Ctrl\+Home/);
assert.match(x11, /bash with the GNU tools/);
assert.ok(!/Cmd\+Down|BSD|cmd\.exe|Wayland/.test(x11), 'none of the Mac or Windows advice, and no Wayland limits on X11');
const wl = platformLine('linux', { arch: 'arm64', session: 'wayland', desktop: 'ubuntu:GNOME', distro: 'Ubuntu 26.04 LTS' });
assert.match(wl, /^Platform: Linux \(Ubuntu 26\.04 LTS\) on Arm, the GNOME desktop on Wayland\./, 'the desktop is the last part of XDG_CURRENT_DESKTOP');
assert.match(wl, /never waits for a click or hover/, 'Wayland: no waiting on what it cannot see');
assert.match(platformLine('linux', {}), /^Platform: Linux on x64, a desktop on Wayland\./, 'not told the session: the careful answer');

// The session: what the app says, else the same signs it reads.
assert.equal(linuxSession({ ROAMIES_SESSION: 'x11', WAYLAND_DISPLAY: 'wayland-0' }), 'x11', 'the app knows best');
assert.equal(linuxSession({ ROAMIES_SESSION: 'wayland' }), 'wayland');
assert.equal(linuxSession({ XDG_SESSION_TYPE: 'wayland' }), 'wayland');
assert.equal(linuxSession({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), 'wayland');
assert.equal(linuxSession({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), 'x11');
assert.equal(linuxSession({ ROAMIES_SESSION: 'nonsense' }), 'x11');

// The pointer over other apps and global shortcuts: everywhere but Wayland.
assert.ok(seesPointer('darwin') && seesPointer('win32') && seesPointer('linux', 'x11') && !seesPointer('linux', 'wayland') && !seesPointer('linux', ''));
assert.ok(hasHotkeys('darwin') && hasHotkeys('win32') && hasHotkeys('linux', 'x11') && !hasHotkeys('linux', 'wayland'));
// Voice: Linux has it, with the same downloaded model as Windows.
assert.ok(hasVoice('darwin') && hasVoice('win32') && hasVoice('linux') && !hasVoice('freebsd'));
assert.ok(!needsVoiceModel('darwin') && needsVoiceModel('win32') && needsVoiceModel('linux'));
// No hands helper on Linux yet: nothing reads or works other apps, no area snap, no circling.
assert.ok(!hasHands('linux', '') && !canSnap('linux', '') && !canCircle('linux'));

// Ask About an Area needs the helper's area selection: macOS, and Windows with the helper there.
assert.ok(canSnap('darwin', '') && canSnap('win32', 'C:\\Roamies\\roamies-hands.exe'));
assert.ok(!canSnap('win32', '') && !canSnap('linux', '/x/roamies-hands'));
assert.ok(hasHands('darwin', '') && hasHands('win32', 'x') && !hasHands('win32', ''));
assert.ok(canCircle('darwin') && canCircle('win32') && !canCircle('linux'));
// Circling while talking on Linux: a Wayland layer surface takes the mouse while a take is heard (ROAMIES_LAYER=1),
// and the mouse draws there (mousePen); nowhere else on Linux. macOS and Windows: the helper's pen, as before.
assert.ok(canCircle('linux', '1') && !canCircle('linux', '') && !canCircle('linux', '0'), 'Linux: layer surfaces only');
assert.ok(canCircle('darwin', '1') && canCircle('win32', '') && !canCircle('freebsd', '1'), 'the others: as before, layer or not');
assert.ok(mousePen('linux', '1') && !mousePen('linux', '') && !mousePen('darwin', '1') && !mousePen('win32', '1'), 'the mouse draws only on a layer surface');
// What the model is told: the helper's words on macOS and Windows, byte for byte; the mouse's on a layer surface,
// and nothing when it can't be done (or the Voice page switched the mouse off).
const HELPER = "; while holding the talk keys, moving the cursor round something circles it (no clicking; it snaps shut with a click when the circle closes, and loose lines don't count) and you'll see what they circled";
assert.equal(circleWords('darwin'), HELPER);
assert.equal(circleWords('win32', '', false), HELPER, 'the setting is the mouse\'s only');
assert.equal(circleWords('linux', ''), '', 'X11 and Wayland without layer surfaces: nothing');
assert.equal(circleWords('linux', '1', false), '', 'switched off on the Voice page: nothing');
const mouse = circleWords('linux', '1', true);
assert.match(mouse, /^; while they talk to you, /);
assert.match(mouse, /dragging with the mouse/, 'the mouse, not the cursor following by itself');
assert.match(mouse, /a click without dragging/, 'and how to stop it');
assert.ok(!/talk keys|holding/.test(mouse), 'no talk keys to hold on Wayland');
// Linux: slurp picks the area, a Wayland layer-shell tool, so a Wayland session whose compositor has layer surfaces
// (the app says so with ROAMIES_LAYER=1) and slurp there (ROAMIES_SLURP, its path).
const wlArea = { session: 'wayland', layer: '1', slurp: '/usr/bin/slurp' };
assert.ok(canSnap('linux', '', wlArea), 'Wayland, layer surfaces and slurp: on');
assert.ok(!canSnap('linux', '', { ...wlArea, slurp: '' }), 'no slurp: off, as before');
assert.ok(!canSnap('linux', '', { ...wlArea, session: 'x11' }), 'X11: slurp needs Wayland');
assert.ok(!canSnap('linux', '', { ...wlArea, layer: '' }), 'no layer surfaces (GNOME): slurp can\'t run there');
assert.ok(canSnap('darwin', '', { slurp: '' }) && canSnap('win32', 'x', { slurp: '' }) && !canSnap('win32', '', wlArea), 'macOS and Windows: as before, slurp or not');
// The commands to bind on Wayland: as before, and --snap with them where the area can be picked.
assert.deepEqual(bindCommands('roamies'), { summon: 'roamies --summon', talk: 'roamies --talk', ask: 'roamies --ask', list: 'roamies --list', panel: 'roamies --panel' }, 'as before');
assert.deepEqual(bindCommands("'/a b/Roamies.AppImage'", { snap: true }), { summon: "'/a b/Roamies.AppImage' --summon", talk: "'/a b/Roamies.AppImage' --talk", ask: "'/a b/Roamies.AppImage' --ask", list: "'/a b/Roamies.AppImage' --list", panel: "'/a b/Roamies.AppImage' --panel", snap: "'/a b/Roamies.AppImage' --snap" });

// With the helper there, its tools are offered on any system (Windows has one now).
const tools = new URL('../tools.mjs', import.meta.url).href;
const names = execFileSync(process.execPath, ['--input-type=module', '-e', `
  const { createTools } = await import(${JSON.stringify(tools)});
  const noop = async () => {};
  const { tools } = createTools({ allowActions: () => false, ui: () => {}, ask: noop, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'T' });
  console.log(tools.map((t) => t.name).join(','));`], { env: { ...process.env, ROAMIES_HANDS: 'fake-hands.mjs' }, encoding: 'utf8' }).trim().split(',');
for (const n of ['list_windows', 'read_window', 'act_in_app']) assert.ok(names.includes(n), `${n} is offered with the helper`);
// The microphone: each reason the voice helper gives gets its own advice, not "I can't find a microphone".
assert.match(micTrouble('darwin'), /^I can't find a microphone\. Plug one in and try again\.$/, 'the Mac helper sends no reason');
assert.match(micTrouble('win32', 'missing'), /input picked in Settings > System > Sound > Input/, 'a plugged-in mic that isn\'t the default');
assert.match(micTrouble('linux', 'missing'), /input picked in your sound settings/);
assert.match(micTrouble('win32', 'busy'), /exclusive control/);
assert.ok(!/exclusive control/.test(micTrouble('linux', 'busy')), 'a Windows-only setting');
assert.match(micTrouble('win32', 'blocked'), /Let desktop apps access your microphone/);
assert.match(micTrouble('win32', 'blocked'), /antivirus or work settings/, 'when the switches are already on');
assert.ok(!/Windows/.test(micTrouble('linux', 'blocked')));
assert.match(micTrouble('win32', 'lost'), /Bluetooth/);
assert.match(micTrouble('win32', 'failed', 'unsupported sample format I48'), /\(unsupported sample format I48\)/);
assert.ok(micTrouble('win32', 'failed', 'x'.repeat(500)).length < 300, 'the system\'s words are cut short');
for (const r of ['busy', 'blocked', 'lost', 'failed']) assert.ok(!/can't find a microphone/.test(micTrouble('win32', r)), `${r} isn't reported as a missing mic`);
// ---------- pointing: by a thing's words where the hands helper finds them, by its place where nothing does ----------
{
  const { drawWords, promptWords } = await import('../platform.mjs');
  // With the helper every word is what it was before there was a choice (copied from that text).
  const PLACES = "Places (at, to, tie), best first: {text: the exact words shown on screen} (exact bounds, scrolls to it; target 'screen' searches every app; also words inside paragraphs, text in images or canvases, and a single character, which matches case); add every: true to mark every place that text appears (each letter s, each mention of a word), one mark per place, and within: {x, y, w, h} (screenshot pixels, x, y the centre) to keep to one part of the screen (every s in one sentence); {id} from read_window, for controls without words; {x, y, w, h} pixels in your latest screenshot, for icons, shapes and areas without words: x, y is the thing's centre, and w, h its whole width and height; the box is then fitted to what's really drawn there, so a close guess is enough.";
  const WALK = "Walkthroughs (\"how do I…\"): one beat per step, each a target on that step's control with label and wait 'click'; the next step is found after they click, on the screen as it is then.";
  const NEVER_WAIT = " On this desktop (Wayland) clicks and hovers in other apps can't be seen: never use wait; beats play one after another, so say each step's line in an order that reads well without pausing.";
  assert.deepEqual(drawWords({ hands: true }), { places: PLACES, walkthroughs: WALK, note: '' }, 'with the helper: as it was');
  assert.deepEqual(drawWords({ hands: true, waits: 'pointer' }), drawWords({ hands: true }));
  assert.deepEqual(drawWords({ hands: true, waits: 'none' }), { places: PLACES, walkthroughs: WALK, note: NEVER_WAIT }, 'Wayland with the helper: as it was');
  const PAGES = "Long pages, feeds and lists: to find something on a page, use draw or click_text with the words you're looking for (they search parts scrolled out of view and scroll there), not scroll after scroll. For \"every post\" or \"each item\" tasks: if the page loads more as you scroll, first act_in_app scroll with to_end; then one read_window shows the whole page (on screen and elsewhere); then do every item in one act_in_app call (fill with near and click_text with near for each, near = words from that item). Don't survey a page by scrolling and screenshotting. Never stop at the first screenful.\n";
  const SHOW = "When they ask how to do something in an app (a how-to), walk them through it with draw: one beat per step in one call, each marking the control with a target and wait 'click'.";
  const FAST = "To point at or click something whose exact words you know (the user said them, or you've seen them), use draw or act_in_app click_text with that text right away, with no read_window or screenshot first. Don't guess words: for \"the version number\" or \"the settings icon\" you don't know what's written, so look first. Put several steps in one act_in_app call. Forms: one act_in_app call with a fill step per field (field = its label or placeholder as shown), choose for dropdowns, fill for typed dates; a field that opens a calendar is clicked, then its month arrows and day are clicked with click_text. Check the field values in the result before saying it's done. When act_in_app shows the page after a click, use that instead of reading again. read_window and act_in_app results include the text on screen, so read pages from them; screenshot only when you need to see something words can't tell you (images, layout, colours).";
  const FRESH = "draw or click_text with text, read_window or a screenshot made now";
  for (const waits of ['pointer', 'none']) assert.deepEqual(promptWords({ hands: true, waits, example: 'a how-to' }), { pages: PAGES, show: SHOW, fast: FAST, fresh: FRESH }, `the prompt with the helper (${waits}): as it was`);
  assert.equal(promptWords({ hands: true, example: '"how do I add a layer mask"' }).show, SHOW.replace('a how-to', '"how do I add a layer mask"'), 'the Mac example goes where it went');

  // Without it nothing finds a thing by its words or its id: places are x, y, w, h read from a screenshot, and
  // the agent is told to look first.
  const bare = drawWords({ hands: false });
  assert.equal(bare.places, "Places (at, to, tie): {x, y, w, h} in the pixels of your latest screenshot, where x, y is the thing's centre and w, h its whole width and height. That is the only way to say where something is on this computer: nothing here finds things by their words or reads a window's controls, so text and id don't work. Look first: take a screenshot, then read the place off it carefully, because the mark is drawn exactly where you say.");
  assert.ok(!/best first|\{text|\{id\}|read_window|scrolls to it|fitted to/.test(bare.places), 'no words-first advice, no ids, and no fitting that only the helper does');
  // A walkthrough's next step isn't on the screenshot yet, and pixels from before a click are refused (pointing.mjs
  // shotProblem): one step per call, with a new look between.
  assert.equal(bare.walkthroughs, "Walkthroughs (\"how do I…\"): a screenshot shows only the step that's on screen now, so one step per call: one beat with a target on that step's control, its label and wait 'click'. When the call returns they've done that step and the screen has changed, so take a new screenshot and draw the next step from it.");
  assert.equal(bare.note, '');
  // Wayland, where nothing waits: the steps that are on screen now, one after another, and the note as it was.
  const blind = drawWords({ hands: false, waits: 'none' });
  assert.equal(blind.places, bare.places);
  assert.equal(blind.walkthroughs, "Walkthroughs (\"how do I…\"): one beat per step, each a target on that step's control with its label, for the steps whose controls are on screen now.");
  assert.equal(blind.note, NEVER_WAIT);
  assert.ok(!/wait/.test(blind.walkthroughs), 'nothing about waiting where nothing waits');

  const plain = promptWords({ hands: false, example: 'a how-to' });
  assert.equal(plain.pages, '', 'finding things on long pages by their words is the helper\'s: the line goes');
  assert.equal(plain.show, "When they ask how to do something in an app (a how-to), walk them through it with draw, one step at a time: look at the screen, mark the control for the step that's on screen now with a target and wait 'click', and when that call returns look again for the next step.");
  assert.equal(plain.fast, "To point at something on screen, look first: take a screenshot and give draw the place as x, y, w, h in that picture's pixels. Nothing here finds things by their words, so never give draw text or an id.");
  assert.equal(plain.fresh, 'a screenshot made now');
  assert.equal(promptWords({ hands: false, waits: 'none', example: 'a how-to' }).show, "When they ask how to do something in an app (a how-to), walk them through it with draw: look at the screen, then one beat per step in one call, each marking its control with a target, for the steps whose controls are on screen now.");
  for (const waits of ['pointer', 'none']) {
    const w = promptWords({ hands: false, waits, example: 'a how-to' });
    assert.ok(!/click_text|act_in_app|read_window|right away|with that text/.test(Object.values(w).join(' ')), `no tool it doesn't have and no words-first advice (${waits})`);
  }

  // The wiring, read from the source (sidekick.mjs runs the app when loaded): the prompt takes these words, for
  // this computer's helper.
  const { readFileSync } = await import('node:fs');
  const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(side, /const SHOW = promptWords\(\{ hands: HANDS_OK, waits: WAITS, example: process\.platform === 'darwin' \? '"how do I add a layer mask"' : 'a how-to' \}\);/);
  assert.match(side, /\n\$\{SHOW\.pages\}A cookie or consent banner/, 'the long-pages line, or nothing');
  assert.match(side, /\nShow, don't just tell\. \$\{SHOW\.show\} When they ask what they're looking at/);
  assert.match(side, /\nBe fast: every tool call is a round trip, so use as few as the task needs\. \$\{SHOW\.fast\}\n/);
  assert.match(side, /work from a fresh look \(\$\{SHOW\.fresh\}\), never from what you saw for an earlier request/);
}
// ---------- walkthroughs: how a beat that waits knows the user has done the step ----------
{
  const { drawWords, promptWords, stepWaits } = await import('../platform.mjs');
  const { readFileSync } = await import('node:fs');
  // Their real click or hover where the pointer is seen. On Wayland it isn't, so nothing waits: except on a layer
  // surface, where the overlay gets the clicks on its own click areas and shows a Next button to press.
  assert.ok(['darwin', 'win32'].every((os) => stepWaits(os, '') === 'pointer') && stepWaits('linux', 'x11') === 'pointer');
  assert.equal(stepWaits('linux', 'wayland'), 'none', 'Wayland, as it was');
  assert.equal(stepWaits('linux', 'wayland', ''), 'none', 'Wayland through XWayland (GNOME), as it was');
  assert.equal(stepWaits('linux', 'wayland', '1'), 'chip', 'a layer surface');
  assert.equal(stepWaits('linux', '', '1'), 'chip');
  for (const odd of ['0', 'true', 'yes', ' ', undefined, null, 1]) assert.equal(stepWaits('linux', 'wayland', odd), 'none', `only the app's own "1" (${JSON.stringify(odd)})`);
  assert.ok(stepWaits('linux', 'x11', '1') === 'pointer' && stepWaits('darwin', '', '1') === 'pointer' && stepWaits('win32', '', '1') === 'pointer', 'where the pointer is seen, the real click');
  // The app says which (ROAMIES_LAYER, beside ROAMIES_SESSION), and both readers take it from there.
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.match(read('../../src-tauri/src/sidecar.rs'), /cmd\.env\("ROAMIES_SESSION", crate::linux::session\(\)\.name\(\)\)\.env\("ROAMIES_LAYER", if crate::linux::layer\(\) \{ "1" \} else \{ "" \}\)/, 'the shell tells the sidecar');
  assert.match(read('../tools.mjs'), /const WAITS = stepWaits\(process\.platform, LINUX \? linuxSession\(\) : '', process\.env\.ROAMIES_LAYER \|\| ''\);/);
  const side = read('../sidekick.mjs');
  assert.match(side, /const WAITS = stepWaits\(process\.platform, SESSION, process\.env\.ROAMIES_LAYER \|\| ''\);/);
  assert.match(side, /session: SESSION, next: WAITS === 'chip', desktop:/, 'and the platform line is worded for it');

  // What the agent is told there: the button, not "never use wait"; the rest as where the click is seen.
  const NEXT = " On this desktop (Wayland) clicks and hovers in other apps can't be seen, so a beat with wait shows a Next button on screen instead (Done on the last of several) and goes on when they press it: word each step's line so they do the step and then press Next. wait 'hover' works the same way.";
  for (const hands of [true, false]) {
    assert.deepEqual(drawWords({ hands, waits: 'chip' }), { ...drawWords({ hands, waits: 'pointer' }), note: NEXT }, `the draw tool (helper: ${hands})`);
    assert.deepEqual(promptWords({ hands, waits: 'chip', example: 'a how-to' }), promptWords({ hands, waits: 'pointer', example: 'a how-to' }), `the prompt (helper: ${hands})`);
  }
  const about = { arch: 'x64', session: 'wayland', desktop: 'Hyprland', distro: 'Arch Linux' };
  const plain = platformLine('linux', about), layer = platformLine('linux', { ...about, next: true });
  assert.ok(plain.endsWith(" Wayland keeps apps from seeing the pointer, clicks and keys in other apps: you can't tell where the user's cursor is or what they clicked, so a draw beat never waits for a click or hover (beats play one after another), and nothing follows their cursor."), 'Wayland, as it was');
  assert.ok(layer.endsWith(" Wayland keeps apps from seeing the pointer, clicks and keys in other apps: you can't tell where the user's cursor is or what they clicked, so a draw beat that waits shows a Next button on screen and goes on when they press it, and nothing follows their cursor."), 'a layer surface');
  assert.equal(layer.slice(0, layer.indexOf(' Wayland keeps')), plain.slice(0, plain.indexOf(' Wayland keeps')), 'the rest of the line is the same');
  assert.equal(platformLine('linux', { ...about, session: 'x11', next: true }), platformLine('linux', { ...about, session: 'x11' }), 'X11 has no such limit to word');
}
console.log('platform tests: passed');
