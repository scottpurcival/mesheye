# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server (proxies /api/* → https://core.eastmesh.au)
npm run build     # Production build — bakes VITE_CESIUM_ION_TOKEN from .env into bundle
npm run test      # Run Vitest test suite
npm run test -- --reporter=verbose tests/propagation.test.js  # Run a single test file
npx wrangler pages deploy dist --project-name mesheye --commit-dirty=true  # Deploy to Cloudflare Pages
```

The `.env` file holds `VITE_CESIUM_ION_TOKEN` and must never be committed (it's in `.gitignore`).

## Architecture

**MeshEye** is a single-page CesiumJS app that visualises MeshCore/Meshtastic repeater nodes fetched from a CoreScope API (https://core.eastmesh.au) and lets the user plan new nodes with 915 MHz RF coverage and link predictions.

### Data flow

```
CoreScope API (/api/nodes, /api/packets)
  → api.js (fetch + normalise)
  → state.js (global singleton Map: nodes, packets, plannedNodes, coverage)
  → Cesium render layers
```

`state.js` is the single source of truth. All modules read from and write to it directly — there is no reactive framework.

### Module responsibilities

| File | Role |
|------|------|
| `main.js` | Bootstraps Cesium Viewer, fires initial sync, sets up `terrainProviderChanged` re-render |
| `state.js` | Global state + propagation maths (`fspl`, `receivedPowerDbm`, `classifySignal`) |
| `propagation.js` | Re-exports from state; also `patternNFromBeamwidth`, `antennaElevCorrDb` |
| `eirp.js` | EIRP limit checking (30 dBm max) |
| `coverage.js` | Terrain sampling → invokes web worker → renders `PointPrimitiveCollection` |
| `coverage-worker.js` | Ray-casting viewshed + knife-edge diffraction, runs off main thread |
| `link-layer.js` | Renders observed CoreScope link arcs (SNR-coloured polylines) |
| `probable-links.js` | 3-pass probable link checker: feasibility → Fresnel sampling → entities + sidebar |
| `los-profile.js` | LOS chart panel: terrain profile, Fresnel zone, earth bulge visualisation |
| `node-layer.js` | Renders existing CoreScope nodes as coloured dots |
| `ui-panel.js` | Node detail panel, planned node placement, coverage trigger |
| `layers.js` | Layer visibility toggles + combined coverage |

### Coverage computation pipeline

`computeAndRenderCoverage` (coverage.js):
1. Samples terrain at **level 11** for the node + 72×80 grid positions in one `sampleTerrain` call
2. Sends to `coverage-worker.js` via postMessage
3. Worker ray-casts 72 rays × 80 log-spaced samples (10m → 150km) using a rolling-horizon algorithm
4. For blocked points, attempts single knife-edge diffraction (ITU-R P.526 §4.1)
5. Returns `CoveragePoint[]` with `{ r, s, pRxRaw, pRxDbm, lat, lon, terrainH }`
6. **After rendering**, calls `evaluateProbableLinks` with the same points

**`pRxRaw` vs `pRxDbm`**: `pRxRaw` is physical received power. `pRxDbm = pRxRaw - linkMarginDb`. Feasibility checks (probable links, coverage map presence) use `pRxRaw`; display dots and SNR thresholds use `pRxDbm`.

### Probable links (3-pass, probable-links.js)

**Pass 1** — feasibility: maps each candidate node to a coverage grid cell `(r, s)` via bearing + log-distance, looks up `pRxRaw` from the coverage map. If the exact cell is null, checks the 8 surrounding cells (handles nodes between grid cells or near a ray that clips terrain). Computes reverse link budget from propagation loss. Skips only if both directions fail.

**Pass 2** — batch Fresnel sampling: 128 points per feasible link, all in a single `sampleTerrain(level 11)` call.

**Pass 3** — entities: colours by Fresnel result — `fresnelPct < 0` → red (beam blocked, diffraction only), `0–60%` → orange, `≥60%` → cyan/magenta.

### Critical CesiumJS gotchas

**Vertical exaggeration (`ve = 3.0`)**: Terrain geometry vertices are scaled 3×. Any primitive or entity placed at height `h` must use `h * ve` or it will be underground. `srcH = (terrainH + elevAgl) * ve`.

**`depthFailMaterial`**: All link polylines set this so they remain visible when underground (e.g., before terrain loads). Underground entities are NOT pickable.

**`terrainProviderChanged` race**: On startup, `sampleTerrain` may hit `EllipsoidTerrainProvider` (height = 0) before `CesiumWorldTerrain` loads. `main.js` listens for `terrainProviderChanged`, resets all `node.terrainH = null`, and re-renders links once real terrain is active.

**`terrainH` caching**: All node objects cache `terrainH` after the first sample. `probable-links.js` always re-samples `sourceNode.terrainH` at level 11 at the start of each evaluation (source node is excluded from the candidates list, so it would otherwise use a stale value).

### Earth curvature — two reference frames

These are different and must not be mixed:

- **Rolling horizon** (coverage-worker): `earthBulge = d² / (2 × R_eff)` — terrain appears **lower** (tangent-plane sagitta). Subtract from terrain height.
- **Chord path profile** (los-profile, probable-links Fresnel): `earthBulge = d1 × d2 / (2 × R_eff)` — terrain appears **higher** (parabolic bulge). Add to terrain height.

`R_EFF_M = 8_495_000` (4/3 × Earth radius, standard atmospheric refraction). `LAMBDA_M = 300/915 ≈ 0.328 m`.

### Deployment

Static assets in `dist/`, Cloudflare Pages Function in `functions/api/[[path]].js` proxies all `/api/*` requests to `https://core.eastmesh.au` (avoids CORS). The Cesium Ion token is baked into the bundle at build time from `.env` — set it as a Pages environment variable for CI builds.
