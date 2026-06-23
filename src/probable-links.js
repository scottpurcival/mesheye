import * as Cesium from 'cesium';
import { calcEirp } from './eirp.js';
import { SENSITIVITY_DBM } from './propagation.js';
import { state } from './state.js';
import { RAY_COUNT, SAMPLE_COUNT, RANGE_KM, MIN_DIST_KM } from './coverage.js';

const DS_NAME = 'probable-links';

// Bearing from (lat1,lon1) to (lat2,lon2), degrees 0-360 from north clockwise.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function evaluateProbableLinks(viewer, sourceNode, points) {
  clearProbableLinks(viewer);

  // Build O(1) lookup: "r,s" → pRxDbm for all visible coverage points
  const coverageMap = new Map();
  for (const p of points) coverageMap.set(`${p.r},${p.s}`, p.pRxDbm);

  const sourceEirpDbm = calcEirp(sourceNode.txPowerDbm ?? 30, sourceNode.gainDbi ?? 0);
  const sourceNoiseFloor = sourceNode.noiseFloorDbm ?? SENSITIVITY_DBM;

  const ds = new Cesium.CustomDataSource(DS_NAME);

  for (const [, node] of state.nodes) {
    if (!node.lat || !node.lon) continue;

    const distKm = haversineKm(sourceNode.lat, sourceNode.lon, node.lat, node.lon);
    if (distKm < 0.1 || distKm > RANGE_KM) continue;

    // Map node position to nearest grid cell using inverse of log-spacing formula
    const bear = bearingDeg(sourceNode.lat, sourceNode.lon, node.lat, node.lon);
    const r = Math.round(bear / 360 * RAY_COUNT) % RAY_COUNT;
    const sRaw = (SAMPLE_COUNT - 1) * Math.log(distKm / MIN_DIST_KM) / Math.log(RANGE_KM / MIN_DIST_KM);
    const s = Math.min(SAMPLE_COUNT - 1, Math.max(0, Math.round(sRaw)));

    const forwardRxDbm = coverageMap.get(`${r},${s}`) ?? null;
    if (forwardRxDbm === null) continue; // terrain-blocked from source

    // Forward link: source → this node (uses this node's noise floor)
    const nodeNoiseFloor = node.noiseFloorDbm ?? SENSITIVITY_DBM;
    const forwardOk = forwardRxDbm >= nodeNoiseFloor;

    // Reverse link: this node → source (path loss symmetric; EIRP may differ)
    const existingEirpDbm = calcEirp(node.txPowerDbm ?? 30, node.gainDbi ?? 2);
    const pathLossDb = sourceEirpDbm - forwardRxDbm;
    const reverseRxDbm = existingEirpDbm - pathLossDb;
    const reverseOk = reverseRxDbm >= sourceNoiseFloor;

    if (!forwardOk && !reverseOk) continue;

    // Cyan = bidirectional, magenta = one-way (source can reach node but not hear back)
    const bidir = forwardOk && reverseOk;
    const color = bidir
      ? Cesium.Color.fromCssColorString('#00e5ffdd')
      : Cesium.Color.fromCssColorString('#ff4081aa');

    const label = bidir
      ? `↔ Probable link | ↓ ${forwardRxDbm.toFixed(0)} dBm  ↑ ${reverseRxDbm.toFixed(0)} dBm`
      : forwardOk
        ? `→ One-way (${node.name} can hear source, ${reverseRxDbm.toFixed(0)} dBm back too weak)`
        : `← One-way (source can't hear ${node.name}, noise floor ${nodeNoiseFloor} dBm)`;

    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([
          sourceNode.lon, sourceNode.lat,
          node.lon, node.lat,
        ]),
        width: bidir ? 3 : 2,
        material: color,
        clampToGround: true,
      },
      description: label,
    });
  }

  viewer.dataSources.add(ds);
}

export function clearProbableLinks(viewer) {
  const existing = viewer.dataSources.getByName(DS_NAME)[0];
  if (existing) viewer.dataSources.remove(existing, true);
}
