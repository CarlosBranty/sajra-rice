// The agent's money tools: the month's spending and balance, the read-only query, categories, classifying, own
// accounts, entries added by hand, and the operations that need the user's confirmation. Throwaway data folder.
// Run: npm test
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

// authorize(reason) answers what `answer` holds: true, false, or an error to throw; every reason asked is kept.
let answer = true;
const asked = [];
const authorize = async (reason) => { asked.push(reason); if (answer instanceof Error) throw answer; return answer; };
const tools = moneyTools({ money: () => m, today: () => '2026-11-11', authorize });
assert.deepEqual(tools.map((t) => t.name), ['spending', 'balance', 'query_expenses', 'categories', 'add_category', 'rename_category', 'delete_category',
  'next_pending_expenses', 'classify_expenses', 'unclassify_expenses', 'add_expense', 'add_income', 'delete_entry', 'own_accounts', 'edit_entry', 'period_balance']);

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
  assert.match(out, /Waiting to be classified: 1/, 'money received is not waiting');
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

const run = (name, args = {}) => tool(tools, name).execute(args);
const row = (id) => ({ ...m.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) });
const ruleOf = (key) => m.db.prepare('SELECT category, origin FROM rules WHERE merchant_key = ?').get(key);
const idOf = (merchant) => m.db.prepare('SELECT id FROM expenses WHERE merchant = ? ORDER BY id').get(merchant).id;
const everything = () => JSON.stringify(['expenses', 'categories', 'rules', 'own_accounts'].map((t) => m.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
// A protected operation: refused and nothing changed when authorize says no, throws or is missing (no authorize
// asked for then); applied when it says yes, after one question whose reason names the change.
async function guarded(name, args, reason, check) {
  for (const [why, a] of [['says no', false], ['throws', new Error('cancelled')]]) {
    answer = a;
    asked.length = 0;
    const before = everything();
    assert.match(await run(name, args), /^Not changed/, `${name}: authorize ${why}`);
    assert.equal(everything(), before, `${name}: nothing changed when authorize ${why}`);
    assert.equal(asked.length, 1);
    assert.match(asked[0], reason, `${name}: the reason names the change`);
  }
  const before = everything();
  assert.match(await tool(moneyTools({ money: () => m, today: () => '2026-11-11' }), name).execute(args), /^Not changed/, `${name}: no authorize`);
  assert.equal(everything(), before, `${name}: nothing changed without authorize`);
  answer = true;
  asked.length = 0;
  const out = await run(name, args);
  assert.deepEqual(asked.length, 1, `${name}: asked once`);
  check(out);
  answer = true;
}
// An operation that needs no confirmation never asks.
async function free(name, args) {
  asked.length = 0;
  const out = await run(name, args);
  assert.equal(asked.length, 0, `${name}: no confirmation asked`);
  return out;
}

// Categories: the defaults are listed with how many expenses each holds; a new one is added without confirmation.
{
  const out = await free('categories');
  assert.match(out, /Comida \(2\), Supermercado \(1\), Transporte \(0\),/);
  assert.match(out, /Entretenimiento \(1\)/);
  assert.match(out, /Otros \(0\)/);
  assert.match(await free('add_category', { name: 'Mascotas' }), /Added the category "Mascotas"/);
  assert.equal(m.categories().at(-1), 'Mascotas');
  await assert.rejects(run('add_category', { name: 'mascotas' }), /exists/);
}

// The pending expenses one by one, oldest first, with the suggested category; money received is never offered.
{
  const jorge = idOf('Jorge');
  const second = add({ occurredAt: '2026-11-08T09:00:00-05:00', amount: 1800, merchant: 'Cafe Central' });
  m.setRule('Cafe Central', 'Comida');
  const first = await free('next_pending_expenses');
  assert.match(first, new RegExp(`#${jorge}\\b.*2026-11-03.*S/ 25\\.00.*Jorge`));
  assert.doesNotMatch(first, /Ana|Cafe Central/, 'one at a time, no money received');
  assert.match(first, /2 waiting/);
  const next = await free('next_pending_expenses', { after_id: jorge });
  assert.match(next, new RegExp(`#${second}\\b.*S/ 18\\.00.*Cafe Central.*suggested: Comida`));
  assert.match(await free('next_pending_expenses', { after_id: second }), /No more/);
  assert.match(await free('next_pending_expenses', { count: 5 }), new RegExp(`#${jorge}\\b[\\s\\S]*#${second}\\b`));
}

// Classifying: an expense with no category needs no confirmation and teaches the merchant's rule (unless told not to).
{
  const jorge = idOf('Jorge');
  assert.match(await free('classify_expenses', { category: 'transferencias', ids: [jorge], learn: false }), /1 expense.*Transferencias/);
  assert.deepEqual([row(jorge).category, row(jorge).status], ['Transferencias', 'classified']);
  assert.equal(ruleOf('jorge'), undefined, 'learn: false');
  const taxi = add({ occurredAt: '2026-11-09T09:00:00-05:00', amount: 1500, merchant: 'Taxi Seguro' });
  const taxi2 = add({ occurredAt: '2026-11-09T19:00:00-05:00', amount: 1200, merchant: 'Taxi Seguro' });
  assert.match(await free('classify_expenses', { category: 'Transporte', merchant: 'Taxi Seguro' }), /2 expenses.*Transporte/);
  assert.deepEqual([row(taxi).category, row(taxi2).category], ['Transporte', 'Transporte']);
  assert.deepEqual({ ...ruleOf('taxi seguro') }, { category: 'Transporte', origin: 'learned' }, 'the rule learned');
  await assert.rejects(run('classify_expenses', { category: 'Casino', ids: [taxi] }), /unknown category/);
  await assert.rejects(run('classify_expenses', { category: 'Otros', ids: [idOf('Ana')] }), /not an expense/, 'money received is not classified');
  await assert.rejects(run('classify_expenses', { category: 'Otros' }), /ids or a merchant/);
  assert.match(await free('classify_expenses', { category: 'Transporte', ids: [taxi] }), /already/, 'nothing to change, nothing asked');
  // Changing the category of an expense that has one is protected; the reason names the expense and both categories.
  const plaza = idOf('Plaza Vea');
  await guarded('classify_expenses', { category: 'Compras', ids: [plaza, taxi], learn: false }, new RegExp(`#${plaza}.*Plaza Vea.*from Supermercado.*Compras`), (out) => {
    assert.match(out, /2 expenses.*Compras/);
    assert.deepEqual([row(plaza).category, row(taxi).category], ['Compras', 'Compras']);
  });
  // Removing a classification is protected too: the expense waits again; rules stay.
  await guarded('unclassify_expenses', { ids: [taxi2] }, new RegExp(`#${taxi2}.*Taxi Seguro.*Transporte`), (out) => {
    assert.match(out, /1 expense/);
    assert.deepEqual([row(taxi2).category, row(taxi2).status], [null, 'pending']);
  });
  assert.match(await free('unclassify_expenses', { ids: [taxi2] }), /no category/, 'nothing to remove, nothing asked');
}

// What is applied is what was authorized: a change made while the user is asked refuses the operation.
{
  const plaza = idOf('Plaza Vea');
  const sneaky = moneyTools({ money: () => m, today: () => '2026-11-11', authorize: async () => { m.classify(plaza, 'Otros', { learn: false }); return true; } });
  assert.match(await tool(sneaky, 'classify_expenses').execute({ category: 'Supermercado', ids: [plaza] }), /^Not changed.*changed/);
  assert.equal(row(plaza).category, 'Otros', 'the change made meanwhile stays, the authorized one is not applied');
  const renamer = moneyTools({ money: () => m, today: () => '2026-11-11', authorize: async () => { m.addCategory('Gatos'); return true; } });
  assert.match(await tool(renamer, 'rename_category').execute({ from: 'Mascotas', to: 'Gatos' }), /^Not changed/);
  assert.deepEqual(m.categories().slice(-2), ['Mascotas', 'Gatos']);
}

// Renaming and deleting a category are protected. Deleting sends its expenses back to waiting and removes its rules.
{
  const taxi = m.db.prepare("SELECT id FROM expenses WHERE merchant = 'Taxi Seguro' AND category IS NULL").get().id;
  m.classify(taxi, 'Transporte', { learn: false });
  await guarded('rename_category', { from: 'transporte', to: 'Movilidad' }, /Rename the category "Transporte" to "Movilidad"/, (out) => {
    assert.match(out, /Renamed "Transporte" to "Movilidad"/);
    assert.ok(m.categories().includes('Movilidad') && !m.categories().includes('Transporte'));
    assert.equal(ruleOf('taxi seguro').category, 'Movilidad', 'rules follow');
  });
  await assert.rejects(run('rename_category', { from: 'Nada', to: 'Algo' }), /unknown category/);
  await guarded('delete_category', { name: 'Movilidad' }, /Delete the category "Movilidad".*1 expense.*1 rule/, (out) => {
    assert.match(out, /Deleted "Movilidad"/);
    assert.equal(m.categories().includes('Movilidad'), false);
    assert.deepEqual([row(taxi).category, row(taxi).status], [null, 'pending'], 'waits to be classified again');
    assert.equal(ruleOf('taxi seguro'), undefined);
  });
}

// Entries added by hand: an expense (PEN and today by default) counts like any other; with a category it arrives
// classified. Income added by hand counts in the balance, never as spending. Neither needs confirmation.
{
  const before = (await run('spending')).match(/Total: (.*)/)[1];
  const out = await free('add_expense', { amount: 20, description: 'Taxi a casa' });
  const id = Number(out.match(/#(\d+)/)[1]);
  const e = row(id);
  assert.deepEqual([e.source, e.kind, e.amount, e.currency, e.merchant, e.message_id, e.status, e.category], ['manual', 'purchase', 2000, 'PEN', 'Taxi a casa', null, 'pending', null]);
  assert.match(e.occurred_at, /^2026-11-11T\d\d:\d\d:\d\d[+-]\d\d:\d\d$/, 'today, local time with offset');
  assert.notEqual((await run('spending')).match(/Total: (.*)/)[1], before);
  assert.match(await run('spending'), /Total: S\/ 1,335\.50 in 7 expenses/);
  const lunch = Number((await free('add_expense', { amount: 12.5, currency: 'USD', description: 'Almuerzo', date: '2026-10-30', category: 'comida' })).match(/#(\d+)/)[1]);
  assert.deepEqual([row(lunch).amount, row(lunch).currency, row(lunch).occurred_at.slice(0, 10), row(lunch).category, row(lunch).status], [1250, 'USD', '2026-10-30', 'Comida', 'classified']);
  const n = m.db.prepare('SELECT count(*) AS n FROM expenses').get().n;
  await assert.rejects(run('add_expense', { amount: 5, description: 'x', category: 'Casino' }), /unknown category/);
  await assert.rejects(run('add_expense', { amount: 5, description: 'x', date: '2026-02-30' }), /date/);
  assert.equal(m.db.prepare('SELECT count(*) AS n FROM expenses').get().n, n, 'nothing added on an error');
  const salary = Number((await free('add_income', { amount: 3500, description: 'Sueldo' })).match(/#(\d+)/)[1]);
  assert.deepEqual([row(salary).source, row(salary).kind, row(salary).amount, row(salary).currency, row(salary).occurred_at.slice(0, 10)], ['manual', 'income', 350000, 'PEN', '2026-11-11']);
  assert.match(await run('spending'), /Total: S\/ 1,335\.50 in 7 expenses/, 'income is not spending');
  // The balance: income (received by mail and added) minus spending, per currency.
  const bal = await free('balance');
  assert.match(bal, /^Balance in 2026-11/m);
  assert.match(bal, /PEN: income S\/ 4,000\.00 \(2\) - spending S\/ 1,335\.50 \(7\) = S\/ 2,664\.50/);
  assert.match(bal, /USD: income US\$ 0\.00 \(0\) - spending US\$ 9\.99 \(1\) = US\$ -9\.99/);
  assert.match(await run('balance', { month: '2026-10' }), /USD: income US\$ 0\.00 \(0\) - spending US\$ 12\.50 \(1\) = US\$ -12\.50/);
  assert.match(await run('balance', { month: '2026-01' }), /nothing/);
  // Deleting an entry added by hand is protected; mail entries are never deleted.
  await guarded('delete_entry', { id: salary }, new RegExp(`#${salary}.*Sueldo.*S/ 3,500\\.00`), (o) => {
    assert.match(o, /Deleted/);
    assert.equal(m.db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(salary), undefined);
  });
  asked.length = 0;
  await assert.rejects(run('delete_entry', { id: idOf('Plaza Vea') }), /added by hand/);
  assert.equal(asked.length, 0);
}

// Own accounts: marking a recipient whose transfers have no category needs no confirmation; their transfers stop
// counting. Marking one with classified transfers, and unmarking, are protected.
{
  const rosa = add({ occurredAt: '2026-11-10T09:00:00-05:00', amount: 30000, merchant: 'Rosa Q', kind: 'transfer_out' });
  const spentBefore = await run('spending');
  assert.match(spentBefore, /Total: S\/ 1,635\.50 in 8 expenses/);
  assert.match(await free('own_accounts', { action: 'list' }), /No own accounts/);
  assert.match(await free('own_accounts', { action: 'mark', merchant: 'Rosa Q' }), /1 transfer/);
  assert.equal(row(rosa).kind, 'own_transfer');
  assert.match(await run('spending'), /Total: S\/ 1,335\.50 in 7 expenses/, 'no longer spending');
  assert.match(await free('own_accounts', { action: 'list' }), /Rosa Q \(1 transfer\)/);
  await guarded('own_accounts', { action: 'unmark', merchant: 'Rosa Q' }, /Rosa Q.*1 transfer/, (o) => {
    assert.match(o, /Unmarked/);
    assert.equal(row(rosa).kind, 'transfer_out');
  });
  const jorge = idOf('Jorge');
  await guarded('own_accounts', { action: 'mark', merchant: 'Jorge' }, /Jorge.*1 transfer.*1 .*classified/, (o) => {
    assert.match(o, /Marked/);
    assert.deepEqual([row(jorge).kind, row(jorge).status, row(jorge).own_from], ['own_transfer', 'ignored', 'yape_out']);
  });
  await assert.rejects(run('own_accounts', { action: 'mark' }), /merchant/);
}

// The query's description follows the schema: income, own_from, entries added by hand.
assert.match(tool(tools, 'query_expenses').description, /income/);
assert.match(tool(tools, 'query_expenses').description, /own_from/);
assert.match(tool(tools, 'query_expenses').description, /manual/);

console.log('money tools: ok');
