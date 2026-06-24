import * as Cesium from 'cesium';

const LINK_DS_NAME = 'link-arcs';

function snrToColor(snr) {
  if (snr >= 10) return Cesium.Color.fromCssColorString('#4caf50cc');
  if (snr >= 0)  return Cesium.Color.fromCssColorString('#ffa726cc');
  return Cesium.Color.fromCssColorString('#ef5350cc');
}

export async function renderLinks(viewer, links, nodes) {
  clearLinkLayer(viewer);

  // Build short-key (first byte of public_key) → node index for sender lookup.
  const shortIndex = new Map();
  for (const [pk, node] of nodes) {
    const byte = pk.slice(0, 2);
    shortIndex.set(byte, shortIndex.has(byte) ? null : node);
  }

  // Collect unique endpoint nodes for this set of links.
  const endpointSet = new Set();
  for (const link of links) {
    const dst = nodes.get(link.observerId);
    const src = link.srcHash ? shortIndex.get(link.srcHash) : null;
    if (src?.lat && dst?.lat) { endpointSet.add(src); endpointSet.add(dst); }
  }

  // Sample terrain at level 9 for endpoints that don't already have a height.
  // Only individual node positions — fast, just a handful of points.
  const needHeight = [...endpointSet].filter(n => n.terrainH == null);
  if (needHeight.length) {
    const cartos = needHeight.map(n => Cesium.Cartographic.fromDegrees(n.lon, n.lat));
    await Cesium.sampleTerrain(viewer.terrainProvider, 9, cartos);
    needHeight.forEach((n, i) => { n.terrainH = cartos[i].height ?? 0; });
  }

  const ve = viewer.scene.verticalExaggeration;
  const ds = new Cesium.CustomDataSource(LINK_DS_NAME);

  for (const link of links) {
    const dst = nodes.get(link.observerId);
    const src = link.srcHash ? shortIndex.get(link.srcHash) : null;
    if (!src?.lat || !dst?.lat) continue;

    ds.entities.add({
      polyline: {
        // Straight PTP line through 3D space — no terrain draping.
        positions: [
          Cesium.Cartesian3.fromDegrees(src.lon, src.lat, (src.terrainH ?? 0) * ve),
          Cesium.Cartesian3.fromDegrees(dst.lon, dst.lat, (dst.terrainH ?? 0) * ve),
        ],
        arcType: Cesium.ArcType.NONE,
        width: 3,
        material: snrToColor(link.medianSnr),
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
