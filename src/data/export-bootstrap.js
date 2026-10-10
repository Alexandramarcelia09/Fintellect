// Writes the bootstrap dataset for each business to var/bootstrap-<id>.json (for inspection or offline demos).
import { env } from "../server/env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository } from "./repository.js";
import { buildDataset } from "./build-dataset.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "../../var");
mkdirSync(out, { recursive: true });
const repo = new Repository(env("DATA_DIR") || undefined);
for (const id of repo.businessIds) {
  const ds = buildDataset(repo.tenant(id));
  writeFileSync(join(out, `bootstrap-${id}.json`), JSON.stringify(ds, null, 1));
  console.log(`var/bootstrap-${id}.json · ${ds.months.length} months`);
}
