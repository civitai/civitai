import { describe, expect, it } from 'vitest';

import { clampToColumn } from '~/server/clickhouse/tracker';

/**
 * `pageViews` was the last table still losing rows to the ClickHouse tracker's silent
 * client-side rejection, and unlike the six enum gaps before it the cause was INTEGER
 * WIDTH OVERFLOW: a value too large for its column destroys the whole row while the
 * fire-and-forget POST still reports success.
 *
 * 🔴 The expectations here are LITERAL, taken from the production rows that were actually
 * rejected (read out of the dead-letter queue on 2026-09-08) and from the ClickHouse type
 * bounds — never derived from the implementation they test.
 */

const UINT32_MAX = 4_294_967_295;
const INT16_MAX = 32_767;

describe('clampToColumn', () => {
  it('passes through a value the column can hold', () => {
    expect(clampToColumn(13_178, UINT32_MAX)).toBe(13_178);
    expect(clampToColumn(1_920, INT16_MAX)).toBe(1_920);
  });

  it('accepts the exact ceiling unchanged', () => {
    // The off-by-one that would matter in the SAFE direction: clamping the boundary
    // itself would corrupt legitimate maximum values on every row.
    expect(clampToColumn(UINT32_MAX, UINT32_MAX)).toBe(UINT32_MAX);
    expect(clampToColumn(INT16_MAX, INT16_MAX)).toBe(INT16_MAX);
  });

  it('clamps one past the ceiling', () => {
    // The other half of the pair. Together these two pin the boundary exactly; either
    // alone is satisfied by an implementation off by one.
    expect(clampToColumn(UINT32_MAX + 1, UINT32_MAX)).toBe(UINT32_MAX);
    expect(clampToColumn(INT16_MAX + 1, INT16_MAX)).toBe(INT16_MAX);
  });

  describe('the real rejected production values', () => {
    // Each of these destroyed a real pageViews row. Pinning the actual numbers means a
    // regression is reported in the terms of the incident, not as an abstract bound.
    const rejectedDurations = [
      4_323_369_542, // smallest observed overflow — only 0.66% over the ceiling
      4_742_447_225,
      5_271_443_941,
      12_434_883_238, // largest observed — ~2.9x the ceiling
    ];
    it.each(rejectedDurations)('duration %d becomes the UInt32 ceiling', (value: number) => {
      expect(value).toBeGreaterThan(UINT32_MAX); // the fixture is genuinely a violation
      expect(clampToColumn(value, UINT32_MAX)).toBe(UINT32_MAX);
    });

    const rejectedDimensions = [51_600, 100_000, 102_000, 183_800, 211_900];
    it.each(rejectedDimensions)(
      'window dimension %d becomes the Int16 ceiling',
      (value: number) => {
        expect(value).toBeGreaterThan(INT16_MAX);
        expect(clampToColumn(value, INT16_MAX)).toBe(INT16_MAX);
      }
    );
  });

  it('collapses non-finite input to 0 rather than emitting NaN', () => {
    // NaN would be rejected by the integer column exactly like an oversized value, so
    // letting it through would leave the row-destroying bug in place for a new input.
    //
    // +Infinity deliberately becomes 0, NOT the ceiling. Saturating it would assert
    // "the longest duration the column can express", which is a measurement claim; a
    // non-finite input is a broken measurement, and 0 reads as "no data" instead of
    // silently manufacturing a maximum. Pinned so the choice cannot drift unnoticed.
    expect(clampToColumn(Number.NaN, UINT32_MAX)).toBe(0);
    expect(clampToColumn(Number.POSITIVE_INFINITY, UINT32_MAX)).toBe(0);
    expect(clampToColumn(Number.NEGATIVE_INFINITY, UINT32_MAX)).toBe(0);
  });

  it('collapses negatives to 0 — the unsigned column cannot hold them', () => {
    expect(clampToColumn(-1, UINT32_MAX)).toBe(0);
    expect(clampToColumn(-99_999, INT16_MAX)).toBe(0);
  });

  it('truncates a non-integer', () => {
    expect(clampToColumn(1_920.75, INT16_MAX)).toBe(1_920);
  });
});
