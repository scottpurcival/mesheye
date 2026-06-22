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
