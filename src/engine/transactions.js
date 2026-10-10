// Transactions the user records on top of the dataset. Pure and deterministic; runs in Node and the browser.
//
// Each transaction adds to one month's inputs before the statements are built, so it flows into the
// P&L, cash flow, balance sheet, dashboard and forecast like any other figure. Amounts exclude GST.
//
//   sale       revenue, paid on the day                 rev[category]
//   invoice    revenue, unpaid until paidOn             rev[category] + accounts receivable until paid
//   expense    cost, paid on the day                    cogs/opex[category]
//   bill       cost, unpaid until paidOn                cogs/opex[category] + accounts payable until paid
//   equipment  equipment bought                         capex
//   loan       loan received                            loanIn
//   repayment  loan principal repaid                    loanRepay
//   owner_in   owner puts money in                      ownerIn
//   drawings   owner takes money out                    drawings

export const TXN_KINDS = [
  ["sale", "Sale (paid)"],
  ["invoice", "Customer invoice"],
  ["expense", "Expense (paid)"],
  ["bill", "Supplier bill"],
  ["equipment", "Equipment purchase"],
  ["loan", "Loan received"],
  ["repayment", "Loan repayment"],
  ["owner_in", "Owner investment"],
  ["drawings", "Owner drawings"],
];
const OTHER_FIELD = { equipment: "capex", loan: "loanIn", repayment: "loanRepay", owner_in: "ownerIn", drawings: "drawings" };
/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-30, which Date would roll into March). */
export function isIsoDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export const txnNeedsCategory = (kind) => kind === "sale" || kind === "invoice" || kind === "expense" || kind === "bill";
export const txnIsIncome = (kind) => kind === "sale" || kind === "invoice";
export const txnHasDue = (kind) => kind === "invoice" || kind === "bill";

/** Which section ("rev", "cogs" or "opex") a category id belongs to, or null. Depreciation can't take transactions. */
export function categorySection(cats, id) {
  if (cats.rev.some((c) => c.id === id)) return "rev";
  if (cats.cogs.some((c) => c.id === id)) return "cogs";
  if (cats.opex.some((c) => c.id === id && c.type !== "NONCASH")) return "opex";
  return null;
}

/**
 * Returns a copy of S whose monthly data includes the transactions. Months that no transaction touches
 * keep their original objects. Transactions outside `months` or with an unknown category are skipped.
 */
export function applyTransactions(S, months) {
  const txns = S.txns || [];
  if (!txns.length) return S;
  const data = { ...S.data }, touched = new Set();
  const month = (k) => {
    if (!touched.has(k)) {
      const d = data[k];
      data[k] = { rev: { ...d.rev }, cogs: { ...d.cogs }, opex: { ...d.opex }, other: { ...d.other } };
      touched.add(k);
    }
    return data[k];
  };
  const inRange = new Set(months);
  for (const t of txns) {
    const k = t.date.slice(0, 7);
    if (!inRange.has(k)) continue;
    if (txnNeedsCategory(t.kind)) {
      const sec = categorySection(S.cats, t.category);
      if (!sec || (sec === "rev") !== txnIsIncome(t.kind)) continue;
      const d = month(k);
      d[sec][t.category] = (d[sec][t.category] || 0) + t.amount;
      if (txnHasDue(t.kind)) {
        // Owed at every month end from the issue month until the month it's paid.
        const field = t.kind === "invoice" ? "ar" : "ap", paidK = t.paidOn ? t.paidOn.slice(0, 7) : null;
        for (const m of months) if (m >= k && (!paidK || m < paidK)) month(m).other[field] += t.amount;
      }
    } else if (OTHER_FIELD[t.kind]) {
      month(k).other[OTHER_FIELD[t.kind]] += t.amount;
    }
  }
  return { ...S, data };
}

/** Totals of the recorded transactions per month: { "2026-09": { income, spend, count } }. */
export function txnTotalsByMonth(txns) {
  const out = {};
  for (const t of txns || []) {
    const k = t.date.slice(0, 7), o = (out[k] ||= { income: 0, spend: 0, count: 0 });
    o.count++;
    if (txnIsIncome(t.kind) || t.kind === "loan" || t.kind === "owner_in") o.income += t.amount;
    else o.spend += t.amount;
  }
  return out;
}

/** Parses CSV text with columns date, type, category, amount, description, paid_on (header row required). */
export function parseTxnCsv(text, cats) {
  const lines = String(text).replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: ["The file is empty"] };
  const split = (l) => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const head = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const col = (n) => head.indexOf(n);
  if (col("date") < 0 || col("type") < 0 || col("amount") < 0) return { rows: [], errors: ["The first row must name the columns: date, type, category, amount, description, paid_on"] };
  const kindByName = {};
  for (const [id, label] of TXN_KINDS) { kindByName[id] = id; kindByName[label.toLowerCase()] = id; }
  const allCats = [...cats.rev, ...cats.cogs, ...cats.opex];
  const catBy = (s) => { const v = s.toLowerCase(); return allCats.find((c) => c.id.toLowerCase() === v || c.name.toLowerCase() === v); };
  const rows = [], errors = [];
  lines.slice(1).forEach((l, i) => {
    const f = split(l), get = (n) => (col(n) >= 0 ? f[col(n)] || "" : ""), line = i + 2;
    const kind = kindByName[get("type").toLowerCase()];
    const amount = Number(get("amount").replace(/[^\d.-]/g, ""));
    const date = get("date"), paidOn = get("paid_on");
    if (!isIsoDate(date)) return errors.push(`Line ${line}: date must look like 2026-09-15`);
    if (!kind) return errors.push(`Line ${line}: unknown type "${get("type")}"`);
    if (!Number.isFinite(amount) || amount <= 0) return errors.push(`Line ${line}: amount must be a positive number`);
    if (paidOn && !isIsoDate(paidOn)) return errors.push(`Line ${line}: paid_on must look like 2026-10-15`);
    const row = { date, kind, amount: Math.round(amount * 100) / 100, description: get("description").slice(0, 120) };
    if (txnNeedsCategory(kind)) {
      const c = catBy(get("category"));
      const sec = c && categorySection(cats, c.id);
      if (!sec || (sec === "rev") !== txnIsIncome(kind)) return errors.push(`Line ${line}: category "${get("category")}" doesn't fit a ${kind}`);
      row.category = c.id;
    }
    if (txnHasDue(kind) && paidOn) row.paidOn = paidOn;
    rows.push(row);
  });
  return { rows, errors };
}
