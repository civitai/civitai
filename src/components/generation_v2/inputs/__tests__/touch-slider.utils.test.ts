import { describe, expect, it } from 'vitest';
import {
  ratioOf,
  snapToStep,
  valueAtRatio,
} from '~/components/generation_v2/inputs/touch-slider.utils';

const loraStrength = { min: -1, max: 2, step: 0.05 };

describe('snapToStep', () => {
  it('returns clean decimals for fractional steps', () => {
    // 0.7 is 34 steps of 0.05 from -1; naive float maths gives 0.7000000000000002.
    expect(snapToStep(0.71, loraStrength)).toBe(0.7);
    expect(snapToStep(0.38, loraStrength)).toBe(0.4);
  });

  it('counts steps from the minimum, not from zero', () => {
    // Quantity under the 2-for-1 bonus runs 2, 4, 6…; 5 must not snap to an odd number.
    expect(snapToStep(5, { min: 2, max: 12, step: 2 })).toBe(6);
    expect(snapToStep(1, { min: 0.25, max: 2, step: 0.5 })).toBe(1.25);
  });

  it('clamps to the range', () => {
    expect(snapToStep(9, loraStrength)).toBe(2);
    expect(snapToStep(-9, loraStrength)).toBe(-1);
  });
});

describe('valueAtRatio and ratioOf', () => {
  it('maps the ends of the track to the ends of the range', () => {
    expect(valueAtRatio(0, loraStrength)).toBe(-1);
    expect(valueAtRatio(1, loraStrength)).toBe(2);
    expect(valueAtRatio(1.4, loraStrength)).toBe(2);
  });

  it('round-trips a value through its track position', () => {
    const cfg = { min: 1, max: 15, step: 0.5 };
    expect(valueAtRatio(ratioOf(7, cfg), cfg)).toBe(7);
  });

  it('puts a degenerate range at the start of the track', () => {
    expect(ratioOf(3, { min: 3, max: 3 })).toBe(0);
  });
});
