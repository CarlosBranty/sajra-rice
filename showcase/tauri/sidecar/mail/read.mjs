// Reading bank mails over IMAP, read-only (imapflow). Every folder is opened with EXAMINE, messages are fetched
// with BODY.PEEK[] (they stay unread), and nothing is ever stored, copied, moved, flagged or deleted on the server.
// The search runs on the server, only for the bank definitions' exact sender addresses and a window: the last
// DAYS days the first time (or after the folder was renumbered), then only UIDs after the last one looked at.
import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PROVIDERS, headerFields, providerAuthResults } from './providers.mjs';

export const DAYS = 90;
// At most this many mails per folder and run; the rest come on the next run.
export const MAX_PER_RUN = 300;

/** imapflow's options for an account: TLS to the provider's server with certificate checks left on, no logging (the
 * sidecar's stdout is its protocol, and logs could carry mail data). `server` replaces host/port/secure in tests. */
export function clientOptions({ provider, email, password, server = null }) {
  const p = PROVIDERS[provider];
  if (!p || p.soon) throw new Error(`not a provider that takes an app password: ${provider}`);
  const where = server ?? { host: p.host, port: p.port, secure: true };
  return {
    host: where.host, port: where.port, secure: where.secure,
    auth: { user: email, pass: password }, logger: false, emitLogs: false, disableAutoIdle: true, clientInfo: { name: 'Roamies' },
    connectionTimeout: 30_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  };
}

/** Connects, runs fn(client), and always logs out (or drops the connection). An aborted signal closes it at once. */
export async function withClient(opts, fn, signal = null) {
  const client = new ImapFlow(clientOptions(opts));
  client.on('error', () => {}); // a failure reaches the awaited call too
  const abort = () => client.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    await client.connect();
    return await fn(client);
  } catch (e) {
    throw signal?.aborted ? Object.assign(new Error('timed out'), { code: 'TIMEOUT' }) : e;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (client.usable) await client.logout().catch(() => client.close()); else client.close();
  }
}

/** The folders read for a provider: Gmail's All Mail (by its \All flag; the Inbox if it is hidden from IMAP), else the Inbox. */
export async function folders(client, provider) {
  if (!PROVIDERS[provider].all) return ['INBOX'];
  const list = await client.list();
  return [list.find((f) => f.specialUse === '\\All' || f.flags?.has('\\All'))?.path ?? 'INBOX'];
}

// Opens a folder read-only (EXAMINE) and refuses to go on if the server did not say READ-ONLY.
async function examine(client, folder) {
  const box = await client.mailboxOpen(folder, { readOnly: true });
  if (!box.readOnly) throw new Error(`${folder} did not open read-only`);
  return box;
}

// The UIDs from the senders inside the window, ascending, after `after`.
async function find(client, senders, window, after) {
  const uids = new Set();
  for (const from of senders) for (const u of (await client.search({ ...window, from }, { uid: true })) || []) if (u > after) uids.add(u);
  return [...uids].sort((a, b) => a - b);
}

const sinceDate = (now) => new Date(now - DAYS * 86_400_000);

/** A raw mail → what parseMail reads. Only the provider's own Authentication-Results header goes with it. */
export async function toMail(source, provider) {
  const parsed = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true, keepCidLinks: true });
  const from = headerFields(source).filter((h) => h.name === 'from').map((h) => h.value);
  return {
    from: from.join(', '), subject: parsed.subject ?? '', date: parsed.date ? parsed.date.toISOString() : null,
    messageId: parsed.messageId ?? `<missing-${createHash('sha256').update(source).digest('hex').slice(0, 32)}@roamies>`,
    html: parsed.html || null, text: parsed.text || null, authResults: providerAuthResults(source, provider),
  };
}

/** Counts the bank mails of the last DAYS days, to test an account. → { folder, count } */
export function testAccount(opts, senders, { now = Date.now(), signal } = {}) {
  return withClient(opts, async (client) => {
    const [folder] = await folders(client, opts.provider);
    await examine(client, folder);
    return { folder, count: (await find(client, senders, { since: sinceDate(now) }, 0)).length };
  }, signal);
}

/** Reads the new bank mails of an account into the money store. `cursors`: openCursors(); `ingest`: money.ingest.
 * → { found, inserted, updated, duplicate, unparsed } */
export function readAccount(opts, { senders, cursors, ingest, now = Date.now(), signal, max = MAX_PER_RUN }) {
  return withClient(opts, async (client) => {
    const out = { found: 0, inserted: 0, updated: 0, duplicate: 0, unparsed: 0 };
    for (const folder of await folders(client, opts.provider)) {
      const box = await examine(client, folder);
      const validity = String(box.uidValidity), cur = cursors.get(opts.id, folder);
      const after = cur && cur.uidValidity === validity ? cur.lastUid : 0;
      const uids = await find(client, senders, after ? { uid: `${after + 1}:*` } : { since: sinceDate(now) }, after);
      const take = uids.slice(0, max);
      for (const msg of take.length ? await client.fetchAll(take.join(','), { uid: true, source: true }, { uid: true }) : []) {
        const r = ingest(await toMail(msg.source, opts.provider));
        out.found++; out[r.action]++;
      }
      // Everything in the folder up to UIDNEXT has been looked at, unless the run stopped at `max`.
      const seen = take.length < uids.length ? take.at(-1) : Math.max(after, take.at(-1) ?? 0, Number(box.uidNext ?? 1) - 1);
      cursors.set(opts.id, folder, validity, seen);
    }
    return out;
  }, signal);
}
