// Saved edits per business (monthly figures, categories, assumptions, events, profile).
// Stored as one JSON file per business under var/state. The file name comes from a business ID
// that has already been checked against the repository, never from raw request input.
//
// Every write is validated against a strict shape, so a client can't store arbitrary data,
// huge payloads or values that would break the engine (NaN, Infinity, unknown months).

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { TXN_KINDS, categorySection, txnNeedsCategory, txnIsIncome, txnHasDue, isIsoDate } from "../engine/transactions.js";

const KINDS = new Set(["capex", "payment", "cost", "monthly", "revenue", "in", "equity", "note"]);
const SCENARIOS = new Set(["worst", "expected", "best"]);
const ASSUMPTION_KEYS = ["posGrowth", "b2bGrowth", "cogsPct", "opexGrowth", "hvDelay"];
const OTHER_KEYS = ["interest", "tax", "capex", "assetSale", "loanIn", "loanRepay", "ownerIn", "drawings", "ar", "inv", "oca", "deposit", "ap", "ocl"];
const OPEN_KEYS = ["cash", "ar", "inv", "oca", "deposit", "equip", "ap", "ocl", "loan", "capital", "re"];
const PROFILE_KEYS = ["name", "legal", "uen", "type", "industry", "country", "gst", "started", "owner", "address", "contact", "fyStart"];
const TXN_KIND_IDS = new Set(TXN_KINDS.map(([id]) => id));
const MAX_TXNS = 5000;
const MAX_ABS = 1e12;

export class ValidationError extends Error {}

const fail = (m) => { throw new ValidationError(m); };
const isNum = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < MAX_ABS;
const str = (v, max = 200) => typeof v === "string" && v.length <= max;
const idOk = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);

/** Validate a client-submitted state against the business's dataset. Returns a clean copy. */
export function validateState(input, DS) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("State must be an object");
  const out = {};
  const months = new Set(DS.months);

  if (input.cats !== undefined) {
    const c = input.cats;
    for (const sec of ["rev", "cogs", "opex"]) {
      if (!Array.isArray(c?.[sec]) || c[sec].length > 60) fail(`cats.${sec} must be a list of up to 60 categories`);
      for (const x of c[sec]) {
        if (!idOk(x.id) || !str(x.name, 80)) fail(`Invalid category in ${sec}`);
        if (sec === "opex" && !["FIXED", "VARIABLE", "NONCASH"].includes(x.type)) fail(`Invalid cost type for ${x.id}`);
      }
    }
    out.cats = { rev: c.rev.map(pick(["id", "name", "group", "custom"])), cogs: c.cogs.map(pick(["id", "name", "custom"])), opex: c.opex.map(pick(["id", "name", "type", "custom"])) };
  }
  if (input.data !== undefined) {
    if (typeof input.data !== "object") fail("data must be an object keyed by month");
    out.data = {};
    for (const [k, d] of Object.entries(input.data)) {
      if (!months.has(k)) fail(`Unknown month ${k}`);
      const m = { rev: {}, cogs: {}, opex: {}, other: {} };
      for (const sec of ["rev", "cogs", "opex"]) {
        for (const [id, v] of Object.entries(d?.[sec] || {})) { if (!idOk(id) || !isNum(v)) fail(`Invalid value ${k}.${sec}.${id}`); m[sec][id] = v; }
      }
      for (const key of OTHER_KEYS) { const v = d?.other?.[key]; if (!isNum(v)) fail(`Invalid value ${k}.other.${key}`); m.other[key] = v; }
      out.data[k] = m;
    }
  }
  if (input.open !== undefined) {
    out.open = {};
    for (const key of OPEN_KEYS) { if (!isNum(input.open[key])) fail(`Invalid opening balance ${key}`); out.open[key] = input.open[key]; }
  }
  if (input.assumptions !== undefined) {
    out.assumptions = {};
    for (const sc of SCENARIOS) {
      out.assumptions[sc] = {};
      for (const key of ASSUMPTION_KEYS) {
        const v = input.assumptions?.[sc]?.[key];
        if (!isNum(v) || Math.abs(v) > 1000) fail(`Invalid assumption ${sc}.${key}`);
        out.assumptions[sc][key] = v;
      }
    }
  }
  if (input.global !== undefined) {
    const g = input.global;
    if (!isNum(g.drawings) || !isNum(g.minBuffer) || typeof g.seasonality !== "boolean") fail("Invalid global settings");
    out.global = { drawings: g.drawings, minBuffer: g.minBuffer, seasonality: g.seasonality };
  }
  if (input.events !== undefined) {
    if (!Array.isArray(input.events) || input.events.length > 200) fail("events must be a list of up to 200");
    out.events = input.events.map((e) => {
      if (!idOk(e.id) || !str(e.name, 120) || !/^\d{4}-\d{2}$/.test(e.month) || !KINDS.has(e.kind) || !isNum(e.amount) || e.amount < 0) fail(`Invalid event ${e?.id}`);
      if (e.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) fail(`Invalid event date ${e.id}`);
      if (!Array.isArray(e.sc) || e.sc.some((s) => !SCENARIOS.has(s))) fail(`Invalid scenarios for ${e.id}`);
      return { id: e.id, name: e.name, month: e.month, date: e.date, kind: e.kind, amount: e.amount, sc: [...new Set(e.sc)], certainty: str(e.certainty, 20) ? e.certainty : undefined, payroll: e.payroll === true || undefined };
    });
  }
  if (input.txns !== undefined) {
    if (!Array.isArray(input.txns) || input.txns.length > MAX_TXNS) fail(`txns must be a list of up to ${MAX_TXNS}`);
    const cats = out.cats || DS.cats, ids = new Set();
    out.txns = input.txns.map((t) => {
      const bad = (why) => fail(`Invalid transaction ${String(t?.id).slice(0, 40)}: ${why}`);
      if (!t || !idOk(t.id) || ids.has(t.id)) bad("id");
      ids.add(t.id);
      if (!TXN_KIND_IDS.has(t.kind)) bad("type");
      if (!isIsoDate(t.date) || !months.has(t.date.slice(0, 7))) bad("date must fall within the months in the books");
      if (!isNum(t.amount) || t.amount <= 0) bad("amount must be positive");
      if (t.description !== undefined && !str(t.description, 120)) bad("description is too long");
      const row = { id: t.id, date: t.date, kind: t.kind, amount: t.amount, description: t.description || undefined };
      if (txnNeedsCategory(t.kind)) {
        const sec = idOk(t.category) && categorySection(cats, t.category);
        if (!sec || (sec === "rev") !== txnIsIncome(t.kind)) bad("category");
        row.category = t.category;
      }
      if (t.paidOn !== undefined && t.paidOn !== null) {
        if (!txnHasDue(t.kind) || !isIsoDate(t.paidOn) || t.paidOn < t.date) bad("paid date");
        row.paidOn = t.paidOn;
      }
      return row;
    });
  }
  if (input.model !== undefined) {
    const m = input.model, inRange = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;
    if (!m || !inRange(m.discount, 0, 100) || !inRange(m.growth, -20, 20) || !inRange(m.multiple, 0, 50) || !inRange(m.ownerPay, 0, 1e7)) fail("Invalid valuation settings");
    if (m.growth >= m.discount) fail("Long-term growth must be below the discount rate");
    out.model = { discount: m.discount, growth: m.growth, multiple: m.multiple, ownerPay: m.ownerPay };
  }
  if (input.business !== undefined) {
    out.business = {};
    for (const key of PROFILE_KEYS) {
      const v = input.business[key];
      if (v === undefined) continue;
      if (key === "fyStart") { if (!Number.isInteger(v) || v < 1 || v > 12) fail("fyStart must be 1–12"); }
      else if (!str(v, 200)) fail(`Invalid profile field ${key}`);
      out.business[key] = v;
    }
  }
  return out;
}

function pick(keys) {
  return (o) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
}

export class StateStore {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  file(businessId) { return join(this.dir, `${businessId}.json`); }
  get(businessId) {
    const f = this.file(businessId);
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
  }
  put(businessId, state) { writeFileSync(this.file(businessId), JSON.stringify(state)); }
  clear(businessId) { rmSync(this.file(businessId), { force: true }); }
}

/** Append-only audit trail, one JSON object per line. */
export class AuditLog {
  constructor(file) { this.file = file; mkdirSync(join(file, ".."), { recursive: true }); }
  write(entry) { appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); }
  read(businessId, limit = 200) {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.businessId === businessId).slice(-limit).reverse();
  }
}
