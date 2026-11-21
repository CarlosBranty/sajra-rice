// show_report: a report page (text, tables, charts, sources) written to a file and opened in the browser. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { documentsDir, renderReport, writeReport } from '../report.mjs';
import { createTools } from '../tools.mjs';

const NOW = new Date(2026, 10, 21, 9, 5);
const report = {
  title: 'Dólar hoy <en Perú>',
  summary: 'Compra y venta según **tres** fuentes.\n\n- El Comercio: [ver nota](https://elcomercio.pe/x?a=1&b=2)\n- BCRP: https://www.bcrp.gob.pe',
  sections: [
    { heading: 'Cotizaciones', table: { columns: ['Fuente', 'Compra', 'Venta'], rows: [['El Comercio', '3.447', '3.453'], ['La República', '3.434', '3.442']] } },
    { heading: 'Venta por día', chart: { kind: 'bar', unit: 'S/', labels: ['Lun', 'Mar', 'Mié'], series: [{ name: 'Venta', values: [3.45, 3.46, 3.44] }] } },
    { chart: { kind: 'line', title: 'Compra y venta', labels: ['Lun', 'Mar', 'Mié'], series: [{ name: 'Compra', values: [3.43, 3.44, 3.42] }, { name: 'Venta', values: [3.45, 3.46, 3.44] }] } },
  ],
  sources: [{ title: 'El Comercio', url: 'https://elcomercio.pe/economia' }, { title: 'Bad', url: 'javascript:alert(1)' }, { title: 'Local', url: 'file:///etc/passwd' }],
};

// Rendering: a whole page, readable offline, with nothing that runs.
{
  const html = renderReport(report, { now: NOW });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Dólar hoy &lt;en Perú&gt;<\/title>/, 'the title is escaped');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/, 'no script can run on the page');
  assert.ok(!/<script/i.test(html), 'the page has no scripts');
  assert.match(html, /<strong>tres<\/strong>/, 'bold text');
  assert.match(html, /<li>El Comercio: <a href="https:\/\/elcomercio\.pe\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ver nota<\/a><\/li>/, 'markdown links and list items');
  assert.match(html, /<a href="https:\/\/www\.bcrp\.gob\.pe"[^>]*>https:\/\/www\.bcrp\.gob\.pe<\/a>/, 'bare links');
  assert.match(html, /<th>Fuente<\/th><th class="num">Compra<\/th><th class="num">Venta<\/th>/, 'table header, number columns aligned right');
  assert.match(html, /<td>La República<\/td><td class="num">3\.434<\/td>/, 'numbers are right-aligned');
  assert.equal((html.match(/<svg /g) ?? []).length, 2, 'one drawing per chart');
  assert.match(html, /<title>Mar · Venta: 3\.46 S\/<\/title>/, 'each mark says its value on hover');
  assert.match(html, /class="legend"[\s\S]*Compra[\s\S]*Venta/, 'two series get a legend');
  assert.equal((html.match(/<details/g) ?? []).length, 2, 'each chart has its data as a table');
  assert.match(html, /<a href="https:\/\/elcomercio\.pe\/economia"[^>]*>El Comercio<\/a>/, 'sources are links');
  assert.ok(!/javascript:|file:\/\//.test(html), 'only web links');
  assert.match(html, /prefers-color-scheme: dark/, 'dark mode');
  assert.match(html, /2026-11-21 09:05/, 'when it was made');
}

// Anything from the web is text, never markup.
{
  const evil = { title: 'x', summary: '<img src=x onerror=alert(1)> [a](javascript:alert(1)) "quoted"', sections: [{ heading: '<script>alert(1)</script>', text: '[x](https://a.com/"onmouseover="alert(1))', table: { columns: ['<b>c</b>'], rows: [['<i>v</i>']] }, chart: { kind: 'bar', labels: ['<l>'], series: [{ name: '<s>', values: [1] }] } }] };
  const html = renderReport(evil, { now: NOW });
  assert.ok(!/<img|<script>|<b>c|<i>v|<l>|<s>/.test(html), 'tags are escaped');
  assert.ok(!/href="javascript/.test(html), 'no script links');
  assert.ok(!/"onmouseover=/.test(html), 'a quote never leaves an attribute');
}

// Odd numbers: negatives, a missing value, a single point, all zeros.
{
  const html = renderReport({ title: 't', sections: [
    { chart: { kind: 'bar', labels: ['a', 'b', 'c'], series: [{ name: 's', values: [-2, 5] }] } },
    { chart: { kind: 'line', labels: ['a'], series: [{ name: 's', values: [0] }] } },
  ] }, { now: NOW });
  assert.ok(!/NaN|Infinity|undefined/.test(html), 'every coordinate is a number');
  const ticks = (h) => [...h.matchAll(/class="tick" x="48" y="[\d.]+" text-anchor="end">([^<]+)</g)].map((m) => m[1]);
  const line = renderReport({ title: 't', sections: [{ chart: { kind: 'line', labels: ['a', 'b'], series: [{ name: 's', values: [3.42, 3.47] }] } }] }, { now: NOW });
  assert.ok(Number(ticks(line)[0]) > 3, 'a line sits on its own range');
  const bars = renderReport({ title: 't', sections: [{ chart: { kind: 'bar', labels: ['a', 'b'], series: [{ name: 's', values: [3.42, 3.47] }] } }] }, { now: NOW });
  assert.equal(ticks(bars)[0], '0', 'bars start at zero');
}

// Writing: a new file each time in the folder given, named after the date and the title.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-'));
  const a = writeReport(report, { dir, now: NOW }), b = writeReport(report, { dir, now: NOW });
  assert.equal(path.dirname(a), dir);
  assert.equal(path.basename(a), '2026-11-21-0905-dolar-hoy-en-peru.html');
  assert.notEqual(a, b, 'a second report never overwrites the first');
  assert.match(fs.readFileSync(b, 'utf8'), /Dólar hoy/);
  assert.equal(fs.statSync(a).mode & 0o777, 0o600, 'only the user reads it');
  fs.rmSync(dir, { recursive: true });
}

// The documents folder: XDG's on Linux, ~/Documents otherwise.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  assert.equal(documentsDir(home, 'linux', {}), path.join(home, 'Documents'), 'no user-dirs file');
  fs.mkdirSync(path.join(home, '.config'));
  fs.writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), '# x\nXDG_DOCUMENTS_DIR="$HOME/Documentos"\n');
  assert.equal(documentsDir(home, 'linux', {}), path.join(home, 'Documentos'));
  fs.writeFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_DOCUMENTS_DIR="$HOME/"\n');
  assert.equal(documentsDir(home, 'linux', {}), path.join(home, 'Documents'), 'not the home folder itself');
  assert.equal(documentsDir(home, 'darwin', {}), path.join(home, 'Documents'));
  fs.rmSync(home, { recursive: true });
}

// The tool: writes the page and opens it; bad input is refused before anything is written.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-'));
  const opened = [];
  const noop = async () => {};
  const { tools } = createTools({ allowActions: () => false, ui: () => {}, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', reportsDir: dir, openFile: async (f) => { opened.push(f); } });
  const tool = tools.find((t) => t.name === 'show_report');
  const out = await tool.execute(tool.parameters.parse(report));
  assert.equal(opened.length, 1, 'opened once, even with actions off');
  assert.ok(opened[0].startsWith(dir) && fs.existsSync(opened[0]));
  assert.match(out, /Opened the report/);
  // The folder goes through the same write check as write_file: never somewhere protected.
  const ssh = path.join(os.homedir(), '.ssh', 'hanami-report-test');
  const blocked = createTools({ allowActions: () => false, ui: () => {}, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', reportsDir: ssh, openFile: async (f) => { opened.push(f); } }).tools.find((t) => t.name === 'show_report');
  await assert.rejects(blocked.execute(tool.parameters.parse(report)), /Blocked for safety/);
  assert.ok(!fs.existsSync(ssh) && opened.length === 1, 'nothing made or opened');
  assert.throws(() => tool.parameters.parse({ title: 't', sections: [{ chart: { kind: 'pie', labels: ['a'], series: [{ name: 's', values: [1] }] } }] }));
  fs.rmSync(dir, { recursive: true });
}

console.log('report ok');
