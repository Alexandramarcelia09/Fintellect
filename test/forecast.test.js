import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHistory, forecast, fcSummary, forecastWeekly } from "../src/engine/index.js";
import { getDataset, stateFrom, referenceForecast } from "./helpers.js";

const DS = getDataset();
const S = stateFrom(DS);
const H = computeHistory(S, DS.months);
const BUFFER = DS.global.minBuffer;
const weekly = (sc, over = {}, events = DS.events) =>
  forecastWeekly(DS.weekly, { ...DS.assumptions[sc], ...over }, { events, scenario: sc, drawings: DS.global.drawings, baseCogsPct: DS.assumptions.expected.cogsPct });

/* ---------- monthly ---------- */

test("monthly forecast is deterministic", () => {
  const a = forecast(DS, S, H, "expected", 36), b = forecast(DS, S, H, "expected", 36);
  assert.deepEqual(a.map((f) => f.cash), b.map((f) => f.cash));
});

test("scenarios are ordered: worst ≤ expected ≤ best, for every month", () => {
  const w = forecast(DS, S, H, "worst", 36), e = forecast(DS, S, H, "expected", 36), b = forecast(DS, S, H, "best", 36);
  for (let i = 0; i < 36; i++) assert.ok(w[i].cash <= e[i].cash + 1 && e[i].cash <= b[i].cash + 1, w[i].k);
});

test("one-time events change forecast cash by their amount", () => {
  const base = forecast(DS, S, H, "expected", 12);
  const extra = { ...S, events: [...S.events, { id: "t1", name: "Test purchase", month: "2027-03", kind: "payment", amount: 10000, sc: ["expected"] }] };
  const with10k = forecast(DS, extra, H, "expected", 12);
  const i = base.findIndex((f) => f.k === "2027-03");
  assert.ok(Math.abs(base[i - 1].cash - with10k[i - 1].cash) < 0.01);
  assert.ok(Math.abs(base[i].cash - with10k[i].cash - 10000) < 0.01);
});

test("GST collected is paid the month after each quarter, except where a planned GST payment covers it", () => {
  const F = forecast(DS, S, H, "expected", 12);
  assert.equal(F.find((f) => f.k === "2026-10").gstPaid, 0, "Q3 2026 GST is a planned event");
  assert.ok(F.find((f) => f.k === "2027-01").gstPaid > 10000);
  assert.equal(F.find((f) => f.k === "2027-02").gstPaid, 0);
});

test("Harbourview paying on time improves the monthly low point", () => {
  const late = fcSummary(forecast(DS, S, H, "expected", 3), BUFFER), onTime = fcSummary(forecast(DS, S, H, "expected", 3, { hvDelay: 0 }), BUFFER);
  assert.ok(onTime.min.cash - late.min.cash > 10000);
});

/* ---------- 13-week, checked against the dataset's reference forecast ---------- */

const ref = referenceForecast();
const refFor = (sc) => ref.filter((r) => r.scenario === sc).map((r) => ({ start: r.week_start, closing: +r.projected_closing_balance, net: +r.net_cash_flow }));

test("13 weeks start the day after the as-of date and open at the bank balance", () => {
  const r = weekly("expected");
  assert.equal(r.weeks.length, 13);
  assert.equal(r.weeks[0].start, "2026-10-01");
  assert.equal(r.startCash, 50827.8);
  assert.deepEqual(r.weeks.map((w) => w.start), refFor("expected").map((w) => w.start));
});

test("every scenario finds the same low-point week as the reference (week of 26 Nov)", () => {
  for (const sc of ["worst", "expected", "best"]) {
    const ours = weekly(sc).low.start;
    const theirs = refFor(sc).reduce((m, w) => (w.closing < m.closing ? w : m)).start;
    assert.equal(ours, theirs, sc);
    assert.equal(ours, "2026-11-26");
  }
});

test("week-to-week movements follow the reference: same direction in at least 11 of 13 weeks", () => {
  for (const sc of ["worst", "expected", "best"]) {
    const ours = weekly(sc).weeks, theirs = refFor(sc);
    const agree = ours.filter((w, i) => Math.sign(w.net) === Math.sign(theirs[i].net)).length;
    assert.ok(agree >= 11, `${sc}: ${agree}/13`);
  }
});

test("balances stay close to the reference, which is simpler on purpose (see README)", () => {
  // Our balances run higher because (1) new orders from 30-day suppliers are paid on their terms rather than
  // from week 3, and (2) new invoices from every customer are projected, not just two. In the best case
  // Harbourview pays within 5 days, so its October invoice lands in December; the reference leaves it out.
  const limit = { worst: 25000, expected: 25000, best: 40000 };
  for (const sc of ["worst", "expected", "best"]) {
    weekly(sc).weeks.forEach((w, i) => assert.ok(Math.abs(w.closing - refFor(sc)[i].closing) < limit[sc], `${sc} ${w.start}`));
    // the first two weeks are almost entirely known items, so they must be close
    weekly(sc).weeks.slice(0, 2).forEach((w, i) => assert.ok(Math.abs(w.closing - refFor(sc)[i].closing) < 3000, `${sc} ${w.start}`));
  }
});

test("the expected case breaches the S$30K buffer around the November crunch", () => {
  const r = weekly("expected");
  assert.ok(r.low.closing < BUFFER);
  assert.ok(r.weeks.filter((w) => w.closing < BUFFER).length >= 2);
});

test("if Harbourview paid on time there would be no breach", () => {
  const r = weekly("expected", { hvDelay: 0 });
  assert.ok(r.low.closing >= BUFFER, `low ${r.low.closing}`);
});

test("scenario lows are ordered worst < expected < best", () => {
  const [w, e, b] = ["worst", "expected", "best"].map((sc) => weekly(sc).low.closing);
  assert.ok(w < e && e < b);
});

test("every weekly item is dated inside the 13 weeks and weeks add up", () => {
  const r = weekly("expected");
  let bal = r.startCash;
  for (const w of r.weeks) {
    for (const it of w.items) assert.ok(it.date >= w.start && it.date <= w.end, it.label);
    const sumItems = w.items.reduce((a, it) => a + it.amount, 0);
    assert.ok(Math.abs(sumItems - w.net) < 0.01);
    bal += w.net;
    assert.ok(Math.abs(bal - w.closing) < 0.01);
  }
});

test("payroll bonus events are split into net pay and next month's CPF", () => {
  const r = weekly("expected");
  const items = r.weeks.flatMap((w) => w.items).filter((it) => /bonus/i.test(it.label));
  assert.equal(items.length, 1, "CPF on the bonus falls in January, after the horizon");
  assert.ok(Math.abs(items[0].amount + 22866 * DS.weekly.payroll.netRatio) < 1);
  assert.equal(items[0].date, "2026-12-28");
});
