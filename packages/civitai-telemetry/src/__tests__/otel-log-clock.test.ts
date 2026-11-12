import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_CLOCK_HOLD_MS, nextOtelLogTimestamp, resetOtelLogClock } from '../otel-logs';

// Unit tests for the bridge's timestamp source. The end-to-end regression (two identical
// records in one millisecond leave the process with different timestamps) lives in
// otel-logs.test.ts, under "emitOtelLog — timestamps".

beforeEach(() => {
  resetOtelLogClock();
});

describe('nextOtelLogTimestamp', () => {
  it('keeps the wall-clock millisecond and puts a sequence number in the sub-millisecond part', () => {
    const now = () => 1_700_000_000_123;
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 123_000_000]);
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 123_000_001]);
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 123_000_002]);
  });

  it('resets the sequence when the wall clock moves forward', () => {
    let ms = 1_700_000_000_123;
    const now = () => ms;
    nextOtelLogTimestamp(now);
    nextOtelLogTimestamp(now);
    ms = 1_700_000_000_124;
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 124_000_000]);
  });

  it('carries the millisecond into the seconds part correctly at a second boundary', () => {
    expect(nextOtelLogTimestamp(() => 1_700_000_000_999)).toEqual([1_700_000_000, 999_000_000]);
    expect(nextOtelLogTimestamp(() => 1_700_000_001_000)).toEqual([1_700_000_001, 0]);
  });

  it('never repeats or goes backwards when the wall clock steps BACK', () => {
    let ms = 1_700_000_000_124;
    const now = () => ms;
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 124_000_000]);
    ms = 1_700_000_000_123; // NTP step back by 1 ms
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 124_000_001]);
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 124_000_002]);
    ms = 1_700_000_000_125; // wall clock passes the held millisecond again
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 125_000_000]);
  });

  it('borrows the next millisecond instead of wrapping after 1,000,000 records in one millisecond', () => {
    const now = () => 1_700_000_000_123;
    let last: [number, number] = [0, 0];
    for (let i = 0; i < 1_000_000; i++) last = nextOtelLogTimestamp(now) as [number, number];
    expect(last).toEqual([1_700_000_000, 123_999_999]);
    // The 1,000,001st must not wrap to 123_000_000, which was already issued.
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 124_000_000]);
  });

  it('resyncs to the wall clock after a backward step larger than MAX_CLOCK_HOLD_MS', () => {
    expect(MAX_CLOCK_HOLD_MS).toBe(1000);
    let ms = 1_700_000_005_124;
    const now = () => ms;
    nextOtelLogTimestamp(now);
    ms = 1_700_000_004_124; // exactly the cap: still held
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_005, 124_000_001]);
    ms = 1_700_000_000_123; // 5 s back: resync rather than stamp 5 s in the future
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 123_000_000]);
    expect(nextOtelLogTimestamp(now)).toEqual([1_700_000_000, 123_000_001]);
  });

  it('reads Date.now() when no clock is injected', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(4_102_444_800_456);
    try {
      expect(nextOtelLogTimestamp()).toEqual([4_102_444_800, 456_000_000]);
    } finally {
      spy.mockRestore();
    }
  });
});
