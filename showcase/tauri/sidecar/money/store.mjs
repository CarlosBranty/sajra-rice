// The money database: one private SQLite file (node:sqlite) holding expenses, categories, merchant → category
// rules and the mails that were not understood. Amounts are integer cents; times are America/Lima ISO strings.
// The schema is created and upgraded by numbered migrations recorded in schema_version.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IGNORED_KINDS, INCOME_KINDS, NOT_SPENDING, OWN_KINDS } from './banks.mjs';
import { maskAccount, merchantKey } from './parse.mjs';

export const DEFAULT_CATEGORIES = ['Comida', 'Supermercado', 'Transporte', 'Viajes', 'Servicios', 'Salud', 'Entretenimiento', 'Compras', 'Educación', 'Transferencias', 'Otros'];

// The expenses table with the kinds a schema version allows (and the columns it adds), and the indexes and triggers
// that hang on it.
const expensesTable = (name, kinds, extra = '') => `
      CREATE TABLE ${name} (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(', ')})),
        occurred_at TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount >= 0),
        currency TEXT NOT NULL CHECK (currency IN ('PEN', 'USD')),
        fee INTEGER,
        merchant TEXT,
        merchant_key TEXT,
        account TEXT,
        operation TEXT,
        message_id TEXT UNIQUE,
        mail_date TEXT,
        category TEXT REFERENCES categories(name) ON UPDATE CASCADE ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'classified', 'ignored', 'needs_review')),
        note TEXT,
        previous_amount INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT${extra}
      );`;
const EXPENSES_INDEXES = `
      CREATE UNIQUE INDEX expenses_operation ON expenses(source, operation) WHERE operation IS NOT NULL;
      CREATE INDEX expenses_when ON expenses(occurred_at);
      CREATE INDEX expenses_status ON expenses(status, occurred_at);`;
const EXPENSES_TRIGGERS = `
      CREATE TRIGGER expenses_fts_insert AFTER INSERT ON expenses BEGIN
        INSERT INTO expenses_fts(rowid, merchant, note) VALUES (new.id, new.merchant, new.note);
      END;
      CREATE TRIGGER expenses_fts_delete AFTER DELETE ON expenses BEGIN
        INSERT INTO expenses_fts(expenses_fts, rowid, merchant, note) VALUES ('delete', old.id, old.merchant, old.note);
      END;
      CREATE TRIGGER expenses_fts_update AFTER UPDATE OF merchant, note ON expenses BEGIN
        INSERT INTO expenses_fts(expenses_fts, rowid, merchant, note) VALUES ('delete', old.id, old.merchant, old.note);
        INSERT INTO expenses_fts(rowid, merchant, note) VALUES (new.id, new.merchant, new.note);
      END;`;

export const MIGRATIONS = [
  // 1: the first schema.
  (db, now) => {
    db.exec(`
      CREATE TABLE categories (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      ${expensesTable('expenses', ['purchase', 'transfer_out', 'transfer_in', 'yape_out', 'withdrawal', 'payment'])}
      ${EXPENSES_INDEXES}
      CREATE TABLE rules (
        merchant_key TEXT PRIMARY KEY,
        category TEXT NOT NULL REFERENCES categories(name) ON UPDATE CASCADE ON DELETE CASCADE,
        origin TEXT NOT NULL CHECK (origin IN ('learned', 'set')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE unparsed (
        message_id TEXT PRIMARY KEY,
        sender TEXT,
        subject TEXT,
        received_at TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE expenses_fts USING fts5(merchant, note, content='expenses', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      ${EXPENSES_TRIGGERS}
    `);
    const add = db.prepare('INSERT INTO categories (name, position, created_at) VALUES (?, ?, ?)');
    DEFAULT_CATEGORIES.forEach((name, i) => add.run(name, i + 1, now));
  },
  // 2: the kinds own_transfer and rejected (SQLite cannot change a CHECK: the table is copied over, ids kept, so the
  // full-text index stays valid); each unparsed mail remembers its account and the definitions that could not read it.
  (db) => {
    db.exec(`
      ${expensesTable('expenses_v2', ['purchase', 'transfer_out', 'transfer_in', 'yape_out', 'withdrawal', 'payment', 'own_transfer', 'rejected'])}
      INSERT INTO expenses_v2 SELECT * FROM expenses;
      DROP TABLE expenses;
      ALTER TABLE expenses_v2 RENAME TO expenses;
      ${EXPENSES_INDEXES}
      ${EXPENSES_TRIGGERS}
      ALTER TABLE unparsed ADD COLUMN account TEXT;
      ALTER TABLE unparsed ADD COLUMN definitions TEXT;
    `);
  },
  // 3: the kind income (added by hand); own_from, the kind a transfer had before its recipient was marked as the user's
  // own account (it is then own_transfer and ignored; unmarking puts the kind back); the own accounts. Copied as in 2.
  (db) => {
    db.exec(`
      ${expensesTable('expenses_v3', ['purchase', 'transfer_out', 'transfer_in', 'yape_out', 'withdrawal', 'payment', 'own_transfer', 'rejected', 'income'],
        `,
        own_from TEXT CHECK (own_from IN ('transfer_out', 'yape_out', 'transfer_in'))`)}
      INSERT INTO expenses_v3 SELECT *, NULL FROM expenses;
      DROP TABLE expenses;
      ALTER TABLE expenses_v3 RENAME TO expenses;
      ${EXPENSES_INDEXES}
      ${EXPENSES_TRIGGERS}
      CREATE TABLE own_accounts (
        merchant_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

// Runs fn in one transaction; inside another one it is part of that one.
function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  if (!row) db.exec('INSERT INTO schema_version (version) VALUES (0)');
  const from = row?.version ?? 0;
  if (from > SCHEMA_VERSION) throw new Error(`money.db is at schema ${from}, newer than this Hanami (${SCHEMA_VERSION})`);
  for (let v = from; v < SCHEMA_VERSION; v++) {
    transaction(db, () => {
      MIGRATIONS[v](db, new Date().toISOString());
      db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
    });
  }
}

/** Opens (creating and migrating) the database at `file`, private to the user. */
export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  const now = () => new Date().toISOString();

  const canonical = (name) => {
    const row = db.prepare('SELECT name FROM categories WHERE name = ?').get(String(name ?? '').trim());
    if (!row) throw new Error(`unknown category: ${name}`);
    return row.name;
  };
  const ruleFor = (key) => (key ? db.prepare('SELECT category FROM rules WHERE merchant_key = ?').get(key)?.category ?? null : null);
  const kinds = (list) => list.map((k) => `'${k}'`).join(', ');
  const SPENDING = `kind NOT IN (${kinds(NOT_SPENDING)}) AND status <> 'ignored'`;
  const INCOME = `kind IN (${kinds(INCOME_KINDS)}) AND status <> 'ignored'`;
  // Words → an FTS5 query where each is a prefix and nothing is read as an operator; '' when there is no word.
  const ftsQuery = (text) => (String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => `"${w}"*`).join(' ');
  const isOwn = (key) => !!key && !!db.prepare('SELECT 1 FROM own_accounts WHERE merchant_key = ?').get(key);
  // An expense marked as moved to the user's own account goes back to its kind; it waits again unless it has a category.
  const UNMARK = "kind = own_from, own_from = NULL, status = CASE WHEN category IS NULL THEN 'pending' ELSE 'classified' END";

  /** The merchant_key a name the user or the agent says stands for: the exact key when one is stored, else its key. */
  function recipientKey(name) {
    const exact = String(name ?? '').trim().toLowerCase();
    const known = exact && db.prepare('SELECT 1 FROM expenses WHERE merchant_key = ? UNION SELECT 1 FROM own_accounts WHERE merchant_key = ?').get(exact, exact);
    const key = known ? exact : merchantKey(name);
    if (!key) throw new Error('no recipient name');
    return key;
  }

  /** Stores a parsed expense once. Same Message-ID → duplicate. Same bank operation number → duplicate, unless the
   * mail is newer and the amount changed (e-commerce purchases settle later): then the amount is replaced, the old
   * one kept in previous_amount, and the category stays. A new expense whose merchant has a rule arrives classified. */
  function addExpense(e) {
    return transaction(db, () => {
      const byMessage = e.messageId ? db.prepare('SELECT id FROM expenses WHERE message_id = ?').get(e.messageId) : null;
      if (byMessage) return { action: 'duplicate', id: byMessage.id };
      const same = e.operation ? db.prepare('SELECT id, amount, mail_date FROM expenses WHERE source = ? AND operation = ?').get(e.source, e.operation) : null;
      if (same) {
        const newer = !same.mail_date || !e.mailDate || e.mailDate > same.mail_date;
        if (!newer || same.amount === e.amount) return { action: 'duplicate', id: same.id };
        db.prepare('UPDATE expenses SET previous_amount = amount, amount = ?, fee = ?, message_id = ?, mail_date = ?, updated_at = ? WHERE id = ?')
          .run(e.amount, e.fee ?? null, e.messageId ?? null, e.mailDate ?? null, now(), same.id);
        return { action: 'updated', id: same.id };
      }
      const key = e.merchantKey ?? merchantKey(e.merchant);
      const own = OWN_KINDS.includes(e.kind) && isOwn(key);
      const kind = own ? 'own_transfer' : e.kind;
      const ignored = IGNORED_KINDS.includes(kind);
      const category = NOT_SPENDING.includes(kind) || e.status === 'needs_review' ? null : ruleFor(key);
      const { lastInsertRowid } = db.prepare(`INSERT INTO expenses (source, kind, occurred_at, amount, currency, fee, merchant, merchant_key, account,
          operation, message_id, mail_date, category, status, note, created_at, own_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.source, kind, e.occurredAt, e.amount, e.currency, e.fee ?? null, e.merchant ?? null, key || null, maskAccount(e.account ?? null),
          e.operation ?? null, e.messageId ?? null, e.mailDate ?? null, category, ignored ? 'ignored' : category ? 'classified' : (e.status ?? 'pending'), e.note ?? null, now(),
          own ? e.kind : null);
      return { action: 'inserted', id: Number(lastInsertRowid) };
    });
  }

  /** Sets an expense's category; with `learn` (the default) its merchant gets that category from now on,
   * unless the user set a rule for it by hand. */
  function classify(id, category, { learn = true } = {}) {
    const name = canonical(category);
    transaction(db, () => {
      const row = db.prepare('SELECT merchant_key FROM expenses WHERE id = ?').get(id);
      if (!row) throw new Error(`no expense ${id}`);
      db.prepare("UPDATE expenses SET category = ?, status = 'classified', updated_at = ? WHERE id = ?").run(name, now(), id);
      if (learn && row.merchant_key) {
        db.prepare(`INSERT INTO rules (merchant_key, category, origin, updated_at) VALUES (?, ?, 'learned', ?)
          ON CONFLICT (merchant_key) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at WHERE rules.origin = 'learned'`)
          .run(row.merchant_key, name, now());
      }
    });
    return name;
  }

  /** Takes an expense's category away: it waits to be classified again (rules stay). */
  function unclassify(id) {
    const r = db.prepare("UPDATE expenses SET category = NULL, status = CASE WHEN status = 'classified' THEN 'pending' ELSE status END, updated_at = ? WHERE id = ?").run(now(), id);
    if (!r.changes) throw new Error(`no expense ${id}`);
  }

  /** Deletes a category: its expenses wait to be classified again and its rules go. → { expenses, rules } changed. */
  function deleteCategory(name) {
    const n = canonical(name);
    return transaction(db, () => {
      const expenses = db.prepare("UPDATE expenses SET category = NULL, status = CASE WHEN status = 'classified' THEN 'pending' ELSE status END, updated_at = ? WHERE category = ?").run(now(), n).changes;
      const rules = db.prepare('DELETE FROM rules WHERE category = ?').run(n).changes;
      db.prepare('DELETE FROM categories WHERE name = ?').run(n);
      return { expenses: Number(expenses), rules: Number(rules) };
    });
  }

  /** Marks a recipient (a merchant_key, or a name) as the user's own account: their transfers, past and future, are
   * own_transfer (moved between the user's own accounts: neither spending nor income). → how many expenses changed. */
  function markOwnAccount(name) {
    const key = recipientKey(name);
    return transaction(db, () => {
      db.prepare('INSERT INTO own_accounts (merchant_key, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(key, now());
      return Number(db.prepare(`UPDATE expenses SET own_from = kind, kind = 'own_transfer', status = 'ignored', updated_at = ?
        WHERE merchant_key = ? AND kind IN (${kinds(OWN_KINDS)})`).run(now(), key).changes);
    });
  }

  /** Undoes markOwnAccount: the recipient's transfers get their kind back. → how many expenses changed. */
  function unmarkOwnAccount(name) {
    const key = recipientKey(name);
    return transaction(db, () => {
      db.prepare('DELETE FROM own_accounts WHERE merchant_key = ?').run(key);
      return Number(db.prepare(`UPDATE expenses SET ${UNMARK}, updated_at = ? WHERE merchant_key = ? AND own_from IS NOT NULL`).run(now(), key).changes);
    });
  }

  /** A rule the user states ("Cafe Central is Comida"); learning never overwrites it. */
  function setRule(merchant, category) {
    const key = merchantKey(merchant);
    if (!key) throw new Error('no merchant name');
    db.prepare(`INSERT INTO rules (merchant_key, category, origin, updated_at) VALUES (?, ?, 'set', ?)
      ON CONFLICT (merchant_key) DO UPDATE SET category = excluded.category, origin = 'set', updated_at = excluded.updated_at`)
      .run(key, canonical(category), now());
    return key;
  }

  function addCategory(name) {
    const n = String(name ?? '').trim();
    if (!n || n.length > 40) throw new Error('a category name is 1 to 40 characters');
    if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(n)) throw new Error(`category exists: ${n}`);
    db.prepare('INSERT INTO categories (name, position, created_at) VALUES (?, (SELECT coalesce(max(position), 0) + 1 FROM categories), ?)').run(n, now());
    return n;
  }

  /** Renames a category; expenses and rules follow (ON UPDATE CASCADE). */
  function renameCategory(from, to) {
    const old = canonical(from), n = String(to ?? '').trim();
    if (!n || n.length > 40) throw new Error('a category name is 1 to 40 characters');
    if (n.toLowerCase() !== old.toLowerCase() && db.prepare('SELECT 1 FROM categories WHERE name = ?').get(n)) throw new Error(`category exists: ${n}`);
    db.prepare('UPDATE categories SET name = ? WHERE name = ?').run(n, old);
    return n;
  }

  return {
    db, file, addExpense, classify, unclassify, setRule, addCategory, renameCategory, deleteCategory, recipientKey, markOwnAccount, unmarkOwnAccount,
    /** fn() in one transaction (the store's own changes inside it join it). */
    atomic: (fn) => transaction(db, fn),
    expense: (id) => db.prepare('SELECT * FROM expenses WHERE id = ?').get(id),
    /** The canonical name of a category, or throws. */
    categoryName: canonical,
    categories: () => db.prepare('SELECT name FROM categories ORDER BY position').all().map((r) => r.name),
    /** Deletes an entry the user added by hand (never one read from a mail). */
    deleteManual(id) {
      if (!db.prepare("DELETE FROM expenses WHERE id = ? AND source = 'manual'").run(id).changes) throw new Error(`no entry added by hand with id ${id}`);
    },
    /** The own accounts with how many transfers each turned into own_transfer. */
    ownAccounts: () => db.prepare(`SELECT o.merchant_key, max(e.merchant) AS merchant, COUNT(e.id) AS count FROM own_accounts o
      LEFT JOIN expenses e ON e.merchant_key = o.merchant_key AND e.own_from IS NOT NULL GROUP BY o.merchant_key ORDER BY o.created_at, o.merchant_key`).all(),
    /** What marking a recipient would change: { total, classified } transfers (classified: with a category). */
    ownAccountEffect: (name) => ({ ...db.prepare(`SELECT COUNT(*) AS total, COUNT(category) AS classified FROM expenses
      WHERE merchant_key = ? AND kind IN (${kinds(OWN_KINDS)})`).get(recipientKey(name)) }),
    suggest: (e) => ruleFor(e.merchantKey ?? e.merchant_key ?? merchantKey(e.merchant)),
    /** Expenses waiting for the user (no category yet, or held for review), oldest first; never what is no spending
     * (money received included). */
    pending: () => db.prepare(`SELECT * FROM expenses WHERE status IN ('pending', 'needs_review')
      AND kind NOT IN (${kinds(NOT_SPENDING)}) ORDER BY occurred_at, id`).all(),
    /** Words in the merchant or the note, accent-insensitive; each word is a prefix, operators are not parsed. */
    search(text, limit = 50) {
      const q = ftsQuery(text);
      if (!q) return [];
      return db.prepare('SELECT e.* FROM expenses_fts f JOIN expenses e ON e.id = f.rowid WHERE expenses_fts MATCH ? ORDER BY e.occurred_at DESC LIMIT ?').all(q, limit);
    },
    /** Every movement (expenses, income, and what is not counted), newest first, filtered: month 'YYYY-MM'; category a
     * name, or null for the expenses not classified yet; group 'spending' | 'income' | 'other' (neither: not counted);
     * text as search() reads it. → { total, rows (limit from offset), totals per currency { currency, spent, received,
     * count } in cents }. */
    movements({ month, category, group, text, offset = 0, limit = 50 } = {}) {
      const where = [], args = [];
      if (month) { where.push('substr(occurred_at, 1, 7) = ?'); args.push(month); }
      if (category === null) where.push(`category IS NULL AND ${SPENDING}`);
      else if (category !== undefined) { where.push('category = ?'); args.push(canonical(category)); }
      if (group === 'spending') where.push(SPENDING);
      else if (group === 'income') where.push(INCOME);
      else if (group === 'other') where.push(`NOT (${SPENDING}) AND NOT (${INCOME})`);
      if (text != null && String(text).trim()) {
        const q = ftsQuery(text);
        if (!q) return { total: 0, rows: [], totals: [] };
        where.push('id IN (SELECT rowid FROM expenses_fts WHERE expenses_fts MATCH ?)'); args.push(q);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return {
        total: db.prepare(`SELECT COUNT(*) AS n FROM expenses ${w}`).get(...args).n,
        rows: db.prepare(`SELECT * FROM expenses ${w} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset),
        totals: db.prepare(`SELECT currency, coalesce(SUM(CASE WHEN ${SPENDING} THEN amount END), 0) AS spent,
            coalesce(SUM(CASE WHEN ${INCOME} THEN amount END), 0) AS received, COUNT(*) AS count FROM expenses ${w} GROUP BY currency ORDER BY currency`).all(...args),
      };
    },
    /** The months with any movement, newest first. */
    months: () => db.prepare('SELECT DISTINCT substr(occurred_at, 1, 7) AS month FROM expenses ORDER BY month DESC').all().map((r) => r.month),
    /** Keeps a mail that was not understood (once per Message-ID) so it can be reviewed and read again: `account` is
     * where it came from, `definitions` the fingerprint of the definitions that could not read it. Read again and still
     * not understood, its reason and fingerprint are updated. */
    addUnparsed: ({ messageId, sender, subject, receivedAt, reason, account = null, definitions = null }) => db.prepare(
      `INSERT INTO unparsed (message_id, sender, subject, received_at, reason, created_at, account, definitions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (message_id) DO UPDATE SET reason = excluded.reason, account = coalesce(excluded.account, account),
          definitions = coalesce(excluded.definitions, definitions)`,
    ).run(messageId, sender ?? null, subject ?? null, receivedAt ?? null, String(reason), now(), account, definitions),
    removeUnparsed: (messageId) => db.prepare('DELETE FROM unparsed WHERE message_id = ?').run(messageId),
    unparsed: () => db.prepare('SELECT * FROM unparsed ORDER BY received_at, created_at').all(),
    /** The not-understood mails of `account` (or of no known account) that other definitions than `definitions` tried,
     * newest first. */
    unparsedBefore: (definitions, account, limit) => db.prepare(`SELECT * FROM unparsed WHERE (definitions IS NULL OR definitions <> ?)
      AND (account IS NULL OR account = ?) ORDER BY received_at DESC, created_at DESC LIMIT ?`).all(definitions, account, limit),
    /** A mail to read again was not found in the mailbox: it counts as tried with `definitions`. */
    triedWith: (messageId, definitions) => db.prepare('UPDATE unparsed SET definitions = ? WHERE message_id = ?').run(definitions, messageId),
    close: () => db.close(),
  };
}
