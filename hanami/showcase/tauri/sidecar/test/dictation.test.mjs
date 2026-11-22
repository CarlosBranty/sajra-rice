// Dictation (Linux; the Voice page's "Type as I speak" switch): off, the take is pasted at once when the key is let
// go; on, its words are typed as they settle. Choosing and typing them is src-tauri/src/voice.rs (tested there);
// here: the setting, and how it travels from the panel to the app. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const side = read('../sidekick.mjs');
const panel = read('../../../panel/panel.js');
const app = read('../../src-tauri/src/main.rs');

// Off by default: pasted at the end, as before the switch.
assert.match(side, /\n  dictationLive: false, \/\/ Linux: /, 'the setting, off by default');
// voice_config carries it on Linux, next to barge-in.
assert.match(side, /barge: config\.bargeIn !== false, dictationLive: config\.dictationLive === true \} : \{\}\) \}\);/, 'voice_config carries it');
// The panel sees it where dictation exists (Linux, with voice control), and the switch flips it.
assert.match(side, /\n    dictation: LINUX && VOICE_OK \? \{ live: config\.dictationLive === true \} : null,/, 'the panel state');
assert.match(side, /else if \(id === 'dictlive' && LINUX\) \{ config\.dictationLive = config\.dictationLive !== true; saveConfig\(\); voiceConfig\(\); menu\(\); \}/, 'the switch');
assert.match(panel, /state\.dictation \? toggle\('Type as I speak', [^\n]*state\.dictation\.live, \(\) => act\('dictlive'\), 'dictlive'\) : null/, 'the Voice page');
// The app keeps it for the next take.
assert.match(app, /voice::set_dictation_live\(voice::dictation_live_of\(&msg\)\);/, 'the app hears it with the rest of voice_config');

console.log('dictation: ok');
