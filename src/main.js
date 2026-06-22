import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

export let viewer;

export async function initGlobe() {
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

  // Fly to Queensland on load
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(144.0, -22.0, 2_000_000),
    duration: 0,
  });

  return viewer;
}

// Bootstrap — imports added by later tasks
initGlobe();
