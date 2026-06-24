import * as Cesium from 'cesium';

const LINK_DS_NAME = 'link-arcs';

let _pickableLinks = [];
export function getPickableLinks() { return _pickableLinks; }


function snrToColor(snr) {
  if (snr >= 10) return Cesium.Color.fromCssColorString('#4caf50cc');
  if (snr >= 0)  return Cesium.Color.fromCssColorString('#ffa726cc');
  return Cesium.Color.fromCssColorString('#ef5350cc');
}

export async function renderLinks(viewer, links, nodes) {
  clearLinkLayer(viewer);

  // Build short-key (first byte of public_key) → node for sender lookup.
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

  // Sample terrain (level 9) for endpoints that don't already have a height.
  const needHeight = [...endpointSet].filter(n => n.terrainH == null);
  if (needHeight.length) {
    const cartos = needHeight.map(n => Cesium.Cartographic.fromDegrees(n.lon, n.lat));
    await Cesium.sampleTerrain(viewer.terrainProvider, 9, cartos);
    needHeight.forEach((n, i) => { n.terrainH = cartos[i].height ?? 0; });
  }

  const ve = viewer.scene.verticalExaggeration;
  const ds = new Cesium.CustomDataSource(LINK_DS_NAME);
  _pickableLinks = [];

  for (const link of links) {
    const dst = nodes.get(link.observerId);
    const src = link.srcHash ? shortIndex.get(link.srcHash) : null;
    if (!src?.lat || !dst?.lat) continue;

    const srcH = ((src.terrainH ?? 0) + (src.elevAgl ?? 5)) * ve;
    const dstH = ((dst.terrainH ?? 0) + (dst.elevAgl ?? 5)) * ve;

    const cartA = Cesium.Cartesian3.fromDegrees(src.lon, src.lat, srcH);
    const cartB = Cesium.Cartesian3.fromDegrees(dst.lon, dst.lat, dstH);

    _pickableLinks.push({ cartA, cartB, srcId: src.publicKey, dstId: dst.publicKey });

    const color = snrToColor(link.medianSnr);
    ds.entities.add({
      polyline: {
        positions: [cartA, cartB],
        width: 3,
        material: color,
        depthFailMaterial: color.withAlpha(0.35),
      },
      description: `RSSI: ${link.medianRssi} dBm | SNR: ${link.medianSnr.toFixed(1)} dB`,
    });
  }

  viewer.dataSources.add(ds);
}

export function clearLinkLayer(viewer) {
  _pickableLinks = [];
  const existing = viewer.dataSources.getByName(LINK_DS_NAME)[0];
  if (existing) viewer.dataSources.remove(existing, true);
}

export function setLinkLayerVisible(viewer, visible) {
  const ds = viewer.dataSources.getByName(LINK_DS_NAME)[0];
  if (ds) ds.show = visible;
}
