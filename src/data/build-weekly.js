// Inputs for the 13-week direct cash forecast, built from one business's own records.
// Everything here is a dated fact or a habit measured from history; the scenario-dependent
// part (growth, cost of goods, how late the key customer pays) is applied later by
// engine/weekly.js, which runs in the browser too.

import { num } from "../lib/csv.js";
import { addDays, addM, bfwd, monthEnd, monthOf, weekday } from "../engine/dates.js";

const r2 = (v) => Math.round(v * 100) / 100;

function shiftMonths(dateStr, n) {
  const k = addM(dateStr.slice(0, 7), n);
  const isMonthEnd = dateStr === monthEnd(dateStr.slice(0, 7));
  if (isMonthEnd) return monthEnd(k);
  const last = +monthEnd(k).slice(8);
  return k + "-" + String(Math.min(+dateStr.slice(8, 10), last)).padStart(2, "0");
}

export function buildWeeklyInputs(view, ctx) {
  const T = view.tables;
  const { asof, mdr, bills, customers, keyCustomer, supplier } = ctx;
  const asofM = monthOf(asof);

  // POS takings by weekday, last 8 weeks
  const wd = Array.from({ length: 7 }, () => ({ card: 0, paynow: 0, cash: 0, n: 0 }));
  for (const r of T.pos_daily_payments) {
    if (r.date <= addDays(asof, -56) || r.date > asof) continue;
    const w = wd[weekday(r.date)];
    w.card += num(r.card); w.paynow += num(r.paynow); w.cash += num(r.cash); w.n++;
  }
  const posWeekday = wd.map((w) => w.n ? { card: r2(w.card / w.n), paynow: r2(w.paynow / w.n), cash: r2(w.cash / w.n) } : { card: 0, paynow: 0, cash: 0 });

  // Seasonality: same month last year relative to the as-of month last year
  const posM = new Map();
  for (const r of T.pos_daily_sales) { const k = monthOf(r.date); posM.set(k, (posM.get(k) || 0) + num(r.net_sales)); }
  const seasonal = {};
  const baseLY = posM.get(addM(asofM, -12));
  for (let i = 1; i <= 6; i++) {
    const k = addM(asofM, i), ly = posM.get(addM(k, -12));
    seasonal[k] = baseLY && ly ? r2(ly / baseLY * 1000) / 1000 : 1;
  }

  // Takings already earned but not yet in the bank at the as-of date
  const pending = [];
  for (const r of T.pos_daily_payments) {
    if (r.date > asof || r.date <= addDays(asof, -10)) continue;
    const s = bfwd(addDays(r.date, 2));
    if (s > asof) pending.push({ date: s, amount: r2(num(r.card) * (1 - mdr)), label: "Card settlement", cat: "Café takings" });
    const dep = addDays(r.date, ((7 - weekday(r.date)) % 7) || 7);
    if (dep > asof) pending.push({ date: dep, amount: r2(num(r.cash)), label: "Cash deposit", cat: "Café takings" });
  }

  // Receivables: open invoices and next quarter's invoices (last 3 months' pattern, shifted by 3 months)
  const delay = Object.fromEntries(customers.map((c) => [c.id, c.avgLate6 ?? 0]));
  const terms = Object.fromEntries(customers.map((c) => [c.id, c.terms]));
  const names = Object.fromEntries(customers.map((c) => [c.id, c.name]));
  const openAR = T.invoices_ar.filter((r) => num(r.balance_due) > 0).map((r) => ({ id: r.invoice_id, customerId: r.customer_id, due: r.due_date, amount: num(r.balance_due) }));
  const fromM = addM(asofM, -2);
  const futureAR = T.invoices_ar.filter((r) => monthOf(r.issue_date) >= fromM && monthOf(r.issue_date) <= asofM)
    .map((r) => ({ customerId: r.customer_id, issue: shiftMonths(r.issue_date, 3), amount: num(r.total_amount) }));

  // Payables: open bills (duplicates already removed). Unknown or unverified payees are held.
  const paid = new Map();
  for (const p of T.supplier_payments) paid.set(p.bill_id, (paid.get(p.bill_id) || 0) + num(p.amount));
  const openAP = bills.map((b) => ({ b, bal: num(b.total_amount) - (paid.get(b.bill_id) || 0) }))
    .filter(({ bal }) => bal > 0.005)
    .map(({ b, bal }) => {
      const s = supplier[b.supplier_id];
      const held = !s ? "Payee not on the approved list" : s.payee_status !== "approved" ? "Payee bank details not verified" : null;
      return { id: b.bill_id, supplier: b.supplier_name, due: b.due_date, amount: r2(bal), held };
    });

  // Ongoing ingredient and packaging purchases: weekly average per supplier over 8 weeks, paid on terms
  const purchases = T.suppliers_payees.filter((s) => s.category.startsWith("COGS") && s.payee_status === "approved").map((s) => {
    const recent = bills.filter((b) => b.supplier_id === s.supplier_id && b.bill_date > addDays(asof, -56) && b.bill_date <= asof);
    return { supplier: s.name, weekly: r2(recent.reduce((a, b) => a + num(b.total_amount), 0) / 8), terms: num(s.payment_terms_days) };
  }).filter((p) => p.weekly > 0);

  // Payroll and CPF: latest period
  const periods = [...new Set(T.payroll_runs.map((r) => r.period))].sort();
  const lastP = T.payroll_runs.filter((r) => r.period === periods[periods.length - 1]);
  const gross = lastP.reduce((a, r) => a + num(r.gross_pay), 0), net = lastP.reduce((a, r) => a + num(r.net_pay), 0);
  const cpf = lastP.reduce((a, r) => a + num(r.employee_cpf) + num(r.employer_cpf), 0);
  const payroll = { net: r2(net), cpf: r2(cpf), netRatio: gross ? r2(net / gross * 1e4) / 1e4 : 1, payDay: 28, cpfDay: 14 };

  // Recurring obligations (payroll, CPF and the loan are handled separately)
  const recurring = T.recurring_obligations.filter((o) => !/payroll|cpf|loan/i.test(o.obligation)).map((o) => ({
    name: o.obligation + (o.payee ? ` · ${o.payee}` : ""), frequency: o.frequency, day: num(o.day_of_month) || 1, amount: num(o.amount),
    start: o.start_date || null, end: o.end_date || null, lag: /14-day terms/i.test(o.notes || "") ? 14 : 0,
    kind: /drawing/i.test(o.obligation) ? "drawings" : "bill",
  }));

  // Loan instalments, and small card purchases paid from receipts (monthly average, last 6 months)
  const loan = T.loan_schedule.filter((r) => r.due_date > asof && r.due_date <= addDays(asof, 130)).map((r) => ({ date: r.due_date, amount: num(r.installment) }));
  const sundryCodes = new Set(["5000", "6140", "6180"]);
  const from6 = addM(asofM, -5);
  const sundry = r2(-T.ledger_entries.filter((r) => sundryCodes.has(r.account_code) && monthOf(r.entry_date) >= from6 && monthOf(r.entry_date) <= asofM).reduce((a, r) => a + num(r.amount), 0) / 6);

  const bank = T.bank_statement;
  const startCash = bank.length ? num(bank[bank.length - 1].running_balance) : 0;

  return {
    asof, startCash, mdr, posWeekday, seasonal, pending, keyCustomerId: keyCustomer.id,
    customers: Object.fromEntries(customers.map((c) => [c.id, { name: names[c.id], terms: terms[c.id], delay: delay[c.id] }])),
    openAR, futureAR, openAP, purchases, payroll, recurring, loan, sundry,
  };
}

