// The panel's Money page, sidecar side (money/panel.mjs): the movements table with its filters, paging and totals,
// and the changes made there, through the same operations as the agent's tools (money/ops.mjs): unprotected ones
// apply, protected ones ask authorize(reason) and change nothing unless it says true. Everything the page sends is
// checked. Throwaway data folder. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMoney } from '../money.mjs';
import { moneyPanel } from '../money/panel.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-money-panel-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const failed = [];
const rule = async (name, fn) => { try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed.push(name); console.error(`FAILED: ${name}\n  ${String(e?.stack ?? e).split('\n').slice(0, 8).join('\n  ')}`); } };

// An empty database: the page works, and says there is nothing.
await rule('an empty database lists nothing, with no months and the default categories', async () => {
  const empty = openMoney({ dir: fs.mkdtempSync(path.join(TMP, 'empty-')) });
  const r = await moneyPanel({ money: () => empty, today: () => '2026-11-11' }).handle({ op: 'list' });
  assert.equal(r.ok, true);
  assert.deepEqual({ rows: r.view.rows, total: r.view.total, months: r.view.months, totals: r.view.totals, own: r.view.own }, { rows: [], total: 0, months: [], totals: [], own: [] });
  assert.ok(r.view.categories.includes('Comida'));
});

const m = openMoney({ dir: TMP });
const e = (over) => ({ source: 'bcp', kind: 'purchase', currency: 'PEN', fee: null, account: '****6789', note: null, mailDate: null, status: 'pending', ...over });
let n = 0;
const add = (over, category) => {
  n++;
  const { id } = m.addExpense(e({ operation: String(n), messageId: `<${n}>`, merchantKey: (over.merchant ?? '').toLowerCase(), ...over }));
  if (category) m.classify(id, category, { learn: false });
  return id;
};
const cafeOct = add({ occurredAt: '2026-10-03T12:00:00-05:00', amount: 3000, merchant: 'Cafe Central' }, 'Comida');
const cafe = add({ occurredAt: '2026-11-01T09:00:00-05:00', amount: 4550, merchant: 'Cafe Central' }, 'Comida');
const plaza = add({ occurredAt: '2026-11-02T09:00:00-05:00', amount: 120000, merchant: 'Plaza Vea' }, 'Supermercado');
const jorge = add({ occurredAt: '2026-11-03T09:00:00-05:00', amount: 2500, merchant: 'Jorge', kind: 'yape_out' });
add({ occurredAt: '2026-11-04T09:00:00-05:00', amount: 999, currency: 'USD', merchant: 'Netflix' }, 'Entretenimiento');
add({ occurredAt: '2026-11-05T09:00:00-05:00', amount: 50000, merchant: 'Ana', kind: 'transfer_in' });
add({ occurredAt: '2026-11-07T09:00:00-05:00', amount: 7000, merchant: 'Tienda', kind: 'rejected' });
const review = add({ occurredAt: '2026-11-08T09:00:00-05:00', amount: 1500, merchant: 'Bodega Sol', status: 'needs_review' });

let answer = true;
const asked = [];
const authorize = async (reason) => { asked.push(reason); if (answer instanceof Error) throw answer; return answer; };
const panel = moneyPanel({ money: () => m, today: () => '2026-11-11', authorize });
const list = async (query) => { const r = await panel.handle({ op: 'list', query }); assert.equal(r.ok, true, r.text); return r.view; };
const everything = () => JSON.stringify([m.db.prepare('SELECT * FROM expenses ORDER BY id').all(), m.db.prepare('SELECT * FROM categories ORDER BY name').all(),
  m.db.prepare('SELECT * FROM rules ORDER BY merchant_key').all(), m.db.prepare('SELECT * FROM own_accounts ORDER BY merchant_key').all()]);
const row = (id) => m.expense(id);

await rule('the list: every movement newest first, each in plain words, amounts as the tools say them', async () => {
  const v = await list({});
  assert.equal(v.total, 8);
  assert.deepEqual(v.rows.map((r) => r.id), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(v.months, ['2026-11', '2026-10']);
  const by = Object.fromEntries(v.rows.map((r) => [r.id, r]));
  assert.deepEqual({ ...by[plaza] }, { ...by[plaza], date: '2026-11-02', text: 'Plaza Vea', source: 'BCP', kind: 'Purchase', amount: 'S/ 1,200.00', category: 'Supermercado', status: 'Classified', classifiable: true, manual: false, own: null });
  assert.equal(by[jorge].kind, 'Yape'); assert.equal(by[jorge].status, 'Waiting'); assert.equal(by[jorge].own, 'jorge', 'a transfer can be marked as the user\'s own');
  assert.equal(by[6].kind, 'Received'); assert.equal(by[6].status, 'Income'); assert.equal(by[6].classifiable, false);
  assert.equal(by[7].kind, 'Refused'); assert.equal(by[7].status, 'Not counted');
  assert.equal(by[review].status, 'Needs review');
  assert.equal(by[5].amount, 'US$ 9.99');
});

await rule('filters: month, category, not classified, spending / income / not counted, and text', async () => {
  assert.deepEqual((await list({ month: '2026-10' })).rows.map((r) => r.id), [cafeOct]);
  assert.deepEqual((await list({ category: 'comida' })).rows.map((r) => r.id), [cafe, cafeOct], 'the category, in any case');
  assert.deepEqual((await list({ category: null })).rows.map((r) => r.id), [review, jorge], 'not classified: expenses only');
  assert.deepEqual((await list({ group: 'spending' })).rows.map((r) => r.id), [review, 5, jorge, plaza, cafe, cafeOct]);
  assert.deepEqual((await list({ group: 'income' })).rows.map((r) => r.id), [6]);
  assert.deepEqual((await list({ group: 'other' })).rows.map((r) => r.id), [7]);
  assert.deepEqual((await list({ text: 'cafe' })).rows.map((r) => r.id), [cafe, cafeOct], 'full-text, accent-insensitive prefix');
  assert.deepEqual((await list({ text: 'café cen', month: '2026-11' })).rows.map((r) => r.id), [cafe], 'filters combine');
  assert.deepEqual((await list({ text: '***' })).rows, [], 'no words: nothing matches');
});

await rule('paging: per rows a page, the page asked for, and the count of all', async () => {
  const p0 = await list({ per: 3, page: 0 }), p2 = await list({ per: 3, page: 2 });
  assert.deepEqual([p0.rows.length, p0.total, p0.pages, p0.page], [3, 8, 3, 0]);
  assert.deepEqual(p2.rows.map((r) => r.id), [2, 1]);
  assert.equal((await list({ per: 3, page: 9 })).page, 2, 'past the end: the last page');
  assert.equal((await list({})).per, 50, '50 a page unless asked');
});

await rule('totals of the filtered view per currency: spent and received, never what is not counted', async () => {
  assert.deepEqual((await list({ month: '2026-11' })).totals, [
    { currency: 'PEN', spent: 'S/ 1,285.50', received: 'S/ 500.00', count: 6 },
    { currency: 'USD', spent: 'US$ 9.99', received: 'US$ 0.00', count: 1 },
  ]);
  assert.deepEqual((await list({ category: 'Comida' })).totals, [{ currency: 'PEN', spent: 'S/ 75.50', received: 'S/ 0.00', count: 2 }]);
});

await rule('classify: rows with no category go straight in, nothing asked', async () => {
  asked.length = 0;
  const r = await panel.handle({ op: 'classify', ids: [jorge], category: 'Transferencias', query: {} });
  assert.equal(r.ok, true); assert.match(r.text, /Put 1 expense in Transferencias/);
  assert.equal(row(jorge).category, 'Transferencias'); assert.equal(asked.length, 0);
  assert.equal(r.view.rows.find((x) => x.id === jorge).category, 'Transferencias', 'the fresh list comes back');
});

await rule('classify into a new category made from the same control', async () => {
  const r = await panel.handle({ op: 'classify', ids: [review], category: 'Mascotas', create: true });
  assert.equal(r.ok, true, r.text);
  assert.ok(m.categories().includes('Mascotas')); assert.equal(row(review).category, 'Mascotas');
});

// Each protected change: refused (false, a throw, no authorize) → nothing changed and said; true → applied.
const PROTECTED = [
  ['change a category', { op: 'classify', ids: [plaza], category: 'Otros' }, /Change the category/, () => row(plaza).category === 'Otros'],
  ['remove a category', { op: 'unclassify', ids: [cafe] }, /Remove the category/, () => row(cafe).category === null],
  ['rename a category', { op: 'rename_category', from: 'Mascotas', to: 'Animales' }, /Rename the category "Mascotas"/, () => m.categories().includes('Animales')],
  ['delete a category', { op: 'delete_category', name: 'Animales' }, /Delete the category "Animales"/, () => !m.categories().includes('Animales')],
];
for (const [what, msg, reason, done] of PROTECTED) {
  await rule(`protected: ${what} asks first; refused, nothing changes`, async () => {
    for (const [a, why] of [[false, 'says no'], [new Error('gone'), 'throws']]) {
      answer = a; asked.length = 0;
      const before = everything();
      const r = await panel.handle(msg);
      assert.equal(r.ok, false, `${why}: not ok`); assert.match(r.text, /^Not changed/);
      assert.equal(everything(), before, `${why}: nothing changed`);
      assert.equal(asked.length, 1); assert.match(asked[0], reason);
    }
    const before = everything();
    const bare = await moneyPanel({ money: () => m, today: () => '2026-11-11' }).handle(msg);
    assert.equal(bare.ok, false); assert.equal(everything(), before, 'no authorize: nothing changed');
    answer = true; asked.length = 0;
    const r = await panel.handle(msg);
    assert.equal(r.ok, true, r.text); assert.equal(asked.length, 1); assert.ok(done(), 'applied once confirmed');
  });
}

await rule('a change that removes the category the table is filtered by: the table comes back unfiltered, and says so', async () => {
  m.addCategory('Temporal');
  answer = true;
  const r = await panel.handle({ op: 'delete_category', name: 'Temporal', query: { category: 'Temporal', per: 3 } });
  assert.equal(r.ok, true, r.text); assert.equal(r.view.dropped, 'Temporal');
  assert.equal('category' in r.view.query, false); assert.equal(r.view.per, 3); assert.ok(r.view.total > 0);
});

await rule('add by hand: an expense (PEN and today unless said, its category) and an income', async () => {
  asked.length = 0;
  const r = await panel.handle({ op: 'add_entry', kind: 'expense', amount: '20.50', description: ' Taxi ', category: 'Transporte' });
  assert.equal(r.ok, true, r.text); assert.match(r.text, /Added expense #\d+: S\/ 20\.50 Taxi on 2026-11-11, in Transporte/);
  const taxi = m.db.prepare("SELECT * FROM expenses WHERE merchant = 'Taxi'").get();
  assert.deepEqual([taxi.source, taxi.kind, taxi.amount, taxi.currency, taxi.category], ['manual', 'purchase', 2050, 'PEN', 'Transporte']);
  const i = await panel.handle({ op: 'add_entry', kind: 'income', amount: '3000', currency: 'USD', date: '2026-11-01', description: 'Sueldo' });
  assert.equal(i.ok, true, i.text);
  const pay = m.db.prepare("SELECT * FROM expenses WHERE merchant = 'Sueldo'").get();
  assert.deepEqual([pay.kind, pay.amount, pay.currency, pay.occurred_at.slice(0, 10)], ['income', 300000, 'USD', '2026-11-01']);
  assert.equal(asked.length, 0);
});

await rule('delete an entry added by hand: protected, and only those', async () => {
  const id = m.db.prepare("SELECT id FROM expenses WHERE merchant = 'Taxi'").get().id;
  answer = false;
  assert.equal((await panel.handle({ op: 'delete_entry', id })).ok, false); assert.ok(row(id));
  answer = true;
  assert.equal((await panel.handle({ op: 'delete_entry', id })).ok, true); assert.equal(row(id), undefined);
  const mailRow = await panel.handle({ op: 'delete_entry', id: plaza });
  assert.equal(mailRow.ok, false); assert.match(mailRow.text, /bank mail/); assert.ok(row(plaza));
});

await rule('own accounts: mark a transfer\'s recipient (no classified ones: nothing asked), listed, unmark asks', async () => {
  const ana = add({ occurredAt: '2026-11-09T09:00:00-05:00', amount: 10000, merchant: 'Ana Lopez', kind: 'transfer_out' });
  asked.length = 0;
  const r = await panel.handle({ op: 'own', action: 'mark', key: 'ana lopez' });
  assert.equal(r.ok, true, r.text); assert.equal(asked.length, 0); assert.equal(row(ana).kind, 'own_transfer');
  assert.deepEqual(r.view.own.map((o) => [o.key, o.name, o.count]), [['ana lopez', 'Ana Lopez', 1]]);
  assert.equal(r.view.rows.find((x) => x.id === ana).kind, 'Own transfer');
  answer = false;
  assert.equal((await panel.handle({ op: 'own', action: 'unmark', key: 'ana lopez' })).ok, false); assert.equal(row(ana).kind, 'own_transfer');
  answer = true;
  assert.equal((await panel.handle({ op: 'own', action: 'unmark', key: 'ana lopez' })).ok, true); assert.equal(row(ana).kind, 'transfer_out');
});

await rule('what the page sends is checked: wrong types, lengths, months, ids and actions change nothing', async () => {
  const before = everything();
  for (const bad of [
    null, 'list', { op: 'nope' }, { op: 'list', query: { month: '2026-13' } }, { op: 'list', query: { month: 202611 } }, { op: 'list', query: { group: 'all of it' } },
    { op: 'list', query: { per: 500 } }, { op: 'list', query: { page: -1 } }, { op: 'list', query: { text: 'x'.repeat(201) } }, { op: 'list', query: { category: 'Nada' } },
    { op: 'list', query: { extra: 1 } }, { op: 'classify', ids: [], category: 'Comida' }, { op: 'classify', ids: ['1'], category: 'Comida' }, { op: 'classify', ids: [99999], category: 'Comida' },
    { op: 'classify', ids: [jorge], category: 'x'.repeat(41) }, { op: 'classify', ids: [jorge], category: 'Nada' }, { op: 'classify', ids: [6], category: 'Comida' },
    { op: 'add_entry', kind: 'expense', amount: '-5', description: 'x' }, { op: 'add_entry', kind: 'expense', amount: 'abc', description: 'x' },
    { op: 'add_entry', kind: 'expense', amount: '5', description: '' }, { op: 'add_entry', kind: 'expense', amount: '5', description: 'x', date: '2026-02-30' },
    { op: 'add_entry', kind: 'expense', amount: '5', description: 'x', currency: 'EUR' }, { op: 'add_entry', kind: 'gift', amount: '5', description: 'x' },
    { op: 'add_entry', kind: 'income', amount: '5', description: 'x', category: 'Comida' }, { op: 'add_entry', kind: 'expense', amount: '1000000000', description: 'x' },
    { op: 'delete_entry', id: 'x' }, { op: 'own', action: 'steal', key: 'jorge' }, { op: 'own', action: 'unmark', key: 'jorge' }, { op: 'rename_category', from: 'Comida', to: '' },
  ]) {
    const r = await panel.handle(bad);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.equal(typeof r.text, 'string');
  }
  assert.equal(everything(), before);
});

if (failed.length) { console.error(`${failed.length} failed`); process.exit(1); }
console.log('money panel actions: ok');
