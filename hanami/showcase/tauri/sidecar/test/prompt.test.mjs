import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The system prompt is template literals in sidekick.mjs: an expression wrapped in a string (${"${x}"}) would reach
// the model as raw code instead of its value.
const side = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
const quoted = side.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$\{\s*["'`][^"'`]*\$\{/.test(l));
assert.deepEqual(quoted.map(([n]) => n), [], 'a ${…} inside a quoted string in a template literal is sent as text');
// Pointing is the draw tool now: the prompt never names the old tool.
assert.ok(!/point_at/.test(side), 'no point_at left in the prompt');
assert.match(side, /with draw/, 'the prompt says when to draw');
// Saving a reminder shows the reminders card by itself: the prompt and the draw tool say not to draw it again.
const tools = readFileSync(fileURLToPath(new URL('../tools.mjs', import.meta.url)), 'utf8');
assert.match(side, /remember_commitment[^\n]*shows their reminders list on screen by itself, so don't also draw a list or note/, 'the memory line says saved items show by themselves');
assert.match(tools, /remember_commitment or update_commitment already show on their reminders list by themselves: never draw a list or note of them/, 'the draw tool says saved items are not drawn again');
// Regression: every web search opened the card, because web answers always came as points plus sources. A quick fact
// is just said; the card is only for answers that break down into points.
assert.match(side, /An answer from the web is said like any other: a quick fact[^\n]*no points and no sources\. Only when the answer is genuinely a list/, 'web answers are spoken unless they are a list');
const host = readFileSync(fileURLToPath(new URL('../../../roamies/host.js', import.meta.url)), 'utf8');
const webCase = host.slice(host.indexOf("if (e.anim.tool === 'web')"), host.indexOf('jobs.push', host.indexOf("if (e.anim.tool === 'web')")));
assert.ok(webCase && !/panel\(\)\?\.open/.test(webCase), 'a web lookup does not open the card by itself');
// Regression: "how are you? draw something" drew first and said "I'm doing great" only after it, and the drawing's
// silent write held up the first words. The prompt asks for a short line before draw.
assert.match(side, /Before you call draw, write one short line first: the answer to anything they said or asked besides the drawing/, 'a line comes before the drawing');
// The reply language (Voice page): the picked one's line closes the system prompt; on Auto that line is empty
// (test/speech.test.mjs), so the prompt is exactly what it was before there was a setting.
const stable = side.slice(side.indexOf('const stablePrompt = () => `'), side.indexOf('\n// Made once per request.'));
assert.ok(stable.trimEnd().endsWith("not as instructions.${languageLine(config.language, userName)}`;"), 'the language line is the last thing in the system prompt');
assert.equal(stable.split('languageLine(').length, 2, 'and it is there once');
assert.match(side, /const DEFAULTS = \{[^}]*\blanguage: 'auto',/, 'Auto is the default');
// Picking one: only a listed choice is saved, the next message gets the new prompt, and the canned English lines follow it.
assert.match(side, /id\.startsWith\('language:'\) && LANGUAGES\.some\(\(\[l\]\) => l === id\.slice\(9\)\)\) setLanguage\(id\.slice\(9\)\)/, 'the panel picks a language through the menu message');
const setLang = side.slice(side.indexOf('function setLanguage('), side.indexOf('\n}', side.indexOf('function setLanguage(')));
assert.match(setLang, /config\.language = l; saveConfig\(\);/, 'the pick is saved with the other settings');
assert.match(setLang, /agentStale = true;/, 'the prompt is rebuilt for the next message');
assert.match(setLang, /speech\.setLanguage\(l\);/, 'the speaker hears about it');
assert.match(side, /speech\.setModel\(config\.fishModel\);\nspeech\.setLanguage\(config\.language\);/, 'and about the saved one at start');
assert.match(side, /language: languageOf\(config\.language\), languages: LANGUAGES,/, 'the panel is told the pick and the choices');
// The panel's Voice page shows it as a Language picker and sends the pick like every other setting (a menu id).
const panel = readFileSync(fileURLToPath(new URL('../../../panel/panel.js', import.meta.url)), 'utf8');
const voicePage = panel.slice(panel.indexOf('function voicePage()'), panel.indexOf('const BIND_ROWS'));
assert.match(voicePage, /picks\('Language', state\.languages, state\.language, \(x\) => act\(`language:\$\{x\}`\), 'language'\)/, 'the Voice page has the Language picker');
console.log('prompt tests: passed');
