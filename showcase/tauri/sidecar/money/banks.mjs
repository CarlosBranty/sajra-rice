// Bank definitions: which senders to trust, which subject means which kind of movement, and which label holds
// each field. Data, not code: the built-ins live in ../banks/*.json (bundled in), and the user adds or replaces
// banks with JSON files of the same shape in <data dir>/banks/. A definition that fails validation is skipped
// with a reason, never loaded half-way.
import fs from 'node:fs';
import path from 'node:path';
import bcp from '../banks/bcp.json' with { type: 'json' };
import falabella from '../banks/falabella.json' with { type: 'json' };

export const KINDS = ['purchase', 'transfer_out', 'transfer_in', 'yape_out', 'withdrawal', 'payment'];
// amount and date are always required; the rest only when the definition says so (all fields are required
// unless marked "optional": true).
export const FIELDS = ['amount', 'fee', 'date', 'time', 'merchant', 'account', 'operation', 'note'];
const CURRENCIES = ['PEN', 'USD'];

const isText = (s) => typeof s === 'string' && s.trim() !== '' && s.length <= 200;
const textList = (v) => (Array.isArray(v) ? v : [v]);
function onlyKeys(obj, keys, where) {
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${where}: unknown key "${extra[0]}" (allowed: ${keys.join(', ')})`);
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A definition as written → its normalized form (lists everywhere, defaults filled). Throws with the reason. */
export function validateDefinition(def) {
  if (!isObject(def)) throw new Error('not a JSON object');
  onlyKeys(def, ['id', 'name', 'notes', 'senders', 'currency', 'mails'], 'definition');
  if (typeof def.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(def.id)) throw new Error('id: lowercase letters, digits and dashes');
  if (!isText(def.name)) throw new Error('name: a short text');
  if (!Array.isArray(def.senders) || !def.senders.length) throw new Error('senders: a list of exact sender addresses');
  for (const s of def.senders) {
    if (typeof s !== 'string' || !/^[^@\s,;"<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) throw new Error(`senders: not an address: ${JSON.stringify(s)}`);
  }
  if (def.currency != null && !CURRENCIES.includes(def.currency)) throw new Error(`currency: one of ${CURRENCIES.join(', ')}`);
  if (!Array.isArray(def.mails) || !def.mails.length) throw new Error('mails: a list of mail layouts');
  const mails = def.mails.map((mail, i) => {
    const at = `mails[${i}]`;
    if (!isObject(mail)) throw new Error(`${at}: not an object`);
    onlyKeys(mail, ['subject', 'kind', 'verified', 'notes', 'fields'], at);
    const subject = textList(mail.subject);
    if (!subject.length || !subject.every(isText)) throw new Error(`${at}.subject: a text or a list of texts`);
    if (!KINDS.includes(mail.kind)) throw new Error(`${at}.kind: one of ${KINDS.join(', ')}`);
    if (mail.verified !== undefined && typeof mail.verified !== 'boolean') throw new Error(`${at}.verified: true or false`);
    if (!isObject(mail.fields)) throw new Error(`${at}.fields: an object of field → label`);
    const fields = {};
    for (const [name, spec] of Object.entries(mail.fields)) {
      const where = `${at}.fields.${name}`;
      if (!FIELDS.includes(name)) throw new Error(`${where}: unknown field (allowed: ${FIELDS.join(', ')})`);
      const s = typeof spec === 'string' || Array.isArray(spec) ? { label: spec } : spec;
      if (!isObject(s)) throw new Error(`${where}: a label or { "label": ... }`);
      onlyKeys(s, ['label', 'optional', 'lines'], where);
      const label = textList(s.label);
      if (!label.length || !label.every(isText)) throw new Error(`${where}.label: a text or a list of texts`);
      if (s.optional !== undefined && typeof s.optional !== 'boolean') throw new Error(`${where}.optional: true or false`);
      if (s.lines !== undefined && !(Number.isInteger(s.lines) && s.lines >= 1 && s.lines <= 3)) throw new Error(`${where}.lines: 1 to 3`);
      if (s.optional && (name === 'amount' || name === 'date')) throw new Error(`${where}: ${name} cannot be optional`);
      fields[name] = { label, optional: !!s.optional, lines: s.lines ?? 1 };
    }
    for (const need of ['amount', 'date']) if (!fields[need]) throw new Error(`${at}.fields: "${need}" is required`);
    return { subject, kind: mail.kind, verified: mail.verified !== false, fields };
  });
  return { id: def.id, name: def.name, senders: def.senders.map((s) => s.toLowerCase()), currency: def.currency ?? null, mails };
}

export const BUILTIN = Object.freeze([falabella, bcp].map(validateDefinition));

/** Built-ins plus every valid *.json in `dir` (a user file with a built-in's id replaces it). */
export function loadDefinitions(dir) {
  const byId = new Map(BUILTIN.map((d) => [d.id, d]));
  const problems = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) {
    if (e.code !== 'ENOENT') problems.push({ file: dir, reason: e.message });
  }
  for (const file of files) {
    try {
      const def = validateDefinition(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      byId.set(def.id, def);
    } catch (e) {
      problems.push({ file, reason: e.message });
    }
  }
  return { definitions: [...byId.values()], problems };
}
