export const state = {
  nodes: new Map(),         // publicKey → NodeRecord
  plannedNodes: [],          // PlannedNode[]
  packets: new Map(),        // `${srcHash}-${destHash}` → LinkRecord
  coverage: new Map(),       // nodeId → CoveragePoint[]
  selectedNodeId: null,      // publicKey or planned node id
  isPlacingNode: false,
  lastSyncTime: null,        // Date
  rxHeightAgl: 1.5,          // m — handheld receiver height above ground
  rxGainDbi: 2,              // dBi — typical Meshtastic whip antenna
};
