// Money S12: schema v4 (salary, original, edited_at) with a backup before migrating, editing and reverting entries
// (protected for those read from bank mails), salary marks, pay periods with carry-over, the overview the native
// panel draws, and the agent's tools for them. Throwaway data folders, synthetic data. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMoney } from '../money.mjs';
import { moneyOps } from '../money/ops.mjs';
import { moneyPanel } from '../money/panel.mjs';
import { periodsFor } from '../money/periods.mjs';
import { MIGRATIONS } from '../money/store.mjs';
import { moneyTools } from '../money/tools.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-money-edit-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const failed = [];
const rule = async (name, fn) => { try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed.push(name); console.error(`FAILED: ${name}\n  ${String(e?.stack ?? e).split('\n').slice(0, 8).join('\n  ')}`); } };
const plain = (rows) => rows.map((r) => ({ ...r }));
const fresh = (name) => { const dir = path.join(TMP, name); fs.mkdirSync(dir); return dir; };

// A database at schema 3, made by the migrations this code ships.
function v3(dir) {
  const db = new DatabaseSync(path.join(dir, 'money.db'));
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (3)');
  MIGRATIONS[0](db, '2026-11-01T00:00:00.000Z');
  MIGRATIONS[1](db);
  MIGRATIONS[2](db);
  db.exec(`INSERT INTO expenses (id, source, kind, occurred_at, amount, currency, fee, merchant, merchant_key, account, operation, message_id, mail_date,
      category, status, note, previous_amount, created_at, updated_at, own_from) VALUES
    (4, 'bcp', 'purchase', '2026-10-05T10:00:00-05:00', 4800, 'PEN', NULL, 'Café Lúcuma', 'cafe lucuma', '****6789', '11', '<v3a@test>', '2026-10-05T15:00:00.000Z',
      'Comida', 'classified', NULL, NULL, '2026-10-05T15:00:01.000Z', NULL, NULL),
    (9, 'manual', 'income', '2026-10-27T12:00:00-05:00', 350000, 'PEN', NULL, 'Sueldo', 'sueldo', NULL, NULL, NULL, NULL,
      NULL, 'classified', NULL, NULL, '2026-10-27T15:00:01.000Z', NULL, NULL);`);
  const before = plain(db.prepare('SELECT * FROM expenses ORDER BY id').all());
  db.close();
  return before;
}

await rule('migrating a v3 file copies it to money.db.bak-v3 first and keeps every row', async () => {
  const dir = fresh('v3');
  const before = v3(dir);
  const m = openMoney({ dir });
  assert.equal(m.db.prepare('SELECT version FROM schema_version').get().version, 4);
  assert.deepEqual(plain(m.db.prepare('SELECT * FROM expenses ORDER BY id').all()), before.map((r) => ({ ...r, salary: 0, original: null, edited_at: null })));
  m.close();
  const bak = path.join(dir, 'money.db.bak-v3');
  assert.ok(fs.existsSync(bak), 'the backup is there');
  if (process.platform !== 'win32') assert.equal((fs.statSync(bak).mode & 0o777).toString(8), '600', 'private like the database');
  const b = new DatabaseSync(bak, { readOnly: true });
  assert.equal(b.prepare('SELECT version FROM schema_version').get().version, 3, 'the backup is the v3 file');
  assert.deepEqual(plain(b.prepare('SELECT * FROM expenses ORDER BY id').all()), before);
  b.close();
  const stat = fs.statSync(bak).mtimeMs;
  openMoney({ dir }).close();
  assert.equal(fs.statSync(bak).mtimeMs, stat, 'reopening a v4 file makes no backup');
});

await rule('an existing backup is never overwritten; a new database gets none', async () => {
  const dir = fresh('v3-kept');
  v3(dir);
  fs.writeFileSync(path.join(dir, 'money.db.bak-v3'), 'older backup');
  openMoney({ dir }).close();
  assert.equal(fs.readFileSync(path.join(dir, 'money.db.bak-v3'), 'utf8'), 'older backup');
  const empty = fresh('new');
  openMoney({ dir: empty }).close();
  assert.deepEqual(fs.readdirSync(empty).filter((f) => f.includes('bak')), []);
});

// The shared store for the rest: bank rows (bcp), and entries by hand.
const m = openMoney({ dir: fresh('main') });
const bank = (over) => m.addExpense({ source: 'bcp', kind: 'purchase', currency: 'PEN', fee: null, account: '****6789', note: null, status: 'pending',
  mailDate: '2026-10-03T17:00:00.000Z', merchantKey: (over.merchant ?? '').toLowerCase(), ...over }).id;
let answer = true;
const asked = [];
const authorize = async (reason) => { asked.push(reason); return answer; };
let TODAY = '2026-11-12';
const ops = moneyOps({ money: () => m, today: () => TODAY, authorize });
const row = (id) => ({ ...m.expense(id) });

const cafe = bank({ occurredAt: '2026-10-03T12:30:00-05:00', amount: 4500, merchant: 'Cafe Central', operation: '77', messageId: '<c@test>' });

await rule('editing a bank entry asks authorize; refused, nothing changes', async () => {
  answer = false; asked.length = 0;
  const before = row(cafe);
  const r = await ops.editEntry({ id: cafe, amount: 50, date: '2026-10-04' });
  assert.equal(r.ok, false);
  assert.deepEqual(asked, ['Edit the BCP expense of S/ 45.00 on 2026-10-03: amount to S/ 50.00, date to 2026-10-04']);
  assert.deepEqual(row(cafe), before);
});

await rule('approved, it changes, keeps the bank\'s values in original and is marked edited', async () => {
  answer = true; asked.length = 0;
  const r = await ops.editEntry({ id: cafe, amount: 50, date: '2026-10-04', description: 'Café Central Miraflores' });
  assert.equal(r.ok, true, r.text);
  assert.equal(asked.length, 1);
  const e = row(cafe);
  assert.deepEqual([e.amount, e.occurred_at, e.merchant, e.merchant_key], [5000, '2026-10-04T12:30:00-05:00', 'Café Central Miraflores', 'cafe central'], 'the time of day and the bank\'s recipient key stay');
  assert.deepEqual(JSON.parse(e.original), { occurred_at: '2026-10-03T12:30:00-05:00', amount: 4500, currency: 'PEN', merchant: 'Cafe Central' });
  assert.ok(e.edited_at);
  await ops.editEntry({ id: cafe, amount: 51 });
  assert.equal(JSON.parse(row(cafe).original).amount, 4500, 'a second edit keeps the first original');
});

await rule('a re-read of the mail never overwrites an edited row', async () => {
  const r = m.addExpense({ source: 'bcp', kind: 'purchase', occurredAt: '2026-10-03T12:30:00-05:00', amount: 9900, currency: 'PEN', merchant: 'Cafe Central',
    operation: '77', messageId: '<c2@test>', mailDate: '2026-10-09T17:00:00.000Z', status: 'pending' });
  assert.deepEqual(r, { action: 'duplicate', id: cafe });
  assert.equal(row(cafe).amount, 5100);
  // A row never edited still takes the bank's settled amount, as before.
  const other = bank({ occurredAt: '2026-10-05T10:00:00-05:00', amount: 1000, merchant: 'Tambo', operation: '78', messageId: '<t@test>' });
  assert.equal(m.addExpense({ source: 'bcp', kind: 'purchase', occurredAt: '2026-10-05T10:00:00-05:00', amount: 1200, currency: 'PEN', merchant: 'Tambo',
    operation: '78', messageId: '<t2@test>', mailDate: '2026-10-09T17:00:00.000Z', status: 'pending' }).action, 'updated');
  assert.equal(row(other).amount, 1200);
});

// Found by an independent check: a first category given in the edit sheet marked the row edited, and the mail that
// settles its amount was dropped for good. Only a change to what the bank said (amount, currency, date, description)
// is a correction that a re-read must not overwrite.
await rule('a category or salary edit leaves a bank row open to the mail that settles its amount', async () => {
  const id = bank({ occurredAt: '2026-10-06T10:00:00-05:00', amount: 10000, merchant: 'Plaza Vea', operation: '91', messageId: '<pv@test>' });
  answer = true;
  assert.equal((await ops.editEntry({ id, category: 'Comida', note: 'súper' })).ok, true);
  assert.equal(row(id).edited_at, null, 'not a correction of the bank\'s values');
  const r = m.addExpense({ source: 'bcp', kind: 'purchase', occurredAt: '2026-10-06T10:00:00-05:00', amount: 12000, currency: 'PEN', merchant: 'Plaza Vea',
    operation: '91', messageId: '<pv2@test>', mailDate: '2026-10-09T17:00:00.000Z', status: 'pending' });
  assert.equal(r.action, 'updated');
  assert.deepEqual([row(id).amount, row(id).category, row(id).note], [12000, 'Comida', 'súper'], 'settled, and the category and note stay');
  m.db.prepare('DELETE FROM expenses WHERE id = ?').run(id); // the rules below count this folder's entries
});

await rule('turning a classified expense added by hand into an income asks first: it takes the category away', async () => {
  answer = false; asked.length = 0;
  await ops.addExpense({ amount: 30, description: 'Regalo', category: 'Comida' });
  const id = m.db.prepare("SELECT max(id) AS id FROM expenses WHERE source = 'manual'").get().id;
  const before = row(id);
  assert.equal((await ops.editEntry({ id, kind: 'income' })).ok, false);
  assert.equal(asked.length, 1, 'asked');
  assert.deepEqual(row(id), before, 'refused: unchanged');
  answer = true;
  assert.equal((await ops.editEntry({ id, kind: 'income' })).ok, true);
  assert.equal(row(id).kind, 'income');
  m.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
});

await rule('revert is protected and puts the bank\'s values back', async () => {
  answer = false; asked.length = 0;
  assert.equal((await ops.revertEntry({ id: cafe })).ok, false);
  assert.equal(row(cafe).amount, 5100);
  assert.match(asked[0], /^Revert the BCP expense of S\/ 51\.00 on 2026-10-04 to what the bank mail said: S\/ 45\.00 on 2026-10-03/);
  answer = true;
  assert.equal((await ops.revertEntry({ id: cafe })).ok, true);
  const e = row(cafe);
  assert.deepEqual([e.amount, e.occurred_at, e.merchant, e.original, e.edited_at], [4500, '2026-10-03T12:30:00-05:00', 'Cafe Central', null, null]);
  await assert.rejects(ops.revertEntry({ id: cafe }), /nothing to revert/);
});

await rule('entries added by hand edit without authorize, kind included; bank rows keep their kind', async () => {
  asked.length = 0;
  await ops.addExpense({ amount: 20, description: 'Taxi', date: '2026-11-03' });
  const taxi = m.db.prepare("SELECT id FROM expenses WHERE merchant = 'Taxi'").get().id;
  const r = await ops.editEntry({ id: taxi, amount: 25, currency: 'USD', description: 'Uber', category: 'Transporte' });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(asked, []);
  let e = row(taxi);
  assert.deepEqual([e.amount, e.currency, e.merchant, e.merchant_key, e.category, e.status, e.original], [2500, 'USD', 'Uber', 'uber', 'Transporte', 'classified', null]);
  assert.ok(e.edited_at);
  await ops.editEntry({ id: taxi, kind: 'income', salary: true });
  e = row(taxi);
  assert.deepEqual([e.kind, e.category, e.status, e.salary], ['income', null, 'classified', 1], 'income: no category, may be the salary');
  await ops.editEntry({ id: taxi, kind: 'expense' });
  e = row(taxi);
  assert.deepEqual([e.kind, e.status, e.salary], ['purchase', 'pending', 0], 'back to an expense: waits for a category, no salary');
  await assert.rejects(ops.editEntry({ id: cafe, kind: 'income' }), /bank mail/);
  await assert.rejects(ops.revertEntry({ id: taxi }), /nothing to revert/);
  m.db.prepare('DELETE FROM expenses WHERE id = ?').run(taxi);
});

await rule('changing a category an entry by hand already has still asks (as classifying does)', async () => {
  asked.length = 0;
  await ops.addExpense({ amount: 10, description: 'Menú', date: '2026-11-04', category: 'Comida' });
  const id = m.db.prepare("SELECT id FROM expenses WHERE merchant = 'Menú'").get().id;
  answer = false;
  assert.equal((await ops.editEntry({ id, category: 'Otros' })).ok, false);
  assert.equal(row(id).category, 'Comida');
  answer = true;
  m.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
});

await rule('set_salary: income only, not protected', async () => {
  asked.length = 0;
  await ops.addIncome({ amount: 3500, description: 'Sueldo', date: '2026-10-27' });
  const id = m.db.prepare("SELECT id FROM expenses WHERE merchant = 'Sueldo'").get().id;
  assert.equal((await ops.setSalary({ id, on: true })).ok, true);
  assert.equal(row(id).salary, 1);
  await assert.rejects(ops.setSalary({ id: cafe, on: true }), /only income/);
  assert.deepEqual(asked, []);
  await ops.setSalary({ id, on: false });
  assert.equal(row(id).salary, 0);
  m.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
});

// Periods: each starts on a salary's date and ends the day before the next; a month whose salary hasn't come starts on
// the 26th; a salary paid up to the 10th belongs to the month before.
await rule('periods from salaries on the 26th, 27th and 28th, the 26th while this month\'s hasn\'t come', async () => {
  const span = (ps) => ps.map((p) => `${p.start}..${p.end}${p.salary ? ' S' : ''}`);
  const salaries = ['2026-08-26', '2026-09-28', '2026-10-27'];
  assert.deepEqual(span(periodsFor({ salaries, first: '2026-08-26', today: '2026-11-27' })),
    ['2026-08-26..2026-09-27 S', '2026-09-28..2026-10-26 S', '2026-10-27..2026-11-25 S', '2026-11-26..2026-12-25']);
  assert.deepEqual(span(periodsFor({ salaries: [...salaries, '2026-11-28'], first: '2026-08-26', today: '2026-11-28' })),
    ['2026-08-26..2026-09-27 S', '2026-09-28..2026-10-26 S', '2026-10-27..2026-11-27 S', '2026-11-28..2026-12-25 S']);
  assert.deepEqual(span(periodsFor({ salaries: [], first: '2026-10-05', today: '2026-11-12' })), ['2026-09-26..2026-10-25', '2026-10-26..2026-11-25'], 'no salary: the 26th');
  assert.deepEqual(span(periodsFor({ salaries: ['2026-11-02'], first: '2026-10-01', today: '2026-11-12' })), ['2026-09-26..2026-11-01', '2026-11-02..2026-11-25 S'], 'a late salary is October\'s');
  assert.deepEqual(span(periodsFor({ salaries: [], first: null, today: '2026-11-12' })), ['2026-10-26..2026-11-25'], 'nothing recorded: the period of today');
  assert.deepEqual(span(periodsFor({ salaries: [], first: null, today: '2027-01-03' })), ['2026-12-26..2027-01-25'], 'across the year');
  assert.equal(periodsFor({ salaries: [], first: null, today: '2026-11-12' })[0].label, '26 Oct – 25 Nov');
});

await rule('overview: carry-over per currency, weeks, accounts, series, exactly the contract', async () => {
  const o = openMoney({ dir: fresh('overview') });
  const add = (over) => o.addExpense({ source: 'bcp', kind: 'purchase', currency: 'PEN', status: 'pending', merchantKey: over.merchant.toLowerCase(), ...over }).id;
  const sep = add({ source: 'manual', kind: 'income', occurredAt: '2026-09-27T09:00:00-05:00', amount: 500000, merchant: 'Sueldo', status: 'classified' });
  o.db.prepare('UPDATE expenses SET salary = 1 WHERE id = ?').run(sep);
  add({ occurredAt: '2026-10-02T09:00:00-05:00', amount: 4500, merchant: 'Cafe', operation: '1' });
  add({ occurredAt: '2026-10-15T09:00:00-05:00', amount: 1000, currency: 'USD', merchant: 'Netflix', operation: '2' });
  const oct = add({ kind: 'transfer_in', occurredAt: '2026-10-28T09:00:00-05:00', amount: 500000, merchant: 'Empresa' });
  const taxi = add({ source: 'manual', occurredAt: '2026-11-03T20:00:00-05:00', amount: 2000, merchant: 'Taxi' });
  o.classify(taxi, 'Transporte', { learn: false });
  add({ kind: 'rejected', occurredAt: '2026-11-05T09:00:00-05:00', amount: 7000, merchant: 'Tienda', operation: '3', status: 'ignored' });
  const oo = moneyOps({ money: () => o, today: () => '2026-11-12', authorize: async () => true });
  assert.equal((await oo.setSalary({ id: oct, on: true })).ok, true, 'money received can be the salary');
  const v = await oo.overview({ range: '1m' });
  assert.deepEqual(Object.keys(v), ['kind', 'view', 'currency', 'periods', 'period', 'weeks', 'accounts', 'series', 'categories']);
  assert.deepEqual([v.kind, v.view, v.currency], ['money', 'overview', 'PEN']);
  assert.deepEqual(v.periods, [
    { start: '2026-09-27', end: '2026-10-27', salary: true, label: '27 Sep – 27 Oct' },
    { start: '2026-10-28', end: '2026-11-25', salary: true, label: '28 Oct – 25 Nov' },
  ]);
  assert.deepEqual(v.period, {
    start: '2026-10-28', end: '2026-11-25', carry_in: 495500, income: 500000, spending: 2000, balance: 993500,
    by_currency: [
      { currency: 'PEN', carry_in: 495500, income: 500000, spending: 2000, balance: 993500 },
      { currency: 'USD', carry_in: -1000, income: 0, spending: 0, balance: -1000 },
    ],
  });
  assert.deepEqual(v.weeks.map((w) => [w.from, w.to, w.items.map((i) => i.description)]), [
    ['2026-11-02', '2026-11-08', ['Tienda', 'Taxi']],
    ['2026-10-28', '2026-11-01', ['Empresa']],
  ], 'newest week first, cut to the period');
  assert.deepEqual(v.weeks[0].items[1], { id: taxi, date: '2026-11-03', kind: 'expense', amount: 2000, currency: 'PEN', description: 'Taxi', category: 'Transporte',
    source: 'manual', salary: false, edited: false, editable: true, protected: false, revertible: false, note: null });
  assert.deepEqual([v.weeks[0].items[0].kind, v.weeks[1].items[0].kind, v.weeks[1].items[0].salary, v.weeks[1].items[0].protected], ['other', 'income', true, true]);
  assert.deepEqual(v.accounts, [
    { source: 'bcp', label: 'BCP', income: 500000, spending: 0, count: 2 },
    { source: 'manual', label: 'By hand', income: 0, spending: 2000, count: 1 },
  ]);
  assert.equal(v.series.range, '1m');
  assert.equal(v.series.points.length, 31);
  assert.deepEqual(v.series.points[0], { date: '2026-10-13', balance: 495500 });
  assert.deepEqual(v.series.points.find((p) => p.date === '2026-10-28'), { date: '2026-10-28', balance: 995500 });
  assert.deepEqual(v.series.points.at(-1), { date: '2026-11-12', balance: 993500 });
  assert.ok(v.categories.includes('Comida'));
  const before = await oo.overview({ period: '2026-09-27' });
  assert.deepEqual([before.period.start, before.period.carry_in, before.period.income, before.period.spending, before.period.balance], ['2026-09-27', 0, 500000, 4500, 495500], 'the carry-in is the period before\'s balance');
  await assert.rejects(oo.overview({ period: '2026-01-01' }), /no period/);
  console.log(JSON.stringify({ ...v, weeks: v.weeks.slice(0, 1), series: { range: v.series.range, points: v.series.points.slice(-2) } }));
  o.close();
});

await rule('the panel: overview, edit_entry, revert_entry, set_salary, and bad input refused', async () => {
  const panel = moneyPanel({ money: () => m, today: () => TODAY, authorize });
  const ov = await panel.handle({ op: 'overview', range: '3m' });
  assert.equal(ov.ok, true, ov.text);
  assert.equal(ov.view.view, 'overview');
  answer = true;
  const ed = await panel.handle({ op: 'edit_entry', id: cafe, amount: '46.50', category: 'Comida' });
  assert.equal(ed.ok, true, ed.text);
  assert.deepEqual([row(cafe).amount, row(cafe).category], [4650, 'Comida']);
  assert.equal(ed.view.view, 'overview', 'a change answers with the overview again');
  assert.equal((await panel.handle({ op: 'edit_entry', id: cafe, category: null })).ok, true);
  assert.equal(row(cafe).category, null);
  assert.equal((await panel.handle({ op: 'revert_entry', id: cafe })).ok, true);
  assert.equal(row(cafe).amount, 4500);
  for (const bad of [
    { op: 'overview', period: '2026-13-01' }, { op: 'overview', range: '5y' }, { op: 'overview', extra: 1 },
    { op: 'edit_entry', id: cafe, kind: 'other' }, { op: 'edit_entry', id: cafe, amount: '-3' }, { op: 'edit_entry', id: 'x' },
    { op: 'edit_entry', id: cafe, date: '03/10/2026' }, { op: 'edit_entry', id: cafe, currency: 'EUR' }, { op: 'edit_entry', id: cafe, note: 'x'.repeat(201) }, { op: 'edit_entry', id: cafe, notes: 'x' }, { op: 'classify', ids: [cafe], category: 'Comida', note: 5 },
    { op: 'revert_entry' }, { op: 'set_salary', id: cafe }, { op: 'set_salary', id: cafe, on: 'yes' },
  ]) {
    const r = await panel.handle(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.text, /^Not changed: /);
  }
  const list = await panel.handle({ op: 'list' });
  assert.equal(list.ok, true, 'the movements table still answers');
  assert.ok(Array.isArray(list.view.rows));
});

await rule('the agent\'s tools: edit_entry and period_balance', async () => {
  const tools = Object.fromEntries(moneyTools({ money: () => m, today: () => TODAY, authorize }).map((t) => [t.name, t]));
  answer = true; asked.length = 0;
  const text = await tools.edit_entry.execute({ id: cafe, amount: 47, category: '' });
  assert.match(text, /^Edited #\d+/);
  assert.equal(row(cafe).amount, 4700);
  assert.equal(asked.length, 1);
  await ops.revertEntry({ id: cafe });
  const pb = await tools.period_balance.execute({});
  assert.match(pb, /^Period 2026-10-26 to 2026-11-25 \(from the 26th; no salary marked yet\):/);
  assert.match(pb, /PEN: carried in S\/ -57\.00 \+ income S\/ 0\.00 - spending S\/ 0\.00 = S\/ -57\.00/);
  assert.match(tools.query_expenses.description, /salary 1 on the income marked as the user's salary/);
  assert.match(tools.query_expenses.description, /original/);
});

// S12b: a note (what the user says about an expense) is set with the category or on its own; never protected.
await rule('a note-only edit never asks, also on a bank row, and leaves original and edited alone', async () => {
  asked.length = 0; answer = false;
  const before = row(cafe);
  const r = await ops.editEntry({ id: cafe, note: '  almuerzo con el equipo ' });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(asked, []);
  const e = row(cafe);
  assert.deepEqual([e.note, e.original, e.edited_at, e.amount], ['almuerzo con el equipo', before.original, before.edited_at, before.amount]);
  assert.deepEqual(m.search('equipo').map((x) => x.id), [cafe], 'the note is searchable');
  assert.equal((await ops.editEntry({ id: cafe, note: null })).ok, true);
  assert.equal(row(cafe).note, null);
  answer = true;
});

await rule('classify takes a note for those ids (panel and agent), next_pending_expenses shows it, items carry it', async () => {
  const panel = moneyPanel({ money: () => m, today: () => TODAY, authorize });
  const tambo = m.db.prepare("SELECT id FROM expenses WHERE merchant = 'Tambo'").get().id;
  const r = await panel.handle({ op: 'classify', ids: [tambo], category: 'Comida', note: 'snacks' });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual([row(tambo).category, row(tambo).note], ['Comida', 'snacks']);
  const tools = Object.fromEntries(moneyTools({ money: () => m, today: () => TODAY, authorize }).map((t) => [t.name, t]));
  assert.match(tools.classify_expenses.description, /note/);
  assert.match(tools.classify_expenses.description, /comida, almuerzo con el equipo/);
  await tools.classify_expenses.execute({ ids: [cafe], category: 'Comida', note: 'almuerzo con el equipo' });
  assert.deepEqual([row(cafe).category, row(cafe).note], ['Comida', 'almuerzo con el equipo']);
  await assert.rejects(tools.classify_expenses.execute({ merchant: 'Tambo', category: 'Comida', note: 'x' }), /note.*ids/);
  m.db.prepare("UPDATE expenses SET category = NULL, status = 'pending' WHERE id = ?").run(cafe);
  assert.match(await tools.next_pending_expenses.execute({}), /note: almuerzo con el equipo/);
  const v = await ops.overview({ period: '2026-10-03' });
  assert.equal(v.weeks.flatMap((w) => w.items).find((i) => i.id === cafe).note, 'almuerzo con el equipo');
});

m.close();
if (failed.length) { console.error(`${failed.length} failed`); process.exit(1); }
