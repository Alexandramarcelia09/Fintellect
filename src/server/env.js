// Settings are read from FINTELLECT_* environment variables. The app used to be called Neraca,
// so the old NERACA_* names are still accepted for existing deployments.
export const env = (name) => process.env[`FINTELLECT_${name}`] ?? process.env[`NERACA_${name}`];
