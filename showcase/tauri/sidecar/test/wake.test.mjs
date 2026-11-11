// The wake word (Linux; the Voice page's switch and phrase): saying the phrase starts listening, as `roamies --talk`
// does. The listening itself is the voice helper's (src-tauri/voice-win, tested there); here: the setting, and how
// it travels from the panel to the helper. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WAKE_MIN, WAKE_MAX, wakePhrase, wakeOf, wakeFor } from '../speech.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// A phrase is what was typed, tidied: 2 to 40 letters (of any alphabet), digits and spaces.
assert.deepEqual([WAKE_MIN, WAKE_MAX], [2, 40]);
assert.equal(wakePhrase('jarvis'), 'jarvis');
assert.equal(wakePhrase('  Hey   Jarvis \n'), 'Hey Jarvis', 'trimmed, one space between words');
assert.equal(wakePhrase('oye señorita'), 'oye señorita', 'accents');
assert.equal(wakePhrase('señor'), 'señor', 'an accent typed as its own mark is the same letter');
assert.equal(wakePhrase('ジャービス'), 'ジャービス', 'any alphabet');
assert.equal(wakePhrase('привет друг'), 'привет друг');
assert.equal(wakePhrase('agent 47'), 'agent 47', 'digits');
assert.equal(wakePhrase('ok'), 'ok', 'two is enough');
assert.equal(wakePhrase('x'.repeat(40)), 'x'.repeat(40), 'forty is the most');
// Anything else isn't a phrase: too short or long, punctuation and symbols, or not text at all.
for (const bad of ['', ' ', '   ', 'a', ' a ', 'x'.repeat(41), 'jarvis!', 'hey, jarvis', "what's up", 'rm -rf /', '"jarvis"', 'a_b', 'hey\u0000you', '😀😀', 42, true, null, undefined, ['jarvis'], { phrase: 'jarvis' }]) {
  assert.equal(wakePhrase(bad), '', `${JSON.stringify(bad)} is not a phrase`);
}

// The saved settings as what's used: on only when it was switched on and there is a phrase to listen for.
assert.deepEqual(wakeOf({}), { on: false, phrase: '' }, 'never set: off');
assert.deepEqual(wakeOf({ wakeWord: true, wakePhrase: ' Hey  Jarvis ' }), { on: true, phrase: 'Hey Jarvis' });
assert.deepEqual(wakeOf({ wakeWord: false, wakePhrase: 'jarvis' }), { on: false, phrase: 'jarvis' }, 'the phrase is kept while it is off');
assert.deepEqual(wakeOf({ wakeWord: true }), { on: false, phrase: '' }, 'no phrase: off');
assert.deepEqual(wakeOf({ wakeWord: true, wakePhrase: 'jarvis!' }), { on: false, phrase: '' }, 'a phrase that is not one: off');
// Only a real "on" switches it on: the microphone never stays open by accident.
for (const on of [undefined, null, 0, 1, 'true', 'on', [], {}]) assert.equal(wakeOf({ wakeWord: on, wakePhrase: 'jarvis' }).on, false, `${JSON.stringify(on)} is off`);
for (const c of [undefined, null, 3, 'x', []]) assert.deepEqual(wakeOf(c), { on: false, phrase: '' }, `no settings (${JSON.stringify(c)})`);
// What the shell is told: the phrase to listen for, or nothing while it's off (the helper is then never asked).
assert.equal(wakeFor({ wakeWord: true, wakePhrase: 'Hey Jarvis' }), 'Hey Jarvis');
assert.equal(wakeFor({ wakeWord: false, wakePhrase: 'Hey Jarvis' }), '');
assert.equal(wakeFor({ wakeWord: true, wakePhrase: 'x' }), '');
assert.equal(wakeFor({}), '');

// The wiring, read from the source (sidekick.mjs runs the app when loaded, so it can't be called here).
const side = read('../sidekick.mjs');
assert.match(side, /const DEFAULTS = \{[^}]*\bwakeWord: false, wakePhrase: '',/, 'off and no phrase by default, with the other settings');
// The switch arrives like every other setting (a menu id); the phrase is typed, so it comes as its own message.
assert.match(side, /else if \(id === 'wake' && LINUX\) \{ config\.wakeWord = !wakeOf\(config\)\.on; saveConfig\(\); voiceConfig\(\); menu\(\); \}/, 'the switch');
assert.match(side, /else if \(m\.type === 'panel_wake' && LINUX\) setWakePhrase\(m\.phrase\);/, 'the typed phrase');
const setter = side.slice(side.indexOf('function setWakePhrase('), side.indexOf('// Progress goes to the setup guide'));
assert.match(setter, /const phrase = wakePhrase\(given\);\n\s+if \(!phrase\) return panelNote\(/, 'a phrase that is not one is refused, and the panel says why');
assert.match(setter, /if \(!wakeOf\(config\)\.phrase\) config\.wakeWord = true;/, 'the first phrase switches it on (that is why it was typed)');
assert.match(setter, /config\.wakePhrase = phrase; saveConfig\(\); voiceConfig\(\); menu\(\);/, 'saved, and on to the shell at once');
// The shell hears about it in voice_config, on Linux only: everywhere else that message is what it always was.
assert.match(side, /const voiceConfig = \(\) => send\(\{ type: 'voice_config', enabled: VOICE_OK && config\.voice && voiceReady\(\), mute: config\.muteWhileTalking !== false, sound: !!config\.sound, \.\.\.\(NEEDS_MODEL \? \{ model: MODEL_DIR \} : \{\}\), \.\.\.\(LINUX \? \{ duck: duckLevel\(config\), wake: wakeFor\(config\) \} : \{\}\) \}\);/, 'voice_config carries the phrase on Linux');
assert.match(side, /wake: LINUX && VOICE_OK \? wakeOf\(config\) : null,/, 'the panel is told the switch and the phrase, on Linux only');

// The shell: the phrase goes on to the voice helper when it changes and to every helper that starts; never when off.
const shell = read('../../src-tauri/src/main.rs');
assert.match(shell, /#\[cfg\(target_os = "linux"\)\]\n\s+voice::set_wake\(app, voice::wake_of\(&msg\)\);\n\s+if msg\.get\("enabled"\)/, 'the shell reads the phrase before the helper is started or stopped');
assert.match(shell, /Some\("talk_toggle"\) => to_voice\(app, &json!\(\{ "cmd": "toggle" \}\)\),/, 'the talk command is what it was');
const voice = read('../../src-tauri/src/voice.rs');
const start = voice.slice(voice.indexOf('pub(crate) fn start_voice('), voice.indexOf('pub(crate) fn stop_voice('));
assert.match(start, /\*state\.0\.lock\(\)\.unwrap\(\) = Some\(child\);\n\s+\/\/[^\n]*\n\s+#\[cfg\(target_os = "linux"\)\]\n\s+\{\n\s+let cmds = wake_cmds\(&WAKE\.lock\(\)\.unwrap\(\), true\);\n\s+for cmd in cmds \{\n\s+to_voice\(app, &cmd\);/, 'a helper that starts (the first, or one restarted after it died) is told the phrase');
// A helper that dies on its own mid-take can't say listening ended: the overlays are told for it.
assert.match(start, /if ours \{\n\s+let app2 = app\.clone\(\);\n\s+let _ = app\.run_on_main_thread\(move \|\| to_overlays\(&app2, &voice_idle\(\)\)\);\n\s+\}/, 'idle goes to the overlays when the helper exits by itself');
assert.match(voice, /pub\(crate\) fn stop_voice\(app: &AppHandle\) \{[^}]*\}\n\s+to_overlays\(app, &voice_idle\(\)\);\n\}/, 'and when it is stopped, as before');
// While a reply plays, the helper is told, so Roamies' own voice saying the phrase starts nothing.
const linux = read('../../src-tauri/src/linux.rs');
const talk = linux.slice(linux.indexOf('pub(crate) fn talk_state('), linux.indexOf('#[cfg(test)]'));
assert.match(talk, /duck_send\(DuckEvent::Busy\(hearing \|\| speaking\)\);/, 'other sounds are lowered as before');
assert.match(talk, /crate::voice::speaking\(app, speaking\);/, 'the helper hears when a reply starts and stops playing');

// The panel's Voice page: the switch and the phrase; only where the sidecar says it works.
const panel = read('../../../panel/panel.js');
const voicePage = panel.slice(panel.indexOf('function voicePage()'), panel.indexOf('const BIND_ROWS'));
assert.match(voicePage, /state\.wake \? group\('Wake word',/, 'shown only when the sidecar offers it (Linux)');
assert.match(voicePage, /toggle\('Wake word', [^\n]*, state\.wake\.on, \(\) => \{\n\s+if \(!state\.wake\.phrase\) \{ ui\.key = 'wake'; render\('key-wake'\); note\('Type the phrase to call me with\.'\); return; \}\n\s+act\('wake'\);\n\s+\}, 'wake'\)/, 'the switch; with no phrase yet it asks for one first');
assert.match(voicePage, /phraseForm\('wake', state\.wake\.phrase, \(phrase\) => send\(\{ type: 'panel_wake', phrase \}\)\)/, 'the phrase is typed in place and sent');
assert.match(panel, /function phraseForm\(id, value, onsave\) \{[\s\S]*?el\('input', \{ type: 'text', id: `key-\$\{id\}`,[^\n]*maxLength: 40 \}\);/, 'a plain text field, forty characters at most');
assert.match(voicePage, /state\.duck \? group\('Other sounds',/, 'Lower other sounds is where it was');
assert.match(voicePage, /toggle\('Voice control', /, 'and so is Voice control');
console.log('wake tests: passed');
