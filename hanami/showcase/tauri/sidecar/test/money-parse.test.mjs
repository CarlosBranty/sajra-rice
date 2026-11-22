// Money: bank notification mails → expenses. Amounts, dates, senders, authentication, layouts, bank definitions.
// Fixtures are synthetic (invented names and numbers) shaped like real samples. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAuth, htmlToText, maskAccount, merchantKey, parseAmount, parseDate, parseMail } from '../money/parse.mjs';
import { BUILTIN, loadDefinitions } from '../money/banks.mjs';

const FIX = new URL('./fixtures/money/', import.meta.url);
const fixture = (name) => fs.readFileSync(new URL(name, FIX), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-money-parse-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const FALABELLA = 'Banco Falabella <notificaciones@pe.notificaciones.bancofalabella.com>';
const BCP = 'BCP Notificaciones <notificaciones@notificacionesbcp.com.pe>';
const authFor = (domain) => `mx.example.net; dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=${domain}; dmarc=pass(p=REJECT) header.from=${domain}`;
const AUTH_FALABELLA = authFor('pe.notificaciones.bancofalabella.com');
const AUTH_BCP = authFor('notificacionesbcp.com.pe');

// Amounts in every format the banks use: symbol with and without a space, zero-padded, dollars, thousands.
assert.deepEqual(parseAmount('S/ 100.00'), { cents: 10000, currency: 'PEN' });
assert.deepEqual(parseAmount('S/4.00'), { cents: 400, currency: 'PEN' });
assert.deepEqual(parseAmount('S/00.00'), { cents: 0, currency: 'PEN' });
assert.deepEqual(parseAmount('$ 12.50'), { cents: 1250, currency: 'USD' });
assert.deepEqual(parseAmount('US$ 1,234.56'), { cents: 123456, currency: 'USD' });
assert.deepEqual(parseAmount('S/ 1.234,56'), { cents: 123456, currency: 'PEN' });
assert.deepEqual(parseAmount('S/. 3'), { cents: 300, currency: 'PEN' });
assert.deepEqual(parseAmount('12.30', 'PEN'), { cents: 1230, currency: 'PEN' }, 'no symbol: the definition currency');
assert.equal(parseAmount('12.30'), null, 'no symbol and no default currency');
assert.equal(parseAmount('gratis'), null);

// Dates in every format, always stored as America/Lima local time with its offset.
assert.equal(parseDate('2026-11-09T19:25:19-03:00'), '2026-11-09T17:25:19-05:00', 'ISO in another offset → Lima');
assert.equal(parseDate('2026-11-10T03:00:00Z'), '2026-11-09T22:00:00-05:00', 'UTC after midnight is the day before in Lima');
assert.equal(parseDate('09-noviembre-2026', '09:36'), '2026-11-09T09:36:00-05:00');
assert.equal(parseDate('10 de noviembre de 2026 - 10:58 AM'), '2026-11-10T10:58:00-05:00');
assert.equal(parseDate('10 de noviembre de 2026 - 12:05 AM'), '2026-11-10T00:05:00-05:00', '12 AM is midnight');
assert.equal(parseDate('1 de diciembre de 2026 - 12:30 PM'), '2026-12-01T12:30:00-05:00', '12 PM is noon');
assert.equal(parseDate('05/11/2026 13:15'), '2026-11-05T13:15:00-05:00', 'day first');
assert.equal(parseDate('7 set 2026'), '2026-09-07T00:00:00-05:00', 'abbreviated month, no time');
assert.equal(parseDate('31-febrero-2026'), null, 'impossible date');
assert.equal(parseDate('mañana'), null);

// Only the masked last digits of an account or card ever leave the parser.
assert.equal(maskAccount('1234567890123456789'), '****6789');
assert.equal(maskAccount('4111 1111 1111 1234'), '****1234');
assert.equal(maskAccount('Cuenta de ahorro **** 4455'), 'Cuenta de ahorro **** 4455', 'already masked');
assert.equal(maskAccount('421355******6789'), '****6789', 'a card number with its middle masked shows only its last four');
assert.equal(maskAccount('************6789'), '************6789', 'already masked');
assert.equal(maskAccount(null), null);

// merchantKey: one key per merchant, whatever the case, accents, branch numbers, legal form or country.
for (const [name, key] of [
  ['Cafe Central Pe', 'cafe central'],
  ['CAFÉ CENTRAL S.A.C.', 'cafe central'],
  ['Café  Central  SAC', 'cafe central'],
  ['PLAZA VEA SAN ISIDRO 123', 'plaza vea san isidro'],
  ['Tottus #045 Jockey', 'tottus jockey'],
  ['Rappi Peru S.A.', 'rappi'],
  ['IZI*BODEGA DON PEPE', 'bodega don pepe'],
  ['PAYU *NETFLIX.COM', 'netflix com'],
  ['UBER *TRIP', 'uber trip'],
  ['Jorge M Salas P.', 'jorge m salas p'],
  ['', ''],
]) assert.equal(merchantKey(name), key, name);

// HTML → text: one line per row, cells separated, entities and non-breaking spaces decoded, scripts dropped.
const t = htmlToText('<style>p{}</style><script>x()</script><table><tr><td>Comisi&oacute;n</td><td>S/&nbsp;1.00</td></tr></table><p>a&amp;b<br>c &#191;d&#x3F;</p>');
assert.deepEqual(t.split('\n'), ['Comisión\tS/ 1.00', 'a&b', 'c ¿d?']);
assert.equal(htmlToText('Noti&#xFB01;caci&oacute;n'), 'Notificación', 'the fi ligature of print-outs reads as plain letters');

// Each built-in definition parses its fixture, HTML and text alike, into the exact expense.
const mail = (over) => ({ messageId: '<m1@test>', date: 'Sun, 08 Nov 2026 19:40:07 -0500', authResults: AUTH_FALABELLA, from: FALABELLA, ...over });
const transfer = {
  source: 'falabella', kind: 'transfer_out', occurredAt: '2026-11-08T19:40:05-05:00', amount: 750, currency: 'PEN', fee: 0,
  merchant: 'LUIS ALBERTO GOMEZ TORRES', merchantKey: 'luis alberto gomez torres', account: '****6789', operation: '990811194001',
  note: null, messageId: '<m1@test>', mailDate: '2026-11-09T00:40:07.000Z', status: 'pending',
};
const movement = {
  ...transfer, kind: 'purchase', occurredAt: '2026-11-07T08:15:00-05:00', amount: 4590, fee: null,
  merchant: 'Cafe Central Pe', merchantKey: 'cafe central', operation: '990807081577',
};
const yape = {
  ...transfer, source: 'bcp', kind: 'yape_out', occurredAt: '2026-11-06T19:05:00-05:00', amount: 2500, fee: null,
  merchant: 'Jorge M Salas P.', merchantKey: 'jorge m salas p', account: 'Cuenta de ahorro **** 4455', operation: '04561234',
  note: 'Almuerzo viernes',
};
for (const [file, subject, from, auth, expected] of [
  ['falabella-transfer', 'Comprobante de transferencia', FALABELLA, AUTH_FALABELLA, transfer],
  ['falabella-movement', 'Movimientos en cuentas', FALABELLA, AUTH_FALABELLA, movement],
  ['bcp-yape', 'Constancia de Yapeo a Celular - Servicio de Notificaciones BCP', BCP, AUTH_BCP, yape],
]) {
  assert.deepEqual(parseMail(mail({ subject, from, authResults: auth, html: fixture(file + '.html') })), { ok: true, expense: expected }, file + '.html');
  assert.deepEqual(parseMail(mail({ subject, from, authResults: auth, text: fixture(file + '.txt') })), { ok: true, expense: expected }, file + '.txt');
}
// The layouts checked against the user's real mails (November 2026), each from a fixture with the real markup.
const bcp = { ...transfer, source: 'bcp', fee: null, note: null };
const card = {
  ...bcp, kind: 'purchase', occurredAt: '2026-11-05T13:15:00-05:00', amount: 5990,
  merchant: 'PLAZA VEA SAN ISIDRO 123', merchantKey: 'plaza vea san isidro', account: '************7788', operation: '123456',
};
for (const [file, subject, from, auth, expected] of [
  ['bcp-card', 'Realizaste un consumo con tu Tarjeta de Débito BCP - Servicio de Notificaciones BCP', BCP, AUTH_BCP, card],
  ['bcp-qr', 'Constancia de Pago con QR - Servicios de Notificaciones BCP', BCP, AUTH_BCP, {
    ...bcp, kind: 'purchase', occurredAt: '2026-11-04T20:40:00-05:00', amount: 1850, merchant: 'Bodega Don Pepe', merchantKey: 'bodega don pepe',
    account: 'Cuenta de ahorro **** 4455', operation: '07771234', // an empty "Mensaje" stays empty: it never reads "Canal"
  }],
  ['bcp-yape-in', 'Constancia de recepción de Yapeo a celular BCP - Servicio de Notificaciones BCP', BCP, AUTH_BCP, {
    ...bcp, kind: 'transfer_in', occurredAt: '2026-11-03T09:12:00-05:00', amount: 1200, merchant: 'Marco Rivas', merchantKey: 'marco rivas',
    account: null, operation: null,
  }],
  ['bcp-own-transfer', 'Constancia de Transferencia Entre mis Cuentas - Servicio de Notificaciones BCP', BCP, AUTH_BCP, {
    ...bcp, kind: 'own_transfer', occurredAt: '2026-11-02T07:30:00-05:00', amount: 125000, merchant: null, merchantKey: '',
    account: 'Clasica **** 4455', operation: '05559876', note: 'Clasica **** 9012',
  }],
  ['bcp-rejected', 'Se rechazó tu compra por fondos insuficientes - Servicio de Notificaciones BCP', BCP, AUTH_BCP, {
    ...bcp, kind: 'rejected', occurredAt: '2026-11-01T23:45:00-05:00', amount: 1599, currency: 'USD', merchant: 'PAYU *NETFLIX.COM', merchantKey: 'netflix com',
    account: '************7788', operation: null, note: 'Fondos Insuficientes',
  }],
  ['bcp-atm', 'Realizaste un retiro en un cajero automático BCP - Servicio de Notificaciones BCP', BCP, AUTH_BCP, {
    ...bcp, kind: 'withdrawal', occurredAt: '2026-09-07T18:20:00-05:00', amount: 20000, fee: 0, merchant: null, merchantKey: '',
    account: '************7788', operation: '4321',
  }],
  ['falabella-movement-card', 'Movimientos en cuentas', FALABELLA, AUTH_FALABELLA, {
    ...movement, occurredAt: '2026-11-06T13:05:00-05:00', amount: 8740, merchant: 'Tottus Jockey Pe', merchantKey: 'tottus jockey',
    account: '****6789', operation: '990806130512',
  }],
  ['falabella-transfer-sent', 'ANA has realizado una transferencia', FALABELLA, AUTH_FALABELLA, {
    ...transfer, occurredAt: '2026-11-08T21:10:00-05:00', amount: 132000, fee: 0, account: null, operation: '990811211044', // an empty "Asunto" stays empty
  }],
]) assert.deepEqual(parseMail(mail({ subject, from, authResults: auth, html: fixture(file + '.html') })), { ok: true, expense: expected }, file);
// The subject of a third-party transfer starts with the user's name, whatever it is.
assert.equal(parseMail(mail({ subject: 'MARIA JOSE has realizado una transferencia', html: fixture('falabella-transfer-sent.html') })).ok, true);
// No credit card purchase seen yet: the same layout is assumed, and each one is held for review.
const credit = parseMail(mail({
  subject: 'Realizaste un consumo con tu Tarjeta de Crédito BCP - Servicio de Notificaciones BCP', from: BCP, authResults: AUTH_BCP,
  html: fixture('bcp-card.html').replaceAll('D&eacute;bito', 'Cr&eacute;dito'),
}));
assert.deepEqual(credit, { ok: true, expense: { ...card, status: 'needs_review' } });
// The real "Comisión" says "GRATIS" or "Gratis": a fee of zero. A fee that is no amount is still refused.
assert.match(parseMail(mail({ subject: 'Realizaste un retiro en un cajero automático BCP', from: BCP, authResults: AUTH_BCP,
  html: fixture('bcp-atm.html').replace('<b>GRATIS</b>', '<b>a convenir</b>') })).reason, /fee not understood/);

// Senders: exact address only, case-insensitive; look-alikes and other mailboxes of the same domain are refused.
const yapeMail = (over) => mail({ subject: 'Constancia de Yapeo a Celular', from: BCP, authResults: AUTH_BCP, html: fixture('bcp-yape.html'), ...over });
assert.equal(parseMail(yapeMail({ from: 'NOTIFICACIONES@NotificacionesBCP.com.pe' })).ok, true, 'case-insensitive');
for (const from of [
  'BCP <notificaciones@notificacionesbcp.com.pe.evil.com>',
  'BCP <alertas@notificacionesbcp.com.pe>',
  '"notificaciones@notificacionesbcp.com.pe" <x@evil.com>',
  'notificaciones@notificacionesbcp.com.pe, x@evil.com',
  '',
]) {
  const r = parseMail(yapeMail({ from }));
  assert.equal(r.ok, false, from);
  assert.match(r.reason, /sender/, from);
}

// Authentication: DMARC pass, or DKIM pass aligned with the sender's domain; a failure or a foreign signature is refused.
assert.deepEqual(checkAuth(AUTH_BCP, 'notificacionesbcp.com.pe'), { result: 'pass' });
assert.equal(checkAuth('mx; dkim=pass header.d=bancofalabella.com', 'pe.notificaciones.bancofalabella.com').result, 'pass', 'parent domain signature aligns');
assert.equal(checkAuth('mx; dkim=pass header.d=com.pe', 'notificacionesbcp.com.pe').result, 'fail', 'a public suffix never aligns');
assert.equal(checkAuth('mx; dkim=pass header.d=evil.com; dmarc=none header.from=notificacionesbcp.com.pe', 'notificacionesbcp.com.pe').result, 'fail');
assert.equal(checkAuth('mx; dkim=pass header.d=notificacionesbcp.com.pe; dmarc=fail header.from=notificacionesbcp.com.pe', 'notificacionesbcp.com.pe').result, 'fail', 'DMARC fail wins');
assert.equal(checkAuth('mx; dkim=pass header.d=evil.com; dmarc=pass header.from=evil.com', 'notificacionesbcp.com.pe').result, 'fail', 'DMARC pass for another domain');
assert.equal(checkAuth(undefined, 'x.pe').result, 'missing');
assert.equal(checkAuth([], 'x.pe').result, 'missing');
const failed = parseMail(yapeMail({ authResults: 'mx; dkim=fail header.d=notificacionesbcp.com.pe; spf=softfail; dmarc=fail header.from=notificacionesbcp.com.pe' }));
assert.equal(failed.ok, false);
assert.match(failed.reason, /authentication/);
const unsigned = parseMail(yapeMail({ authResults: undefined }));
assert.equal(unsigned.ok, true, 'no authentication header: kept');
assert.equal(unsigned.expense.status, 'needs_review', 'but held for review');

// Layouts it does not understand come back with a reason, never a guess.
const blank = parseMail(yapeMail({ html: '<p>Hola, tu operación fue registrada.</p>' }));
assert.equal(blank.ok, false);
assert.match(blank.reason, /missing amount/);
assert.match(parseMail(yapeMail({ html: fixture('bcp-yape.html').replace('<td>Enviado a</td>', '<td>Para</td>') })).reason, /missing merchant/);
const promo = parseMail(yapeMail({ subject: 'Promociones de noviembre' }));
assert.equal(promo.ok, false);
assert.match(promo.reason, /subject/);
assert.match(parseMail(yapeMail({ html: undefined, text: undefined })).reason, /body/);
assert.match(parseMail(yapeMail({ html: fixture('bcp-yape.html').replace('S/&nbsp;25.00', 'veinticinco') })).reason, /amount/);

// Bank definitions: the built-ins are valid; user ones in the data folder add or replace banks; invalid ones are skipped.
assert.deepEqual(BUILTIN.map((b) => b.id).sort(), ['bcp', 'falabella']);
const banks = path.join(TMP, 'banks');
fs.mkdirSync(banks);
fs.writeFileSync(path.join(banks, 'ejemplo.json'), JSON.stringify({
  id: 'ejemplo', name: 'Banco Ejemplo', senders: ['avisos@ejemplo.test'],
  mails: [{ subject: 'Consumo', kind: 'purchase', fields: { amount: 'Importe', date: 'Fecha', merchant: 'Comercio' } }],
}));
fs.writeFileSync(path.join(banks, 'bcp.json'), JSON.stringify({ ...BUILTIN.find((b) => b.id === 'bcp'), senders: ['otro@notificacionesbcp.com.pe'] }));
fs.writeFileSync(path.join(banks, 'bad.json'), JSON.stringify({ id: 'bad', name: 'Sin remitentes', mails: [] }));
fs.writeFileSync(path.join(banks, 'kind.json'), JSON.stringify({ id: 'kind', name: 'X', senders: ['a@b.pe'], mails: [{ subject: 'x', kind: 'robo', fields: { amount: 'M', date: 'F' } }] }));
fs.writeFileSync(path.join(banks, 'others.json'), JSON.stringify({ id: 'others', name: 'X', senders: ['a@b.pe'], mails: [{ subject: 'x', kind: 'purchase', otherLabels: ['Canal', 42], fields: { amount: 'M', date: 'F' } }] }));
fs.writeFileSync(path.join(banks, 'broken.json'), '{ "id": ');
fs.writeFileSync(path.join(banks, 'notes.txt'), 'not a definition');
const loaded = loadDefinitions(banks);
assert.deepEqual(loaded.definitions.map((b) => b.id).sort(), ['bcp', 'ejemplo', 'falabella']);
assert.deepEqual(loaded.problems.map((p) => p.file).sort(), ['bad.json', 'broken.json', 'kind.json', 'others.json']);
assert.match(loaded.problems.find((p) => p.file === 'others.json').reason, /otherLabels/);
assert.match(loaded.problems.find((p) => p.file === 'bad.json').reason, /senders/);
assert.match(loaded.problems.find((p) => p.file === 'kind.json').reason, /kind/);
const ejemplo = parseMail({ from: 'avisos@ejemplo.test', subject: 'Consumo aprobado', messageId: '<e1@test>', authResults: authFor('ejemplo.test'), text: 'Fecha de vencimiento 30/11/2026\nComercio: Libreria Sur\nImporte: S/ 30.00\nFecha: 02/11/2026 10:00' }, loaded.definitions);
assert.equal(ejemplo.ok, true, ejemplo.reason);
assert.equal(ejemplo.expense.amount, 3000);
assert.equal(ejemplo.expense.merchant, 'Libreria Sur');
assert.equal(ejemplo.expense.occurredAt, '2026-11-02T10:00:00-05:00', '"Fecha de vencimiento" is not the label "Fecha"');
assert.equal(parseMail(yapeMail({}), loaded.definitions).ok, false, 'the user definition replaced the built-in BCP senders');
assert.equal(parseMail(yapeMail({ from: 'otro@notificacionesbcp.com.pe' }), loaded.definitions).ok, true);
assert.deepEqual(loadDefinitions(path.join(TMP, 'missing')).definitions, BUILTIN, 'no user folder: the built-ins');

console.log('money-parse: ok');
