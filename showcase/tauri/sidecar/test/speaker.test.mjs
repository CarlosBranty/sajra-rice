import assert from 'node:assert/strict';
import { createSpeaker, BEATS, BEATS_ES, bundledBeats } from '../speaker.mjs';
import { FISH_MODELS } from '../fish.mjs';
import { readFileSync } from 'node:fs';

// A FishVoice stand-in the test drives by hand.
const made = [];
class FakeVoice {
  constructor(o) { Object.assign(this, o); this.said = []; this.ended = false; this.aborted = false; made.push(this); }
  open() { return this; }
  say(s) { this.said.push(s); }
  end() { this.ended = true; }
  abort() { this.aborted = true; }
}
const setup = (acct = { ok: true, credit: 4.5 }, beatPhrases = [], bundled = () => null, spanish = []) => {
  made.length = 0;
  const out = [], problems = [];
  const sp = createSpeaker({ emit: (m) => out.push(m), onProblem: (p) => problems.push(p), FishVoiceImpl: FakeVoice, account: async () => acct, beatPhrases, spanishBeats: spanish, bundled });
  return { sp, out, problems };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

{ // No key: no voice.
  const { sp } = setup();
  assert.equal(sp.start(), null);
}
{ // Credit → Drama 3; audio goes out as base64 with the reply's id; end marks the end.
  const { sp, out } = setup();
  sp.setKey('k'); await tick();
  assert.equal(sp.model, 'drama-3');
  const r = sp.start();
  assert.deepEqual(out.at(-1), { kind: 'speech', stop: true }, 'a new reply stops whatever was playing');
  r.say('Hi.'); r.end();
  const v = made[0];
  assert.equal(v.model, 'drama-3'); assert.deepEqual(v.said, ['Hi.']); assert.ok(v.ended);
  v.onAudio(new Uint8Array([1, 0, 2, 0]));
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 44100, pcm: Buffer.from([1, 0, 2, 0]).toString('base64') });
  v.onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 3 }, 'a whole reply says how much it said');
}
{ // No credit → the free model.
  const { sp } = setup({ ok: true, credit: 0 });
  sp.setKey('k'); await tick();
  assert.equal(sp.model, 's2.1-pro-free');
}
{ // Fails before any audio → retried once on the free model with everything said so far, and ended again.
  const { sp, out, problems } = setup({ ok: true, credit: 0 });
  sp.setKey('k');
  const r = sp.start(); // started before the account check finished: still on production
  r.say('One.'); r.say('Two.'); r.end();
  await made[0].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false }));
  assert.equal(made.length, 2); assert.equal(made[1].model, 's2.1-pro-free');
  assert.deepEqual(made[1].said, ['One.', 'Two.']); assert.ok(made[1].ended);
  made[1].onAudio(new Uint8Array([0, 0])); made[1].onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 9 }); assert.deepEqual(problems, []);
}
{ // A bad key: no retry, one problem report, the reply ends (text stays).
  const { sp, out, problems } = setup({ ok: false, reason: 'key' });
  sp.setKey('bad');
  const r = sp.start(); r.say('Hi.');
  await made[0].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false }));
  assert.equal(made.length, 1); assert.deepEqual(problems, ['key']);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true });
}
{ // Fails after audio started: no retry (it would repeat itself), no problem shown, just ends.
  const { sp, problems, out } = setup();
  sp.setKey('k');
  const r = sp.start(); r.say('Hi.');
  made[0].onAudio(new Uint8Array([0, 0]));
  await made[0].onError(Object.assign(new Error('dropped'), { heard: true }));
  assert.equal(made.length, 1); assert.deepEqual(problems, []);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true });
}
{ // A new reply aborts the old one; the old one's late audio and end are ignored.
  const { sp, out } = setup();
  sp.setKey('k');
  const a = sp.start(); a.say('Old.');
  const b = sp.start();
  assert.ok(made[0].aborted);
  const n = out.length;
  made[0].onAudio(new Uint8Array([0, 0])); made[0].onEnd();
  assert.equal(out.length, n, 'nothing from the stopped reply');
  b.say('New.'); assert.deepEqual(made[1].said, ['New.']);
}
{ // stop() (Stop, barge-in): aborts and tells the overlay to go quiet.
  const { sp, out } = setup();
  sp.setKey('k');
  sp.start().say('Hi.');
  sp.stop();
  assert.ok(made[0].aborted); assert.deepEqual(out.at(-1), { kind: 'speech', stop: true });
}
{ // Beats are made once in the voice; a slow tool with nothing said plays one instantly, only once per reply.
  const { sp, out } = setup(undefined, BEATS);
  sp.setKey('k'); await tick();
  for (let i = 0; i < BEATS.length; i++) { const w = made.at(-1); assert.deepEqual(w.said, [BEATS[i]]); w.onAudio(new Uint8Array([i, 0])); w.onEnd(); await tick(); await tick(); }
  assert.equal(sp.ready, BEATS.length);
  const r = sp.start(), n = made.length;
  assert.equal(r.beat(), true);
  const played = out.at(-1);
  assert.deepEqual({ ...played, pcm: undefined }, { kind: 'speech', id: r.id, rate: 44100, pcm: undefined });
  assert.ok(BEATS.some((_, i) => played.pcm === Buffer.from([i, 0]).toString('base64')), 'one of the made beats');
  assert.equal(made.length, n, 'no extra socket for the beat');
  assert.deepEqual(made.at(-1).said, [], 'the beat came from the cache, not the live socket');
  assert.equal(r.beat(), false, 'once per reply');
  const r2 = sp.start(); r2.say('Already talking.');
  assert.equal(r2.beat(), false, 'not when it already said something');
}
{ // No beats made yet (or making them failed): the beat is spoken live instead.
  const { sp } = setup(undefined, BEATS);
  sp.setKey('k');
  const r = sp.start(); const live = made.at(-1);
  assert.equal(r.beat(), true);
  assert.ok(BEATS.includes(live.said[0]));
}
{ // Drama 3 fails before any audio with credit left → S2.1 Pro, and the one that worked is kept for the next reply.
  const { sp, problems } = setup();
  sp.setKey('k'); await tick();
  const r = sp.start(); r.say('Hi.'); r.end();
  const v = made.slice(made.length - 1); // this reply's sockets (an earlier test's beat warm-up can add to made)
  await v[0].onError(Object.assign(new Error('Fish Audio closed the connection'), { heard: false }));
  v.push(made.at(-1));
  assert.equal(v[0].model, 'drama-3'); assert.equal(v[1].model, 's2.1-pro'); assert.deepEqual(v[1].said, ['Hi.']);
  v[1].onAudio(new Uint8Array([0, 0])); v[1].onEnd();
  assert.equal(sp.model, 's2.1-pro'); assert.deepEqual(problems, []);
  sp.start(); assert.equal(made.at(-1).model, 's2.1-pro');
}
{ // Every model fails before audio → tried once on each, then one problem report.
  const { sp, problems } = setup();
  sp.setKey('k'); await tick();
  sp.start().say('Hi.');
  const v = [made.at(-1)];
  for (let i = 0; i < 3; i++) { await v[i].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false })); if (i < 2) v.push(made.at(-1)); }
  assert.deepEqual(v.map((x) => x.model), ['drama-3', 's2.1-pro', 's2.1-pro-free']);
  assert.equal(made.at(-1), v[2], 'no fourth try');
  assert.deepEqual(problems, ['Could not reach Fish Audio']);
}
{ // Picking S2.1 Pro: replies use it, and a failure falls back to the free tier, never up to the pricier Drama 3.
  const { sp, problems } = setup();
  sp.setModel('s2.1-pro');
  sp.setKey('k'); await tick();
  assert.equal(sp.pick, 's2.1-pro');
  sp.start().say('Hi.');
  const v = [made.at(-1)];
  assert.equal(v[0].model, 's2.1-pro');
  for (let i = 0; i < 2; i++) { await v[i].onError(Object.assign(new Error('Could not reach Fish Audio'), { heard: false })); if (i < 1) v.push(made.at(-1)); }
  assert.deepEqual(v.map((x) => x.model), ['s2.1-pro', 's2.1-pro-free']);
  assert.equal(made.at(-1), v[1], 'no third try, and never Drama 3');
  assert.deepEqual(problems, ['Could not reach Fish Audio']);
}
{ // Switching the pick: the next reply uses it; no credit keeps it on the free tier; only real choices count.
  const { sp } = setup({ ok: true, credit: 0 });
  sp.setKey('k'); await tick();
  sp.setModel('s2.1-pro');
  assert.equal(sp.pick, 's2.1-pro');
  assert.equal(sp.model, 's2.1-pro-free', 'no credit stays free');
  sp.setModel('s2.1-pro-free'); sp.setModel('nope');
  assert.equal(sp.pick, 's2.1-pro', 'the free tier and unknown names are not picks');
  const { sp: sp2 } = setup();
  sp2.setKey('k'); await tick();
  sp2.setModel('s2.1-pro');
  sp2.start(); assert.equal(made.at(-1).model, 's2.1-pro');
  sp2.setModel('drama-3');
  sp2.start(); assert.equal(made.at(-1).model, 'drama-3');
}
console.log('speaker tests: passed');
{ // Voice cues aren't counted as spoken text.
  const { sp, out } = setup();
  sp.setKey('k');
  const r = sp.start(); r.say('[warm] Hello there.'); r.end();
  made.at(-1).onAudio(new Uint8Array([0, 0])); made.at(-1).onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 12 });
  console.log('speech pacing tests: passed');
}

{ // At least 30 short beats, one or two words each, picked at random with no repeat among the last few.
  assert.ok(BEATS.length >= 30, 'plenty of beats');
  assert.equal(new Set(BEATS).size, BEATS.length, 'no duplicates');
  for (const b of BEATS) assert.ok(b.replace(/[.,!]/g, '').trim().split(/\s+/).length <= 2, `${b} is one or two words`);
  const { sp, out } = setup(undefined, BEATS);
  sp.setKey('k'); await tick();
  for (let i = 0; i < BEATS.length; i++) { const w = made.at(-1); w.onAudio(new Uint8Array([i, 1])); w.onEnd(); await tick(); await tick(); }
  const seen = [];
  for (let i = 0; i < 40; i++) { const r = sp.start(); r.beat(); seen.push(out.at(-1).pcm); r.abort(); }
  for (let i = 0; i < seen.length; i++) assert.ok(!seen.slice(Math.max(0, i - 8), i).includes(seen[i]), 'no repeat within 8');
  assert.ok(new Set(seen).size > 12, 'they vary');
}
console.log('speaker beat variety: passed');

{ // Beats shipped with the app play at their own rate, and none are made over Fish for them.
  const clip = { rate: 24000, pcm: Buffer.from([7, 7]).toString('base64') };
  const { sp, out } = setup(undefined, BEATS, () => new Map(BEATS.map((b) => [b, clip])));
  sp.setKey('k'); await tick(); await tick();
  assert.equal(made.filter((v) => v.said.length).length, 0, 'no beat is recorded at run time');
  const r = sp.start();
  assert.equal(r.beat(), true);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 24000, pcm: clip.pcm });
}
{ // Every look's voice has every beat recorded, in both paid models (re-run beats/make.mjs after changing BEATS).
  const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const { DEFAULT_VOICE } = await import('../fish.mjs');
  const voices = [DEFAULT_VOICE, ...[...side.matchAll(/\['\w+', '[^']+', '([0-9a-f]{32})'\]/g)].map((m) => m[1])];
  const get = bundledBeats();
  for (const v of voices) for (const m of FISH_MODELS) {
    const set = get(v, m);
    assert.ok(set, `beats for ${v} on ${m}`);
    for (const b of BEATS) assert.ok(set.get(b)?.pcm.length > 1000, `"${b}" in ${v} on ${m}`);
  }
}
console.log('bundled beats: passed');

// The shipped beats are English recordings. With Spanish picked a slow tool gets a short Spanish line instead
// ("Vale, déjame ver."), made over Fish in the voice in use, never an English one; Auto and English play the English ones.
const clip = { rate: 24000, pcm: Buffer.from([9, 9]).toString('base64') };
const shippedAll = () => new Map(BEATS.map((b) => [b, clip]));
const made1 = (phrase) => made.filter((v) => v.said.length === 1 && v.said[0] === phrase);
{ // Español: the Spanish lines are made over Fish (one at a time), and a slow tool gets one of them.
  const { sp, out } = setup(undefined, BEATS, shippedAll, BEATS_ES);
  sp.setLanguage('es');
  sp.setKey('k'); await tick(); await tick();
  for (const phrase of BEATS_ES) {
    const v = made.at(-1);
    assert.deepEqual(v.said, [phrase], `"${phrase}" is made`);
    v.onAudio(new Uint8Array([7, 0])); v.onEnd(); await tick(); await tick();
  }
  assert.ok(made.every((v) => !BEATS.includes(v.said[0])), 'no English beat is made in Spanish');
  const r = sp.start(), n = out.length;
  assert.equal(r.beat(), true, 'a beat in Spanish');
  assert.deepEqual(out.slice(n), [{ kind: 'speech', id: r.id, rate: 44100, pcm: Buffer.from([7, 0]).toString('base64') }], 'one made Spanish line, never a shipped English one');
  assert.equal(r.beat(), false, 'once per reply');
  r.say('Hola.'); r.end();
  assert.deepEqual(made.at(-1).said, ['Hola.'], 'the reply itself is spoken as usual');
}
{ // Only when slow, as the English ones: nothing once the reply has started talking; one not made yet is said live.
  const { sp, out } = setup(undefined, BEATS, shippedAll, BEATS_ES);
  sp.setLanguage('es'); sp.setKey('k');
  const r = sp.start();
  r.say('Son las tres.');
  assert.equal(r.beat(), false, 'it is already talking');
  const r2 = sp.start(), live = made.at(-1), n = out.length;
  assert.equal(r2.beat(), true);
  assert.ok(BEATS_ES.includes(live.said[0]) && live.said.length === 1, `said live in Spanish: ${live.said}`);
  assert.equal(out.length, n, 'nothing shipped plays');
  await tick(); await tick(); // its first Spanish line is being made: let that start here, not in the next test
}
{ // Back to Auto: the English ones play again and no Spanish line is made any more.
  const { sp, out } = setup(undefined, BEATS, shippedAll, BEATS_ES);
  sp.setKey('k'); await tick(); await tick();
  assert.equal(made.filter((v) => BEATS_ES.includes(v.said[0])).length, 0, 'no Spanish line is made on Auto');
  sp.setLanguage('es'); await tick();
  assert.deepEqual(made.at(-1).said, [BEATS_ES[0]], 'switched to Spanish: they are made now');
  made.at(-1).onError(new Error('x')); await tick(); await tick();
  sp.setLanguage('auto'); await tick();
  const r = sp.start();
  assert.equal(r.beat(), true);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 24000, pcm: clip.pcm }, 'the shipped English beat on Auto');
}
// Never set (a config from before the setting), Auto, English, and a value that isn't a choice: the shipped beat plays.
for (const lang of [undefined, 'auto', 'en', 'fr', null]) {
  const { sp, out } = setup(undefined, BEATS, shippedAll, BEATS_ES);
  if (lang !== undefined) sp.setLanguage(lang);
  sp.setKey('k'); await tick(); await tick();
  assert.equal(made.filter((v) => v.said.length).length, 0, `nothing is made with ${lang}: the English beats are shipped`);
  const r = sp.start();
  assert.equal(r.beat(), true, `a beat with ${lang}`);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 24000, pcm: clip.pcm }, `the shipped beat with ${lang}`);
  assert.equal(r.beat(), false, 'once per reply');
}
{ // Switching mid-way: Spanish gets a Spanish line, English the shipped English beat again.
  const { sp, out } = setup(undefined, BEATS, shippedAll, BEATS_ES);
  sp.setKey('k'); await tick();
  sp.setLanguage('es');
  const r0 = sp.start();
  assert.equal(r0.beat(), true);
  assert.ok(BEATS_ES.includes(made.at(-1).said[0]), 'a Spanish one, said live (not made yet)');
  sp.setLanguage('en');
  const r = sp.start();
  assert.equal(r.beat(), true);
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: 24000, pcm: clip.pcm });
}
console.log('speaker language: passed');
