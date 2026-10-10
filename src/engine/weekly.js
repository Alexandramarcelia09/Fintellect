// 13-week direct cash forecast. Every inflow and outflow is placed on the day the bank would
// see it, then summed into weeks starting the day after the as-of date. Deterministic.
//
// W  weekly inputs from the server (see src/data/build-weekly.js)
// A  scenario assumptions { posGrowth (%/month), b2bGrowth (%/month), cogsPct, hvDelay (days) }
// opts.events      planned events (from state, so user-added events count too)
// opts.scenario    which events apply
// opts.drawings    owner drawings per month (overrides the recurring obligation)
// opts.baseCogsPct the COGS % that recent purchase volumes correspond to
// opts.seasonality whether to apply last year's month pattern to café takings

import { addDays, addM, bback, bfwd, daysBetween, dayInMonth, monthEnd, monthOf, weekday } from "./dates.js";

export const WEEKS = 13;

export function forecastWeekly(W, A, opts = {}) {
  const { events = [], scenario = "expected", drawings, baseCogsPct = A.cogsPct, seasonality = true } = opts;
  const start = addDays(W.asof, 1);
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ i, start: addDays(start, 7 * i), end: addDays(start, 7 * i + 6), inflow: 0, outflow: 0, items: [] }));
  const horizonEnd = weeks[WEEKS - 1].end;
  const items = [];
  const put = (date, amount, label, cat) => {
    if (!amount) return;
    const d = date <= W.asof ? start : date;
    if (d > horizonEnd) return;
    items.push({ date: d, amount, label, cat });
  };
  const monthsAhead = (d) => daysBetween(W.asof, d) / 30.44;
  const months = [];
  for (let k = monthOf(start); k <= monthOf(horizonEnd); k = addM(k, 1)) months.push(k);

  // Café takings, by weekday pattern, with settlement timing
  for (let d = start; d <= horizonEnd; d = addDays(d, 1)) {
    const r = W.posWeekday[weekday(d)];
    const f = Math.pow(1 + A.posGrowth / 100, monthsAhead(d)) * (seasonality ? W.seasonal[monthOf(d)] || 1 : 1);
    put(bfwd(addDays(d, 2)), r.card * (1 - W.mdr) * f, "Card settlements", "Café takings");
    put(d, r.paynow * f, "PayNow", "Café takings");
    put(addDays(d, ((7 - weekday(d)) % 7) || 7), r.cash * f, "Cash deposit", "Café takings");
  }
  for (const p of W.pending) put(p.date, p.amount, p.label, p.cat);

  // Customer invoices
  const delayFor = (id) => (id === W.keyCustomerId ? A.hvDelay : W.customers[id]?.delay ?? 0);
  const custName = (id) => W.customers[id]?.name ?? id;
  for (const inv of W.openAR) put(bfwd(addDays(inv.due, Math.round(delayFor(inv.customerId)))), inv.amount, `${custName(inv.customerId)} · ${inv.id}`, "Customer payments");
  for (const inv of W.futureAR) {
    const c = W.customers[inv.customerId] || { terms: 30 };
    const g = Math.pow(1 + A.b2bGrowth / 100, monthsAhead(inv.issue));
    put(bfwd(addDays(inv.issue, c.terms + Math.round(delayFor(inv.customerId)))), inv.amount * g, `${custName(inv.customerId)} · new invoice`, "Customer payments");
  }

  // Supplier bills: open ones on their due date (held payees excluded), new purchases on terms
  for (const b of W.openAP) if (!b.held) put(b.due, -b.amount, `${b.supplier} · ${b.id}`, "Suppliers");
  const cogsScale = baseCogsPct ? A.cogsPct / baseCogsPct : 1;
  for (const p of W.purchases) {
    for (let d = start; d <= horizonEnd; d = addDays(d, 7)) {
      put(addDays(d, p.terms), -p.weekly * cogsScale * Math.pow(1 + A.posGrowth / 100, monthsAhead(d)), `${p.supplier} · new orders`, "Suppliers");
    }
  }

  // Payroll, CPF, recurring obligations, loan, small card purchases
  for (const k of months) {
    put(bback(dayInMonth(k, W.payroll.payDay)), -W.payroll.net, "Payroll (net pay)", "Staff");
    put(bfwd(dayInMonth(k, W.payroll.cpfDay)), -W.payroll.cpf, "CPF contributions", "Staff");
    for (const o of W.recurring) {
      if (o.start && o.start.slice(0, 7) > k) continue;
      if (o.end && o.end.slice(0, 7) < k) continue;
      if (o.frequency === "annual" && (!o.start || o.start.slice(5, 7) !== k.slice(5, 7))) continue;
      const amt = o.kind === "drawings" && drawings != null ? drawings : o.amount;
      const date = addDays(dayInMonth(k, o.day), o.lag);
      put(o.kind === "drawings" ? bfwd(date) : date, -amt, o.name, o.kind === "drawings" ? "Owner" : "Bills & rent");
    }
    put(monthEnd(k), -W.sundry, "Small card purchases", "Bills & rent");
  }
  for (const l of W.loan) put(l.date, -l.amount, "Term loan instalment", "Loan");

  // Planned events
  for (const e of events.filter((x) => x.sc.includes(scenario))) {
    const date = e.date || e.month + "-15";
    switch (e.kind) {
      case "capex": case "payment": put(date, -e.amount, e.name, "Planned events"); break;
      case "cost":
        if (e.payroll) {
          const k = monthOf(date);
          put(bback(dayInMonth(k, W.payroll.payDay)), -e.amount * W.payroll.netRatio, e.name + " (net pay)", "Planned events");
          put(bfwd(dayInMonth(addM(k, 1), W.payroll.cpfDay)), -e.amount * (1 - W.payroll.netRatio), e.name + " (CPF)", "Planned events");
        } else put(date, -e.amount, e.name, "Planned events");
        break;
      case "revenue": case "in": case "equity": put(date, e.amount, e.name, "Planned events"); break;
      case "monthly":
        for (const k of months) if (k >= e.month) put(dayInMonth(k, 1), -e.amount, e.name, "Planned events");
        break;
      default: break;
    }
  }

  // Sum into weeks
  for (const it of items) {
    const w = weeks[Math.floor(daysBetween(start, it.date) / 7)];
    if (!w) continue;
    if (it.amount >= 0) w.inflow += it.amount; else w.outflow -= it.amount;
    w.items.push(it);
  }
  let bal = W.startCash;
  for (const w of weeks) {
    w.net = w.inflow - w.outflow;
    w.opening = bal;
    bal += w.net;
    w.closing = bal;
    w.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.amount - b.amount));
  }
  const low = weeks.reduce((m, w) => (w.closing < m.closing ? w : m), weeks[0]);
  return { start: W.asof, startCash: W.startCash, weeks, low, end: weeks[WEEKS - 1].closing };
}

/** Totals by category across the 13 weeks, for a "where the cash goes" summary. */
export function weeklyByCategory(result) {
  const m = new Map();
  for (const w of result.weeks) for (const it of w.items) m.set(it.cat, (m.get(it.cat) || 0) + it.amount);
  return [...m.entries()].map(([cat, amount]) => ({ cat, amount })).sort((a, b) => b.amount - a.amount);
}
