import * as Cesium from 'cesium';
import { state } from './state.js';
import { eirpStatus, EIRP_LIMIT_DBM } from './eirp.js';
import { computeAndRenderCoverage, clearCoverageLayer } from './coverage.js';

let _viewer;

// Panel element refs
const panel     = () => document.getElementById('panel-node');
const pnName    = () => document.getElementById('pn-name');
const pnRole    = () => document.getElementById('pn-role');
const pnPos     = () => document.getElementById('pn-pos');
const pnElev    = () => document.getElementById('pn-elev');
const pnTx      = () => document.getElementById('pn-tx');
const pnTxVal   = () => document.getElementById('pn-tx-val');
const pnGain    = () => document.getElementById('pn-gain');
const pnEirp    = () => document.getElementById('pn-eirp');
const pnWarn    = () => document.getElementById('pn-eirp-warn');
const pnCalc    = () => document.getElementById('pn-calc');
const pnRemove  = () => document.getElementById('pn-remove');

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
}

function showPanel(node, isPlanned) {
  panel().classList.add('visible');
  pnName().textContent = node.name;
  pnRole().textContent = isPlanned ? 'Planned' : node.role;
  pnPos().textContent = `${node.lat.toFixed(4)}, ${node.lon.toFixed(4)}`;
  pnElev().value = node.elevAgl ?? 5;
  pnTx().value = node.txPowerDbm ?? 30;
  pnGain().value = node.gainDbi ?? 0;
  pnRemove().style.display = isPlanned ? '' : 'none';
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
}

function addPlannedNodeEntity(node) {
  _viewer.entities.add({
    id: node.id,
    name: node.name,
    position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat),
    point: {
      pixelSize: 12,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#4fc3f7'),
      outlineWidth: 2.5,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: node.name,
      font: '12px system-ui',
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 2,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

export function initPanel(viewer) {
  _viewer = viewer;

  // EIRP live update
  pnTx().addEventListener('input', updateEirpReadout);
  pnGain().addEventListener('input', updateEirpReadout);

  // Calculate coverage button
  pnCalc().addEventListener('click', async () => {
    const node = getSelectedNode();
    if (!node) return;
    applyPanelValuesToNode(node);
    pnCalc().textContent = 'Calculating…';
    pnCalc().disabled = true;
    try {
      await computeAndRenderCoverage(viewer, node);
    } finally {
      pnCalc().textContent = 'Calculate Coverage';
      pnCalc().disabled = false;
    }
  });

  // Remove planned node
  pnRemove().addEventListener('click', () => {
    const node = getSelectedNode();
    if (!node) return;
    clearCoverageLayer(viewer, node.id);
    viewer.entities.removeById(node.id);
    state.plannedNodes = state.plannedNodes.filter(n => n.id !== node.id);
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

      const cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
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
