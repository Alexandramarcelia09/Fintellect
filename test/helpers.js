import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository } from "../src/data/repository.js";
import { buildDataset } from "../src/data/build-dataset.js";
import { parseCsv } from "../src/lib/csv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let repo, ds;
export const getRepo = () => (repo ||= new Repository());
export const getDataset = () => (ds ||= buildDataset(getRepo().tenant("B001")));
export const stateFrom = (DS) => ({ open: DS.open, cats: DS.cats, data: DS.data, assumptions: DS.assumptions, events: DS.events, global: DS.global });
/** Answer key from the dataset authors. Used by tests only; the app never loads it. */
export const referenceForecast = () => parseCsv(readFileSync(join(HERE, "fixtures/reference_13_week_forecast.csv"), "utf8"));
