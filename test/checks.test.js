import { test } from "node:test";
import assert from "node:assert/strict";
import { getDataset } from "./helpers.js";

const DS = getDataset();

test("finds the duplicate bill entry and leaves it out", () => {
  const c = DS.checks.find((x) => x.type === "dup_bill");
  assert.equal(c.ref, "BILL-00272");
});

test("finds the bill that was paid twice", () => {
  const c = DS.checks.find((x) => x.type === "dup_pay");
  assert.equal(c.ref, "BILL-00246");
});

test("flags the payee that isn't approved and the one pending verification", () => {
  const refs = DS.checks.filter((x) => x.type === "payee").map((x) => x.ref).sort();
  assert.deepEqual(refs, ["BILL-00274", "S008"]);
});

test("identifies Harbourview as the key customer and shows it paying later", () => {
  assert.equal(DS.keyCustomer.id, "C001");
  const hv = DS.customers.find((c) => c.id === "C001");
  assert.equal(hv.outstanding, 41966.19);
  assert.ok(hv.avgLate6 > hv.avgLatePrior6 * 1.5, "recent lateness should be over 50% worse (alert AL-05)");
  const first = hv.trend[0][1], last = hv.trend.at(-1)[1];
  assert.ok(last > first * 2);
  assert.ok(hv.overdue > 0 && hv.oldestOverdueDays > 30, "an invoice is more than 30 days overdue (alert AL-04)");
});

test("other customers keep paying on their normal habit", () => {
  for (const c of DS.customers.filter((x) => x.id !== "C001" && x.avgLatePrior6 != null)) {
    assert.ok(Math.abs(c.avgLate6 - c.avgLatePrior6) < 5, c.name);
  }
});

test("bills from unverified payees are held in the 13-week forecast", () => {
  const held = DS.weekly.openAP.filter((b) => b.held);
  assert.deepEqual(held.map((b) => b.id), ["BILL-00274"]);
  assert.ok(!DS.weekly.openAP.some((b) => b.id === "BILL-00272"), "duplicate bill must not be paid");
});
