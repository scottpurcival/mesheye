import { receivedPowerDbm, classifySignal, SENSITIVITY_DBM } from './propagation.js';

const R_EFF_M = 8_495_000; // 4/3 × 6 371 000 m — standard atmospheric refraction
const LAMBDA_M = 300 / 915; // 915 MHz wavelength in metres

self.onmessage = ({ data }) => {
  if (data.type === 'compute') {
    const points = computeCoverage(data);
    self.postMessage({ type: 'result', nodeId: data.nodeId, points });
  }
};

// Fresnel-Kirchhoff knife-edge diffraction loss (dB) from dimensionless v parameter.
// v < -0.7 → effectively in the clear (0 dB). v = 0 → 6 dB (grazing). v > 0 → deep shadow.
// Approximation from ITU-R P.526 §4.1.
function knifeEdgeLoss(v) {
  if (v <= -0.7) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

function computeCoverage({ node, samples, rayCount, sampleCount }) {
  const { nodeAbsElev, eirpDbm, gainDbi, rxHeightAgl, rxGainDbi, patternN = null, linkMarginDb = 0 } = node;
  const points = [];

  for (let r = 0; r < rayCount; r++) {
    let maxHorizonAngle = -Infinity;
    // Track which terrain sample set the horizon — needed for diffraction geometry.
    let obsDistM = 0;
    let obsEffH  = 0;

    for (let s = 0; s < sampleCount; s++) {
      const sample = samples[r * sampleCount + s];
      if (!sample || sample.distKm <= 0) continue;

      const { lat, lon, terrainH, distKm } = sample;
      const distM = distKm * 1000;

      // Earth bulge: terrain at range d sits d²/(2·R_eff) below the local tangent plane.
      const earthBulge    = (distM * distM) / (2 * R_EFF_M);
      const effectiveTerrH = terrainH - earthBulge;

      // Terrain surface angle — governs the rolling horizon.
      const terrainAngle = Math.atan2(effectiveTerrH - nodeAbsElev, distM);
      // Receiver sits rxHeightAgl above the terrain surface at this sample.
      const rxEffH  = effectiveTerrH + rxHeightAgl;
      const rxAngle = Math.atan2(rxEffH - nodeAbsElev, distM);

      const visible = rxAngle >= maxHorizonAngle;

      // Update dominant obstacle before deciding what to do with blocked points.
      if (terrainAngle > maxHorizonAngle) {
        maxHorizonAngle = terrainAngle;
        obsDistM = distM;
        obsEffH  = effectiveTerrH;
      }

      if (visible) {
        // Clear line-of-sight: standard link budget.
        // pRxRaw = physical signal; pRxDbm = after margin (used for coverage dots).
        // We include the point whenever pRxRaw ≥ sensitivity so that the probable-link
        // check can use raw signal for feasibility, even when pRxDbm falls below the
        // display threshold due to a conservative margin setting.
        const pRxRaw = receivedPowerDbm({
          eirpDbm, distKm, gainDbi, elevAngleRad: rxAngle, rxGainDbi, patternN,
        });
        const pRxDbm = pRxRaw - linkMarginDb;
        if (pRxRaw >= SENSITIVITY_DBM) {
          const classification = classifySignal(pRxDbm);
          points.push({ lat, lon, terrainH, classification, pRxDbm, pRxRaw, r, s });
        }
      } else {
        // Terrain-blocked: LoRa diffracts around single dominant obstacle.
        // Only attempt if the obstacle is meaningfully between tx and rx.
        const d2 = distM - obsDistM;
        if (obsDistM > 0 && d2 > 100) {
          // Height of the direct tx→rx line at the obstacle's distance.
          const hDirectAtObs = nodeAbsElev + (rxEffH - nodeAbsElev) * (obsDistM / distM);
          const hExcess = obsEffH - hDirectAtObs;
          if (hExcess > 0) {
            const v = hExcess * Math.sqrt(2 * distM / (LAMBDA_M * obsDistM * d2));
            const diffrLoss = knifeEdgeLoss(v);
            const pRxRaw = receivedPowerDbm({
              eirpDbm, distKm, gainDbi, elevAngleRad: rxAngle, rxGainDbi, patternN,
            }) - diffrLoss;
            const pRxDbm = pRxRaw - linkMarginDb;
            if (pRxRaw >= SENSITIVITY_DBM) {
              points.push({ lat, lon, terrainH, classification: 'marginal', pRxDbm, pRxRaw, r, s });
            }
          }
        }
      }
    }
  }

  return points;
}
