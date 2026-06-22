import * as Cesium from 'cesium';

const LINK_DS_NAME = 'link-arcs';

function snrToColor(snr) {
  // >= 10: green, 0–10: yellow, < 0: red
  if (snr >= 10) return Cesium.Color.fromCssColorString('#4caf5099');
  if (snr >= 0)  return Cesium.Color.fromCssColorString('#ffa72699');
  return Cesium.Color.fromCssColorString('#ef535099');
}

export function renderLinks(viewer, links, nodes) {
  clearLinkLayer(viewer);
  const ds = new Cesium.CustomDataSource(LINK_DS_NAME);

  for (const link of links) {
    const src = nodes.get(link.srcHash);
    const dst = nodes.get(link.destHash);
    if (!src?.lat || !dst?.lat) continue;

    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([
          src.lon, src.lat,
          dst.lon, dst.lat,
        ]),
        width: 2,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.15,
          color: snrToColor(link.medianSnr),
        }),
        clampToGround: true,
      },
      description: `RSSI: ${link.medianRssi} dBm | SNR: ${link.medianSnr.toFixed(1)} dB`,
    });
  }

  viewer.dataSources.add(ds);
}

export function clearLinkLayer(viewer) {
  const existing = viewer.dataSources.getByName(LINK_DS_NAME)[0];
  if (existing) viewer.dataSources.remove(existing, true);
}

export function setLinkLayerVisible(viewer, visible) {
  const ds = viewer.dataSources.getByName(LINK_DS_NAME)[0];
  if (ds) ds.show = visible;
}
