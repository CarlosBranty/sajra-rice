// Money: the expenses Roamies reads from bank notification mails, kept in <data dir>/money.db.
// openMoney() gives the store, the parser bound to the bank definitions (built-in plus <data dir>/banks/*.json),
// ingest (mail → expense, or kept as not understood), the read-only query and the ready summaries.
// Mail access, the bar and the agent's tools build on this; nothing here reads mail or talks to the model.
import path from 'node:path';
import { loadDefinitions } from './money/banks.mjs';
import { parseMail } from './money/parse.mjs';
import { runQuery, summaries } from './money/query.mjs';
import { openStore } from './money/store.mjs';
import { DIR } from './store.mjs';

export { BUILTIN, KINDS, loadDefinitions, validateDefinition } from './money/banks.mjs';
export { checkAuth, htmlToText, maskAccount, merchantKey, parseAmount, parseDate, parseMail } from './money/parse.mjs';
export { checkSelect, runQuery } from './money/query.mjs';
export { DEFAULT_CATEGORIES, SCHEMA_VERSION } from './money/store.mjs';

export function openMoney({ dir = DIR } = {}) {
  const store = openStore(path.join(dir, 'money.db'));
  const { definitions, problems } = loadDefinitions(path.join(dir, 'banks'));
  const parse = (mail) => parseMail(mail, definitions);
  return {
    ...store,
    ...summaries(store.db),
    definitions,
    /** User definitions that were skipped, with the reason: [{ file, reason }]. */
    problems,
    parseMail: parse,
    /** A fetched mail → { action: 'inserted' | 'duplicate' | 'updated', id } or { action: 'unparsed', reason }. */
    ingest(mail) {
      const r = parse(mail);
      if (r.ok) return store.addExpense(r.expense);
      const received = mail.date ? new Date(mail.date) : null;
      store.addUnparsed({
        messageId: mail.messageId, sender: mail.from, subject: mail.subject,
        receivedAt: received && !Number.isNaN(received.getTime()) ? received.toISOString() : null, reason: r.reason,
      });
      return { action: 'unparsed', reason: r.reason };
    },
    query: (sql, opts) => runQuery(store.file, sql, opts),
  };
}
