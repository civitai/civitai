import { describe, expect, it } from 'vitest';
import {
  BLOCK_EVENT_RATE_BURST,
  BLOCK_EVENT_RATE_MAX_KEYS,
  BLOCK_EVENT_RATE_PER_SECOND,
  createBlockEventRateLimiter,
} from '../block-event-rate-limit';
import { BLOCK_EVENT_BATCH_MAX } from '~/server/schema/track.schema';

const T0 = 1_700_000_000_000;

describe('block-event rate limiter', () => {
  it('grants up to the burst, then nothing', () => {
    const limiter = createBlockEventRateLimiter({ burst: 7, perSecond: 3 });
    expect(limiter.take('k', 5, T0)).toBe(5);
    expect(limiter.take('k', 5, T0)).toBe(2);
    expect(limiter.take('k', 5, T0)).toBe(0);
  });

  it('refills at the sustained rate and never past the burst', () => {
    const limiter = createBlockEventRateLimiter({ burst: 7, perSecond: 3 });
    expect(limiter.take('k', 7, T0)).toBe(7);
    expect(limiter.take('k', 100, T0 + 999)).toBe(2);
    expect(limiter.take('k', 100, T0 + 999)).toBe(0);
    // A long idle period refills to the burst, not beyond it.
    expect(limiter.take('k', 100, T0 + 3_600_000)).toBe(7);
  });

  it('keeps separate budgets per key', () => {
    const limiter = createBlockEventRateLimiter({ burst: 4, perSecond: 1 });
    expect(limiter.take('a', 4, T0)).toBe(4);
    expect(limiter.take('a', 1, T0)).toBe(0);
    expect(limiter.take('b', 3, T0)).toBe(3);
  });

  it('does not mint tokens when the clock steps backwards', () => {
    const limiter = createBlockEventRateLimiter({ burst: 4, perSecond: 1 });
    expect(limiter.take('k', 4, T0)).toBe(4);
    expect(limiter.take('k', 4, T0 - 60_000)).toBe(0);
    // Nor when it steps forward again to where it was: no real time has passed.
    expect(limiter.take('k', 4, T0)).toBe(0);
    expect(limiter.take('k', 4, T0 + 2_000)).toBe(2);
  });

  it('never holds more than maxKeys buckets under a key flood', () => {
    const limiter = createBlockEventRateLimiter({ burst: 2, perSecond: 1, maxKeys: 37 });
    for (let i = 0; i < 5_000; i += 1) limiter.take(`flood-${i}`, 1, T0);
    expect(limiter.size()).toBe(37);
  });

  it('evicts the LEAST RECENTLY USED bucket, so an active key keeps its spent state', () => {
    const limiter = createBlockEventRateLimiter({ burst: 2, perSecond: 0, maxKeys: 3 });
    expect(limiter.take('active', 2, T0)).toBe(2);
    limiter.take('x1', 1, T0);
    expect(limiter.take('active', 1, T0)).toBe(0);
    limiter.take('x2', 1, T0);
    limiter.take('x3', 1, T0);
    // `x1` was the oldest untouched key and is the one that went; `active` is still spent.
    expect(limiter.size()).toBe(3);
    expect(limiter.take('active', 1, T0)).toBe(0);
    // An evicted key comes back with a full bucket: the accuracy the cap gives up.
    expect(limiter.take('x1', 2, T0)).toBe(2);
  });

  it('by default admits one client spending its whole planned page budget', () => {
    // A burst below one batch would drop rows from a well-formed batch.
    expect(BLOCK_EVENT_RATE_BURST).toBeGreaterThanOrEqual(BLOCK_EVENT_BATCH_MAX);
    expect(BLOCK_EVENT_RATE_PER_SECOND).toBeGreaterThan(0);
    expect(BLOCK_EVENT_RATE_MAX_KEYS).toBeGreaterThan(1_000);
    const limiter = createBlockEventRateLimiter();
    // 500 events at 10 a second, flushed as full batches every 5 seconds.
    let granted = 0;
    for (let batch = 0; batch < 10; batch += 1)
      granted += limiter.take('k', 50, T0 + batch * 5_000);
    expect(granted).toBe(500);
    // And a caller far over that budget is cut off.
    const flood = createBlockEventRateLimiter();
    let floodGranted = 0;
    for (let i = 0; i < 100; i += 1) floodGranted += flood.take('k', 50, T0 + i * 10);
    // The burst (100) plus 990 ms of refill at 10 a second.
    expect(floodGranted).toBe(109);
  });
});
