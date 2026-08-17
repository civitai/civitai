import { describe, expect, it } from 'vitest';

import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The listing detail's "Details" accordion ROW MODEL (blocking `unit` project).
 *
 * The browser `component` project is not run by CI and loads no CSS, so nothing there
 * can be the gate for which rows exist, in what order, or whether the `preview`
 * posture drops the reviews row. That decision is pure, so it is pinned here.
 *
 * `formatDate` is INJECTED throughout — a fixed marker rather than the real dayjs
 * formatter — so these assertions are about ORDER and OMISSION and cannot go red on a
 * host timezone or a locale.
 */

const FIXED_DATE = '2026-03-04T05:06:07.000Z';
const fmt = (iso: string) => `formatted:${iso}`;

type Input = Parameters<typeof buildListingDetailRows>[0];

function detail(over: Partial<ListingDetail> = {}): Input {
  return {
    kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: true, liveUrl: 'https://a.civit.ai' },
    category: 'utility',
    contentRating: 'pg',
    // 431 up / 68 down → 0.8637 across 499 reviews (the 0.8–0.95 band, <500 bucket).
    // Distinct from `installCount` below and from every ladder constant.
    recommend: { recommendedCount: 431, notRecommendedCount: 68, recommendPct: 431 / 499 },
    reviewCount: 499,
    installCount: 4213,
    updatedAt: FIXED_DATE,
    ...over,
  } as Input;
}

const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe('buildListingDetailRows — order', () => {
  it('a fully-populated listing yields every row, in the fixed order', () => {
    expect(keys(buildListingDetailRows(detail(), { formatDate: fmt }))).toEqual([
      'kind',
      'category',
      'rating',
      'reviews',
      'installs',
      'updated',
    ]);
  });

  it('labels and values are the display strings, not the raw fields', () => {
    const rows = buildListingDetailRows(detail(), { formatDate: fmt });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.kind).toMatchObject({ label: 'Kind', value: 'On-site app' });
    expect(by.category).toMatchObject({ label: 'Category', value: 'utility' });
    expect(by.rating).toMatchObject({ label: 'Rating', value: 'pg' });
    // The SHARED ladder's word label plus the count, matching the model page's
    // "<label> (N)". Literal, not re-derived from `getRatingLabel`.
    expect(by.reviews).toMatchObject({ label: 'Reviews', value: 'Very Positive (499)', color: 'green' });
    // Thousands-separated, like every other public count on the site.
    expect(by.installs).toMatchObject({ label: 'Installs', value: '4,213' });
    // The injected formatter is what produced this — so the ROW is under test, not dayjs.
    expect(by.updated).toMatchObject({ label: 'Updated', value: `formatted:${FIXED_DATE}` });
  });

  it('the kind row names the sub-kind for both off-site shapes', () => {
    const connect = buildListingDetailRows(
      detail({
        kindData: { kind: 'offsite', subKind: 'connect', externalUrl: null, connectClientId: 'c1' },
      }),
      { formatDate: fmt }
    );
    expect(connect.find((r) => r.key === 'kind')?.value).toBe('Connect app');

    const link = buildListingDetailRows(
      detail({
        kindData: {
          kind: 'offsite',
          subKind: 'external-link',
          externalUrl: 'https://x.example',
          connectClientId: null,
        },
      }),
      { formatDate: fmt }
    );
    expect(link.find((r) => r.key === 'kind')?.value).toBe('Off-site link');
  });
});

describe('buildListingDetailRows — a null field OMITS its row (never renders a dash)', () => {
  it('POSITIVE CONTROL: both optional rows are present when their fields are set', () => {
    // The omission assertions below are zeros. Prove first that these keys CAN appear,
    // or "absent" would be indistinguishable from a builder that never emits them.
    const rows = keys(buildListingDetailRows(detail(), { formatDate: fmt }));
    expect(rows).toContain('category');
    expect(rows).toContain('rating');
  });

  it('a null category drops ONLY the category row', () => {
    const rows = keys(buildListingDetailRows(detail({ category: null }), { formatDate: fmt }));
    expect(rows).not.toContain('category');
    expect(rows).toEqual(['kind', 'rating', 'reviews', 'installs', 'updated']);
  });

  it('a null contentRating drops ONLY the rating row', () => {
    const rows = keys(buildListingDetailRows(detail({ contentRating: null }), { formatDate: fmt }));
    expect(rows).not.toContain('rating');
    expect(rows).toEqual(['kind', 'category', 'reviews', 'installs', 'updated']);
  });

  it('both null → the three always-present rows remain', () => {
    const rows = keys(
      buildListingDetailRows(detail({ category: null, contentRating: null }), { formatDate: fmt })
    );
    expect(rows).toEqual(['kind', 'reviews', 'installs', 'updated']);
  });

  it('a zero installCount still renders — 0 installs is a fact, not an absent field', () => {
    const rows = buildListingDetailRows(detail({ installCount: 0 }), { formatDate: fmt });
    expect(keys(rows)).toContain('installs');
    expect(rows.find((r) => r.key === 'installs')?.value).toBe('0');
  });
});

describe('buildListingDetailRows — the reviews row', () => {
  it('no reviews → the honest "No reviews yet", NOT the ladder\'s zero-rating verdict', () => {
    // 🔴 The trap this pins: `getRatingLabel({positiveRating: 0, totalCount: 0})`
    // returns `Mixed` — a verdict about an app nobody has reviewed. The zero case must
    // short-circuit before the ladder.
    const rows = buildListingDetailRows(
      detail({
        recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
        reviewCount: 0,
      }),
      { formatDate: fmt }
    );
    const reviews = rows.find((r) => r.key === 'reviews');
    expect(reviews?.value).toBe('No reviews yet');
    expect(reviews?.value).not.toContain('Mixed');
    // No verdict → no verdict colour.
    expect(reviews?.color).toBeUndefined();
  });

  it('a non-null pct with a zero reviewCount also takes the no-reviews branch', () => {
    // Defensive: the two fields come from one rollup but are separate scalars, and a
    // `0/0` metric row could produce a pct without a count.
    const rows = buildListingDetailRows(
      detail({
        recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: 0 },
        reviewCount: 0,
      }),
      { formatDate: fmt }
    );
    expect(rows.find((r) => r.key === 'reviews')?.value).toBe('No reviews yet');
  });

  it('a low rating carries the ladder\'s own colour, not a hardcoded green', () => {
    const rows = buildListingDetailRows(
      detail({
        recommend: { recommendedCount: 4, notRecommendedCount: 133, recommendPct: 4 / 137 },
        reviewCount: 137,
      }),
      { formatDate: fmt }
    );
    expect(rows.find((r) => r.key === 'reviews')).toMatchObject({
      value: 'Very Negative (137)',
      color: 'red',
    });
  });
});

describe('🔴 buildListingDetailRows — the `preview` posture', () => {
  it('POSITIVE CONTROL: the reviews row IS present in the live posture', () => {
    // Same fixture, `preview` unset. Without this the omission below is a zero from a
    // builder that might never emit the row at all.
    expect(keys(buildListingDetailRows(detail(), { formatDate: fmt }))).toContain('reviews');
  });

  it('preview OMITS the reviews row (a shadow listing has none) and keeps the rest', () => {
    const rows = keys(buildListingDetailRows(detail(), { preview: true, formatDate: fmt }));
    expect(rows).not.toContain('reviews');
    expect(rows).toEqual(['kind', 'category', 'rating', 'installs', 'updated']);
  });

  it('preview: false is byte-identical to omitting the flag', () => {
    expect(buildListingDetailRows(detail(), { preview: false, formatDate: fmt })).toEqual(
      buildListingDetailRows(detail(), { formatDate: fmt })
    );
  });
});
