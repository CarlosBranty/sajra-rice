// What the agent can tell about its own use: the tokens of past requests, from the usage log sidekick.mjs writes
// (one JSON line per request in ~/.gg/sidekick/usage.jsonl: model, token counts and timings, never what was said),
// and how it answers now: which provider and model, through the user's subscription (signed in to their account)
// or an API key.
import fs from 'node:fs/promises';
import { z } from 'zod';

const day = (t) => new Date(t).toLocaleDateString('en-CA');
const N = (v) => (Number.isFinite(v) ? v : 0);
const NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', glm: 'Z.ai GLM', minimax: 'MiniMax', xiaomi: 'Xiaomi MiMo' };
const VIA = {
  subscription: "through the user's Claude subscription (signed in with Claude, run by Claude Code): no charge per token, it counts against the plan's usage limits",
  account: "through the user's account with that provider (signed in): it counts against that plan's limits",
  'api-key': 'through an API key (billed per token by the provider)',
};

/** Records of usage.jsonl between two local days (YYYY-MM-DD, both included; either may be left out). */
export function summarize(records, { from, to } = {}) {
  const total = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
  const models = new Map();
  let requests = 0;
  for (const r of records) {
    const d = day(r.t);
    if ((from && d < from) || (to && d > to)) continue;
    requests++;
    const m = models.get(r.model) ?? { model: r.model, requests: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
    m.requests++;
    for (const k of Object.keys(total)) { total[k] += N(r[k]); m[k] += N(r[k]); }
    models.set(r.model, m);
  }
  const byModel = [...models.values()].sort((a, b) => b.in + b.cacheWrite + b.out - (a.in + a.cacheWrite + a.out));
  return { requests, total, byModel };
}

async function readRecords(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((l) => {
    try { const r = JSON.parse(l); return Number.isFinite(r?.t) ? [r] : []; } catch { return []; }
  });
}

const tokens = (u) => `input ${u.in}, from cache ${u.cacheRead}, written to cache ${u.cacheWrite}, output ${u.out}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** file: usage.jsonl; now(): ms; route(): { provider, model, via: 'subscription' | 'account' | 'api-key' } or null. */
export function usageTools({ file, now = Date.now, route }) {
  return [{
    name: 'token_usage',
    description: "How many tokens Roamies has used answering the user (today, yesterday, the last 7 days, this month or everything kept, about 90 days), per model, and how it answers now: the AI provider and model, and whether through the user's subscription or an API key. Input tokens are new text sent; from cache are tokens re-read from the prompt cache (much cheaper); output tokens are what the model wrote.",
    parameters: z.object({ period: z.enum(['today', 'yesterday', 'week', 'month', 'all']).optional().describe('today if left out') }),
    execute: async ({ period = 'today' }) => {
      const t = now(), today = day(t);
      const [label, from, to] = {
        today: ['Today', today, today],
        yesterday: ['Yesterday', day(t - 864e5), day(t - 864e5)],
        week: ['The last 7 days', day(t - 6 * 864e5), today],
        month: ['This month', `${today.slice(0, 7)}-01`, today],
        all: ['Everything kept', undefined, undefined],
      }[period];
      const s = summarize(await readRecords(file), { from, to });
      const span = from ? (from === to ? ` (${from})` : ` (${from} to ${to})`) : '';
      const lines = [s.requests
        ? `${label}${span}: ${plural(s.requests, 'request')}; tokens: ${tokens(s.total)}.`
        : `${label}${span}: no requests.`];
      if (s.byModel.length > 1) lines.push(`By model: ${s.byModel.map((m) => `${m.model} ${plural(m.requests, 'request')} (${tokens(m)})`).join('; ')}.`);
      const r = route?.();
      lines.push(r ? `Answering now: ${NAMES[r.provider] ?? r.provider}, model ${r.model}, ${VIA[r.via] ?? r.via}.` : 'No AI provider is signed in.');
      return lines.join('\n');
    },
  }];
}
