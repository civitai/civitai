import { describe, expect, it } from 'vitest';

import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import {
  buildListingCardPreview,
  buildListingDetailPreview,
} from '~/components/Apps/reviewListingPreview';
import type { OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';

/**
 * Pure mapping gate for the mod-review listing PREVIEW builders (Item 3): review row
 * → `ListingCard` / `ListingDetail` store shapes. The browser component test for the
 * preview surface is report-only, so this is the blocking coverage for the mapping.
 * Pins: kind derivation, the name→slug fallback, submitter→creator chip, empty
 * recommend rollup, placeholder-nulled image URLs (not resolvable on this surface),
 * the omitted-in-preview scalars (tagline/description/serialId), kind-aware
 * `kindData`, and the optional resolved-images passthrough.
 */

function row(over: Partial<OffsitePendingRow> & { id: string }): OffsitePendingRow {
  return {
    id: over.id,
    appListingId: 'apl_1',
    slug: 'my-app',
    status: 'pending',
    submittedAt: '2026-01-01T00:00:00Z',
    changelog: null,
    appListing: {
      name: 'My App',
      externalUrl: null,
      category: 'utility',
      contentRating: 'PG',
    },
    submittedBy: { id: 7, username: 'alice', image: 'img-key' },
    ...over,
  };
}

describe('buildListingCardPreview', () => {
  it('maps an on-site listing-media row into an on-site card with placeholder art', () => {
    const card = buildListingCardPreview(row({ id: 'r1', kind: 'onsite' }));
    expect(card.kind).toBe('onsite');
    expect(card.name).toBe('My App');
    expect(card.category).toBe('utility');
    expect(card.contentRating).toBe('PG');
    expect(card.creator).toEqual({ id: 7, username: 'alice', image: 'img-key' });
    // Image URLs aren't resolvable on the mod-review surface → null (placeholder art).
    expect(card.iconUrl).toBeNull();
    expect(card.coverUrl).toBeNull();
    // No reviews on an unapproved listing.
    expect(card.recommend.recommendPct).toBeNull();
    expect(card.reviewCount).toBe(0);
    expect(card.kindData).toEqual({
      kind: 'onsite',
      appBlockId: null,
      hasPage: false,
      liveUrl: '',
    });
  });

  it('an external (offsite) row → offsite kindData with the external url, no sub-kind', () => {
    const card = buildListingCardPreview(
      row({
        id: 'r2',
        appListing: {
          name: 'Ext',
          externalUrl: 'https://ext.app',
          category: null,
          contentRating: null,
        },
      })
    );
    expect(card.kind).toBe('offsite');
    expect(card.kindData).toEqual({
      kind: 'offsite',
      externalUrl: 'https://ext.app',
    });
  });

  /**
   * 🔴 The moderator preview is a SECOND producer of `ListingCardKindData` — it
   * builds the DTO by hand from a review row rather than through
   * `projectListingCard`, and it carried its OWN copy of the sub-kind
   * derivation. Both copies are gone, so the preview must now agree with the
   * store for a row that differs only by `connectClientId`.
   *
   * The two rows carry deliberately distinct names and ids so an equality that
   * passes cannot be two default objects.
   */
  it('🔴 a linked OAuth client no longer changes the preview card kindData', () => {
    const connected = buildListingCardPreview(
      row({
        id: 'r3',
        appListing: {
          name: 'Conn',
          externalUrl: 'https://ext.app',
          category: null,
          contentRating: null,
          connectClientId: 'cc_1',
        },
      })
    );
    const grandfathered = buildListingCardPreview(
      row({
        id: 'r3b',
        appListing: {
          name: 'Legacy',
          externalUrl: 'https://ext.app',
          category: null,
          contentRating: null,
          connectClientId: null,
        },
      })
    );
    expect(connected.kind).toBe('offsite');
    expect(connected.kindData).toEqual(grandfathered.kindData);
    expect(connected.kindData).toEqual({ kind: 'offsite', externalUrl: 'https://ext.app' });
  });

  it('falls back to the slug when the listing (or its name) is absent', () => {
    expect(buildListingCardPreview(row({ id: 'r4', appListing: null, slug: 'sx' })).name).toBe(
      'sx'
    );
  });

  it('passes resolved image URLs straight through when provided', () => {
    const card = buildListingCardPreview(row({ id: 'r5' }), {
      iconUrl: 'https://cdn/icon.png',
      coverUrl: 'https://cdn/cover.png',
    });
    expect(card.iconUrl).toBe('https://cdn/icon.png');
    expect(card.coverUrl).toBe('https://cdn/cover.png');
  });
});

describe('buildListingDetailPreview', () => {
  it('maps an on-site row into a detail with omitted scalars + empty gallery', () => {
    const detail = buildListingDetailPreview(row({ id: 'r1', kind: 'onsite' }));
    expect(detail.kind).toBe('onsite');
    expect(detail.name).toBe('My App');
    // Tagline/description aren't carried by the review data → null (omitted in preview).
    expect(detail.tagline).toBeNull();
    expect(detail.description).toBeNull();
    // serialId only feeds the comments thread, which preview omits.
    expect(detail.serialId).toBe(0);
    expect(detail.screenshots).toEqual([]);
    expect(detail.kindData).toEqual({
      kind: 'onsite',
      appBlockId: null,
      hasPage: false,
      liveUrl: '',
    });
  });

  it('an external row carries the connectClientId (null) + externalUrl on kindData', () => {
    const detail = buildListingDetailPreview(
      row({
        id: 'r2',
        appListing: {
          name: 'Ext',
          externalUrl: 'https://ext.app',
          category: null,
          contentRating: null,
        },
      })
    );
    expect(detail.kindData).toEqual({
      kind: 'offsite',
      externalUrl: 'https://ext.app',
      connectClientId: null,
    });
  });

  it('passes resolved screenshots + cover through when provided', () => {
    const detail = buildListingDetailPreview(row({ id: 'r5' }), {
      coverUrl: 'https://cdn/cover.png',
      screenshots: [{ url: 'https://cdn/s1.png', caption: 'one' }],
    });
    expect(detail.coverUrl).toBe('https://cdn/cover.png');
    expect(detail.screenshots).toEqual([{ url: 'https://cdn/s1.png', caption: 'one' }]);
  });
});

/**
 * 🔴 THE SEAM — this builder's fabricated scalars vs the rail that renders them.
 *
 * Both halves were individually tested and individually right, and the defect lived
 * BETWEEN them: this module substitutes the publish request's SUBMISSION time for the
 * required `updatedAt`, and `buildListingDetailRows` rendered that value under the
 * label "Updated". Neither module's own suite could see it — one never loads the rail,
 * the other never loads this builder. So the composition is asserted here, with the
 * SUBMISSION TIMESTAMP as the thing that must not appear.
 *
 * The `installCount: 0` half is the same shape: a structural zero this builder emits,
 * which the rail printed as `Installs: 0` while the header chips (which decided the
 * same question correctly) showed nothing.
 */
describe('🔴 SEAM: nothing the preview builder FABRICATES reaches the details rail', () => {
  const SUBMITTED = '2026-01-01T00:00:00Z';
  /** A marker formatter — the rendered date is identifiable no matter the locale. */
  const fmt = (iso: string) => `formatted:${iso}`;

  const previewDetail = () => buildListingDetailPreview(row({ id: 'seam', kind: 'onsite' }));

  it('POSITIVE CONTROL: the builder really does fabricate both scalars', () => {
    // Without this, the assertions below could pass because the builder stopped
    // emitting the fields at all — a different change, and not the one under test.
    const detail = previewDetail();
    expect(detail.updatedAt).toBe(new Date(SUBMITTED).toISOString());
    expect(detail.installCount).toBe(0);
  });

  it('POSITIVE CONTROL: rendered in the LIVE posture, both fabricated values DO show', () => {
    // The rail is not blind to these values in general — which is what makes their
    // absence in `preview` a fact about the posture rather than about the rail.
    const rows = buildListingDetailRows(previewDetail(), { formatDate: fmt });
    expect(rows.find((r) => r.key === 'updated')?.value).toBe(
      `formatted:${new Date(SUBMITTED).toISOString()}`
    );
    expect(rows.find((r) => r.key === 'installs')?.value).toBe('0');
  });

  it('🔴 in `preview` the submission time is NOT rendered, under any label', () => {
    const rows = buildListingDetailRows(previewDetail(), { preview: true, formatDate: fmt });
    const submittedIso = new Date(SUBMITTED).toISOString();
    // The formatted value, the raw ISO string, and the row key — three shapes the same
    // date could arrive in.
    expect(rows.map((r) => r.value)).not.toContain(`formatted:${submittedIso}`);
    expect(rows.map((r) => r.value)).not.toContain(submittedIso);
    expect(rows.find((r) => r.key === 'updated')).toBeUndefined();
    expect(rows.map((r) => r.label)).not.toContain('Updated');
  });

  it('🔴 in `preview` the structural zero install count is NOT rendered', () => {
    const rows = buildListingDetailRows(previewDetail(), { preview: true, formatDate: fmt });
    expect(rows.find((r) => r.key === 'installs')).toBeUndefined();
    expect(rows.map((r) => r.value)).not.toContain('0');
    expect(rows.map((r) => r.label)).not.toContain('Installs');
  });

  it('🔴 the preview rail states ONLY what the posture can state honestly', () => {
    // The whole row set, pinned — so a future row carrying another fabricated scalar
    // has to be added here deliberately.
    const rows = buildListingDetailRows(previewDetail(), { preview: true, formatDate: fmt });
    expect(rows.map((r) => r.key)).toEqual(['kind', 'category', 'rating']);
  });
});
