import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAID_ACCESS_REFUND_WINDOW_DAYS,
  isWithinPaidAccessRefundWindow,
  paidAccessRefundWindowEnd,
} from '~/server/utils/early-access-helpers';

const NOW = new Date('2026-01-15T12:00:00.000Z');
const CUTOFF = new Date('2025-12-16T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('isWithinPaidAccessRefundWindow', () => {
  it('lands the boundary exactly one window after the purchase', () => {
    expect(paidAccessRefundWindowEnd(CUTOFF).toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });

  it('still owes a refund one millisecond before the window closes', () => {
    expect(isWithinPaidAccessRefundWindow(new Date(CUTOFF.getTime() + 1), NOW)).toBe(true);
  });

  it('owes nothing once the purchase is exactly the window old', () => {
    expect(isWithinPaidAccessRefundWindow(CUTOFF, NOW)).toBe(false);
  });

  it('compares timestamps, not calendar dates', () => {
    // Bought later in the DAY than `now`, a full window back: a date-only comparison reads this as
    // 30 days old and strands the buyer six hours before their window is actually up.
    expect(isWithinPaidAccessRefundWindow(new Date('2025-12-16T18:00:00.000Z'), NOW)).toBe(true);
    expect(isWithinPaidAccessRefundWindow(new Date('2025-12-16T06:00:00.000Z'), NOW)).toBe(false);
  });

  it('holds the boundary across a DST change rather than moving it an hour', () => {
    // Days, unlike months, are a fixed span — but only if the arithmetic doesn't go through local
    // calendar days. A window spanning a DST change must still be exactly 30 * 24 hours.
    const original = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const bought = new Date('2025-10-20T12:00:00.000Z');
      const end = paidAccessRefundWindowEnd(bought);
      expect(end.getTime() - bought.getTime()).toBe(PAID_ACCESS_REFUND_WINDOW_DAYS * 24 * 3600_000);
    } finally {
      process.env.TZ = original;
    }
  });

  it('keeps owing a refund for a purchase with no recorded date', () => {
    expect(isWithinPaidAccessRefundWindow(null, NOW)).toBe(true);
  });

  it('defaults `now` to the current time rather than exempting everything', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(isWithinPaidAccessRefundWindow(new Date(CUTOFF.getTime() + 1))).toBe(true);
    expect(isWithinPaidAccessRefundWindow(new Date(CUTOFF.getTime() - 1))).toBe(false);
  });
});
