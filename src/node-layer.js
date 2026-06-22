import * as Cesium from 'cesium';

const ROLE_COLORS = {
  repeater:  Cesium.Color.fromCssColorString('#4fc3f7'),
  room:      Cesium.Color.fromCssColorString('#66bb6a'),
  companion: Cesium.Color.fromCssColorString('#ffa726'),
  sensor:    Cesium.Color.fromCssColorString('#ce93d8'),
};

const NODE_DS_NAME = 'existing-nodes';

export function renderNodes(viewer, nodes) {
  clearNodeLayer(viewer);
  const ds = new Cesium.CustomDataSource(NODE_DS_NAME);

  for (const node of nodes) {
    if (node.lat == null || node.lon == null) continue;
    const color = ROLE_COLORS[node.role] ?? Cesium.Color.WHITE;
    ds.entities.add({
      id: node.publicKey,
      name: node.name,
      position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat),
      point: {
        pixelSize: 10,
        color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1.5,
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
        translucencyByDistance: new Cesium.NearFarScalar(500_000, 1, 2_000_000, 0),
      },
    });
  }

  viewer.dataSources.add(ds);
}

export function clearNodeLayer(viewer) {
  const existing = viewer.dataSources.getByName(NODE_DS_NAME)[0];
  if (existing) viewer.dataSources.remove(existing, true);
}

export function setNodeLayerVisible(viewer, visible) {
  const ds = viewer.dataSources.getByName(NODE_DS_NAME)[0];
  if (ds) ds.show = visible;
}
