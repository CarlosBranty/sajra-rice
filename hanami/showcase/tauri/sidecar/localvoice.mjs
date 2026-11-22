// The local voice (Linux and Windows): spoken replies made on this computer, offline, by the voice helper's --speak
// mode (src-tauri/voice-win/src/speak.rs, upstream Piper 1.8's way of speaking a Piper voice). The voice is Piper's
// es_ES "sharvard" medium, retrained upstream (rhasspy/piper-voices, pinned to one commit, checked by SHA-256), speaker
// F; it's Spanish (Spain). Downloaded on first use next to the speech model (voicemodel.mjs). The helper process starts
// on the first reply and stays, so the voice loads once (~2 s); sentences are spoken one by one as the reply streams,
// each coming back as 16-bit mono PCM at 22 050 Hz in the same chunk messages Fish Audio's audio goes out in.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { modelDir } from './voicemodel.mjs';

export const LOCAL_VOICE = {
  id: 'piper-es_ES-sharvard-medium-cf910fb',
  base: 'https://huggingface.co/rhasspy/piper-voices/resolve/cf910fb59f1d79ab3b625a63993a108751c6c25d/es/es_ES/sharvard/medium/',
  files: [
    { name: 'es_ES-sharvard-medium.onnx', size: 76753841, sha256: '234dc4cf0fdb53ccb76b9b2c4d7ef1330364762674c1b78c1b62d8608c528a54' },
    { name: 'es_ES-sharvard-medium.onnx.json', size: 5486, sha256: '1910940c6b480e0f7cbce5e0da45c8cbe2557ccbfd86a5d22cda141a3b65f521' },
  ],
};
export const LOCAL_SPEAKER = 1; // "F" in the voice's speaker_id_map
export const LOCAL_RATE = 22050;
export const LOCAL_THREADS = 2; // leaves the cores Parakeet uses for speech-to-text
export const localModel = (dir = modelDir(LOCAL_VOICE)) => path.join(dir, LOCAL_VOICE.files[0].name);

/** The words to say: voice cues ("[warm]", "[chuckling]") are for Fish, so they're dropped, never read out. */
export const spokenText = (t) => String(t ?? '').replace(/\[[^\]]*\]\s*/g, '').replace(/\s+/g, ' ').trim();

/**
 * The helper process: started on first use (or warm()) and kept. say(id, text) queues text; what comes back for
 * that id goes to the handlers listen(id, …) registered: onAudio(base64 PCM, rate), onSaid() once the text is all
 * spoken, onSkip() when it was skipped, onError(err).
 * The helper speaks the texts in the order they were sent and ends each with "said" (a cancelled one too), so the
 * first one not said yet is the one it's on. If it dies on that one (a crash on some text), that text is skipped
 * and the helper is started again with the rest: the reply goes on without that sentence. Once: if the new one dies
 * too before it has said anything, or one dies before it's ready (the voice won't load), every open id gets an
 * error, as when it's stopped. With nothing being spoken, the next say() starts it again.
 */
export function createLocalEngine({ bin, model, spawnImpl = spawn, log = () => {}, speaker = LOCAL_SPEAKER, threads = LOCAL_THREADS }) {
  let proc = null, ready = false, restarted = false;
  let queue = []; // { id, text } sent to the running helper and not said yet, in order
  const listeners = new Map();
  const failAll = (why) => {
    const all = [...listeners.values()];
    listeners.clear();
    for (const l of all) l.onError?.(new Error(why));
  };
  const handle = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'ready') { ready = true; return log('local_voice_ready', { ms: m.ms }); }
    const l = m.id != null ? listeners.get(m.id) : null;
    if (m.type === 'audio' && typeof m.pcm === 'string') l?.onAudio?.(m.pcm, m.rate);
    else if (m.type === 'said') {
      const i = queue.findIndex((q) => q.id === m.id);
      if (i >= 0) queue.splice(i, 1);
      restarted = false;
      l?.onSaid?.();
    } else if (m.type === 'error') { if (l) l.onError?.(new Error(String(m.message ?? 'The local voice failed'))); else log('local_voice_error', { message: String(m.message ?? '').slice(0, 200) }); }
  };
  const start = () => {
    const p = spawnImpl(bin, ['--speak', model, '--speaker', String(speaker), '--threads', String(threads)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc = p;
    ready = false;
    let buf = '';
    p.stdout.setEncoding?.('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handle(line); }
    });
    p.stderr?.on('data', (d) => log('local_voice_log', { text: String(d).trim().slice(0, 300) }));
    p.stdin.on?.('error', () => {});
    const gone = (why) => {
      if (proc !== p) return;
      proc = null;
      log('local_voice_exit', { why });
      const [doing, ...rest] = queue;
      queue = [];
      if (!ready || (restarted && doing)) { restarted = false; return failAll('The local voice stopped'); }
      if (!doing) return;
      restarted = true;
      log('local_voice_skip', { id: doing.id, chars: doing.text.length });
      listeners.get(doing.id)?.onSkip?.();
      for (const q of rest) if (listeners.has(q.id)) send(q);
    };
    p.on('exit', (code, signal) => gone(`exit ${code ?? signal}`));
    p.on('error', (e) => gone(e.message));
  };
  const send = (msg) => {
    if (!proc) start();
    if (msg.text != null) queue.push(msg);
    try { proc.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* the exit handler reports it */ }
  };
  return {
    listen(id, handlers) { listeners.set(id, handlers); },
    say(id, text) { send({ id, text }); },
    /** Stops what's still queued for id; nothing more is heard from it. */
    cancel(id) { listeners.delete(id); if (proc) send({ cmd: 'cancel', id }); },
    done(id) { listeners.delete(id); },
    warm() { if (!proc) start(); },
    stop() { const p = proc; proc = null; queue = []; restarted = false; failAll('The local voice stopped'); try { p?.kill(); } catch {} },
    get running() { return !!proc; },
  };
}

let seq = 0;
/**
 * One reply's local voice, used like FishVoice: say() as many times as needed, then end(); abort() stops at once.
 * onAudio(base64 PCM) as each sentence is ready, onEnd() after the last, onError(err) instead (err.heard: any audio yet).
 */
export class LocalVoice {
  constructor({ engine, onAudio, onEnd, onError }) {
    Object.assign(this, { engine, onAudio, onEnd, onError });
    this.id = `local${++seq}`;
    this.state = 'new'; // new → open → ending → done
    this.pending = 0;
    this.heard = false;
  }

  open() {
    if (this.state !== 'new') return this;
    this.state = 'open';
    this.engine.listen(this.id, {
      onAudio: (pcm) => { if (this.state === 'done') return; this.heard = true; this.onAudio?.(pcm); },
      onSaid: () => { this.pending--; this.check(); },
      onSkip: () => { this.pending--; this.check(); }, // the helper crashed on that text: the reply goes on without it
      onError: (e) => this.fail(e),
    });
    return this;
  }

  say(text) {
    if (this.state === 'new') this.open();
    if (this.state !== 'open') return;
    const t = spokenText(text);
    if (!t) return;
    this.pending++;
    this.engine.say(this.id, t);
  }

  end() {
    if (this.state === 'new') this.open();
    if (this.state !== 'open') return;
    this.state = 'ending';
    this.check();
  }

  check() {
    if (this.state !== 'ending' || this.pending > 0) return;
    this.state = 'done';
    this.engine.done(this.id);
    this.onEnd?.();
  }

  abort() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.engine.cancel(this.id);
  }

  fail(err) {
    if (this.state === 'done') return;
    this.state = 'done';
    this.engine.cancel(this.id);
    err.heard = this.heard;
    this.onError?.(err);
  }
}
