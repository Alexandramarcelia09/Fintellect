// Vercel entry point. Vercel runs the app as a serverless function instead of a long-running
// server, so the app is built once per instance and reused across requests.
//
// Differences from src/server/index.js:
// - A missing FINTELLECT_SECRET returns a clear 500 instead of exiting the process.
// - Saved edits and the audit log go to /tmp, the only writable folder on Vercel. They are
//   per instance and are lost when the instance is recycled; use a database for real data.

import { env } from "../src/server/env.js";
import { Repository } from "../src/data/repository.js";
import { createApp } from "../src/server/app.js";

let handler;

export default function fintellect(req, res) {
  if (!handler) {
    const secret = env("SECRET");
    if (!secret || secret.length < 16) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("FINTELLECT_SECRET is not set. Add it (32+ random characters) in the Vercel project's Environment Variables, then redeploy.");
    }
    handler = createApp({
      repo: new Repository(env("DATA_DIR") || undefined),
      secret,
      varDir: env("VAR_DIR") || "/tmp/fintellect",
      demoPasscode: env("DEMO_PASSCODE") || "demo1234",
      secureCookies: env("SECURE_COOKIES") !== "0",
    });
  }
  return handler(req, res);
}
