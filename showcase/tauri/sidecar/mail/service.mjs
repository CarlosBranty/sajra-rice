// Money's mail accounts and the reading of them while the app runs. The settings keep each account's provider and
// email; its app password is only in the system keyring (secrets.mjs, one entry per account), read when a run
// connects and sent nowhere but to the provider's IMAP server over TLS. With no account nothing runs: no timer,
// no keyring read, no database opened, no connection.
// Runs go one at a time (so one connection per account at most), each with a hard time limit; an account that fails
// waits longer each time (up to an hour). After each run, onPending(n) says how many expenses wait for the user.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openCursors } from './cursors.mjs';
import { PROVIDERS, READY, accountId, plainError, validEmail } from './providers.mjs';
import { REREAD_PER_RUN, readAccount, testAccount } from './read.mjs';

export const EVERY = [2, 5, 15, 30, 60]; // minutes between checks; 5 by default
export const DEFAULT_EVERY = 5;
const MAX_WAIT = 60 * 60_000;
const START_DELAY = 15_000; // the first run waits a little, so it never slows the app's start
const label = (a) => `${PROVIDERS[a.provider]?.label ?? a.provider} (${a.email})`;

/**
 * settings(): the saved settings ({ mailAccounts: [{ provider, email }], mailEvery }); save(): writes them.
 * openMoney(): the money store (money.mjs), opened on the first run. server: tests only (read.mjs clientOptions).
 */
export function createMail({ secrets, settings, save, openMoney, dir, server = null, log = () => {}, onChange = () => {}, onPending = () => {},
  schedule = setTimeout, unschedule = clearTimeout, now = Date.now, timeoutMs = 120_000 }) {
  const status = new Map(); // id → { state: 'checking' | 'ok' | 'error', text, at, fails, due }
  let timer = null, running = null, money = null, cursors = null, pending = 0, stopped = false;

  const accounts = () => (Array.isArray(settings().mailAccounts) ? settings().mailAccounts : [])
    .filter((a) => READY.includes(a?.provider) && validEmail(a?.email)).map((a) => ({ id: accountId(a.provider, a.email), provider: a.provider, email: a.email }));
  const every = () => (EVERY.includes(settings().mailEvery) ? settings().mailEvery : DEFAULT_EVERY) * 60_000;
  const store = () => {
    money ??= openMoney();
    cursors ??= openCursors(path.join(dir, 'mail.db'));
    return { money, cursors };
  };
  const senders = () => [...new Set(store().money.definitions.flatMap((d) => d.senders))];

  async function password(a) {
    let p;
    try { p = await secrets.get(a.id); } catch (e) { throw Object.assign(new Error(`I couldn't read the app password from the keyring: ${String(e?.message ?? e).slice(0, 120)}`), { code: 'KEYRING' }); }
    if (!p) throw Object.assign(new Error('The app password is not in the keyring any more. Remove the account and add it again.'), { code: 'KEYRING' });
    return p;
  }
  // fn(signal) with a hard limit: past it the connection is closed and the run fails with a timeout.
  async function limited(fn) {
    const ac = new AbortController();
    const t = schedule(() => ac.abort(), timeoutMs);
    try { return await fn(ac.signal); } finally { unschedule(t); }
  }

  async function runAccount(a) {
    const s = status.get(a.id) ?? { fails: 0 };
    status.set(a.id, { ...s, state: 'checking', text: 'Checking…' });
    onChange();
    try {
      const pass = await password(a);
      const { money: m, cursors: c } = store();
      const r = await limited((signal) => readAccount({ ...a, password: pass, server }, {
        senders: senders(), cursors: c, ingest: m.ingest, now: now(), signal,
        rereads: () => m.toReread(a.id, REREAD_PER_RUN).map((u) => u.message_id), missed: m.rereadMissed, deadline: Date.now() + timeoutMs / 2,
      }));
      log('mail', { provider: a.provider, ...r });
      status.set(a.id, { state: 'ok', text: r.found ? `Read ${r.found} new bank mail${r.found === 1 ? '' : 's'}` : 'No new bank mails', at: now(), fails: 0, due: now() + every() });
    } catch (e) {
      const err = plainError(e, a.provider), fails = (s.fails ?? 0) + 1;
      log('mail', { provider: a.provider, error: err.code });
      status.set(a.id, { state: 'error', text: err.text, code: err.code, at: now(), fails, due: now() + Math.min(every() * 2 ** fails, MAX_WAIT) });
    }
  }

  // One run over the accounts that are due (all of them when forced); then the pending count, then the next wake-up.
  async function tick(force = false) {
    timer = null;
    if (running || stopped) return running;
    running = (async () => {
      for (const a of accounts()) if (force || (status.get(a.id)?.due ?? 0) <= now()) await runAccount(a);
      if (money) { pending = money.pending().length; onPending(pending); }
    })().finally(() => { running = null; onChange(); plan(); });
    return running;
  }
  function plan(delay = null) {
    if (timer) { unschedule(timer); timer = null; }
    const list = accounts();
    if (stopped || !list.length || running) return;
    const next = delay ?? Math.max(1000, Math.min(...list.map((a) => (status.get(a.id)?.due ?? now() + START_DELAY) - now())));
    timer = schedule(() => tick(), next);
    timer?.unref?.();
  }

  return {
    /** Starts reading if there is an account (call once, at launch). */
    start() { stopped = false; plan(); },
    stop() { stopped = true; if (timer) unschedule(timer); timer = null; },
    /** After the accounts or the interval changed. */
    refresh: () => plan(),
    /** Reads every account now, due or not. */
    runNow: () => tick(true),
    /** Expenses waiting for the user after the last run. */
    pending: () => pending,
    /** The money store, opened on first use (the agent's money tools share it with the reader). */
    money: () => store().money,
    /** For the panel: each account and how its last check went. */
    list: () => accounts().map((a) => ({ ...a, label: PROVIDERS[a.provider].label, status: status.get(a.id) ? { state: status.get(a.id).state, text: status.get(a.id).text, at: status.get(a.id).at ?? null } : null })),
    every: () => every() / 60_000,

    /** → { ok, text }. The password is saved to the keyring before the account is added to the settings. */
    async add({ provider, email, password: pass }) {
      if (PROVIDERS[provider]?.soon) return { ok: false, text: `${PROVIDERS[provider].label} isn't supported yet: it needs a Microsoft sign-in.` };
      if (!READY.includes(provider)) return { ok: false, text: 'Pick Gmail or Yahoo.' };
      const addr = String(email ?? '').trim().toLowerCase();
      if (!validEmail(addr)) return { ok: false, text: 'That is not an email address.' };
      const key = String(pass ?? '').replace(/\s+/g, ''); // shown in groups of four with spaces
      if (!/^[\x21-\x7e]{8,200}$/.test(key)) return { ok: false, text: 'Paste the app password the provider made for Roamies.' };
      const id = accountId(provider, addr);
      if (accounts().some((a) => a.id === id)) return { ok: false, text: `${label({ provider, email: addr })} is already added.` };
      try { await secrets.set(id, key); } catch (e) {
        return { ok: false, text: `I couldn't save the app password safely, so the account wasn't added: ${String(e?.message ?? e).slice(0, 140)}` };
      }
      save({ mailAccounts: [...(settings().mailAccounts ?? []), { provider, email: addr }] });
      status.delete(id);
      plan(START_DELAY);
      return { ok: true, id, text: `${label({ provider, email: addr })} added. I'll read its bank mails every ${every() / 60_000} minutes.` };
    },

    /** Deletes the keyring entry, then the account; the entry failing to go keeps the account (and says so). */
    async remove(id) {
      const a = accounts().find((x) => x.id === id);
      if (!a) return { ok: false, text: 'That account is not there any more.' };
      try { await secrets.delete(id); } catch (e) {
        return { ok: false, text: `I couldn't remove the app password from the keyring, so the account stays: ${String(e?.message ?? e).slice(0, 140)}` };
      }
      save({ mailAccounts: (settings().mailAccounts ?? []).filter((x) => accountId(x?.provider, x?.email) !== id) });
      status.delete(id);
      if (cursors || existsSync(path.join(dir, 'mail.db'))) (cursors ??= openCursors(path.join(dir, 'mail.db'))).forget(id);
      plan();
      return { ok: true, text: `${label(a)} removed, and its app password deleted from the keyring.` };
    },

    /** Logs in, opens the folder read-only and counts the bank mails of the last 90 days. → { ok, text } */
    async test(id) {
      const a = accounts().find((x) => x.id === id);
      if (!a) return { ok: false, text: 'That account is not there any more.' };
      try {
        const pass = await password(a);
        const { folder, count } = await limited((signal) => testAccount({ ...a, password: pass, server }, senders(), { now: now(), signal }));
        return { ok: true, text: `Connected to ${PROVIDERS[a.provider].label}, read-only: ${count} bank mail${count === 1 ? '' : 's'} in the last 90 days (${folder}).` };
      } catch (e) {
        return { ok: false, text: plainError(e, a.provider).text };
      }
    },
  };
}
