import { describe, expect, it } from 'vitest';

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
    expect(card.kindData).toEqual({ kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: '' });
  });

  it('an external (offsite) row → offsite kindData with the external url + sub-kind', () => {
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
      subKind: 'external-link',
      externalUrl: 'https://ext.app',
    });
  });

  it('a connect (offsite) row → connect sub-kind', () => {
    const card = buildListingCardPreview(
      row({
        id: 'r3',
        appListing: {
          name: 'Conn',
          externalUrl: null,
          category: null,
          contentRating: null,
          connectClientId: 'cc_1',
        },
      })
    );
    expect(card.kind).toBe('offsite');
    expect(card.kindData.kind === 'offsite' && card.kindData.subKind).toBe('connect');
  });

  it('falls back to the slug when the listing (or its name) is absent', () => {
    expect(buildListingCardPreview(row({ id: 'r4', appListing: null, slug: 'sx' })).name).toBe('sx');
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
    expect(detail.kindData).toEqual({ kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: '' });
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
      subKind: 'external-link',
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
