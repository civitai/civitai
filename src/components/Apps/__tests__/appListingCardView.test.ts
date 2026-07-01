import { describe, expect, it } from 'vitest';
import {
  getListingBadge,
  getListingCta,
  getRecommendLabel,
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

describe('getListingCta — on-site', () => {
  it('hasPage + canOpenPage → Open → /apps/run/<slug>', () => {
    expect(getListingCta(onsiteCard({ hasPage: true, slug: 'gen-matrix' }), { canOpenPage: true })).toEqual({
      label: 'Open',
      action: 'open',
      href: '/apps/run/gen-matrix',
      external: false,
      disabled: false,
    });
  });
  it('hasPage but NOT canOpenPage → View details → /apps/<appBlockId> (no dead run link)', () => {
    expect(getListingCta(onsiteCard({ hasPage: true, appBlockId: 'blk-9' }), { canOpenPage: false })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/blk-9',
      external: false,
      disabled: false,
    });
  });
  it('!hasPage → View details → /apps/<appBlockId>', () => {
    expect(getListingCta(onsiteCard({ hasPage: false, appBlockId: 'blk-3' }), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/blk-3',
      external: false,
      disabled: false,
    });
  });
  it('!hasPage + no appBlockId → disabled View details (no target)', () => {
    expect(getListingCta(onsiteCard({ hasPage: false, appBlockId: null }), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: undefined,
      external: false,
      disabled: true,
    });
  });
  it('encodes an odd slug', () => {
    expect(
      getListingCta(onsiteCard({ hasPage: true, slug: 'a b/c' }), { canOpenPage: true }).href
    ).toBe('/apps/run/a%20b%2Fc');
  });
});

describe('getListingCta — off-site', () => {
  it('external-link https → Visit ↗ (external)', () => {
    expect(getListingCta(offsiteCard('external-link', 'https://foo.app'), { canOpenPage: true })).toEqual({
      label: 'Visit',
      action: 'visit',
      href: 'https://foo.app',
      external: true,
      disabled: false,
    });
  });
  it('external-link non-https → disabled View details (guard drops it)', () => {
    expect(getListingCta(offsiteCard('external-link', 'http://foo.app'), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: undefined,
      external: false,
      disabled: true,
    });
  });
  it('external-link null url → disabled View details', () => {
    expect(getListingCta(offsiteCard('external-link', null), { canOpenPage: true }).disabled).toBe(true);
  });
  it('connect → disabled Connect (P2c flow)', () => {
    expect(getListingCta(offsiteCard('connect', null), { canOpenPage: true })).toEqual({
      label: 'Connect',
      action: 'connect',
      href: undefined,
      external: false,
      disabled: true,
    });
  });
});
