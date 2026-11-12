// Money store: schema, duplicates, amount updates, masking, categories, learned rules, pending, search, ingest.
// Runs in a throwaway data folder, never the real one. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMoney } from '../money.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-money-store-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const DB = path.join(TMP, 'money.db');

// Migration from nothing: a private file at the current schema version with the default categories.
let m = openMoney({ dir: TMP });
assert.ok(fs.existsSync(DB));
if (process.platform !== 'win32') assert.equal((fs.statSync(DB).mode & 0o777).toString(8), '600', 'private file');
assert.equal(m.db.prepare('SELECT version FROM schema_version').get().version, 1);
const DEFAULTS = ['Comida', 'Supermercado', 'Transporte', 'Viajes', 'Servicios', 'Salud', 'Entretenimiento', 'Compras', 'Educación', 'Transferencias', 'Otros'];
assert.deepEqual(m.categories(), DEFAULTS);
m.close();
m = openMoney({ dir: TMP });
assert.deepEqual(m.categories(), DEFAULTS, 'reopening migrates nothing twice');
assert.equal(m.db.prepare('SELECT count(*) AS n FROM schema_version').get().n, 1);

const base = {
  source: 'falabella', kind: 'purchase', occurredAt: '2026-11-07T08:15:00-05:00', amount: 4590, currency: 'PEN', fee: null,
  merchant: 'Cafe Central Pe', merchantKey: 'cafe central', account: '****6789', operation: '990807081577', note: null,
  messageId: '<a@test>', mailDate: '2026-11-07T13:15:05.000Z', status: 'pending',
};
const count = () => m.db.prepare('SELECT count(*) AS n FROM expenses').get().n;
const row = (id) => m.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);

// Duplicates: the same Message-ID, or the same bank operation number, is stored once.
const first = m.addExpense(base);
assert.equal(first.action, 'inserted');
assert.deepEqual(m.addExpense(base), { action: 'duplicate', id: first.id }, 'same message id');
assert.deepEqual(m.addExpense({ ...base, operation: null }), { action: 'duplicate', id: first.id }, 'same message id, no operation number');
assert.deepEqual(m.addExpense({ ...base, messageId: '<resent@test>' }), { action: 'duplicate', id: first.id }, 'same operation, same amount');
const other = m.addExpense({ ...base, source: 'bcp', messageId: '<b@test>' });
assert.equal(other.action, 'inserted', 'operation numbers are per bank');
assert.equal(count(), 2);

// E-commerce amount update: a newer mail for the same operation replaces the amount, keeps the category and the row.
m.classify(first.id, 'comida');
assert.deepEqual(m.addExpense({ ...base, amount: 4800, messageId: '<final@test>', mailDate: '2026-11-08T10:00:00.000Z' }), { action: 'updated', id: first.id });
let r = row(first.id);
assert.deepEqual([r.amount, r.previous_amount, r.category, r.status, r.message_id], [4800, 4590, 'Comida', 'classified', '<final@test>']);
assert.deepEqual(m.addExpense({ ...base, amount: 4100, messageId: '<late-old@test>', mailDate: '2026-11-07T20:00:00.000Z' }), { action: 'duplicate', id: first.id }, 'an older mail never overwrites a newer one');
assert.equal(row(first.id).amount, 4800);
assert.equal(m.addExpense({ ...base, amount: 4800, messageId: '<final@test>' }).action, 'duplicate', 'the update mail itself fetched again');
assert.equal(count(), 2);

// Masking: a full account number never reaches the database, whoever builds the expense.
const raw = m.addExpense({ ...base, operation: '1', messageId: '<raw@test>', account: '1234567890123456789' });
assert.equal(row(raw.id).account, '****6789');
assert.deepEqual([row(raw.id).category, row(raw.id).status], ['Comida', 'classified'], 'the rule learned from the first classification');
assert.equal(m.db.prepare("SELECT count(*) AS n FROM expenses WHERE account GLOB '*[0-9][0-9][0-9][0-9][0-9]*'").get().n, 0);

// Rules: classifying learns merchant → category; later expenses from that merchant arrive classified.
const yape = { ...base, source: 'bcp', kind: 'yape_out', merchant: 'Jorge M Salas P.', merchantKey: 'jorge m salas p', operation: '04561234', messageId: '<y1@test>', occurredAt: '2026-11-06T19:05:00-05:00' };
const y1 = m.addExpense(yape);
assert.equal(m.suggest(yape), null);
m.classify(y1.id, 'TRANSFERENCIAS');
assert.equal(row(y1.id).category, 'Transferencias', 'canonical category name');
assert.equal(m.suggest({ merchantKey: 'jorge m salas p' }), 'Transferencias');
const y2 = m.addExpense({ ...yape, operation: '04561299', messageId: '<y2@test>', occurredAt: '2026-11-09T12:00:00-05:00' });
assert.deepEqual([row(y2.id).category, row(y2.id).status], ['Transferencias', 'classified']);
const noLearn = m.addExpense({ ...base, merchant: 'Kiosko', merchantKey: 'kiosko', operation: '7', messageId: '<k@test>' });
m.classify(noLearn.id, 'Otros', { learn: false });
assert.equal(m.suggest({ merchantKey: 'kiosko' }), null, 'learn: false learns nothing');
m.setRule('Cafe Central S.A.C.', 'Comida');
m.classify(m.addExpense({ ...base, operation: '8', messageId: '<c2@test>' }).id, 'Otros');
assert.equal(m.suggest({ merchantKey: 'cafe central' }), 'Comida', 'a rule the user set is not overwritten by learning');
assert.throws(() => m.classify(noLearn.id, 'Casino'), /unknown category/);
assert.throws(() => m.classify(99999, 'Otros'), /no expense/);

// Rules never classify an expense held for review.
const review = m.addExpense({ ...yape, operation: '04561300', messageId: '<y3@test>', status: 'needs_review', occurredAt: '2026-11-01T09:00:00-05:00' });
assert.deepEqual([row(review.id).category, row(review.id).status], [null, 'needs_review']);

// Pending: unclassified and held-for-review expenses, oldest first.
const pend = m.pending();
assert.deepEqual(pend.map((e) => e.id), [review.id, other.id]);
assert.ok(pend.every((e) => e.category === null));
assert.ok(pend.map((e) => e.occurred_at).every((t, i, a) => i === 0 || a[i - 1] <= t), 'date order');

// Categories are the user's: add, rename (expenses and rules follow).
m.addCategory('Mascotas');
assert.equal(m.categories().at(-1), 'Mascotas');
assert.throws(() => m.addCategory('mascotas'), /exists/);
m.renameCategory('Comida', 'Comida y bebida');
assert.equal(row(first.id).category, 'Comida y bebida');
assert.equal(m.suggest({ merchantKey: 'cafe central' }), 'Comida y bebida');

// Full-text search over merchant and note, accent-insensitive; query syntax in the input is inert.
m.addExpense({ ...base, merchant: 'Café Lúcuma', merchantKey: 'cafe lucuma', note: 'Almuerzo viernes', operation: '9', messageId: '<l@test>' });
assert.deepEqual(m.search('lucuma').map((e) => e.merchant), ['Café Lúcuma']);
assert.deepEqual(m.search('almuerzo').map((e) => e.merchant), ['Café Lúcuma']);
assert.ok(m.search('cafe').length >= 2);
assert.deepEqual(m.search('" OR merchant:*'), []);

// Unparsed mails are kept once each for review.
m.addUnparsed({ messageId: '<u@test>', sender: 'x@notificacionesbcp.com.pe', subject: 'Raro', receivedAt: '2026-11-09T10:00:00.000Z', reason: 'missing amount' });
m.addUnparsed({ messageId: '<u@test>', sender: 'x@notificacionesbcp.com.pe', subject: 'Raro', receivedAt: '2026-11-09T10:00:00.000Z', reason: 'missing amount' });
assert.equal(m.unparsed().length, 1);

// ingest: a parsed mail becomes an expense, anything else an unparsed mail with its reason.
const auth = 'mx; dkim=pass header.d=notificacionesbcp.com.pe; dmarc=pass header.from=notificacionesbcp.com.pe';
const html = fs.readFileSync(new URL('./fixtures/money/bcp-yape.html', import.meta.url), 'utf8');
const ok = m.ingest({ from: 'notificaciones@notificacionesbcp.com.pe', subject: 'Constancia de Yapeo a Celular', messageId: '<i1@test>', date: '2026-11-06T19:06:00-05:00', authResults: auth, html });
assert.deepEqual(ok.action, 'duplicate', 'same BCP operation as the yape above');
const bad = m.ingest({ from: 'notificaciones@notificacionesbcp.com.pe', subject: 'Constancia de Yapeo a Celular', messageId: '<i2@test>', date: '2026-11-06T19:06:00-05:00', authResults: auth, html: '<p>nada</p>' });
assert.equal(bad.action, 'unparsed');
assert.match(m.unparsed().find((u) => u.message_id === '<i2@test>').reason, /amount/);
m.close();

// A database written by a newer Roamies is refused rather than guessed at.
const future = new DatabaseSync(DB);
future.exec('UPDATE schema_version SET version = 99');
future.close();
assert.throws(() => openMoney({ dir: TMP }), /newer/);

console.log('money-store: ok');
