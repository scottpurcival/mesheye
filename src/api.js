const BASE = '';

const PAGE_SIZE = 1000;

function toNodeRecord(n) {
  return {
    publicKey: n.public_key,
    name: n.name,
    lat: n.lat ?? null,
    lon: n.lon ?? null,
    role: n.role,
    lastSeen: n.last_seen,
  };
}

export async function fetchNodes() {
  const all = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${BASE}/api/nodes?limit=${PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) throw new Error(`CoreScope nodes fetch failed: ${res.status}`);
    const { nodes: page } = await res.json();
    for (const n of page) all.push(toNodeRecord(n));
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

export async function fetchLinks() {
  const res = await fetch(`${BASE}/api/packets?limit=1000`);
  if (!res.ok) throw new Error(`CoreScope packets fetch failed: ${res.status}`);
  const { packets: raw } = await res.json();

  // Group by observer (receiver) + sender short-ID pair.
  // observer_id is the full public_key (uppercase) of the receiving node.
  // srcHash comes from decoded_json and is the 1-byte hex short-ID of the sender.
  const groups = new Map();
  for (const p of raw) {
    if (!p.observer_id) continue;
    let srcHash = null;
    try {
      if (p.decoded_json) srcHash = JSON.parse(p.decoded_json).srcHash ?? null;
    } catch (_) {}
    if (!srcHash) continue;

    const key = `${p.observer_id.toLowerCase()}-${srcHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  return [...groups.entries()].map(([key, packets]) => {
    const rssis = packets.map(p => p.rssi).filter(r => r != null).sort((a, b) => a - b);
    const snrs  = packets.map(p => p.snr).filter(s => s != null).sort((a, b) => a - b);
    const latest = packets.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    let srcHash = null;
    try { srcHash = JSON.parse(packets[0].decoded_json)?.srcHash ?? null; } catch (_) {}
    return {
      key,
      observerId: packets[0].observer_id.toLowerCase(),
      srcHash,
      medianRssi: rssis.length ? median(rssis) : 0,
      medianSnr:  snrs.length  ? median(snrs)  : 0,
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
