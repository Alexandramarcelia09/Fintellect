// Monthly forecast, 12–36 months. Deterministic: the same inputs always give the same output.
//
// Revenue: café (POS) and B2B streams, each starting from its deseasonalised last-3-month level,
// growing monthly, with last-12-month seasonality. The key customer's invoices are issued at
// month end and collected after 30-day terms plus the scenario's days late; other revenue is
// collected in the month. GST collected accrues and is paid the month after each quarter;
// corporate tax accrues monthly and is paid each November.

import { addM } from "./dates.js";

function lastDay(k) { return new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)); }
const keyOf = (d) => d.toISOString().slice(0, 7);
const plusDays = (d, n) => new Date(d.getTime() + n * 864e5);

/**
 * @param DS  bootstrap dataset (hvShare, gstRatio, hvOpen, depF, loanF)
 * @param S   state (assumptions, events, global, cats)
 * @param H   computed history
 * @param sc  "worst" | "expected" | "best"
 * @param horizon months
 * @param over optional assumption overrides, e.g. { hvDelay: 0 }
 */
export function forecast(DS, S, H, sc, horizon, over) {
  const A = Object.assign({}, S.assumptions[sc], over || {});
  const last = H[H.length - 1], L12 = H.slice(-12), L3 = H.slice(-3);
  const seasOn = S.global.seasonality;
  const idx = (f) => {
    const avg = L12.reduce((a, h) => a + h[f], 0) / L12.length, o = {};
    L12.forEach((h) => (o[+h.k.slice(5)] = avg ? h[f] / avg : 1));
    return (cm) => (seasOn ? o[cm] || 1 : 1);
  };
  const sP = idx("pos"), sB = idx("b2b");
  const baseP = L3.reduce((a, h) => a + h.pos / sP(+h.k.slice(5)), 0) / 3;
  const baseB = L3.reduce((a, h) => a + h.b2b / sB(+h.k.slice(5)), 0) / 3;
  const pos12 = L12.reduce((a, h) => a + h.pos, 0);
  const fixed = {}, varRatio = {};
  S.cats.opex.forEach((c) => {
    if (c.type === "FIXED") fixed[c.id] = ["sal", "cpf", "rent", "ins"].includes(c.id) ? last.opexCat[c.id] || 0 : L12.reduce((a, h) => a + (h.opexCat[c.id] || 0), 0) / 12;
    else if (c.type === "VARIABLE") varRatio[c.id] = pos12 ? L12.reduce((a, h) => a + (h.opexCat[c.id] || 0), 0) / pos12 : 0;
  });
  const noGrowth = { rent: 1, ins: 1 };
  const evs = S.events.filter((e) => e.sc.includes(sc));
  const share = DS.hvShare, gstR = DS.gstRatio, taxM = last.tax;
  const coll = {};
  const addColl = (k, v) => (coll[k] = (coll[k] || 0) + v);
  const asof = lastDay(last.k);
  DS.hvOpen.forEach((inv) => {
    let d = plusDays(new Date(inv.due + "T00:00:00Z"), A.hvDelay);
    if (d <= asof) d = plusDays(asof, 1);
    addColl(keyOf(d), inv.amount);
  });
  let cash = last.cash, depExtra = 0, yearsStepped = 0, gstQ = 0, extraLoan = 0, extraRepay = 0;
  const out = [];
  let k = last.k;
  for (let t = 1; t <= horizon; t++) {
    k = addM(k, 1);
    const cm = +k.slice(5);
    if (cm === 1) yearsStepped++;
    const evM = evs.filter((e) => e.month === k);
    const sumK = (kind) => evM.filter((e) => e.kind === kind).reduce((a, e) => a + e.amount, 0);
    const pos = baseP * Math.pow(1 + A.posGrowth / 100, t + 1) * sP(cm);
    const b2b = baseB * Math.pow(1 + A.b2bGrowth / 100, t + 1) * sB(cm);
    const oneRev = sumK("revenue");
    const rev = pos + b2b + oneRev, cogs = (rev * A.cogsPct) / 100;
    let opexCash = 0, opexVar = 0;
    for (const id in fixed) opexCash += fixed[id] * (noGrowth[id] ? 1 : Math.pow(1 + A.opexGrowth / 100, yearsStepped));
    for (const id in varRatio) opexVar += pos * varRatio[id];
    opexCash += opexVar;
    opexCash += evs.filter((e) => e.kind === "monthly" && e.month <= k).reduce((a, e) => a + e.amount, 0);
    opexCash += sumK("cost");
    const capex = sumK("capex"), payments = sumK("payment"), loansIn = sumK("in"), equityIn = sumK("equity");
    const dep = (DS.depF[k] ?? last.dep) + depExtra;
    depExtra += capex / 60;
    const lf = DS.loanF[k] || [0, 0];
    if (loansIn) { extraLoan += loansIn; extraRepay += loansIn / 36; }
    const xPay = Math.min(extraLoan, loansIn ? 0 : extraRepay);
    extraLoan -= xPay;
    const interest = lf[0] + (extraLoan * 0.045) / 12, principal = lf[1] + xPay;
    const tax = taxM;
    const opex = opexCash + dep, gross = rev - cogs, op = gross - opex, np = op - interest - tax;
    const hvRev = b2b * share;
    addColl(keyOf(plusDays(lastDay(k), 30 + A.hvDelay)), hvRev);
    const hvIn = coll[k] || 0;
    const gstIn = rev * gstR;
    // A planned GST or tax payment event in the month replaces the automatic one (it settles a past period)
    const plannedGst = evM.some((e) => e.kind === "payment" && /\bGST\b/i.test(e.name));
    const plannedTax = evM.some((e) => e.kind === "payment" && /income tax/i.test(e.name));
    let gstPaid = 0;
    if ([1, 4, 7, 10].includes(cm) && !plannedGst) { gstPaid = gstQ; gstQ = 0; }
    gstQ += gstIn;
    const taxPaid = cm === 11 && !plannedTax ? taxM * 12 : 0;
    const drawings = S.global.drawings;
    const flow = np + dep + tax - hvRev + hvIn + gstIn - gstPaid - taxPaid - principal - drawings - capex - payments + loansIn + equityIn;
    const openCash = cash;
    cash += flow;
    out.push({
      k, t, rev, pos, b2b, oneRev, cogs, gross, opex, opexCash, opexVar, dep, op, interest, tax, np, principal, drawings, capex, payments, loansIn, equityIn,
      hvRev, hvIn, gstIn, gstPaid, taxPaid, flow, openCash, cash, events: evM, cashCosts: cogs + opexCash + interest, opFlow: np + dep + tax - principal - drawings,
    });
  }
  return out;
}

export function fcSummary(F, buffer) {
  const rev = F.reduce((a, f) => a + f.rev, 0), gross = F.reduce((a, f) => a + f.gross, 0), np = F.reduce((a, f) => a + f.np, 0);
  let min = F[0], neg = null, below = null;
  F.forEach((f) => {
    if (f.cash < min.cash) min = f;
    if (neg === null && f.cash < 0) neg = f;
    if (below === null && f.cash < buffer) below = f;
  });
  const end = F[F.length - 1], w = F.slice(-3);
  const net = w.reduce((a, f) => a + f.opFlow, 0) / w.length, costs = w.reduce((a, f) => a + f.cashCosts, 0) / w.length;
  return {
    rev, gross, np, gm: rev ? gross / rev : 0, nm: rev ? np / rev : 0, end, min, neg, below,
    monthsBelow: F.filter((f) => f.cash < buffer).length, burn: -net,
    runway: end.cash <= 0 ? 0 : net < 0 ? end.cash / -net : Infinity, cover: costs ? end.cash / costs : 0,
  };
}
