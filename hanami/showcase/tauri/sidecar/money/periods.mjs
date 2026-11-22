// Pay periods: the user is paid around the 26th of each month (26th to 28th), so money is looked at from one salary to
// the next instead of by calendar month. A period starts on the date of an income marked as salary and lasts until
// the day before the next period starts. Each salary belongs to the pay month whose 26th it is nearest: one paid by the
// 10th belongs to the month before (a late salary). A pay month with no salary marked starts on its 26th once that
// day has come ("while this month's salary hasn't come, the 26th is assumed"); a later salary of that month then
// moves the start to its own date. The last period ends on the 25th of the month after its pay month. Dates are local
// YYYY-MM-DD strings; the arithmetic is done in UTC so no time zone moves a day.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PAYDAY = 26;
const LATE = 10; // a salary paid up to this day of the month is the month before's

const pad = (n) => String(n).padStart(2, '0');
const toUtc = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromUtc = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
/** date ± n days. */
export const addDays = (date, n) => { const t = toUtc(date); t.setUTCDate(t.getUTCDate() + n); return fromUtc(t); };
/** 'YYYY-MM' ± n months. */
const addMonths = (month, n) => { const [y, m] = month.split('-').map(Number); const i = y * 12 + (m - 1) + n; return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`; };
/** The pay month a salary paid on `date` belongs to. */
const payMonth = (date) => (Number(date.slice(8, 10)) <= LATE ? addMonths(date.slice(0, 7), -1) : date.slice(0, 7));
/** The Monday of the week holding `date`. */
export const weekStart = (date) => addDays(date, -((toUtc(date).getUTCDay() + 6) % 7));
const short = (date) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

/** salaries: the local dates of the incomes marked as salary; first: the first recorded entry's date (or null);
 * today. → the periods, oldest first: [{ start, end, salary (it starts on a salary), label }]. The first is the one
 * holding the first entry (or today, if earlier); the last holds today or a later salary. */
export function periodsFor({ salaries = [], first = null, today }) {
  const base = first && first < today ? first : today;
  const paid = new Set(salaries.map(payMonth));
  const last = salaries.length ? [...salaries].sort().at(-1) : today;
  const until = payMonth(last) > today.slice(0, 7) ? payMonth(last) : today.slice(0, 7);
  const starts = new Set(salaries);
  for (let mo = addMonths(base.slice(0, 7), -1); mo <= until; mo = addMonths(mo, 1)) {
    const day = `${mo}-${PAYDAY}`;
    if (!paid.has(mo) && day <= today) starts.add(day);
  }
  let list = [...starts].sort();
  const from = list.findLastIndex((d) => d <= base);
  if (from < 0) {
    // Every start is after the first entry (a salary of the month before it was paid late): the 26th before it opens.
    const mo = Number(base.slice(8, 10)) >= PAYDAY ? base.slice(0, 7) : addMonths(base.slice(0, 7), -1);
    list.unshift(`${mo}-${PAYDAY}`);
  } else list = list.slice(from);
  const isSalary = new Set(salaries);
  return list.map((start, i) => {
    const end = i + 1 < list.length ? addDays(list[i + 1], -1) : `${addMonths(payMonth(start), 1)}-${PAYDAY - 1}`;
    return { start, end, salary: isSalary.has(start), label: `${short(start)} – ${short(end)}` };
  });
}

/** The period holding `date`, or null. */
export const periodOf = (periods, date) => periods.find((p) => p.start <= date && date <= p.end) ?? null;
