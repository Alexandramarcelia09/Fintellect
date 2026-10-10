// Public surface of the calculation engine. Browser-safe: no Node imports anywhere under src/engine.
export * from "./dates.js";
export { POS_GROUP, sumObj, computeHistory, runwayAt } from "./history.js";
export { forecast, fcSummary } from "./forecast.js";
export { forecastWeekly, weeklyByCategory, WEEKS } from "./weekly.js";
export { TXN_KINDS, applyTransactions, categorySection, txnNeedsCategory, txnIsIncome, txnHasDue, isIsoDate, txnTotalsByMonth, parseTxnCsv } from "./transactions.js";
export { threeStatement, annualize, breakEven, breakEvenActual, breakEvenForecast, valuation, modelDefaults } from "./model.js";
