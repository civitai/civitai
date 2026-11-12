import { beforeEach, describe, expect, it } from 'vitest';

import { nextOtelLogTimestamp, resetOtelLogClock } from '../otel-logs';

// Unit tests for the bridge's timestamp source. The end-to-end regression (two identical
// records in one millisecond leave the process with different timestamps) lives in
// otel-logs.test.ts, under "emitOtelLog — timestamps".
//
// Fixture instants have pairwise-distinct millisecond parts (123, 124, 999) so that a
// mutant which hardcodes one of them, or drops the millisecond part, gives a wrong
// expected tuple.

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

  it('reads Date.now() when no clock is injected', () => {
    const before = Date.now();
    const [seconds, nanos] = nextOtelLogTimestamp();
    const stampedMs = seconds * 1000 + Math.floor(nanos / 1_000_000);
    expect(stampedMs).toBeGreaterThanOrEqual(before);
    expect(stampedMs).toBeLessThanOrEqual(Date.now());
  });
});
