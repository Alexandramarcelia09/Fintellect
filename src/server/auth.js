// Sessions and permissions.
//
// Sessions are stateless signed cookies: base64url(JSON {uid, exp}) + "." + HMAC-SHA256.
// Login is a demo passcode shared by all seeded users; replace with a real identity provider
// before handling real data. Roles map to a small set of capabilities checked on every route.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "fintellect_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const ROLE_CAPS = {
  owner: ["read", "write", "audit"],
  finance_admin: ["read", "write"],
  accountant: ["read"],
  agent: ["read", "draft"],
};

const b64 = (buf) => Buffer.from(buf).toString("base64url");

export function signSession(uid, secret, now = Date.now()) {
  const payload = b64(JSON.stringify({ uid, exp: now + SESSION_TTL_MS }));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.uid || typeof data.exp !== "number" || data.exp < now) return null;
    return data;
  } catch { return null; }
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure = false, clear = false } = {}) {
  const attrs = [`${SESSION_COOKIE}=${clear ? "" : token}`, "Path=/", "HttpOnly", "SameSite=Strict", clear ? "Max-Age=0" : `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export const can = (user, cap) => !!user && (ROLE_CAPS[user.role] || []).includes(cap);

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Very small fixed-window rate limiter for login attempts. */
export class RateLimiter {
  constructor(limit = 10, windowMs = 60_000) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || now - h.start > this.windowMs) { this.hits.set(key, { start: now, n: 1 }); return true; }
    h.n++;
    return h.n <= this.limit;
  }
}
