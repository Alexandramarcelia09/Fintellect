import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHistory, runwayAt } from "../src/engine/index.js";
import { getDataset, stateFrom, getRepo } from "./helpers.js";
import { num } from "../src/lib/csv.js";

const DS = getDataset();
const H = computeHistory(stateFrom(DS), DS.months);

test("covers April 2025 to September 2026", () => {
  assert.equal(DS.months[0], "2025-04");
  assert.equal(DS.months.at(-1), "2026-09");
  assert.equal(DS.months.length, 18);
});

test("closing cash matches the bank statement every month, to the cent", () => {
  for (const h of H) assert.ok(Math.abs(h.cash - DS.bank[h.k]) < 0.01, `${h.k}: ${h.cash.toFixed(2)} vs bank ${DS.bank[h.k]}`);
  assert.equal(Math.round(H.at(-1).cash * 100) / 100, 50827.8);
});

test("the balance sheet balances every month", () => {
  for (const h of H) assert.ok(Math.abs(h.imbalance) < 0.01, `${h.k} off by ${h.imbalance}`);
});

test("the opening balance sheet balances", () => {
  const o = DS.open;
  const assets = o.cash + o.ar + o.inv + o.oca + o.deposit + o.equip, claims = o.ap + o.ocl + o.loan + o.capital + o.re;
  assert.ok(Math.abs(assets - claims) < 0.01);
});

test("the balancing payables line stays close to an independent GST + CPF + tax estimate", () => {
  // Differences come from GST on the grinder and two small bank-only items; they must stay small.
  for (const d of DS.diagnostics) assert.ok(Math.abs(d.ocl - d.estimate) < 500, `${d.k}: ${d.ocl} vs ${d.estimate}`);
});

test("revenue equals POS net sales plus invoice net amounts", () => {
  const T = getRepo().tenant("B001").tables;
  for (const k of ["2025-12", "2026-09"]) {
    const pos = T.pos_daily_sales.filter((r) => r.date.startsWith(k)).reduce((a, r) => a + num(r.net_sales), 0);
    const inv = T.invoices_ar.filter((r) => r.issue_date.startsWith(k)).reduce((a, r) => a + num(r.net_amount), 0);
    const h = H.find((x) => x.k === k);
    assert.ok(Math.abs(h.rev - (pos + inv)) < 0.05, k);
  }
});

test("December 2025 shows the year-end bonus as a loss month", () => {
  const dec = H.find((h) => h.k === "2025-12");
  assert.ok(dec.opexCat.sal > 45000);
  assert.ok(dec.np < 0);
});

test("runway reports cash-positive when cash isn't being burned", () => {
  const r = runwayAt(H, H.length - 1);
  assert.equal(r.months, Infinity);
  assert.ok(r.burn < 0);
});
