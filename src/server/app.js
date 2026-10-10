// HTTP API and static file server. No framework; node:http only.
//
// Every /api/businesses/:id/* route resolves the signed-in user first, then checks that
// :id is the user's own business. Unknown and other-tenant IDs get the same 403, so the API
// never confirms that another business exists. Denied attempts are written to the audit log.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { buildDataset } from "../data/build-dataset.js";
import { computeHistory, forecast, fcSummary, forecastWeekly, applyTransactions, modelDefaults } from "../engine/index.js";
import { SESSION_COOKIE, signSession, verifySession, parseCookies, sessionCookie, can, safeEqual, RateLimiter, ROLE_CAPS } from "./auth.js";
import { StateStore, AuditLog, validateState, ValidationError } from "./state.js";
import { ask, cleanHistory, createClient } from "./assistant.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const STATIC = [
  { prefix: "/engine/", dir: join(ROOT, "src/engine") },
  { prefix: "/", dir: join(ROOT, "public") },
];
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
const MAX_BODY = 2 * 1024 * 1024;

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createApp(opts) {
  const { repo, secret, varDir = join(ROOT, "var"), demoPasscode = "demo1234", secureCookies = false, loginLimitPerMinute = 10, assistantPerHour = 30 } = opts;
  // The AI assistant is on when an Anthropic client is available (ANTHROPIC_API_KEY, or one passed in by tests).
  const assistant = opts.assistantClient !== undefined ? opts.assistantClient : createClient();
  if (!secret || secret.length < 16) throw new Error("A session secret of at least 16 characters is required");
  const store = new StateStore(join(varDir, "state"));
  const audit = new AuditLog(join(varDir, "audit.jsonl"));
  const limiter = new RateLimiter(loginLimitPerMinute, 60_000);
  const askLimiter = new RateLimiter(assistantPerHour, 60 * 60_000);
  const users = repo.users();
  const userById = new Map(users.map((u) => [u.id, u]));
  const datasets = new Map(); // built lazily, once per business
  const datasetFor = (id) => { if (!datasets.has(id)) datasets.set(id, buildDataset(repo.tenant(id))); return datasets.get(id); };

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = verifySession(token, secret);
    return s ? userById.get(s.uid) || null : null;
  }

  function requireTenant(req, user, businessId) {
    if (!user) throw new HttpError(401, "Sign in to continue");
    if (user.businessId !== businessId || !repo.hasBusiness(businessId)) {
      audit.write({ type: "access_denied", businessId: user.businessId, userId: user.id, target: String(businessId).slice(0, 40), path: req.url.slice(0, 200) });
      throw new HttpError(403, "You don't have access to that business");
    }
  }

  function mergedState(businessId) {
    const DS = datasetFor(businessId), saved = store.get(businessId) || {};
    return {
      DS,
      S: {
        open: saved.open || DS.open, cats: saved.cats || DS.cats, data: saved.data || DS.data,
        assumptions: saved.assumptions || DS.assumptions, events: saved.events || DS.events, global: saved.global || DS.global,
        business: { ...DS.business, ...(saved.business || {}) },
        txns: saved.txns || [], model: saved.model || modelDefaults(DS.global.drawings),
      },
      saved,
    };
  }
  // Statements built from the saved figures plus the transactions users recorded.
  const historyOf = (DS, S) => computeHistory(applyTransactions(S, DS.months), DS.months);

  const routes = [
    ["GET", /^\/api\/health$/, () => ({ ok: true })],
    ["GET", /^\/api\/users$/, () => ({
      // Demo sign-in list. Shows names and roles only; no business data.
      users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, business: repo.tenant(u.businessId).tables.business_profile[0]?.legal_name })),
    })],
    ["POST", /^\/api\/login$/, async (req, res) => {
      const ip = req.socket.remoteAddress || "unknown";
      if (!limiter.allow(ip)) throw new HttpError(429, "Too many sign-in attempts. Wait a minute and try again.");
      const body = await readJson(req);
      const user = userById.get(String(body.userId || ""));
      if (!user || !safeEqual(body.passcode || "", demoPasscode)) {
        audit.write({ type: "login_failed", businessId: user?.businessId || null, userId: String(body.userId || "").slice(0, 40) });
        throw new HttpError(401, "That user and passcode don't match");
      }
      res.setHeader("Set-Cookie", sessionCookie(signSession(user.id, secret), { secure: secureCookies }));
      audit.write({ type: "login", businessId: user.businessId, userId: user.id });
      return { user: publicUser(user) };
    }],
    ["POST", /^\/api\/logout$/, (req, res) => {
      res.setHeader("Set-Cookie", sessionCookie("", { clear: true, secure: secureCookies }));
      return { ok: true };
    }],
    ["GET", /^\/api\/me$/, (req) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, "Sign in to continue");
      return { user: publicUser(user) };
    }],
    ["GET", /^\/api\/businesses\/([^/]+)\/bootstrap$/, (req, res, [id]) => {
      const user = currentUser(req); requireTenant(req, user, id);
      const DS = datasetFor(id);
      return { dataset: DS, saved: store.get(id), user: publicUser(user), assistant: !!assistant };
    }],
    ["PUT", /^\/api\/businesses\/([^/]+)\/state$/, async (req, res, [id]) => {
      const user = currentUser(req); requireTenant(req, user, id);
      if (!can(user, "write")) {
        audit.write({ type: "write_denied", businessId: id, userId: user.id, role: user.role });
        throw new HttpError(403, "Your role can view these figures but not change them");
      }
      const body = await readJson(req);
      const clean = validateState(body, datasetFor(id));
      const before = store.get(id) || {};
      store.put(id, clean);
      audit.write({ type: "state_saved", businessId: id, userId: user.id, changed: changedSections(before, clean) });
      return { ok: true };
    }],
    ["DELETE", /^\/api\/businesses\/([^/]+)\/state$/, (req, res, [id]) => {
      const user = currentUser(req); requireTenant(req, user, id);
      if (!can(user, "write")) throw new HttpError(403, "Your role can view these figures but not change them");
      store.clear(id);
      audit.write({ type: "state_reset", businessId: id, userId: user.id });
      return { ok: true };
    }],
    ["GET", /^\/api\/businesses\/([^/]+)\/forecast\/weekly$/, (req, res, [id], url) => {
      const user = currentUser(req); requireTenant(req, user, id);
      const sc = scenarioParam(url);
      const { DS, S } = mergedState(id);
      const r = forecastWeekly(DS.weekly, S.assumptions[sc], { events: S.events, scenario: sc, drawings: S.global.drawings, baseCogsPct: DS.assumptions.expected.cogsPct, seasonality: S.global.seasonality });
      return { scenario: sc, minBuffer: S.global.minBuffer, ...r };
    }],
    ["GET", /^\/api\/businesses\/([^/]+)\/forecast\/monthly$/, (req, res, [id], url) => {
      const user = currentUser(req); requireTenant(req, user, id);
      const sc = scenarioParam(url);
      const horizon = Number(url.searchParams.get("horizon") || 12);
      if (![12, 24, 36].includes(horizon)) throw new HttpError(400, "horizon must be 12, 24 or 36");
      const { DS, S } = mergedState(id);
      const H = historyOf(DS, S);
      const F = forecast(DS, S, H, sc, horizon);
      const s = fcSummary(F, S.global.minBuffer);
      return { scenario: sc, horizon, months: F.map(({ events, ...f }) => ({ ...f, events: events.map((e) => e.name) })), summary: { rev: s.rev, np: s.np, endCash: s.end.cash, minCash: s.min.cash, minMonth: s.min.k, firstNegative: s.neg?.k || null, firstBelowBuffer: s.below?.k || null } };
    }],
    ["POST", /^\/api\/businesses\/([^/]+)\/assistant$/, async (req, res, [id]) => {
      const user = currentUser(req); requireTenant(req, user, id);
      if (!assistant) throw new HttpError(503, "The AI assistant isn't set up. Add ANTHROPIC_API_KEY to the server's environment.");
      if (!askLimiter.allow(user.id)) throw new HttpError(429, "You've asked a lot of questions this hour. Try again later.");
      const history = cleanHistory((await readJson(req)).messages);
      if (!history) throw new HttpError(400, "Send messages ending with a question");
      const { DS, S } = mergedState(id);
      if (DS.limited) throw new HttpError(400, "The assistant needs sales, bills and payroll records, which this business doesn't have yet");
      let out;
      try { out = await ask(assistant, { DS, S, H: historyOf(DS, S) }, history); }
      catch (e) {
        console.error("assistant:", e.status || "", e.message);
        throw new HttpError(502, e.status === 429 ? "The AI service is busy. Try again in a minute." : "The AI assistant couldn't answer right now. Try again.");
      }
      // Logged without the question text: the log records that the assistant was used, not what was asked.
      audit.write({ type: "assistant_question", businessId: id, userId: user.id, tools: out.tools.slice(0, 20) });
      return out;
    }],
    ["GET", /^\/api\/businesses\/([^/]+)\/audit$/, (req, res, [id]) => {
      const user = currentUser(req); requireTenant(req, user, id);
      if (!can(user, "audit")) throw new HttpError(403, "Only the owner can view the audit log");
      return { entries: audit.read(id) };
    }],
  ];

  return async function handler(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        if ((req.method === "POST" || req.method === "PUT") && !String(req.headers["content-type"] || "").startsWith("application/json")) {
          throw new HttpError(415, "Send JSON");
        }
        for (const [method, re, fn] of routes) {
          const m = url.pathname.match(re);
          if (m && method === req.method) {
            const out = await fn(req, res, m.slice(1).map(decodeURIComponent), url);
            return sendJson(res, 200, out);
          }
        }
        throw new HttpError(404, "Not found");
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
      return serveStatic(url.pathname, res);
    } catch (e) {
      if (e instanceof ValidationError) return sendJson(res, 400, { error: e.message });
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error(e);
      return sendJson(res, 500, { error: "Something went wrong on the server" });
    }
  };
}

function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, businessId: u.businessId, capabilities: ROLE_CAPS[u.role] || [] };
}

function scenarioParam(url) {
  const sc = url.searchParams.get("scenario") || "expected";
  if (!["worst", "expected", "best"].includes(sc)) throw new HttpError(400, "scenario must be worst, expected or best");
  return sc;
}

function changedSections(a, b) {
  return ["data", "cats", "open", "assumptions", "events", "global", "business", "txns", "model"].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, "Request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "Body isn't valid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function serveStatic(pathname, res) {
  for (const { prefix, dir } of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length) || "index.html";
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir + sep) && file !== dir) break;
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      return res.end(readFileSync(file));
    }
  }
  // single-page app fallback for unknown non-asset paths
  if (!extname(pathname)) {
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
    return res.end(readFileSync(join(ROOT, "public/index.html")));
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

export const randomSecret = () => randomBytes(32).toString("hex");
