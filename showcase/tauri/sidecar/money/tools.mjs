// The agent's tools over the user's money (money.mjs): expenses read from bank mails or added by hand, income, and
// the user's categories and own accounts. `spending`, `balance`, `query_expenses` (one SELECT through runQuery: a
// read-only connection in a child process with row and time limits), `categories` and `next_pending_expenses` only
// read. The changes are the shared operations of ops.mjs (the panel's Money page uses the same ones): those that undo
// what the user already decided first ask authorize(reason) for the user's password or fingerprint and change nothing
// unless it answers true. Amounts are stored in cents and said in soles or dollars.
import { z } from 'zod';
import { INCOME_KINDS, NOT_SPENDING } from './banks.mjs';
import { count, localDay, money, moneyOps, plural } from './ops.mjs';

const MAX_ROWS = 100;

const totals = (rows) => (rows.length ? rows.map((r) => `${money(r.total, r.currency)} in ${count(r.count)}`).join('; ') : 'nothing');
const KIND = { purchase: 'purchase at', transfer_out: 'transfer to', yape_out: 'yape to', withdrawal: 'cash withdrawal', payment: 'payment to' };

/** money(): the open money store (opened on first use); today(): the local date, YYYY-MM-DD; authorize(reason):
 * resolves true once the user confirmed who they are for the change `reason` names. */
export function moneyTools({ money: open, today = localDay, authorize }) {
  const empty = 'No expenses recorded yet. They come from the bank notification mails of the mail account added on the Money page of the panel.';
  const ops = moneyOps({ money: open, today, authorize });
  const text = (r) => r.text;

  const amount = z.number().positive().max(100000000).describe('in soles or dollars, e.g. 20.5');
  const currency = z.enum(['PEN', 'USD']).optional().describe('PEN if left out');
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; today if left out');

  return [
    {
      name: 'spending',
      description: "The user's spending in a month, from the bank and wallet notification mails Hanami reads and the expenses they added by hand: totals, by category, top merchants, the month before, how many expenses wait to be classified, and the dates the records cover. Use it for questions like \"what did I spend this month\" or \"how much on food in October\"; use balance for income, and query_expenses for anything they don't answer. Money received, income, transfers between their own accounts and refused purchases are not spending.",
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
      name: 'balance',
      description: "The user's balance in a month, per currency: income minus spending, with both parts. Income is money received by mail (not from the user's own accounts) plus income they added (add_income).",
      parameters: z.object({ month: z.string().optional().describe('YYYY-MM; the current month if left out') }),
      execute: async ({ month }) => {
        const month_ = month ?? today().slice(0, 7);
        const rows = open().balance(month_);
        if (!rows.length) return `Balance in ${month_}: nothing received or spent.`;
        return [`Balance in ${month_} (income - spending = balance):`, ...rows.map((r) =>
          `${r.currency}: income ${money(r.income, r.currency)} (${r.income_count}) - spending ${money(r.spending, r.currency)} (${r.spending_count}) = ${money(r.balance, r.currency)}`)].join('\n');
      },
    },
    {
      name: 'query_expenses',
      description: `Run one read-only SQLite SELECT over the user's money records (from their bank notification mails, and entries they added by hand) and get the rows as JSON (at most ${MAX_ROWS}). Tables: expenses(id, source 'bcp'|'falabella'|…|'manual' (added by hand), kind, occurred_at ISO local time with offset, amount INTEGER in cents, currency 'PEN'|'USD', fee in cents, merchant (or what was said for an entry added by hand), merchant_key lowercase, account masked, operation, category, status 'pending'|'classified'|'ignored'|'needs_review', note (what the user said about it), own_from, salary 1 on the income marked as the user's salary (pay periods start on its date), original (JSON of what the bank mail said before the user edited it; NULL if never edited), edited_at), categories(name, position), rules(merchant_key, category, origin), own_accounts(merchant_key: recipients that are the user's own accounts); expenses_fts(merchant, note) is an FTS5 index (rowid = expenses.id). Kinds: purchase, transfer_out, yape_out, withdrawal, payment are spending; transfer_in (money received), income (added by hand), own_transfer (moved between the user's own accounts; own_from is the kind it had before its recipient was marked as theirs) and rejected (refused) are not; status 'ignored' never counts. Spending: WHERE kind NOT IN ('${NOT_SPENDING.join("', '")}') AND status <> 'ignored'. Income: WHERE kind IN ('${INCOME_KINDS.join("', '")}') AND status <> 'ignored'. Waiting to be classified: spending with status 'pending' or 'needs_review'. Sum per currency, divide amounts by 100, and use substr(occurred_at, 1, 7) for a month.`,
      parameters: z.object({ sql: z.string().min(6).max(4000) }),
      execute: async ({ sql }) => {
        const r = await open().query(sql, { maxRows: MAX_ROWS });
        return JSON.stringify({ columns: r.columns, rows: r.rows, truncated: r.truncated });
      },
    },
    {
      name: 'categories',
      description: "The user's expense categories (the defaults and the ones they created), each with how many expenses it holds.",
      parameters: z.object({}),
      execute: async () => `Categories (expenses in each): ${open().categoryCounts().map((c) => `${c.name} (${c.count})`).join(', ')}`,
    },
    {
      name: 'add_category',
      description: 'Create a new expense category.',
      parameters: z.object({ name: z.string().min(1).max(40) }),
      execute: async ({ name }) => text(await ops.addCategory({ name })),
    },
    {
      name: 'rename_category',
      description: "Rename a category; its expenses and rules follow. Asks for the user's password or fingerprint.",
      parameters: z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40) }),
      execute: async (args) => text(await ops.renameCategory(args)),
    },
    {
      name: 'delete_category',
      description: "Delete a category: its expenses wait to be classified again and its merchant rules are removed. Asks for the user's password or fingerprint.",
      parameters: z.object({ name: z.string().min(1).max(40) }),
      execute: async (args) => text(await ops.deleteCategory(args)),
    },
    {
      name: 'next_pending_expenses',
      description: 'The next expenses waiting to be classified, oldest first, each with its id and the suggested category (from what the user said before about that merchant), to read them to the user one by one and ask the category. Pass after_id (the last one read or skipped) to go on.',
      parameters: z.object({
        after_id: z.number().int().positive().optional().describe('the id of the last expense read; from the start if left out'),
        count: z.number().int().min(1).max(10).optional().describe('how many; 1 if left out'),
      }),
      execute: async ({ after_id, count: n = 1 }) => {
        const m = open();
        const all = m.pending();
        if (!all.length) return 'Nothing waits to be classified.';
        let start = 0;
        if (after_id != null) {
          const ref = m.expense(after_id);
          if (!ref) throw new Error(`no expense ${after_id}`);
          start = all.findIndex((e) => e.occurred_at > ref.occurred_at || (e.occurred_at === ref.occurred_at && e.id > ref.id));
          if (start < 0) return `No more waiting after #${after_id} (${all.length} waiting in all).`;
        }
        const line = (e) => {
          const suggested = m.suggest(e);
          return `#${e.id} ${e.occurred_at.slice(0, 10)} ${money(e.amount, e.currency)} ${KIND[e.kind] ?? e.kind} ${e.merchant ?? ''}`.trimEnd()
            + ` (${e.source}${e.account ? ` ${e.account}` : ''})${e.note ? `, note: ${e.note}` : ''}`
            + (e.status === 'needs_review' ? ', held for review: the bank mail layout is not verified, check the amount' : '')
            + `; ${suggested ? `suggested: ${suggested}` : 'no suggestion'}`;
        };
        return [`${all.length} waiting to be classified${start ? ` (#${after_id} and those before it skipped)` : ''}:`, ...all.slice(start, start + n).map(line),
          `Categories: ${m.categories().join(', ')}`].join('\n');
      },
    },
    {
      name: 'classify_expenses',
      description: "Put expenses in a category: by id (from next_pending_expenses or query_expenses), or every expense of a merchant or recipient. By default the merchant's next expenses arrive in that category (learn: false to not). When the user says a note with the category (\"comida, almuerzo con el equipo\": category Comida, note \"almuerzo con el equipo\"), pass it as note with the ids. Changing the category of an expense that already has one asks for the user's password or fingerprint; the note never does.",
      parameters: z.object({
        category: z.string().min(1).max(40),
        ids: z.array(z.number().int().positive()).max(200).optional(),
        merchant: z.string().min(1).max(200).optional().describe('a merchant or recipient name, instead of ids'),
        learn: z.boolean().optional(),
        note: z.string().max(200).optional().describe('what the user said about these expenses, only with ids; "" removes it'),
      }),
      execute: async (args) => text(await ops.classify(args)),
    },
    {
      name: 'unclassify_expenses',
      description: "Take expenses out of their category: they wait to be classified again. Asks for the user's password or fingerprint.",
      parameters: z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }),
      execute: async (args) => text(await ops.unclassify(args)),
    },
    {
      name: 'add_expense',
      description: 'Record an expense no bank mail reported (cash, another card), as the user tells it. It counts like any other expense.',
      parameters: z.object({
        amount, currency, date,
        description: z.string().min(1).max(200).describe('what or where, e.g. "Taxi"'),
        category: z.string().min(1).max(40).optional().describe('only if the user said it'),
      }),
      execute: async (args) => text(await ops.addExpense(args)),
    },
    {
      name: 'add_income',
      description: "Record money the user received (their salary or any other income) as they tell it; it counts in the balance, never as spending. Money received that a bank mail reported is already counted.",
      parameters: z.object({ amount, currency, date, description: z.string().min(1).max(200).describe('e.g. "Sueldo"') }),
      execute: async (args) => text(await ops.addIncome(args)),
    },
    {
      name: 'delete_entry',
      description: "Delete an expense or income the user added by hand (never one read from a bank mail). Asks for the user's password or fingerprint.",
      parameters: z.object({ id: z.number().int().positive() }),
      execute: async (args) => text(await ops.deleteEntry(args)),
    },
    {
      name: 'own_accounts',
      description: "The recipients that are the user's own accounts (when they say a transfer went to themselves, e.g. \"that one is mine\"). Their transfers, past and future, are moves between the user's own accounts: neither spending nor income. list them, mark one (by the merchant or recipient name), or unmark one. Unmarking, and marking a recipient whose transfers are already classified, ask for the user's password or fingerprint.",
      parameters: z.object({ action: z.enum(['list', 'mark', 'unmark']), merchant: z.string().min(1).max(200).optional() }),
      execute: async ({ action, merchant }) => {
        const m = open();
        if (action === 'list') {
          const own = m.ownAccounts();
          return own.length ? `Own accounts: ${own.map((o) => `${o.merchant ?? o.merchant_key} (${plural(o.count, 'transfer')})`).join(', ')}` : 'No own accounts marked yet.';
        }
        if (!merchant) throw new Error('say which recipient: merchant');
        return text(await ops.ownAccount({ action, merchant }));
      },
    },
    {
      name: 'edit_entry',
      description: "Correct an expense or income as the user says (from query_expenses or next_pending_expenses by id): amount, currency, date, description, category, note, expense or income, and whether an income is their salary (pay periods start on the salary's date). Only what is passed changes. Changing what a bank mail said (amount, currency, date, description) asks for the user's password or fingerprint, and the bank's values are kept so the edit can be undone; so does changing a category the entry already has. A note never asks. Only entries added by hand switch between expense and income.",
      parameters: z.object({
        id: z.number().int().positive(),
        amount: amount.optional(), currency, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
        description: z.string().min(1).max(200).optional(),
        category: z.string().max(40).optional().describe('a category name; "" removes it'),
        note: z.string().max(200).optional().describe('what the user said about it; "" removes it'),
        kind: z.enum(['expense', 'income']).optional(),
        salary: z.boolean().optional().describe('income only: true when it is the user\'s salary'),
      }),
      execute: async (args) => text(await ops.editEntry(args)),
    },
    {
      name: 'period_balance',
      description: "The user's balance in a pay period: a period starts on the date of the income marked as their salary and lasts until the day before the next one (paid around the 26th; while a month's salary hasn't come, the 26th is assumed). Per currency: what was left from before (carried in) + income - spending = balance, and the periods there are. Use it for \"how much do I have left until payday\"; mark the salary with edit_entry (salary: true).",
      parameters: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('any day of the period, YYYY-MM-DD; the current period if left out') }),
      execute: async ({ date }) => {
        const v = await ops.overview({ period: date });
        const p = v.period;
        const lines = p.by_currency.map((c) => `${c.currency}: carried in ${money(c.carry_in, c.currency)} + income ${money(c.income, c.currency)} - spending ${money(c.spending, c.currency)} = ${money(c.balance, c.currency)}`);
        return [`Period ${p.start} to ${p.end} (${v.periods.find((x) => x.start === p.start)?.salary ? `from the salary on ${p.start}` : 'from the 26th; no salary marked yet'}):`,
          ...(lines.length ? lines : ['Nothing recorded yet.']),
          `Periods: ${v.periods.slice(-6).map((x) => `${x.start} to ${x.end}`).join(', ')}`].join('\n');
      },
    },
  ];
}
