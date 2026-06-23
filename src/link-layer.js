import * as Cesium from 'cesium';

const LINK_DS_NAME = 'link-arcs';

function snrToColor(snr) {
  if (snr >= 10) return Cesium.Color.fromCssColorString('#4caf50cc');
  if (snr >= 0)  return Cesium.Color.fromCssColorString('#ffa726cc');
  return Cesium.Color.fromCssColorString('#ef5350cc');
}

export function renderLinks(viewer, links, nodes) {
  clearLinkLayer(viewer);
  const ds = new Cesium.CustomDataSource(LINK_DS_NAME);

  // Build short-key (first byte of public_key) → node index for sender lookup.
  // If two nodes share the same first byte the link is ambiguous and skipped.
  const shortIndex = new Map();
  for (const [pk, node] of nodes) {
    const byte = pk.slice(0, 2);
    shortIndex.set(byte, shortIndex.has(byte) ? null : node);
  }

  for (const link of links) {
    const dst = nodes.get(link.observerId);        // receiver — full public_key match
    const src = link.srcHash ? shortIndex.get(link.srcHash) : null;  // sender — short-ID match
    if (!src?.lat || !dst?.lat) continue;

    ds.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([
          src.lon, src.lat,
          dst.lon, dst.lat,
        ]),
        width: 3,
        material: snrToColor(link.medianSnr),
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
