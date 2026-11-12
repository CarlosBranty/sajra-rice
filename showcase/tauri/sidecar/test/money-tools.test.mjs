// The agent's money tools: the month's spending summary and the read-only query. Throwaway data folder. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
import { openMoney } from '../money.mjs';
import { moneyTools } from '../money/tools.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-money-tools-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const tool = (tools, name) => tools.find((t) => t.name === name);

// No expenses yet: the tools say so, and where they come from, instead of failing.
{
  const empty = openMoney({ dir: fs.mkdtempSync(path.join(TMP, 'empty-')) });
  const tools = moneyTools({ money: () => empty, today: () => '2026-11-11' });
  const out = await tool(tools, 'spending').execute({});
  assert.match(out, /No expenses recorded yet/);
  assert.match(out, /Money page/);
}

const m = openMoney({ dir: TMP });
const e = (over) => ({ source: 'bcp', kind: 'purchase', currency: 'PEN', fee: null, account: '****6789', note: null, mailDate: null, status: 'pending', ...over });
let n = 0;
const add = (over, category) => {
  n++;
  const { id } = m.addExpense(e({ operation: String(n), messageId: `<${n}>`, merchantKey: (over.merchant ?? '').toLowerCase(), ...over }));
  if (category) m.classify(id, category, { learn: false });
  return id;
};
add({ occurredAt: '2026-10-03T12:00:00-05:00', amount: 3000, merchant: 'Cafe Central' }, 'Comida');
add({ occurredAt: '2026-11-01T09:00:00-05:00', amount: 4550, merchant: 'Cafe Central' }, 'Comida');
add({ occurredAt: '2026-11-02T09:00:00-05:00', amount: 120000, merchant: 'Plaza Vea' }, 'Supermercado');
add({ occurredAt: '2026-11-03T09:00:00-05:00', amount: 2500, merchant: 'Jorge', kind: 'yape_out' });
add({ occurredAt: '2026-11-04T09:00:00-05:00', amount: 999, currency: 'USD', merchant: 'Netflix' }, 'Entretenimiento');
add({ occurredAt: '2026-11-05T09:00:00-05:00', amount: 50000, merchant: 'Ana', kind: 'transfer_in' });
add({ occurredAt: '2026-11-06T09:00:00-05:00', amount: 90000, merchant: null, kind: 'own_transfer' });
add({ occurredAt: '2026-11-07T09:00:00-05:00', amount: 7000, merchant: 'Tienda', kind: 'rejected' });

const tools = moneyTools({ money: () => m, today: () => '2026-11-11' });
assert.deepEqual(tools.map((t) => t.name), ['spending', 'query_expenses']);

// Every provider accepts the schemas (no string formats, flat objects).
for (const t of tools) {
  const s = JSON.stringify(resolveToolSchema(t));
  assert.ok(!/"format"|"(oneOf|anyOf|allOf)"/.test(s), `${t.name}: plain schema`);
}

// The month's spending: totals per currency, by category (not classified named), top merchants, the month before,
// what is waiting, and the dates the records cover. Money received, own transfers and refused purchases never count.
{
  const out = await tool(tools, 'spending').execute({});
  assert.match(out, /^Spending in 2026-11 /m, 'the current month by default');
  assert.match(out, /Total: S\/ 1,270\.50 in 3 expenses; US\$ 9\.99 in 1/, 'per currency, money in and own transfers left out');
  assert.match(out, /Supermercado S\/ 1,200\.00 \(1\)/);
  assert.match(out, /Comida S\/ 45\.50 \(1\)/);
  assert.match(out, /not classified S\/ 25\.00 \(1\)/);
  assert.match(out, /Plaza Vea S\/ 1,200\.00/);
  assert.match(out, /2026-10: S\/ 30\.00 in 1 expense\b/, 'the month before');
  assert.match(out, /Waiting to be classified: 2/);
  assert.match(out, /2026-10-03 to 2026-11-07/, 'the dates the records cover');
  assert.doesNotMatch(out, /Ana|Tienda|900\.00|70\.00|500\.00/, 'nothing that is not spending');

  const oct = await tool(tools, 'spending').execute({ month: '2026-10' });
  assert.match(oct, /^Spending in 2026-10 /m);
  assert.match(oct, /Total: S\/ 30\.00 in 1 expense\b/);
  assert.match(oct, /2026-09: nothing/);

  await assert.rejects(tool(tools, 'spending').execute({ month: 'noviembre' }), /YYYY-MM/);
}

// The query: one read-only SELECT, rows as JSON, the row cap said. Writes are refused and change nothing.
{
  const q = tool(tools, 'query_expenses');
  assert.match(q.description, /amount.*cents/i, 'the description says amounts are in cents');
  assert.match(q.description, /transfer_in.*own_transfer.*rejected/, 'and which kinds are not spending');
  const out = JSON.parse(await q.execute({ sql: "SELECT merchant, amount FROM expenses WHERE category = 'Comida' ORDER BY occurred_at" }));
  assert.deepEqual(out.rows, [{ merchant: 'Cafe Central', amount: 3000 }, { merchant: 'Cafe Central', amount: 4550 }]);
  assert.equal(out.truncated, false);
  const many = JSON.parse(await q.execute({ sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 500) SELECT x FROM c' }));
  assert.equal(many.rows.length, 100, 'at most 100 rows');
  assert.equal(many.truncated, true);
  const count = () => m.db.prepare('SELECT COUNT(*) AS c FROM expenses').get().c;
  const before = count();
  await assert.rejects(q.execute({ sql: 'DELETE FROM expenses' }), /SELECT/);
  await assert.rejects(q.execute({ sql: "SELECT 1; UPDATE expenses SET amount = 0" }), /one statement/);
  assert.equal(count(), before, 'nothing changed');
}

// The store opens on first use, not when the tools are made (no mail account, no database file).
{
  let opened = 0;
  moneyTools({ money: () => { opened++; return m; } });
  assert.equal(opened, 0);
}

console.log('money tools: ok');
