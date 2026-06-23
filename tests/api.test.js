import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchNodes, fetchLinks } from '../src/api.js';

const MOCK_NODES = [
  { public_key: 'abc123', name: 'Tower Alpha', lat: -27.5, lon: 153.0, role: 'repeater', last_seen: '2026-06-22T10:00:00Z' },
  { public_key: 'def456', name: 'Base Beta', lat: null, lon: null, role: 'room', last_seen: '2026-06-22T09:00:00Z' },
];

// Packets use the real CoreScope shape:
//   observer_id = full uppercase public_key of the receiving node
//   decoded_json = JSON string with srcHash (1-byte hex short-ID of sender)
const MOCK_PACKETS = [
  {
    observer_id: 'DEF456',
    decoded_json: '{"srcHash":"ab","destHash":"de"}',
    rssi: -70, snr: 8.5, timestamp: '2026-06-22T10:00:00Z',
  },
  {
    observer_id: 'DEF456',
    decoded_json: '{"srcHash":"ab","destHash":"de"}',
    rssi: -80, snr: 6.0, timestamp: '2026-06-22T09:50:00Z',
  },
  {
    observer_id: 'ABC123',
    decoded_json: '{"srcHash":"de","destHash":"ab"}',
    rssi: -65, snr: 12.0, timestamp: '2026-06-22T10:01:00Z',
  },
  // Packet without decoded_json — should be skipped
  {
    observer_id: 'ABC123',
    decoded_json: null,
    rssi: -90, snr: 3.0, timestamp: '2026-06-22T10:02:00Z',
  },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchNodes', () => {
  it('transforms API nodes to NodeRecord', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ nodes: MOCK_NODES }) });
    const nodes = await fetchNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({
      publicKey: 'abc123', name: 'Tower Alpha', lat: -27.5, lon: 153.0,
      role: 'repeater', lastSeen: '2026-06-22T10:00:00Z',
    });
  });

  it('includes nodes with null lat/lon', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ nodes: MOCK_NODES }) });
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
    fetch.mockResolvedValue({ ok: true, json: async () => ({ packets: MOCK_PACKETS }) });
    const links = await fetchLinks();
    // Two decodable pairs: def456←ab (2 packets) and abc123←de (1 packet); null-decoded skipped
    expect(links).toHaveLength(2);
    const link = links.find(l => l.observerId === 'def456' && l.srcHash === 'ab');
    expect(link).toBeDefined();
    expect(link.medianRssi).toBe(-75);   // median of [-80, -70]
    expect(link.medianSnr).toBe(7.25);   // median of [6.0, 8.5]
  });

  it('uses most recent timestamp per pair', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ packets: MOCK_PACKETS }) });
    const links = await fetchLinks();
    const link = links.find(l => l.observerId === 'def456');
    expect(link.lastSeen).toBe('2026-06-22T10:00:00Z');
  });

  it('skips packets with no decoded srcHash', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ packets: MOCK_PACKETS }) });
    const links = await fetchLinks();
    // The null decoded_json packet must not produce a link entry
    expect(links.every(l => l.srcHash !== null)).toBe(true);
  });

  it('normalises observer_id to lowercase', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ packets: MOCK_PACKETS }) });
    const links = await fetchLinks();
    expect(links.every(l => l.observerId === l.observerId.toLowerCase())).toBe(true);
  });

  it('throws on non-ok response', async () => {
    fetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchLinks()).rejects.toThrow('CoreScope packets fetch failed: 503');
  });
});
