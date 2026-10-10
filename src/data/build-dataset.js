// Builds the monthly financial model for ONE business from its own tables (a TenantView).
//
// Revenue and costs are accrual-based and come from source documents (POS, invoices, bills,
// payroll), not from the cash ledger. Balance sheet items are measured at each month end.
// "GST, CPF, tax & other payables" is the balancing working-capital line, so closing cash
// always equals the bank statement; tests check that this line stays close to an independent
// GST + CPF + tax estimate.

import { num } from "../lib/csv.js";
import { addDays, addM, bfwd, daysBetween, monthEnd, monthOf, monthsRange, quarterOf, weekday } from "../engine/dates.js";
import { buildWeeklyInputs } from "./build-weekly.js";

export const POS_GROUP = "Café (POS)";
export const B2B_GROUP = "B2B invoices";
const OPEX_IDS = { 6000: "sal", 6010: "cpf", 6100: "rent", 6110: "util", 6120: "telco", 6130: "soft", 6140: "repairs", 6150: "mkt", 6160: "ins", 6170: "fees", 6180: "sundry" };
const OPEX_NAMES = { sal: "Salaries & bonuses", cpf: "CPF (employer)" };
const UNCATEGORISED_CODE = "6180";
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const r2 = (v) => Math.round(v * 100) / 100;
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

function groupSum(rows, keyFn, valFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + valFn(r)); }
  return m;
}

export function buildDataset(view) {
  const T = view.tables;
  const bp = T.business_profile[0];
  const asof = bp.as_of_date;
  const months = monthsRange(monthOf(bp.data_history_start), monthOf(asof));
  const gstRate = num(bp.gst_rate);
  const A = assumptionsByScenario(T.forecast_assumptions);
  const mdr = A.all?.card_mdr_pct ?? 0;

  // ---- reference maps
  const coa = Object.fromEntries(T.chart_of_accounts.map((a) => [a.account_code, a]));
  const supplier = Object.fromEntries(T.suppliers_payees.map((s) => [s.supplier_id, s]));
  // Some businesses have invoices but no customer master; fall back to the IDs on the invoices.
  const custRows = T.customers.length ? T.customers : [...new Set(T.invoices_ar.map((r) => r.customer_id))].map((id) => {
    const r = T.invoices_ar.find((x) => x.customer_id === id);
    return { customer_id: id, name: id, segment: "Invoiced sales", payment_terms_days: String(daysBetween(r.issue_date, r.due_date)), credit_limit: "0" };
  });
  const customer = Object.fromEntries(custRows.map((c) => [c.customer_id, c]));

  // ---- POS
  const posCats = [...new Set(T.pos_daily_sales.map((r) => r.category))];
  const posRev = groupSum(T.pos_daily_sales, (r) => monthOf(r.date) + "|" + r.category, (r) => num(r.net_sales));
  const posGst = groupSum(T.pos_daily_sales, (r) => monthOf(r.date), (r) => num(r.gst));
  const posPay = T.pos_daily_payments;
  const cardByMonth = groupSum(posPay, (r) => monthOf(r.date), (r) => num(r.card));

  // ---- receivables
  const segments = [...new Set(custRows.map((c) => c.segment))];
  const invoices = T.invoices_ar.map((r) => ({ ...r, m: monthOf(r.issue_date), seg: customer[r.customer_id]?.segment }));
  const invPays = T.invoice_payments;

  // ---- payables (duplicate bill entries are excluded)
  const seen = new Set(), dupBills = [];
  const bills = [];
  for (const b of T.bills_ap) {
    const key = b.supplier_id + "|" + b.supplier_invoice_no;
    if (seen.has(key)) { dupBills.push(b); continue; }
    seen.add(key);
    const s = supplier[b.supplier_id];
    bills.push({ ...b, m: monthOf(b.bill_date), code: s ? s.account_code : UNCATEGORISED_CODE, known: !!s });
  }
  const billIds = new Set(bills.map((b) => b.bill_id));
  const supPays = T.supplier_payments;

  // ---- ledger (cash book) by account and month
  const ledger = groupSum(T.ledger_entries, (r) => r.account_code + "|" + monthOf(r.entry_date), (r) => num(r.amount));
  const L = (code, k) => -(ledger.get(code + "|" + k) || 0);

  // ---- payroll, loan, assets, stock, tax
  const payroll = new Map();
  for (const r of T.payroll_runs) {
    const p = payroll.get(r.period) || { gross: 0, bonus: 0, er: 0, ee: 0, net: 0 };
    p.gross += num(r.gross_pay); p.bonus += num(r.bonus); p.er += num(r.employer_cpf); p.ee += num(r.employee_cpf); p.net += num(r.net_pay);
    payroll.set(r.period, p);
  }
  const loanSched = new Map(T.loan_schedule.map((r) => [monthOf(r.due_date), { interest: num(r.interest), principal: num(r.principal) }]));
  const stock = groupSum(T.inventory_snapshots, (r) => r.snapshot_date, (r) => num(r.value_at_cost));
  const depFor = (k) => depreciation(T.fixed_assets, k);
  const cit = T.tax_obligations.filter((t) => t.tax_type !== "GST").sort((a, b) => a.period < b.period ? -1 : 1);
  const taxAccrual = cit.length ? num(cit[cit.length - 1].amount) / 12 : 0;
  const gstRows = T.tax_obligations.filter((t) => t.tax_type === "GST").sort((a, b) => a.period < b.period ? -1 : 1);
  const rentFor = (k) => {
    const r = T.recurring_obligations.find((o) => /^rent/i.test(o.obligation) && (!o.start_date || o.start_date.slice(0, 7) <= k) && (!o.end_date || o.end_date.slice(0, 7) >= k));
    return r ? num(r.amount) : 0;
  };
  // insurance: each premium paid in the ledger is spread over the following 12 months
  const insPaid = months.concat(monthsRange(addM(months[0], -12), addM(months[0], -1))).map((k) => [k, L("6160", k)]).filter(([, v]) => v > 0);
  const insFor = (k) => sum(insPaid.filter(([pk]) => pk <= k && addM(pk, 11) >= k), ([, v]) => v / 12);

  // ---- bank
  const bank = T.bank_statement;
  const bankAt = (d) => { let v = null; for (const r of bank) { if (r.posting_date <= d) v = num(r.running_balance); else break; } return v; };
  const bankMonthEnd = Object.fromEntries(months.map((k) => [k, r2(bankAt(monthEnd(k)))]));
  let bankLow = null;
  for (const r of bank) { const v = num(r.running_balance); if (!bankLow || v < bankLow.amount) bankLow = { date: r.posting_date, amount: v }; }

  // ---- balance helpers
  const arAt = (d) => sum(invoices.filter((r) => r.issue_date <= d), (r) => num(r.total_amount)) - sum(invPays.filter((p) => p.payment_date <= d), (p) => num(p.amount));
  const apAt = (d) => {
    const open = bills.filter((b) => b.bill_date <= d);
    const paid = groupSum(supPays.filter((p) => p.payment_date <= d && billIds.has(p.bill_id)), (p) => p.bill_id, (p) => num(p.amount));
    let ap = 0, over = 0;
    for (const b of open) { const bal = num(b.total_amount) - (paid.get(b.bill_id) || 0); if (bal > 0) ap += bal; else over -= bal; }
    return { ap, over };
  };
  const transitAt = (d) => {
    let t = 0;
    for (const r of posPay) {
      if (r.date > d || r.date <= addDays(d, -10)) continue;
      if (bfwd(addDays(r.date, 2)) > d) t += num(r.card) * (1 - mdr);
      const dep = addDays(r.date, ((7 - weekday(r.date)) % 7) || 7); // following Monday
      if (dep > d) t += num(r.cash);
    }
    return t;
  };

  // ---- categories
  const cogsCodes = T.chart_of_accounts.filter((a) => a.account_type === "COGS").map((a) => a.account_code);
  const opexCodes = T.chart_of_accounts.filter((a) => a.account_type === "Operating expense").map((a) => a.account_code);
  const cats = {
    rev: [
      ...posCats.map((c) => ({ id: "pos_" + slug(c), name: "Café: " + c.toLowerCase(), group: POS_GROUP, src: c })),
      ...segments.map((s) => ({ id: "b2b_" + slug(s), name: s, group: B2B_GROUP, src: s })),
    ],
    cogs: [...cogsCodes.map((c) => ({ id: "c" + c, name: coa[c].account_name.replace(/^COGS - /, "").replace(/^./, (x) => x.toUpperCase()), code: c })), { id: "stock", name: "Change in stock on hand" }],
    opex: [
      ...opexCodes.map((c) => { const id = OPEX_IDS[c] || "a" + c; return { id, name: OPEX_NAMES[id] || coa[c].account_name, type: id === "fees" ? "VARIABLE" : "FIXED", code: c }; }),
      { id: "dep", name: "Depreciation", type: "NONCASH" },
    ],
  };

  const ob = Object.fromEntries(T.opening_balance_sheet.map((r) => [r.account_code, num(r.amount)]));
  // Without an opening balance sheet, start from the bank balance before the first transaction.
  const firstBank = bank[0];
  const bankOpen = firstBank ? num(firstBank.running_balance) - num(firstBank.credit) + num(firstBank.debit) : 0;
  const hasOpening = T.opening_balance_sheet.length > 0;
  if (!hasOpening) { ob["1000"] = bankOpen; ob["3200"] = bankOpen; }
  const open = {
    cash: ob["1000"] || 0, ar: ob["1100"] || 0, inv: ob["1200"] || 0, oca: 0, deposit: ob["1300"] || 0, equip: ob["1500"] || 0,
    ap: ob["2000"] || 0, ocl: (ob["2100"] || 0) + (ob["2200"] || 0), loan: ob["2300"] || 0, capital: ob["3000"] || 0, re: ob["3200"] || 0,
  };

  // ---- month loop
  const data = {};
  const diagnostics = [];
  let prev = { ...open, prepaid: 0 };
  let gstBal = ob["2100"] || 0, citBal = 0;
  const gstPaid = (k) => -(ledger.get("2100|" + k) || 0);
  months.forEach((k, i) => {
    const d = monthEnd(k);
    const mb = bills.filter((b) => b.m === k);
    const billNet = (code) => sum(mb.filter((b) => b.code === code), (b) => num(b.net_amount));
    const mi = invoices.filter((r) => r.m === k);

    const rev = {};
    for (const c of cats.rev) rev[c.id] = r2(c.group === POS_GROUP ? posRev.get(k + "|" + c.src) || 0 : sum(mi.filter((r) => r.seg === c.src), (r) => num(r.net_amount)));

    const invNow = stock.get(d) ?? prev.inv;
    const invPrev = i === 0 ? open.inv : prev.inv;
    const cogs = {};
    for (const c of cats.cogs) cogs[c.id] = c.id === "stock" ? r2(-(invNow - invPrev)) : r2(billNet(c.code) + L(c.code, k));

    const pr = payroll.get(k) || { gross: 0, er: 0, ee: 0 };
    const ins = insFor(k);
    const opex = {};
    for (const c of cats.opex) {
      let v;
      switch (c.id) {
        case "sal": v = pr.gross; break;
        case "cpf": v = pr.er; break;
        case "rent": v = rentFor(k); break;
        case "ins": v = ins; break;
        case "fees": v = (cardByMonth.get(k) || 0) * mdr + L(c.code, k); break;
        case "dep": v = depFor(k); break;
        default: v = billNet(c.code) + L(c.code, k);
      }
      opex[c.id] = r2(v);
    }
    const ls = loanSched.get(k) || { interest: 0, principal: 0 };
    const capex = billNet("1500") + L("1500", k) / (1 + gstRate);
    const { ap, over } = apAt(d);
    const ar = arAt(d);
    const prepaid = prev.prepaid + L("6160", k) - ins;
    const oca = transitAt(d) + over + prepaid;
    const drawings = L("3100", k);
    const revT = sum(Object.values(rev), (v) => v), cogsT = sum(Object.values(cogs), (v) => v), opexT = sum(Object.values(opex), (v) => v);
    const np = revT - cogsT - opexT - ls.interest - taxAccrual;
    const cash = bankMonthEnd[k];
    const base = prev.cash + np + opex.dep - (ar - prev.ar) - (invNow - prev.inv) - (oca - prev.oca) + (ap - prev.ap) - capex - ls.principal - drawings;
    const ocl = prev.ocl + (cash - base);

    // independent estimate of GST + CPF + tax payable, used by tests as a sanity check on `ocl`
    gstBal += num(posGst.get(k) || 0) + sum(mi, (r) => num(r.gst)) - sum(mb, (b) => num(b.gst)) - gstPaid(k);
    citBal += taxAccrual - L("8000", k);
    diagnostics.push({ k, ocl: r2(ocl), estimate: r2(gstBal + pr.er + pr.ee + citBal) });

    data[k] = {
      rev, cogs, opex,
      other: {
        interest: r2(ls.interest), tax: r2(taxAccrual), capex: r2(capex), assetSale: 0, loanIn: 0, loanRepay: r2(ls.principal), ownerIn: 0, drawings: r2(drawings),
        ar: r2(ar), inv: r2(invNow), oca: r2(oca), deposit: open.deposit, ap: r2(ap), ocl: r2(ocl),
      },
    };
    prev = { cash, ar, inv: invNow, oca, ap, ocl, prepaid };
  });

  // ---- receivables analytics
  const lastPay = groupSum(invPays, (p) => p.invoice_id, () => 0);
  const lastPayDate = new Map();
  for (const p of invPays) if (!lastPayDate.has(p.invoice_id) || p.payment_date > lastPayDate.get(p.invoice_id)) lastPayDate.set(p.invoice_id, p.payment_date);
  void lastPay;
  const rev12Start = addM(monthOf(asof), -11);
  const customers = custRows.map((c) => {
    const ci = invoices.filter((r) => r.customer_id === c.customer_id);
    const openInv = ci.filter((r) => num(r.balance_due) > 0);
    const overdue = openInv.filter((r) => r.due_date < asof);
    const paid = ci.filter((r) => num(r.balance_due) === 0 && lastPayDate.has(r.invoice_id))
      .map((r) => ({ due: r.due_date, late: daysBetween(r.due_date, lastPayDate.get(r.invoice_id)) }))
      .sort((a, b) => a.due < b.due ? -1 : 1);
    const avg = (xs) => xs.length ? r2(sum(xs, (x) => x.late) / xs.length) : null;
    const byQ = new Map();
    for (const p of paid) { const q = quarterOf(p.due); const a = byQ.get(q) || []; a.push(p.late); byQ.set(q, a); }
    return {
      id: c.customer_id, name: c.name, segment: c.segment, terms: num(c.payment_terms_days), limit: num(c.credit_limit),
      outstanding: r2(sum(openInv, (r) => num(r.balance_due))), overdue: r2(sum(overdue, (r) => num(r.balance_due))),
      oldestOverdueDays: overdue.reduce((m, r) => Math.max(m, daysBetween(r.due_date, asof)), 0),
      avgLate6: avg(paid.slice(-6)), avgLatePrior6: avg(paid.slice(-12, -6)),
      trend: [...byQ.entries()].map(([q, xs]) => [q, Math.round(sum(xs, (x) => x) / xs.length * 10) / 10]),
      rev12: r2(sum(ci.filter((r) => r.m >= rev12Start), (r) => num(r.net_amount))),
    };
  });
  const keyCustomer = customers.slice().sort((a, b) => b.rev12 - a.rev12)[0] || { id: null, name: "", rev12: 0 };
  const l6Start = addM(monthOf(asof), -5);
  const l6 = invoices.filter((r) => r.m >= l6Start);
  const keyShare = sum(l6.filter((r) => r.customer_id === keyCustomer.id), (r) => num(r.net_amount)) / (sum(l6, (r) => num(r.net_amount)) || 1);
  const keyOpen = invoices.filter((r) => r.customer_id === keyCustomer.id && num(r.balance_due) > 0).map((r) => ({ id: r.invoice_id, due: r.due_date, amount: num(r.balance_due) }));
  const rev12 = sum(months.slice(-12), (k) => sum(Object.values(data[k].rev), (v) => v));
  const gstRatio = rev12 ? sum(gstRows.slice(-4), (t) => num(t.amount)) / rev12 : 0;

  // ---- bookkeeping checks (structured facts only)
  const fmtS = (v) => "S$" + num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const checks = [];
  for (const b of dupBills) checks.push({ type: "dup_bill", ref: b.bill_id, date: b.bill_date, text: `Bill ${b.bill_id} repeats supplier invoice ${b.supplier_invoice_no} from ${b.supplier_name} (${fmtS(b.total_amount)}). Left out of expenses and payables.` });
  const payGroups = new Map();
  for (const p of supPays) { const a = payGroups.get(p.bill_id) || []; a.push(p); payGroups.set(p.bill_id, a); }
  for (const [bid, ps] of payGroups) if (ps.length > 1) {
    const bill = bills.find((b) => b.bill_id === bid);
    const total = sum(ps, (p) => num(p.amount));
    if (bill && total > num(bill.total_amount) + 0.01) checks.push({ type: "dup_pay", ref: bid, date: ps[ps.length - 1].payment_date, text: `Bill ${bid} was paid ${ps.length} times (${ps.map((p) => p.payment_date).join(", ")}), ${fmtS(ps[0].amount)} each. The extra payment is recorded as owed back by the supplier.` });
  }
  for (const b of T.bills_ap) if (!supplier[b.supplier_id]) checks.push({ type: "payee", ref: b.bill_id, date: b.bill_date, text: `Bill ${b.bill_id} from ${b.supplier_name} (${fmtS(b.total_amount)}) is from a payee that isn't on the approved list.` });
  for (const s of T.suppliers_payees) if (s.payee_status !== "approved") checks.push({ type: "payee", ref: s.supplier_id, date: asof, text: `${s.name} is still pending bank-detail verification.` });

  // ---- forecast inputs
  const fut = monthsRange(addM(monthOf(asof), 1), addM(monthOf(asof), 40));
  const loanF = Object.fromEntries(fut.map((k) => { const l = loanSched.get(k); return [k, l ? [r2(l.interest), r2(l.principal)] : [0, 0]]; }));
  const depF = Object.fromEntries(fut.map((k) => [k, r2(depFor(k))]));
  const assumptions = {};
  for (const sc of ["worst", "expected", "best"]) {
    const a = A[sc] || {};
    assumptions[sc] = {
      posGrowth: r2((a.pos_sales_growth_monthly ?? 0) * 100), b2bGrowth: r2((a.b2b_sales_growth_monthly ?? 0) * 100),
      cogsPct: Math.round((a.cogs_pct_of_revenue ?? 0.33) * 1000) / 10, opexGrowth: Math.round((a.opex_growth_annual ?? 0) * 1000) / 10,
      hvDelay: a.harbourview_payment_delay_days ?? 0,
    };
  }
  const events = T.forecast_events.map((e) => mapEvent(e));
  const drawRow = T.recurring_obligations.find((o) => /drawing/i.test(o.obligation));
  const global = { drawings: drawRow ? num(drawRow.amount) : 0, minBuffer: A.all?.min_cash_buffer ?? 0, seasonality: true };

  const bonusMonths = [...payroll.entries()].filter(([k, p]) => p.bonus > 0 && months.includes(k)).map(([k, p]) => ({ k, amount: r2(p.bonus) }));
  const loan = T.loans[0];
  const business = {
    id: bp.business_id, name: bp.legal_name.replace(/ Pte Ltd$/, ""), legal: bp.legal_name, uen: bp.registration_no,
    type: ((t) => t.charAt(0).toUpperCase() + t.slice(1))(bp.industry.split(" - ")[1] || bp.industry), industry: bp.industry.split(" - ")[0], country: bp.country, currency: bp.currency,
    fyStart: num(bp.fiscal_year_start_month) || 1, started: bp.business_start_date, owner: bp.owner_name, address: bp.address,
    contact: T.bank_accounts[0] ? `${T.bank_accounts[0].bank_name} · ${T.bank_accounts[0].account_no_masked}` : "",
    gst: bp.gst_registered === "True" ? `GST-registered, ${Math.round(gstRate * 100)}%` : "Not GST-registered", staff: num(bp.employees),
  };
  const financing = T.financing_products.map((f) => ({ product_id: f.product_id, provider: f.provider, product_type: f.product_type, pricing: f.pricing, advance_rate: f.advance_rate, tenor_months: f.tenor_months, approval_days: f.approval_days, best_for: f.best_for }));
  const longTermSuppliers = T.suppliers_payees.filter((s) => s.category.startsWith("COGS") && num(s.payment_terms_days) >= 30).map((s) => s.name);

  return {
    version: 2, business, asof, months, open, cats, data, bank: bankMonthEnd, bankLow,
    assumptions, events, global, loanF, depF, customers, keyCustomer: { id: keyCustomer.id, name: keyCustomer.name, short: keyCustomer.name.split(/[\s-]/)[0] },
    limited: !T.pos_daily_sales.length && !T.payroll_runs.length,
    hvOpen: keyOpen, hvShare: r2(keyShare * 1e4) / 1e4, gstRatio: r2(gstRatio * 1e4) / 1e4, checks, financing, bonusMonths,
    loan: loan ? { lender: loan.lender, rate: num(loan.annual_rate), principal: num(loan.principal) } : null,
    longTermSuppliers, diagnostics,
    weekly: buildWeeklyInputs(view, { asof, mdr, bills, dupBills, customers, keyCustomer, supplier }),
  };
}

function assumptionsByScenario(rows) {
  const A = {};
  for (const r of rows) (A[r.scenario] ||= {})[r.driver] = num(r.value);
  return A;
}

/** Straight-line depreciation for month k across all fixed assets. A purchase after the 1st starts the following month. */
export function depreciation(assets, k) {
  const y = +k.slice(0, 4), m = +k.slice(5, 7);
  let t = 0;
  for (const a of assets) {
    const py = +a.purchase_date.slice(0, 4), pm = +a.purchase_date.slice(5, 7);
    const n = (y - py) * 12 + (m - pm);
    const startOff = a.purchase_date.slice(8) > "01" ? 1 : 0;
    const life = num(a.useful_life_years) * 12;
    if (n >= startOff && n < startOff + life) t += num(a.cost) / life;
  }
  return t;
}

/** Map a dataset forecast event onto the engine's event kinds. */
export function mapEvent(e) {
  const d = e.description, type = e.type;
  let kind = "payment";
  if (type === "outflow") kind = /oven|equipment|machine|grinder|chiller|fit-?out/i.test(d) ? "capex" : /bonus|payroll/i.test(d) ? "cost" : "payment";
  else if (type === "inflow") kind = "revenue";
  else if (type === "recurring_change") kind = "monthly";
  else if (type === "revenue_loss") kind = "note";
  const sc = e.scenarios === "all" ? ["worst", "expected", "best"] : e.scenarios.split(";").map((s) => s.trim());
  return {
    id: e.event_id, name: d.replace(/\s*\((?:ProBake )?quotation[^)]*\)/i, "").replace(/, gross$/, ""),
    month: e.event_date.slice(0, 7), date: e.event_date, kind, amount: num(e.amount), sc, certainty: e.certainty,
    payroll: /bonus|payroll/i.test(d) || undefined,
  };
}
