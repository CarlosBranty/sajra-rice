// The mail providers bank notifications are read from, and what is known about each: its IMAP server (always TLS
// on 993), the folders read, which Authentication-Results header is its own, and its errors in plain words.
// Pure functions, no I/O.
import { createHash } from 'node:crypto';

export const PROVIDERS = {
  // imap.gmail.com:993, implicit TLS (developers.google.com/workspace/gmail/imap/imap-smtp). All Mail holds every
  // mail but Spam and Trash, whatever labels or filters moved it out of the inbox; its name is localized, so it is
  // found by its special-use flag (\All).
  gmail: { label: 'Gmail', host: 'imap.gmail.com', port: 993, all: true, authserv: (id) => id === 'mx.google.com' },
  // imap.mail.yahoo.com:993, SSL required (help.yahoo.com/kb/SLN4075.html). Only the Inbox: the Bulk folder is spam,
  // where look-alike bank mails land; a real one that lands there comes back with "Not spam".
  // Yahoo stamps its results with the receiving host, a yahoo.com name such as atlas321.free.mail.ne1.yahoo.com
  // (public header examples, not a documented list), so any host under yahoo.com counts.
  yahoo: { label: 'Yahoo', host: 'imap.mail.yahoo.com', port: 993, all: false, authserv: (id) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.yahoo\.com$/.test(id) },
  // Outlook.com refuses app passwords: it needs a Microsoft sign-in (OAuth), which is not here yet.
  outlook: { label: 'Outlook', soon: true },
};
export const READY = Object.keys(PROVIDERS).filter((p) => !PROVIDERS[p].soon);

const EMAIL = /^[^@\s,;"<>()\\]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
export const validEmail = (s) => typeof s === 'string' && s.length <= 200 && EMAIL.test(s.trim());

/** The keyring entry of an account: one per provider and address, a name every secret store takes. */
export const accountId = (provider, email) => `mail-${createHash('sha256').update(`${provider}:${String(email).trim().toLowerCase()}`).digest('hex').slice(0, 16)}`;

// ---------- headers ----------

/** A raw mail's header fields, in order (unfolded): [{ name, value }]. */
export function headerFields(source) {
  const s = Buffer.isBuffer(source) ? source.toString('latin1') : String(source ?? '');
  const end = s.search(/\r?\n\r?\n/);
  const out = [];
  for (const line of (end < 0 ? s : s.slice(0, end)).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out.at(-1).value += ' ' + line.trim();
    else {
      const i = line.indexOf(':');
      if (i > 0) out.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
    }
  }
  return out;
}

/** The authserv-id an Authentication-Results value starts with (comments and version dropped), lowercased. */
export function authservId(value) {
  let s = String(value ?? ''), prev;
  do { prev = s; s = s.replace(/\([^()]*\)/g, ' '); } while (s !== prev);
  return s.split(';')[0].trim().split(/\s+/)[0].toLowerCase();
}

/** The one Authentication-Results header the provider itself added: the topmost with its own authserv-id. Any
 * other came with the mail from outside, where a sender can write anything. [] when there is none. */
export function providerAuthResults(source, provider) {
  const own = PROVIDERS[provider]?.authserv;
  if (!own) return [];
  const hit = headerFields(source).find((h) => h.name === 'authentication-results' && own(authservId(h.value)));
  return hit ? [hit.value] : [];
}

// ---------- errors ----------

const NETWORK = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ETIMEDOUT',
  'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectTLS', 'ClosedAfterConnectText']);

/** An IMAP or network error → { code, text } in plain words. code: password, app_password, imap_off, network,
 * certificate, timeout, keyring or other. */
export function plainError(err, provider) {
  const p = PROVIDERS[provider] ?? { label: 'The mail server', host: 'the mail server' };
  const said = String(err?.responseText ?? err?.response ?? '').replace(/\s+/g, ' ').trim();
  const code = String(err?.code ?? '');
  if (code === 'TIMEOUT') return { code: 'timeout', text: `${p.label} took too long to answer. I'll try again later.` };
  if (code === 'KEYRING') return { code: 'keyring', text: String(err.message) };
  if (/not enabled for IMAP|IMAP (access )?(is )?disabled|IMAP.*not (enabled|allowed)/i.test(said)) {
    return { code: 'imap_off', text: `${p.label} has IMAP switched off for this account${provider === 'gmail' ? ' (a work or school account\'s admin may block it)' : ''}.` };
  }
  if (/application-specific password|app password required|web login required/i.test(said)) {
    return { code: 'app_password', text: provider === 'gmail'
      ? 'Gmail wants an app password, not your Google password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.'
      : `${p.label} wants an app password, not your account password.` };
  }
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|invalid credentials|login failed|authentication failed/i.test(said)) {
    return { code: 'password', text: `${p.label} refused the address or app password. Check the address, or create a new app password${provider === 'gmail' ? ' (it needs 2-Step Verification on)' : ''}.` };
  }
  if (/^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|ERR_SSL)/.test(code)) {
    return { code: 'certificate', text: `The secure connection to ${p.host} failed its certificate check, so nothing was sent.` };
  }
  if (NETWORK.has(code)) return { code: 'network', text: `Couldn't reach ${p.host}. Check the internet connection.` };
  return { code: 'other', text: `${p.label} said: ${(said || String(err?.message ?? err)).slice(0, 120)}` };
}
