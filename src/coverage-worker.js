import { receivedPowerDbm, classifySignal } from './propagation.js';

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

      // Terrain surface angle — used to update the horizon (obstacles block at terrain height)
      const terrainAngle = Math.atan2(terrainH - nodeAbsElev, distM);
      // Receiver angle — receiver is rxHeightAgl above the terrain surface
      const rxAngle = Math.atan2(terrainH + rxHeightAgl - nodeAbsElev, distM);

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
