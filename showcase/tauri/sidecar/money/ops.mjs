// The changes to the user's money records, one function per operation, shared by the agent's tools (tools.mjs) and
// the panel's Money page (panel.mjs) so both do exactly the same. Changes that undo what the user already decided
// (renaming or deleting a category, changing or removing a classification, deleting an entry, marking or unmarking an
// own account over classified transfers) first ask authorize(reason) for the user's password or fingerprint and
// change nothing unless it answers true. Each operation → { ok, text } (ok: false when nothing was changed because
// the user did not confirm), or throws why it cannot be done.
import { NOT_SPENDING } from './banks.mjs';

const SYMBOL = { PEN: 'S/', USD: 'US$' };
const SHOWN = 5;

/** cents → "S/ 1,234.50". */
export const money = (cents, currency) => `${SYMBOL[currency] ?? currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const count = (n) => plural(n, 'expense');
export const localDay = () => new Date().toLocaleDateString('en-CA');
const pad = (n) => String(n).padStart(2, '0');
/** Spending the user can classify: not money received, moved between their own accounts or refused, not ignored. */
export const isExpense = (e) => !NOT_SPENDING.includes(e.kind) && e.status !== 'ignored';
const NOT_EXPENSE = { transfer_in: 'money received', income: 'income', own_transfer: 'a transfer between the user\'s own accounts', rejected: 'a refused purchase' };
// "#12 Plaza Vea, S/ 120.00, 2026-11-02": how an expense is named in a confirmation.
const short = (e) => `#${e.id} ${e.merchant ?? e.note ?? e.kind}, ${money(e.amount, e.currency)}, ${e.occurred_at.slice(0, 10)}`;
const some = (items, fn) => items.slice(0, SHOWN).map(fn).join('; ') + (items.length > SHOWN ? `; and ${items.length - SHOWN} more` : '');
const cents = (n) => Math.round(n * 100);

/** A local date (YYYY-MM-DD) → an ISO time with the local offset: now on the real today, else noon. */
export function localTime(date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && new Date(`${date}T12:00:00`);
  if (!day || Number.isNaN(day.getTime()) || day.toLocaleDateString('en-CA') !== date) throw new Error(`a date is YYYY-MM-DD, not ${JSON.stringify(date)}`);
  const at = date === localDay() ? new Date() : day;
  const off = -at.getTimezoneOffset();
  return `${date}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${off < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** money(): the open money store (opened on first use); today(): the local date, YYYY-MM-DD; authorize(reason):
 * resolves true once the user confirmed who they are for the change `reason` names. */
export function moneyOps({ money: open, today = localDay, authorize }) {
  // plan() reads the data as it is now → { reason, protect, apply() } or throws why it cannot be done. A protected
  // change asks authorize(reason) first; then, inside one transaction, the plan is made again and applied only if it
  // is still the same (same reason): what changes is exactly what the user confirmed.
  async function change(m, plan) {
    const first = plan();
    if (first.protect) {
      if (typeof authorize !== 'function') return { ok: false, text: `Not changed: this needs the user's password or fingerprint, and asking for it is not available here. (${first.reason})` };
      let yes = false;
      try { yes = (await authorize(first.reason)) === true; } catch { yes = false; }
      if (!yes) return { ok: false, text: `Not changed: the user did not confirm it. (${first.reason})` };
    }
    return m.atomic(() => {
      let now;
      try { now = plan(); } catch { now = null; }
      if (!now || now.reason !== first.reason || now.protect !== first.protect) return { ok: false, text: 'Not changed: the data changed while the user was confirming. Nothing was applied; ask again.' };
      return { ok: true, text: now.apply() };
    });
  }
  const expenseById = (m, id) => m.expense(id) ?? (() => { throw new Error(`no expense ${id}`); })();

  return {
    addCategory: async ({ name }) => ({ ok: true, text: `Added the category "${open().addCategory(name)}".` }),

    renameCategory: async ({ from, to }) => {
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

    deleteCategory: async ({ name }) => {
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

    /** By ids, or every expense of a merchant; learn: the merchant's next expenses arrive in that category. */
    classify: async ({ category, ids, merchant, learn = true }) => {
      const m = open();
      if (!ids?.length && !merchant) throw new Error('say which expenses: ids or a merchant');
      return change(m, () => {
        const name = m.categoryName(category);
        const rows = ids?.length
          ? ids.map((id) => expenseById(m, id))
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

    unclassify: async ({ ids }) => {
      const m = open();
      return change(m, () => {
        const todo = ids.map((id) => expenseById(m, id)).filter((e) => e.category);
        if (!todo.length) return { reason: '', protect: false, apply: () => 'Nothing to change: no category to remove.' };
        return {
          reason: `Remove the category of ${count(todo.length)}: ${some(todo, (e) => `${short(e)}, in ${e.category}`)}`, protect: true,
          apply: () => { for (const e of todo) m.unclassify(e.id); return `${count(todo.length)} wait${todo.length === 1 ? 's' : ''} to be classified again.`; },
        };
      });
    },

    /** amount in soles or dollars; date YYYY-MM-DD (today if left out); category only if the user said it. */
    addExpense: async ({ amount, currency = 'PEN', date, description, category }) => {
      const m = open();
      const name = category ? m.categoryName(category) : null;
      const occurredAt = localTime(date ?? today());
      return m.atomic(() => {
        const { id } = m.addExpense({ source: 'manual', kind: 'purchase', occurredAt, amount: cents(amount), currency, merchant: description.trim(), status: 'pending' });
        if (name) m.classify(id, name);
        const e = m.expense(id);
        return { ok: true, text: `Added expense #${id}: ${money(e.amount, currency)} ${e.merchant} on ${occurredAt.slice(0, 10)}, ${e.category ? `in ${e.category}` : 'waiting to be classified'}.` };
      });
    },

    addIncome: async ({ amount, currency = 'PEN', date, description }) => {
      const m = open();
      const occurredAt = localTime(date ?? today());
      const { id } = m.addExpense({ source: 'manual', kind: 'income', occurredAt, amount: cents(amount), currency, merchant: description.trim(), status: 'classified' });
      return { ok: true, text: `Added income #${id}: ${money(cents(amount), currency)} ${description.trim()} on ${occurredAt.slice(0, 10)}.` };
    },

    /** Only an entry added by hand, never one read from a bank mail. */
    deleteEntry: async ({ id }) => {
      const m = open();
      return change(m, () => {
        const e = m.expense(id);
        if (!e) throw new Error(`no expense ${id}`);
        if (e.source !== 'manual') throw new Error(`#${id} came from a bank mail: only entries added by hand can be deleted`);
        return { reason: `Delete the ${e.kind === 'income' ? 'income' : 'expense'} added by hand ${short(e)}`, protect: true, apply: () => { m.deleteManual(id); return `Deleted #${id}.`; } };
      });
    },

    /** action 'mark' or 'unmark' a recipient (a merchant or recipient name, or its merchant_key) as the user's own account. */
    ownAccount: async ({ action, merchant }) => {
      const m = open();
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
  };
}
