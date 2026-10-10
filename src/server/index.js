import { createServer } from "node:http";
import { Repository } from "../data/repository.js";
import { createApp, randomSecret } from "./app.js";

const port = Number(process.env.PORT || 3000);
let secret = process.env.NERACA_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === "production") {
    console.error("NERACA_SECRET must be set in production.");
    process.exit(1);
  }
  secret = randomSecret();
  console.warn("NERACA_SECRET not set: using a random secret, so sessions reset on restart.");
}

const repo = new Repository(process.env.NERACA_DATA_DIR || undefined);
const handler = createApp({
  repo,
  secret,
  varDir: process.env.NERACA_VAR_DIR || undefined,
  demoPasscode: process.env.NERACA_DEMO_PASSCODE || "demo1234",
  secureCookies: process.env.NERACA_SECURE_COOKIES === "1",
});

createServer(handler).listen(port, () => {
  console.log(`Neraca running on http://localhost:${port}  (businesses: ${repo.businessIds.join(", ")})`);
});
