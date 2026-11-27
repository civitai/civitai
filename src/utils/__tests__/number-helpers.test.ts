import { describe, expect, it } from 'vitest';
import { abbreviateNumber, formatDuration } from '~/utils/number-helpers';

describe('formatDuration', () => {
  it('carries a seconds value that rounds up to 60 into the next minute', () => {
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(119.7)).toBe('2:00');
  });

  it('carries a rounded-up minute into the next hour', () => {
    expect(formatDuration(3599.5)).toBe('01:00:00');
  });

  it('rounds a fractional duration to the nearest second', () => {
    expect(formatDuration(12.4)).toBe('00:12');
    expect(formatDuration(83.5)).toBe('1:24');
  });

  it('keeps the existing whole-second output', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(42)).toBe('00:42');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(3725)).toBe('01:02:05');
  });
});

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
