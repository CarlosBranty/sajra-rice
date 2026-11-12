// A yes/no said out loud and answered by voice, and talking over a reply (barge-in, Linux). The listening itself is
// the voice helper's (src-tauri/voice-win, tested there); here: what is said, when the mic opens, the setting, and how
// they are wired. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { echoCancelled, bargeOf, askLanguage, askLine, askAgainLine, relayVoice, createVoiceAsk } from '../speech.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ---- the echo-cancelled microphone ----
for (const aec of ['hanami_aec_source', 'echo-cancel-source', 'alsa_input.usb.echo-cancel', 'my_echo_cancel_mic', 'AEC.mic']) assert.ok(echoCancelled(aec), aec);
for (const plain of ['', null, undefined, 'alsa_input.pci-0000_00_1f.3.analog-stereo', 'bluez_input.headset', 'aecho', 'spaecial']) assert.ok(!echoCancelled(plain), String(plain));
assert.deepEqual(bargeOf({}, 'hanami_aec_source'), { on: true, aec: true }, 'on by default with the echo-cancelled microphone');
assert.deepEqual(bargeOf({ bargeIn: false }, 'hanami_aec_source'), { on: false, aec: true }, 'switched off');
assert.deepEqual(bargeOf({ bargeIn: true }, ''), { on: false, aec: false }, 'never on another microphone, whatever the setting');

// ---- what is said ----
assert.equal(askLanguage('es', 'what time is it'), 'es', 'a picked reply language wins');
assert.equal(askLanguage('en', 'qué hora es'), 'en');
assert.equal(askLanguage('auto', '¿Puedes abrir la terminal y correr los tests?'), 'es', 'Auto: what the request sounded like');
assert.equal(askLanguage('auto', 'open the terminal and run the tests'), 'en');
assert.equal(askLine('Run `ls` in kitty (workspace 2)?', 'es'), 'Run ls in kitty (workspace 2). ¿Lo permito?');
assert.equal(askLine('Open Safari and type hello?', 'en'), 'Open Safari and type hello. Should I allow it?');
assert.equal(askLine('Run `rm -rf ~/projects/old/build` here?', 'en'), 'Run here. Should I allow it?', 'code and paths are not read out');
assert.ok(askLine('x '.repeat(200), 'es').length < 170, 'kept short');
assert.equal(askLine('', 'es'), '¿Lo permito?');
assert.equal(askAgainLine('es'), '¿Sí o no?');
assert.equal(askAgainLine('en'), 'Yes or no?');

// ---- the request's voice: the question is said after what was said so far, and the reply goes on after it ----
{
  const made = [];
  const start = () => { const v = { id: `s${made.length + 1}`, said: [], ended: false, aborted: false, say(s) { this.said.push(s); }, beat() { this.said.push('<beat>'); return true; }, end() { this.ended = true; }, abort() { this.aborted = true; } }; made.push(v); return v; };
  assert.equal(relayVoice(() => null), null, 'no voice: nothing to relay');
  const r = relayVoice(start);
  r.say('Voy a correr eso.');
  assert.equal(r.interject('Run ls. ¿Lo permito?'), 's1', 'said on the reply\'s own voice, which then ends');
  assert.deepEqual(made[0].said, ['Voy a correr eso.', 'Run ls. ¿Lo permito?']);
  assert.ok(made[0].ended && made.length === 1);
  r.say('Listo.');
  assert.equal(made.length, 2, 'the rest of the reply on a fresh voice');
  assert.deepEqual(made[1].said, ['Listo.']);
  assert.equal(r.id, 's2', 'the id auto-listen waits for');
  r.end();
  assert.ok(made[1].ended);
  r.say('late');
  assert.equal(made.length, 2, 'nothing after the end');
  // Asked again and never answered before the request ends: nothing more is started.
  const q = relayVoice(start);
  q.interject('¿Sí o no?');
  q.end();
  q.abort();
  assert.equal(made.length, 3);
}

// ---- the spoken yes/no ----
{
  const log = [];
  let nextSpeech = 's1';
  const va = createVoiceAsk({
    speak: (text) => { log.push(['speak', text]); return nextSpeech; },
    show: (id, speech) => log.push(['show', id, speech]),
    listen: () => log.push(['listen']),
    cancel: () => log.push(['cancel']),
  });
  va.open('a1', 'Run `ls` in kitty?', 'es');
  assert.deepEqual(log, [['speak', 'Run ls in kitty. ¿Lo permito?'], ['show', 'a1', 's1']], 'said once, and the overlay waits for it to be heard');
  assert.equal(va.ready('a2'), false, 'another question: nothing');
  assert.ok(va.ready('a1'));
  assert.deepEqual(log.at(-1), ['listen'], 'the mic opens once it has been said');
  assert.equal(va.ready('a1'), false, 'and only once');
  va.heard();
  // Unclear: asked once more, then the buttons.
  nextSpeech = 's2';
  assert.ok(va.unclear('a1'));
  assert.deepEqual(log.slice(-2), [['speak', '¿Sí o no?'], ['show', 'a1', 's2']]);
  assert.equal(va.unclear('a1'), false, 'not while it is being said');
  assert.ok(va.ready('a1'));
  assert.equal(log.filter(([k]) => k === 'listen').length, 2);
  const before = log.length;
  assert.equal(va.unclear('a1'), false, 'unclear twice: the buttons are left');
  assert.equal(log.length, before, 'nothing more said or opened');
  assert.equal(va.current, null);
  // A click while it listens: the take it opened is dropped.
  va.open('a3', 'Open Safari?', 'en');
  va.ready('a3');
  va.done('a3');
  assert.deepEqual(log.at(-1), ['cancel']);
  assert.equal(va.ready('a3'), false, 'gone');
  // A click before the mic opened: nothing to drop, and it never opens.
  va.open('a4', 'Open Safari?', 'en');
  va.done('a4');
  assert.notDeepEqual(log.at(-1), ['cancel']);
  assert.equal(va.ready('a4'), false);
  // Answered by voice: the take is over already.
  va.open('a5', 'Open Safari?', 'en');
  va.ready('a5');
  va.done('a5', { byVoice: true });
  assert.notDeepEqual(log.at(-1), ['cancel']);
  // Nothing heard (no answer at all) counts as unclear.
  va.open('a6', 'Open Safari?', 'en');
  va.ready('a6');
  va.heard();
  assert.ok(va.unclear(), 'the current question');
}

// ---- wiring ----
const side = read('../sidekick.mjs');
const askFn = side.slice(side.indexOf('function ask(opts, signal)'), side.indexOf('// ---------- logins'));
assert.match(askFn, /if \(opts\.choices\?\.length === 2 && voiceAskOn\(\)\) voiceAsk\.open\(id, /, 'only a yes/no, only when asked');
assert.match(askFn, /signal\?\.addEventListener\('abort', \(\) => \{ pending\.delete\(id\); choiceAsks\.delete\(id\); voiceAsk\.done\(id\);/, 'a stopped request drops it');
assert.match(side, /const voiceAskOn = \(\) => VOICE_OK && !!config\.voice && voiceReady\(\) && !intro && !onboarding && \(VOICE_ON\(\) \|\| turnByVoice\);/, 'with the mic, outside the setup guide, when replies are spoken or the request was');
assert.match(side, /else if \(m\.type === 'answer'\) \{ pending\.get\(m\.id\)\?\.\(m\.text \?\? null\); pending\.delete\(m\.id\); choiceAsks\.delete\(m\.id\); voiceAsk\.done\(m\.id\); \}/, 'a click or a typed answer cancels the listening');
assert.match(side, /if \(!pick\) \{ voiceAsk\.unclear\(id\); return; \}/, 'an unclear answer is asked again');
assert.match(side, /else if \(m\.type === 'ask_listen'\) \{ if \(choiceAsks\.has\(String\(m\.id\)\)\) voiceAsk\.ready\(String\(m\.id\)\); \}/);
assert.match(side, /if \(m\.code === 'nothing_heard' && voiceAsk\.current\) \{ voiceAsk\.unclear\(\); return; \}/);
assert.match(side, /const voice = VOICE_ON\(\) \? relayVoice\(\(\) => speech\.start\(\)\) : \(speech\.stop\(\), null\);/);
// The password and fingerprint prompt is never answered by voice, nor said out loud: it isn't an ask.
const safety = read('../safety.mjs');
assert.ok(!/voiceAsk|ask_listen/.test(safety), 'authorize knows nothing of it');
assert.ok(!/voiceAsk/.test(side.slice(side.indexOf("m.type === 'auth_open'"), side.indexOf("m.type === 'auth_open'") + 200)));
const host = read('../../../roamies/host.js');
assert.match(host, /else if \(m\.kind === 'ask_listen'\) waitThenAnswer\(m\);/);
const wait = host.slice(host.indexOf('function waitThenAnswer'), host.indexOf('async function playTools'));
assert.match(wait, /if \(Date\.now\(\) - t0 > 30_000 \|\| ask\?\.id !== m\.id \|\| !ask\.choices\) return drop\(\);/, 'only while that yes/no is open (never the password card: it has no choices)');
assert.match(wait, /Roamie\.voiceOut\.finished\(m\.speech \?\? null\)/, 'once the voice has said it');
assert.match(wait, /send\(\{ type: 'ask_listen', id: m\.id \}\);/);
// Barge-in: the setting, the panel, the shell.
assert.match(side, /barge: LINUX && VOICE_OK \? bargeOf\(config, deviceName\(config\.micDevice\)\) : null,/, 'the panel is told (state.barge)');
assert.match(side, /micGain: micGain\(config\), barge: config\.bargeIn !== false \}/, 'voice_config carries the wish; the shell checks the microphone');
assert.match(side, /else if \(id === 'bargein' && LINUX\) \{ if \(bargeOf\(config, deviceName\(config\.micDevice\)\)\.aec\) \{ config\.bargeIn = config\.bargeIn === false; saveConfig\(\); voiceConfig\(\); menu\(\); \} \}/, 'switchable only with the echo-cancelled microphone');
assert.match(side, /if \(m\.type === 'voice_state' && m\.state === 'listening'\) \{ if \(!choiceAsks\.size\) interruptQuietly\(\); speech\.stop\(\); warmUp\(\); \}/, 'a barge stops the reply as the talk keys do: its take starts listening');
const panel = read('../../../panel/panel.js');
assert.match(panel, /state\.barge \? bargeToggle\(state\.barge, v\.on\) : null/);
assert.match(panel, /toggle\('Interrupt me by talking', [^\n]*'Needs the echo-cancelled microphone \(Devices\)'[^\n]*'bargein'\)/);
assert.match(panel, /if \(!b\.aec\) \{ const sw = row\.querySelector\('button'\); sw\.disabled = true;/, 'disabled without it');
const shell = read('../../src-tauri/src/main.rs');
assert.match(shell, /voice::set_mic\(app, voice::device_of\(&msg, "mic"\)\);\n[^\n]*\n\s+voice::set_barge\(app, voice::barge_of\(&msg\)\);/, 'after the microphone, which it depends on');
const voiceRs = read('../../src-tauri/src/voice.rs');
assert.match(voiceRs, /changed && \(wake\.0\.is_some\(\) \|\| barge_on\(\)\)/, 'the helper hears when a reply plays with barge-in on');
assert.match(voiceRs, /Some\("barge"\) => to_sidecar\(app, &json!\(\{ "type": "voice_barge" \}\)\),/);

console.log('voiceask: ok');
