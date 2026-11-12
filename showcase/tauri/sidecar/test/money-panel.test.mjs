// Money's mail accounts in the app: the settings, the sidecar's wiring (sidekick.mjs runs the app when loaded, so it
// is read as source) and the panel's Money page. The reading itself is tested in mail.test.mjs. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scrubConfig } from '../diagnostics.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const side = read('../sidekick.mjs');

// Settings: no account and five minutes by default; the address is kept as `email`, so diagnostics redact it.
assert.match(side, /const DEFAULTS = \{[\s\S]*?\bmailAccounts: \[\], mailEvery: 5,/, 'no account by default');
assert.deepEqual(scrubConfig({ mailAccounts: [{ provider: 'yahoo', email: 'ana@yahoo.com' }] }), { mailAccounts: [{ provider: 'yahoo', email: '<redacted>' }] });
// One service, with the app's keyring and data folder, and never a test server.
assert.match(side, /import \{ EVERY as MAIL_EVERY, createMail \} from '\.\/mail\/service\.mjs';/);
const made = side.slice(side.indexOf('const mail = createMail({'), side.indexOf('});', side.indexOf('const mail = createMail({')));
assert.match(made, /secrets, dir: DIR, openMoney,/, 'the Fish key\'s keyring, the data folder');
assert.doesNotMatch(made, /server/, 'the real providers only');
assert.match(side, /mail\.pending\(\): the expenses waiting for the user/, 'the pending count, for the rest of the sidecar (mail.test.mjs)');
assert.match(side, /\nmail\.start\(\);\n/, 'started at launch (it does nothing without an account)');
// The panel's actions: typed details as their own message (like a key), the rest as menu ids.
assert.match(side, /else if \(m\.type === 'panel_mail_add' && typeof m\.provider === 'string' && typeof m\.email === 'string' && typeof m\.password === 'string'\) \{\n\s+mail\.add\(\{ provider: m\.provider, email: m\.email\.slice\(0, 200\), password: m\.password\.slice\(0, 200\) \}\)/);
const handler = side.slice(side.indexOf("m.type === 'panel_mail_add'"), side.indexOf("m.type === 'panel_wake'"));
assert.doesNotMatch(handler, /logLine|console\./, 'what was typed is never logged');
assert.match(side, /else if \(id\.startsWith\('mail_test:'\)\) mail\.test\(id\.slice\(10\)\)\.then\(\(r\) => panelNote\(r\.text, !r\.ok\)\);/);
assert.match(side, /else if \(id\.startsWith\('mail_remove:'\)\) mail\.remove\(id\.slice\(12\)\)\.then\(\(r\) => \{ menu\(\); panelNote\(r\.text, !r\.ok\); \}\);/);
assert.match(side, /else if \(id\.startsWith\('mailevery:'\) && MAIL_EVERY\.includes\(Number\(id\.slice\(10\)\)\)\) \{ config\.mailEvery = Number\(id\.slice\(10\)\); saveConfig\(\); mail\.refresh\(\); menu\(\); \}/);
assert.match(side, /money: \{ accounts: mail\.list\(\), every: mail\.every\(\), everys: MAIL_EVERY \},/, 'the panel is told the accounts, never a password');
// What was there keeps working: the Fish key and the wake phrase arrive as before.
assert.match(side, /else if \(m\.type === 'panel_fishkey' && typeof m\.key === 'string'\) fishKeyLogin\(/);
assert.match(side, /else if \(id === 'fishkey_remove'\) removeFishKey\(\);/);

// The panel: a Money page with the accounts and adding one, each provider's way to an app password.
const panel = read('../../../panel/panel.js');
assert.match(panel, /const PANES = \{ home, memory, model: modelPage, appearance: appearancePage, voice: voicePage, money: moneyPage, behavior: behaviorPage, about: aboutPage \};/);
const page = panel.slice(panel.indexOf('function moneyPage()'), panel.indexOf('// Wayland: the commands to bind'));
assert.match(page, /tabBtn\('accounts', 'Accounts'\), tabBtn\('add', 'Add account'\)/, 'tabs: the panel does not scroll');
assert.match(page, /\['gmail', 'Gmail'\], \['yahoo', 'Yahoo'\], \['outlook', 'Outlook \(soon\)'\]/);
assert.match(panel, /myaccount\.google\.com\/apppasswords/);
assert.match(panel, /2-Step Verification/);
assert.match(panel, /Account Security[^']*Generate app password/);
assert.match(panel, /keeps working after you change your Yahoo password/, 'Yahoo app passwords survive a password change: said');
assert.match(panel, /needs a Microsoft sign-in/, 'Outlook: coming soon, and why');
assert.match(page, /el\('input', \{ type: 'password', id: 'key-mailpass',/, 'the app password is typed masked');
assert.match(page, /send\(\{ type: 'panel_mail_add', provider: ui\.mprov, email, password \}\)/);
assert.match(page, /armed\('Remove', 'Confirm', `mail-remove:\$\{a\.id\}`, `mail_remove:\$\{a\.id\}`,/, 'removing asks first');
assert.match(page, /link\('Test', \(\) => act\(`mail_test:\$\{a\.id\}`\)/);
assert.match(page, /picks\('Check every', m\.everys\.map\(\(n\) => \[n, `\$\{n\} min`\]\), m\.every, \(x\) => act\(`mailevery:\$\{x\}`\), 'mailevery'\)/);
// The browser preview has sample accounts, so the page can be seen without the app.
assert.match(panel, /money: \{ accounts: \[/);

// The movements table (S11): the sidecar answers the page's messages through money/panel.mjs, whose replies come
// back as a 'money' message; only its own failures and changes are said in the note.
assert.match(side, /import \{ moneyPanel \} from '\.\/money\/panel\.mjs';/);
assert.match(side, /const moneyPage = moneyPanel\(\{ money: \(\) => mail\.money\(\), authorize \}\);/, 'the same store and the same authorize as the agent\'s tools');
assert.match(side, /else if \(m\.type === 'panel_money'\) moneyPage\.handle\(m\)\.then\(\(r\) => \{\n\s+if \(r\.view && panelOpen\) send\(\{ type: 'panel', msg: \{ kind: 'money', view: r\.view \} \}\);\n\s+if \(r\.text && \(m\.op !== 'list' \|\| !r\.ok\)\) panelNote\(r\.text, !r\.ok\);/);
// The tabs: the movements first, adding by hand, then the mail accounts as before.
assert.match(page, /tabBtn\('moves', 'Movements'\), tabBtn\('entry', 'Add by hand'\), tabBtn\('accounts', 'Accounts'\), tabBtn\('add', 'Add account'\)/);
assert.match(panel, /ytab: 'moves'/, 'the movements open first');
// Filters: month, category (with not classified), kind group and a search; a change asks the sidecar from page 1.
assert.match(page, /choose\('Month', \[\['', 'All months'\], \.\.\.v\.months\.map/);
assert.match(page, /choose\('Category', \[\['', 'All categories'\], \['null', 'Not classified'\], \.\.\.v\.categories\.map/);
assert.match(page, /choose\('Kind', \[\['all', 'Everything'\], \['spending', 'Spending'\], \['income', 'Income'\], \['other', 'Not counted'\]\]/);
assert.match(page, /type: 'search', id: 'find-money'/);
assert.match(panel, /const moneyDo = \(op, args = \{\}\) => send\(\{ type: 'panel_money', op, \.\.\.args, query: mquery\(\) \}\);/, 'every message carries the query, so the table comes back as it is shown');
// Rows: selectable (keyboard: a checkbox button) when something can be done with them, amounts, category or status.
assert.match(page, /role: 'checkbox', 'aria-checked': String\(on\), 'aria-label': `Select: \$\{what\}`/);
assert.match(page, /'No movements yet: they come from your bank mails, or add one by hand\.'/, 'an empty database says where they come from');
assert.match(page, /'Nothing matches these filters\.'/);
// The selection's actions: a category (or a new one), removing it, marking a recipient as one's own, deleting an entry
// added by hand; protected ones say where the prompt is.
assert.match(page, /moneyDo\('classify', \{ ids, category: name, create: ui\.mnew \|\| undefined \}\)/);
assert.match(page, /\['new', 'New category…'\]/);
assert.match(page, /moneyDo\('unclassify', \{ ids: /);
assert.match(page, /moneyDo\('own', \{ action: 'mark', key: sel\[0\]\.own \}\)/);
assert.match(page, /moneyDo\('delete_entry', \{ id: sel\[0\]\.id \}\)/);
assert.match(page, /moneyDo\('rename_category', \{ from: name, to \}\)/);
assert.match(page, /moneyDo\('delete_category', \{ name: q\.category \}\)/);
assert.match(panel, /const askFirst = \(\) => note\('Confirm it is you: the prompt is by your Roamie\.'\);/);
// Adding by hand: expense or income, amount, currency (soles first), what, date (today first), category for expenses.
assert.match(page, /picks\('Kind', \[\['expense', 'Expense'\], \['income', 'Income'\]\]/);
assert.match(page, /picks\('Currency', \[\['PEN', 'S\/'\], \['USD', 'US\$'\]\]/);
assert.match(panel, /mform: \{ kind: 'expense', amount: '', currency: 'PEN', description: '', date: '', category: '' \}/);
assert.match(page, /moneyDo\('add_entry', \{ kind: f\.kind, amount, currency: f\.currency, date: f\.date \|\| today, description,/);
// Own accounts on the Accounts tab, each with Unmark.
assert.match(page, /moneyDo\('own', \{ action: 'unmark', key: o\.key \}\)/);
// The preview answers the page's messages with sample movements (made up), and none with ?empty.
const pre = panel.slice(panel.indexOf('function preview()'));
assert.match(pre, /if \(args\.msg\?\.type === 'panel_money'\) \{ setTimeout\(\(\) => window\.__panel\(\{ kind: 'money', view: moneyView\(args\.msg\) \}\), 60\); return null; \}/);
assert.match(pre, /const MOVES = q\.has\('empty'\) \? \[\] : \[/);
console.log('money panel: ok');
