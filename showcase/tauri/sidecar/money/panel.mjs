// The panel's Money page, sidecar side: the movements table (filtered, paged, with totals) and the changes made
// there. Messages come from the panel's webview ({ type: 'panel_money', op, ... }) and are never trusted: each is
// checked field by field (types, lengths, the month, ids that exist) before anything is read or changed. Changes are
// the shared operations of ops.mjs, the agent's own: protected ones ask authorize(reason) (the prompt shows by the
// Roamie) and change nothing unless the user confirms.
import { z } from 'zod';
import { INCOME_KINDS, OWN_KINDS } from './banks.mjs';
import { isExpense, localDay, money, moneyOps } from './ops.mjs';

const PER = 50;
const KIND = {
  purchase: 'Purchase', transfer_out: 'Transfer', yape_out: 'Yape', withdrawal: 'Withdrawal', payment: 'Payment',
  transfer_in: 'Received', income: 'Income', own_transfer: 'Own transfer', rejected: 'Refused',
};
const STATUS = { pending: 'Waiting', classified: 'Classified', needs_review: 'Needs review', ignored: 'Not counted' };

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(id).min(1).max(200);
const category = z.string().trim().min(1).max(40);
const query = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).or(z.literal('')).optional(),
  category: category.nullable().optional(), // null: the expenses not classified yet
  group: z.enum(['all', 'spending', 'income', 'other']).optional(),
  text: z.string().max(200).optional(),
  page: z.number().int().min(0).max(1e6).optional(),
  per: z.number().int().min(1).max(PER).optional(),
}).strict();
// "20", "20.5", "1234,50": soles or dollars as typed, more than 0 and at most 100,000,000 (as the agent's tools).
const amount = z.string().trim().regex(/^\d{1,9}([.,]\d{1,2})?$/, 'an amount like 20.50').transform((s) => Number(s.replace(',', '.')))
  .pipe(z.number().positive().max(100000000));
const withQuery = { query: query.optional() };
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a date like 2026-10-26');
const look = { period: day.optional(), range: z.enum(['1m', '3m', '6m', '1y']).optional() };
// The overview to answer with after a change (the period and range the page shows); today's period if left out.
const withLook = { look: z.object(look).strict().optional() };
const note = z.string().max(200).nullable(); // '' or null: no note
const MESSAGES = {
  list: z.object({ ...withQuery }).strict(),
  classify: z.object({ ids, category, create: z.boolean().optional(), note: note.optional(), ...withQuery }).strict(),
  unclassify: z.object({ ids, ...withQuery }).strict(),
  rename_category: z.object({ from: category, to: category, ...withQuery }).strict(),
  delete_category: z.object({ name: category, ...withQuery }).strict(),
  add_entry: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('expense'), category: category.optional() }),
    z.object({ kind: z.literal('income') }),
  ].map((o) => o.extend({
    amount, currency: z.enum(['PEN', 'USD']).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    description: z.string().trim().min(1).max(200), ...withQuery,
  }).strict())),
  delete_entry: z.object({ id, ...withQuery }).strict(),
  own: z.object({ action: z.enum(['mark', 'unmark']), key: z.string().trim().min(1).max(200), ...withQuery }).strict(),
  // The overview (pay periods, S12) and the changes made from it; each answers with the overview.
  overview: z.object(look).strict(),
  edit_entry: z.object({
    id, amount: amount.or(z.number().positive().max(100000000)).optional(), currency: z.enum(['PEN', 'USD']).optional(), date: day.optional(),
    description: z.string().trim().min(1).max(200).optional(), category: category.nullable().optional(), kind: z.enum(['expense', 'income']).optional(),
    salary: z.boolean().optional(), note: note.optional(), ...withLook,
  }).strict(),
  revert_entry: z.object({ id, ...withLook }).strict(),
  set_salary: z.object({ id, on: z.boolean(), ...withLook }).strict(),
};
const OVERVIEW = new Set(['overview', 'edit_entry', 'revert_entry', 'set_salary']);

/** money(): the open money store; today(): the local date; authorize(reason): as for the agent's tools (ops.mjs). */
export function moneyPanel({ money: open, today = localDay, authorize }) {
  const ops = moneyOps({ money: open, today, authorize });

  // A stored row → what the page shows: in plain words, the amount as the tools say it.
  const shape = (m, names) => (e) => ({
    id: e.id, date: e.occurred_at.slice(0, 10), time: e.occurred_at.slice(11, 16),
    text: e.merchant ?? e.note ?? KIND[e.kind] ?? e.kind,
    note: e.merchant && e.note ? e.note : null,
    source: e.source === 'manual' ? 'By hand' : names[e.source] ?? e.source,
    kind: KIND[e.kind] ?? e.kind, amount: money(e.amount, e.currency), currency: e.currency, category: e.category,
    status: e.status !== 'ignored' && INCOME_KINDS.includes(e.kind) ? 'Income' : STATUS[e.status] ?? e.status,
    classifiable: isExpense(e), manual: e.source === 'manual',
    own: OWN_KINDS.includes(e.kind) && e.merchant_key ? e.merchant_key : null, // a recipient that can be marked as the user's own
  });

  function view(q = {}) {
    const m = open();
    const per = q.per ?? PER;
    const filter = { month: q.month || undefined, category: q.category, group: q.group === 'all' ? undefined : q.group, text: q.text };
    const { total } = m.movements({ ...filter, limit: 0 });
    const pages = Math.max(1, Math.ceil(total / per)), page = Math.min(q.page ?? 0, pages - 1);
    const r = m.movements({ ...filter, offset: page * per, limit: per });
    const names = Object.fromEntries(m.definitions.map((d) => [d.id, d.name]));
    return {
      query: q, rows: r.rows.map(shape(m, names)), total, page, pages, per,
      totals: r.totals.map((t) => ({ currency: t.currency, spent: money(t.spent, t.currency), received: money(t.received, t.currency), count: t.count })),
      months: m.months(), categories: m.categories(),
      own: m.ownAccounts().map((o) => ({ key: o.merchant_key, name: o.merchant ?? o.merchant_key, count: o.count })),
    };
  }

  async function run(op, a) {
    switch (op) {
      case 'list': return { ok: true };
      case 'classify': {
        // A new category typed in the same control: made first (kept even if the change is then refused).
        if (a.create && !open().categories().some((c) => c.toLowerCase() === a.category.toLowerCase())) await ops.addCategory({ name: a.category });
        return ops.classify({ category: a.category, ids: a.ids, ...(a.note !== undefined && { note: a.note }) });
      }
      case 'unclassify': return ops.unclassify({ ids: a.ids });
      case 'rename_category': return ops.renameCategory({ from: a.from, to: a.to });
      case 'delete_category': return ops.deleteCategory({ name: a.name });
      case 'add_entry': return a.kind === 'income'
        ? ops.addIncome({ amount: a.amount, currency: a.currency, date: a.date, description: a.description })
        : ops.addExpense({ amount: a.amount, currency: a.currency, date: a.date, description: a.description, category: a.category });
      case 'delete_entry': return ops.deleteEntry({ id: a.id });
      case 'own': return ops.ownAccount({ action: a.action, merchant: a.key });
      case 'overview': return { ok: true };
      case 'edit_entry': {
        const { id: entry, look: _, ...fields } = a;
        return ops.editEntry({ id: entry, ...fields });
      }
      case 'revert_entry': return ops.revertEntry({ id: a.id });
      case 'set_salary': return ops.setSalary({ id: a.id, on: a.on });
    }
  }

  return {
    /** A message from the page → { ok, text?, view? }: view is the table again (with the query the page sent), after
     * any change; text says what happened or why nothing did. Never throws. */
    async handle(msg) {
      const op = msg?.op, schema = typeof op === 'string' && Object.hasOwn(MESSAGES, op) ? MESSAGES[op] : null;
      if (!schema) return { ok: false, text: 'That is not something the Money page can do.' };
      const { op: _, type: __, ...rest } = msg;
      const parsed = schema.safeParse(rest);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        return { ok: false, text: `Not changed: ${i.path.join('.') || 'the request'}: ${i.message}` };
      }
      const a = parsed.data;
      let r;
      try {
        r = await run(op, a);
      } catch (e) {
        return { ok: false, text: `${op === 'list' ? "Couldn't list" : op === 'overview' ? "Couldn't show it" : 'Not changed'}: ${String(e?.message ?? e).slice(0, 200)}` };
      }
      // The overview ops answer with the overview ({ kind: 'money', view: 'overview', ... }), the rest with the table.
      if (OVERVIEW.has(op)) {
        try {
          return { ...r, view: await ops.overview(op === 'overview' ? a : a.look ?? {}) };
        } catch (e) {
          return { ...r, ok: op === 'overview' ? false : r.ok, text: r.text ?? `Couldn't show it: ${String(e?.message ?? e).slice(0, 200)}` };
        }
      }
      try {
        return { ...r, view: view(a.query) };
      } catch (e) {
        // After a change, the category the table was filtered by may be gone (renamed, deleted): the table without it.
        const { category: dropped, ...rest } = a.query ?? {};
        if (op !== 'list' && typeof dropped === 'string') {
          try { return { ...r, view: { ...view(rest), dropped } }; } catch { /* said below */ }
        }
        return { ...r, ok: op === 'list' ? false : r.ok, text: r.text ?? `Couldn't list: ${String(e?.message ?? e).slice(0, 200)}` };
      }
    },
    view,
  };
}
