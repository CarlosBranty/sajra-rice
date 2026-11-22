// Money's mail reading (mail/*.mjs) against a fake IMAP server: read-only (EXAMINE, BODY.PEEK[], nothing stored,
// copied, moved or deleted), a server-side search for the definitions' senders inside the date or UID window,
// each mail ingested once, only the provider's own Authentication-Results trusted, app passwords only in the
// keyring, errors in plain words with backoff, and nothing at all without an account. Synthetic mails only;
// a throwaway data folder. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openMoney, parseMail, BUILTIN } from '../money.mjs';
import { PROVIDERS, READY, accountId, authservId, plainError, providerAuthResults, validEmail } from '../mail/providers.mjs';
import { DAYS, clientOptions, readAccount, toMail } from '../mail/read.mjs';
import { openCursors } from '../mail/cursors.mjs';
import { DEFAULT_EVERY, EVERY, createMail } from '../mail/service.mjs';
import { fakeImap } from './fake-imap.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-mail-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const fixture = (f) => fs.readFileSync(fileURLToPath(new URL(`fixtures/money/${f}`, import.meta.url)), 'utf8');

const BCP = 'notificaciones@notificacionesbcp.com.pe', FALABELLA = 'notificaciones@pe.notificaciones.bancofalabella.com';
const pass = (domain) => `dkim=pass header.i=@${domain} header.s=s1 header.b=AbCd; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`;
const raw = ({ from, subject, html, auth = [], id, date = Date.now() - 86_400_000 }) => [
  ...auth.map((a) => `Authentication-Results: ${a}`),
  `From: Banco <${from}>`, 'To: someone@example.test', `Subject: ${subject}`, `Date: ${new Date(date).toUTCString()}`, `Message-ID: ${id}`,
  'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', html, ''].join('\r\n');

// ---------- providers ----------
assert.deepEqual(READY, ['gmail', 'yahoo'], 'Outlook is shown but not usable yet');
assert.equal(PROVIDERS.outlook.soon, true);
for (const [p, host] of [['gmail', 'imap.gmail.com'], ['yahoo', 'imap.mail.yahoo.com']]) {
  const o = clientOptions({ provider: p, email: 'a@b.test', password: 'pw' });
  assert.equal(o.host, host); assert.equal(o.port, 993); assert.equal(o.secure, true, `${p}: TLS from the first byte`);
  assert.equal(o.tls, undefined, 'certificate checks are never relaxed');
  assert.equal(o.logger, false, 'no logging: stdout is the protocol and logs could carry mail');
  assert.equal(o.disableAutoIdle, true);
}
assert.throws(() => clientOptions({ provider: 'outlook', email: 'a@b.test', password: 'pw' }), /not a provider/);
assert.match(accountId('gmail', 'A@B.test'), /^mail-[0-9a-f]{16}$/, 'a name every secret store takes');
assert.equal(accountId('gmail', ' a@b.test '), accountId('gmail', 'A@B.TEST'), 'one entry per address, any case');
assert.notEqual(accountId('gmail', 'a@b.test'), accountId('yahoo', 'a@b.test'));
assert.ok(validEmail('ana.perez+bank@yahoo.com') && !validEmail('ana') && !validEmail('a@b') && !validEmail('a b@c.com') && !validEmail(42));

// ---------- the provider's own Authentication-Results, never one that came with the mail ----------
assert.equal(authservId('mx.google.com; dkim=pass'), 'mx.google.com');
assert.equal(authservId(' (comment (nested)) atlas321.free.mail.ne1.yahoo.com 1 ; dkim=pass'), 'atlas321.free.mail.ne1.yahoo.com');
const own = `mx.google.com; ${pass('notificacionesbcp.com.pe')}`;
const forged = `mx.google.com.attacker.test; ${pass('notificacionesbcp.com.pe')}`;
const head = (auth) => raw({ from: BCP, subject: 'x', html: '<p>x</p>', id: '<h@test>', auth });
assert.deepEqual(providerAuthResults(head([own, forged]), 'gmail'), [own], 'the provider\'s own header');
assert.deepEqual(providerAuthResults(head([forged]), 'gmail'), [], 'a header from outside is ignored');
assert.deepEqual(providerAuthResults(head(['mx.google.com; dkim=fail header.d=notificacionesbcp.com.pe', own]), 'gmail'), ['mx.google.com; dkim=fail header.d=notificacionesbcp.com.pe'],
  'the topmost wins: one further down came with the mail');
assert.deepEqual(providerAuthResults(head([`atlas-production.v2-mail-prod1-gq1.omega.yahoo.com; ${pass('x.pe')}`]), 'yahoo').length, 1, 'Yahoo stamps its receiving host');
for (const id of ['yahoo.com.attacker.test', 'evilyahoo.com', 'mx.google.com']) assert.deepEqual(providerAuthResults(head([`${id}; ${pass('x.pe')}`]), 'yahoo'), [], `${id} is not Yahoo`);
assert.deepEqual(providerAuthResults(head([`atlas.mail.yahoo.com; ${pass('x.pe')}`]), 'gmail'), [], 'Yahoo\'s header means nothing in Gmail');
// Yahoo's real header (seen on the user's BCP and Banco Falabella mails, November 2026): authserv-id mta.yahoo.com,
// folded, with the bank's DKIM signature next to its mail platform's (synthetic selectors and hosts).
const YAHOO_REAL = (d) => `mta.yahoo.com;\r\n dkim=pass header.i=@${d} header.s=s1 arc_overridden_status=NOT_OVERRIDDEN;\r\n dkim=pass header.i=@mailer.example.net header.s=smtpapi arc_overridden_status=NOT_OVERRIDDEN;\r\n spf=pass smtp.mailfrom=em0000.${d} arc_overridden_status=NOT_OVERRIDDEN`;
for (const [from, d, subject, html] of [
  [BCP, 'notificacionesbcp.com.pe', 'Realizaste un consumo con tu Tarjeta de Débito BCP - Servicio de Notificaciones BCP', fixture('bcp-card.html')],
  [FALABELLA, 'pe.notificaciones.bancofalabella.com', 'Movimientos en cuentas', fixture('falabella-movement-card.html')],
]) {
  const m = await toMail(raw({ from, subject, html, id: '<real@test>', auth: [YAHOO_REAL(d)] }), 'yahoo');
  assert.equal(m.authResults.length, 1, 'mta.yahoo.com is Yahoo\'s own');
  assert.equal(parseMail(m).expense.status, 'pending', `${d}: its DKIM pass is trusted, not held for review`);
}
// Folded header lines are read whole.
assert.deepEqual(providerAuthResults(`Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@x.pe\r\nFrom: a@x.pe\r\n\r\nbody`, 'gmail'), ['mx.google.com; dkim=pass header.i=@x.pe']);
// Through the parser: a forged pass under the provider's fail is still a failure.
{
  const yape = (auth) => raw({ from: BCP, subject: 'Constancia de Yapeo a Celular - Servicio de Notificaciones BCP', html: fixture('bcp-yape.html'), id: '<y@test>', auth });
  assert.equal(parseMail(await toMail(yape([own]), 'gmail')).ok, true);
  const r = parseMail(await toMail(yape(['mx.google.com; dkim=fail header.d=notificacionesbcp.com.pe; dmarc=fail header.from=notificacionesbcp.com.pe', own]), 'gmail'));
  assert.equal(r.ok, false); assert.match(r.reason, /authentication failed/);
  assert.equal(parseMail(await toMail(yape([forged]), 'gmail')).expense.status, 'needs_review', 'only an outside header: held for review, never trusted');
  const m = await toMail(yape([own]), 'gmail');
  assert.equal(m.from, `Banco <${BCP}>`); assert.equal(m.messageId, '<y@test>'); assert.match(m.html, /Monto enviado/);
}

// ---------- errors in plain words ----------
const e = (o) => Object.assign(new Error(o.message ?? 'x'), o);
assert.equal(plainError(e({ authenticationFailed: true, responseText: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)' }), 'yahoo').code, 'password');
assert.match(plainError(e({ authenticationFailed: true, responseText: 'Invalid credentials' }), 'yahoo').text, /^Yahoo refused the address or app password/);
assert.match(plainError(e({ responseText: '[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)' }), 'gmail').text, /2-Step Verification.*apppasswords/);
assert.equal(plainError(e({ responseText: '[ALERT] Your account is not enabled for IMAP use.' }), 'gmail').code, 'imap_off');
assert.match(plainError(e({ code: 'ENOTFOUND' }), 'gmail').text, /^Couldn't reach imap\.gmail\.com/);
assert.equal(plainError(e({ code: 'CERT_HAS_EXPIRED' }), 'yahoo').code, 'certificate');
assert.equal(plainError(e({ code: 'TIMEOUT' }), 'yahoo').code, 'timeout');

// ---------- reading, against the fake server ----------
const T = Date.now();
const SECRET = 'abcdefghijklmnop'; // the app password: must turn up nowhere but the keyring and the server's LOGIN
function keyring() {
  const ring = new Map(), calls = [];
  return { ring, calls, get: async (n) => { calls.push(['get', n]); return ring.get(n) ?? null; }, set: async (n, v) => { calls.push(['set', n]); ring.set(n, v); }, delete: async (n) => { calls.push(['delete', n]); ring.delete(n); } };
}
function harness({ port, accounts = [], secrets = keyring(), timeoutMs = 60_000, now = () => T }) {
  const cfg = { mailAccounts: accounts, mailEvery: DEFAULT_EVERY };
  const file = path.join(TMP, 'sidekick.json'), logFile = path.join(TMP, 'log.jsonl');
  const timers = [], pendings = [];
  let opened = 0, money = null;
  const mail = createMail({
    secrets, dir: TMP, server: { host: '127.0.0.1', port, secure: false }, timeoutMs, now,
    settings: () => cfg, save: (patch) => { Object.assign(cfg, patch); fs.writeFileSync(file, JSON.stringify(cfg)); },
    openMoney: () => { opened++; return (money ??= openMoney({ dir: TMP })); },
    log: (kind, data) => fs.appendFileSync(logFile, JSON.stringify({ kind, ...data }) + '\n'),
    onPending: (n) => pendings.push(n),
    schedule: (fn, ms) => { const t = { fn, ms, cleared: false }; if (ms === timeoutMs) t.real = setTimeout(fn, ms); timers.push(t); return t; },
    unschedule: (t) => { if (t) { t.cleared = true; clearTimeout(t.real); } },
  });
  return { mail, cfg, secrets, timers, pendings, opened: () => opened, money: () => money };
}
const plans = (h) => h.timers.filter((t) => !t.cleared && t.ms !== 60_000 && !t.real).map((t) => t.ms);

const yapeMail = (id, auth = [`mx.google.com; ${pass('notificacionesbcp.com.pe')}`]) => raw({ from: BCP, subject: 'Constancia de Yapeo a Celular - Servicio de Notificaciones BCP', html: fixture('bcp-yape.html').replace('04561234', `0456${id}`), id: `<${id}@test>`, auth });
const box = {
  uidValidity: 1700, uidNext: 8, specialUse: '\\All',
  messages: [
    { uid: 2, date: T - 200 * 86_400_000, from: BCP, raw: yapeMail('old') },
    { uid: 5, date: T - 86_400_000, from: `Banco <${BCP}>`, raw: yapeMail('a') },
    { uid: 6, date: T - 86_400_000, from: 'Tienda <ofertas@tienda.test>', raw: raw({ from: 'ofertas@tienda.test', subject: 'Ofertas', html: '<p>private</p>', id: '<shop@test>' }) },
    { uid: 7, date: T - 3_600_000, from: FALABELLA, raw: raw({ from: FALABELLA, subject: 'Movimientos en cuentas', html: fixture('falabella-movement.html'), id: '<f@test>', auth: [`mx.google.com; ${pass('pe.notificaciones.bancofalabella.com')}`] }) },
  ],
};
const server = await fakeImap({ user: 'ana@gmail.com', pass: SECRET, folders: { INBOX: { uidValidity: 1, uidNext: 1, messages: [] }, '[Gmail]/All Mail': box } });
const SENDERS = [...new Set(BUILTIN.flatMap((d) => d.senders))];
const imapDay = (ms) => { const d = new Date(ms); return `${d.getUTCDate()}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const commands = (from = 0) => server.log.slice(from).map((l) => l.replace(/^\S+ /, ''));
const searches = (from) => commands(from).filter((c) => /^UID SEARCH/i.test(c));

{
  const h = harness({ port: server.port });
  // Adding: the password goes to the keyring first, the settings keep provider and email only.
  const bad = await h.mail.add({ provider: 'outlook', email: 'ana@outlook.com', password: SECRET });
  assert.equal(bad.ok, false); assert.match(bad.text, /isn't supported yet/);
  assert.equal((await h.mail.add({ provider: 'gmail', email: 'nope', password: SECRET })).ok, false);
  const added = await h.mail.add({ provider: 'gmail', email: ' Ana@Gmail.com ', password: 'abcd efgh ijkl mnop' });
  assert.equal(added.ok, true, added.text);
  const id = accountId('gmail', 'ana@gmail.com');
  assert.equal(added.id, id);
  assert.equal(h.secrets.ring.get(id), SECRET, 'the spaces Google shows are not part of the password');
  assert.deepEqual(h.cfg.mailAccounts, [{ provider: 'gmail', email: 'ana@gmail.com' }]);
  assert.equal((await h.mail.add({ provider: 'gmail', email: 'ana@gmail.com', password: SECRET })).ok, false, 'added once');
  assert.deepEqual(plans(h).at(-1), 15_000, 'the first read comes shortly after');

  // Test connection: logs in, EXAMINEs, counts the bank mails of the last 90 days, fetches nothing.
  let at = server.log.length;
  const t = await h.mail.test(id);
  assert.equal(t.text, 'Connected to Gmail, read-only: 2 bank mails in the last 90 days ([Gmail]/All Mail).');
  assert.ok(commands(at).includes('EXAMINE "[Gmail]/All Mail"'));
  assert.ok(!commands(at).some((c) => /FETCH/i.test(c)), 'a test reads no mail');

  // First run: the 90-day window, one search per bank sender, EXAMINE only, BODY.PEEK[].
  at = server.log.length;
  await h.mail.runNow();
  assert.ok(h.secrets.calls.some(([op, n]) => op === 'get' && n === id), 'the password is read from the keyring');
  assert.ok(commands(at).some((c) => c === `LOGIN ana@gmail.com ${SECRET}` || c === `LOGIN "ana@gmail.com" "${SECRET}"`), 'and given to the server');
  assert.deepEqual(searches(at).sort(), SENDERS.map((s) => `UID SEARCH SINCE ${imapDay(T - DAYS * 86_400_000)} FROM ${s}`).sort(), 'only the senders, only the window');
  const fetches = commands(at).filter((c) => /FETCH/i.test(c));
  assert.deepEqual(fetches, ['UID FETCH 5,7 (UID BODY.PEEK[])'], 'the two bank mails of the window, without marking them read');
  const money = h.money();
  assert.equal(money.db.prepare('SELECT count(*) AS n FROM expenses').get().n, 2);
  assert.deepEqual(h.pendings, [2], 'the pending count is told after the run');
  assert.equal(h.mail.pending(), 2);
  assert.equal(h.mail.list()[0].status.text, 'Read 2 new bank mails');
  assert.equal(plans(h).at(-1), DEFAULT_EVERY * 60_000, 'next run in five minutes');

  // Second run, nothing new: only UIDs after the last seen (UIDNEXT 8), nothing fetched.
  at = server.log.length;
  await h.mail.runNow();
  assert.deepEqual(searches(at).sort(), SENDERS.map((s) => `UID SEARCH UID 8:* FROM ${s}`).sort());
  assert.ok(!commands(at).some((c) => /FETCH/i.test(c)), 'n:* names the highest UID; it was seen already');

  // A new mail: fetched and ingested once.
  box.messages.push({ uid: 8, date: T, from: BCP, raw: yapeMail('b') }); box.uidNext = 9;
  at = server.log.length;
  await h.mail.runNow();
  assert.deepEqual(commands(at).filter((c) => /FETCH/i.test(c)), ['UID FETCH 8 (UID BODY.PEEK[])']);
  await h.mail.runNow();
  assert.equal(money.db.prepare('SELECT count(*) AS n FROM expenses').get().n, 3, 'each mail once across runs');

  // The server renumbered the folder (new UIDVALIDITY): the date window again; what was stored stays stored once.
  box.uidValidity = 1800;
  at = server.log.length;
  await h.mail.runNow();
  assert.ok(searches(at).every((c) => c.startsWith(`UID SEARCH SINCE ${imapDay(T - DAYS * 86_400_000)} `)), 'a fresh window');
  assert.deepEqual(commands(at).filter((c) => /FETCH/i.test(c)), ['UID FETCH 5,7,8 (UID BODY.PEEK[])']);
  assert.equal(money.db.prepare('SELECT count(*) AS n FROM expenses').get().n, 3);

  // A forged pass under the provider's own fail: kept as not understood, never as an expense.
  box.messages.push({ uid: 9, date: T, from: BCP, raw: yapeMail('c', ['mx.google.com; dkim=fail header.d=notificacionesbcp.com.pe; dmarc=fail header.from=notificacionesbcp.com.pe', `mx.google.com; ${pass('notificacionesbcp.com.pe')}`]) });
  box.uidNext = 10;
  await h.mail.runNow();
  assert.equal(money.db.prepare('SELECT count(*) AS n FROM expenses').get().n, 3);
  assert.match(money.unparsed().find((u) => u.message_id === '<c@test>').reason, /authentication failed/);

  // Read-only, all along: the folder opened with EXAMINE, never SELECT; nothing stored, copied, moved or deleted.
  for (const c of commands()) assert.doesNotMatch(c, /^(UID )?(SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|RENAME|CREATE|SUBSCRIBE|CLOSE)\b/i, c);
  assert.ok(commands().filter((c) => /FETCH/i.test(c)).every((c) => c.includes('BODY.PEEK[]') && !/BODY\[/.test(c.replace('BODY.PEEK[]', ''))));

  // The app password is nowhere but the keyring: not in the settings, the log, money.db or mail.db.
  const files = fs.readdirSync(TMP).map((f) => path.join(TMP, f)).filter((f) => fs.statSync(f).isFile());
  assert.ok(files.some((f) => f.endsWith('money.db')) && files.some((f) => f.endsWith('mail.db')) && files.some((f) => f.endsWith('log.jsonl')) && files.some((f) => f.endsWith('sidekick.json')));
  for (const f of files) assert.ok(!fs.readFileSync(f).includes(SECRET), `${path.basename(f)} has no password`);
  assert.ok(!fs.readFileSync(path.join(TMP, 'log.jsonl'), 'utf8').includes('ana@'), 'the log names no address');
  assert.ok(!fs.readFileSync(path.join(TMP, 'log.jsonl'), 'utf8').includes('Tienda'), 'or anything about other mail');

  // Removing: the keyring entry goes, then the account and its cursors.
  const r = await h.mail.remove(id);
  assert.equal(r.ok, true, r.text);
  assert.ok(h.secrets.calls.some(([op, n]) => op === 'delete' && n === id));
  assert.equal(h.secrets.ring.has(id), false);
  assert.deepEqual(h.cfg.mailAccounts, []);
  assert.deepEqual(h.mail.list(), []);
  { const db = new DatabaseSync(path.join(TMP, 'mail.db')); assert.equal(db.prepare('SELECT count(*) AS n FROM folders WHERE account = ?').get(id).n, 0, 'and where reading stopped'); db.close(); }
  money.close();
}

// A keyring that will not delete keeps the account (and says why).
{
  const s = keyring(); s.delete = async () => { throw new Error('the keyring is locked'); };
  const h = harness({ port: server.port, secrets: s });
  await h.mail.add({ provider: 'yahoo', email: 'ana@yahoo.com', password: SECRET });
  const r = await h.mail.remove(accountId('yahoo', 'ana@yahoo.com'));
  assert.equal(r.ok, false); assert.match(r.text, /keyring is locked/);
  assert.equal(h.cfg.mailAccounts.length, 1);
  h.mail.stop();
}

// Wrong password: plain words, and each failure waits twice as long (up to an hour).
{
  const s = keyring();
  const h = harness({ port: server.port, secrets: s, accounts: [{ provider: 'gmail', email: 'ana@gmail.com' }] });
  s.ring.set(accountId('gmail', 'ana@gmail.com'), 'wrong-password');
  await h.mail.runNow();
  assert.match(h.mail.list()[0].status.text, /^Gmail refused the address or app password/);
  assert.equal(h.mail.list()[0].status.state, 'error');
  assert.equal(plans(h).at(-1), 2 * DEFAULT_EVERY * 60_000);
  await h.mail.runNow();
  assert.equal(plans(h).at(-1), 4 * DEFAULT_EVERY * 60_000);
  for (let i = 0; i < 5; i++) await h.mail.runNow();
  assert.equal(plans(h).at(-1), 60 * 60_000, 'never more than an hour');
  assert.match((await h.mail.test(accountId('gmail', 'ana@gmail.com'))).text, /refused/);
  h.mail.stop();
}

// Not reachable, and a server that never answers (the hard limit closes the connection).
{
  const gone = await fakeImap({ user: 'x', pass: 'y', folders: {} });
  const port = gone.port;
  await gone.close();
  const h = harness({ port, accounts: [{ provider: 'yahoo', email: 'ana@yahoo.com' }] });
  h.secrets.ring.set(accountId('yahoo', 'ana@yahoo.com'), SECRET);
  await h.mail.runNow();
  assert.equal(h.mail.list()[0].status.text, "Couldn't reach imap.mail.yahoo.com. Check the internet connection.");
  assert.equal(plans(h).at(-1), 2 * DEFAULT_EVERY * 60_000, 'backs off');
  h.mail.stop();

  const silent = await fakeImap({ user: 'x', pass: 'y', folders: {}, hang: true });
  const h2 = harness({ port: silent.port, timeoutMs: 300, accounts: [{ provider: 'yahoo', email: 'ana@yahoo.com' }] });
  h2.secrets.ring.set(accountId('yahoo', 'ana@yahoo.com'), SECRET);
  const t0 = Date.now();
  await h2.mail.runNow();
  assert.ok(Date.now() - t0 < 5000, 'the run ends at its limit');
  assert.equal(h2.mail.list()[0].status.text, "Yahoo took too long to answer. I'll try again later.");
  h2.mail.stop();
  await silent.close();
}

// Yahoo: the Inbox only (no folder listing), and the mailbox's own UID window.
{
  const y = await fakeImap({ user: 'ana@yahoo.com', pass: SECRET, folders: { INBOX: { uidValidity: 5, uidNext: 3, messages: [{ uid: 2, date: T, from: BCP, raw: yapeMail('y1', [`atlas321.free.mail.ne1.yahoo.com; ${pass('notificacionesbcp.com.pe')}`]) }] }, Bulk: { uidValidity: 6, uidNext: 2, messages: [{ uid: 1, date: T, from: BCP, raw: yapeMail('spam') }] } } });
  const h = harness({ port: y.port, accounts: [{ provider: 'yahoo', email: 'ana@yahoo.com' }] });
  h.secrets.ring.set(accountId('yahoo', 'ana@yahoo.com'), SECRET);
  await h.mail.runNow();
  const c = y.log.map((l) => l.replace(/^\S+ /, ''));
  assert.ok(c.includes('EXAMINE INBOX') || c.includes('EXAMINE "INBOX"'));
  assert.ok(!c.some((x) => /Bulk|^(LIST|LSUB) "" "\*"/i.test(x)), 'never lists the folders or opens Bulk (spam)');
  const exp = h.money().db.prepare("SELECT status FROM expenses WHERE message_id = '<y1@test>'").get();
  assert.equal(exp.status, 'pending', 'Yahoo\'s own results trusted');
  h.mail.stop(); h.money().close();
  await y.close();
}

// Mails kept as not understood are looked up again by Message-ID once the bank definitions change, read with the
// new ones, and no longer kept as not understood; once, read-only, without moving the cursor back.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-mail-reread-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const yahoo = (id, subject, html) => raw({ from: BCP, subject, html, id, auth: [`atlas.mail.yahoo.com; ${pass('notificacionesbcp.com.pe')}`] });
  const inbox = { uidValidity: 9, uidNext: 4, messages: [
    { uid: 1, date: T, from: BCP, raw: yahoo('<qr@test>', 'Constancia de Pago con QR - Servicios de Notificaciones BCP', fixture('bcp-qr.html')) },
    { uid: 2, date: T, from: BCP, raw: yahoo('<atm@test>', 'Realizaste un retiro en un cajero automático BCP', fixture('bcp-atm.html')) },
    { uid: 3, date: T, from: BCP, raw: yahoo('<a<qr@test>>', 'Constancia de Pago con QR', '<p>an id that holds another</p>') },
  ] };
  const y = await fakeImap({ user: 'ana@yahoo.com', pass: SECRET, folders: { INBOX: inbox } });
  // The first run with older definitions (only BCP's yapeo): both mails kept as not understood.
  fs.mkdirSync(path.join(dir, 'banks'));
  fs.writeFileSync(path.join(dir, 'banks', 'bcp.json'), JSON.stringify({ id: 'bcp', name: 'BCP', senders: [BCP],
    mails: [{ subject: 'Constancia de Yapeo a Celular', kind: 'yape_out', fields: { amount: 'Monto enviado', date: 'Fecha y hora' } }] }));
  const run = async (deadline) => {
    const money = openMoney({ dir }), cursors = openCursors(path.join(dir, 'mail.db')), at = y.log.length;
    const r = await readAccount({ id: 'mail-y', provider: 'yahoo', email: 'ana@yahoo.com', password: SECRET, server: { host: '127.0.0.1', port: y.port, secure: false } }, {
      senders: [BCP], cursors, ingest: money.ingest, now: T, rereads: () => money.toReread('mail-y', 100).map((u) => u.message_id), missed: money.rereadMissed, deadline,
    });
    const state = { r, commands: y.log.slice(at).map((l) => l.replace(/^\S+ /, '')), unparsed: money.unparsed().map((u) => u.message_id).sort(),
      kinds: money.db.prepare('SELECT kind FROM expenses ORDER BY kind').all().map((e) => e.kind) };
    money.close(); cursors.close();
    return state;
  };
  let s = await run();
  assert.deepEqual([s.unparsed, s.kinds], [['<a<qr@test>>', '<atm@test>', '<qr@test>'], []]);
  assert.ok(!s.commands.some((c) => /HEADER/i.test(c)), 'nothing to read again yet');
  s = await run();
  assert.ok(!s.commands.some((c) => /HEADER|FETCH/i.test(c)), 'same definitions: nothing looked up again');
  // The definitions change (back to the built-ins): the same cursor, but the kept mails are looked up and read.
  fs.rmSync(path.join(dir, 'banks', 'bcp.json'));
  // Past the run's time budget for looking mails up again (a slow server): nothing looked up, all left for later.
  s = await run(0);
  assert.ok(!s.commands.some((c) => /HEADER/i.test(c)), 'no time left: no look-up');
  assert.deepEqual([s.unparsed.length, s.kinds, s.r.reread], [3, [], 0]);
  s = await run();
  assert.ok(s.commands.some((c) => /^UID SEARCH UID 4:\* FROM/.test(c)), 'the cursor did not move back');
  assert.deepEqual(s.commands.filter((c) => /HEADER/i.test(c)).map((c) => c.replaceAll('"', '')).sort(),
    ['<a<qr@test>>', '<atm@test>', '<qr@test>'].map((id) => `UID SEARCH HEADER MESSAGE-ID ${id}`), 'one search per kept mail, by its Message-ID');
  assert.deepEqual(s.kinds, ['purchase', 'withdrawal'], 'read by the new definitions');
  assert.deepEqual(s.unparsed, ['<a<qr@test>>'], 'and no longer kept as not understood (the search for <qr@test> also hit <a<qr@test>>: only the exact id counts)');
  assert.equal(s.r.reread, 3);
  for (const c of s.commands) assert.doesNotMatch(c, /^(UID )?(SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|CLOSE)\b/i, c);
  assert.ok(s.commands.filter((c) => /FETCH/i.test(c)).every((c) => c.includes('BODY.PEEK[]')), 'fetched without marking read');
  s = await run();
  assert.ok(!s.commands.some((c) => /HEADER|FETCH/i.test(c)), 'once: the next run looks up nothing again');
  // A kept mail that is gone from the mailbox is not looked for on every run.
  inbox.messages = inbox.messages.filter((m) => m.uid !== 3);
  fs.writeFileSync(path.join(dir, 'banks', 'extra.json'), JSON.stringify({ id: 'extra', name: 'Otro', senders: ['a@otro.test'], mails: [{ subject: 'x', kind: 'purchase', fields: { amount: 'M', date: 'F' } }] }));
  s = await run();
  assert.equal(s.commands.filter((c) => /HEADER/i.test(c)).length, 1, 'new definitions: looked up once');
  assert.deepEqual(s.unparsed, ['<a<qr@test>>'], 'still kept, for review');
  s = await run();
  assert.ok(!s.commands.some((c) => /HEADER/i.test(c)), 'not there: not looked for again');
  await y.close();
}

// No account: no timer, no keyring read, no database, no connection.
{
  const before = server.log.length;
  const h = harness({ port: server.port });
  h.mail.start(); h.mail.refresh();
  assert.equal(h.timers.length, 0);
  assert.equal(h.secrets.calls.length, 0);
  assert.equal(h.opened(), 0);
  await h.mail.runNow();
  assert.equal(h.opened(), 0); assert.equal(h.secrets.calls.length, 0);
  assert.equal(server.log.length, before);
  assert.deepEqual(h.pendings, []);
  // An account in the settings starts the timer, after a short wait.
  h.cfg.mailAccounts = [{ provider: 'gmail', email: 'ana@gmail.com' }];
  h.mail.refresh();
  assert.deepEqual(plans(h), [15_000]);
  h.cfg.mailAccounts = [];
  h.mail.refresh();
  assert.deepEqual(plans(h), [], 'and the last one removed stops it');
}
assert.deepEqual(EVERY, [2, 5, 15, 30, 60]);
await server.close();
console.log('mail: ok');
