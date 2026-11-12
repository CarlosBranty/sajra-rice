// Questions about spending, answered exactly. `runQuery` runs one SELECT in a separate Node process on a read-only
// connection whose authorizer allows reading and nothing else (no writes, ATTACH or PRAGMA), with a row cap and a
// time limit (the process is killed: SQLite cannot be interrupted from another thread here). The summaries are fixed
// queries over the same rules: spending is every kind but money received, ignored expenses left out, per currency.
import { spawn } from 'node:child_process';

/** Why `sql` is not a single SELECT/WITH statement, or null when it is (strings and comments are skipped). */
export function checkSelect(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return 'empty query';
  const bare = sql
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => (m[0] === '-' || m[0] === '/' ? ' ' : "''"))
    .trim().replace(/;\s*$/, '');
  if (bare.includes(';')) return 'only one statement is allowed';
  if (!/^(select|with)\b/i.test(bare)) return 'only SELECT or WITH queries are allowed';
  return null;
}

// Runs in the child: reads { file, sql, maxRows } from stdin, writes { ok, columns, rows, truncated } or { ok, error }.
const CHILD = `
const { DatabaseSync, constants: C } = require('node:sqlite');
let input = '';
process.stdin.setEncoding('utf8').on('data', (d) => { input += d; }).on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o));
  try {
    const { file, sql, maxRows } = JSON.parse(input);
    const db = new DatabaseSync(file, { readOnly: true });
    const allowed = new Set([C.SQLITE_SELECT, C.SQLITE_READ, C.SQLITE_FUNCTION, C.SQLITE_RECURSIVE]);
    db.setAuthorizer((action) => (allowed.has(action) ? C.SQLITE_OK : C.SQLITE_DENY));
    const stmt = db.prepare(sql);
    const trim = (s) => s.trim().replace(/;\\s*$/, '').trim();
    if (trim(stmt.sourceSQL) !== trim(sql)) throw new Error('only one statement is allowed');
    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(row);
    }
    out({ ok: true, columns: stmt.columns().map((c) => c.name), rows, truncated });
  } catch (e) {
    out({ ok: false, error: e.message });
  }
});`;

const MAX_OUTPUT = 4 * 1024 * 1024;

/** One read-only SELECT on the database file → { columns, rows, truncated }. Rejects refused or failed queries. */
export function runQuery(file, sql, { maxRows = 200, timeoutMs = 3000 } = {}) {
  const why = checkSelect(sql);
  if (why) return Promise.reject(new Error(why));
  maxRows = Math.max(1, Math.min(Number(maxRows) || 200, 1000));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', CHILD], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', done = false;
    const finish = (fn, value) => { if (!done) { done = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`the query took longer than ${timeoutMs} ms and was stopped`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
      if (out.length > MAX_OUTPUT) { child.kill('SIGKILL'); finish(reject, new Error('the query result is too large')); }
    });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => {
      let r;
      try { r = JSON.parse(out); } catch { return finish(reject, new Error(`query process failed: ${err.trim().split('\n').at(-1) || 'no output'}`)); }
      if (r.ok) finish(resolve, { columns: r.columns, rows: r.rows, truncated: r.truncated });
      else finish(reject, new Error(r.error));
    });
    child.stdin.end(JSON.stringify({ file, sql, maxRows }));
  });
}

const SPENDING = "kind <> 'transfer_in' AND status <> 'ignored'";
const checkMonth = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) throw new Error(`a month is YYYY-MM, not ${JSON.stringify(month)}`);
  return month;
};
const previousMonth = (month) => {
  const [y, m] = checkMonth(month).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
// Plain objects (node:sqlite rows have a null prototype).
const plain = (rows) => rows.map((r) => ({ ...r }));

/** The ready summaries over an open database. */
export function summaries(db) {
  const totals = (month) => plain(db.prepare(`SELECT currency, SUM(amount) AS total, COUNT(*) AS count FROM expenses
    WHERE substr(occurred_at, 1, 7) = ? AND ${SPENDING} GROUP BY currency ORDER BY currency`).all(checkMonth(month)));
  return {
    /** Spending per category in a month (category null = not classified yet). */
    totalsByCategory: (month) => plain(db.prepare(`SELECT category, currency, SUM(amount) AS total, COUNT(*) AS count FROM expenses
      WHERE substr(occurred_at, 1, 7) = ? AND ${SPENDING} GROUP BY category, currency ORDER BY currency, total DESC`).all(checkMonth(month))),
    /** Spending per merchant in a month, biggest first. */
    totalsByMerchant: (month, limit = 20) => plain(db.prepare(`SELECT merchant_key, max(merchant) AS merchant, currency, SUM(amount) AS total, COUNT(*) AS count
      FROM expenses WHERE substr(occurred_at, 1, 7) = ? AND ${SPENDING} GROUP BY merchant_key, currency ORDER BY currency, total DESC LIMIT ?`)
      .all(checkMonth(month), limit)),
    /** A month's spending next to the month before. */
    compareMonths: (month) => ({ month, previous: previousMonth(month), current: totals(month), before: totals(previousMonth(month)) }),
  };
}
