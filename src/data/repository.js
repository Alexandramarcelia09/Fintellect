// Data access layer. Every read for a business goes through a TenantView that only ever
// contains rows whose business_id matches. There is no API on the view that can reach
// another tenant's rows, so a request for "the other company's cash flow" has nothing to return.
//
// Free-text columns written by third parties (bank memos, supplier bill notes, OCR notes,
// invoice notes) are dropped at load time. They can carry instructions aimed at an AI agent,
// and nothing in the calculations needs them.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../lib/csv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(HERE, "../../data/sme_sample_dataset");

// Only these tables are loaded. Anything else in the folder (answer keys, scripts) is ignored.
export const TENANT_TABLES = [
  "business_profile", "bank_accounts", "bank_statement", "ledger_entries", "chart_of_accounts",
  "pos_daily_sales", "pos_daily_payments", "customers", "invoices_ar", "invoice_payments",
  "suppliers_payees", "purchase_orders", "goods_received", "bills_ap", "supplier_payments",
  "payment_requests", "receipts", "receipt_line_items", "employees", "payroll_runs", "loans",
  "loan_schedule", "recurring_obligations", "tax_obligations", "fixed_assets", "inventory_snapshots",
  "opening_balance_sheet", "forecast_assumptions", "forecast_events", "payment_policy_rules",
  "alert_rules", "users_roles",
];
export const SHARED_TABLES = ["financing_products", "external_indicators_illustrative"];

export const UNTRUSTED_COLUMNS = new Set(["memo", "notes", "ocr_raw_note"]);

function deepFreeze(rows) {
  for (const r of rows) Object.freeze(r);
  return Object.freeze(rows);
}

export class Repository {
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.tables = {};
    for (const name of [...TENANT_TABLES, ...SHARED_TABLES]) {
      const file = join(dataDir, `${name}.csv`);
      if (!existsSync(file)) { this.tables[name] = []; continue; }
      const rows = parseCsv(readFileSync(file, "utf8")).map((r) => {
        for (const c of UNTRUSTED_COLUMNS) if (c in r) delete r[c];
        return r;
      });
      this.tables[name] = rows;
    }
    this.businessIds = [...new Set(this.tables.business_profile.map((r) => r.business_id))];
    this._views = new Map();
  }

  hasBusiness(id) { return this.businessIds.includes(id); }

  /** A read-only view holding only `businessId`'s rows plus shared reference tables. */
  tenant(businessId) {
    if (!this.hasBusiness(businessId)) throw new Error(`Unknown business ${businessId}`);
    if (this._views.has(businessId)) return this._views.get(businessId);
    const t = {};
    for (const name of TENANT_TABLES) {
      t[name] = deepFreeze(this.tables[name].filter((r) => r.business_id === businessId).map((r) => ({ ...r })));
    }
    for (const name of SHARED_TABLES) t[name] = deepFreeze(this.tables[name].map((r) => ({ ...r })));
    const view = Object.freeze({ businessId, tables: Object.freeze(t) });
    this._views.set(businessId, view);
    return view;
  }

  /** Users for login. Returned without any business data. */
  users() {
    return this.tables.users_roles.map((u) => ({
      id: u.user_id, name: u.name, role: u.role, businessId: u.business_id,
      permissions: u.permissions.split(";").map((s) => s.trim()).filter(Boolean),
      mfaEnrolled: u.mfa_enrolled === "True",
    }));
  }
}
