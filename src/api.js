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
