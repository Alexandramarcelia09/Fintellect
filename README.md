# Neraca

A finance copilot for small businesses. It turns a business's own records (POS sales, invoices, supplier bills, payroll, loan schedule and bank statement) into:

- monthly financial statements that reconcile to the bank to the cent
- a financial health dashboard with receivables tracking and bookkeeping checks
- a 13-week cash forecast and a 12–36 month forecast, each with Worst, Expected and Best scenarios

It runs on the SME Finance Copilot sample dataset for **Crumb & Copper Bakehouse** (business `B001`), a fictional Singapore café and catering bakery. As of 30 Sep 2026 the Expected case drops below the S$30,000 cash buffer in the week of 26 November. Harbourview, the largest customer, now pays about 40 days late; if it paid on time there would be no breach.

## Quick start

Requires Node.js 20 or later. There are no npm dependencies.

```bash
npm start              # http://localhost:3000
npm test               # 50 tests
npm run build:data     # optional: writes var/bootstrap-<id>.json for inspection
```

Sign in with any demo account. The demo passcode is `demo1234` (set `NERACA_DEMO_PASSCODE` to change it).

| Account | Role | Can do |
|---|---|---|
| Rachel Tan (`U01`) | Owner, B001 | Read, change figures, view the activity log |
| Marcus Lee (`U02`) | Finance admin, B001 | Read, change figures |
| External accountant (`U03`) | Accountant, B001 | Read only |
| Finance copilot (`AGENT`) | AI agent, B001 | Read only (drafting is reserved for the agent layer) |
| Kelvin Ang (`U90`) | Owner, B002 | Only Petal & Stem Florist's own data |

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NERACA_SECRET` | random per start | Signs session cookies. **Required** when `NODE_ENV=production`. Use 32+ random characters. |
| `NERACA_DEMO_PASSCODE` | `demo1234` | Shared demo passcode |
| `NERACA_SECURE_COOKIES` | off | Set to `1` behind HTTPS so cookies get the `Secure` flag |
| `NERACA_DATA_DIR` | `data/sme_sample_dataset` | Folder of CSV tables |
| `NERACA_VAR_DIR` | `var/` | Saved edits (`var/state/<business>.json`) and the audit log (`var/audit.jsonl`) |

## Deployment

**Docker**

```bash
docker build -t neraca .
docker run -p 3000:3000 -e NERACA_SECRET="$(openssl rand -hex 32)" -e NERACA_SECURE_COOKIES=1 -v neraca-var:/app/var neraca
```

**Any Node host** (Render, Railway, Fly.io, a VM): run `npm start` with `NODE_ENV=production` and `NERACA_SECRET` set, behind HTTPS, with `var/` on a persistent disk. The server is a single process with no database.

## Architecture

```
data/sme_sample_dataset/*.csv
        │
        ▼
src/data/repository.js     Loads an allow-list of tables, drops untrusted free-text columns,
        │                  and hands out read-only per-business views (TenantView).
        ▼
src/data/build-dataset.js  One business's tables → monthly model: P&L lines, balances,
src/data/build-weekly.js   receivables analytics, bookkeeping checks, forecast inputs,
        │                  13-week cash timing facts.
        ▼
src/server/app.js          node:http API. Session → user → business check on every route.
        │                  Saves edits (validated) and writes an audit trail.
        ▼
public/app.js  ──imports──▶ src/engine/*.js   The same engine runs in the browser, the server
public/index.html                              and the tests: statements, monthly forecast,
                                               13-week forecast. Pure, deterministic, no Node APIs.
```

| Path | What it does |
|---|---|
| `src/engine/history.js` | P&L, indirect cash flow and balance sheet per month; runway |
| `src/engine/forecast.js` | Monthly forecast, 12–36 months |
| `src/engine/weekly.js` | 13-week direct cash forecast, item by item |
| `src/engine/dates.js` | UTC date helpers on ISO strings |
| `src/data/*` | Loading, tenant isolation, building the model from raw records |
| `src/server/*` | API, sessions, permissions, state validation, audit log |
| `public/*` | Single-page app (dashboard, statements, input, assumptions, forecast, reports) |
| `test/*` | `node:test` suites |

### API

All business routes need a session cookie and only work for the signed-in user's own business.

| Method & path | Who | Returns |
|---|---|---|
| `POST /api/login` `{userId, passcode}` | anyone | Sets the session cookie |
| `POST /api/logout` | anyone | Clears it |
| `GET /api/me` | signed in | Current user and capabilities |
| `GET /api/businesses/:id/bootstrap` | read | Monthly model, forecast inputs, saved edits |
| `GET /api/businesses/:id/forecast/weekly?scenario=` | read | 13 weeks with every dated item |
| `GET /api/businesses/:id/forecast/monthly?scenario=&horizon=12\|24\|36` | read | Monthly forecast and summary |
| `PUT /api/businesses/:id/state` | write | Saves edits after validation |
| `DELETE /api/businesses/:id/state` | write | Resets to the dataset |
| `GET /api/businesses/:id/audit` | owner | Activity log |

## How the numbers are built

**Accrual figures from source documents, not the cash book.**
- **Revenue:** POS net sales by category, plus invoice net amounts by issue date. Both exclude GST.
- **Cost of goods sold:** supplier bills by account, plus direct card purchases, adjusted for the change in month-end stock.
- **Staff costs:** payroll gross pay and employer CPF.
- **Rent:** from the lease in `recurring_obligations`.
- **Insurance:** each premium is spread over 12 months.
- **Card fees:** 1.6% of card takings.
- **Depreciation:** straight-line per asset.
- **Interest and principal:** from the loan schedule.
- **Corporate tax:** accrued monthly from the latest assessment.

**Balances at each month end.**
- **Receivables and payables:** invoices and bills less the payments made against them.
- **Stock:** taken from the month-end snapshots.
- **Settlements in transit:** card takings settle 2 business days later and cash is banked on Mondays.
- **Rental deposit and prepaid insurance:** carried as assets.
- **Balancing line:** "GST, CPF & tax payable" closes the balance sheet, so closing cash always equals the bank statement. A test checks it stays within S$500 of an independent GST + CPF + tax estimate; the gap is about S$390.

**Bookkeeping checks** found while building the model:
- duplicate bill `BILL-00272`, which is excluded from expenses and payables
- bill `BILL-00246` paid twice; the extra payment is carried as owed back by the supplier
- QuickFix Kitchen Supplies, a payee that isn't on the approved list
- ProBake Equipment, whose bank details haven't been verified

### 13-week forecast

Each inflow and outflow is placed on the day the bank would see it:

- **Café takings:** the average for each weekday over the last 8 weeks, adjusted by last year's month pattern and scenario growth. Card takings settle 2 business days later, net of the fee. PayNow arrives the same day. Cash is banked on Mondays.
- **Customer invoices:** open invoices are collected at their due date plus each customer's recent average lateness. Harbourview follows the scenario (60 / 40 / 5 days late). Next quarter's invoices follow the last 3 months' pattern.
- **Supplier bills:** open bills are paid on their due dates. Bills from unverified payees are held. New ingredient orders follow each supplier's 8-week average and are paid on that supplier's terms.
- **Fixed payments:**
  - payroll on the 28th and CPF on the 14th
  - rent, drawings, utilities, software and marketing from the recurring obligations
  - loan instalments from the schedule
  - small card purchases at month end
- **Planned events:** the oven deposit and balance, Q3 GST, corporate tax and the December bonus. The bonus is split into net pay on the 28th and CPF the following month.

**Compared with the dataset's reference forecast** (`test/fixtures/reference_13_week_forecast.csv`, used only by tests):

| Check | Result |
|---|---|
| Low-point week, all three scenarios | Same: week of 26 Nov |
| Direction of each week's net flow | Same in at least 11 of 13 weeks |
| First two weeks | Within S$3,000 |
| Expected case | Breaches the S$30K buffer; on-time Harbourview removes the breach |

Our balances run higher than the reference, and the low point is S$9.7K rather than −S$3.2K, for three reasons:

1. **Supplier timing.** The reference pays new orders to 30-day suppliers from week 3. That pays about two weeks of flour, coffee and packaging twice, because those weeks are already covered by open September bills.
2. **Other customers' invoices.** We project new invoices from every customer, including the Bean There and Northpoint invoices paid inside the 13 weeks. The reference only projects two customers.
3. **Best case.** Harbourview's October invoice is collected in December, and the reference leaves it out.

### Monthly forecast

- **Revenue:** café and B2B streams each start from the last 3 months, deseasonalised. They then grow monthly with last-12-month seasonality.
- **Costs:** fixed costs rise each January by the scenario rate. Rent follows the signed lease event. Card fees follow café sales.
- **GST and tax:** GST collected is paid the month after each quarter, and corporate tax each November. A planned GST or tax event in the same month replaces the automatic payment.
- **Events:** equipment is depreciated over 5 years. New loans are repaid over 36 months.

## Security design

| Area | What's in place |
|---|---|
| Tenant isolation | Data is read only through a frozen per-business `TenantView`. Every business route checks the session user's business. An unknown business and someone else's business get the same 403, and the attempt is logged. Tests confirm that B002 never sees B001 data and the reverse. |
| Authentication | HMAC-SHA256 signed session cookie (`HttpOnly`, `SameSite=Strict`, optional `Secure`, 8-hour expiry), compared in constant time. Login is rate limited per IP. |
| Authorisation | Capabilities by role: owner (read, write, audit), finance admin (read, write), accountant (read), AI agent (read, draft). Writes from read-only roles are refused and logged. |
| Input validation | Saved edits must match a strict schema: known months, finite numbers within limits, allowed event kinds and scenarios, length limits. The request body limit is 2 MB. Mutating requests must be JSON, which blocks simple cross-site form posts. |
| Untrusted content | Bank memos, bill notes, invoice notes and OCR notes are dropped when the data is loaded, so instructions hidden in them can't reach the app or a future agent. Answer-key files are never loaded. |
| Audit trail | Append-only JSONL: sign-ins, failed sign-ins, saved changes (which sections changed), resets, refused cross-business requests and refused writes. |
| Browser hardening | CSP with `script-src 'self'` (no inline scripts), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. Static file serving can't leave `public/` or `src/engine/`. |

### Known risks and limits

- **Demo login.** All accounts share one passcode, and `/api/users` lists the demo accounts. Replace both with a real identity provider and MFA before using real data.
- **No multi-factor step yet.** The dataset's payment policy rules call for owner approval with MFA on high-risk payments; that belongs with the payment approval flow, which isn't built yet.
- **File storage.** Saved edits and the audit log are plain files on one server, with no encryption at rest or log rotation. Use a database with encryption and backups in production.
- **Forecast granularity.** The monthly forecast shows month-end balances only. The 13-week view is the one to use for timing decisions.
- **Not financial advice.** Alerts and options are informational.

## Data notes

- Business `B002` (Petal & Stem Florist) has only bank lines and a few invoices. It loads as a limited view and exists to test isolation.
- The payment request queue, receipts, purchase orders and reconciliation tables are loaded but not yet used by the app. They are the inputs for the agent's payment-policy and reconciliation work.
