// Linux: the microphones and speakers the sound server (PipeWire or PulseAudio) has, for the Voice page's pickers,
// read with `pactl -f json list sources|sinks`. The pick is a device's name; '' is the system's default. The shell
// does the rest: the voice helper is started pointed at the microphone (voice.rs), and Roamies' own playback is
// moved to the speaker (linux.rs). Parsing is pure (test/audiodev.test.mjs).
import { execFile } from 'node:child_process';

/** A device name as the sound server writes them, or '' (the default) for anything else. */
export const deviceName = (v) => (typeof v === 'string' && /^[\w.:@+-]{1,200}$/.test(v) ? v : '');

/** pactl's JSON list of sources or sinks → [{ name, label }]; a source that is a speaker's monitor is not a microphone. */
export function parseDevices(text) {
  let list;
  try { list = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const devices = list
    .filter((d) => deviceName(d?.name) && !d.name.endsWith('.monitor') && !/^Monitor of /.test(d.description ?? ''))
    .map((d) => ({ name: d.name, label: String(d.description || d.name).slice(0, 120) }));
  return shorten(devices);
}

/** Labels that share a long beginning with another (a sound card's name: "500 Series … (HD Audio) Speaker", "… HDMI 1")
 *  lose it, so what tells them apart shows in a narrow picker. */
function shorten(devices) {
  const shared = (a, b) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return a.slice(0, i).lastIndexOf(' ') + 1;
  };
  return devices.map((d) => {
    // The shortest of the long ones: the card's name, not also the "HDMI / DisplayPort " that two of its outputs share.
    const cuts = devices.filter((o) => o !== d).map((o) => shared(d.label, o.label)).filter((c) => c >= 24);
    const cut = cuts.length ? Math.min(...cuts) : 0;
    return cut && cut < d.label.length ? { ...d, label: d.label.slice(cut) } : d;
  });
}

const pactl = (what) => new Promise((resolve) => {
  execFile('pactl', ['-f', 'json', 'list', what], { timeout: 3000, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C.UTF-8' }, maxBuffer: 8 << 20 },
    (err, out) => resolve(err ? null : String(out)));
});

/** { mics, speakers } now, or null when there is no pactl or sound server. run(what): pactl's output (a test's fake). */
export async function listDevices(run = pactl) {
  const [sources, sinks] = await Promise.all([run('sources'), run('sinks')]);
  if (sources == null && sinks == null) return null;
  return { mics: parseDevices(sources ?? '[]'), speakers: parseDevices(sinks ?? '[]') };
}
