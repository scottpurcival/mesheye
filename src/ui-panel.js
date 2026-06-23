import * as Cesium from 'cesium';
import { state } from './state.js';
import { eirpStatus, EIRP_LIMIT_DBM } from './eirp.js';
import { computeAndRenderCoverage, clearCoverageLayer, toggleCoverageNode, isCoverageNodeVisible } from './coverage.js';
import { clearProbableLinks } from './probable-links.js';

const STORAGE_KEY = 'mesheye-planned-nodes';

function savePlannedNodes() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.plannedNodes));
}

export function restorePlannedNodes(viewer) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); }
  catch (_) { saved = []; }
  for (const node of saved) {
    state.plannedNodes.push(node);
    addPlannedNodeEntity(node);
    // Re-sample terrain if terrainH was never set (old saves) or is zero
    if (!node.terrainH) refreshNodeTerrainHeight(viewer, node);
  }
}

let _viewer;

// Panel element refs
const panel     = () => document.getElementById('panel-node');
const pnName    = () => document.getElementById('pn-name');
const pnRole    = () => document.getElementById('pn-role');
const pnPos     = () => document.getElementById('pn-pos');
const pnElev    = () => document.getElementById('pn-elev');
const pnTx      = () => document.getElementById('pn-tx');
const pnTxVal   = () => document.getElementById('pn-tx-val');
const pnGain       = () => document.getElementById('pn-gain');
const pnNoiseFloor = () => document.getElementById('pn-noise-floor');
const pnBeamwidth = () => document.getElementById('pn-beamwidth');
const pnPattern   = () => document.getElementById('pn-pattern');
const pnEirp    = () => document.getElementById('pn-eirp');
const pnWarn    = () => document.getElementById('pn-eirp-warn');
const pnCalc      = () => document.getElementById('pn-calc');
const pnToggleCov = () => document.getElementById('pn-toggle-cov');
const pnRemove    = () => document.getElementById('pn-remove');

function drawAntennaPattern(gainDbi, beamwidthDeg) {
  const canvas = pnPattern();
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 12;

  ctx.clearRect(0, 0, W, H);

  // Background rings
  ctx.strokeStyle = '#2a2a3e';
  ctx.lineWidth = 1;
  [0.33, 0.67, 1.0].forEach(f => {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.beginPath();
  ctx.moveTo(cx - R - 8, cy); ctx.lineTo(cx + R + 8, cy);
  ctx.moveTo(cx, cy - R - 8); ctx.lineTo(cx, cy + R + 8);
  ctx.stroke();

  // Compute n: from beamwidth if supplied, else from gainDbi (old approximation)
  let n;
  if (beamwidthDeg && beamwidthDeg > 0 && beamwidthDeg < 180) {
    const thetaHalf = (beamwidthDeg / 2) * Math.PI / 180;
    n = -3 / (20 * Math.log10(Math.cos(thetaHalf)));
  } else {
    n = gainDbi > 0 ? Math.round(gainDbi / 3) : 0;
  }

  // Isotropic reference (dashed) when there is real gain
  if (n > 0) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Elevation pattern: amplitude = |cos(θ)|^n
  // θ = 0 → horizon (max), θ = ±90° → vertical null
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 2;
  ctx.fillStyle = '#4fc3f718';
  ctx.beginPath();
  for (let deg = 0; deg <= 360; deg++) {
    const θ = (deg * Math.PI) / 180;
    const amp = n === 0 ? 1 : Math.pow(Math.abs(Math.cos(θ)), n);
    const r = R * amp;
    const x = cx + r * Math.cos(θ);
    const y = cy - r * Math.sin(θ);
    if (deg === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#666';
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('up', cx, 9);
  ctx.fillText('down', cx, H - 1);
  ctx.textAlign = 'right';
  ctx.fillText('horiz', W - 1, cy - 3);
  ctx.textAlign = 'left';
  ctx.fillText('horiz', 1, cy - 3);
}

function updateEirpReadout() {
  const tx = Number(pnTx().value);
  const gain = Number(pnGain().value);
  const status = eirpStatus(tx, gain);
  pnTxVal().textContent = tx;
  pnEirp().textContent = `EIRP: ${status.eirpDbm} dBm ${status.compliant ? '✓' : '✗'}`;
  pnEirp().className = `eirp-readout ${status.compliant ? 'eirp-ok' : 'eirp-warn'}`;
  if (!status.compliant) {
    pnWarn().style.display = '';
    pnWarn().textContent = `Reduce TX by ${status.requiredReductionDb} dB to comply (max ${EIRP_LIMIT_DBM} dBm EIRP)`;
  } else {
    pnWarn().style.display = 'none';
  }
  drawAntennaPattern(gain, Number(pnBeamwidth().value) || null);
}

function showPanel(node, isPlanned) {
  panel().classList.add('visible');
  pnName().textContent = node.name;
  pnRole().textContent = isPlanned ? 'Planned' : node.role;
  pnPos().textContent = `${node.lat.toFixed(4)}, ${node.lon.toFixed(4)}`;
  pnElev().value = node.elevAgl ?? 5;
  pnTx().value = node.txPowerDbm ?? 30;
  pnGain().value = node.gainDbi ?? 0;
  pnNoiseFloor().value = node.noiseFloorDbm ?? -130;
  pnBeamwidth().value = node.vertBeamwidthDeg ?? '';
  pnRemove().style.display = isPlanned ? '' : 'none';
  const hasCov = state.coverage.has(node.id);
  pnToggleCov().style.display = hasCov ? '' : 'none';
  if (hasCov) {
    pnToggleCov().textContent = isCoverageNodeVisible(_viewer, node.id) ? 'Hide Coverage' : 'Show Coverage';
  }
  updateEirpReadout();
}

function hidePanel() {
  panel().classList.remove('visible');
  state.selectedNodeId = null;
}

function getSelectedNode() {
  if (!state.selectedNodeId) return null;
  return state.nodes.get(state.selectedNodeId)
    ?? state.plannedNodes.find(n => n.id === state.selectedNodeId)
    ?? null;
}

function applyPanelValuesToNode(node) {
  node.elevAgl = Number(pnElev().value);
  node.txPowerDbm = Number(pnTx().value);
  node.gainDbi = Number(pnGain().value);
  node.noiseFloorDbm = Number(pnNoiseFloor().value);
  node.vertBeamwidthDeg = Number(pnBeamwidth().value) || null;
}

function nodePosition(node) {
  // terrainH is the real (non-exaggerated) terrain height from sampleTerrain.
  // Multiply by verticalExaggeration so the entity sits on the visual terrain surface.
  const h = (node.terrainH ?? 0) * _viewer.scene.verticalExaggeration;
  return Cesium.Cartesian3.fromDegrees(node.lon, node.lat, h);
}

function addPlannedNodeEntity(node) {
  _viewer.entities.add({
    id: node.id,
    name: node.name,
    position: nodePosition(node),
    point: {
      pixelSize: 12,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#4fc3f7'),
      outlineWidth: 2.5,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: node.name,
      font: '12px system-ui',
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 2,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

// Sample terrain at a node's lat/lon and update its terrainH + entity position.
function refreshNodeTerrainHeight(viewer, node) {
  const c = [Cesium.Cartographic.fromDegrees(node.lon, node.lat)];
  Cesium.sampleTerrain(viewer.terrainProvider, 11, c).then(() => {
    node.terrainH = c[0].height ?? 0;
    savePlannedNodes();
    const entity = viewer.entities.getById(node.id);
    if (entity) entity.position = nodePosition(node);
  });
}

export function initPanel(viewer) {
  _viewer = viewer;

  // EIRP live update
  pnTx().addEventListener('input', updateEirpReadout);
  pnGain().addEventListener('input', updateEirpReadout);
  pnBeamwidth().addEventListener('input', updateEirpReadout);

  // Calculate coverage button
  pnCalc().addEventListener('click', async () => {
    const node = getSelectedNode();
    if (!node) return;
    applyPanelValuesToNode(node);
    savePlannedNodes();
    pnCalc().textContent = 'Calculating…';
    pnCalc().disabled = true;
    try {
      await computeAndRenderCoverage(viewer, node);
      pnToggleCov().style.display = '';
      pnToggleCov().textContent = 'Hide Coverage';
    } finally {
      pnCalc().textContent = 'Calculate Coverage';
      pnCalc().disabled = false;
    }
  });

  // Toggle coverage visibility for selected node
  pnToggleCov().addEventListener('click', () => {
    const node = getSelectedNode();
    if (!node) return;
    const nowVisible = toggleCoverageNode(viewer, node.id);
    pnToggleCov().textContent = nowVisible ? 'Hide Coverage' : 'Show Coverage';
  });

  // Remove planned node
  pnRemove().addEventListener('click', () => {
    const node = getSelectedNode();
    if (!node) return;
    clearCoverageLayer(viewer, node.id);
    clearProbableLinks(viewer);
    viewer.entities.removeById(node.id);
    state.plannedNodes = state.plannedNodes.filter(n => n.id !== node.id);
    savePlannedNodes();
    hidePanel();
  });

  // Plan Node button: enter placement mode
  document.getElementById('btn-plan-node').addEventListener('click', () => {
    state.isPlacingNode = true;
    document.getElementById('btn-plan-node').textContent = 'Click map to place…';
    viewer.container.style.cursor = 'crosshair';
  });

  // Single LEFT_CLICK handler: branches on placement vs. selection mode
  viewer.screenSpaceEventHandler.setInputAction(movement => {
    if (state.isPlacingNode) {
      // Placement mode: drop a new planned node
      state.isPlacingNode = false;
      document.getElementById('btn-plan-node').textContent = '+ Plan Node';
      viewer.container.style.cursor = '';

      const cartesian = viewer.scene.pickPosition(movement.position);
      if (!cartesian) return;
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);

      const node = {
        id: `planned-${Date.now()}`,
        name: `Planned ${state.plannedNodes.length + 1}`,
        lat, lon,
        elevAgl: 5,
        txPowerDbm: 30,
        gainDbi: 0,
        terrainH: 0,
      };
      state.plannedNodes.push(node);
      state.selectedNodeId = node.id;
      addPlannedNodeEntity(node);
      refreshNodeTerrainHeight(viewer, node); // async: samples terrain, updates position + saves
      showPanel(node, true);
    } else {
      // Selection mode: pick an existing or planned node
      const picked = viewer.scene.pick(movement.position);
      if (Cesium.defined(picked) && picked.id?.id) {
        const entityId = picked.id.id;
        state.selectedNodeId = entityId;
        const existing = state.nodes.get(entityId);
        const planned = state.plannedNodes.find(n => n.id === entityId);
        if (existing) showPanel({ ...existing, elevAgl: 5, txPowerDbm: 30, gainDbi: 0 }, false);
        if (planned) showPanel(planned, true);
      } else {
        hidePanel();
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
