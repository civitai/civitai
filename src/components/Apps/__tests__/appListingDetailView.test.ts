import { describe, expect, it } from 'vitest';
import {
  canOwnerEditListing,
  getDetailPrimaryAction,
  getOwnerEditHref,
  isEditableListingStatus,
} from '~/components/Apps/appListingDetailView';
import { getListingPreview } from '~/components/Apps/appListingPreview';
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
    serialId: 1,
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
    serialId: 2,
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
  it('hasPage + !canOpenPage → points at the IN-PAGE preview; the "Open live" button is GONE', () => {
    const action = getDetailPrimaryAction(
      onsiteDetail({ hasPage: true, liveUrl: 'https://my-app.civit.ai' }),
      { canOpenPage: false }
    );
    // The redundant off-site "Open live" button was removed now that the detail
    // renders the app in-page (poster → click to activate).
    expect(action.label).not.toBe('Open live');
    expect(action.mode).not.toBe('visit');
    // No external nav at all from this branch.
    expect(action.external).toBe(false);
    expect(action.href).toBeUndefined();
    // …and it is not a dead end: it explicitly points at the preview.
    expect(action.mode).toBe('info');
    expect(action.note).toBeTruthy();
  });

  it('🔴 removing "Open live" does NOT strand the viewer — the pointer and the preview agree', () => {
    // This is the invariant the removal hinges on: whenever the header claims a
    // preview exists, `getListingPreview` must actually produce one (both derive
    // from kindData.liveUrl through the same https guard). Exercised over the
    // full on-site matrix so a future change to either side fails here.
    for (const canOpenPage of [true, false]) {
      for (const liveUrl of ['https://my-app.civit.ai', 'http://insecure.example']) {
        const detail = onsiteDetail({ hasPage: true, liveUrl });
        const action = getDetailPrimaryAction(detail, { canOpenPage });
        const preview = getListingPreview(detail);
        const pointsAtPreview = action.label === 'Live preview below';
        if (pointsAtPreview) {
          expect(preview, `claimed a preview for liveUrl=${liveUrl}`).not.toBeNull();
        }
        // And there is ALWAYS some way to use the app: an Open link, a preview,
        // or (worst case) an informational affordance with a learn-more href.
        const usable =
          (action.mode === 'open' && !!action.href) || !!preview || !!action.href || !!action.note;
        expect(usable, `stranded at canOpenPage=${canOpenPage} liveUrl=${liveUrl}`).toBe(true);
      }
    }
  });

  it('hasPage + canOpenPage still wins over the preview pointer (Open is the direct action)', () => {
    expect(
      getDetailPrimaryAction(onsiteDetail({ hasPage: true }), { canOpenPage: true }).mode
    ).toBe('open');
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

describe('owner Edit deep-link + gating (on the detail view-model)', () => {
  it('on-site detail kindData → the unified /edit editor (extra fields ignored)', () => {
    expect(
      getOwnerEditHref(onsiteDetail({ hasPage: true, appBlockId: 'blk-7' }).kindData, 'l1')
    ).toBe('/apps/blk-7/edit');
  });
  it('on-site with no appBlockId → null (no editable target → hide)', () => {
    expect(getOwnerEditHref(onsiteDetail({ hasPage: false, appBlockId: null }).kindData, 'l1')).toBeNull();
  });
  it('off-site detail kindData → the submit editor keyed on the listing id', () => {
    expect(getOwnerEditHref(offsiteDetail('external-link', { externalUrl: 'https://x' }).kindData, 'l2')).toBe(
      '/apps/submit?edit=l2'
    );
    expect(getOwnerEditHref(offsiteDetail('connect').kindData, 'l2')).toBe('/apps/submit?edit=l2');
  });

  it('owner + editable → show; non-owner → hide; mod-removed → hide', () => {
    expect(canOwnerEditListing({ isOwner: true })).toBe(true);
    expect(canOwnerEditListing({ isOwner: false })).toBe(false);
    expect(canOwnerEditListing({ isOwner: true, status: 'removed' })).toBe(false);
    expect(isEditableListingStatus('approved')).toBe(true);
    expect(isEditableListingStatus('removed')).toBe(false);
  });
});
