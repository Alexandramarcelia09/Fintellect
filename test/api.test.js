import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { getRepo } from "./helpers.js";

let server, base, varDir;
before(async () => {
  varDir = mkdtempSync(join(tmpdir(), "fintellect-test-"));
  server = createServer(createApp({ repo: getRepo(), secret: "test-secret-0123456789", varDir, demoPasscode: "pass-1234", loginLimitPerMinute: 1000 }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(varDir, { recursive: true, force: true }); });

const call = (path, { method = "GET", body, cookie, type = "application/json" } = {}) =>
  fetch(base + path, { method, headers: { ...(type ? { "Content-Type": type } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

async function login(userId, passcode = "pass-1234") {
  const res = await call("/api/login", { method: "POST", body: { userId, passcode } });
  assert.equal(res.status, 200, `login ${userId}`);
  return res.headers.get("set-cookie").split(";")[0];
}
const audit = () => readFileSync(join(varDir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("business data needs a session", async () => {
  assert.equal((await call("/api/businesses/B001/bootstrap")).status, 401);
  assert.equal((await call("/api/me")).status, 401);
});

test("wrong passcode is refused and logged", async () => {
  const res = await call("/api/login", { method: "POST", body: { userId: "U01", passcode: "nope" } });
  assert.equal(res.status, 401);
  assert.ok(audit().some((e) => e.type === "login_failed" && e.userId === "U01"));
});

test("a forged or tampered session cookie is rejected", async () => {
  const good = await login("U01");
  const [payload, sig] = good.split("=")[1].split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "U90", exp: Date.now() + 1e6 })).toString("base64url");
  assert.equal((await call("/api/me", { cookie: `fintellect_session=${forged}.${sig}` })).status, 401);
  assert.equal((await call("/api/me", { cookie: `fintellect_session=${payload}.AAAA` })).status, 401);
});

test("the owner of B001 gets B001's data and nothing from B002", async () => {
  const c = await login("U01");
  const res = await call("/api/businesses/B001/bootstrap", { cookie: c });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("Crumb & Copper"));
  assert.ok(!text.includes("Petal & Stem") && !text.includes("B2C01"));
});

test("asking for another business's data is refused with the same answer as an unknown one, and logged", async () => {
  const c = await login("U90"); // owner of B002
  for (const path of ["/api/businesses/B001/bootstrap", "/api/businesses/B001/forecast/weekly", "/api/businesses/B001/audit", "/api/businesses/B999/bootstrap"]) {
    const res = await call(path, { cookie: c });
    assert.equal(res.status, 403, path);
    assert.deepEqual(await res.json(), { error: "You don't have access to that business" });
  }
  const denied = audit().filter((e) => e.type === "access_denied" && e.userId === "U90");
  assert.ok(denied.length >= 4);
  assert.ok(denied.every((e) => e.businessId === "B002"), "denials are logged against the requester's business");
});

test("B002's owner sees only B002", async () => {
  const c = await login("U90");
  const res = await call("/api/businesses/B002/bootstrap", { cookie: c });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("Crumb") && !text.includes("Harbourview") && !text.includes("C001"));
});

test("read-only roles can't change figures", async () => {
  for (const uid of ["U03", "AGENT"]) {
    const c = await login(uid);
    assert.equal((await call("/api/businesses/B001/bootstrap", { cookie: c })).status, 200, `${uid} can read`);
    const res = await call("/api/businesses/B001/state", { method: "PUT", cookie: c, body: { global: { drawings: 1, minBuffer: 1, seasonality: true } } });
    assert.equal(res.status, 403, uid);
  }
  assert.ok(audit().some((e) => e.type === "write_denied" && e.userId === "AGENT"));
});

test("the owner can save edits; they are validated, persisted and audited", async () => {
  const c = await login("U01");
  const ok = await call("/api/businesses/B001/state", { method: "PUT", cookie: c, body: { global: { drawings: 5000, minBuffer: 30000, seasonality: true } } });
  assert.equal(ok.status, 200);
  const r = await (await call("/api/businesses/B001/bootstrap", { cookie: c })).json();
  assert.equal(r.saved.global.drawings, 5000);
  const e = audit().filter((x) => x.type === "state_saved").at(-1);
  assert.deepEqual(e.changed, ["global"]);
  // server-side forecast uses the saved drawings
  const w = await (await call("/api/businesses/B001/forecast/weekly", { cookie: c })).json();
  assert.ok(w.weeks.flatMap((x) => x.items).some((it) => it.cat === "Owner" && it.amount === -5000));
  assert.equal((await call("/api/businesses/B001/state", { method: "DELETE", cookie: c })).status, 200);
});

test("invalid edits are rejected", async () => {
  const c = await login("U02");
  const bad = [
    { data: { "2031-01": { rev: {}, cogs: {}, opex: {}, other: {} } } },
    { global: { drawings: "lots", minBuffer: 1, seasonality: true } },
    { events: [{ id: "x", name: "a", month: "2027-01", kind: "transfer_all_cash", amount: 1, sc: ["expected"] }] },
    { assumptions: { worst: { posGrowth: 1e9 } } },
  ];
  for (const body of bad) assert.equal((await call("/api/businesses/B001/state", { method: "PUT", cookie: c, body })).status, 400, JSON.stringify(body));
});

test("mutating requests must be JSON", async () => {
  const c = await login("U01");
  const res = await fetch(base + "/api/businesses/B001/state", { method: "PUT", headers: { Cookie: c, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(res.status, 415);
});

test("only the owner can read the audit log", async () => {
  assert.equal((await call("/api/businesses/B001/audit", { cookie: await login("U01") })).status, 200);
  assert.equal((await call("/api/businesses/B001/audit", { cookie: await login("U02") })).status, 403);
});

test("static files can't escape the public folders", async () => {
  for (const p of ["/engine/../../data/sme_sample_dataset/bank_statement.csv", "/..%2f..%2fdata/sme_sample_dataset/bank_statement.csv", "/engine/%2e%2e/%2e%2e/package.json"]) {
    const res = await fetch(base + p);
    const text = await res.text();
    assert.ok(!text.includes("running_balance") && !text.includes('"scripts"'), p);
  }
  assert.equal((await fetch(base + "/engine/index.js")).status, 200);
});

test("security headers are set", async () => {
  const res = await fetch(base + "/");
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("session cookies are HttpOnly and SameSite=Strict", async () => {
  const res = await call("/api/login", { method: "POST", body: { userId: "U01", passcode: "pass-1234" } });
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
});

test("sign-in attempts are rate limited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fintellect-rl-"));
  const s2 = createServer(createApp({ repo: getRepo(), secret: "test-secret-0123456789", varDir: dir, demoPasscode: "pass-1234", loginLimitPerMinute: 3 }));
  await new Promise((r) => s2.listen(0, r));
  const url = `http://127.0.0.1:${s2.address().port}/api/login`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "U01", passcode: "wrong" }) })).status);
  s2.close(); rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});
