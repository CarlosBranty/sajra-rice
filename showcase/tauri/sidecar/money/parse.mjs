// Bank notification mail → expense. Pure functions, no I/O; the bank definitions come from banks.mjs.
// A mail is read only from an exact sender address and refused when DKIM/DMARC do not pass for its domain (with no
// authentication results at all it is kept but held for review). Only the fields a definition names are read, by
// label. Anything else is "not understood", with a reason.
import { BUILTIN } from './banks.mjs';

// --- text ---

/** Lowercase, no accents, whitespace collapsed: the form labels and subjects are compared in. */
export const fold = (s) => foldMap(String(s ?? '')).out.trim();

// The folded line plus, for each folded character, its index in the original (so a label match maps back).
function foldMap(line) {
  let out = '', ws = false, i = 0;
  const map = [];
  for (const c of line) {
    if (/\s/.test(c)) {
      if (!ws) { out += ' '; map.push(i); }
      ws = true;
    } else {
      ws = false;
      for (const f of c.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()) { out += f; map.push(i); }
    }
    i += c.length;
  }
  map.push(line.length);
  return { out, map };
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', deg: '°',
  euro: '€', laquo: '«', raquo: '»', middot: '·', bull: '•', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
};
for (const [l, base] of Object.entries({ a: 'a', e: 'e', i: 'i', o: 'o', u: 'u' })) {
  for (const [name, mark] of [['acute', '́'], ['grave', '̀'], ['uml', '̈']]) {
    ENTITIES[l + name] = (base + mark).normalize('NFC');
    ENTITIES[l.toUpperCase() + name] = (base.toUpperCase() + mark).normalize('NFC');
  }
}
ENTITIES.ntilde = 'ñ'; ENTITIES.Ntilde = 'Ñ'; ENTITIES.ccedil = 'ç'; ENTITIES.Ccedil = 'Ç';

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  }
  return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? all;
});

/** Mail HTML → text: one line per block or table row, cells separated by a tab. */
export function htmlToText(html) {
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(td|th)\b[^>]*>/gi, '\t')
    .replace(/<(br|hr)\b[^>]*>|<\/?(p|div|tr|table|tbody|thead|li|ul|ol|h[1-6]|blockquote|section|center)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return lines(decode(text)).join('\n');
}

// Text → trimmed non-empty lines. NFKC turns the "ﬁ" ligature and non-breaking spaces into plain text.
const lines = (text) => text.normalize('NFKC').split(/\r?\n/)
  .map((l) => l.replace(/[ \f\v ]+/g, ' ').replace(/ ?\t[\t ]*/g, '\t').trim()).filter(Boolean);

// --- values ---

/** "S/ 100.00", "S/4.00", "$ 12.50", "US$ 1,234.56" → { cents, currency }; null when it is not an amount. */
export function parseAmount(s, currency = null) {
  const m = String(s ?? '').match(/(US\$|USD|PEN|S\/\.?|\$)?\s*(\d[\d.,]*)/i);
  if (!m) return null;
  const cur = m[1] ? (/^(S\/|PEN)/i.test(m[1]) ? 'PEN' : 'USD') : currency;
  if (!cur) return null;
  let num = m[2].replace(/[.,]$/, '');
  const dec = num.match(/[.,](\d{1,2})$/);
  const whole = (dec ? num.slice(0, -dec[0].length) : num).replace(/[.,]/g, '');
  const cents = Number(whole) * 100 + (dec ? Number(dec[1].padEnd(2, '0')) : 0);
  return Number.isSafeInteger(cents) ? { cents, currency: cur } : null;
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthOf = (w) => {
  if (/^\d+$/.test(w)) return Number(w);
  if (w === 'set' || w === 'setiembre') return 9;
  const i = MONTHS.findIndex((name) => w.length >= 3 && name.startsWith(w));
  return i < 0 ? 0 : i + 1;
};

const LIMA = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Lima', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
// Lima's wall clock at an instant, as if it were UTC (the difference is the offset).
const limaWall = (ms) => {
  const p = Object.fromEntries(LIMA.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
};
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** An instant → "2026-11-09T17:25:19-05:00" in America/Lima. */
export function toLima(ms) {
  ms = Math.floor(ms / 1000) * 1000;
  const wall = limaWall(ms), off = Math.round((wall - ms) / 60000), d = new Date(wall);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    + `${off <= 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** A date as the banks write it (ISO with offset, "09-noviembre-2026", "10 de noviembre de 2026 - 10:58 AM",
 * "05/11/2026 13:15"), with an optional separate time → Lima ISO time; null when it is not a real date. */
export function parseDate(s, time) {
  const raw = String(s ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const ms = Date.parse(raw.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isNaN(ms) ? null : toLima(ms);
  }
  const f = fold(raw);
  const d = f.match(/(\d{1,2})(?:\s*de\s*|[-/.\s]+)([a-z]+|\d{1,2})\.?(?:\s*de(?:l)?\s*|[-/.\s]+)(\d{4})/);
  if (!d) return null;
  const [day, month, year] = [Number(d[1]), monthOf(d[2]), Number(d[3])];
  const t = (f.slice(d.index + d[0].length) + ' ' + fold(time)).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\b\.?)?/);
  let [h, mi, sec] = t ? [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)] : [0, 0, 0];
  if (t?.[4]) { if (h < 1 || h > 12) return null; h = (h % 12) + (t[4] === 'p' ? 12 : 0); }
  if (!month || h > 23 || mi > 59 || sec > 59) return null;
  const wall = Date.UTC(year, month - 1, day, h, mi, sec), back = new Date(wall);
  if (back.getUTCDate() !== day || back.getUTCMonth() !== month - 1) return null;
  // Lima wall time → instant: shift by Lima's offset, then again by the offset at that instant (DST-proof).
  let ms = wall - (limaWall(wall) - wall);
  ms = wall - (limaWall(ms) - ms);
  return toLima(ms);
}

/** Any run of 5+ digits (spaces and dashes allowed inside) → "****" + its last 4 digits. */
export function maskAccount(s) {
  if (s == null) return null;
  return String(s).replace(/\d[\d -]*\d/g, (run) => {
    const digits = run.replace(/\D/g, '');
    return digits.length >= 5 ? '****' + digits.slice(-4) : run;
  }).replace(/\s+/g, ' ').trim();
}

const PROCESSORS = new Set(['payu', 'izi', 'izipay', 'niubiz', 'culqi', 'mercadopago', 'mpago', 'paypal', 'pp', 'dlc', 'openpay']);
const LEGAL = /(^|\s)(s\.?\s?a\.?\s?c|s\.?\s?a\.?\s?a|s\.?\s?r\.?\s?l|e\.?\s?i\.?\s?r\.?\s?l|s\.?\s?a)\.?(?=\s|$)/g;
const PLACE = new Set(['pe', 'per', 'peru', 'lima']);

/** One key per merchant: no case, accents, payment-processor prefix, legal form, branch numbers or trailing country. */
export function merchantKey(name) {
  let s = fold(name);
  const star = s.match(/^([a-z ]+?)\s*\*\s*(.+)$/);
  if (star && PROCESSORS.has(star[1].trim())) s = star[2];
  s = s.replace(LEGAL, ' ');
  const words = s.replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w && !/\d/.test(w));
  while (words.length > 1 && PLACE.has(words.at(-1))) words.pop();
  return words.join(' ');
}

// --- sender and authentication ---

/** The one sender address of a From header, lowercased; null when there is none or more than one. */
export function senderAddress(from) {
  const s = String(from ?? '').trim();
  const angle = [...s.matchAll(/<([^<>\s]+)>/g)];
  const addr = angle.length ? (angle.length === 1 && !s.slice(s.lastIndexOf('>') + 1).trim() ? angle[0][1] : null) : s;
  return addr && /^[^@\s,;"<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(addr) ? addr.toLowerCase() : null;
}

// A signing domain aligns with the sender's when it is the same or a parent, but never a bare public suffix.
const aligned = (d, domain) => d === domain
  || (domain.endsWith('.' + d) && d.includes('.') && !/^(com|org|net|gob|edu|co|nom|mil)\.[a-z]{2}$/.test(d));

/** Authentication-Results header(s) → { result: 'pass' | 'fail' | 'missing', reason? } for the sender's domain.
 * Pass: DMARC pass for that domain, or DKIM pass signed by it (or a parent), and no DMARC fail.
 * The caller passes only the headers its own mail provider added (a sender can forge more of them). */
export function checkAuth(authResults, domain) {
  const headers = [].concat(authResults ?? []).filter((h) => typeof h === 'string' && h.trim());
  if (!headers.length) return { result: 'missing' };
  let dmarcPass = false, dmarcFail = false, dkimPass = false;
  for (const part of headers.join(';').toLowerCase().split(';')) {
    const m = part.match(/\b(dkim|dmarc)\s*=\s*([a-z]+)/);
    if (!m) continue;
    if (m[1] === 'dmarc') {
      if (part.match(/header\.from\s*=\s*([^\s;]+)/)?.[1] !== domain) continue;
      if (m[2] === 'pass') dmarcPass = true;
      if (m[2] === 'fail') dmarcFail = true;
    } else if (m[2] === 'pass') {
      const d = part.match(/header\.d\s*=\s*([^\s;]+)/)?.[1] ?? part.match(/header\.i\s*=\s*[^\s;@]*@([^\s;]+)/)?.[1];
      if (d && aligned(d, domain)) dkimPass = true;
    }
  }
  if (dmarcFail) return { result: 'fail', reason: 'DMARC fail' };
  if (dmarcPass || dkimPass) return { result: 'pass' };
  return { result: 'fail', reason: `no DKIM or DMARC pass for ${domain}` };
}

// --- fields ---

// Label → value: the label starts a line and ends at a colon, a cell break, two spaces, or a space before a value
// that does not continue the label in lowercase ("Fecha y hora" is not "Fecha"). The value is the rest of the line,
// or the next line when the rest is empty; `lines` joins that many lines. The longest label wins.
function extract(textLines, fields) {
  const labels = [];
  for (const [name, spec] of Object.entries(fields)) for (const l of spec.label) labels.push({ name, label: fold(l) });
  labels.sort((a, b) => b.label.length - a.label.length);
  const folded = textLines.map(foldMap);
  const labelAt = (i) => {
    const { out, map } = folded[i];
    for (const l of labels) {
      if (!out.startsWith(l.label)) continue;
      const rest = textLines[i].slice(map[l.label.length]);
      if (rest === '' || /^(\s*:|\t| {2}| [^\p{Ll}])/u.test(rest)) return { ...l, rest };
    }
    return null;
  };
  const values = {};
  for (let i = 0; i < textLines.length; i++) {
    const hit = labelAt(i);
    if (!hit || hit.name in values) continue;
    const parts = [];
    let rest = hit.rest.replace(/^[\s:]+/, '').trim(), j = i;
    if (rest) parts.push(rest);
    while (parts.length < fields[hit.name].lines && j + 1 < textLines.length && !labelAt(j + 1)) parts.push(textLines[++j]);
    values[hit.name] = parts.join(' ').replace(/\s+/g, ' ').trim() || null;
  }
  return values;
}

const fail = (reason) => ({ ok: false, reason });

function fromText(text, def, bank) {
  const v = extract(lines(text), def.fields);
  for (const [name, spec] of Object.entries(def.fields)) {
    if (!spec.optional && !v[name]) return fail(`missing ${name} (label "${spec.label[0]}")`);
  }
  const amount = parseAmount(v.amount, bank.currency);
  if (!amount) return fail(`amount not understood: "${v.amount}"`);
  const fee = v.fee ? parseAmount(v.fee, amount.currency) : null;
  if (v.fee && !fee) return fail(`fee not understood: "${v.fee}"`);
  const occurredAt = parseDate(v.date, v.time);
  if (!occurredAt) return fail(`date not understood: "${v.date}${v.time ? ' ' + v.time : ''}"`);
  return {
    ok: true,
    expense: {
      source: bank.id, kind: def.kind, occurredAt, amount: amount.cents, currency: amount.currency, fee: fee?.cents ?? null,
      merchant: v.merchant ?? null, merchantKey: merchantKey(v.merchant), account: maskAccount(v.account ?? null),
      operation: v.operation ?? null, note: v.note ?? null,
    },
  };
}

/** A mail ({ from, subject, date, messageId, html, text, authResults }) → { ok: true, expense } or { ok: false, reason }.
 * The expense is 'needs_review' when the mail carries no authentication results or its layout is unverified. */
export function parseMail(mail, definitions = BUILTIN) {
  const address = senderAddress(mail.from);
  if (!address) return fail('no single sender address');
  const bank = definitions.find((b) => b.senders.some((s) => s.toLowerCase() === address));
  if (!bank) return fail(`sender is not a known bank: ${address}`);
  const domain = address.split('@')[1];
  const auth = checkAuth(mail.authResults, domain);
  if (auth.result === 'fail') return fail(`authentication failed for ${domain}: ${auth.reason}`);
  const subject = fold(mail.subject);
  const def = bank.mails.find((d) => d.subject.some((s) => subject.includes(fold(s))));
  if (!def) return fail(`unknown subject for ${bank.name}: "${mail.subject ?? ''}"`);
  const bodies = [mail.html && htmlToText(mail.html), mail.text].filter((b) => typeof b === 'string' && b.trim());
  if (!bodies.length) return fail('empty body');
  let first;
  for (const body of bodies) {
    const r = fromText(body, def, bank);
    if (r.ok) {
      const date = mail.date ? new Date(mail.date) : null;
      return {
        ok: true,
        expense: {
          ...r.expense, messageId: mail.messageId ?? null,
          mailDate: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
          status: auth.result === 'missing' || def.verified === false ? 'needs_review' : 'pending',
        },
      };
    }
    first ??= r;
  }
  return first;
}
