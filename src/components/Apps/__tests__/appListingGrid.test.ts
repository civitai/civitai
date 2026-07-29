import { describe, expect, test } from 'vitest';
import { LISTING_GRID_SPAN, LISTING_STORE_CONTAINER_SIZE } from '~/components/Apps/appListingGrid';

/**
 * `/apps` store GEOMETRY pins (blocking `unit` project).
 *
 * The product feedback was "make app cover images larger — fewer columns per
 * row?". The implementation answer is a ONE-breakpoint change (xl 2.4 → 3, i.e.
 * five columns → four) plus a responsive 16:9 cover in `AppListingCard` — with
 * the CONTAINER WIDTH LEFT ALONE. All three halves of that statement are pinned
 * here so a later tweak can't quietly re-narrow the cards or widen the page.
 */
describe('LISTING_GRID_SPAN', () => {
  test('xl yields FOUR columns (span 3 of 12) — the larger-cover change', () => {
    expect(LISTING_GRID_SPAN.xl).toBe(3);
    expect(12 / LISTING_GRID_SPAN.xl).toBe(4);
  });

  test('base / sm / md / lg are UNCHANGED (1 / 2 / 3 / 4 columns)', () => {
    expect(LISTING_GRID_SPAN.base).toBe(12);
    expect(LISTING_GRID_SPAN.sm).toBe(6);
    expect(LISTING_GRID_SPAN.md).toBe(4);
    expect(LISTING_GRID_SPAN.lg).toBe(3);
    expect(12 / LISTING_GRID_SPAN.base).toBe(1);
    expect(12 / LISTING_GRID_SPAN.sm).toBe(2);
    expect(12 / LISTING_GRID_SPAN.md).toBe(3);
    expect(12 / LISTING_GRID_SPAN.lg).toBe(4);
  });

  test('every breakpoint is a whole-column span (no fractional 2.4-style spans)', () => {
    // The old `xl: 2.4` was the only fractional span; dropping it means every
    // breakpoint now divides 12 evenly, so no row ever ends on a part-column.
    for (const [bp, span] of Object.entries(LISTING_GRID_SPAN)) {
      expect(Number.isInteger(span), `${bp} span should be a whole number`).toBe(true);
      expect(12 % span, `${bp} span should divide 12`).toBe(0);
    }
  });

  test('the span set is exactly the five expected breakpoints', () => {
    expect(Object.keys(LISTING_GRID_SPAN).sort()).toEqual(['base', 'lg', 'md', 'sm', 'xl']);
  });
});

describe('LISTING_STORE_CONTAINER_SIZE', () => {
  test('the store container width is UNTOUCHED at 1600', () => {
    // The extra card width comes from the column-count drop, NOT from widening
    // the page. If this ever changes, the grid span above must be re-derived.
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(1600);
  });
});
