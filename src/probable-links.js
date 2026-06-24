import * as Cesium from 'cesium';
import { calcEirp } from './eirp.js';
import { SENSITIVITY_DBM } from './propagation.js';
import { state } from './state.js';
import { RAY_COUNT, SAMPLE_COUNT, RANGE_KM, MIN_DIST_KM } from './coverage.js';

const DS_NAME = 'probable-links';

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

export async function evaluateProbableLinks(viewer, sourceNode, points) {
  clearProbableLinks(viewer);

  const coverageMap = new Map();
  for (const p of points) coverageMap.set(`${p.r},${p.s}`, p.pRxDbm);

  const sourceEirpDbm = calcEirp(sourceNode.txPowerDbm ?? 30, sourceNode.gainDbi ?? 0);
  const sourceNoiseFloor = sourceNode.noiseFloorDbm ?? SENSITIVITY_DBM;

  const candidates = [
    ...state.nodes.values(),
    ...state.plannedNodes.filter(n => n.id !== sourceNode.id),
  ];

  // Sample terrain (level 9) for candidate nodes that don't have a height yet.
  const needHeight = candidates.filter(n => n.lat && n.lon && n.terrainH == null);
  if (needHeight.length) {
    const cartos = needHeight.map(n => Cesium.Cartographic.fromDegrees(n.lon, n.lat));
    await Cesium.sampleTerrain(viewer.terrainProvider, 9, cartos);
    needHeight.forEach((n, i) => { n.terrainH = cartos[i].height ?? 0; });
  }

  const ve = viewer.scene.verticalExaggeration;
  const srcH = ((sourceNode.terrainH ?? 0) + (sourceNode.elevAgl ?? 5)) * ve;
  const ds = new Cesium.CustomDataSource(DS_NAME);

  for (const node of candidates) {
    if (!node.lat || !node.lon) continue;

    const distKm = haversineKm(sourceNode.lat, sourceNode.lon, node.lat, node.lon);
    if (distKm < 0.1 || distKm > RANGE_KM) continue;

    const bear = bearingDeg(sourceNode.lat, sourceNode.lon, node.lat, node.lon);
    const r = Math.round(bear / 360 * RAY_COUNT) % RAY_COUNT;
    const sRaw = (SAMPLE_COUNT - 1) * Math.log(distKm / MIN_DIST_KM) / Math.log(RANGE_KM / MIN_DIST_KM);
    const s = Math.min(SAMPLE_COUNT - 1, Math.max(0, Math.round(sRaw)));

    const forwardRxDbm = coverageMap.get(`${r},${s}`) ?? null;
    if (forwardRxDbm === null) continue;

    const nodeNoiseFloor = node.noiseFloorDbm ?? SENSITIVITY_DBM;
    const forwardOk = forwardRxDbm >= nodeNoiseFloor;

    const existingEirpDbm = calcEirp(node.txPowerDbm ?? 30, node.gainDbi ?? 2);
    const propagationLossDb = sourceEirpDbm - forwardRxDbm + state.rxGainDbi;
    const reverseRxDbm = existingEirpDbm - propagationLossDb + (sourceNode.gainDbi ?? 0);
    const reverseOk = reverseRxDbm >= sourceNoiseFloor;

    if (!forwardOk && !reverseOk) continue;

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
        positions: [
          Cesium.Cartesian3.fromDegrees(sourceNode.lon, sourceNode.lat, srcH),
          Cesium.Cartesian3.fromDegrees(node.lon, node.lat, ((node.terrainH ?? 0) + (node.elevAgl ?? 5)) * ve),
        ],
        width: bidir ? 3 : 2,
        material: color,
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
