const FREQ_MHZ = 915;
export const SENSITIVITY_DBM = -130;
export const GOOD_THRESHOLD_DBM = -110;

export function fspl(distKm) {
  if (distKm < 0.001) return 0;
  // Path loss exponent 3 (vs free-space 2) accounts for terrain diffraction,
  // vegetation, and clutter common in real outdoor LoRa deployments.
  return 30 * Math.log10(distKm) + 20 * Math.log10(FREQ_MHZ) + 32.44;
}

// Compute pattern exponent n from vertical half-power beamwidth (degrees).
// A real 15° omni → n ≈ 40; a 30° omni → n ≈ 10; a dipole (~78°) → n ≈ 1.
// Returns null when not supplied (falls back to gainDbi-derived default).
export function patternNFromBeamwidth(beamwidthDeg) {
  if (!beamwidthDeg || beamwidthDeg <= 0 || beamwidthDeg >= 180) return null;
  const thetaHalf = (beamwidthDeg / 2) * Math.PI / 180;
  return -3 / (20 * Math.log10(Math.cos(thetaHalf)));
}

// patternN: explicit exponent override derived from beamwidth.
// When null, falls back to round(gainDbi/3) — the old approximation.
export function antennaElevCorrDb(gainDbi, elevAngleRad, patternN = null) {
  const n = patternN !== null ? patternN : (gainDbi <= 0 ? 0 : Math.round(gainDbi / 3));
  if (n === 0) return 0;
  const cosTheta = Math.abs(Math.cos(elevAngleRad));
  if (cosTheta < 1e-10) return -200;
  return n * 20 * Math.log10(cosTheta);
}

export function classifySignal(pRxDbm) {
  if (pRxDbm >= GOOD_THRESHOLD_DBM) return 'good';
  if (pRxDbm >= SENSITIVITY_DBM)    return 'marginal';
  return 'blocked';
}

export function receivedPowerDbm({ eirpDbm, distKm, gainDbi, elevAngleRad, rxGainDbi = 0, patternN = null }) {
  return eirpDbm - fspl(distKm) + antennaElevCorrDb(gainDbi, elevAngleRad, patternN) + rxGainDbi;
}
