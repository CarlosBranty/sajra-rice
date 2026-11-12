// A minimal IMAP server for the mail tests (plain TCP on localhost; the real providers are TLS-only, see
// mail/read.mjs clientOptions). It answers what imapflow sends to read mail: CAPABILITY, LOGIN, LIST/LSUB, EXAMINE,
// UID SEARCH (UID ranges, SINCE, FROM), UID FETCH, NOOP and LOGOUT. Every command line is recorded; anything else
// (STORE, COPY, MOVE, EXPUNGE, SELECT, APPEND…) is answered BAD, and recorded too, so a test can prove it never came.
import net from 'node:net';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A command line (literals already joined in) → tokens: atoms, "quoted strings", literals, and (lists) flattened.
function tokens(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === ' ' || c === '(' || c === ')') { i++; continue; }
    if (c === '"') {
      let v = '';
      for (i++; i < s.length && s[i] !== '"'; i++) v += s[i] === '\\' ? s[++i] : s[i];
      out.push(v); i++;
    } else if (c === '\0') { // a literal, joined in as \0<length>\0<bytes>
      const j = s.indexOf('\0', i + 1), n = Number(s.slice(i + 1, j));
      out.push(s.slice(j + 1, j + 1 + n)); i = j + 1 + n;
    } else {
      let j = i;
      while (j < s.length && !' ()'.includes(s[j])) j++;
      // BODY.PEEK[] and BODY[HEADER] stay one atom with their brackets.
      out.push(s.slice(i, j)); i = j;
    }
  }
  return out;
}

const inSet = (set, uid, max) => set.split(',').some((part) => {
  const [a, b = a] = part.split(':').map((x) => (x === '*' ? max : Number(x)));
  return uid >= Math.min(a, b) && uid <= Math.max(a, b);
});
const imapDate = (s) => { const [d, m, y] = s.split('-'); return Date.UTC(Number(y), MONTHS.indexOf(m), Number(d)); };

/** folders: { name: { uidValidity, uidNext, specialUse, messages: [{ uid, date (ms), from, raw }] } }. */
export async function fakeImap({ user, pass, folders, loginError = null, hang = false }) {
  const log = [];
  let selected = null;
  const open = new Set();
  const server = net.createServer((sock) => {
    open.add(sock); sock.on('close', () => open.delete(sock));
    let buf = '', literal = null, pendingLine = '';
    const w = (s) => sock.write(s + '\r\n');
    if (hang) return; // never greets
    w('* OK fake IMAP ready');
    const run = (line) => {
      const [tag, rawName, ...rest] = tokens(line);
      const name = String(rawName ?? '').toUpperCase();
      log.push(line);
      const args = rest;
      if (name === 'CAPABILITY') { w('* CAPABILITY IMAP4rev1'); return w(`${tag} OK done`); }
      if (name === 'NOOP') return w(`${tag} OK done`);
      if (name === 'LOGOUT') { w('* BYE bye'); w(`${tag} OK done`); return sock.end(); }
      if (name === 'LOGIN') {
        if (args[0] === user && args[1] === pass) return w(`${tag} OK [CAPABILITY IMAP4rev1] logged in`);
        return w(`${tag} NO ${loginError ?? '[AUTHENTICATIONFAILED] Invalid credentials (Failure)'}`);
      }
      if (name === 'LIST' || name === 'LSUB') {
        if (args[1] === '') { w(`* ${name} (\\Noselect) "/" ""`); return w(`${tag} OK done`); } // the hierarchy delimiter
        for (const [f, box] of Object.entries(folders)) w(`* ${name} (\\HasNoChildren${box.specialUse ? ' ' + box.specialUse : ''}) "/" "${f}"`);
        return w(`${tag} OK done`);
      }
      if (name === 'EXAMINE') {
        const box = folders[args[0]];
        if (!box) return w(`${tag} NO no such folder`);
        selected = box;
        w('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
        w(`* ${box.messages.length} EXISTS`);
        w(`* OK [UIDVALIDITY ${box.uidValidity}] ok`);
        w(`* OK [UIDNEXT ${box.uidNext}] ok`);
        return w(`${tag} OK [READ-ONLY] examined`);
      }
      if (name === 'UID' && selected) {
        const sub = String(args[0]).toUpperCase(), max = Math.max(0, ...selected.messages.map((m) => m.uid));
        if (sub === 'SEARCH') {
          let hits = selected.messages;
          for (let i = 1; i < args.length; i++) {
            const k = String(args[i]).toUpperCase();
            if (k === 'UID') { const set = args[++i]; hits = hits.filter((m) => inSet(set, m.uid, max)); }
            else if (k === 'SINCE') { const d = imapDate(args[++i]); hits = hits.filter((m) => m.date >= d); }
            else if (k === 'FROM') { const s = String(args[++i]).toLowerCase(); hits = hits.filter((m) => m.from.toLowerCase().includes(s)); }
            else return w(`${tag} BAD unsupported search key ${k}`);
          }
          // n:* always names the highest UID (RFC 3501), even below n.
          w(`* SEARCH ${hits.map((m) => m.uid).join(' ')}`.trim());
          return w(`${tag} OK searched`);
        }
        if (sub === 'FETCH') {
          const set = args[1];
          selected.messages.forEach((m, i) => {
            if (!inSet(set, m.uid, max)) return;
            sock.write(`* ${i + 1} FETCH (UID ${m.uid} BODY[] {${Buffer.byteLength(m.raw)}}\r\n${m.raw})\r\n`);
          });
          return w(`${tag} OK fetched`);
        }
      }
      return w(`${tag} BAD not supported here`);
    };
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (literal) {
          if (Buffer.byteLength(buf) < literal) return;
          pendingLine += `\0${literal}\0${buf.slice(0, literal)}`; buf = buf.slice(literal); literal = null;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const lit = line.match(/\{(\d+)\+?\}$/);
        if (lit) { pendingLine += line.slice(0, lit.index); literal = Number(lit[1]); if (!line.includes('+}')) w('+ go ahead'); continue; }
        const full = pendingLine + line; pendingLine = '';
        run(full);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, log,
    close: () => new Promise((r) => { for (const s of open) s.destroy(); server.close(() => r()); }),
  };
}
