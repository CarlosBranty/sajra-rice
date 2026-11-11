// The page that plays the voice (showcase/roamies/voice-out.js): when a reply counts as playing. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clock = { t: 0 };
let ac = null;
const noop = () => {};
class AudioContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; ac = this; }
  resume() {}
  createGain() { return { gain: { value: 1, cancelScheduledValues: noop, setValueAtTime: noop, linearRampToValueAtTime: noop }, connect: noop }; }
  createAnalyser() { return { fftSize: 0, connect: noop, getFloatTimeDomainData: noop }; }
  createBuffer(_c, n, rate) { const d = new Float32Array(n); return { duration: n / rate, getChannelData: () => d }; }
  createBufferSource() { return { connect: noop, start: noop, stop: noop }; }
}
const window = { Roamie: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../../roamies/voice-out.js', import.meta.url), 'utf8'), { window, AudioContext, atob, Float32Array, Math, Set, performance: { now: () => clock.t } });
const V = window.Roamie.voiceOut;
const second = Buffer.alloc(44100 * 2).toString('base64'); // one second of 16-bit mono
const at = (audio, wall) => { ac.currentTime = audio; clock.t = wall; };

// A reply plays from its first chunk until its sound has run out.
V.handle({ id: 'a', pcm: second, rate: 44100 });
assert.equal(V.playing(), true);
at(0.6, 600);
assert.equal(V.playing(), true, 'half way through');
V.handle({ id: 'a', end: true, chars: 10 });
assert.equal(V.finished('a'), false, 'its end arrived, but it is still sounding');
at(1.3, 1300);
assert.equal(V.playing(), false, 'past its last sample');
assert.equal(V.finished('a'), true);

// Regression: on a system with no audio output the context's clock never moves, so a reply counted as playing for
// ever: other apps stayed turned down and the wake word stayed deaf until the reply was stopped by hand.
V.handle({ id: 'b', pcm: second, rate: 44100 });
at(1.3, 1400);
assert.equal(V.playing(), true, 'just handed over: give the clock a moment');
at(1.3, 2600);
assert.equal(V.playing(), true, 'a short hiccup is not the end');
at(1.3, 3800);
assert.equal(V.playing(), false, 'the clock has stood still for over two seconds: nothing is sounding');
V.handle({ id: 'b', end: true, chars: 10 });
assert.equal(V.finished('b'), true);

// A clock that moves again counts again, and stopping ends it at once, as before.
V.handle({ id: 'c', pcm: second, rate: 44100 });
at(1.5, 4000);
assert.equal(V.playing(), true);
V.stop();
assert.equal(V.playing(), false);
assert.equal(V.finished('c'), true);

// ROAMIES_LATENCY: a traced reply's first chunk says when it starts sounding (wall clock ms), once; others say nothing.
const started = [];
V.started = (id, t) => started.push([id, t]);
at(2, 5000);
V.handle({ id: 'd', pcm: second, rate: 44100 });
V.handle({ id: 'e', pcm: second, rate: 44100, trace: true });
const t0 = Date.now();
V.handle({ id: 'e', pcm: second, rate: 44100, trace: true });
assert.equal(started.length, 1, 'only the first chunk of a traced reply');
assert.equal(started[0][0], 'e');
assert.ok(Math.abs(started[0][1] - (t0 + 120)) < 50, `when its first buffer starts, after the lead: ${started[0][1] - t0}`);
V.stop();

console.log('voice out tests: passed');
