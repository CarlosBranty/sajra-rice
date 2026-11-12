// Other apps' sound, lowered while Roamies listens and while it speaks (Linux; the Voice page's switch and level).
// The lowering itself is the shell's (src-tauri/src/linux.rs, tested there); here: the setting. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DUCK_LEVELS, duckOf, duckLevel } from '../speech.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// The choices, and what a saved setting comes to: off unless it was switched on, at 30 % unless a choice was picked.
assert.deepEqual(DUCK_LEVELS, [10, 20, 30, 50]);
assert.deepEqual(duckOf({}), { on: false, level: 30 }, 'never set: off, 30 %');
assert.deepEqual(duckOf({ duckOthers: true }), { on: true, level: 30 });
for (const l of DUCK_LEVELS) assert.deepEqual(duckOf({ duckOthers: true, duckLevel: l }), { on: true, level: l }, `${l} is a choice`);
// A level that isn't a choice (out of range, hand-edited, another type) is 30.
for (const l of [undefined, null, 0, -30, 5, 25, 30.5, 100, 1000, NaN, Infinity, '30', '50', true, [30], { level: 30 }]) {
  assert.equal(duckOf({ duckOthers: true, duckLevel: l }).level, 30, `${JSON.stringify(l)} is 30`);
}
// Only a real "on" switches it on: other apps' sound is never touched by accident.
for (const on of [undefined, null, false, 0, 1, 'true', 'on', [], {}]) assert.equal(duckOf({ duckOthers: on, duckLevel: 50 }).on, false, `${JSON.stringify(on)} is off`);
for (const c of [undefined, null, 3, 'x', []]) assert.deepEqual(duckOf(c), { on: false, level: 30 }, `no settings (${JSON.stringify(c)})`);
// What the shell is told: the level to lower to, and 0 while it's switched off (the shell then leaves every volume alone).
assert.equal(duckLevel({ duckOthers: true, duckLevel: 20 }), 20);
assert.equal(duckLevel({ duckOthers: true, duckLevel: 99 }), 30);
assert.equal(duckLevel({ duckOthers: false, duckLevel: 20 }), 0);
assert.equal(duckLevel({ duckLevel: 20 }), 0);
assert.equal(duckLevel({}), 0);

// The wiring, read from the source (sidekick.mjs runs the app when loaded, so it can't be called here).
const side = read('../sidekick.mjs');
assert.match(side, /const DEFAULTS = \{[^}]*\bduckOthers: false, duckLevel: 30,/, 'off and 30 % by default, with the other settings');
// The switch and the level arrive like every other setting (a menu id), are saved, and go on to the shell at once.
assert.match(side, /else if \(id === 'duck' && LINUX\) \{ config\.duckOthers = !duckOf\(config\)\.on; saveConfig\(\); voiceConfig\(\); menu\(\); \}/, 'the switch');
assert.match(side, /else if \(id\.startsWith\('ducklevel:'\) && LINUX && DUCK_LEVELS\.includes\(Number\(id\.slice\(10\)\)\)\) \{ config\.duckLevel = Number\(id\.slice\(10\)\); saveConfig\(\); voiceConfig\(\); menu\(\); \}/, 'only a listed level is saved');
// The shell hears about it in voice_config, on Linux only: everywhere else that message is what it always was.
assert.match(side, /const voiceConfig = \(\) => send\(\{ type: 'voice_config', enabled: VOICE_OK && config\.voice && voiceReady\(\), mute: config\.muteWhileTalking !== false, sound: !!config\.sound, \.\.\.\(NEEDS_MODEL \? \{ model: MODEL_DIR \} : \{\}\), \.\.\.\(LINUX \? \{ duck: duckLevel\(config\), wake: wakeFor\(config\) \} : \{\}\) \}\);/, 'voice_config carries the level on Linux (next to the wake phrase, wake.test.mjs)');
assert.match(side, /duck: LINUX \? \{ \.\.\.duckOf\(config\), levels: DUCK_LEVELS \} : null,/, 'the panel is told the switch, the level and the choices, on Linux only');
// "Mute Mac while talking" (macOS) is its own setting and stays as it was.
assert.match(side, /else if \(id === 'mutetalk'\) \{ config\.muteWhileTalking = config\.muteWhileTalking === false; saveConfig\(\); voiceConfig\(\); menu\(\); \}/, 'the macOS mute switch is untouched');
assert.match(side, /mac: MAC, mute: config\.muteWhileTalking !== false, autoListen: !!config\.autoListen,/, 'and so is what the panel is told about it');
const shell = read('../../src-tauri/src/main.rs');
assert.match(shell, /let mute = msg\.get\("mute"\)\.and_then\(Value::as_bool\)\.unwrap_or\(true\);\n\s+to_voice\(app, &json!\(\{ "cmd": "mute", "on": mute \}\)\);/, 'the shell still hands mute to the voice helper');
assert.match(shell, /#\[cfg\(target_os = "linux"\)\]\n\s+linux::duck_level\(msg\.get\("duck"\)\.and_then\(Value::as_u64\)\.filter\(\|l\| \*l < 100\)\.unwrap_or\(0\) as u32\);/, 'the shell reads the level: none, or one that makes no sense, is off');

// The panel's Voice page: the switch, and the level's choices while it's on; only where the sidecar says it works.
const panel = read('../../../panel/panel.js');
const voicePage = panel.slice(panel.indexOf('function voicePage()'), panel.indexOf('const BIND_ROWS'));
assert.match(voicePage, /state\.duck \? group\('Other sounds',/, 'shown only when the sidecar offers it (Linux)');
assert.match(voicePage, /toggle\('Lower other sounds', [^\n]*, state\.duck\.on, \(\) => act\('duck'\), 'duck'\)/, 'the switch');
assert.match(voicePage, /state\.duck\.on \? \[[^\]]*picks\('Lower to', state\.duck\.levels\.map\(\(l\) => \[l, `\$\{l\}%`\]\), state\.duck\.level, \(x\) => act\(`ducklevel:\$\{x\}`\), 'ducklevel'\)/, 'the level picker');
assert.match(voicePage, /v\.mac \? toggle\('Mute Mac while talking', 'Other sounds go quiet while you talk', v\.mute, \(\) => act\('mutetalk'\), 'mutetalk'\) : null/, 'the macOS switch is as it was');
assert.match(voicePage, /picks\('Language', state\.languages, state\.language, \(x\) => act\(`language:\$\{x\}`\), 'language'\)/, 'and so is the Language picker');

// The voice on the Replies tab: Fish Audio or the local voice, offered only where the voice helper is (the sidecar sends
// engines then); Fish's model picker, key row and key form only for Fish, exactly as before; Fish stays the default.
assert.match(voicePage, /state\.engines \? \[\n\s+el\('p', \{ className: 'sub', textContent: 'Voice' \}\),\n\s+picks\('Voice', state\.engines, state\.voiceEngine, \(x\) => act\(`voiceengine:\$\{x\}`\), 'voiceengine',/, 'the choice');
assert.match(voicePage, /!local && state\.replies === 'voice' && state\.fishModels\?\.length \? \[\n\s+el\('p', \{ className: 'sub', textContent: 'Voice model' \}\),\n\s+picks\('Voice model', state\.fishModels\.map\(\(c\) => \[c\.id, c\.name\]\), state\.fishModel, \(x\) => act\(`fishmodel:\$\{x\}`\), 'fishmodel',/, 'the Fish model picker, for Fish only');
assert.match(voicePage, /local \? null : el\('div', \{ className: 'setting' \},\n\s+el\('span', \{\}, 'Fish Audio key',/, 'the key row, for Fish only');
assert.match(voicePage, /local \? null : keyForm\('fish', 'Fish Audio', \(key\) => send\(\{ type: 'panel_fishkey', key \}\)\)\)/, 'the key form, for Fish only');
assert.match(voicePage, /if \(x === 'voice' && !local && !state\.fishKey\) \{ ui\.key = 'fish'; render\('key-fish'\); note\('Add a Fish Audio key to hear me talk\.'\); return; \}/, 'Fish still asks for its key first; the local voice needs none');
assert.match(voicePage, /'A Spanish voice: replies in other languages sound Spanish-accented\. Pick Español below for the best result\.'/, 'the language rule, said where it applies');
assert.match(voicePage, /act\('localdl'\)/, 'a download that failed can be retried');
assert.match(side, /voiceEngine: 'fish', \/\/ 'local'/, 'Fish is the default for everyone');
assert.match(side, /const VOICE_HELPER = process\.platform === 'darwin' \? '' : process\.env\.ROAMIES_VOICE \|\| '';/, 'never on macOS');
assert.match(side, /voiceEngine: engineNow\(\), engines: LOCAL_OK \? ENGINES : null,/, 'the panel is told');
assert.match(side, /else if \(id\.startsWith\('voiceengine:'\) && ENGINES\.some\(\(\[e\]\) => e === id\.slice\(12\)\)\) setEngine\(id\.slice\(12\)\);/, 'and the pick is handled');
assert.match(side, /const ENGINES = \[\['fish', 'Fish Audio'\], \['local', 'Local voice \(Spanish\)'\]\];/);
assert.match(shell, /std::env::remove_var\("ROAMIES_VOICE_ENGINE"\);/, 'the debug override is cleared in release builds');
assert.match(read('../../src-tauri/src/sidecar.rs'), /\.env\("ROAMIES_VOICE", helper_binary\("roamies-voice"\)/, 'the sidecar is told where the voice helper is');

// The overlay says when a take is open and when a reply is playing: on Linux only, when either changes.
const host = read('../../../roamies/host.js');
const talk = host.slice(host.indexOf('const talkSync = '), host.indexOf('// Start hidden in auto mode'));
assert.match(talk, /if \(!LINUX\) return;/, 'nothing is sent anywhere else');
assert.match(talk, /const speaking = !!Roamie\.voiceOut\?\.speaking\(\), key = `\$\{hearing\},\$\{speaking\}`;\n\s+if \(key === toldTalk\) return;/, 'only when it changes');
assert.match(talk, /invoke\('talk_state', \{ hearing, speaking \}\)\.catch\(\(\) => \{ toldTalk = null; \}\);/, 'and again if the shell did not get it');
assert.match(host, /else if \(m\.kind === 'voice'\) \{ onVoice\(m\); talkSync\(\); \}/, 'the take opening is passed on at once (the mic is already on)');
assert.match(host, /const up = \(\) => !!\(getAgent\(\)\?\.visible \|\| ask \|\| Roamie\.panel\?\.isOpen \|\| Roamie\.ink\?\.playing \|\| Roamie\.ink\?\.loose \|\| Roamie\.ink\?\.reminding \|\| hearing \|\| waveTurn \|\| Roamie\.voiceOut\?\.playing\(\)\);/, 'Esc is held as before');
assert.match(shell, /generate_handler!\[[^\]]*\bdock_state, talk_state, sidecar_send,/, 'the command is registered');
console.log('duck tests: passed');
