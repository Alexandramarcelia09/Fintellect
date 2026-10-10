import { env } from "./env.js";
import { createServer } from "node:http";
import { Repository } from "../data/repository.js";
import { createApp, randomSecret } from "./app.js";

const port = Number(process.env.PORT || 3000);
let secret = env("SECRET");
if (!secret) {
  if (process.env.NODE_ENV === "production") {
    console.error("FINTELLECT_SECRET must be set in production.");
    process.exit(1);
  }
  secret = randomSecret();
  console.warn("FINTELLECT_SECRET not set: using a random secret, so sessions reset on restart.");
}

const repo = new Repository(env("DATA_DIR") || undefined);
const handler = createApp({
  repo,
  secret,
  varDir: env("VAR_DIR") || undefined,
  demoPasscode: env("DEMO_PASSCODE") || "demo1234",
  secureCookies: env("SECURE_COOKIES") === "1",
});

createServer(handler).listen(port, () => {
  console.log(`Fintellect running on http://localhost:${port}  (businesses: ${repo.businessIds.join(", ")})`);
});
