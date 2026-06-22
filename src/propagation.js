const FREQ_MHZ = 915;
export const SENSITIVITY_DBM = -130;
export const GOOD_THRESHOLD_DBM = -110;

export function fspl(distKm) {
  if (distKm < 0.001) return 0;
  return 20 * Math.log10(distKm) + 20 * Math.log10(FREQ_MHZ) + 32.44;
}

export function antennaElevCorrDb(gainDbi, elevAngleRad) {
  if (gainDbi <= 0) return 0;
  const n = Math.round(gainDbi / 3);
  const cosTheta = Math.abs(Math.cos(elevAngleRad));
  if (cosTheta < 1e-10) return -60;
  return n * 20 * Math.log10(cosTheta);
}

export function classifySignal(pRxDbm) {
  if (pRxDbm > GOOD_THRESHOLD_DBM) return 'good';
  if (pRxDbm > SENSITIVITY_DBM) return 'marginal';
  return 'blocked';
}

export function receivedPowerDbm({ eirpDbm, distKm, gainDbi, elevAngleRad }) {
  return eirpDbm - fspl(distKm) + antennaElevCorrDb(gainDbi, elevAngleRad);
}
