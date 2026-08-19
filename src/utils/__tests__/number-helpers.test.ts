import { describe, expect, it } from 'vitest';
import { abbreviateNumber } from '~/utils/number-helpers';

describe('abbreviateNumber', () => {
  it('floors at the requested precision instead of at whole units', () => {
    expect(abbreviateNumber(10_600_000, { floor: true, decimals: 1 })).toBe('10.6m');
    expect(abbreviateNumber(10_699_999, { floor: true, decimals: 1 })).toBe('10.6m');
  });

  it('still floors to whole units when no decimals are requested', () => {
    expect(abbreviateNumber(10_600_000, { floor: true })).toBe('10m');
  });

  it('floors from the undivided value, so no tick is lost to float error', () => {
    expect(abbreviateNumber(1130, { floor: true, decimals: 2 })).toBe('1.13k');
    expect(abbreviateNumber(1_130_000, { floor: true, decimals: 2 })).toBe('1.13m');
  });

  it('never reads higher than the true value, in either direction', () => {
    expect(abbreviateNumber(10_990_000, { floor: true, decimals: 1 })).toBe('10.9m');
    // Floored toward negative infinity: a debt must not render as less debt.
    expect(abbreviateNumber(-10_690_000, { floor: true, decimals: 1 })).toBe('-10.7m');
  });

  it('leaves the rounding path alone', () => {
    expect(abbreviateNumber(10_690_000)).toBe('10.7m');
    expect(abbreviateNumber(-10_690_000)).toBe('-10.7m');
  });
});
