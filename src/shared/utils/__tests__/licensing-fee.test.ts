import { describe, expect, it } from 'vitest';
import { feeToRatio, formatFeeCadence } from '@civitai/buzz';

describe('feeToRatio', () => {
  it.each([
    [1, { buzz: 1, images: 1 }],
    [0.1, { buzz: 1, images: 10 }],
    [0.5, { buzz: 5, images: 10 }],
    [0.05, { buzz: 1, images: 20 }],
    [0.01, { buzz: 1, images: 100 }],
    [2.5, { buzz: 25, images: 10 }],
  ])('maps per-image %p to the smallest whole-number ratio', (perImage, expected) => {
    expect(feeToRatio(perImage)).toEqual(expected);
  });

  it('treats null / zero / negative as off', () => {
    expect(feeToRatio(null).buzz).toBe(0);
    expect(feeToRatio(0).buzz).toBe(0);
    expect(feeToRatio(-1).buzz).toBe(0);
  });
});

describe('formatFeeCadence', () => {
  it('singularizes a per-1 cadence', () => {
    expect(formatFeeCadence(1)).toBe('per generation');
  });
  it('pluralizes multi-unit cadences', () => {
    expect(formatFeeCadence(10)).toBe('per 10 generations');
    expect(formatFeeCadence(100)).toBe('per 100 generations');
  });
});
