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
console.log('money panel: ok');
