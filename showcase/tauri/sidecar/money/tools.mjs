// The agent's tools for questions about the user's spending, over the expenses read from bank mails (money.mjs).
// Both only read: `spending` runs the fixed summaries, `query_expenses` one SELECT through runQuery (a read-only
// connection in a child process with row and time limits). Amounts are stored in cents and said in soles or dollars.
import { z } from 'zod';
import { NOT_SPENDING } from './banks.mjs';

const SYMBOL = { PEN: 'S/', USD: 'US$' };
const MAX_ROWS = 100;

const money = (cents, currency) => `${SYMBOL[currency] ?? currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n) => `${n} expense${n === 1 ? '' : 's'}`;
const totals = (rows) => (rows.length ? rows.map((r) => `${money(r.total, r.currency)} in ${count(r.count)}`).join('; ') : 'nothing');
const localDay = () => new Date().toLocaleDateString('en-CA');

/** money(): the open money store (opened on first use); today(): the local date, YYYY-MM-DD. */
export function moneyTools({ money: open, today = localDay }) {
  const empty = 'No expenses recorded yet. They come from the bank notification mails of the mail account added on the Money page of the panel.';
  return [
    {
      name: 'spending',
      description: "The user's spending in a month, from the bank and wallet notification mails Roamies reads: totals, by category, top merchants, the month before, how many expenses wait to be classified, and the dates the records cover. Use it for questions like \"what did I spend this month\" or \"how much on food in October\"; use query_expenses for anything it doesn't answer. Money received, transfers between their own accounts and refused purchases are not spending.",
      parameters: z.object({ month: z.string().optional().describe('YYYY-MM; the current month if left out') }),
      execute: async ({ month }) => {
        const m = open();
        const month_ = month ?? today().slice(0, 7);
        const cmp = m.compareMonths(month_); // checks the month
        const range = m.db.prepare('SELECT COUNT(*) AS n, min(occurred_at) AS first, max(occurred_at) AS last FROM expenses').get();
        if (!range.n) return empty;
        const byCategory = m.totalsByCategory(month_).map((r) => `${r.category ?? 'not classified'} ${money(r.total, r.currency)} (${r.count})`);
        const byMerchant = m.totalsByMerchant(month_, 8).map((r) => `${r.merchant ?? r.merchant_key ?? 'unknown'} ${money(r.total, r.currency)} (${r.count})`);
        return [
          `Spending in ${month_} (records cover ${range.first.slice(0, 10)} to ${range.last.slice(0, 10)}):`,
          `Total: ${totals(cmp.current)}`,
          byCategory.length && `By category: ${byCategory.join(', ')}`,
          byMerchant.length && `Top merchants: ${byMerchant.join(', ')}`,
          `${cmp.previous}: ${totals(cmp.before)}`,
          `Waiting to be classified: ${m.pending().length}`,
        ].filter(Boolean).join('\n');
      },
    },
    {
      name: 'query_expenses',
      description: `Run one read-only SQLite SELECT over the user's expenses (from their bank notification mails) and get the rows as JSON (at most ${MAX_ROWS}). Tables: expenses(id, source 'bcp'|'falabella'|…, kind, occurred_at ISO local time with offset, amount INTEGER in cents, currency 'PEN'|'USD', fee in cents, merchant, merchant_key lowercase, account masked, operation, category, status 'pending'|'classified'|'ignored'|'needs_review', note), categories(name, position), rules(merchant_key, category, origin); expenses_fts(merchant, note) is an FTS5 index (rowid = expenses.id). Kinds: purchase, transfer_out, yape_out, withdrawal, payment are spending; transfer_in, own_transfer, rejected are not (money received, moved between the user's own accounts, refused), and status 'ignored' never counts: for spending add WHERE kind NOT IN ('${NOT_SPENDING.join("', '")}') AND status <> 'ignored'. Sum per currency, divide amounts by 100, and use substr(occurred_at, 1, 7) for a month.`,
      parameters: z.object({ sql: z.string().min(6).max(4000) }),
      execute: async ({ sql }) => {
        const r = await open().query(sql, { maxRows: MAX_ROWS });
        return JSON.stringify({ columns: r.columns, rows: r.rows, truncated: r.truncated });
      },
    },
  ];
}
