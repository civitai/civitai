import { describe, expect, it } from 'vitest';
import { getDetailPrimaryAction } from '~/components/Apps/appListingDetailView';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — P2c detail view-model unit tests (node `unit`
 * project → the BLOCKING correctness gate; the browser component suites are
 * report-only). Pin the kind × hasPage × subKind primary-action matrix incl.
 * the appBlocksPages gate, https guard, connect stub, and slug encoding, so a
 * regression in the detail action routing FAILS here.
 */

function onsiteDetail(
  over: Partial<ListingDetail> & { hasPage: boolean; appBlockId?: string | null; liveUrl?: string }
): ListingDetail {
  const { hasPage, appBlockId = 'blk-1', liveUrl = 'https://my-app.civit.ai', ...rest } = over;
  return {
    id: 'l1',
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [],
    kindData: { kind: 'onsite', appBlockId, hasPage, liveUrl },
    ...rest,
  };
}

function offsiteDetail(
  subKind: 'connect' | 'external-link',
  over: { externalUrl?: string | null; connectClientId?: string | null; slug?: string } = {}
): ListingDetail {
  const { externalUrl = null, connectClientId = null, slug = 'ext-app' } = over;
  return {
    id: 'l2',
    slug,
    kind: 'offsite',
    name: 'Ext App',
    tagline: null,
    description: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [],
    kindData: { kind: 'offsite', subKind, externalUrl, connectClientId },
  };
}

describe('getDetailPrimaryAction — on-site', () => {
  it('hasPage + canOpenPage → Open → /apps/run/<slug>', () => {
    expect(getDetailPrimaryAction(onsiteDetail({ hasPage: true, slug: 'gen' }), { canOpenPage: true })).toEqual({
      label: 'Open',
      mode: 'open',
      href: '/apps/run/gen',
      external: false,
    });
  });
  it('hasPage + !canOpenPage → Open live → the standalone liveUrl (no dead run link)', () => {
    expect(
      getDetailPrimaryAction(onsiteDetail({ hasPage: true, liveUrl: 'https://my-app.civit.ai' }), {
        canOpenPage: false,
      })
    ).toEqual({ label: 'Open live', mode: 'visit', href: 'https://my-app.civit.ai', external: true });
  });
  it('hasPage + !canOpenPage + non-https liveUrl → info fallback (guard drops it)', () => {
    const action = getDetailPrimaryAction(
      onsiteDetail({ hasPage: true, liveUrl: 'http://insecure.example' }),
      { canOpenPage: false }
    );
    expect(action.mode).toBe('info');
    expect(action.label).toBe('Runs on model pages');
  });
  it('!hasPage (model-slot) → info "Runs on model pages" → link to live /apps/<appBlockId>', () => {
    const action = getDetailPrimaryAction(onsiteDetail({ hasPage: false, appBlockId: 'blk-9' }), {
      canOpenPage: true,
    });
    expect(action.mode).toBe('info');
    expect(action.label).toBe('Runs on model pages');
    expect(action.href).toBe('/apps/blk-9');
    expect(action.note).toBeTruthy();
  });
  it('!hasPage + no appBlockId → info with no learn-more link (no dead nav)', () => {
    const action = getDetailPrimaryAction(onsiteDetail({ hasPage: false, appBlockId: null }), {
      canOpenPage: true,
    });
    expect(action.mode).toBe('info');
    expect(action.href).toBeUndefined();
  });
  it('encodes an odd slug on the Open run link', () => {
    expect(
      getDetailPrimaryAction(onsiteDetail({ hasPage: true, slug: 'a b/c' }), { canOpenPage: true }).href
    ).toBe('/apps/run/a%20b%2Fc');
  });
});

describe('getDetailPrimaryAction — off-site', () => {
  it('external-link https → Visit ↗ (external)', () => {
    expect(
      getDetailPrimaryAction(offsiteDetail('external-link', { externalUrl: 'https://foo.app' }), {
        canOpenPage: true,
      })
    ).toEqual({ label: 'Visit', mode: 'visit', href: 'https://foo.app', external: true });
  });
  it('external-link non-https → info Unavailable (guard drops it, no target)', () => {
    const action = getDetailPrimaryAction(
      offsiteDetail('external-link', { externalUrl: 'http://foo.app' }),
      { canOpenPage: true }
    );
    expect(action).toEqual({
      label: 'Unavailable',
      mode: 'info',
      external: false,
      note: 'This app has no valid external link.',
    });
  });
  it('external-link null url → info Unavailable', () => {
    expect(getDetailPrimaryAction(offsiteDetail('external-link', { externalUrl: null }), { canOpenPage: true }).mode).toBe(
      'info'
    );
  });
  it('connect → Connect stub (mode connect, no dead href, note set)', () => {
    const action = getDetailPrimaryAction(offsiteDetail('connect', { connectClientId: 'client-123' }), {
      canOpenPage: true,
    });
    expect(action.mode).toBe('connect');
    expect(action.label).toBe('Connect');
    expect(action.href).toBeUndefined();
    expect(action.external).toBe(false);
    expect(action.note).toBeTruthy();
  });
});
