import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { state } from './state.js';
import { fetchNodes, fetchLinks } from './api.js';
import { renderNodes } from './node-layer.js';
import { renderLinks } from './link-layer.js';
import { initPanel } from './ui-panel.js';
import { initLayers } from './layers.js';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

export let viewer;

async function syncCoreScope() {
  try {
    const [nodes, links] = await Promise.all([fetchNodes(), fetchLinks()]);

    state.nodes.clear();
    for (const n of nodes) state.nodes.set(n.publicKey, n);

    state.packets.clear();
    for (const l of links) state.packets.set(l.key, l);

    state.lastSyncTime = new Date();

    renderNodes(viewer, nodes);
    renderLinks(viewer, [...state.packets.values()], state.nodes);
    document.getElementById('statusbar').textContent =
      `${state.nodes.size} nodes | ${state.packets.size} links | Last sync ${state.lastSyncTime.toLocaleTimeString()}`;
  } catch (err) {
    console.error('CoreScope sync failed:', err);
    document.getElementById('statusbar').textContent =
      `Sync failed: ${err.message}. Check CORS — CoreScope must allow requests from this origin.`;
  }
}

async function bootstrap() {
  viewer = new Cesium.Viewer('cesium-container', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    baseLayerPicker: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    geocoder: false,
    infoBox: false,
    selectionIndicator: false,
    fullscreenButton: false,
  });

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(144.0, -22.0, 2_000_000),
    duration: 0,
  });

  await syncCoreScope();
  setInterval(syncCoreScope, 300_000);

  document.getElementById('btn-sync').addEventListener('click', syncCoreScope);
  initPanel(viewer);
  initLayers(viewer);
}

bootstrap();
