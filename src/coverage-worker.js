import { receivedPowerDbm, classifySignal } from './propagation.js';

// Effective Earth radius for radio propagation (4/3 × geometric, standard atmosphere).
// This accounts for atmospheric refraction bending radio waves slightly downward,
// extending the radio horizon beyond the geometric horizon.
const R_EFF_M = 8_495_000; // 4/3 × 6 371 000 m

self.onmessage = ({ data }) => {
  if (data.type === 'compute') {
    const points = computeCoverage(data);
    self.postMessage({ type: 'result', nodeId: data.nodeId, points });
  }
};

function computeCoverage({ node, samples, rayCount, sampleCount }) {
  // node: { nodeAbsElev, eirpDbm, gainDbi, rxHeightAgl, rxGainDbi, patternN }
  // samples: flat array of {lat, lon, terrainH, distKm}, indexed [r * sampleCount + s]
  const { nodeAbsElev, eirpDbm, gainDbi, rxHeightAgl, rxGainDbi, patternN = null } = node;
  const points = [];

  for (let r = 0; r < rayCount; r++) {
    let maxHorizonAngle = -Infinity;

    for (let s = 0; s < sampleCount; s++) {
      const sample = samples[r * sampleCount + s];
      if (!sample || sample.distKm <= 0) continue;

      const { lat, lon, terrainH, distKm } = sample;
      const distM = distKm * 1000;

      // Earth bulge: the ellipsoid surface drops away from the local tangent plane
      // at the transmitter by d²/(2·R_eff). Subtracting this makes far terrain appear
      // at its correct geometric angle — without it the model is too pessimistic at range.
      const earthBulge = (distM * distM) / (2 * R_EFF_M);
      const effectiveTerrainH = terrainH - earthBulge;

      // Terrain surface angle — used to update the horizon (obstacles block at terrain height)
      const terrainAngle = Math.atan2(effectiveTerrainH - nodeAbsElev, distM);
      // Receiver angle — receiver is rxHeightAgl above the terrain surface
      const rxAngle = Math.atan2(effectiveTerrainH + rxHeightAgl - nodeAbsElev, distM);

      const visible = rxAngle >= maxHorizonAngle;
      maxHorizonAngle = Math.max(maxHorizonAngle, terrainAngle);

      if (!visible) continue;

      const pRxDbm = receivedPowerDbm({ eirpDbm, distKm, gainDbi, elevAngleRad: rxAngle, rxGainDbi, patternN });
      const classification = classifySignal(pRxDbm);
      if (classification !== 'blocked') {
        points.push({ lat, lon, terrainH, classification, pRxDbm, r, s });
      }
    }
  }

  return points;
}
