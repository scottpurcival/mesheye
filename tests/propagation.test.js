import { describe, it, expect } from 'vitest';
import { fspl, antennaElevCorrDb, classifySignal, receivedPowerDbm } from '../src/propagation.js';

describe('fspl', () => {
  it('returns 0 for zero distance', () => {
    expect(fspl(0)).toBe(0);
  });

  it('returns ~91.7 dB at 1 km for 915 MHz', () => {
    // PL(1km) = 30*log10(1) + 20*log10(915) + 32.44 = 0 + 59.23 + 32.44 = 91.67
    expect(fspl(1)).toBeCloseTo(91.67, 1);
  });

  it('increases by ~9 dB per doubling of distance (exponent 3)', () => {
    // 30*log10(2) ≈ 9.03
    const diff = fspl(2) - fspl(1);
    expect(diff).toBeCloseTo(9.03, 1);
  });

  it('returns ~121.7 dB at 10 km', () => {
    // 30*log10(10) + 91.67 = 30 + 91.67 = 121.67
    expect(fspl(10)).toBeCloseTo(121.67, 1);
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

  it('classifies good at -110 dBm', () => {
    expect(classifySignal(-110)).toBe('good');
  });

  it('classifies marginal at -129 dBm', () => {
    expect(classifySignal(-129)).toBe('marginal');
  });

  it('classifies marginal at -130 dBm', () => {
    expect(classifySignal(-130)).toBe('marginal');
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

  it('adds rxGainDbi directly to received power', () => {
    const base = receivedPowerDbm({ eirpDbm: 30, distKm: 10, gainDbi: 0, elevAngleRad: 0, rxGainDbi: 0 });
    const withRx = receivedPowerDbm({ eirpDbm: 30, distKm: 10, gainDbi: 0, elevAngleRad: 0, rxGainDbi: 2 });
    expect(withRx - base).toBeCloseTo(2, 5);
  });

  it('defaults rxGainDbi to 0 when omitted', () => {
    const explicit = receivedPowerDbm({ eirpDbm: 30, distKm: 10, gainDbi: 0, elevAngleRad: 0, rxGainDbi: 0 });
    const omitted  = receivedPowerDbm({ eirpDbm: 30, distKm: 10, gainDbi: 0, elevAngleRad: 0 });
    expect(omitted).toBeCloseTo(explicit, 10);
  });
});
