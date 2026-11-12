// The changes to the user's money records, one function per operation, shared by the agent's tools (tools.mjs) and
// the panel's Money page (panel.mjs) so both do exactly the same. Changes that undo what the user already decided
// (renaming or deleting a category, changing or removing a classification, deleting an entry, marking or unmarking an
// own account over classified transfers) first ask authorize(reason) for the user's password or fingerprint and
// change nothing unless it answers true. Each operation → { ok, text } (ok: false when nothing was changed because
// the user did not confirm), or throws why it cannot be done.
import { INCOME_KINDS, NOT_SPENDING } from './banks.mjs';
import { merchantKey } from './parse.mjs';
import { addDays, periodOf, periodsFor, weekStart } from './periods.mjs';

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
/** How an entry counts: 'income', 'expense', or 'other' (not counted: moved between own accounts, refused, ignored). */
export const direction = (e) => (e.status === 'ignored' || (NOT_SPENDING.includes(e.kind) && !INCOME_KINDS.includes(e.kind)) ? 'other'
  : INCOME_KINDS.includes(e.kind) ? 'income' : 'expense');
const isIncome = (e) => direction(e) === 'income';
const MAIN = 'PEN';
const cleanNote = (n) => (n == null ? null : String(n).trim().slice(0, 200) || null);
const RANGE_DAYS = { '1m': 30, '3m': 91, '6m': 182, '1y': 365 };

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
  const sourceName = (m, source) => (source === 'manual' ? 'By hand' : m.definitions?.find((d) => d.id === source)?.name ?? source.toUpperCase());
  // "the BCP expense of S/ 45.00 on 2026-10-03": how an entry is named in an edit's confirmation.
  const named = (m, e) => `the ${e.source === 'manual' ? 'hand-added' : sourceName(m, e.source)} ${{ income: 'income', expense: 'expense', other: 'entry' }[direction(e)]} of ${money(e.amount, e.currency)} on ${e.occurred_at.slice(0, 10)}`;

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

    /** By ids, or every expense of a merchant; learn: the merchant's next expenses arrive in that category; note (only
     * with ids): what the user said about them, set on each (never protected by itself). */
    classify: async ({ category, ids, merchant, learn = true, note }) => {
      const m = open();
      if (!ids?.length && !merchant) throw new Error('say which expenses: ids or a merchant');
      if (note !== undefined && !ids?.length) throw new Error('a note goes with ids, not with every expense of a merchant');
      const noted = note === undefined ? null : cleanNote(note);
      const setNote = (rows) => { if (note !== undefined) for (const e of rows) if (e.note !== noted) m.editEntry(e.id, { note: noted }); };
      return change(m, () => {
        const name = m.categoryName(category);
        const rows = ids?.length
          ? ids.map((id) => expenseById(m, id))
          : m.db.prepare('SELECT * FROM expenses WHERE merchant_key = ? ORDER BY occurred_at, id').all(m.recipientKey(merchant)).filter(isExpense);
        if (!rows.length) throw new Error(`no expenses from ${merchant}`);
        for (const e of rows) if (!isExpense(e)) throw new Error(`#${e.id} is ${NOT_EXPENSE[e.kind] ?? 'not counted as spending'}, not an expense to classify`);
        const todo = rows.filter((e) => e.category !== name);
        const withNote = note === undefined ? '' : noted ? ` with the note "${noted}"` : ' and remove their note';
        if (!todo.length) {
          return { reason: '', protect: false, apply: () => { setNote(rows); return `${note === undefined ? 'Nothing to change: ' : noted ? `Set the note "${noted}"; ` : 'Removed the note; '}${rows.length === 1 ? 'it is' : `all ${rows.length} are`} already in ${name}.`; } };
        }
        const moved = todo.filter((e) => e.category), fresh = todo.length - moved.length;
        const reason = moved.length
          ? `Change the category of ${count(moved.length)}: ${some(moved, (e) => `${short(e)}, from ${e.category} to ${name}`)}${fresh ? `; and put ${count(fresh)} with no category in ${name}` : ''}`
          : `Put ${count(todo.length)} in ${name}`;
        return {
          reason, protect: moved.length > 0,
          apply: () => { for (const e of todo) m.classify(e.id, name, { learn }); setNote(rows); return `Put ${count(todo.length)} in ${name}${withNote}.`; },
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

    /** Corrects an entry: amount (soles or dollars), currency, date (YYYY-MM-DD; the time of day stays), description,
     * category (a name; null or '' removes it), note (what the user says about it; null or '' removes it; never
     * protected and never counted as an edit), kind 'expense' | 'income', salary. Every entry is editable. Asks
     * authorize first when a field a bank mail gave (amount, currency, date, description) changes on an entry read from
     * a mail (its values are then kept in `original`, so revertEntry can put them back, and a later read of the mail
     * never overwrites the correction), and when a category the entry already has is changed or removed (as classify
     * does). Kind: only entries added by hand switch between expense and income (an expense becomes kind 'purchase',
     * waiting for a category; an income is kind 'income' with no category); an entry read from a mail keeps the kind
     * the bank said (a transfer to the user's own account is marked with ownAccount instead). */
    editEntry: async ({ id, amount, currency, date, description, category, kind, salary, note }) => {
      const m = open();
      return change(m, () => {
        const e = expenseById(m, id);
        const manual = e.source === 'manual', set = {}, said = [];
        if (kind !== undefined && kind !== direction(e)) {
          if (!manual || direction(e) === 'other') throw new Error(`#${id} came from a bank mail: it stays the kind the bank said (a transfer to the user's own account is marked as an own account instead)`);
          if (kind === 'income') Object.assign(set, { kind: 'income', category: null, status: 'classified' });
          else Object.assign(set, { kind: 'purchase', status: 'pending', salary: 0 });
          said.push(kind === 'income' ? 'make it an income' : 'make it an expense');
        }
        const after = { ...e, ...set };
        if (amount !== undefined && cents(amount) !== e.amount) { set.amount = cents(amount); said.push(`amount to ${money(set.amount, currency ?? e.currency)}`); }
        if (currency !== undefined && currency !== e.currency) { set.currency = currency; said.push(`currency to ${currency}`); }
        if (date !== undefined) {
          localTime(date); // checks it
          const at = `${date}${e.occurred_at.slice(10)}`;
          if (at !== e.occurred_at) { set.occurred_at = at; said.push(`date to ${date}`); }
        }
        if (description !== undefined) {
          const d = String(description).trim();
          if (!d) throw new Error('a description is not empty');
          // An entry read from a mail keeps the bank's recipient key (its rules and own account follow it).
          if (d !== e.merchant) { set.merchant = d; if (manual) set.merchant_key = merchantKey(d) || null; said.push(`description to "${d}"`); }
        }
        let moved = false;
        if (category !== undefined) {
          const name = category === null || category === '' ? null : m.categoryName(category);
          const was = after.category;
          if (name && direction(after) !== 'expense') throw new Error(`#${id} is not an expense: only expenses have a category`);
          if (name !== was) {
            set.category = name;
            set.status = name ? 'classified' : after.status === 'classified' && direction(after) === 'expense' ? 'pending' : after.status;
            moved = was != null;
            said.push(name ? `category ${was ? `from ${was} ` : ''}to ${name}` : `remove the category ${was}`);
          }
        }
        if (salary !== undefined && (salary ? 1 : 0) !== ('salary' in set ? set.salary : e.salary)) {
          if (salary && direction(after) !== 'income') throw new Error(`#${id} is not an income: only income can be the salary`);
          set.salary = salary ? 1 : 0;
          said.push(salary ? 'mark it as the salary' : 'unmark it as the salary');
        }
        if (note !== undefined && cleanNote(note) !== e.note) {
          set.note = cleanNote(note);
          said.push(set.note ? `note "${set.note}"` : 'remove the note');
        }
        if (!said.length) return { reason: '', protect: false, apply: () => `Nothing to change in #${id}.` };
        const bankEdit = !manual && ['amount', 'currency', 'occurred_at', 'merchant'].some((k) => k in set);
        return {
          reason: `Edit ${named(m, e)}: ${said.join(', ')}`, protect: bankEdit || moved,
          apply: () => { m.editEntry(id, set); return `Edited #${id}: ${said.join(', ')}.`; },
        };
      });
    },

    /** Puts back what the bank mail said in an entry the user edited (always asks authorize). */
    revertEntry: async ({ id }) => {
      const m = open();
      return change(m, () => {
        const e = expenseById(m, id);
        if (!e.original) throw new Error(`#${id} has nothing to revert: it was never edited from what a bank mail said`);
        const o = JSON.parse(e.original);
        return {
          reason: `Revert ${named(m, e)} to what the bank mail said: ${money(o.amount, o.currency)} on ${o.occurred_at.slice(0, 10)}, "${o.merchant ?? ''}"`, protect: true,
          apply: () => { m.revertEntry(id); return `Reverted #${id} to what the bank mail said.`; },
        };
      });
    },

    /** Marks (on) or unmarks an income as the user's salary: pay periods start on its date. Not protected. */
    setSalary: async ({ id, on }) => {
      const m = open();
      const e = expenseById(m, id);
      if (on && !isIncome(e)) throw new Error(`#${id} is not an income: only income can be the salary`);
      m.setSalary(id, on);
      return { ok: true, text: on ? `#${id} is the salary: a pay period starts on ${e.occurred_at.slice(0, 10)}.` : `#${id} is no longer the salary.` };
    },

    /** The pay periods (periods.mjs) and the one holding `period` (any date in it; today's if left out) with its carry-in,
     * income, spending and balance (carry-in + income - spending) per currency; its movements by week, newest first;
     * its sources; the end-of-day balance of the main currency over `range` up to today; the categories. Amounts in cents. */
    overview: async ({ period, range = '1m' } = {}) => {
      const m = open();
      const t = today();
      const periods = periodsFor({ salaries: m.salaryDates(), first: m.firstDay(), today: t });
      const p = period ? periodOf(periods, period) : periodOf(periods, t) ?? periods.at(-1);
      if (!p) throw new Error(`no period holds ${period}`);
      const days = m.dailyTotals();
      const sums = (currency) => {
        let carry = 0, income = 0, spending = 0;
        for (const d of days) {
          if (d.currency !== currency) continue;
          if (d.day < p.start) carry += d.income - d.spending;
          else if (d.day <= p.end) { income += d.income; spending += d.spending; }
        }
        return { currency, carry_in: carry, income, spending, balance: carry + income - spending };
      };
      const { currency: _, ...main } = sums(MAIN);
      const rows = m.between(p.start, p.end);
      const weeks = [];
      for (const e of rows) {
        const day = e.occurred_at.slice(0, 10), from = weekStart(day) < p.start ? p.start : weekStart(day);
        if (weeks.at(-1)?.from !== from) weeks.push({ from, to: addDays(weekStart(day), 6) > p.end ? p.end : addDays(weekStart(day), 6), items: [] });
        weeks.at(-1).items.push({
          id: e.id, date: day, kind: direction(e), amount: e.amount, currency: e.currency, description: e.merchant ?? e.note ?? e.kind, category: e.category,
          source: e.source, salary: e.salary === 1, edited: e.edited_at != null, editable: true, protected: e.source !== 'manual', revertible: e.original != null, note: e.note,
        });
      }
      const accounts = [...new Set(rows.map((e) => e.source))].sort().map((source) => {
        const of = rows.filter((e) => e.source === source), main_ = of.filter((e) => e.currency === MAIN);
        const total = (list) => list.reduce((s, e) => s + e.amount, 0);
        return { source, label: sourceName(m, source), income: total(main_.filter(isIncome)), spending: total(main_.filter(isExpense)), count: of.length };
      });
      const from = addDays(t, -RANGE_DAYS[range]);
      let balance = 0;
      const daily = new Map();
      for (const d of days) {
        if (d.currency !== MAIN) continue;
        if (d.day < from) balance += d.income - d.spending;
        else daily.set(d.day, d.income - d.spending);
      }
      const points = [];
      for (let day = from; day <= t; day = addDays(day, 1)) { balance += daily.get(day) ?? 0; points.push({ date: day, balance }); }
      return {
        kind: 'money', view: 'overview', currency: MAIN, periods,
        period: { start: p.start, end: p.end, ...main, by_currency: [...new Set(days.filter((d) => d.day <= p.end).map((d) => d.currency))].sort().map(sums) },
        weeks, accounts, series: { range, points }, categories: m.categories(),
      };
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
