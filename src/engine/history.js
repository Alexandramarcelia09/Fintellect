// Financial statements from monthly inputs. Pure and deterministic; runs in Node and the browser.
//
// State `S` holds: open (opening balance sheet), cats (category lists), data[month] = {rev, cogs, opex, other}.
// Each month produces a P&L, an indirect-method cash flow and a balance sheet. The balance sheet
// balances by construction whenever the opening balance sheet balances.

export const POS_GROUP = "Café (POS)";

export function sumObj(cats, o) {
  let s = 0;
  for (const c of cats) s += (o && o[c.id]) || 0;
  return s;
}

export function computeHistory(S, months) {
  const H = [];
  const o = S.open;
  let p = { cash: o.cash, ar: o.ar, inv: o.inv, oca: o.oca, deposit: o.deposit, equip: o.equip, ap: o.ap, ocl: o.ocl, loan: o.loan, capital: o.capital, re: o.re, drawCum: 0 };
  const posIds = S.cats.rev.filter((c) => c.group === POS_GROUP).map((c) => c.id);
  months.forEach((k, i) => {
    const d = S.data[k], x = d.other;
    const revCat = {}, cogsCat = {}, opexCat = {};
    S.cats.rev.forEach((c) => (revCat[c.id] = d.rev[c.id] || 0));
    S.cats.cogs.forEach((c) => (cogsCat[c.id] = d.cogs[c.id] || 0));
    S.cats.opex.forEach((c) => (opexCat[c.id] = d.opex[c.id] || 0));
    const rev = sumObj(S.cats.rev, d.rev), cogs = sumObj(S.cats.cogs, d.cogs), opex = sumObj(S.cats.opex, d.opex);
    const pos = posIds.reduce((a, id) => a + (d.rev[id] || 0), 0);
    const dep = S.cats.opex.filter((c) => c.type === "NONCASH").reduce((a, c) => a + (d.opex[c.id] || 0), 0);
    const gross = rev - cogs, op = gross - opex, np = op - x.interest - x.tax;
    const dAR = x.ar - p.ar, dInv = x.inv - p.inv, dOCA = x.oca - p.oca, dDep = x.deposit - p.deposit, dAP = x.ap - p.ap, dOCL = x.ocl - p.ocl;
    const cfo = np + dep - dAR - dInv - dOCA - dDep + dAP + dOCL;
    const cfi = -x.capex + x.assetSale;
    const cff = x.loanIn - x.loanRepay + x.ownerIn - x.drawings;
    const cash = p.cash + cfo + cfi + cff;
    const equip = p.equip + x.capex - dep - x.assetSale, loan = p.loan + x.loanIn - x.loanRepay;
    const capital = p.capital + x.ownerIn, re = p.re + np, drawCum = p.drawCum + x.drawings;
    const stDebt = Math.min(loan, Math.max(0, x.loanRepay) * 12), ltDebt = loan - stDebt;
    const curAssets = cash + x.ar + x.inv + x.oca, assets = curAssets + x.deposit + equip;
    const curLiab = x.ap + x.ocl + stDebt, liab = x.ap + x.ocl + loan, equity = capital + re - drawCum;
    const cashCosts = cogs + (opex - dep) + x.interest + x.tax;
    H.push({
      k, i, rev, pos, b2b: rev - pos, revCat, cogs, cogsCat, opex, opexCat, dep, gross, op, interest: x.interest, tax: x.tax, np,
      dAR, dInv, dOCA, dDep, dAP, dOCL, cfo, capex: x.capex, assetSale: x.assetSale, cfi, loanIn: x.loanIn, loanRepay: x.loanRepay,
      ownerIn: x.ownerIn, drawings: x.drawings, cff, openCash: p.cash, cash, ar: x.ar, inv: x.inv, oca: x.oca, deposit: x.deposit, equip,
      ap: x.ap, ocl: x.ocl, loan, stDebt, ltDebt, capital, re, drawCum, curAssets, assets, curLiab, liab, equity,
      imbalance: assets - liab - equity, cashCosts,
      gm: rev ? gross / rev : 0, om: rev ? op / rev : 0, nm: rev ? np / rev : 0, cr: curLiab ? curAssets / curLiab : Infinity, dr: assets ? liab / assets : 0,
    });
    p = { cash, ar: x.ar, inv: x.inv, oca: x.oca, deposit: x.deposit, equip, ap: x.ap, ocl: x.ocl, loan, capital, re, drawCum };
  });
  return H;
}

/** Runway: burn = average monthly fall in cash from operations, loan repayments and drawings over the
 *  last 3 months. Equipment purchases and new funding are left out. */
export function runwayAt(H, i) {
  const w = H.slice(Math.max(0, i - 2), i + 1);
  const net = w.reduce((a, h) => a + h.cfo - h.loanRepay - h.drawings, 0) / w.length;
  const costs = w.reduce((a, h) => a + h.cashCosts, 0) / w.length;
  const cash = H[i].cash;
  return { burn: -net, months: net < 0 ? cash / -net : Infinity, cover: costs ? cash / costs : 0, cash };
}
