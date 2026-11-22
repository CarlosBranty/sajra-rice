// Money: the expenses Roamies reads from bank notification mails, kept in <data dir>/money.db.
// openMoney() gives the store, the parser bound to the bank definitions (built-in plus <data dir>/banks/*.json),
// ingest (mail → expense, or kept as not understood), the read-only query and the ready summaries.
// Mail access, the bar and the agent's tools build on this; nothing here reads mail or talks to the model.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadDefinitions } from './money/banks.mjs';
import { parseMail } from './money/parse.mjs';
import { runQuery, summaries } from './money/query.mjs';
import { openStore } from './money/store.mjs';
import { DIR } from './store.mjs';

export { BUILTIN, KINDS, NOT_SPENDING, loadDefinitions, validateDefinition } from './money/banks.mjs';
export { checkAuth, htmlToText, maskAccount, merchantKey, parseAmount, parseDate, parseMail } from './money/parse.mjs';
export { checkSelect, runQuery } from './money/query.mjs';
export { DEFAULT_CATEGORIES, SCHEMA_VERSION } from './money/store.mjs';

export function openMoney({ dir = DIR } = {}) {
  const store = openStore(path.join(dir, 'money.db'));
  const { definitions, problems } = loadDefinitions(path.join(dir, 'banks'));
  const parse = (mail) => parseMail(mail, definitions);
  // Changes whenever the loaded definitions do (notes aside): mails they could not read are worth reading again.
  const fingerprint = createHash('sha256').update(JSON.stringify(definitions)).digest('hex').slice(0, 16);
  return {
    ...store,
    ...summaries(store.db),
    definitions,
    /** User definitions that were skipped, with the reason: [{ file, reason }]. */
    problems,
    parseMail: parse,
    fingerprint,
    /** A fetched mail (with the `account` it came from, if any) → { action: 'inserted' | 'duplicate' | 'updated', id }
     * or { action: 'unparsed', reason }. A mail read at last is no longer kept as not understood. */
    ingest(mail) {
      const r = parse(mail);
      if (r.ok) {
        const out = store.addExpense(r.expense);
        if (mail.messageId) store.removeUnparsed(mail.messageId);
        return out;
      }
      const received = mail.date ? new Date(mail.date) : null;
      store.addUnparsed({
        messageId: mail.messageId, sender: mail.from, subject: mail.subject,
        receivedAt: received && !Number.isNaN(received.getTime()) ? received.toISOString() : null, reason: r.reason,
        account: mail.account ?? null, definitions: fingerprint,
      });
      return { action: 'unparsed', reason: r.reason };
    },
    /** Not-understood mails of an account that the current definitions have not tried yet, newest first. */
    toReread: (account, limit) => store.unparsedBefore(fingerprint, account, limit),
    /** A mail to read again is not in the mailbox any more: it is not looked for again until the definitions change. */
    rereadMissed: (messageId) => store.triedWith(messageId, fingerprint),
    query: (sql, opts) => runQuery(store.file, sql, opts),
  };
}
