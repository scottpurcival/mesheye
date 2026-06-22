import { receivedPowerDbm, classifySignal } from './propagation.js';

self.onmessage = ({ data }) => {
  if (data.type === 'compute') {
    const points = computeCoverage(data);
    self.postMessage({ type: 'result', nodeId: data.nodeId, points });
  }
};

function computeCoverage({ node, samples, rayCount, sampleCount }) {
  // node: { nodeAbsElev, eirpDbm, gainDbi }
  // samples: flat array of {lat, lon, terrainH, distKm}, indexed [r * sampleCount + s]
  const { nodeAbsElev, eirpDbm, gainDbi } = node;
  const points = [];

  for (let r = 0; r < rayCount; r++) {
    let maxHorizonAngle = -Infinity;

    for (let s = 0; s < sampleCount; s++) {
      const sample = samples[r * sampleCount + s];
      if (!sample || sample.distKm <= 0) continue;

      const { lat, lon, terrainH, distKm } = sample;
      const distM = distKm * 1000;
      const elevAngleRad = Math.atan2(terrainH - nodeAbsElev, distM);

      const visible = elevAngleRad >= maxHorizonAngle;
      maxHorizonAngle = Math.max(maxHorizonAngle, elevAngleRad);

      if (!visible) {
        // Don't push blocked points — saves memory; renderer treats absent points as blocked
        continue;
      }

      const pRx = receivedPowerDbm({ eirpDbm, distKm, gainDbi, elevAngleRad });
      const classification = classifySignal(pRx);
      if (classification !== 'blocked') {
        points.push({ lat, lon, classification });
      }
    }
  }

  return points;
}
