// The speech model for voice on Windows and Linux: NVIDIA Parakeet TDT 0.6B v3, int8 ONNX export (CC-BY-4.0,
// huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), pinned to one commit and checked by SHA-256.
// Downloaded once into the user's local app data; interrupted downloads resume where they stopped.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const MODEL = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  base: 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/',
  files: [
    { name: 'encoder-model.int8.onnx', size: 652183999, sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09' },
    { name: 'decoder_joint-model.int8.onnx', size: 18202004, sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70' },
    { name: 'vocab.txt', size: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  ],
};

// Two small models the voice helper uses when they are there, next to the speech model: Silero VAD v6.2.3 (MIT,
// github.com/snakers4/silero-vad, the 16 kHz/8 kHz ONNX its own wrapper loads) tells a voice from noise, and Pipecat
// Smart Turn v3.2 (BSD-2-Clause, huggingface.co/pipecat-ai/smart-turn-v3, the int8 CPU export) tells from the voice
// whether a turn is finished. Each is pinned and checked like the speech model, and is optional: without one the
// helper keeps the volume gate and the pauses, so a failed download never fails the speech model's.
export const EXTRAS = [
  { name: 'silero-vad.onnx', url: 'https://raw.githubusercontent.com/snakers4/silero-vad/5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad.onnx', size: 2327524, sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3' },
  { name: 'smart-turn.onnx', url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx', size: 8679182, sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f' },
];

export const totalBytes = (model = MODEL) => model.files.reduce((n, f) => n + f.size, 0);
export const sizeLabel = (model = MODEL) => `${Math.round(totalBytes(model) / 1e6)} MB`;

export function modelDir(model = MODEL) {
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Roamies') : path.join(os.homedir(), '.gg', 'sidekick');
  return path.join(root, 'models', model.id);
}

const READY = 'ready.json';

/** Downloaded and verified: the marker is written only after every file's checksum matched. */
export function isReady(dir, model = MODEL) {
  try {
    if (JSON.parse(readFileSync(path.join(dir, READY), 'utf8')).id !== model.id) return false;
    return model.files.every((f) => statSync(path.join(dir, f.name)).size === f.size);
  } catch { return false; }
}

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Fetches every missing file, verifies it and writes the ready marker.
 * onProgress({ done, total }) runs often; throttle it in the caller.
 * Errors carry a code: 'disk' (not enough space), 'checksum', 'network' or 'aborted'.
 * Resolves as soon as the marker is written, with { extras }: a promise for the extras (EXTRAS for the speech model),
 * fetched after it by downloadExtras, that never rejects and names the ones it couldn't get. The model is ready
 * without them, so nothing waits for them (one that stalls would hold "My voice is ready" for ever).
 */
export async function downloadModel(dir, { model = MODEL, extras = model === MODEL ? EXTRAS : [], ready = true, onProgress = () => {}, signal, fetchImpl = fetch, retries = 4, retryDelay = 2000 } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const total = totalBytes(model);
  const have = async (f) => {
    for (const p of [path.join(dir, f.name), path.join(dir, `${f.name}.part`)]) {
      try { return Math.min((await fs.stat(p)).size, f.size); } catch {}
    }
    return 0;
  };
  const counts = await Promise.all(model.files.map(have));
  let done = counts.reduce((a, b) => a + b, 0);
  try {
    const free = await fs.statfs(dir);
    // Room for what's left plus a little slack.
    if (free.bavail * free.bsize < total - done + 50e6) throw fail('disk', `Not enough free disk space: the voice model needs ${sizeLabel(model)}.`);
  } catch (e) { if (e.code === 'disk') throw e; }
  onProgress({ done, total });

  for (const f of model.files) {
    const final = path.join(dir, f.name), part = `${final}.part`;
    if (existsSync(final) && statSync(final).size === f.size) {
      if (await sha256(final) === f.sha256) continue;
      await fs.rm(final, { force: true });
      done -= f.size; onProgress({ done, total });
    }
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw fail('aborted', 'Download stopped.');
      let start = 0;
      try { start = (await fs.stat(part)).size; } catch {}
      if (start > f.size) { await fs.rm(part, { force: true }); done -= start; start = 0; }
      try {
        if (start < f.size) {
          const res = await fetchImpl(f.url ?? model.base + f.name, { headers: start ? { Range: `bytes=${start}-` } : {}, signal, redirect: 'follow' });
          // 206: resuming. 200: the server sent it all, so start over. 416: what's there is already complete or wrong.
          if (res.status === 416) { await fs.rm(part, { force: true }); done -= start; onProgress({ done, total }); throw fail('network', 'Range not satisfiable'); }
          if (!res.ok || !res.body) throw fail('network', `HTTP ${res.status}`);
          const resumed = res.status === 206 && start > 0;
          if (!resumed && start) { done -= start; start = 0; }
          // Each chunk is written before the next is read, so a dropped connection keeps everything that arrived.
          const fh = await fs.open(part, resumed ? 'a' : 'w');
          try {
            for await (const chunk of res.body) { await fh.write(chunk); done += chunk.length; onProgress({ done, total }); }
          } finally { await fh.close(); }
        }
        if ((await fs.stat(part)).size !== f.size) throw fail('network', 'Download ended early');
        if (await sha256(part) !== f.sha256) {
          await fs.rm(part, { force: true });
          done -= f.size; onProgress({ done, total });
          throw fail('checksum', `${f.name} didn't match its checksum`);
        }
        await fs.rename(part, final);
        break;
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') throw fail('aborted', 'Download stopped.');
        if (attempt >= retries) throw e.code === 'checksum' ? e : fail('network', `Couldn't download the voice model (${e.message}).`);
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
      }
    }
  }
  if (!ready) return { extras: Promise.resolve([]) };
  await fs.writeFile(path.join(dir, READY), JSON.stringify({ id: model.id, at: new Date().toISOString() }));
  onProgress({ done: total, total });
  const later = extras.length ? downloadExtras(dir, { extras, signal, fetchImpl, retries, retryDelay }) : Promise.resolve([]);
  return { extras: later.catch(() => extras.map((f) => f.name)) };
}

/**
 * Fetches the extras that aren't there yet, each on its own, and never throws: returns the names it couldn't get.
 * A file is only renamed into place once its checksum matched, so one that is there at its size is done.
 */
export async function downloadExtras(dir, { extras = EXTRAS, signal, fetchImpl = fetch, retries = 4, retryDelay = 2000 } = {}) {
  const failed = [];
  for (const f of extras) {
    try { if (statSync(path.join(dir, f.name)).size === f.size) continue; } catch {}
    try {
      // No marker of its own: the folder's ready.json is the speech model's.
      await downloadModel(dir, { model: { id: f.name, files: [f] }, ready: false, signal, fetchImpl, retries, retryDelay });
    } catch { failed.push(f.name); }
  }
  return failed;
}
