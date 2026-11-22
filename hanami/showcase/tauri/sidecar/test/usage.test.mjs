import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarize, usageTools } from '../usage.mjs';

const at = (iso) => new Date(iso).getTime();
const rec = (iso, model, n, extra = {}) => ({ t: at(iso), model, calls: 1, tools: 0, in: n, cacheRead: n * 10, cacheWrite: n * 2, out: n * 3, ms: 1000, ...extra });

test('usage is summed per model inside the period, local days', () => {
  const recs = [
    rec('2026-11-10T12:00:00', 'claude-haiku-5-5', 10),
    rec('2026-11-12T09:00:00', 'claude-haiku-5-5', 1),
    rec('2026-11-12T10:00:00', 'claude-sonnet-5-5', 2),
  ];
  const s = summarize(recs, { from: '2026-11-12', to: '2026-11-12' });
  assert.equal(s.requests, 2);
  assert.deepEqual(s.total, { in: 3, cacheRead: 30, cacheWrite: 6, out: 9 });
  assert.deepEqual(s.byModel.map((m) => [m.model, m.requests]), [['claude-sonnet-5-5', 1], ['claude-haiku-5-5', 1]]);
  assert.equal(summarize(recs, {}).requests, 3, 'no bounds: everything');
});

test('the tool says the tokens of a period and the route that answers now', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 'usage.jsonl');
  const lines = [
    rec('2026-11-01T08:00:00', 'claude-haiku-5-5', 100, { route: 'claude-code', provider: 'anthropic' }),
    rec('2026-11-12T09:00:00', 'claude-haiku-5-5', 4, { route: 'claude-code', provider: 'anthropic' }),
  ];
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  const [tool] = usageTools({ file, now: () => at('2026-11-12T20:00:00'), route: () => ({ provider: 'anthropic', model: 'claude-haiku-5-5', via: 'subscription' }) });
  assert.equal(tool.name, 'token_usage');

  const today = await tool.execute({});
  assert.match(today, /Today \(2026-11-12\): 1 request/);
  assert.match(today, /input 4, from cache 40, written to cache 8, output 12/);
  assert.match(today, /Answering now: Anthropic, model claude-haiku-5-5, through the user's Claude subscription/);
  assert.match(today, /no charge per token/);

  const month = await tool.execute({ period: 'month' });
  assert.match(month, /This month \(2026-11-01 to 2026-11-12\): 2 requests/);
  assert.match(month, /input 104/);

  const api = usageTools({ file, now: () => at('2026-11-12T20:00:00'), route: () => ({ provider: 'openai', model: 'gpt-x', via: 'api-key' }) })[0];
  assert.match(await api.execute({}), /Answering now: OpenAI, model gpt-x, through an API key \(billed per token/);

  const none = usageTools({ file: path.join(dir, 'missing.jsonl'), now: () => at('2026-11-12T20:00:00'), route: () => null })[0];
  assert.match(await none.execute({}), /Today \(2026-11-12\): no requests/);
  assert.match(await none.execute({}), /No AI provider is signed in/);
  await fs.rm(dir, { recursive: true });
});
