// Money questions: the read-only query (one SELECT, no writes, row and time limits) and the ready summaries.
// Runs in a throwaway data folder. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSelect } from '../money/query.mjs';
import { openMoney } from '../money.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-money-query-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const m = openMoney({ dir: TMP });

const e = (over) => ({
  source: 'falabella', kind: 'purchase', currency: 'PEN', fee: null, account: '****6789', note: null, mailDate: null, status: 'pending', ...over,
});
const add = (over, category) => { const { id } = m.addExpense(e(over)); if (category) m.classify(id, category, { learn: false }); return id; };
add({ occurredAt: '2026-10-03T12:00:00-05:00', amount: 3000, merchant: 'Cafe Central', merchantKey: 'cafe central', operation: '1', messageId: '<1>' }, 'Comida');
add({ occurredAt: '2026-10-20T12:00:00-05:00', amount: 12000, merchant: 'Plaza Vea', merchantKey: 'plaza vea', operation: '2', messageId: '<2>' }, 'Supermercado');
add({ occurredAt: '2026-11-01T00:30:00-05:00', amount: 4500, merchant: 'Cafe Central', merchantKey: 'cafe central', operation: '3', messageId: '<3>' }, 'Comida');
add({ occurredAt: '2026-11-05T13:00:00-05:00', amount: 1500, merchant: 'Cafe Central', merchantKey: 'cafe central', operation: '4', messageId: '<4>' }, 'Comida');
add({ occurredAt: '2026-11-06T19:05:00-05:00', amount: 2500, merchant: 'Jorge', merchantKey: 'jorge', operation: '5', messageId: '<5>', kind: 'yape_out' });
add({ occurredAt: '2026-11-07T10:00:00-05:00', amount: 999, currency: 'USD', merchant: 'Netflix', merchantKey: 'netflix', operation: '6', messageId: '<6>' }, 'Entretenimiento');
add({ occurredAt: '2026-11-08T10:00:00-05:00', amount: 50000, merchant: 'Sueldo', merchantKey: 'sueldo', operation: '7', messageId: '<7>', kind: 'transfer_in' });
add({ occurredAt: '2026-11-09T10:00:00-05:00', amount: 125000, merchant: null, merchantKey: '', operation: '8', messageId: '<8>', kind: 'own_transfer' });
add({ occurredAt: '2026-11-09T11:00:00-05:00', amount: 1599, currency: 'USD', merchant: 'Netflix', merchantKey: 'netflix', operation: null, messageId: '<9>', kind: 'rejected' });
// Even classified by hand, they never count: the kind decides.
m.classify(add({ occurredAt: '2026-11-09T12:00:00-05:00', amount: 7000, merchant: null, merchantKey: '', operation: '10', messageId: '<10>', kind: 'own_transfer' }), 'Otros', { learn: false });
const before = fs.readFileSync(path.join(TMP, 'money.db'));

// A plain SELECT answers exactly.
assert.deepEqual(await m.query("SELECT category, SUM(amount) AS total FROM expenses WHERE category = 'Comida'"), {
  columns: ['category', 'total'], rows: [{ category: 'Comida', total: 9000 }], truncated: false,
});
assert.deepEqual((await m.query("SELECT ';' AS semi -- a comment; DROP TABLE expenses\n;")).rows, [{ semi: ';' }], 'semicolons in strings and comments');
assert.equal((await m.query('WITH c AS (SELECT 1 AS n) SELECT n FROM c')).rows[0].n, 1);

// Refused before running: anything but one SELECT/WITH statement.
for (const [sql, why] of [
  ['DELETE FROM expenses', /only SELECT/],
  ["UPDATE expenses SET amount = 0", /only SELECT/],
  ["ATTACH DATABASE 'x.db' AS x", /only SELECT/],
  ['PRAGMA user_version = 5', /only SELECT/],
  ['SELECT 1; DELETE FROM expenses', /one statement/],
  ["SELECT 1; ATTACH DATABASE 'x.db' AS x", /one statement/],
  ['', /empty/],
]) {
  assert.match(checkSelect(sql) ?? '', why, sql);
  await assert.rejects(m.query(sql), why, sql);
}
// Refused while compiling: writes hidden in a WITH, pragmas through table functions.
await assert.rejects(m.query('WITH x AS (SELECT 1) DELETE FROM expenses'), /not authorized|readonly/i);
await assert.rejects(m.query("WITH x AS (SELECT 1) INSERT INTO categories VALUES ('X', 99, '')"), /not authorized|readonly/i);
await assert.rejects(m.query("SELECT * FROM pragma_table_info('expenses')"), /not authorized/i);
assert.deepEqual(fs.readFileSync(path.join(TMP, 'money.db')), before, 'the database is untouched');

// Row and time limits.
const many = await m.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 1000) SELECT x FROM c', { maxRows: 10 });
assert.deepEqual([many.rows.length, many.truncated], [10, true]);
const t0 = Date.now();
await assert.rejects(m.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', { timeoutMs: 400 }), /longer than/);
assert.ok(Date.now() - t0 < 5000, 'stopped, not waited out');

// Ready summaries: spending only (no money received or moved between own accounts, no refused purchase, nothing
// ignored), per currency, by Lima calendar month.
assert.deepEqual(m.totalsByCategory('2026-11'), [
  { category: 'Comida', currency: 'PEN', total: 6000, count: 2 },
  { category: null, currency: 'PEN', total: 2500, count: 1 },
  { category: 'Entretenimiento', currency: 'USD', total: 999, count: 1 },
]);
assert.deepEqual(m.totalsByMerchant('2026-11').slice(0, 2), [
  { merchant_key: 'cafe central', merchant: 'Cafe Central', currency: 'PEN', total: 6000, count: 2 },
  { merchant_key: 'jorge', merchant: 'Jorge', currency: 'PEN', total: 2500, count: 1 },
]);
assert.deepEqual(m.compareMonths('2026-11'), {
  month: '2026-11', previous: '2026-10',
  current: [{ currency: 'PEN', total: 8500, count: 3 }, { currency: 'USD', total: 999, count: 1 }],
  before: [{ currency: 'PEN', total: 15000, count: 2 }],
});
assert.equal(m.compareMonths('2026-01').previous, '2025-12');

// Balance: income (money received by mail, and income added by hand) minus spending, per currency, with the parts.
add({ occurredAt: '2026-11-10T09:00:00-05:00', amount: 350000, merchant: 'Sueldo', merchantKey: 'sueldo', operation: null, messageId: null, source: 'manual', kind: 'income', status: 'classified' });
assert.deepEqual(m.balance('2026-11'), [
  { currency: 'PEN', income: 400000, income_count: 2, spending: 8500, spending_count: 3, balance: 391500 },
  { currency: 'USD', income: 0, income_count: 0, spending: 999, spending_count: 1, balance: -999 },
]);
assert.deepEqual(m.balance('2026-10'), [{ currency: 'PEN', income: 0, income_count: 0, spending: 15000, spending_count: 2, balance: -15000 }]);
assert.deepEqual(m.balance('2026-09'), []);
assert.deepEqual(m.compareMonths('2026-11').current, [{ currency: 'PEN', total: 8500, count: 3 }, { currency: 'USD', total: 999, count: 1 }], 'income is not spending');
assert.throws(() => m.balance('noviembre'), /month/);
assert.throws(() => m.totalsByCategory('noviembre'), /month/);

m.close();
console.log('money-query: ok');
