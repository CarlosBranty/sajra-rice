// The agent's tools over the user's money (money.mjs): expenses read from bank mails or added by hand, income, and
// the user's categories and own accounts. `spending`, `balance`, `query_expenses` (one SELECT through runQuery: a
// read-only connection in a child process with row and time limits), `categories` and `next_pending_expenses` only
// read. Changes that undo what the user already decided (renaming or deleting a category, changing or removing a
// classification, deleting an entry, marking or unmarking an own account over classified transfers) first ask
// authorize(reason) for the user's password or fingerprint and change nothing unless it answers true. Amounts are
// stored in cents and said in soles or dollars.
import { z } from 'zod';
import { INCOME_KINDS, NOT_SPENDING } from './banks.mjs';

const SYMBOL = { PEN: 'S/', USD: 'US$' };
const MAX_ROWS = 100;
const SHOWN = 5;

const money = (cents, currency) => `${SYMBOL[currency] ?? currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const count = (n) => plural(n, 'expense');
const totals = (rows) => (rows.length ? rows.map((r) => `${money(r.total, r.currency)} in ${count(r.count)}`).join('; ') : 'nothing');
const localDay = () => new Date().toLocaleDateString('en-CA');
const pad = (n) => String(n).padStart(2, '0');
const isExpense = (e) => !NOT_SPENDING.includes(e.kind) && e.status !== 'ignored';
const NOT_EXPENSE = { transfer_in: 'money received', income: 'income', own_transfer: 'a transfer between the user\'s own accounts', rejected: 'a refused purchase' };
const KIND = { purchase: 'purchase at', transfer_out: 'transfer to', yape_out: 'yape to', withdrawal: 'cash withdrawal', payment: 'payment to' };
// "#12 Plaza Vea, S/ 120.00, 2026-11-02": how an expense is named in a confirmation.
const short = (e) => `#${e.id} ${e.merchant ?? e.note ?? e.kind}, ${money(e.amount, e.currency)}, ${e.occurred_at.slice(0, 10)}`;
const some = (items, fn) => items.slice(0, SHOWN).map(fn).join('; ') + (items.length > SHOWN ? `; and ${items.length - SHOWN} more` : '');

/** A local date (YYYY-MM-DD) → an ISO time with the local offset: now on the real today, else noon. */
function localTime(date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && new Date(`${date}T12:00:00`);
  if (!day || Number.isNaN(day.getTime()) || day.toLocaleDateString('en-CA') !== date) throw new Error(`a date is YYYY-MM-DD, not ${JSON.stringify(date)}`);
  const at = date === localDay() ? new Date() : day;
  const off = -at.getTimezoneOffset();
  return `${date}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${off < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** money(): the open money store (opened on first use); today(): the local date, YYYY-MM-DD; authorize(reason):
 * resolves true once the user confirmed who they are for the change `reason` names. */
export function moneyTools({ money: open, today = localDay, authorize }) {
  const empty = 'No expenses recorded yet. They come from the bank notification mails of the mail account added on the Money page of the panel.';

  // plan() reads the data as it is now → { reason, protect, apply() } or throws why it cannot be done. A protected
  // change asks authorize(reason) first; then, inside one transaction, the plan is made again and applied only if it
  // is still the same (same reason): what changes is exactly what the user confirmed.
  async function change(m, plan) {
    const first = plan();
    if (first.protect) {
      if (typeof authorize !== 'function') return `Not changed: this needs the user's password or fingerprint, and asking for it is not available here. (${first.reason})`;
      let yes = false;
      try { yes = (await authorize(first.reason)) === true; } catch { yes = false; }
      if (!yes) return `Not changed: the user did not confirm it. (${first.reason})`;
    }
    return m.atomic(() => {
      let now;
      try { now = plan(); } catch { now = null; }
      if (!now || now.reason !== first.reason || now.protect !== first.protect) return 'Not changed: the data changed while the user was confirming. Nothing was applied; ask again.';
      return now.apply();
    });
  }
  const amount = z.number().positive().max(100000000).describe('in soles or dollars, e.g. 20.5');
  const currency = z.enum(['PEN', 'USD']).optional().describe('PEN if left out');
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; today if left out');
  const cents = (n) => Math.round(n * 100);

  return [
    {
      name: 'spending',
      description: "The user's spending in a month, from the bank and wallet notification mails Roamies reads and the expenses they added by hand: totals, by category, top merchants, the month before, how many expenses wait to be classified, and the dates the records cover. Use it for questions like \"what did I spend this month\" or \"how much on food in October\"; use balance for income, and query_expenses for anything they don't answer. Money received, income, transfers between their own accounts and refused purchases are not spending.",
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
      description: `Run one read-only SQLite SELECT over the user's money records (from their bank notification mails, and entries they added by hand) and get the rows as JSON (at most ${MAX_ROWS}). Tables: expenses(id, source 'bcp'|'falabella'|…|'manual' (added by hand), kind, occurred_at ISO local time with offset, amount INTEGER in cents, currency 'PEN'|'USD', fee in cents, merchant (or what was said for an entry added by hand), merchant_key lowercase, account masked, operation, category, status 'pending'|'classified'|'ignored'|'needs_review', note, own_from), categories(name, position), rules(merchant_key, category, origin), own_accounts(merchant_key: recipients that are the user's own accounts); expenses_fts(merchant, note) is an FTS5 index (rowid = expenses.id). Kinds: purchase, transfer_out, yape_out, withdrawal, payment are spending; transfer_in (money received), income (added by hand), own_transfer (moved between the user's own accounts; own_from is the kind it had before its recipient was marked as theirs) and rejected (refused) are not; status 'ignored' never counts. Spending: WHERE kind NOT IN ('${NOT_SPENDING.join("', '")}') AND status <> 'ignored'. Income: WHERE kind IN ('${INCOME_KINDS.join("', '")}') AND status <> 'ignored'. Waiting to be classified: spending with status 'pending' or 'needs_review'. Sum per currency, divide amounts by 100, and use substr(occurred_at, 1, 7) for a month.`,
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
      execute: async ({ name }) => `Added the category "${open().addCategory(name)}".`,
    },
    {
      name: 'rename_category',
      description: "Rename a category; its expenses and rules follow. Asks for the user's password or fingerprint.",
      parameters: z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40) }),
      execute: async ({ from, to }) => {
        const m = open();
        return change(m, () => {
          const old = m.categoryName(from), name = to.trim();
          if (old === name) throw new Error(`the category is already called "${old}"`);
          if (name.toLowerCase() !== old.toLowerCase() && m.categories().some((c) => c.toLowerCase() === name.toLowerCase())) throw new Error(`category exists: ${name}`);
          const n = m.db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE category = ?').get(old).n;
          const r = m.db.prepare('SELECT COUNT(*) AS n FROM rules WHERE category = ?').get(old).n;
          return {
            reason: `Rename the category "${old}" to "${name}" (${count(n)} and ${plural(r, 'rule')} follow)`, protect: true,
            apply: () => `Renamed "${old}" to "${m.renameCategory(old, name)}".`,
          };
        });
      },
    },
    {
      name: 'delete_category',
      description: "Delete a category: its expenses wait to be classified again and its merchant rules are removed. Asks for the user's password or fingerprint.",
      parameters: z.object({ name: z.string().min(1).max(40) }),
      execute: async ({ name }) => {
        const m = open();
        return change(m, () => {
          const cat = m.categoryName(name);
          const n = m.db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE category = ?').get(cat).n;
          const r = m.db.prepare('SELECT COUNT(*) AS n FROM rules WHERE category = ?').get(cat).n;
          return {
            reason: `Delete the category "${cat}": its ${count(n)} go back to waiting to be classified and its ${plural(r, 'rule')} ${r === 1 ? 'is' : 'are'} removed`, protect: true,
            apply: () => `Deleted "${cat}"; ${count(m.deleteCategory(cat).expenses)} wait to be classified again.`,
          };
        });
      },
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
      description: "Put expenses in a category: by id (from next_pending_expenses or query_expenses), or every expense of a merchant or recipient. By default the merchant's next expenses arrive in that category (learn: false to not). Changing the category of an expense that already has one asks for the user's password or fingerprint.",
      parameters: z.object({
        category: z.string().min(1).max(40),
        ids: z.array(z.number().int().positive()).max(200).optional(),
        merchant: z.string().min(1).max(200).optional().describe('a merchant or recipient name, instead of ids'),
        learn: z.boolean().optional(),
      }),
      execute: async ({ category, ids, merchant, learn = true }) => {
        const m = open();
        if (!ids?.length && !merchant) throw new Error('say which expenses: ids or a merchant');
        return change(m, () => {
          const name = m.categoryName(category);
          const rows = ids?.length
            ? ids.map((id) => m.expense(id) ?? (() => { throw new Error(`no expense ${id}`); })())
            : m.db.prepare('SELECT * FROM expenses WHERE merchant_key = ? ORDER BY occurred_at, id').all(m.recipientKey(merchant)).filter(isExpense);
          if (!rows.length) throw new Error(`no expenses from ${merchant}`);
          for (const e of rows) if (!isExpense(e)) throw new Error(`#${e.id} is ${NOT_EXPENSE[e.kind] ?? 'not counted as spending'}, not an expense to classify`);
          const todo = rows.filter((e) => e.category !== name);
          if (!todo.length) return { reason: '', protect: false, apply: () => `Nothing to change: ${rows.length === 1 ? 'it is' : `all ${rows.length} are`} already in ${name}.` };
          const moved = todo.filter((e) => e.category), fresh = todo.length - moved.length;
          const reason = moved.length
            ? `Change the category of ${count(moved.length)}: ${some(moved, (e) => `${short(e)}, from ${e.category} to ${name}`)}${fresh ? `; and put ${count(fresh)} with no category in ${name}` : ''}`
            : `Put ${count(todo.length)} in ${name}`;
          return {
            reason, protect: moved.length > 0,
            apply: () => { for (const e of todo) m.classify(e.id, name, { learn }); return `Put ${count(todo.length)} in ${name}.`; },
          };
        });
      },
    },
    {
      name: 'unclassify_expenses',
      description: "Take expenses out of their category: they wait to be classified again. Asks for the user's password or fingerprint.",
      parameters: z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }),
      execute: async ({ ids }) => {
        const m = open();
        return change(m, () => {
          const todo = ids.map((id) => m.expense(id) ?? (() => { throw new Error(`no expense ${id}`); })()).filter((e) => e.category);
          if (!todo.length) return { reason: '', protect: false, apply: () => 'Nothing to change: no category to remove.' };
          return {
            reason: `Remove the category of ${count(todo.length)}: ${some(todo, (e) => `${short(e)}, in ${e.category}`)}`, protect: true,
            apply: () => { for (const e of todo) m.unclassify(e.id); return `${count(todo.length)} wait${todo.length === 1 ? 's' : ''} to be classified again.`; },
          };
        });
      },
    },
    {
      name: 'add_expense',
      description: 'Record an expense no bank mail reported (cash, another card), as the user tells it. It counts like any other expense.',
      parameters: z.object({
        amount, currency, date,
        description: z.string().min(1).max(200).describe('what or where, e.g. "Taxi"'),
        category: z.string().min(1).max(40).optional().describe('only if the user said it'),
      }),
      execute: async ({ amount: a, currency: c = 'PEN', date: d, description, category }) => {
        const m = open();
        const name = category ? m.categoryName(category) : null;
        const occurredAt = localTime(d ?? today());
        return m.atomic(() => {
          const { id } = m.addExpense({ source: 'manual', kind: 'purchase', occurredAt, amount: cents(a), currency: c, merchant: description.trim(), status: 'pending' });
          if (name) m.classify(id, name);
          const e = m.expense(id);
          return `Added expense #${id}: ${money(e.amount, c)} ${e.merchant} on ${occurredAt.slice(0, 10)}, ${e.category ? `in ${e.category}` : 'waiting to be classified'}.`;
        });
      },
    },
    {
      name: 'add_income',
      description: "Record money the user received (their salary or any other income) as they tell it; it counts in the balance, never as spending. Money received that a bank mail reported is already counted.",
      parameters: z.object({ amount, currency, date, description: z.string().min(1).max(200).describe('e.g. "Sueldo"') }),
      execute: async ({ amount: a, currency: c = 'PEN', date: d, description }) => {
        const m = open();
        const occurredAt = localTime(d ?? today());
        const { id } = m.addExpense({ source: 'manual', kind: 'income', occurredAt, amount: cents(a), currency: c, merchant: description.trim(), status: 'classified' });
        return `Added income #${id}: ${money(cents(a), c)} ${description.trim()} on ${occurredAt.slice(0, 10)}.`;
      },
    },
    {
      name: 'delete_entry',
      description: "Delete an expense or income the user added by hand (never one read from a bank mail). Asks for the user's password or fingerprint.",
      parameters: z.object({ id: z.number().int().positive() }),
      execute: async ({ id }) => {
        const m = open();
        return change(m, () => {
          const e = m.expense(id);
          if (!e) throw new Error(`no expense ${id}`);
          if (e.source !== 'manual') throw new Error(`#${id} came from a bank mail: only entries added by hand can be deleted`);
          return { reason: `Delete the ${e.kind === 'income' ? 'income' : 'expense'} added by hand ${short(e)}`, protect: true, apply: () => { m.deleteManual(id); return `Deleted #${id}.`; } };
        });
      },
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
        return change(m, () => {
          const key = m.recipientKey(merchant);
          const shown = `"${m.db.prepare('SELECT max(merchant) AS name FROM expenses WHERE merchant_key = ?').get(key).name ?? merchant}"`;
          const marked = m.ownAccounts().some((o) => o.merchant_key === key);
          if (action === 'unmark') {
            if (!marked) throw new Error(`${shown} is not marked as an own account`);
            const n = m.ownAccounts().find((o) => o.merchant_key === key).count;
            return {
              reason: `Unmark ${shown} as the user's own account: ${plural(n, 'transfer')} count${n === 1 ? 's' : ''} again as spending or income`, protect: true,
              apply: () => `Unmarked ${shown}: ${plural(m.unmarkOwnAccount(key), 'transfer')} count again.`,
            };
          }
          const { total, classified } = m.ownAccountEffect(key);
          if (marked && !total) return { reason: '', protect: false, apply: () => `${shown} is already marked as an own account.` };
          return {
            reason: `Mark ${shown} as the user's own account: ${plural(total, 'transfer')} stop${total === 1 ? 's' : ''} counting as spending or income${classified ? ` (${classified} of them already classified)` : ''}, and so do later ones`,
            protect: classified > 0,
            apply: () => `Marked ${shown} as the user's own account: ${plural(m.markOwnAccount(key), 'transfer')} (and later ones) are now between the user's own accounts.`,
          };
        });
      },
    },
  ];
}
