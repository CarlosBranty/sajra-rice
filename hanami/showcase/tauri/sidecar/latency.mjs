// ROAMIES_LATENCY=1 (a debug aid): when each stage of a spoken question happened, on the wall clock every process of
// the app shares (milliseconds since 1970). The voice helper sends its three with the words (voiced: the voice last
// went above speech level; closed: the take ended, and why; final: its words were ready), the sidecar adds its own and
// the page says when the first audio started playing. One line per stage as it happens, then a summary line with the
// gaps, all on stderr (~/.gg/sidekick.log). Off, start() returns null and nothing else runs.

// In the order they happen: [key, what it is].
export const STAGES = [
  ['voiced', 'last voiced audio'],
  ['closed', 'take closed'],
  ['final', 'final transcript'],
  ['received', 'words reached the sidecar'],
  ['sent', 'request sent to the model'],
  ['token', 'first token'],
  ['sentence', 'first sentence handed to the voice'],
  ['audio', 'first audio from Fish'],
  ['played', 'first audio playing'],
];

/** The summary of one question: each gap between stages that happened, in order, and the whole. */
export function summary(q, t, about = {}) {
  const seen = STAGES.map(([k]) => k).filter((k) => Number.isFinite(t[k]));
  const gaps = seen.slice(1).map((k, i) => `${seen[i]}→${k} ${Math.round(t[k] - t[seen[i]])}`);
  const whole = seen.length > 1 ? ` | ${seen[0]}→${seen.at(-1)} ${Math.round(t[seen.at(-1)] - t[seen[0]])}` : '';
  const extra = Object.entries(about).filter(([, v]) => v != null && v !== '').map(([k, v]) => ` ${k}=${v}`).join('');
  return `[latency] ${q} summary ms: ${gaps.join(', ')}${whole}${extra}`;
}

/** on: the trace is wanted (ROAMIES_LATENCY). print: where lines go. now: the wall clock. */
export function createLatency({ on = !!process.env.ROAMIES_LATENCY, print = (s) => console.error(s), now = Date.now } = {}) {
  let n = 0;
  return {
    on,
    /** A spoken question's trace, from the helper's stage times (helper: the words' trace, or nothing), or null when off. */
    start(helper) {
      if (!on) return null;
      const q = `q${++n}${helper?.take != null ? `/take${helper.take}` : ''}`;
      const t = {}, about = { why: helper?.why, read: helper?.read, model: null, beat: null };
      let last = null, ended = false;
      const rec = {
        speech: null, // the reply's voice id, so its first audio and its playing can be told apart from others
        about,
        mark(stage, at = now()) {
          if (ended || !Number.isFinite(at) || Number.isFinite(t[stage])) return;
          t[stage] = at;
          print(`[latency] ${q} ${stage} ${new Date(at).toISOString()}${last == null ? '' : ` +${Math.round(at - last)}ms`}`);
          last = at;
        },
        /** Once: the summary line (the first audio played, or nothing will). */
        done() { if (ended) return; ended = true; print(summary(q, t, about)); },
        times: t,
      };
      for (const k of ['voiced', 'closed', 'final']) if (Number.isFinite(helper?.[k])) rec.mark(k, helper[k]);
      rec.mark('received');
      return rec;
    },
  };
}
