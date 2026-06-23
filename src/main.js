import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { state } from './state.js';
import { fetchNodes, fetchLinks } from './api.js';
import { renderNodes } from './node-layer.js';
import { renderLinks } from './link-layer.js';
import { initPanel, restorePlannedNodes } from './ui-panel.js';
import { initLayers } from './layers.js';
import { updateStatus } from './ui-status.js';

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
    updateStatus();
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

  // Replace default Bing satellite with OpenStreetMap
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(
    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
  );

  // Exaggerate vertical scale so terrain relief is visible at regional zoom
  viewer.scene.verticalExaggeration = 3.0;

  // Fly to Queensland with a 45° tilt so terrain is immediately visible
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(149.0, -24.0, 800_000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-45),
      roll: 0,
    },
    duration: 0,
  });

  await syncCoreScope();
  setInterval(syncCoreScope, 300_000);

  document.getElementById('btn-sync').addEventListener('click', syncCoreScope);
  initPanel(viewer);
  restorePlannedNodes(viewer);
  initLayers(viewer);
}

bootstrap();
