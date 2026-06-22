import * as Cesium from 'cesium';
import { eirpStatus } from './eirp.js';
import { state } from './state.js';

const RAY_COUNT = 360;
const SAMPLE_COUNT = 500;
const STEP_KM = 0.1; // 100 m intervals

const COVERAGE_DS_PREFIX = 'coverage-';

const worker = new Worker(new URL('./coverage-worker.js', import.meta.url), { type: 'module' });

const pendingCallbacks = new Map(); // nodeId → resolve

worker.onmessage = ({ data }) => {
  if (data.type === 'result') {
    const resolve = pendingCallbacks.get(data.nodeId);
    if (resolve) {
      pendingCallbacks.delete(data.nodeId);
      resolve(data.points);
    }
  }
};

function invokeWorker(nodeId, workerPayload) {
  return new Promise(resolve => {
    pendingCallbacks.set(nodeId, resolve);
    worker.postMessage({ type: 'compute', nodeId, ...workerPayload });
  });
}

function generateSamplePositions(lat0, lon0) {
  const positions = [];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);

  for (let r = 0; r < RAY_COUNT; r++) {
    const azimuth = (r / RAY_COUNT) * 2 * Math.PI;
    for (let s = 1; s <= SAMPLE_COUNT; s++) {
      const distKm = s * STEP_KM;
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
  await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartographics);
  return positions.map((p, i) => ({
    ...p,
    terrainH: cartographics[i].height ?? 0,
  }));
}

export async function computeAndRenderCoverage(viewer, node) {
  const { effectiveEirpDbm } = eirpStatus(node.txPowerDbm, node.gainDbi);

  // Fetch node's own terrain height
  const [nodeCartographic] = await (async () => {
    const c = [Cesium.Cartographic.fromDegrees(node.lon, node.lat)];
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, c);
    return c;
  })();
  node.terrainH = nodeCartographic.height ?? 0;
  const nodeAbsElev = node.terrainH + node.elevAgl;

  // Generate and fetch terrain for all sample points
  const samplePositions = generateSamplePositions(node.lat, node.lon);
  const samplesWithHeight = await fetchTerrainHeights(samplePositions, viewer);

  // Arrange into flat array indexed [r * SAMPLE_COUNT + s - 1]
  const samples = new Array(RAY_COUNT * SAMPLE_COUNT).fill(null);
  for (const s of samplesWithHeight) {
    samples[(s.r * SAMPLE_COUNT) + (s.s - 1)] = {
      lat: s.lat, lon: s.lon, terrainH: s.terrainH, distKm: s.distKm,
    };
  }

  const points = await invokeWorker(node.id, {
    node: { nodeAbsElev, eirpDbm: effectiveEirpDbm, gainDbi: node.gainDbi },
    samples,
    rayCount: RAY_COUNT,
    sampleCount: SAMPLE_COUNT,
  });

  state.coverage.set(node.id, points);
  renderCoveragePoints(viewer, node.id, points);
}

function renderCoveragePoints(viewer, nodeId, points) {
  clearCoverageLayer(viewer, nodeId);

  const collection = new Cesium.PointPrimitiveCollection();
  const GOOD_COLOR    = new Cesium.Color(0.18, 0.80, 0.44, 0.55);
  const MARGINAL_COLOR = new Cesium.Color(1.00, 0.65, 0.00, 0.45);

  for (const p of points) {
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
      color: p.classification === 'good' ? GOOD_COLOR : MARGINAL_COLOR,
      pixelSize: 3,
    });
  }
  collection.name = COVERAGE_DS_PREFIX + nodeId;
  viewer.scene.primitives.add(collection);
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
