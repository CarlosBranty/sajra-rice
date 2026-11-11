// Ask About an Area on Linux (Wayland): `roamies --snap` (or the tray menu, or the panel) has the app pick the area
// with slurp and cut it out of a screenshot (linux.rs `area`, tested with cargo test), and from there it is the same
// snap as on macOS and Windows. These check the wiring between the pieces, as test/prompt.test.mjs does. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const side = read('../sidekick.mjs');
const fn = (src, head) => src.slice(src.indexOf(head), src.indexOf('\n}', src.indexOf(head)));

// On where slurp can run: the app says where slurp is (ROAMIES_SLURP) and whether the overlay is a layer surface.
assert.match(side, /const SNAP_OK = canSnap\(process\.platform, process\.env\.ROAMIES_HANDS, \{ session: SESSION, layer: process\.env\.ROAMIES_LAYER \|\| '', slurp: process\.env\.ROAMIES_SLURP \|\| '' \}\);/, 'the capability is told the session, layer surfaces and slurp');
assert.match(read('../../src-tauri/src/sidecar.rs'), /\.env\("ROAMIES_SLURP", /, 'the app tells the sidecar where slurp is');
// The command to bind joins the others (the panel's Behavior page and the prompt), only where it works.
assert.match(side, /const BIND = bindCommands\(LAUNCH, \{ snap: SNAP_OK && !HOTKEYS_OK \}\);/);
// `roamies --snap` reaches the snap.
assert.match(read('../../src-tauri/src/main.rs'), /"summon", "list", "talk", "ask", "panel", "snap"/, 'the app knows the flag (Linux)');
assert.match(fn(side, 'async function onCli('), /if \(action === 'snap'\) return areaSnap\(\);/, 'the sidecar starts the snap');
// The snap itself: on Linux the app picks and cuts the area (area → area_done); the rest is the macOS and Windows flow.
const snap = fn(side, 'async function areaSnap(');
assert.match(snap, /const res = LINUX \? await shellCall\(\{ type: 'area', file \}, AREA_WAIT\) : await hands\('select', file\);/);
assert.match(snap, /if \(res\.cancelled\) return;/, 'Esc, a click without a drag or walking away: nothing is asked');
assert.match(snap, /if \(LINUX && !res\.ok\) throw new Error/, 'a failure is said, as the helper\'s are');
assert.match(snap, /enqueue\(q\.trim\(\) \|\| 'What is this\? Explain it simply\.', \{ image: s\.image \}\);/, 'the question goes with the picture, as on Windows');
assert.match(side, /m\.type === 'screenshot_done' \|\| m\.type === 'clipboard_done' \|\| m\.type === 'area_done'\) shellAnswer\(m\)/, 'the answer reaches the waiting snap');
assert.match(read('../../src-tauri/src/main.rs'), /Some\("area"\) => \{[^}]*linux::area\(/, 'the app takes the area request');
// The prompt: on Wayland the snap is a command they bind, not Ctrl+Alt+A, and it is no longer among what needs the app.
assert.match(side, /\$\{BIND\.talk\} \(talk\)\$\{BIND\.snap \? `, \$\{BIND\.snap\} \(ask about an area\)` : ''\} and \$\{BIND\.panel\} \(the panel\)/);
assert.match(side, /\$\{SNAP_OK && HOTKEYS_OK \? `; ask about an area \$\{keyWords\(keys\(\)\.snap\)\}` : ''\}/, 'with shortcuts (macOS, Windows): as before');
assert.match(side, /\$\{HANDS_OK \? '' : ` \$\{SNAP_OK \? 'Reading' : 'Asking about an area, reading'\} app windows, finding things on screen by their words and working other apps need the Roamies app/);
// The tray menu shows the snap's shortcut only where there are shortcuts.
assert.match(side, /\.\.\.\(SNAP_OK \? \[\{ id: 'snap', label: 'Ask About an Area…', \.\.\.\(HOTKEYS_OK \? \{ accel: keys\(\)\.snap \} : \{\}\) \}\] : \[\]\),/);
// The panel lists it with the other commands, and so does the README, which no longer says it's missing.
assert.match(read('../../../panel/panel.js'), /const BIND_ROWS = \[[^\n]*\['snap', 'Ask about an area'\]/);
const readme = read('../../../../README.md');
assert.match(readme, /\| `roamies --snap` +\| /, 'the README\'s commands table');
assert.ok(!/Not yet:[^\n]*Ask About an Area/.test(readme), 'no longer listed as missing');
// The setup guide lists the commands to bind as the panel does, the area one included (it shows only those it is sent).
{
  const guide = readFileSync(fileURLToPath(new URL('../../../onboarding/onboarding.js', import.meta.url)), 'utf8');
  const at = guide.indexOf('renderBind(b) {'), list = guide.slice(at, at + 400);
  assert.match(list, /\['snap', 'Ask about an area'\]/, 'the setup guide lists the area command');
}

console.log('area tests: passed');
