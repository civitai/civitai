import { describe, expect, it } from 'vitest';
import { chiSquareP, normalCdf, sampleRatio, twoProportion, welch, wilson } from '../stats';

describe('readout statistics, against textbook values', () => {
  it('normal CDF', () => {
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
  });

  it('Wilson interval, including the zero-success edge', () => {
    const ci = wilson(50, 100);
    expect(ci.low).toBeCloseTo(0.4038, 3);
    expect(ci.high).toBeCloseTo(0.5962, 3);
    expect(wilson(0, 20).low).toBe(0);
    expect(wilson(0, 20).high).toBeCloseTo(0.1611, 3);
  });

  it('two-proportion test: 50/100 vs 60/100', () => {
    const r = twoProportion({ successes: 50, n: 100 }, { successes: 60, n: 100 });
    expect(r.diff).toBeCloseTo(0.1, 10);
    expect(r.p).toBeCloseTo(0.1556, 3);
    expect(r.ci.low).toBeLessThan(0);
    expect(r.ci.high).toBeCloseTo(0.2372, 3); // 0.1 + 1.96 * sqrt(0.25/100 + 0.24/100)
  });

  it('Welch: equal means give p = 1, a clear shift a tiny p', () => {
    const same = { n: 1000, mean: 2, variance: 4 };
    expect(welch(same, same).p).toBeCloseTo(1, 6);
    expect(welch(same, { n: 1000, mean: 2.5, variance: 4 }).p).toBeLessThan(0.001);
  });

  it('chi-square tail at the 5% critical values', () => {
    expect(chiSquareP(3.841459, 1)).toBeCloseTo(0.05, 4);
    expect(chiSquareP(5.991465, 2)).toBeCloseTo(0.05, 4);
    expect(chiSquareP(0, 1)).toBe(1);
  });

  it('sample-ratio check: a fair split passes, a skewed one does not', () => {
    expect(sampleRatio([5010, 4990], [0.5, 0.5]).p).toBeGreaterThan(0.5);
    const skew = sampleRatio([5000, 5400], [0.5, 0.5]);
    expect(skew.statistic).toBeCloseTo(15.38, 1);
    expect(skew.p).toBeLessThan(0.001);
  });
});
