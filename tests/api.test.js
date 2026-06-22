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
