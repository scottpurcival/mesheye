import { setNodeLayerVisible } from './node-layer.js';
import { setLinkLayerVisible } from './link-layer.js';
import { setCoverageLayerVisible, computeAndRenderCoverage, clearCoverageLayer } from './coverage.js';
import { state } from './state.js';

const COMBINED_DS_NAME = 'coverage-combined';

export function initLayers(viewer) {
  const el = id => document.getElementById(id);

  el('btn-layers').addEventListener('click', () => {
    const panel = el('panel-layers');
    panel.classList.toggle('visible');
    if (el('panel-node').classList.contains('visible')) {
      el('panel-node').classList.remove('visible');
    }
  });

  el('lyr-repeaters').addEventListener('change', e => setRoleVisible(viewer, 'repeater', e.target.checked));
  el('lyr-rooms').addEventListener('change', e => setRoleVisible(viewer, 'room', e.target.checked));
  el('lyr-companions').addEventListener('change', e => setRoleVisible(viewer, 'companion', e.target.checked));
  el('lyr-sensors').addEventListener('change', e => setRoleVisible(viewer, 'sensor', e.target.checked));

  el('lyr-planned').addEventListener('change', e => {
    for (const node of state.plannedNodes) {
      const entity = viewer.entities.getById(node.id);
      if (entity) entity.show = e.target.checked;
    }
  });

  el('lyr-links').addEventListener('change', e => setLinkLayerVisible(viewer, e.target.checked));

  el('lyr-coverage').addEventListener('change', e => setCoverageLayerVisible(viewer, e.target.checked));

  el('rx-height').addEventListener('change', e => { state.rxHeightAgl = Number(e.target.value); });
  el('rx-gain').addEventListener('change', e => { state.rxGainDbi = Number(e.target.value); });

  el('lyr-coverage-combined').addEventListener('change', async e => {
    if (e.target.checked) {
      await renderCombinedCoverage(viewer);
    } else {
      clearCombinedCoverage(viewer);
    }
  });
}

function setRoleVisible(viewer, role, visible) {
  const ds = viewer.dataSources.getByName('existing-nodes')[0];
  if (!ds) return;
  for (const entity of ds.entities.values) {
    const node = state.nodes.get(entity.id);
    if (node?.role === role) entity.show = visible;
  }
}

async function renderCombinedCoverage(viewer) {
  clearCombinedCoverage(viewer);

  const allNodes = [
    ...[...state.nodes.values()].filter(n => n.lat != null).map(n => ({
      ...n,
      id: `combined-${n.publicKey}`,
      elevAgl: 5,
      txPowerDbm: 30,
      gainDbi: 0,
      terrainH: 0,
    })),
    ...state.plannedNodes.map(n => ({
      ...n,
      id: `combined-${n.id}`,
    })),
  ];

  for (const node of allNodes) {
    await computeAndRenderCoverage(viewer, node);
  }
}

function clearCombinedCoverage(viewer) {
  const primitives = viewer.scene.primitives;
  for (let i = primitives.length - 1; i >= 0; i--) {
    const p = primitives.get(i);
    if (p.name?.startsWith('coverage-combined-')) primitives.remove(p);
  }
}
