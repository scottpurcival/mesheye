import * as Cesium from 'cesium';
import { calcEirp } from './eirp.js';
import { SENSITIVITY_DBM } from './propagation.js';
import { state } from './state.js';
import { RAY_COUNT, SAMPLE_COUNT, RANGE_KM, MIN_DIST_KM } from './coverage.js';
import { triggerLosForNodes } from './los-profile.js';

const DS_NAME = 'probable-links';

// Screen-space pick data — populated after each render pass.
let _pickableLinks = [];
export function getPickableLinks() { return _pickableLinks; }

const R_EFF_M  = 8_495_000; // 4/3 × Earth radius — standard atmospheric refraction
const LAMBDA_M = 300 / 915; // 915 MHz wavelength in metres
const FRESNEL_SAMPLES = 128; // samples per link path for Fresnel colour decision

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function evaluateProbableLinks(viewer, sourceNode, points) {
  clearProbableLinks(viewer);

  // pRxRaw = physical signal without link margin — used for link feasibility.
  const coverageMap = new Map();
  for (const p of points) coverageMap.set(`${p.r},${p.s}`, p.pRxRaw ?? p.pRxDbm);

  const sourceEirpDbm  = calcEirp(sourceNode.txPowerDbm ?? 30, sourceNode.gainDbi ?? 0);
  const sourceNoiseFloor = sourceNode.noiseFloorDbm ?? SENSITIVITY_DBM;

  const candidates = [
    ...state.nodes.values(),
    ...state.plannedNodes.filter(n => n.id !== sourceNode.id),
  ];

  // Always re-sample sourceNode terrain — it's excluded from candidates and
  // may have a stale or null height that would corrupt the LOS line.
  {
    const carto = Cesium.Cartographic.fromDegrees(sourceNode.lon, sourceNode.lat);
    await Cesium.sampleTerrain(viewer.terrainProvider, 11, [carto]);
    sourceNode.terrainH = carto.height ?? 0;
  }

  // Sample terrain (level 11) for candidate nodes that don't have a height yet.
  const needHeight = candidates.filter(n => n.lat && n.lon && n.terrainH == null);
  if (needHeight.length) {
    const cartos = needHeight.map(n => Cesium.Cartographic.fromDegrees(n.lon, n.lat));
    await Cesium.sampleTerrain(viewer.terrainProvider, 11, cartos);
    needHeight.forEach((n, i) => { n.terrainH = cartos[i].height ?? 0; });
  }

  const ve = viewer.scene.verticalExaggeration;
  // Real-world antenna height (metres ASL) — used for Fresnel geometry.
  const srcHReal = (sourceNode.terrainH ?? 0) + (sourceNode.elevAgl ?? 5);
  const srcH     = srcHReal * ve; // visual height for Cesium

  // ── Pass 1: determine feasible links ─────────────────────────────────────
  const feasible = [];

  for (const node of candidates) {
    if (!node.lat || !node.lon) continue;

    const distKm = haversineKm(sourceNode.lat, sourceNode.lon, node.lat, node.lon);
    if (distKm < 0.1 || distKm > RANGE_KM) continue;

    const bear = bearingDeg(sourceNode.lat, sourceNode.lon, node.lat, node.lon);
    const r    = Math.round(bear / 360 * RAY_COUNT) % RAY_COUNT;
    const sRaw = (SAMPLE_COUNT - 1) * Math.log(distKm / MIN_DIST_KM) / Math.log(RANGE_KM / MIN_DIST_KM);
    const s    = Math.min(SAMPLE_COUNT - 1, Math.max(0, Math.round(sRaw)));

    // Primary cell lookup — if null, try adjacent distance samples and rays.
    // The grid is discrete: a node at 90 km may sit between cells, or the
    // nearest ray may pass through terrain the actual path avoids.
    let forwardRxDbm = coverageMap.get(`${r},${s}`) ?? null;
    if (forwardRxDbm === null) {
      for (const [dr, ds] of [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[-1,1],[1,-1],[1,1]]) {
        const rs = Math.max(0, Math.min(SAMPLE_COUNT - 1, s + ds));
        const rr = (r + dr + RAY_COUNT) % RAY_COUNT;
        const v  = coverageMap.get(`${rr},${rs}`) ?? null;
        if (v !== null && (forwardRxDbm === null || v > forwardRxDbm)) forwardRxDbm = v;
      }
    }
    if (forwardRxDbm === null) continue;

    const nodeNoiseFloor = node.noiseFloorDbm ?? SENSITIVITY_DBM;
    const forwardOk      = forwardRxDbm >= nodeNoiseFloor;

    const existingEirpDbm  = calcEirp(node.txPowerDbm ?? 30, node.gainDbi ?? 2);
    const propagationLossDb = sourceEirpDbm - forwardRxDbm + state.rxGainDbi;
    const reverseRxDbm      = existingEirpDbm - propagationLossDb + (sourceNode.gainDbi ?? 0);
    const reverseOk         = reverseRxDbm >= sourceNoiseFloor;

    if (!forwardOk && !reverseOk) continue;

    const dstHReal = (node.terrainH ?? 0) + (node.elevAgl ?? 5);
    const totalDistM = distKm * 1000;

    feasible.push({
      node, distKm, totalDistM,
      forwardOk, reverseOk,
      forwardRxDbm, reverseRxDbm,
      srcHReal, dstHReal,
      dstH: dstHReal * ve,
    });
  }

  // ── Pass 2: batch Fresnel terrain sampling across all feasible paths ──────
  const fresnelCartos = [];
  const fresnelMeta   = []; // { fi (feasible index), d1, totalDistM }

  for (let fi = 0; fi < feasible.length; fi++) {
    const { node, totalDistM } = feasible[fi];
    for (let i = 1; i < FRESNEL_SAMPLES; i++) {
      const t = i / FRESNEL_SAMPLES;
      fresnelCartos.push(Cesium.Cartographic.fromDegrees(
        sourceNode.lon + (node.lon - sourceNode.lon) * t,
        sourceNode.lat + (node.lat - sourceNode.lat) * t,
      ));
      fresnelMeta.push({ fi, d1: t * totalDistM, totalDistM });
    }
  }

  if (fresnelCartos.length) {
    await Cesium.sampleTerrain(viewer.terrainProvider, 11, fresnelCartos);
  }

  // Minimum Fresnel clearance (%) per feasible link.
  const fresnelPct = feasible.map(() => Infinity);

  for (let mi = 0; mi < fresnelMeta.length; mi++) {
    const { fi, d1, totalDistM } = fresnelMeta[mi];
    const { srcHReal, dstHReal } = feasible[fi];
    const d2         = totalDistM - d1;
    const terrainH   = fresnelCartos[mi].height ?? 0;
    const earthBulge = d1 * d2 / (2 * R_EFF_M);
    const effectiveH = terrainH + earthBulge;
    const losH       = srcHReal + (dstHReal - srcHReal) * (d1 / totalDistM);
    const fresnelR   = Math.sqrt(LAMBDA_M * d1 * d2 / totalDistM);
    const pct        = fresnelR > 0 ? (losH - effectiveH) / fresnelR * 100 : 100;
    if (pct < fresnelPct[fi]) fresnelPct[fi] = pct;
  }

  // ── Pass 3: add entities ──────────────────────────────────────────────────
  const ds = new Cesium.CustomDataSource(DS_NAME);
  _pickableLinks = [];

  for (let fi = 0; fi < feasible.length; fi++) {
    const { node, forwardOk, reverseOk, forwardRxDbm, reverseRxDbm, dstH } = feasible[fi];
    const bidir = forwardOk && reverseOk;
    const fPct  = fresnelPct[fi];
    const fresnelWarn = fPct < 60;

    const beamBlocked = fPct < 0; // terrain above LOS line — signal only via diffraction

    const color = beamBlocked
      ? Cesium.Color.fromCssColorString('#ef535088')   // red — main beam blocked
      : fresnelWarn
        ? Cesium.Color.fromCssColorString('#ffa726dd') // orange — Fresnel <60%
        : bidir
          ? Cesium.Color.fromCssColorString('#00e5ffdd') // cyan — bidir, clear
          : Cesium.Color.fromCssColorString('#ff4081aa'); // magenta — one-way, clear

    const fresnelNote = fresnelWarn
      ? ` | Fresnel ${Math.max(0, Math.round(fPct))}% ⚠`
      : ` | Fresnel ${Math.min(100, Math.round(fPct))}%`;

    const label = bidir
      ? `↔ Probable link | ↓ ${forwardRxDbm.toFixed(0)} dBm  ↑ ${reverseRxDbm.toFixed(0)} dBm${fresnelNote}`
      : forwardOk
        ? `→ One-way (${node.name} can hear source, ${reverseRxDbm.toFixed(0)} dBm back too weak)${fresnelNote}`
        : `← One-way (source can't hear ${node.name})${fresnelNote}`;

    const cartA = Cesium.Cartesian3.fromDegrees(sourceNode.lon, sourceNode.lat, srcH);
    const cartB = Cesium.Cartesian3.fromDegrees(node.lon, node.lat, dstH);

    _pickableLinks.push({
      cartA, cartB,
      srcId: sourceNode.publicKey ?? sourceNode.id,
      dstId: node.publicKey ?? node.id,
    });

    ds.entities.add({
      polyline: {
        positions: [cartA, cartB],
        width: beamBlocked ? 1 : bidir ? 3 : 2,
        material: color,
        depthFailMaterial: color.withAlpha(0.35),
      },
      description: label,
    });
  }

  viewer.dataSources.add(ds);
  renderLinksList(feasible, fresnelPct, sourceNode);
}

function renderLinksList(feasible, fresnelPct, sourceNode) {
  const container = document.getElementById('pn-links-list');
  const items     = document.getElementById('pn-links-items');
  if (!container || !items) return;

  if (feasible.length === 0) {
    container.style.display = 'none';
    return;
  }

  const srcId = sourceNode.publicKey ?? sourceNode.id;

  items.innerHTML = feasible.map((f, fi) => {
    const { node, forwardOk, reverseOk, forwardRxDbm, reverseRxDbm } = f;
    const bidir       = forwardOk && reverseOk;
    const fPct        = fresnelPct[fi];
    const beamBlocked = fPct < 0;
    const fWarn       = !beamBlocked && fPct < 60;
    const dstId       = node.publicKey ?? node.id;
    const dir         = bidir ? '↔' : forwardOk ? '↓' : '↑';
    const rxDbm       = bidir ? forwardRxDbm : forwardOk ? forwardRxDbm : reverseRxDbm;
    const nameColor   = beamBlocked ? 'color:#ef5350;' : '';
    const fColor      = beamBlocked ? '#ef5350' : fWarn ? '#ffa726' : '#4caf50';
    const fLabel      = `${Math.max(0, Math.round(Math.min(fPct, 100)))}%${fWarn ? '⚠' : ''}`;
    const btnBorder   = beamBlocked ? 'border-color:#ef5350;color:#ef5350;' : '';

    return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #1a1a2e;">
      <span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${nameColor}" title="${node.name}">${dir} ${node.name}</span>
      <span style="font-size:10px;color:#aaa;flex-shrink:0;">${rxDbm.toFixed(0)}</span>
      <span style="font-size:10px;color:${fColor};flex-shrink:0;">${fLabel}</span>
      <button class="btn btn-outline" style="padding:1px 6px;font-size:10px;flex-shrink:0;${btnBorder}"
        data-src="${srcId}" data-dst="${dstId}">LOS</button>
    </div>`;
  }).join('');

  items.querySelectorAll('button[data-src]').forEach(btn => {
    btn.addEventListener('click', () => triggerLosForNodes(btn.dataset.src, btn.dataset.dst));
  });

  container.style.display = 'block';
}

export function clearProbableLinks(viewer) {
  _pickableLinks = [];
  const container = document.getElementById('pn-links-list');
  if (container) container.style.display = 'none';
  const existing = viewer.dataSources.getByName(DS_NAME)[0];
  if (existing) viewer.dataSources.remove(existing, true);
}
