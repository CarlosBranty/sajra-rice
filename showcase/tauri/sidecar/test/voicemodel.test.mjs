// Voice model download (Windows voice): resume, checksum, ready marker. Uses a local server, never the real model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadExtras, downloadModel, EXTRAS, isReady, totalBytes } from '../voicemodel.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-model-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const A = Buffer.alloc(300_000, 7), B = Buffer.from('hello vocab\n');
const files = { 'enc.onnx': A, 'vocab.txt': B };
let requests = [], cutAfter = null, corrupt = false;
const server = http.createServer((req, res) => {
  const body = files[req.url.slice(1)];
  requests.push({ url: req.url, range: req.headers.range });
  if (!body) { res.writeHead(404).end(); return; }
  const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
  const slice = body.subarray(from);
  res.writeHead(from ? 206 : 200, { 'content-length': slice.length });
  if (cutAfter != null) { res.write(slice.subarray(0, cutAfter), () => setTimeout(() => res.destroy(), 30)); cutAfter = null; return; }
  res.end(corrupt ? Buffer.alloc(slice.length, 1) : slice);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const model = {
  id: 'test-model',
  base: `http://127.0.0.1:${server.address().port}/`,
  files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })),
};
const opts = { model, retryDelay: 1 };

// A first try that drops mid-file resumes with a Range request, then everything verifies.
const dir = path.join(TMP, 'a');
assert.equal(isReady(dir, model), false);
cutAfter = 100_000;
const seen = [];
await downloadModel(dir, { ...opts, onProgress: (p) => seen.push(p) });
assert.equal(isReady(dir, model), true);
assert.deepEqual(fs.readFileSync(path.join(dir, 'enc.onnx')), A);
assert.ok(requests.some((r) => r.url === '/enc.onnx' && r.range === 'bytes=100000-'), 'resumed from where it stopped');
assert.deepEqual(seen.at(-1), { done: totalBytes(model), total: totalBytes(model) });
assert.ok(seen.every((p) => p.done <= p.total), 'progress never overshoots');
assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.part')), false, 'no leftovers');

// Already there: verified from disk, nothing fetched.
requests = [];
await downloadModel(dir, opts);
assert.equal(requests.length, 0);

// A part file left by a quit app is picked up.
const dir2 = path.join(TMP, 'b');
fs.mkdirSync(dir2);
fs.writeFileSync(path.join(dir2, 'enc.onnx.part'), A.subarray(0, 250_000));
requests = [];
await downloadModel(dir2, opts);
assert.equal(isReady(dir2, model), true);
assert.equal(requests.find((r) => r.url === '/enc.onnx').range, 'bytes=250000-');

// Bad bytes never become a ready model.
const dir3 = path.join(TMP, 'c');
corrupt = true;
await assert.rejects(downloadModel(dir3, { ...opts, retries: 0 }), (e) => e.code === 'checksum');
assert.equal(isReady(dir3, model), false);
assert.equal(fs.existsSync(path.join(dir3, 'enc.onnx')), false);
corrupt = false;

// A wrong id in the marker or a truncated file means not ready.
fs.writeFileSync(path.join(dir2, 'ready.json'), JSON.stringify({ id: 'other' }));
assert.equal(isReady(dir2, model), false);
await downloadModel(dir2, opts);
fs.truncateSync(path.join(dir2, 'vocab.txt'), 3);
assert.equal(isReady(dir2, model), false);

// Stopping reports 'aborted'; a missing file is a network error after retries.
const ac = new AbortController(); ac.abort();
await assert.rejects(downloadModel(path.join(TMP, 'd'), { ...opts, signal: ac.signal }), (e) => e.code === 'aborted');
await assert.rejects(downloadModel(path.join(TMP, 'e'), { ...opts, model: { ...model, files: [{ name: 'missing.bin', size: 5, sha256: 'x' }] }, retries: 1 }), (e) => e.code === 'network');

{ // The two small models the voice helper uses when they're there (a voice gate and end of turn) come with the speech
  // model, each checked on its own; one that fails leaves the speech model ready and nothing half there.
  const V = Buffer.alloc(20_000, 3), T = Buffer.alloc(30_000, 5);
  files['v.onnx'] = V; files['t.onnx'] = T;
  const extras = [
    { name: 'silero-vad.onnx', url: `${model.base}v.onnx`, size: V.length, sha256: sha(V) },
    { name: 'smart-turn.onnx', url: `${model.base}t.onnx`, size: T.length, sha256: sha(T) },
  ];
  const d = path.join(TMP, 'x');
  assert.deepEqual(await (await downloadModel(d, { ...opts, extras })).extras, []);
  assert.equal(isReady(d, model), true);
  assert.deepEqual(fs.readFileSync(path.join(d, 'silero-vad.onnx')), V);
  assert.deepEqual(fs.readFileSync(path.join(d, 'smart-turn.onnx')), T);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'ready.json'), 'utf8')).id, model.id, "the speech model's marker stays its own");

  // Never fetched twice: not by the next download, nor by fetching the extras alone.
  requests = [];
  await (await downloadModel(d, { ...opts, extras })).extras;
  assert.deepEqual(await downloadExtras(d, { ...opts, extras }), []);
  assert.equal(requests.length, 0);

  // One missing upstream (404): the speech model is still ready and the other one arrives.
  const d2 = path.join(TMP, 'y');
  const gone = [{ ...extras[0], url: `${model.base}gone.onnx` }, extras[1]];
  assert.deepEqual(await (await downloadModel(d2, { ...opts, extras: gone })).extras, ['silero-vad.onnx']);
  assert.equal(isReady(d2, model), true);
  assert.equal(fs.existsSync(path.join(d2, 'silero-vad.onnx')), false);
  assert.deepEqual(fs.readFileSync(path.join(d2, 'smart-turn.onnx')), T);

  // Bad bytes: never put in place, and no part file left.
  const d3 = path.join(TMP, 'z');
  await (await downloadModel(d3, { ...opts, extras: [{ ...extras[0], sha256: sha(Buffer.from('other')) }] })).extras;
  assert.equal(isReady(d3, model), true);
  assert.deepEqual(fs.readdirSync(d3).sort(), ['enc.onnx', 'ready.json', 'vocab.txt']);

  // A speech model downloaded before the extras existed gets them on their own; the result names what failed.
  assert.deepEqual(await downloadExtras(d2, { ...opts, extras: gone }), ['silero-vad.onnx']);
  assert.deepEqual(await downloadExtras(d2, { ...opts, extras }), []);
  assert.deepEqual(fs.readFileSync(path.join(d2, 'silero-vad.onnx')), V);
}

{ // Regression: "My voice is ready" waited for the extras (about 40 s when both failed, for ever when one stalled).
  // The speech model is ready, and downloadModel done, as soon as its marker is written; the extras come after.
  const T = Buffer.alloc(10_000, 9);
  const extras = [{ name: 'smart-turn.onnx', url: 'http://stalled.invalid/t.onnx', size: T.length, sha256: sha(T) }];
  let release;
  const stalled = new Promise((r) => { release = r; });
  const fetchImpl = (url, o) => (String(url).includes('stalled') ? stalled.then(() => fetch(`${model.base}missing`, o)) : fetch(url, o));
  const d = path.join(TMP, 's');
  const got = await Promise.race([downloadModel(d, { ...opts, extras, fetchImpl, retries: 0 }), new Promise((r) => setTimeout(() => r('waited'), 2000))]);
  assert.notEqual(got, 'waited', 'ready without waiting for the extras');
  assert.equal(isReady(d, model), true);
  release();
  assert.deepEqual(await got.extras, ['smart-turn.onnx'], 'and they report what failed when they are done');
  // No extras (another model): nothing to wait for.
  assert.deepEqual(await (await downloadModel(path.join(TMP, 's2'), { ...opts, extras: [] })).extras, []);
}

server.close();
console.log('voice model download tests: passed');

{ // The extras are pinned: Silero VAD v6.2.3 (MIT) at its release commit on GitHub, Smart Turn v3.2's CPU (int8) model
  // (BSD-2-Clause) at one Hugging Face commit, each with its size and SHA-256. By default downloadExtras asks for those.
  assert.deepEqual(EXTRAS, [
    { name: 'silero-vad.onnx', url: 'https://raw.githubusercontent.com/snakers4/silero-vad/5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad.onnx', size: 2327524, sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3' },
    { name: 'smart-turn.onnx', url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx', size: 8679182, sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f' },
  ]);
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return new Response(null, { status: 404 }); };
  const failed = await downloadExtras(path.join(TMP, 'w'), { fetchImpl, retries: 0, retryDelay: 1 });
  assert.deepEqual(failed, ['silero-vad.onnx', 'smart-turn.onnx']);
  assert.deepEqual(asked, EXTRAS.map((f) => f.url));
}
console.log('voice extras pinned: passed');

{ // The local voice is pinned like the speech model: one upstream commit, each file's size and SHA-256 (as Hugging
  // Face's LFS pointer states them for the model), stored next to the speech model.
  const { LOCAL_VOICE, localModel } = await import('../localvoice.mjs');
  const { MODEL, modelDir } = await import('../voicemodel.mjs');
  assert.equal(LOCAL_VOICE.base, 'https://huggingface.co/rhasspy/piper-voices/resolve/cf910fb59f1d79ab3b625a63993a108751c6c25d/es/es_ES/sharvard/medium/');
  assert.deepEqual(LOCAL_VOICE.files, [
    { name: 'es_ES-sharvard-medium.onnx', size: 76753841, sha256: '234dc4cf0fdb53ccb76b9b2c4d7ef1330364762674c1b78c1b62d8608c528a54' },
    { name: 'es_ES-sharvard-medium.onnx.json', size: 5486, sha256: '1910940c6b480e0f7cbce5e0da45c8cbe2557ccbfd86a5d22cda141a3b65f521' },
  ]);
  assert.equal(path.dirname(modelDir(LOCAL_VOICE)), path.dirname(modelDir(MODEL)), 'in the same models folder');
  assert.equal(localModel(), path.join(modelDir(LOCAL_VOICE), 'es_ES-sharvard-medium.onnx'));
  assert.equal(totalBytes(LOCAL_VOICE), 76759327);
}
console.log('local voice download: passed');
