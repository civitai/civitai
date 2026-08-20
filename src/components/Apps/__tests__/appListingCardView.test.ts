import { describe, expect, it } from 'vitest';
import {
  canOwnerEditListing,
  getListingBadge,
  getListingCta,
  getListingDetailHref,
  getOwnerEditHref,
  getRecommendLabel,
  isEditableListingStatus,
  safeExternalHref,
} from '~/components/Apps/appListingCardView';
import type {
  ListingCard,
  ListingRecommendRollup,
} from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — P2b card view-model unit tests (node `unit`
 * project → the BLOCKING correctness gate; the browser component suites are
 * report-only). Pin the kind matrix, the recommend label (incl. null pct), the
 * https guard, and the CTA target policy so a regression in the kind-aware
 * routing/badging FAILS here.
 */

const roll = (
  recommendedCount: number,
  notRecommendedCount: number,
  recommendPct: number | null
): ListingRecommendRollup => ({ recommendedCount, notRecommendedCount, recommendPct });

function onsiteCard(over: Partial<ListingCard> & { hasPage: boolean; appBlockId?: string | null }): ListingCard {
  const { hasPage, appBlockId = 'blk-1', ...rest } = over;
  return {
    id: 'l1',
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: roll(0, 0, null),
    reviewCount: 0,
    kindData: { kind: 'onsite', appBlockId, hasPage },
    ...rest,
  };
}

/**
 * 🔴 The `subKind` parameter is GONE. Off-site listings used to fork for display
 * into `connect` / `external-link`, derived from `connectClientId`; the card DTO
 * no longer carries either the sub-kind or the client id, so a card cannot
 * express the distinction at all. `externalUrl` is the only off-site input left.
 */
function offsiteCard(externalUrl: string | null): ListingCard {
  return {
    id: 'l2',
    slug: 'ext-app',
    kind: 'offsite',
    name: 'Ext App',
    tagline: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: roll(0, 0, null),
    reviewCount: 0,
    kindData: { kind: 'offsite', externalUrl },
  };
}

describe('getListingBadge', () => {
  it('on-site → "App"', () => {
    expect(getListingBadge(onsiteCard({ hasPage: true }))).toEqual({ label: 'App', kind: 'onsite' });
  });
  /**
   * 🔴 NEW BEHAVIOUR (not regression coverage): off-site used to badge as
   * "Connect app" when a client was linked and "Off-site" when not. There is one
   * badge now, and PR #4187 renamed its word to "Standalone". This pins the
   * collapsed pair — the "Connect app" case above is what a revert would put
   * back, and it is what this assertion refuses.
   */
  it('🔴 off-site → "Standalone", with or without a usable destination', () => {
    for (const externalUrl of [null, 'https://x.com', 'http://insecure.example']) {
      expect(getListingBadge(offsiteCard(externalUrl)), String(externalUrl)).toEqual({
        label: 'Standalone',
        kind: 'offsite',
      });
    }
  });
  /**
   * The word is load-bearing: it must be the SAME word the store's kind filter
   * puts on the whole category (`KindFilterButtons`' "Standalone"). Under the fork
   * the parent label was true of only one child while the submit flow minted
   * nothing but the other one. Pinned as a literal so a reword has to be
   * deliberate — PR #4187 renamed it Off-site → Standalone, and this assertion
   * moved with it.
   */
  it('🔴 the off-site badge label is exactly the store kind-filter word', () => {
    expect(getListingBadge(offsiteCard('https://x.com')).label).toBe('Standalone');
  });
});

describe('getRecommendLabel', () => {
  it('null pct → "No reviews yet"', () => {
    expect(getRecommendLabel(roll(0, 0, null), 0)).toBe('No reviews yet');
  });
  it('pct present → "N% recommend (M)" with rounding + count', () => {
    expect(getRecommendLabel(roll(9, 1, 0.9), 10)).toBe('90% recommend (10)');
    expect(getRecommendLabel(roll(2, 1, 0.6666), 3)).toBe('67% recommend (3)');
    expect(getRecommendLabel(roll(1, 0, 1), 1)).toBe('100% recommend (1)');
  });
  it('formats large counts with locale separators', () => {
    expect(getRecommendLabel(roll(1200, 300, 0.8), 1500)).toBe('80% recommend (1,500)');
  });
});

describe('safeExternalHref', () => {
  it('passes https', () => {
    expect(safeExternalHref('https://example.com')).toBe('https://example.com');
  });
  it('rejects http / non-https / dangerous / empty', () => {
    expect(safeExternalHref('http://example.com')).toBeNull();
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeExternalHref('ftp://x')).toBeNull();
    expect(safeExternalHref('')).toBeNull();
    expect(safeExternalHref(null)).toBeNull();
    expect(safeExternalHref(undefined)).toBeNull();
  });
});

describe('getListingDetailHref', () => {
  it('routes to the unified store-preview detail by slug', () => {
    expect(getListingDetailHref('my-app')).toBe('/apps/store-preview/my-app');
  });
  it('encodes an odd slug (defense in depth)', () => {
    expect(getListingDetailHref('a b/c')).toBe('/apps/store-preview/a%20b%2Fc');
  });
});

describe('getListingCta — on-site (P2c: View details → unified detail)', () => {
  it('hasPage + canOpenPage → Open → /apps/run/<slug> (direct primary)', () => {
    expect(getListingCta(onsiteCard({ hasPage: true, slug: 'gen-matrix' }), { canOpenPage: true })).toEqual({
      label: 'Open',
      action: 'open',
      href: '/apps/run/gen-matrix',
      external: false,
    });
  });
  it('hasPage but NOT canOpenPage → View details → unified detail (no dead run link)', () => {
    expect(getListingCta(onsiteCard({ hasPage: true, slug: 'my-app' }), { canOpenPage: false })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/my-app',
      external: false,
    });
  });
  it('!hasPage → View details → unified detail', () => {
    expect(getListingCta(onsiteCard({ hasPage: false, slug: 'my-app' }), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/my-app',
      external: false,
    });
  });
  it('!hasPage + no appBlockId → still reaches the unified detail (never actionless)', () => {
    expect(getListingCta(onsiteCard({ hasPage: false, appBlockId: null, slug: 'my-app' }), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/my-app',
      external: false,
    });
  });
  it('encodes an odd slug on the Open run link', () => {
    expect(
      getListingCta(onsiteCard({ hasPage: true, slug: 'a b/c' }), { canOpenPage: true }).href
    ).toBe('/apps/run/a%20b%2Fc');
  });
});

describe('getListingCta — off-site (P2c: View details → unified detail)', () => {
  it('https externalUrl → Visit ↗ (direct external primary)', () => {
    expect(getListingCta(offsiteCard('https://foo.app'), { canOpenPage: true })).toEqual({
      label: 'Visit',
      action: 'visit',
      href: 'https://foo.app',
      external: true,
    });
  });
  it('non-https → View details → unified detail (guard drops the href)', () => {
    expect(getListingCta(offsiteCard('http://foo.app'), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/ext-app',
      external: false,
    });
  });
  it('null url → View details → unified detail', () => {
    expect(getListingCta(offsiteCard(null), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/ext-app',
      external: false,
    });
  });
  it('no usable target → View details → unified detail (fails safe)', () => {
    for (const externalUrl of [null, '', 'http://insecure.app', 'javascript:alert(1)']) {
      expect(
        getListingCta(offsiteCard(externalUrl), { canOpenPage: true }),
        String(externalUrl)
      ).toEqual({
        label: 'View details',
        action: 'detail',
        href: '/apps/store-preview/ext-app',
        external: false,
      });
    }
  });
});

describe('getOwnerEditHref (owner Edit deep-link)', () => {
  it('on-site → the UNIFIED /edit editor keyed on appBlockId (Item 2)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: 'blk-1' }, 'l1')).toBe('/apps/blk-1/edit');
  });
  it('on-site with no backing appBlockId → null (no editable target → hide)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: null }, 'l1')).toBeNull();
  });
  it('off-site → the submit editor keyed on the listing id (UNCHANGED)', () => {
    expect(getOwnerEditHref({ kind: 'offsite' }, 'l2')).toBe('/apps/submit?edit=l2');
  });
  it('accepts the full card kindData (extra fields are ignored)', () => {
    expect(getOwnerEditHref(onsiteCard({ hasPage: true, appBlockId: 'blk-9' }).kindData, 'l1')).toBe(
      '/apps/blk-9/edit'
    );
    expect(getOwnerEditHref(offsiteCard('connect', null).kindData, 'l2')).toBe(
      '/apps/submit?edit=l2'
    );
  });
  it('encodes odd ids (defense in depth)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: 'a b/c' }, 'l1')).toBe(
      '/apps/a%20b%2Fc/edit'
    );
    expect(getOwnerEditHref({ kind: 'offsite' }, 'a b/c')).toBe('/apps/submit?edit=a%20b%2Fc');
  });
});

describe('isEditableListingStatus / canOwnerEditListing (owner Edit gating)', () => {
  it('no status (approved-only store DTO) → editable', () => {
    expect(isEditableListingStatus(null)).toBe(true);
    expect(isEditableListingStatus(undefined)).toBe(true);
  });
  it('editable lifecycle statuses → editable', () => {
    expect(isEditableListingStatus('draft')).toBe(true);
    expect(isEditableListingStatus('pending')).toBe(true);
    expect(isEditableListingStatus('approved')).toBe(true);
  });
  it('mod-removed / rejected → NOT editable', () => {
    expect(isEditableListingStatus('removed')).toBe(false);
    expect(isEditableListingStatus('rejected')).toBe(false);
  });

  it('owner + editable → show', () => {
    expect(canOwnerEditListing({ isOwner: true })).toBe(true);
    expect(canOwnerEditListing({ isOwner: true, status: 'approved' })).toBe(true);
    expect(canOwnerEditListing({ isOwner: true, status: 'pending' })).toBe(true);
  });
  it('non-owner → hide (even for an editable status)', () => {
    expect(canOwnerEditListing({ isOwner: false })).toBe(false);
    expect(canOwnerEditListing({ isOwner: false, status: 'approved' })).toBe(false);
  });
  it('owner but mod-removed / rejected → hide', () => {
    expect(canOwnerEditListing({ isOwner: true, status: 'removed' })).toBe(false);
    expect(canOwnerEditListing({ isOwner: true, status: 'rejected' })).toBe(false);
  });
});
