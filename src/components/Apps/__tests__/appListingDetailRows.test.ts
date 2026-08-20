import { describe, expect, it } from 'vitest';

import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The listing detail's "Details" accordion ROW MODEL (blocking `unit` project).
 *
 * The browser `component` project is not run by CI and loads no CSS, so nothing there
 * can be the gate for which rows exist, in what order, or which rows the `preview`
 * posture drops. That decision is pure, so it is pinned here.
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
    expect(by.reviews).toMatchObject({
      label: 'Reviews',
      value: 'Very Positive (499)',
      color: 'green',
    });
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
    // 🔴 And the discriminator: `0` must NOT take the same path as `undefined` below.
    // A `if (detail.installCount)` truthiness guard would drop this row, which is the
    // most likely way the runtime guard gets written wrong.
    expect(rows.find((r) => r.key === 'installs')?.value).not.toBe(undefined);
  });

  /**
   * 🔴 REGRESSION, not an invariant guard — this one was RED before the fix, on a real
   * crash. `updatedAt` and `installCount` are declared REQUIRED on `ListingDetail`, but
   * the moderator combined-review surface builds a `ListingDetail`-shaped object
   * DIRECTLY, through a cast, rather than via `projectListingDetail`. The first version
   * of this builder called `detail.installCount.toLocaleString()` unconditionally; on
   * that producer it threw, and because a crashing child unmounts its ancestors the
   * whole review modal rendered as an empty `<body>`.
   *
   * The rule: a details row is DECORATION and must never be able to blank the page it
   * decorates. An absent field is treated exactly like a null one — omit the row.
   */
  describe('🔴 a field that is ABSENT at runtime (a cast producer) omits its row, never throws', () => {
    it('POSITIVE CONTROL: both rows are present when the fields are supplied', () => {
      const rows = keys(buildListingDetailRows(detail(), { formatDate: fmt }));
      expect(rows).toContain('installs');
      expect(rows).toContain('updated');
    });

    it('a missing installCount omits the installs row instead of throwing', () => {
      const cast = { ...detail() } as Record<string, unknown>;
      delete cast.installCount;
      const rows = keys(buildListingDetailRows(cast as Input, { formatDate: fmt }));
      expect(rows).not.toContain('installs');
      expect(rows).toEqual(['kind', 'category', 'rating', 'reviews', 'updated']);
    });

    it('a missing updatedAt omits the updated row instead of formatting `undefined` as today', () => {
      // Formatting `undefined` through dayjs yields TODAY — a confident, wrong date on
      // a moderator's screen. Omission is the honest answer.
      const cast = { ...detail() } as Record<string, unknown>;
      delete cast.updatedAt;
      const rows = keys(buildListingDetailRows(cast as Input, { formatDate: fmt }));
      expect(rows).not.toContain('updated');
      expect(rows).toEqual(['kind', 'category', 'rating', 'reviews', 'installs']);
    });

    it('BOTH missing — the panel still builds, with the rows it can', () => {
      const cast = { ...detail() } as Record<string, unknown>;
      delete cast.installCount;
      delete cast.updatedAt;
      expect(() => buildListingDetailRows(cast as Input, { formatDate: fmt })).not.toThrow();
      expect(keys(buildListingDetailRows(cast as Input, { formatDate: fmt }))).toEqual([
        'kind',
        'category',
        'rating',
        'reviews',
      ]);
    });
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

  it("a low rating carries the ladder's own colour, not a hardcoded green", () => {
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
  it('POSITIVE CONTROL: reviews, installs and updated ARE present in the live posture', () => {
    // Same fixture, `preview` unset. Without this the omissions below are zeros from a
    // builder that might never emit those rows at all.
    const live = keys(buildListingDetailRows(detail(), { formatDate: fmt }));
    expect(live).toContain('reviews');
    expect(live).toContain('installs');
    expect(live).toContain('updated');
  });

  it('preview OMITS reviews / installs / updated and keeps exactly the honest rows', () => {
    const rows = keys(buildListingDetailRows(detail(), { preview: true, formatDate: fmt }));
    expect(rows).not.toContain('reviews');
    expect(rows).not.toContain('installs');
    expect(rows).not.toContain('updated');
    expect(rows).toEqual(['kind', 'category', 'rating']);
  });

  /**
   * 🔴 INSTALLS — asserted on the ROW, not on a word.
   *
   * `buildListingStatChips` already returns NO chips in preview, with a docstring
   * saying the reason is that a zero would read as a measured fact about an app nobody
   * could yet have installed. The rail then rendered `Installs: 0` anyway. The rule is
   * one rule; this pins that the rail obeys it too.
   *
   * The assertion is the ABSENCE OF THE ROW OBJECT plus the absence of any row whose
   * rendered value is the zero string — not "the DOM does not contain '0'", which any
   * other number on the page can spell.
   */
  it('🔴 preview renders NO installs row — not even the zero one', () => {
    const zeroed = detail({ installCount: 0 });
    // Control: with `preview` unset the zero really does render, so the omission below
    // is about the posture and not about a builder that drops zeros generally.
    const live = buildListingDetailRows(zeroed, { formatDate: fmt });
    expect(live.find((r) => r.key === 'installs')).toMatchObject({
      label: 'Installs',
      value: '0',
    });

    const rows = buildListingDetailRows(zeroed, { preview: true, formatDate: fmt });
    expect(rows.find((r) => r.key === 'installs')).toBeUndefined();
    // …and no OTHER row smuggles the count in under a different key.
    expect(rows.map((r) => r.value)).not.toContain('0');
    expect(rows.map((r) => r.label)).not.toContain('Installs');
  });

  /**
   * 🔴 UPDATED — the mislabelled-submission-date row.
   *
   * In preview the `updatedAt` a `ListingDetail` carries is not necessarily
   * `app_listings.updated_at`: `buildListingDetailPreview` has no such field and
   * substitutes the publish request's SUBMISSION time. The row rendered it as
   * "Updated: <submission date>". `AppListingDetailBody` already omits its header meta
   * line in preview for exactly this reason; the rail now agrees.
   *
   * Asserted on the row's rendered VALUE — the formatted date string is pinned absent,
   * so a row that came back under a different key or label would still fail.
   */
  it('🔴 preview renders NO updated row, so no date reaches the screen under that label', () => {
    // Control: the live posture DOES render the formatted date.
    const live = buildListingDetailRows(detail(), { formatDate: fmt });
    expect(live.find((r) => r.key === 'updated')).toMatchObject({
      label: 'Updated',
      value: `formatted:${FIXED_DATE}`,
    });

    const rows = buildListingDetailRows(detail(), { preview: true, formatDate: fmt });
    expect(rows.find((r) => r.key === 'updated')).toBeUndefined();
    expect(rows.map((r) => r.value)).not.toContain(`formatted:${FIXED_DATE}`);
    expect(rows.map((r) => r.label)).not.toContain('Updated');
  });

  it('🔴 preview never calls the date formatter at all', () => {
    // Stronger than "no row": if the formatter is never invoked, no formatted date can
    // exist to be rendered by any future row. A spy, not a string search.
    const calls: string[] = [];
    const spy = (iso: string) => {
      calls.push(iso);
      return `formatted:${iso}`;
    };
    // Positive control first — the spy DOES fire in the live posture.
    buildListingDetailRows(detail(), { formatDate: spy });
    expect(calls).toEqual([FIXED_DATE]);

    calls.length = 0;
    buildListingDetailRows(detail(), { preview: true, formatDate: spy });
    expect(calls).toEqual([]);
  });

  it('preview: false is byte-identical to omitting the flag', () => {
    expect(buildListingDetailRows(detail(), { preview: false, formatDate: fmt })).toEqual(
      buildListingDetailRows(detail(), { formatDate: fmt })
    );
  });
});
