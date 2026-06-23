import * as Cesium from 'cesium';
import { calcEirp } from './eirp.js';
import { patternNFromBeamwidth } from './propagation.js';
import { state } from './state.js';
import { evaluateProbableLinks, clearProbableLinks } from './probable-links.js';

export const RAY_COUNT = 90;
export const SAMPLE_COUNT = 100;
export const RANGE_KM = 128;
export const MIN_DIST_KM = 0.01; // 10 m — near-field start
// Samples are log-spaced from MIN_DIST_KM to RANGE_KM so that close-in
// angles (where antenna gain pattern actually matters) are well resolved.
export const STEP_KM = RANGE_KM / SAMPLE_COUNT; // kept for reference only

const COVERAGE_DS_PREFIX = 'coverage-';

import CoverageWorker from './coverage-worker.js?worker';

const worker = new CoverageWorker();

const pendingCallbacks = new Map(); // nodeId → { resolve, reject }

worker.onmessage = ({ data }) => {
  if (data.type === 'result') {
    const cb = pendingCallbacks.get(data.nodeId);
    if (cb) {
      pendingCallbacks.delete(data.nodeId);
      cb.resolve(data.points);
    }
  }
};

worker.onerror = (err) => {
  console.error('Coverage worker error:', err);
  for (const [, cb] of pendingCallbacks) cb.reject(new Error('Worker failed: ' + err.message));
  pendingCallbacks.clear();
};

function invokeWorker(nodeId, workerPayload) {
  return new Promise((resolve, reject) => {
    pendingCallbacks.set(nodeId, { resolve, reject });
    worker.postMessage({ type: 'compute', nodeId, ...workerPayload });
  });
}

function sampleDist(s) {
  // Log-spaced: s=0 → MIN_DIST_KM, s=SAMPLE_COUNT-1 → RANGE_KM
  return MIN_DIST_KM * Math.pow(RANGE_KM / MIN_DIST_KM, s / (SAMPLE_COUNT - 1));
}

function generateSamplePositions(lat0, lon0) {
  const positions = [];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);

  for (let r = 0; r < RAY_COUNT; r++) {
    const azimuth = (r / RAY_COUNT) * 2 * Math.PI;
    for (let s = 0; s < SAMPLE_COUNT; s++) {
      const distKm = sampleDist(s);
      const dLat = (distKm * Math.cos(azimuth)) / 111.32;
      const dLon = (distKm * Math.sin(azimuth)) / (111.32 * cosLat);
      positions.push({ lat: lat0 + dLat, lon: lon0 + dLon, distKm, r, s });
    }
  }
  return positions;
}

async function fetchTerrainHeights(positions, viewer) {
  const cartographics = positions.map(p =>
    Cesium.Cartographic.fromDegrees(p.lon, p.lat)
  );
  await Cesium.sampleTerrain(viewer.terrainProvider, 11, cartographics);
  return positions.map((p, i) => ({
    ...p,
    terrainH: cartographics[i].height ?? 0,
  }));
}

export async function computeAndRenderCoverage(viewer, node) {
  // Use uncapped EIRP for physical prediction; compliance warning is shown in the UI panel.
  const eirpDbm = calcEirp(node.txPowerDbm, node.gainDbi);

  // Fetch node's own terrain height (level 11 matches sample grid — fast)
  const [nodeCartographic] = await (async () => {
    const c = [Cesium.Cartographic.fromDegrees(node.lon, node.lat)];
    await Cesium.sampleTerrain(viewer.terrainProvider, 11, c);
    return c;
  })();
  node.terrainH = nodeCartographic.height ?? 0;
  const nodeAbsElev = node.terrainH + node.elevAgl;

  // Generate and fetch terrain for all sample points
  const samplePositions = generateSamplePositions(node.lat, node.lon);
  const samplesWithHeight = await fetchTerrainHeights(samplePositions, viewer);

  // Arrange into flat array indexed [r * SAMPLE_COUNT + s] (s is 0-indexed)
  const samples = new Array(RAY_COUNT * SAMPLE_COUNT).fill(null);
  for (const sp of samplesWithHeight) {
    samples[(sp.r * SAMPLE_COUNT) + sp.s] = {
      lat: sp.lat, lon: sp.lon, terrainH: sp.terrainH, distKm: sp.distKm,
    };
  }

  const patternN = patternNFromBeamwidth(node.vertBeamwidthDeg);
  const points = await invokeWorker(node.id, {
    node: { nodeAbsElev, eirpDbm, gainDbi: node.gainDbi, rxHeightAgl: state.rxHeightAgl, rxGainDbi: state.rxGainDbi, patternN },
    samples,
    rayCount: RAY_COUNT,
    sampleCount: SAMPLE_COUNT,
  });

  state.coverage.set(node.id, points);
  renderCoveragePoints(viewer, node.id, points);
  evaluateProbableLinks(viewer, node, points);
  document.getElementById('coverage-legend').classList.add('visible');
}

// Map pRxDbm to a Cesium.Color using a sqrt curve so the gradient feels
// proportional to perceived signal quality (inverse-square power fall-off).
// -130 dBm (noise floor) → red, -50 dBm and above → bright green.
const SIGNAL_FLOOR_DBM = -130;
const SIGNAL_CEIL_DBM  = -50;

function signalColor(pRxDbm) {
  const tLinear = Math.max(0, Math.min(1,
    (pRxDbm - SIGNAL_FLOOR_DBM) / (SIGNAL_CEIL_DBM - SIGNAL_FLOOR_DBM)
  ));
  const t = Math.sqrt(tLinear);
  const r = t < 0.5 ? 1.0 : 2.0 * (1.0 - t);
  const g = t < 0.5 ? 2.0 * t : 1.0;
  return new Cesium.Color(r, g, 0.0, 0.75);
}

function renderCoveragePoints(viewer, nodeId, points) {
  clearCoverageLayer(viewer, nodeId);

  const ve = viewer.scene.verticalExaggeration;
  const collection = new Cesium.PointPrimitiveCollection();

  for (const p of points) {
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(
        p.lon, p.lat, (p.terrainH ?? 0) * ve,
      ),
      color: signalColor(p.pRxDbm),
      pixelSize: 4,
    });
  }
  collection.name = COVERAGE_DS_PREFIX + nodeId;
  viewer.scene.primitives.add(collection);
}

export function toggleCoverageNode(viewer, nodeId) {
  const name = COVERAGE_DS_PREFIX + nodeId;
  const primitives = viewer.scene.primitives;
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives.get(i);
    if (p.name === name) { p.show = !p.show; return p.show; }
  }
  return false;
}

export function isCoverageNodeVisible(viewer, nodeId) {
  const name = COVERAGE_DS_PREFIX + nodeId;
  const primitives = viewer.scene.primitives;
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives.get(i);
    if (p.name === name) return p.show;
  }
  return false;
}

export function clearCoverageLayer(viewer, nodeId) {
  const name = COVERAGE_DS_PREFIX + nodeId;
  const primitives = viewer.scene.primitives;
  for (let i = primitives.length - 1; i >= 0; i--) {
    if (primitives.get(i).name === name) {
      primitives.remove(primitives.get(i));
      break;
    }
  }
}

export function setCoverageLayerVisible(viewer, visible) {
  const primitives = viewer.scene.primitives;
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives.get(i);
    if (p.name?.startsWith(COVERAGE_DS_PREFIX)) p.show = visible;
  }
}
