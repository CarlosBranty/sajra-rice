// show_report: what the agent found (text, tables, charts, sources) as one page opened in the browser. Everything in
// it may come from the web, so it is all escaped, links are web and mail only, and the page can run nothing (its
// Content-Security-Policy allows no script; the charts are plain SVG, their values shown on hover by <title>).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SAFE, checkLink } from './safety.mjs';

const text = (n) => z.string().max(n);
export const reportSchema = z.object({
  title: text(120).min(1),
  summary: text(4000).optional().describe('A short intro. Light markdown: **bold**, [links](https://…), "- " list lines, blank lines between paragraphs.'),
  sections: z.array(z.object({
    heading: text(120).optional(),
    text: text(8000).optional().describe('Same light markdown as summary.'),
    table: z.object({
      columns: z.array(text(80)).min(1).max(12),
      rows: z.array(z.array(text(300)).max(12)).max(200),
    }).optional(),
    chart: z.object({
      kind: z.enum(['bar', 'line']).describe('bar: compare amounts; line: change over time'),
      title: text(120).optional(),
      unit: text(20).optional().describe('e.g. "S/", "USD", "%"'),
      labels: z.array(text(40)).min(1).max(60).describe('the x axis: items or dates, in order'),
      series: z.array(z.object({ name: text(60), values: z.array(z.number()).max(60).describe('one per label') })).min(1).max(6),
    }).optional(),
  })).max(20),
  sources: z.array(z.object({ title: text(200), url: text(2000) })).max(50).optional().describe('The pages the facts came from.'),
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const webLink = (url) => checkLink(url).level === SAFE && !/^mailto:/i.test(url);
const anchor = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

// One line of light markdown: [label](url), bare links, **bold**. Text between them is escaped.
function inline(line) {
  const out = [];
  const re = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)|(https?:\/\/[^\s<>"'`)\]]+)|\*\*([^*\n]{1,300})\*\*/g;
  let at = 0, m;
  while ((m = re.exec(line))) {
    out.push(esc(line.slice(at, m.index)));
    if (m[1] != null) out.push(webLink(m[2]) ? anchor(m[2], esc(m[1])) : esc(m[1]));
    else if (m[3] != null) { const url = m[3].replace(/[.,;:!?]+$/, ''); out.push(webLink(url) ? anchor(url, esc(url)) : esc(url)); re.lastIndex = m.index + url.length; }
    else out.push(`<strong>${esc(m[4])}</strong>`);
    at = re.lastIndex;
  }
  out.push(esc(line.slice(at)));
  return out.join('');
}
// Paragraphs and "- " lists.
function prose(s) {
  return String(s ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => /^[-*•] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

const NUMERIC = /^[-+]?[$€£¥S/.\s]*[-+]?\d[\d.,\s]*%?\s*[A-Za-z]{0,4}$/;
function table({ columns, rows }) {
  const isNum = (v) => NUMERIC.test(String(v ?? '').trim());
  const numCol = columns.map((_, i) => rows.length > 0 && rows.every((r) => isNum(r[i]) || !String(r[i] ?? '').trim()) && rows.some((r) => isNum(r[i])));
  const head = columns.map((c, i) => `<th${numCol[i] ? ' class="num"' : ''}>${esc(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${columns.map((_, i) => { const v = r[i] ?? ''; return `<td${isNum(v) ? ' class="num"' : ''}>${inline(v)}</td>`; }).join('')}</tr>`).join('\n');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100));
// Round axis bounds and 4 or 5 ticks between them. Bars start at zero; a line may sit on its own range.
function scale(values, zero = true) {
  const lo = zero ? Math.min(0, ...values) : Math.min(...values), hi = zero ? Math.max(0, ...values) : Math.max(...values);
  const span = hi - lo || Math.abs(hi) || 1, raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  let min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step;
  if (max <= min) max = min + step;
  const ticks = [];
  for (let k = 0; min + k * step <= max + step / 2; k++) ticks.push(Number((min + k * step).toPrecision(12)));
  return { min, max, ticks };
}
// A bar with its far end rounded (4 px) and its base square on the zero line.
function bar(x, w, y0, y1) {
  const r = Math.min(4, w / 2, Math.abs(y1 - y0));
  const up = y1 < y0, e = up ? y1 + r : y1 - r, s = up ? 1 : 0;
  return `M${x} ${y0}V${e}A${r} ${r} 0 0 ${s} ${x + r} ${y1}H${x + w - r}A${r} ${r} 0 0 ${s} ${x + w} ${e}V${y0}Z`;
}
const n2 = (v) => Math.round(v * 10) / 10;

function chart({ kind, title, unit, labels, series }) {
  const W = 720, H = 300, L = 56, R = 16, T = 16, B = 40, pw = W - L - R, ph = H - T - B;
  const vals = series.flatMap((s) => s.values.slice(0, labels.length).filter(Number.isFinite));
  const { min, max, ticks } = scale(vals.length ? vals : [0], kind === 'bar');
  const y = (v) => n2(T + ph - ((v - min) / (max - min)) * ph);
  const u = unit ? ` ${unit}` : '';
  const tip = (i, s, v) => `<title>${esc(labels[i])}${series.length > 1 || s.name ? ` · ${esc(s.name)}` : ''}: ${esc(fmt(v))}${esc(u)}</title>`;
  const parts = [];
  for (const t of ticks) parts.push(`<line class="grid${t === 0 ? ' zero' : ''}" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`);
  const band = pw / labels.length, every = Math.ceil(labels.length / 12);
  const cx = (i) => n2(L + band * (i + 0.5));
  labels.forEach((l, i) => { if (i % every === 0) parts.push(`<text class="tick" x="${cx(i)}" y="${H - B + 20}" text-anchor="middle">${esc(l.length > 14 ? l.slice(0, 13) + '…' : l)}</text>`); });
  if (kind === 'bar') {
    const gap = 2, inner = band * 0.72, w = Math.max(1, (inner - gap * (series.length - 1)) / series.length);
    series.forEach((s, k) => s.values.slice(0, labels.length).forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = n2(L + band * i + (band - inner) / 2 + k * (w + gap));
      parts.push(`<path class="s${k + 1}" d="${bar(x, n2(w), y(0), y(v))}">${tip(i, s, v)}</path>`);
    }));
  } else {
    series.forEach((s, k) => {
      const pts = s.values.slice(0, labels.length).map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
      if (pts.length > 1) parts.push(`<polyline class="line s${k + 1}" points="${pts.map(([i, v]) => `${cx(i)},${y(v)}`).join(' ')}"/>`);
      for (const [i, v] of pts) parts.push(`<circle class="dot s${k + 1}" cx="${cx(i)}" cy="${y(v)}" r="4">${tip(i, s, v)}</circle>`);
    });
  }
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, k) => `<span><i class="s${k + 1}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  const data = table({ columns: ['', ...series.map((s) => s.name + (unit ? ` (${unit})` : ''))], rows: labels.map((l, i) => [l, ...series.map((s) => (Number.isFinite(s.values[i]) ? fmt(s.values[i]) : ''))]) });
  const name = title || (series.length === 1 ? series[0].name : '');
  return `<figure>${name ? `<figcaption>${esc(name)}</figcaption>` : ''}${legend}
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name || 'Chart')}">${parts.join('')}</svg>
<details><summary>Data</summary>${data}</details></figure>`;
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// The validated default categorical palette (light, and its dark steps), and its chart surfaces.
const CSS = `
:root{color-scheme:light;--bg:#fcfcfb;--card:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df;--link:#1c5cab;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#1a1a19;--card:#222221;--ink:#f0efec;--ink2:#c3c2b7;--line:#3a3a38;--link:#86b6ef;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 4px}h2{font-size:1.2rem;margin:32px 0 8px}
.meta{color:var(--ink2);font-size:.875rem;margin:0 0 24px}
a{color:var(--link)}p,ul{margin:0 0 12px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.9375rem}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}th{color:var(--ink2);font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
figure{margin:16px 0;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
figcaption{font-weight:600;margin-bottom:8px}
svg{width:100%;height:auto;display:block}
.grid{stroke:var(--line);stroke-width:1}.grid.zero{stroke:var(--ink2)}
.tick{fill:var(--ink2);font-size:12px;font-variant-numeric:tabular-nums}
path.s1,circle.s1{fill:var(--s1)}path.s2,circle.s2{fill:var(--s2)}path.s3,circle.s3{fill:var(--s3)}
path.s4,circle.s4{fill:var(--s4)}path.s5,circle.s5{fill:var(--s5)}path.s6,circle.s6{fill:var(--s6)}
i.s1{background:var(--s1)}i.s2{background:var(--s2)}i.s3{background:var(--s3)}i.s4{background:var(--s4)}i.s5{background:var(--s5)}i.s6{background:var(--s6)}
.line{fill:none;stroke-width:2;stroke-linejoin:round}.line.s1{stroke:var(--s1)}.line.s2{stroke:var(--s2)}.line.s3{stroke:var(--s3)}
.line.s4{stroke:var(--s4)}.line.s5{stroke:var(--s5)}.line.s6{stroke:var(--s6)}
.dot{stroke:var(--card);stroke-width:2}
.legend{display:flex;flex-wrap:wrap;gap:16px;color:var(--ink2);font-size:.875rem;margin-bottom:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
details{margin-top:8px;color:var(--ink2);font-size:.875rem}details .scroll{margin-top:8px;color:var(--ink)}
.sources li{margin-bottom:4px}`;

export function renderReport(r, { now = new Date() } = {}) {
  const sections = (r.sections ?? []).map((s) => [
    s.heading ? `<h2>${esc(s.heading)}</h2>` : '',
    s.text ? prose(s.text) : '',
    s.table ? table(s.table) : '',
    s.chart ? chart(s.chart) : '',
  ].filter(Boolean).join('\n'));
  const sources = (r.sources ?? []).filter((s) => webLink(s.url));
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(r.title)}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(r.title)}</h1>
<p class="meta">Made by Hanami · ${stamp(now)}</p>
${r.summary ? prose(r.summary) : ''}
${sections.join('\n')}
${sources.length ? `<h2>Sources</h2><ol class="sources">${sources.map((s) => `<li>${anchor(s.url, esc(s.title || s.url))}</li>`).join('')}</ol>` : ''}
</main></body></html>
`;
}

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'report';

/** Writes the page as a new file in `dir` (made if missing) and returns its path; never overwrites one. check(file)
 *  throws to refuse a path (tools.mjs: safety.mjs checkWrite), before anything is made. */
export function writeReport(r, { dir, now = new Date(), check = () => {} }) {
  check(path.join(dir, 'report.html'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const d = now, base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${slug(r.title)}`;
  const html = renderReport(r, { now });
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${base}${n > 1 ? `-${n}` : ''}.html`);
    check(file);
    try { fs.writeFileSync(file, html, { flag: 'wx', mode: 0o600 }); return file; } catch (e) { if (e.code !== 'EEXIST' || n >= 100) throw e; }
  }
}

/** The user's documents folder: XDG's (user-dirs.dirs) on Linux, ~/Documents otherwise. */
export function documentsDir(home, platform = process.platform, env = process.env) {
  const fallback = path.join(home, 'Documents');
  if (platform !== 'linux') return fallback;
  let conf = '';
  try { conf = fs.readFileSync(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs'), 'utf8'); } catch { return fallback; }
  const m = /^XDG_DOCUMENTS_DIR="([^"]*)"/m.exec(conf);
  if (!m) return fallback;
  const dir = path.resolve(m[1].replace(/^\$HOME(?=\/|$)/, home));
  return dir === path.resolve(home) || !path.isAbsolute(m[1].replace(/^\$HOME/, home)) ? fallback : dir;
}
