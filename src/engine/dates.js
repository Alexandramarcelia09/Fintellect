// Date helpers on ISO strings ("YYYY-MM-DD", months as "YYYY-MM"), all in UTC so results
// never depend on the server's or the viewer's time zone. Browser-safe.

export const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 864e5;

export const parseD = (s) => new Date(s + "T00:00:00Z");
export const fmtD = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => fmtD(new Date(parseD(s).getTime() + n * DAY));
export const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / DAY);
/** Monday = 0 … Sunday = 6 (same convention as Python's weekday()). */
export const weekday = (s) => (parseD(s).getUTCDay() + 6) % 7;
/** Roll forward to the next business day if s falls on a weekend. */
export const bfwd = (s) => { while (weekday(s) > 4) s = addDays(s, 1); return s; };
/** Roll back to the previous business day if s falls on a weekend. */
export const bback = (s) => { while (weekday(s) > 4) s = addDays(s, -1); return s; };

export const monthOf = (s) => s.slice(0, 7);
export function addM(k, n) {
  let y = +k.slice(0, 4), m = +k.slice(5, 7) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + "-" + String(m + 1).padStart(2, "0");
}
export const monthEnd = (k) => fmtD(new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)));
export const monthStart = (k) => k + "-01";
export const dayInMonth = (k, d) => {
  const last = +monthEnd(k).slice(8);
  return k + "-" + String(Math.min(d, last)).padStart(2, "0");
};
export function monthsRange(a, b) {
  const out = [];
  for (let k = a; k <= b; k = addM(k, 1)) out.push(k);
  return out;
}
export const quarterOf = (s) => `${s.slice(0, 4)}Q${Math.floor((+s.slice(5, 7) - 1) / 3) + 1}`;

export const ml = (k) => MN[+k.slice(5, 7) - 1] + " " + k.slice(0, 4);
export const ms = (k) => MN[+k.slice(5, 7) - 1];
export const msy = (k) => MN[+k.slice(5, 7) - 1] + " '" + k.slice(2, 4);
export const fmtDate = (s) => +s.slice(8, 10) + " " + MN[+s.slice(5, 7) - 1] + " " + s.slice(0, 4);
export const fmtDayMonth = (s) => +s.slice(8, 10) + " " + MN[+s.slice(5, 7) - 1];
