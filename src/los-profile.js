import * as Cesium from 'cesium';
import { state } from './state.js';

const PROFILE_SAMPLES = 256;
const R_EFF_M = 8_495_000;
const FREQ_MHZ = 915;
const LAMBDA_M = 300 / FREQ_MHZ;

export function initLosPanel(viewer) {
  document.getElementById('btn-los').addEventListener('click', () => {
    const panel = document.getElementById('panel-los');
    document.getElementById('panel-node').classList.remove('visible');
    document.getElementById('panel-layers').classList.remove('visible');
    panel.classList.toggle('visible');
    if (panel.classList.contains('visible')) populateDropdowns();
  });

  document.getElementById('los-compute').addEventListener('click', () => {
    const aId = document.getElementById('los-node-a').value;
    const bId = document.getElementById('los-node-b').value;
    if (!aId || !bId || aId === bId) return;
    const nodeA = findNode(aId);
    const nodeB = findNode(bId);
    if (nodeA && nodeB) computeAndDraw(viewer, nodeA, nodeB);
  });
}

export function populateDropdowns() {
  const nodes = [
    ...[...state.nodes.values()]
      .filter(n => n.lat != null)
      .map(n => ({ id: n.publicKey, name: n.name, lat: n.lat, lon: n.lon, elevAgl: n.elevAgl ?? 5 })),
    ...state.plannedNodes
      .filter(n => n.lat != null)
      .map(n => ({ id: n.id, name: n.name, lat: n.lat, lon: n.lon, elevAgl: n.elevAgl ?? 5 })),
  ];

  for (const selId of ['los-node-a', 'los-node-b']) {
    const sel = document.getElementById(selId);
    const prev = sel.value;
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select node —';
    sel.appendChild(blank);
    for (const n of nodes) {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = n.name;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
  }

  // Pre-select the currently selected node in slot A
  if (state.selectedNodeId) {
    const selA = document.getElementById('los-node-a');
    selA.value = state.selectedNodeId;
  }
}

function findNode(id) {
  if (state.nodes.has(id)) return state.nodes.get(id);
  return state.plannedNodes.find(n => n.id === id) ?? null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function computeAndDraw(viewer, nodeA, nodeB) {
  const resultEl = document.getElementById('los-result');
  const canvas   = document.getElementById('los-chart');
  resultEl.textContent = 'Sampling terrain…';

  const totalDistKm = haversineKm(nodeA.lat, nodeA.lon, nodeB.lat, nodeB.lon);
  const totalDistM  = totalDistKm * 1000;

  // Sample points along the great-circle path
  const positions = Array.from({ length: PROFILE_SAMPLES + 1 }, (_, i) => {
    const t = i / PROFILE_SAMPLES;
    return {
      lat: nodeA.lat + (nodeB.lat - nodeA.lat) * t,
      lon: nodeA.lon + (nodeB.lon - nodeA.lon) * t,
      distM: t * totalDistM,
    };
  });

  const cartos = positions.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
  await Cesium.sampleTerrain(viewer.terrainProvider, 11, cartos);

  const hA = (cartos[0].height ?? 0) + (nodeA.elevAgl ?? 5);
  const hB = (cartos[cartos.length - 1].height ?? 0) + (nodeB.elevAgl ?? 5);

  const profile = positions.map((p, i) => {
    const terrainH  = cartos[i].height ?? 0;
    const earthBulge = (p.distM ** 2) / (2 * R_EFF_M);
    const effectiveH = terrainH - earthBulge;
    const losH       = hA + (hB - hA) * (p.distM / totalDistM);
    // First Fresnel zone radius at this point
    const d1 = p.distM, d2 = totalDistM - p.distM;
    const fresnelR = (d1 > 0 && d2 > 0)
      ? Math.sqrt(LAMBDA_M * d1 * d2 / totalDistM)
      : 0;
    return { distM: p.distM, terrainH, effectiveH, losH, fresnelR };
  });

  // Clearance = LOS height minus effective terrain height
  let minClearance = Infinity;
  let firstBlockM  = null;
  for (const pt of profile) {
    const clearance = pt.losH - pt.effectiveH;
    if (clearance < minClearance) minClearance = clearance;
    if (clearance < 0 && firstBlockM === null) firstBlockM = pt.distM;
  }

  const blocked = firstBlockM !== null;
  if (blocked) {
    resultEl.innerHTML =
      `<span style="color:#ef5350">⛔ BLOCKED at ${(firstBlockM / 1000).toFixed(1)} km — terrain ${Math.abs(minClearance).toFixed(0)} m above LOS</span>`;
  } else {
    const fresnelPct = profile.reduce((min, pt) => {
      if (pt.fresnelR === 0) return min;
      return Math.min(min, (pt.losH - pt.effectiveH) / pt.fresnelR * 100);
    }, 100);
    const fresnelOk = fresnelPct >= 60;
    resultEl.innerHTML =
      `<span style="color:${fresnelOk ? '#4caf50' : '#ffa726'}">` +
      `${fresnelOk ? '✓' : '⚠'} ${totalDistKm.toFixed(1)} km | clearance ${minClearance.toFixed(0)} m | ` +
      `Fresnel ${Math.min(fresnelPct, 100).toFixed(0)}%${fresnelOk ? '' : ' (⚠ <60%)'}</span>`;
  }

  drawProfile(canvas, profile, totalDistM);
}

function drawProfile(canvas, profile, totalDistM) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PAD = { top: 8, right: 8, bottom: 22, left: 44 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const allH = profile.flatMap(p => [p.effectiveH, p.losH, p.losH + p.fresnelR]);
  const minH = Math.min(...allH) - 10;
  const maxH = Math.max(...allH) + 20;

  const sx = d => PAD.left + (d / totalDistM) * cW;
  const sy = h => PAD.top + cH - ((h - minH) / (maxH - minH)) * cH;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(0, 0, W, H);

  // Grid lines + Y labels
  ctx.font = '9px system-ui';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#555';
  for (let i = 0; i <= 4; i++) {
    const h = minH + (maxH - minH) * (i / 4);
    const y = sy(h);
    ctx.fillStyle = '#555';
    ctx.fillText(Math.round(h) + 'm', PAD.left - 3, y + 3);
    ctx.strokeStyle = '#151525';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
  }

  // X labels
  ctx.textAlign = 'center';
  ctx.fillStyle = '#555';
  for (let i = 0; i <= 4; i++) {
    const d = totalDistM * (i / 4);
    ctx.fillText((d / 1000).toFixed(0) + 'km', sx(d), H - 5);
  }

  // Fresnel zone band (first Fresnel, semi-transparent)
  ctx.beginPath();
  profile.forEach((pt, i) => {
    const x = sx(pt.distM), y = sy(pt.losH + pt.fresnelR);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  for (let i = profile.length - 1; i >= 0; i--) {
    const pt = profile[i];
    ctx.lineTo(sx(pt.distM), sy(pt.losH - pt.fresnelR));
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 229, 255, 0.07)';
  ctx.fill();

  // 60% Fresnel boundary (dotted orange)
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = '#ffa72688';
  ctx.lineWidth = 1;
  ctx.beginPath();
  profile.forEach((pt, i) => {
    const x = sx(pt.distM), y = sy(pt.losH + pt.fresnelR * 0.6);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Terrain fill — red where it penetrates Fresnel, amber where in Fresnel, green otherwise
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    const clearA = a.losH - a.effectiveH;
    const clearB = b.losH - b.effectiveH;
    const frA = a.fresnelR * 0.6, frB = b.fresnelR * 0.6;
    const color = (clearA < 0 || clearB < 0) ? '#6b2020'
      : (clearA < frA || clearB < frB) ? '#5a4010'
      : '#1a3020';

    ctx.beginPath();
    ctx.moveTo(sx(a.distM), sy(minH));
    ctx.lineTo(sx(a.distM), sy(a.effectiveH));
    ctx.lineTo(sx(b.distM), sy(b.effectiveH));
    ctx.lineTo(sx(b.distM), sy(minH));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Terrain outline
  ctx.beginPath();
  profile.forEach((pt, i) => {
    const x = sx(pt.distM), y = sy(pt.effectiveH);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#4a8a4a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // LOS line
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(profile[0].losH));
  ctx.lineTo(sx(totalDistM), sy(profile[profile.length - 1].losH));
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Endpoint dots
  for (const pt of [profile[0], profile[profile.length - 1]]) {
    ctx.beginPath();
    ctx.arc(sx(pt.distM), sy(pt.losH), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#4fc3f7';
    ctx.fill();
  }
}
