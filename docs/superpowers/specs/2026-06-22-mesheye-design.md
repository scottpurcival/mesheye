# MeshEye — Design Spec
**Date:** 2026-06-22  
**Status:** Approved  
**Scope:** Phase 1 MVP + Phase 2 definition

---

## Overview

MeshEye is a static web application for planning and visualising MeshCore repeater coverage across Australia. It imports live node and link data from an existing CoreScope instance, renders nodes on a 3D terrain globe, and lets users place planned repeaters to see expected coverage before deployment. No backend server is required — terrain streams from Cesium Ion, node data comes from the CoreScope API, and all computation runs in the browser.

**Primary use case:** place a planned repeater node on the map, configure its parameters, and immediately see what coverage it would provide — validated against real terrain.

---

## Phase 1 MVP Scope

1. 3D terrain globe for Australia (Cesium Ion streaming)
2. Live node import from `core.eastmesh.au` — positioned, colour-coded by role
3. Live link quality arcs from packet data (RSSI/SNR coloured green→yellow→red)
4. Click-to-place planned repeater nodes with configurable parameters
5. Per-node coverage heatmap calculated via viewshed + propagation model
6. Combined coverage view across all nodes (existing + planned) to reveal black spots
7. EIRP enforcement with live readout and warning (30 dBm / 1W limit, 915 MHz LoRa)

---

## Architecture

### Stack

| Concern | Technology |
|---|---|
| 3D globe + terrain + LoS | CesiumJS |
| Terrain tiles | Cesium Ion (free tier) |
| Build tooling | Vite (static output, fast dev server) |
| UI | Vanilla JS — Cesium owns the canvas, sidebar is simple DOM |
| Coverage computation | Web Worker (off main thread) |
| Node/link data | `core.eastmesh.au/api/nodes` + `/api/packets` |

### File Structure

```
mesheye/
  index.html
  src/
    main.js          — Cesium init, app bootstrap
    nodes.js         — CoreScope API fetch, node entity management
    coverage.js      — viewshed orchestration, result rendering
    links.js         — packet API fetch, link arc rendering
    layers.js        — layer visibility management
    ui.js            — sidebar, panels, controls, EIRP readout
    worker.js        — coverage computation (Web Worker, no Cesium)
  public/
    cesium/          — CesiumJS assets (copied by Vite plugin)
  docs/
```

### Deployment

Static files only. Works opened as `file://` locally, or hosted on GitHub Pages / any static host. No server, no database, no auth.

---

## Data Sources

### CoreScope API (`core.eastmesh.au`)

**Nodes** — `GET /api/nodes`
- Fields used: `name`, `lat`, `lon`, `role` (repeater/room/companion/sensor), `public_key` (as stable ID)
- Nodes missing `lat`/`lon` are listed in a sidebar "Unlocated Nodes" panel
- Refresh interval: 5 minutes

**Packets** — `GET /api/packets`
- Fields used: `srcHash`, `destHash`, `observer_id`, `rssi`, `snr`, `path_json`, `timestamp`
- Aggregate per node-pair: median RSSI, median SNR, last-seen timestamp
- Render as polyline arcs between node pairs, coloured by signal quality

**CORS:** If `core.eastmesh.au` does not return CORS headers permitting the MeshEye origin, fetch requests will fail. Mitigation: add a `?proxy` query parameter that routes through a lightweight CORS proxy (or configure the server). Design assumes CORS is open; proxy fallback is a contingency.

---

## Coverage Model

### Algorithm — Viewshed with Propagation

Computed in `worker.js` using pre-fetched terrain elevation data passed from the main thread.

**Input:** node position (lat/lon/elevation AGL), TX power (dBm), antenna gain (dBi), frequency (915 MHz fixed).

**Steps:**
1. Cast radials every 1° azimuth (360 rays) from the node out to max range (50 km).
2. Sample each ray at 100m intervals. For each sample point at distance `d`:

   **a. Fresnel zone clearance**
   ```
   F1 = 8.66 × sqrt(d_km / f_GHz)   [metres, at midpoint]
   ```
   At 915 MHz over 20 km: F1 ≈ 40m. Check if terrain clears F1 above the ray path. Points where terrain intrudes into F1 are classified as obstructed (even if geometric LOS exists).

   **b. Free Space Path Loss**
   ```
   FSPL (dB) = 20·log₁₀(d_km) + 20·log₁₀(f_MHz) + 32.44
   ```

   **c. Antenna elevation pattern**
   Elevation angle `θ` from the node to the sample point (0° = horizontal):
   - 0 dBi: no correction applied (uniform, isotropic)
   - G dBi (G > 0): elevation gain correction in dB = `n · 20·log₁₀(|cos(θ)|)` where `n = round(G / 3)`
   
   At bore-sight (θ=0°): correction = 0 dB (full antenna gain applied). At 45°: ≈ −n·3 dB. At 90° (straight up/down): correction → −∞ (no signal). This approximates how a vertical collinear antenna compresses gain toward the horizontal plane.

   **d. Link budget**
   ```
   EIRP = min(TX_power + antenna_gain, 30)   [dBm — hard clamped to legal limit]
   P_rx = EIRP + G_rx - FSPL + G_antenna(θ)
   ```
   `G_rx`: assumed 0 dBi (handheld). Sensitivity threshold: −130 dBm (typical LoRa node).

   **e. Classification**
   - `P_rx ≥ −110 dBm` → **good** (green)
   - `−130 ≤ P_rx < −110` → **marginal** (yellow)
   - `P_rx < −130` or obstructed → **blocked** (no overlay)

3. Results are a flat array of `{lat, lon, strength}` points, returned to main thread.
4. Main thread renders as a `Cesium.PointPrimitiveCollection` or `CustomDataSource` with colour-mapped points on terrain.

### Performance

- 360 rays × 500 samples = 180,000 points per node
- Terrain elevation samples fetched via `Cesium.sampleTerrainMostDetailed()` in batches before Worker is invoked; results passed to Worker as typed array
- Worker computation (pure arithmetic): < 500ms
- Total time including terrain fetch: 2–8 seconds depending on cache state

---

## EIRP Enforcement

Australian LIPD class licence for 915 MHz LoRa: **1W EIRP maximum (30 dBm)**.

```
EIRP (dBm) = TX_power (dBm) + antenna_gain (dBi)
```

Node panel behaviour:
- EIRP shown as live readout next to the power/gain controls
- **Green** when EIRP ≤ 30 dBm
- **Red + warning banner** when EIRP > 30 dBm
- Coverage calculation always uses `min(EIRP, 30)` — never exceeds legal limit regardless of inputs
- Panel shows required TX power reduction: "Reduce TX by X dB to comply"

TX power range: 22–30 dBm (hardware limits of typical MeshCore nodes).  
Antenna gain: 0–12 dBi (free input, validated to numeric).

---

## UI Layout

```
┌─────────────────────────────────────────────────────────┐
│  MeshEye  [Layers ▾]  [Sync CoreScope]  [+ Plan Node]  │
├──────────────┬──────────────────────────────────────────┤
│              │                                          │
│  Node Panel  │                                          │
│  (slide-in   │         Cesium 3D Globe                  │
│   when node  │                                          │
│   selected)  │                                          │
│              │                                          │
│  ─────────── │                                          │
│  Name        │                                          │
│  Role        │                                          │
│  Lat / Lon   │                                          │
│  Elev AGL    │                                          │
│  TX Power ── │                                          │
│  Ant Gain    │                                          │
│  EIRP: 30dBm │                                          │
│  [Recalc]    │                                          │
│              │                                          │
├──────────────┴──────────────────────────────────────────┤
│  50 nodes | 12 links | Last sync 14:22 | QLD region    │
└─────────────────────────────────────────────────────────┘
```

### Layers Panel (toggle visibility)

- Existing nodes (by role: repeater / room / companion / sensor)
- Planned nodes
- Coverage — per node (click node to toggle individual)
- Coverage — combined (union of all nodes)
- Link quality arcs
- Unlocated nodes list

---

## CoreScope Node Display

| Role | Colour | Icon |
|---|---|---|
| Repeater | Blue | Tower |
| Room | Green | Circle |
| Companion | Yellow | Person |
| Sensor | Purple | Dot |

Planned (undeployed) nodes: white dashed outline, same icons.

Click any node → slide-in Node Panel showing live stats (from API) or editable parameters (for planned nodes).

---

## Phase 2 (Defined, Not Phase 1)

### Multi-Site Handheld Heatmap
User drops 2+ "handheld location" pins on the map. MeshEye computes a grid of candidate repeater positions and calculates whether each candidate has adequate coverage to **all** handheld pins simultaneously. Result: a heatmap showing the best repeater placement zones. Computationally intensive — runs per-candidate in Worker with progress indication.

### First-Person / Ground-Level View
"Look from here" button on any repeater node. Camera descends to node elevation AGL and enters free-look mode. User can pan/tilt to see surrounding terrain, identify obstacles, and take bearings to other nodes (which appear as labelled markers). Exit via button or Escape.

### Interference Layer
Query ACMA RRL public API for 900 MHz band licensees within the current viewport. Display as orange markers with tooltip showing licensee, frequency, and EIRP. Helps identify potential noise sources near planned nodes.

### Potential Sites Overlay
Query OpenStreetMap Overpass API for:
- `man_made=tower` 
- `tourism=viewpoint`
- `natural=peak`
- `man_made=survey_point`

Show as candidate site markers (grey pins). Clicking shows OSM data and elevation. Useful for finding high ground to survey.

### Elevation Exaggeration
Slider mapped to `viewer.scene.verticalExaggeration` (range 1×–10×). Helps visualise terrain variation in low-relief areas like western Queensland.

---

## Assumptions & Constraints

- **LoRa sensitivity:** −130 dBm (handheld). Not configurable in Phase 1.
- **Terrain resolution:** Cesium Ion World Terrain (~30m in populated areas, coarser outback). Sufficient for 915 MHz Fresnel zone calculations at regional scale.
- **Propagation model:** simplified (FSPL + Fresnel + antenna pattern). Does not model troposcatter, humidity, or vegetation. Appropriate for planning tool, not regulatory compliance modelling.
- **No user accounts / saved state** in Phase 1. Planned nodes exist only in the current browser session (localStorage persistence is a Phase 2 nice-to-have).
- **Cesium Ion:** free tier requires a token (1M tile requests/month). Token is stored in source as a public env var — acceptable for a personal/community tool.
- **CORS:** assumes `core.eastmesh.au` permits cross-origin requests. To be verified during implementation; proxy fallback to be added if needed.
