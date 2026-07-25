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

function offsiteCard(
  subKind: 'connect' | 'external-link',
  externalUrl: string | null
): ListingCard {
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
    kindData: { kind: 'offsite', subKind, externalUrl },
  };
}

describe('getListingBadge', () => {
  it('on-site → "App"', () => {
    expect(getListingBadge(onsiteCard({ hasPage: true }))).toEqual({ label: 'App', kind: 'onsite' });
  });
  it('off-site connect → "Connect app"', () => {
    expect(getListingBadge(offsiteCard('connect', null))).toEqual({
      label: 'Connect app',
      kind: 'connect',
    });
  });
  it('off-site external-link → "Off-site"', () => {
    expect(getListingBadge(offsiteCard('external-link', 'https://x.com'))).toEqual({
      label: 'Off-site',
      kind: 'external-link',
    });
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
  it('external-link https → Visit ↗ (direct external primary)', () => {
    expect(getListingCta(offsiteCard('external-link', 'https://foo.app'), { canOpenPage: true })).toEqual({
      label: 'Visit',
      action: 'visit',
      href: 'https://foo.app',
      external: true,
    });
  });
  it('external-link non-https → View details → unified detail (guard drops the href)', () => {
    expect(getListingCta(offsiteCard('external-link', 'http://foo.app'), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/ext-app',
      external: false,
    });
  });
  it('external-link null url → View details → unified detail', () => {
    expect(getListingCta(offsiteCard('external-link', null), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/ext-app',
      external: false,
    });
  });
  it('connect → View details → unified detail (Connect affordance lives on the detail page)', () => {
    expect(getListingCta(offsiteCard('connect', null), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/ext-app',
      external: false,
    });
  });
});

describe('getOwnerEditHref (owner Edit deep-link)', () => {
  it('on-site → the manifest editor keyed on appBlockId', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: 'blk-1' }, 'l1')).toBe(
      '/apps/blk-1/edit-manifest'
    );
  });
  it('on-site with no backing appBlockId → null (no editable target → hide)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: null }, 'l1')).toBeNull();
  });
  it('off-site → the submit editor keyed on the listing id', () => {
    expect(getOwnerEditHref({ kind: 'offsite' }, 'l2')).toBe('/apps/submit?edit=l2');
  });
  it('accepts the full card kindData (extra fields are ignored)', () => {
    expect(getOwnerEditHref(onsiteCard({ hasPage: true, appBlockId: 'blk-9' }).kindData, 'l1')).toBe(
      '/apps/blk-9/edit-manifest'
    );
    expect(getOwnerEditHref(offsiteCard('connect', null).kindData, 'l2')).toBe(
      '/apps/submit?edit=l2'
    );
  });
  it('encodes odd ids (defense in depth)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: 'a b/c' }, 'l1')).toBe(
      '/apps/a%20b%2Fc/edit-manifest'
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
