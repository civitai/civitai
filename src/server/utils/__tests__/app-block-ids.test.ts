import { describe, expect, it, vi } from 'vitest';
import {
  newAppBlockId,
  newAppListingModerationEventId,
  newAppListingReportId,
  newBlockInstanceId,
  newBlockUserSubscriptionId,
  newModelBlockInstallId,
} from '../app-block-ids';

describe('app-block-ids', () => {
  it('produces prefixed identifiers in the documented shape', () => {
    expect(newAppBlockId()).toMatch(/^ab_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newModelBlockInstallId()).toMatch(/^mbi_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newBlockInstanceId()).toMatch(/^bki_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newBlockUserSubscriptionId()).toMatch(/^bus_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newAppListingReportId()).toMatch(/^alrp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newAppListingModerationEventId()).toMatch(/^alme_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique ids on repeated calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newAppBlockId()));
    expect(ids.size).toBe(100);
  });

  it('embeds a time-sortable prefix so newer ids sort later (cross-ms)', () => {
    // Use fake timers so the test isn't flaky in CI. Cross-millisecond
    // ordering comes from the timestamp prefix.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-23T00:00:00.000Z'));
      const a = newAppBlockId();
      vi.setSystemTime(new Date('2026-05-23T00:00:00.005Z'));
      const b = newAppBlockId();
      expect(a < b).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is monotonic within a single millisecond', () => {
    // Within the same ms, the random suffix increments instead of being
    // regenerated. This is the spec.monotonic() property — without it,
    // two IDs minted in the same ms would sort in arbitrary order.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-23T00:00:00.000Z'));
      const ids = Array.from({ length: 50 }, () => newAppBlockId());
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i - 1] < ids[i]).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
