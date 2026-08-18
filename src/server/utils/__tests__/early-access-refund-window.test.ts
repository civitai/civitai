import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EARLY_ACCESS_REFUND_WINDOW_MONTHS,
  isWithinEarlyAccessRefundWindow,
} from '~/server/utils/early-access-helpers';
import { EARLY_ACCESS_CONFIG } from '~/server/common/constants';

const NOW = new Date('2026-01-15T12:00:00.000Z');
const CUTOFF = new Date('2025-10-15T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('isWithinEarlyAccessRefundWindow', () => {
  it('still owes a refund one millisecond before the window closes', () => {
    expect(isWithinEarlyAccessRefundWindow(new Date(CUTOFF.getTime() + 1), NOW)).toBe(true);
  });

  it('owes nothing once the version is exactly the window old', () => {
    expect(isWithinEarlyAccessRefundWindow(CUTOFF, NOW)).toBe(false);
  });

  it('compares timestamps, not calendar dates', () => {
    // Published later in the DAY than `now`, three calendar months back: a date-only comparison
    // reads this as three months old and exempts it, six hours before it actually is.
    expect(isWithinEarlyAccessRefundWindow(new Date('2025-10-15T18:00:00.000Z'), NOW)).toBe(true);
    expect(isWithinEarlyAccessRefundWindow(new Date('2025-10-15T06:00:00.000Z'), NOW)).toBe(false);
  });

  it('keeps owing a refund for a version that never published', () => {
    expect(isWithinEarlyAccessRefundWindow(null, NOW)).toBe(true);
  });

  it('defaults `now` to the current time rather than exempting everything', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(isWithinEarlyAccessRefundWindow(new Date(CUTOFF.getTime() + 1))).toBe(true);
    expect(isWithinEarlyAccessRefundWindow(new Date(CUTOFF.getTime() - 1))).toBe(false);
  });

  it('leaves room for the longest early access window a creator can buy', () => {
    const longestEarlyAccessDays = Math.max(...EARLY_ACCESS_CONFIG.timeframeValues);
    expect(longestEarlyAccessDays).toBeLessThan(EARLY_ACCESS_REFUND_WINDOW_MONTHS * 28);
  });
});
