export const EIRP_LIMIT_DBM = 30;
export const TX_POWER_MIN_DBM = 22;
export const TX_POWER_MAX_DBM = 30;

export function calcEirp(txPowerDbm, gainDbi) {
  return txPowerDbm + gainDbi;
}

export function eirpStatus(txPowerDbm, gainDbi) {
  const eirpDbm = calcEirp(txPowerDbm, gainDbi);
  const excess = eirpDbm - EIRP_LIMIT_DBM;
  return {
    eirpDbm,
    effectiveEirpDbm: Math.min(eirpDbm, EIRP_LIMIT_DBM),
    compliant: excess <= 0,
    requiredReductionDb: Math.max(0, excess),
  };
}
