# MeshEye Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static web app that imports live MeshCore nodes from CoreScope, displays them on a 3D terrain globe, lets users place planned repeater nodes, and shows their expected 915 MHz LoRa coverage as a heatmap.

**Architecture:** CesiumJS renders a 3D globe streaming Australian terrain from Cesium Ion. Node and packet data is fetched from the CoreScope API at `core.eastmesh.au` and refreshed every 5 minutes. Coverage is computed in a Web Worker (geometric LOS + FSPL + antenna elevation pattern) and rendered as coloured point primitives on the terrain.

**Tech Stack:** CesiumJS 1.120+, Vite 5+, Vitest, vanilla JS (ES modules), no framework.

## Global Constraints

- Browser target: Chrome/Firefox latest only
- Frequency: 915 MHz (constant — not configurable)
- EIRP limit: 30 dBm / 1 W (Australian LIPD class licence)
- TX power range: 22–30 dBm
- Coverage max range: 50 km
- Ray count: 360 (1° azimuth resolution)
- Sample count per ray: 500 (100 m intervals → 50 km)
- LoRa sensitivity threshold: −130 dBm
- Good signal threshold: −110 dBm
- CoreScope API base URL: `https://core.eastmesh.au`
- Auto-refresh interval: 300 000 ms (5 minutes)
- Phase 1 propagation model: geometric LOS + FSPL + antenna elevation pattern (Fresnel zone penalty deferred to Phase 2)
- No user accounts, no persistence beyond browser session
- Cesium Ion token stored in `.env` as `VITE_CESIUM_ION_TOKEN` (never commit `.env`)

---

## File Map

```
mesheye/
  index.html                   — app shell: topbar, sidebar, Cesium container, statusbar
  .env.example                 — VITE_CESIUM_ION_TOKEN=your_token_here
  .gitignore
  package.json
  vite.config.js               — Vite + vite-plugin-cesium + Vitest config
  src/
    main.js                    — Cesium Viewer init, bootstrap all modules
    state.js                   — shared mutable app state (nodes, planned nodes, packets, coverage)
    eirp.js                    — pure EIRP calculation and compliance check
    api.js                     — CoreScope fetch: nodes + packets, transform to internal types
    propagation.js             — pure propagation math (fspl, antenna pattern, classify signal)
    coverage-worker.js         — Web Worker: ray-cast viewshed using propagation.js
    coverage.js                — terrain fetch orchestration + worker invocation + result rendering
    node-layer.js              — Cesium entities for existing + planned nodes
    link-layer.js              — Cesium polylines for RSSI/SNR link arcs
    layers.js                  — layer visibility toggle management
    ui-panel.js                — sidebar node panel: properties, sliders, EIRP readout
    ui-status.js               — statusbar: node count, link count, last sync time
  tests/
    eirp.test.js
    api.test.js
    propagation.test.js
```

---

## Shared Types (documented here — referenced across tasks)

```js
// NodeRecord      { publicKey:string, name:string, lat:number, lon:number, role:'repeater'|'room'|'companion'|'sensor', lastSeen:string }
// PlannedNode     { id:string, name:string, lat:number, lon:number, elevAgl:number, txPowerDbm:number, gainDbi:number, terrainH:number }
// LinkRecord      { key:string, srcHash:string, destHash:string, medianRssi:number, medianSnr:number, lastSeen:string }
// CoveragePoint   { lat:number, lon:number, classification:'good'|'marginal'|'blocked' }
// EirpStatus      { eirpDbm:number, effectiveEirpDbm:number, compliant:boolean, requiredReductionDb:number }
```

---

## Task 1: Project Scaffold + Cesium Globe

**Files:**
- Create: `package.json`
- Create: `vite.config.js`
- Create: `index.html`
- Create: `src/main.js`
- Create: `.env.example`
- Create: `.gitignore`

**Interfaces:**
- Produces: `initGlobe(containerId: string): Cesium.Viewer` — exported from `main.js`, used by all later tasks

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/scottpurcival/Claude_Projects/MeshPlanner
npm create vite@latest . -- --template vanilla --force
npm install cesium
npm install -D vite-plugin-cesium vitest
```

- [ ] **Step 2: Write `package.json`**

Replace the generated `package.json` with:

```json
{
  "name": "mesheye",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "cesium": "^1.120.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "vite-plugin-cesium": "^1.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write `vite.config.js`**

```js
import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
.env
```

- [ ] **Step 5: Write `.env.example`**

```
VITE_CESIUM_ION_TOKEN=your_token_here
```

Sign up at https://ion.cesium.com (free), create an access token, copy it, then create `.env` with the real value.

- [ ] **Step 6: Write `index.html`**

Delete the generated `index.html` and write:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>MeshEye</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { display: flex; flex-direction: column; height: 100vh; font-family: system-ui, sans-serif; background: #0f0f1a; color: #e0e0e0; overflow: hidden; }
    #topbar { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: #0a0a14; border-bottom: 1px solid #2a2a3e; flex-shrink: 0; }
    #topbar h1 { font-size: 17px; color: #4fc3f7; letter-spacing: 1px; margin-right: auto; }
    #main { display: flex; flex: 1; min-height: 0; }
    #sidebar { width: 280px; min-width: 280px; background: #0a0a14; border-right: 1px solid #2a2a3e; overflow-y: auto; display: flex; flex-direction: column; }
    #cesium-container { flex: 1; position: relative; }
    #statusbar { padding: 4px 16px; background: #0a0a14; border-top: 1px solid #2a2a3e; font-size: 11px; color: #666; flex-shrink: 0; }
    .btn { padding: 5px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; background: #1565c0; color: #fff; }
    .btn:hover { background: #1976d2; }
    .btn-outline { background: transparent; border: 1px solid #4fc3f7; color: #4fc3f7; }
    .btn-outline:hover { background: #4fc3f71a; }
    .btn-danger { background: #c62828; }
    .btn-danger:hover { background: #e53935; }
    #panel-node, #panel-layers, #panel-unlocated { padding: 16px; display: none; flex-direction: column; gap: 10px; }
    #panel-node.visible, #panel-layers.visible, #panel-unlocated.visible { display: flex; }
    .field-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
    .field-value { font-size: 14px; }
    input[type="range"] { width: 100%; accent-color: #4fc3f7; }
    input[type="number"] { width: 100%; padding: 4px 8px; background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 4px; color: #e0e0e0; font-size: 13px; }
    .eirp-readout { font-size: 16px; font-weight: bold; padding: 8px; border-radius: 4px; text-align: center; }
    .eirp-ok { background: #1b5e2033; color: #4caf50; border: 1px solid #4caf50; }
    .eirp-warn { background: #b71c1c33; color: #ef5350; border: 1px solid #ef5350; }
    .layer-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .layer-row input[type="checkbox"] { accent-color: #4fc3f7; }
    .separator { border: none; border-top: 1px solid #2a2a3e; }
    .section-title { font-size: 12px; color: #4fc3f7; text-transform: uppercase; letter-spacing: 1px; }
  </style>
</head>
<body>
  <div id="topbar">
    <h1>MeshEye</h1>
    <button class="btn btn-outline" id="btn-layers">Layers</button>
    <button class="btn btn-outline" id="btn-sync">Sync CoreScope</button>
    <button class="btn" id="btn-plan-node">+ Plan Node</button>
  </div>
  <div id="main">
    <div id="sidebar">
      <div id="panel-node">
        <div class="section-title">Node</div>
        <hr class="separator" />
        <div>
          <div class="field-label">Name</div>
          <div class="field-value" id="pn-name">—</div>
        </div>
        <div>
          <div class="field-label">Role</div>
          <div class="field-value" id="pn-role">—</div>
        </div>
        <div>
          <div class="field-label">Position</div>
          <div class="field-value" id="pn-pos">—</div>
        </div>
        <div>
          <div class="field-label">Elevation AGL (m)</div>
          <input type="number" id="pn-elev" value="5" min="0" max="200" />
        </div>
        <div>
          <div class="field-label">TX Power (dBm) <span id="pn-tx-val">30</span></div>
          <input type="range" id="pn-tx" min="22" max="30" value="30" />
        </div>
        <div>
          <div class="field-label">Antenna Gain (dBi)</div>
          <input type="number" id="pn-gain" value="0" min="0" max="12" step="0.5" />
        </div>
        <div class="eirp-readout eirp-ok" id="pn-eirp">EIRP: 30 dBm ✓</div>
        <div id="pn-eirp-warn" style="display:none; font-size:12px; color:#ef5350;"></div>
        <button class="btn" id="pn-calc">Calculate Coverage</button>
        <button class="btn btn-danger" id="pn-remove" style="display:none;">Remove Node</button>
      </div>
      <div id="panel-layers">
        <div class="section-title">Layers</div>
        <hr class="separator" />
        <label class="layer-row"><input type="checkbox" id="lyr-repeaters" checked /> Repeaters</label>
        <label class="layer-row"><input type="checkbox" id="lyr-rooms" checked /> Rooms</label>
        <label class="layer-row"><input type="checkbox" id="lyr-companions" checked /> Companions</label>
        <label class="layer-row"><input type="checkbox" id="lyr-sensors" checked /> Sensors</label>
        <label class="layer-row"><input type="checkbox" id="lyr-planned" checked /> Planned nodes</label>
        <hr class="separator" />
        <label class="layer-row"><input type="checkbox" id="lyr-links" checked /> Link quality arcs</label>
        <label class="layer-row"><input type="checkbox" id="lyr-coverage" checked /> Coverage (selected node)</label>
        <label class="layer-row"><input type="checkbox" id="lyr-coverage-combined" /> Combined coverage</label>
        <hr class="separator" />
        <div id="unlocated-list" style="font-size:12px; color:#888;"></div>
      </div>
    </div>
    <div id="cesium-container"></div>
  </div>
  <div id="statusbar">Initialising…</div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

- [ ] **Step 7: Write `src/state.js`**

```js
export const state = {
  nodes: new Map(),         // publicKey → NodeRecord
  plannedNodes: [],          // PlannedNode[]
  packets: new Map(),        // `${srcHash}-${destHash}` → LinkRecord
  coverage: new Map(),       // nodeId → CoveragePoint[]
  selectedNodeId: null,      // publicKey or planned node id
  isPlacingNode: false,
  lastSyncTime: null,        // Date
};
```

- [ ] **Step 8: Write `src/main.js`**

```js
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
```

- [ ] **Step 9: Delete generated boilerplate**

```bash
rm -f src/style.css src/counter.js src/javascript.svg public/vite.svg
```

- [ ] **Step 10: Verify globe renders**

```bash
npm run dev
```

Open `http://localhost:5173`. Expected: black UI frame with a Cesium 3D globe centred on Queensland. No console errors.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: scaffold Vite + CesiumJS globe"
```

---

## Task 2: EIRP Module (TDD)

**Files:**
- Create: `src/eirp.js`
- Create: `tests/eirp.test.js`

**Interfaces:**
- Produces: `calcEirp(txPowerDbm, gainDbi): number` — EIRP in dBm
- Produces: `eirpStatus(txPowerDbm, gainDbi): EirpStatus` — compliance object

- [ ] **Step 1: Write failing tests**

Create `tests/eirp.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { calcEirp, eirpStatus } from '../src/eirp.js';

describe('calcEirp', () => {
  it('sums tx power and antenna gain', () => {
    expect(calcEirp(30, 0)).toBe(30);
    expect(calcEirp(24, 6)).toBe(30);
    expect(calcEirp(22, 3)).toBe(25);
  });
});

describe('eirpStatus', () => {
  it('reports compliant when EIRP <= 30 dBm', () => {
    const s = eirpStatus(30, 0);
    expect(s.compliant).toBe(true);
    expect(s.eirpDbm).toBe(30);
    expect(s.effectiveEirpDbm).toBe(30);
    expect(s.requiredReductionDb).toBe(0);
  });

  it('clamps effectiveEirpDbm to 30 when over limit', () => {
    const s = eirpStatus(30, 3);
    expect(s.eirpDbm).toBe(33);
    expect(s.compliant).toBe(false);
    expect(s.effectiveEirpDbm).toBe(30);
    expect(s.requiredReductionDb).toBe(3);
  });

  it('handles exactly 30 dBm as compliant', () => {
    expect(eirpStatus(27, 3).compliant).toBe(true);
  });

  it('reports correct reduction when 2 dB over', () => {
    expect(eirpStatus(30, 2).requiredReductionDb).toBe(2);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

```bash
npm test
```

Expected: 5 tests fail with "Cannot find module '../src/eirp.js'"

- [ ] **Step 3: Write `src/eirp.js`**

```js
export const EIRP_LIMIT_DBM = 30;
export const TX_POWER_MIN_DBM = 22;
export const TX_POWER_MAX_DBM = 30;

export function calcEirp(txPowerDbm, gainDbi) {
  return txPowerDbm + gainDbi;
}

export function eirpStatus(txPowerDbm, gainDbi) {
  const eirpDbm = calcEirp(txPowerDbm, gainDbi);
  const excess = eirpDbm - EIRP_LIMIT_DBM;
  return {
    eirpDbm,
    effectiveEirpDbm: Math.min(eirpDbm, EIRP_LIMIT_DBM),
    compliant: excess <= 0,
    requiredReductionDb: Math.max(0, excess),
  };
}
```

- [ ] **Step 4: Confirm tests pass**

```bash
npm test
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/eirp.js tests/eirp.test.js
git commit -m "feat: add EIRP calculation module (TDD)"
```

---

## Task 3: CoreScope API Module (TDD)

**Files:**
- Create: `src/api.js`
- Create: `tests/api.test.js`

**Interfaces:**
- Produces: `fetchNodes(): Promise<NodeRecord[]>`
- Produces: `fetchLinks(): Promise<LinkRecord[]>` — aggregates packet data into per-pair link records

- [ ] **Step 1: Write failing tests**

Create `tests/api.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchNodes, fetchLinks } from '../src/api.js';

const MOCK_NODES = [
  { public_key: 'abc123', name: 'Tower Alpha', lat: -27.5, lon: 153.0, role: 'repeater', last_seen: '2026-06-22T10:00:00Z' },
  { public_key: 'def456', name: 'Base Beta', lat: null, lon: null, role: 'room', last_seen: '2026-06-22T09:00:00Z' },
];

const MOCK_PACKETS = [
  { srcHash: 'abc123', destHash: 'def456', observer_id: 'abc123', rssi: -70, snr: 8.5, timestamp: '2026-06-22T10:00:00Z' },
  { srcHash: 'abc123', destHash: 'def456', observer_id: 'abc123', rssi: -80, snr: 6.0, timestamp: '2026-06-22T09:50:00Z' },
  { srcHash: 'def456', destHash: 'abc123', observer_id: 'def456', rssi: -65, snr: 12.0, timestamp: '2026-06-22T10:01:00Z' },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchNodes', () => {
  it('transforms API nodes to NodeRecord', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => MOCK_NODES });
    const nodes = await fetchNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({
      publicKey: 'abc123', name: 'Tower Alpha', lat: -27.5, lon: 153.0,
      role: 'repeater', lastSeen: '2026-06-22T10:00:00Z',
    });
  });

  it('includes nodes with null lat/lon', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => MOCK_NODES });
    const nodes = await fetchNodes();
    expect(nodes[1].lat).toBeNull();
    expect(nodes[1].lon).toBeNull();
  });

  it('throws on non-ok response', async () => {
    fetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchNodes()).rejects.toThrow('CoreScope nodes fetch failed: 503');
  });
});

describe('fetchLinks', () => {
  it('aggregates packets into per-pair link records with median RSSI/SNR', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => MOCK_PACKETS });
    const links = await fetchLinks();
    // Two pairs: abc123→def456 (2 packets) and def456→abc123 (1 packet)
    expect(links).toHaveLength(2);
    const link = links.find(l => l.srcHash === 'abc123' && l.destHash === 'def456');
    expect(link).toBeDefined();
    expect(link.medianRssi).toBe(-75);  // median of -70 and -80
    expect(link.medianSnr).toBe(7.25);  // median of 8.5 and 6.0
  });

  it('uses most recent timestamp per pair', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => MOCK_PACKETS });
    const links = await fetchLinks();
    const link = links.find(l => l.srcHash === 'abc123');
    expect(link.lastSeen).toBe('2026-06-22T10:00:00Z');
  });
});
```

- [ ] **Step 2: Confirm tests fail**

```bash
npm test
```

Expected: all api.test.js tests fail with "Cannot find module"

- [ ] **Step 3: Write `src/api.js`**

```js
const BASE = 'https://core.eastmesh.au';

export async function fetchNodes() {
  const res = await fetch(`${BASE}/api/nodes`);
  if (!res.ok) throw new Error(`CoreScope nodes fetch failed: ${res.status}`);
  const raw = await res.json();
  return raw.map(n => ({
    publicKey: n.public_key,
    name: n.name,
    lat: n.lat ?? null,
    lon: n.lon ?? null,
    role: n.role,
    lastSeen: n.last_seen,
  }));
}

export async function fetchLinks() {
  const res = await fetch(`${BASE}/api/packets`);
  if (!res.ok) throw new Error(`CoreScope packets fetch failed: ${res.status}`);
  const raw = await res.json();

  // Group by src→dest pair
  const groups = new Map();
  for (const p of raw) {
    const key = `${p.srcHash}-${p.destHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  return [...groups.entries()].map(([key, packets]) => {
    const rssis = packets.map(p => p.rssi).sort((a, b) => a - b);
    const snrs = packets.map(p => p.snr).sort((a, b) => a - b);
    const latest = packets.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    return {
      key,
      srcHash: packets[0].srcHash,
      destHash: packets[0].destHash,
      medianRssi: median(rssis),
      medianSnr: median(snrs),
      lastSeen: latest.timestamp,
    };
  });
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
```

- [ ] **Step 4: Confirm tests pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api.js tests/api.test.js
git commit -m "feat: add CoreScope API module (TDD)"
```

---

## Task 4: Globe + Node Layer

**Files:**
- Modify: `src/main.js`
- Create: `src/node-layer.js`

**Interfaces:**
- Consumes: `fetchNodes(): Promise<NodeRecord[]>` from `src/api.js`
- Consumes: `state.nodes: Map` from `src/state.js`
- Produces: `renderNodes(viewer, nodes: NodeRecord[]): void` — draws/updates node entities
- Produces: `clearNodeLayer(viewer): void` — removes all node entities

- [ ] **Step 1: Write `src/node-layer.js`**

```js
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
```

- [ ] **Step 2: Update `src/main.js` to load nodes on startup**

Replace the contents of `src/main.js` with:

```js
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { state } from './state.js';
import { fetchNodes, fetchLinks } from './api.js';
import { renderNodes } from './node-layer.js';

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
}

bootstrap();
```

- [ ] **Step 3: Manual verification**

```bash
npm run dev
```

Open `http://localhost:5173`. Expected: nodes from `core.eastmesh.au` appear as coloured dots over Queensland. Status bar shows node/link count. If CORS error appears in console, the CoreScope server will need a CORS header — note it and continue (test with local mock data if needed).

- [ ] **Step 4: Commit**

```bash
git add src/main.js src/node-layer.js
git commit -m "feat: render live nodes from CoreScope on globe"
```

---

## Task 5: Link Quality Arc Layer

**Files:**
- Create: `src/link-layer.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `LinkRecord[]` from `state.packets`, `NodeRecord` from `state.nodes`
- Produces: `renderLinks(viewer, links: LinkRecord[], nodes: Map): void`
- Produces: `setLinkLayerVisible(viewer, visible: boolean): void`

- [ ] **Step 1: Write `src/link-layer.js`**

```js
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
```

- [ ] **Step 2: Import and call `renderLinks` in `src/main.js`**

Add import at top of `src/main.js`:
```js
import { renderLinks } from './link-layer.js';
```

Inside `syncCoreScope()`, after `renderNodes(viewer, nodes)` add:
```js
renderLinks(viewer, [...state.packets.values()], state.nodes);
```

- [ ] **Step 3: Manual verification**

```bash
npm run dev
```

Expected: coloured arcs connect nodes with observed links. Green = good SNR (≥10 dB), yellow = marginal (0–10 dB), red = poor (<0 dB).

- [ ] **Step 4: Commit**

```bash
git add src/link-layer.js src/main.js
git commit -m "feat: render RSSI/SNR link arcs from packet data"
```

---

## Task 6: Propagation Model (TDD) + Coverage Worker

**Files:**
- Create: `src/propagation.js`
- Create: `src/coverage-worker.js`
- Create: `tests/propagation.test.js`

**Interfaces:**
- Produces (propagation.js):
  - `fspl(distKm: number): number` — free-space path loss in dB
  - `antennaElevCorrDb(gainDbi: number, elevAngleRad: number): number` — gain correction in dB
  - `classifySignal(pRxDbm: number): 'good'|'marginal'|'blocked'`
  - `receivedPowerDbm({eirpDbm, distKm, gainDbi, elevAngleRad}): number`
- Produces (coverage-worker.js): Web Worker that handles `{type:'compute', node, samples, rayCount, sampleCount}` → posts `{type:'result', nodeId, points: CoveragePoint[]}`

- [ ] **Step 1: Write failing tests**

Create `tests/propagation.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { fspl, antennaElevCorrDb, classifySignal, receivedPowerDbm } from '../src/propagation.js';

describe('fspl', () => {
  it('returns 0 for zero distance', () => {
    expect(fspl(0)).toBe(0);
  });

  it('returns ~91.7 dB at 1 km for 915 MHz', () => {
    // FSPL = 20*log10(1) + 20*log10(915) + 32.44 = 0 + 59.23 + 32.44 = 91.67
    expect(fspl(1)).toBeCloseTo(91.67, 1);
  });

  it('increases by 6 dB per doubling of distance', () => {
    const diff = fspl(2) - fspl(1);
    expect(diff).toBeCloseTo(6.02, 1);
  });

  it('returns ~111.7 dB at 10 km', () => {
    expect(fspl(10)).toBeCloseTo(111.67, 1);
  });
});

describe('antennaElevCorrDb', () => {
  it('returns 0 for 0 dBi antenna regardless of angle', () => {
    expect(antennaElevCorrDb(0, 0)).toBe(0);
    expect(antennaElevCorrDb(0, Math.PI / 4)).toBe(0);
    expect(antennaElevCorrDb(0, Math.PI / 2)).toBe(0);
  });

  it('returns 0 at bore-sight (horizontal, θ=0) for any gain', () => {
    expect(antennaElevCorrDb(3, 0)).toBeCloseTo(0, 5);
    expect(antennaElevCorrDb(6, 0)).toBeCloseTo(0, 5);
  });

  it('returns negative correction at 45° for 3 dBi (n=1)', () => {
    // n=1, cos(45°)=0.707, 1*20*log10(0.707) ≈ -3.01
    expect(antennaElevCorrDb(3, Math.PI / 4)).toBeCloseTo(-3.01, 1);
  });

  it('returns a floor value near vertical (θ≈90°)', () => {
    expect(antennaElevCorrDb(6, Math.PI / 2 - 0.001)).toBeLessThan(-50);
  });
});

describe('classifySignal', () => {
  it('classifies good signal at -109 dBm', () => {
    expect(classifySignal(-109)).toBe('good');
  });

  it('classifies marginal at -110 dBm', () => {
    expect(classifySignal(-110)).toBe('marginal');
  });

  it('classifies marginal at -129 dBm', () => {
    expect(classifySignal(-129)).toBe('marginal');
  });

  it('classifies blocked at -130 dBm', () => {
    expect(classifySignal(-130)).toBe('blocked');
  });
});

describe('receivedPowerDbm', () => {
  it('equals EIRP minus FSPL at 0 dBi and horizontal angle', () => {
    const pRx = receivedPowerDbm({ eirpDbm: 30, distKm: 1, gainDbi: 0, elevAngleRad: 0 });
    expect(pRx).toBeCloseTo(30 - fspl(1), 5);
  });

  it('is lower at 45° with a 3 dBi antenna than at horizontal', () => {
    const horizontal = receivedPowerDbm({ eirpDbm: 30, distKm: 10, gainDbi: 3, elevAngleRad: 0 });
    const tilted = receivedPowerDbm({ eirpDbm: 30, distKm: 10, gainDbi: 3, elevAngleRad: Math.PI / 4 });
    expect(tilted).toBeLessThan(horizontal);
  });
});
```

- [ ] **Step 2: Confirm tests fail**

```bash
npm test
```

Expected: all propagation tests fail.

- [ ] **Step 3: Write `src/propagation.js`**

```js
const FREQ_MHZ = 915;
export const SENSITIVITY_DBM = -130;
export const GOOD_THRESHOLD_DBM = -110;

export function fspl(distKm) {
  if (distKm < 0.001) return 0;
  return 20 * Math.log10(distKm) + 20 * Math.log10(FREQ_MHZ) + 32.44;
}

export function antennaElevCorrDb(gainDbi, elevAngleRad) {
  if (gainDbi <= 0) return 0;
  const n = Math.round(gainDbi / 3);
  const cosTheta = Math.abs(Math.cos(elevAngleRad));
  if (cosTheta < 1e-10) return -60;
  return n * 20 * Math.log10(cosTheta);
}

export function classifySignal(pRxDbm) {
  if (pRxDbm > GOOD_THRESHOLD_DBM) return 'good';
  if (pRxDbm > SENSITIVITY_DBM) return 'marginal';
  return 'blocked';
}

export function receivedPowerDbm({ eirpDbm, distKm, gainDbi, elevAngleRad }) {
  return eirpDbm - fspl(distKm) + antennaElevCorrDb(gainDbi, elevAngleRad);
}
```

- [ ] **Step 4: Confirm tests pass**

```bash
npm test
```

Expected: all propagation tests pass. (Note: `classifySignal(-130)` = 'blocked' because we use `>` not `>=`.)

- [ ] **Step 5: Write `src/coverage-worker.js`**

```js
import { receivedPowerDbm, classifySignal } from './propagation.js';

self.onmessage = ({ data }) => {
  if (data.type === 'compute') {
    const points = computeCoverage(data);
    self.postMessage({ type: 'result', nodeId: data.nodeId, points });
  }
};

function computeCoverage({ node, samples, rayCount, sampleCount }) {
  // node: { nodeAbsElev, eirpDbm, gainDbi }
  // samples: flat array of {lat, lon, terrainH, distKm}, indexed [r * sampleCount + s]
  const { nodeAbsElev, eirpDbm, gainDbi } = node;
  const points = [];

  for (let r = 0; r < rayCount; r++) {
    let maxHorizonAngle = -Infinity;

    for (let s = 0; s < sampleCount; s++) {
      const sample = samples[r * sampleCount + s];
      if (!sample || sample.distKm <= 0) continue;

      const { lat, lon, terrainH, distKm } = sample;
      const distM = distKm * 1000;
      const elevAngleRad = Math.atan2(terrainH - nodeAbsElev, distM);

      const visible = elevAngleRad >= maxHorizonAngle;
      maxHorizonAngle = Math.max(maxHorizonAngle, elevAngleRad);

      if (!visible) {
        // Don't push blocked points — saves memory; renderer treats absent points as blocked
        continue;
      }

      const pRx = receivedPowerDbm({ eirpDbm, distKm, gainDbi, elevAngleRad });
      const classification = classifySignal(pRx);
      if (classification !== 'blocked') {
        points.push({ lat, lon, classification });
      }
    }
  }

  return points;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/propagation.js src/coverage-worker.js tests/propagation.test.js
git commit -m "feat: propagation model (TDD) + coverage Web Worker"
```

---

## Task 7: Coverage Orchestration + Heatmap Rendering

**Files:**
- Create: `src/coverage.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `viewer` (Cesium.Viewer), `PlannedNode`, `eirpStatus()` from `src/eirp.js`
- Consumes: Worker from `src/coverage-worker.js`
- Produces: `computeAndRenderCoverage(viewer, node: PlannedNode): Promise<void>`
- Produces: `clearCoverageLayer(viewer, nodeId: string): void`
- Produces: `setCoverageLayerVisible(viewer, visible: boolean): void`

- [ ] **Step 1: Write `src/coverage.js`**

```js
import * as Cesium from 'cesium';
import { eirpStatus } from './eirp.js';
import { state } from './state.js';

const RAY_COUNT = 360;
const SAMPLE_COUNT = 500;
const STEP_KM = 0.1; // 100 m intervals

const COVERAGE_DS_PREFIX = 'coverage-';

const worker = new Worker(new URL('./coverage-worker.js', import.meta.url), { type: 'module' });

const pendingCallbacks = new Map(); // nodeId → resolve

worker.onmessage = ({ data }) => {
  if (data.type === 'result') {
    const resolve = pendingCallbacks.get(data.nodeId);
    if (resolve) {
      pendingCallbacks.delete(data.nodeId);
      resolve(data.points);
    }
  }
};

function invokeWorker(nodeId, workerPayload) {
  return new Promise(resolve => {
    pendingCallbacks.set(nodeId, resolve);
    worker.postMessage({ type: 'compute', nodeId, ...workerPayload });
  });
}

function generateSamplePositions(lat0, lon0) {
  const positions = [];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);

  for (let r = 0; r < RAY_COUNT; r++) {
    const azimuth = (r / RAY_COUNT) * 2 * Math.PI;
    for (let s = 1; s <= SAMPLE_COUNT; s++) {
      const distKm = s * STEP_KM;
      const dLat = (distKm * Math.cos(azimuth)) / 111.32;
      const dLon = (distKm * Math.sin(azimuth)) / (111.32 * cosLat);
      positions.push({ lat: lat0 + dLat, lon: lon0 + dLon, distKm, r, s });
    }
  }
  return positions;
}

async function fetchTerrainHeights(positions, viewer) {
  const cartographics = positions.map(p =>
    Cesium.Cartographic.fromDegrees(p.lon, p.lat)
  );
  await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartographics);
  return positions.map((p, i) => ({
    ...p,
    terrainH: cartographics[i].height ?? 0,
  }));
}

export async function computeAndRenderCoverage(viewer, node) {
  const { effectiveEirpDbm } = eirpStatus(node.txPowerDbm, node.gainDbi);

  // Fetch node's own terrain height
  const [nodeCartographic] = await (async () => {
    const c = [Cesium.Cartographic.fromDegrees(node.lon, node.lat)];
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, c);
    return c;
  })();
  node.terrainH = nodeCartographic.height ?? 0;
  const nodeAbsElev = node.terrainH + node.elevAgl;

  // Generate and fetch terrain for all sample points
  const samplePositions = generateSamplePositions(node.lat, node.lon);
  const samplesWithHeight = await fetchTerrainHeights(samplePositions, viewer);

  // Arrange into flat array indexed [r * SAMPLE_COUNT + s - 1]
  const samples = new Array(RAY_COUNT * SAMPLE_COUNT).fill(null);
  for (const s of samplesWithHeight) {
    samples[(s.r * SAMPLE_COUNT) + (s.s - 1)] = {
      lat: s.lat, lon: s.lon, terrainH: s.terrainH, distKm: s.distKm,
    };
  }

  const points = await invokeWorker(node.id, {
    node: { nodeAbsElev, eirpDbm: effectiveEirpDbm, gainDbi: node.gainDbi },
    samples,
    rayCount: RAY_COUNT,
    sampleCount: SAMPLE_COUNT,
  });

  state.coverage.set(node.id, points);
  renderCoveragePoints(viewer, node.id, points);
}

function renderCoveragePoints(viewer, nodeId, points) {
  clearCoverageLayer(viewer, nodeId);

  const collection = new Cesium.PointPrimitiveCollection();
  const GOOD_COLOR    = new Cesium.Color(0.18, 0.80, 0.44, 0.55);
  const MARGINAL_COLOR = new Cesium.Color(1.00, 0.65, 0.00, 0.45);

  for (const p of points) {
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
      color: p.classification === 'good' ? GOOD_COLOR : MARGINAL_COLOR,
      pixelSize: 3,
    });
  }
  collection.name = COVERAGE_DS_PREFIX + nodeId;
  viewer.scene.primitives.add(collection);
}

export function clearCoverageLayer(viewer, nodeId) {
  const name = COVERAGE_DS_PREFIX + nodeId;
  const primitives = viewer.scene.primitives;
  for (let i = primitives.length - 1; i >= 0; i--) {
    if (primitives.get(i).name === name) {
      primitives.remove(primitives.get(i));
      break;
    }
  }
}

export function setCoverageLayerVisible(viewer, visible) {
  const primitives = viewer.scene.primitives;
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives.get(i);
    if (p.name?.startsWith(COVERAGE_DS_PREFIX)) p.show = visible;
  }
}
```

- [ ] **Step 2: Manual verification with a hardcoded test node**

Add this temporary block at the bottom of `src/main.js` inside `bootstrap()` after `syncCoreScope()`:

```js
// TEMP: test coverage on a hardcoded position (Brisbane city)
import { computeAndRenderCoverage } from './coverage.js';
const testNode = { id: 'test-1', name: 'Test', lat: -27.47, lon: 153.02, elevAgl: 20, txPowerDbm: 30, gainDbi: 0, terrainH: 0 };
computeAndRenderCoverage(viewer, testNode).then(() => console.log('Coverage rendered'));
```

```bash
npm run dev
```

Expected: green/yellow haze appears around Brisbane. May take 5–15 seconds (terrain fetch). No console errors.

Remove the temporary block from `main.js` once verified.

- [ ] **Step 3: Commit**

```bash
git add src/coverage.js src/main.js
git commit -m "feat: viewshed coverage computation and heatmap rendering"
```

---

## Task 8: Node Panel UI + Planned Node Placement

**Files:**
- Create: `src/ui-panel.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `computeAndRenderCoverage`, `clearCoverageLayer` from `src/coverage.js`
- Consumes: `eirpStatus` from `src/eirp.js`
- Consumes: `state` from `src/state.js`
- Consumes: `viewer` from `src/main.js`
- Produces: `initPanel(viewer): void` — wires up all sidebar panel interactions

- [ ] **Step 1: Write `src/ui-panel.js`**

```js
import * as Cesium from 'cesium';
import { state } from './state.js';
import { eirpStatus, TX_POWER_MIN_DBM, TX_POWER_MAX_DBM, EIRP_LIMIT_DBM } from './eirp.js';
import { computeAndRenderCoverage, clearCoverageLayer } from './coverage.js';

let _viewer;

// Panel element refs
const panel     = () => document.getElementById('panel-node');
const pnName    = () => document.getElementById('pn-name');
const pnRole    = () => document.getElementById('pn-role');
const pnPos     = () => document.getElementById('pn-pos');
const pnElev    = () => document.getElementById('pn-elev');
const pnTx      = () => document.getElementById('pn-tx');
const pnTxVal   = () => document.getElementById('pn-tx-val');
const pnGain    = () => document.getElementById('pn-gain');
const pnEirp    = () => document.getElementById('pn-eirp');
const pnWarn    = () => document.getElementById('pn-eirp-warn');
const pnCalc    = () => document.getElementById('pn-calc');
const pnRemove  = () => document.getElementById('pn-remove');

function updateEirpReadout() {
  const tx = Number(pnTx().value);
  const gain = Number(pnGain().value);
  const status = eirpStatus(tx, gain);
  pnTxVal().textContent = tx;
  pnEirp().textContent = `EIRP: ${status.eirpDbm} dBm ${status.compliant ? '✓' : '✗'}`;
  pnEirp().className = `eirp-readout ${status.compliant ? 'eirp-ok' : 'eirp-warn'}`;
  if (!status.compliant) {
    pnWarn().style.display = '';
    pnWarn().textContent = `Reduce TX by ${status.requiredReductionDb} dB to comply (max ${EIRP_LIMIT_DBM} dBm EIRP)`;
  } else {
    pnWarn().style.display = 'none';
  }
}

function showPanel(node, isPlanned) {
  panel().classList.add('visible');
  pnName().textContent = node.name;
  pnRole().textContent = isPlanned ? 'Planned' : node.role;
  pnPos().textContent = `${node.lat.toFixed(4)}, ${node.lon.toFixed(4)}`;
  pnElev().value = node.elevAgl ?? 5;
  pnTx().value = node.txPowerDbm ?? 30;
  pnGain().value = node.gainDbi ?? 0;
  pnRemove().style.display = isPlanned ? '' : 'none';
  updateEirpReadout();
}

function hidePanel() {
  panel().classList.remove('visible');
  state.selectedNodeId = null;
}

function getSelectedNode() {
  if (!state.selectedNodeId) return null;
  return state.nodes.get(state.selectedNodeId)
    ?? state.plannedNodes.find(n => n.id === state.selectedNodeId)
    ?? null;
}

function applyPanelValuesToNode(node) {
  node.elevAgl = Number(pnElev().value);
  node.txPowerDbm = Number(pnTx().value);
  node.gainDbi = Number(pnGain().value);
}

function addPlannedNodeEntity(node) {
  _viewer.entities.add({
    id: node.id,
    name: node.name,
    position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat),
    point: {
      pixelSize: 12,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#4fc3f7'),
      outlineWidth: 2.5,
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
    },
  });
}

export function initPanel(viewer) {
  _viewer = viewer;

  // EIRP live update
  pnTx().addEventListener('input', updateEirpReadout);
  pnGain().addEventListener('input', updateEirpReadout);

  // Calculate coverage button
  pnCalc().addEventListener('click', async () => {
    const node = getSelectedNode();
    if (!node) return;
    applyPanelValuesToNode(node);
    pnCalc().textContent = 'Calculating…';
    pnCalc().disabled = true;
    try {
      await computeAndRenderCoverage(viewer, node);
    } finally {
      pnCalc().textContent = 'Calculate Coverage';
      pnCalc().disabled = false;
    }
  });

  // Remove planned node
  pnRemove().addEventListener('click', () => {
    const node = getSelectedNode();
    if (!node) return;
    clearCoverageLayer(viewer, node.id);
    viewer.entities.removeById(node.id);
    state.plannedNodes = state.plannedNodes.filter(n => n.id !== node.id);
    hidePanel();
  });

  // Click existing node to select it
  viewer.screenSpaceEventHandler.setInputAction(movement => {
    if (state.isPlacingNode) return;
    const picked = viewer.scene.pick(movement.position);
    if (Cesium.defined(picked) && picked.id?.id) {
      const entityId = picked.id.id;
      state.selectedNodeId = entityId;
      const existing = state.nodes.get(entityId);
      const planned = state.plannedNodes.find(n => n.id === entityId);
      if (existing) showPanel({ ...existing, elevAgl: 5, txPowerDbm: 30, gainDbi: 0 }, false);
      if (planned) showPanel(planned, true);
    } else {
      hidePanel();
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Plan Node button: enter placement mode
  document.getElementById('btn-plan-node').addEventListener('click', () => {
    state.isPlacingNode = true;
    document.getElementById('btn-plan-node').textContent = 'Click map to place…';
    viewer.container.style.cursor = 'crosshair';
  });

  // Placement click
  viewer.screenSpaceEventHandler.setInputAction(movement => {
    if (!state.isPlacingNode) return;
    state.isPlacingNode = false;
    document.getElementById('btn-plan-node').textContent = '+ Plan Node';
    viewer.container.style.cursor = '';

    const cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);

    const node = {
      id: `planned-${Date.now()}`,
      name: `Planned ${state.plannedNodes.length + 1}`,
      lat, lon,
      elevAgl: 5,
      txPowerDbm: 30,
      gainDbi: 0,
      terrainH: 0,
    };
    state.plannedNodes.push(node);
    state.selectedNodeId = node.id;
    addPlannedNodeEntity(node);
    showPanel(node, true);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
```

- [ ] **Step 2: Wire up panel in `src/main.js`**

Add import at top of `src/main.js`:
```js
import { initPanel } from './ui-panel.js';
```

Add at end of `bootstrap()`, after `syncCoreScope()`:
```js
initPanel(viewer);
```

- [ ] **Step 3: Manual verification**

```bash
npm run dev
```

- Click `+ Plan Node`, click the map → white node appears, sidebar panel slides in
- Adjust TX power slider → EIRP readout updates live
- Set gain to 6 dBi with TX at 30 dBm → red warning "Reduce TX by 6 dB"
- Click `Calculate Coverage` → heatmap appears within ~10 seconds
- Click `Remove Node` → node and heatmap disappear
- Click an existing node → panel shows with its name and role, no Remove button

- [ ] **Step 4: Commit**

```bash
git add src/ui-panel.js src/main.js
git commit -m "feat: node panel UI with planned node placement and coverage trigger"
```

---

## Task 9: Layer Management + Combined Coverage

**Files:**
- Create: `src/layers.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `setNodeLayerVisible` from `src/node-layer.js`
- Consumes: `setLinkLayerVisible` from `src/link-layer.js`
- Consumes: `setCoverageLayerVisible`, `computeAndRenderCoverage`, `clearCoverageLayer` from `src/coverage.js`
- Produces: `initLayers(viewer): void`

- [ ] **Step 1: Write `src/layers.js`**

```js
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
      ...n, id: `combined-${n.publicKey}`, elevAgl: 5, txPowerDbm: 30, gainDbi: 0, terrainH: 0,
    })),
    ...state.plannedNodes,
  ];

  for (const node of allNodes) {
    await computeAndRenderCoverage(viewer, { ...node, id: `combined-${node.id}` });
  }
}

function clearCombinedCoverage(viewer) {
  const primitives = viewer.scene.primitives;
  for (let i = primitives.length - 1; i >= 0; i--) {
    const p = primitives.get(i);
    if (p.name?.startsWith('coverage-combined-')) primitives.remove(p);
  }
}
```

- [ ] **Step 2: Wire up layers in `src/main.js`**

Add import:
```js
import { initLayers } from './layers.js';
```

Add at end of `bootstrap()`:
```js
initLayers(viewer);
```

- [ ] **Step 3: Manual verification**

```bash
npm run dev
```

- Click `Layers` → layer panel opens
- Uncheck `Link quality arcs` → arcs disappear
- Uncheck `Repeaters` → repeater dots disappear; re-check → return
- Check `Combined coverage` → coverage calculates for all located nodes (may take time)
- Uncheck `Combined coverage` → combined coverage clears

- [ ] **Step 4: Commit**

```bash
git add src/layers.js src/main.js
git commit -m "feat: layer visibility toggles and combined coverage view"
```

---

## Task 10: Status Bar, Auto-Refresh + Unlocated Nodes Panel

**Files:**
- Create: `src/ui-status.js`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `state` from `src/state.js`
- Produces: `updateStatus(): void` — refreshes the statusbar and unlocated nodes list

- [ ] **Step 1: Write `src/ui-status.js`**

```js
import { state } from './state.js';

export function updateStatus() {
  const located = [...state.nodes.values()].filter(n => n.lat != null).length;
  const unlocated = state.nodes.size - located;
  const syncStr = state.lastSyncTime
    ? state.lastSyncTime.toLocaleTimeString()
    : 'Never';

  document.getElementById('statusbar').textContent =
    `${located} nodes located | ${unlocated} unlocated | ${state.packets.size} links | Last sync ${syncStr} | Auto-refresh every 5 min`;

  // Populate unlocated list in layers panel
  const listEl = document.getElementById('unlocated-list');
  const unlocatedNodes = [...state.nodes.values()].filter(n => n.lat == null);
  if (unlocatedNodes.length === 0) {
    listEl.textContent = '';
    return;
  }
  listEl.innerHTML = `<strong style="color:#4fc3f7">Unlocated nodes (${unlocatedNodes.length}):</strong><br>` +
    unlocatedNodes.map(n => `• ${n.name} (${n.role})`).join('<br>');
}
```

- [ ] **Step 2: Call `updateStatus` after each sync in `src/main.js`**

Add import:
```js
import { updateStatus } from './ui-status.js';
```

In `syncCoreScope()`, replace the `document.getElementById('statusbar').textContent = ...` lines with:
```js
updateStatus();
```

- [ ] **Step 3: Manual verification**

```bash
npm run dev
```

Expected: status bar shows "X nodes located | Y unlocated | Z links | Last sync HH:MM:SS | Auto-refresh every 5 min". Wait 5 minutes and verify the timestamp updates automatically.

- [ ] **Step 4: Run all tests one final time**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui-status.js src/main.js
git commit -m "feat: status bar with sync time and unlocated nodes panel"
```

- [ ] **Step 6: Push to GitHub**

```bash
git push
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| 3D terrain globe for Australia | Task 1 |
| Live node import from CoreScope | Task 4 |
| Colour-coded by role | Task 4 |
| Live link quality arcs (RSSI/SNR) | Task 5 |
| Click-to-place planned nodes | Task 8 |
| Per-node configurable elevation/power/gain | Task 8 |
| EIRP enforcement with live readout | Task 2 + Task 8 |
| Coverage heatmap (viewshed + FSPL + antenna pattern) | Task 6 + Task 7 |
| Combined coverage of all nodes | Task 9 |
| Black spot identification (via combined view) | Task 9 |
| Layer visibility toggles | Task 9 |
| 5-minute auto-refresh | Task 4 + Task 10 |
| Unlocated nodes list | Task 10 |
| Good/marginal/blocked classification | Task 6 |

**Known limitations documented in spec (not gaps):**
- Fresnel zone penalty deferred to Phase 2 (geometric LOS only in Phase 1)
- No session persistence (localStorage deferred to Phase 2)
- CORS must be open on CoreScope; proxy fallback not implemented in Phase 1
