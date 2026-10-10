// Financial model on top of the monthly forecast: a linked three-statement projection (P&L, cash flow,
// balance sheet), break-even analysis and a simple valuation. Pure and deterministic.
//
// The balance sheet starts from the last actual month and moves only by the forecast's own flows,
// so it balances by construction and closing cash always equals the forecast's cash line:
//   receivables   + key customer's invoices issued − collected (other receivables held flat)
//   equipment     + purchases − depreciation
//   taxes payable + GST collected − GST paid + tax accrued − tax paid − planned GST/tax/CPF payments
//   loans         + new loans − principal repaid
//   equity        + net profit + owner money in − drawings − other planned payments
// Stock, prepayments, the rental deposit and supplier payables are held at their last actual level.

const TAX_PAYMENT = /\bGST\b|tax|CPF/i;
const FLOW_KEYS = ["rev", "pos", "b2b", "oneRev", "cogs", "gross", "opexCash", "opexVar", "dep", "opex", "ebitda", "op", "interest", "tax", "np",
  "cfo", "cfi", "cff", "net", "capex", "drawings", "loansIn", "principal", "equityIn", "otherPay", "dAR", "dTaxes", "fcf"];
const BAL_KEYS = ["cash", "ar", "inv", "oca", "deposit", "equip", "ap", "ocl", "loan", "equity", "curAssets", "assets", "liab", "check"];

/** One row per forecast month with P&L, cash flow and balance sheet. `last` is the last actual month from computeHistory. */
export function threeStatement(F, last) {
  let b = { ar: last.ar, inv: last.inv, oca: last.oca, deposit: last.deposit, equip: last.equip, ap: last.ap, ocl: last.ocl, loan: last.loan, equity: last.equity };
  return F.map((f) => {
    const taxPay = f.events.filter((e) => e.kind === "payment" && TAX_PAYMENT.test(e.name)).reduce((a, e) => a + e.amount, 0);
    const otherPay = f.payments - taxPay;
    const dAR = f.hvRev - f.hvIn;
    const dTaxes = f.gstIn - f.gstPaid + f.tax - f.taxPaid - taxPay;
    const cfo = f.np + f.dep - dAR + dTaxes, cfi = -f.capex;
    const cff = f.loansIn - f.principal + f.equityIn - f.drawings - otherPay;
    b = { ...b, ar: b.ar + dAR, equip: b.equip + f.capex - f.dep, ocl: b.ocl + dTaxes, loan: b.loan + f.loansIn - f.principal, equity: b.equity + f.np + f.equityIn - f.drawings - otherPay };
    const curAssets = f.cash + b.ar + b.inv + b.oca, assets = curAssets + b.deposit + b.equip, liab = b.ap + b.ocl + b.loan;
    return {
      k: f.k, t: f.t, rev: f.rev, pos: f.pos, b2b: f.b2b, oneRev: f.oneRev, cogs: f.cogs, gross: f.gross, opexCash: f.opexCash, opexVar: f.opexVar, dep: f.dep,
      opex: f.opex, ebitda: f.op + f.dep, op: f.op, interest: f.interest, tax: f.tax, np: f.np,
      cfo, cfi, cff, net: cfo + cfi + cff, capex: f.capex, drawings: f.drawings, loansIn: f.loansIn, principal: f.principal, equityIn: f.equityIn, otherPay, dAR, dTaxes,
      // Unlevered free cash flow: operating cash before interest, less equipment spending.
      fcf: cfo + f.interest + cfi,
      openCash: f.openCash, cash: f.cash, ...b, curAssets, assets, liab, check: assets - liab - b.equity, events: f.events,
    };
  });
}

/** Groups monthly rows into forecast years of 12 months: flows are summed, balances taken at the year end. */
export function annualize(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 12) {
    const ch = rows.slice(i, i + 12), end = ch[ch.length - 1], y = { from: ch[0].k, to: end.k, months: ch.length, openCash: ch[0].openCash };
    for (const key of FLOW_KEYS) y[key] = ch.reduce((a, r) => a + r[key], 0);
    for (const key of BAL_KEYS) y[key] = end[key];
    out.push(y);
  }
  return out;
}

/**
 * Break-even from period totals. `variable` costs move with sales (COGS, card fees); `fixed` costs don't
 * (staff, rent, depreciation, interest). Tax is left out: break-even is the point of zero pre-tax profit.
 */
export function breakEven({ rev, variable, fixed, months }) {
  const cmr = rev ? 1 - variable / rev : 0;
  const fixedM = fixed / months, revM = rev / months;
  const beM = cmr > 0 ? fixedM / cmr : Infinity;
  return { revM, variableM: variable / months, fixedM, cmr, beM, beDay: beM * 12 / 365, safety: revM ? (revM - beM) / revM : 0, profitM: revM * cmr - fixedM };
}

/** Break-even inputs for actual months (H rows) given which operating cost categories are variable. */
export function breakEvenActual(Hs, varIds) {
  const varOpex = (h) => varIds.reduce((a, id) => a + (h.opexCat[id] || 0), 0);
  return breakEven({
    rev: Hs.reduce((a, h) => a + h.rev, 0),
    variable: Hs.reduce((a, h) => a + h.cogs + varOpex(h), 0),
    fixed: Hs.reduce((a, h) => a + h.opex - varOpex(h) + h.interest, 0),
    months: Hs.length,
  });
}

/** Break-even inputs for forecast rows from threeStatement. */
export function breakEvenForecast(rows) {
  return breakEven({
    rev: rows.reduce((a, r) => a + r.rev, 0),
    variable: rows.reduce((a, r) => a + r.cogs + r.opexVar, 0),
    fixed: rows.reduce((a, r) => a + r.opex - r.opexVar + r.interest, 0),
    months: rows.length,
  });
}

/**
 * Valuation from forecast rows (ideally 36 months).
 * The P&L has no salary for the owner, who is paid through drawings, so both methods first deduct a
 * market salary for running the business (`ownerPay` per month), as a buyer would have to pay one.
 * DCF: unlevered free cash flow discounted monthly at the annual rate, plus a terminal value on the last
 * 12 months' free cash flow growing at `growth` forever. Multiple: last 12 actual months' EBITDA × `multiple`.
 * Both convert enterprise value to equity value by adding cash and subtracting loans at the valuation date.
 */
export function valuation(rows, { discount, growth, multiple, ownerPay }, { cash, loan, ebitdaL12 }) {
  const r = discount / 100, g = growth / 100, n = rows.length;
  const df = (t) => Math.pow(1 + r, -t / 12);
  const fcf = (row) => row.fcf - ownerPay;
  const pvFcf = rows.reduce((a, row) => a + fcf(row) * df(row.t), 0);
  const fcfLast12 = rows.slice(-12).reduce((a, row) => a + fcf(row), 0) * (12 / Math.min(12, n));
  const valid = r > g && r > -1;
  const tv = valid ? (fcfLast12 * (1 + g)) / (r - g) : NaN;
  const pvTv = valid ? tv * df(n) : NaN;
  const ev = pvFcf + pvTv, netDebt = loan - cash;
  const ebitdaAdj = ebitdaL12 - ownerPay * 12, evMult = Math.max(0, ebitdaAdj) * multiple;
  return {
    valid, pvFcf, fcfLast12, tv, pvTv, ev, netDebt, equity: ev - netDebt, tvShare: ev ? pvTv / ev : 0,
    ebitdaL12, ebitdaAdj, evMult, equityMult: evMult - netDebt,
  };
}

/** Valuation settings. Owner pay defaults to the owner's current monthly drawings. */
export const modelDefaults = (drawings) => ({ discount: 15, growth: 2, multiple: 3, ownerPay: drawings });
