import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, num } from "../src/lib/csv.js";
import { TENANT_TABLES, UNTRUSTED_COLUMNS } from "../src/data/repository.js";
import { getRepo } from "./helpers.js";

test("CSV parser handles quotes, embedded commas, escaped quotes and newlines", () => {
  const rows = parseCsv('a,b,c\n1,"x, y","say ""hi"""\n2,"line1\nline2",\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: "1", b: "x, y", c: 'say "hi"' });
  assert.equal(rows[1].b, "line1\nline2");
  assert.equal(rows[1].c, "");
});

test("num() never returns NaN", () => {
  assert.equal(num(""), 0);
  assert.equal(num("abc"), 0);
  assert.equal(num("1,234.5"), 1234.5);
});

test("a tenant view contains only that business's rows, in every table", () => {
  const repo = getRepo();
  for (const id of ["B001", "B002"]) {
    const view = repo.tenant(id);
    for (const t of TENANT_TABLES) {
      const leaked = view.tables[t].filter((r) => r.business_id !== id);
      assert.equal(leaked.length, 0, `${t} leaked ${leaked.length} rows into ${id}`);
    }
  }
  // B002 has rows in the shared files, so the filter is doing real work
  assert.ok(repo.tables.bank_statement.some((r) => r.business_id === "B002"));
  assert.ok(repo.tenant("B002").tables.bank_statement.length > 0);
  assert.equal(repo.tenant("B002").tables.pos_daily_sales.length, 0);
});

test("tenant views are read-only", () => {
  const view = getRepo().tenant("B001");
  assert.throws(() => { view.tables.bank_statement.push({}); });
  assert.throws(() => { "use strict"; view.tables.bank_statement[0].running_balance = "999"; });
});

test("unknown business IDs are refused", () => {
  assert.throws(() => getRepo().tenant("B999"), /Unknown business/);
  assert.throws(() => getRepo().tenant("../B001"), /Unknown business/);
});

test("free-text columns from third parties are dropped at load", () => {
  const repo = getRepo();
  for (const [name, rows] of Object.entries(repo.tables)) {
    for (const col of UNTRUSTED_COLUMNS) assert.ok(!rows.length || !(col in rows[0]), `${name}.${col} should not be loaded`);
  }
});

test("answer keys are not part of the loaded data", () => {
  const names = Object.keys(getRepo().tables);
  assert.ok(!names.some((n) => /answer|planted|reconciliation_key|reference/.test(n)));
});
