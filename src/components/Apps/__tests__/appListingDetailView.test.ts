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
  it('🔴 hasPage + !canOpenPage → the raw-origin "Open live" ESCAPE HATCH is KEPT', () => {
    const action = getDetailPrimaryAction(
      onsiteDetail({ hasPage: true, liveUrl: 'https://my-app.civit.ai' }),
      { canOpenPage: false }
    );
    // With appBlocksPages dark the in-page preview is the only in-store route,
    // and it is a sandboxed frame WITHOUT allow-forms / allow-popups /
    // allow-downloads — so a block that needs any of those is unusable through
    // it. The legacy /apps/[appBlockId] page kept an unsandboxed escape hatch;
    // the canonical page must not be strictly less capable.
    expect(action).toEqual({
      label: 'Open live',
      mode: 'visit',
      href: 'https://my-app.civit.ai',
      external: true,
      note: 'Opens the app at its own address. You can also run it in the live preview below.',
    });
  });

  it('hasPage + canOpenPage → the escape hatch is HIDDEN (the app opens in-page)', () => {
    // The redundancy the removal was actually about: when /apps/run works, a
    // second button shipping the viewer to the raw origin is noise.
    const action = getDetailPrimaryAction(onsiteDetail({ hasPage: true }), { canOpenPage: true });
    expect(action.mode).toBe('open');
    expect(action.label).not.toBe('Open live');
    expect(action.external).toBe(false);
    expect(action.href).toBe('/apps/run/my-app');
  });

  it('🔴 no on-site state strands the viewer (full matrix, no note-shaped escape)', () => {
    // The invariant the whole action matrix rests on: for every combination of
    // hasPage × canOpenPage × liveUrl-validity × appBlockId-presence, the page
    // offers either a REAL navigable route or a renderable in-page preview.
    //
    // "usable" deliberately does NOT count `action.note`. Every branch of
    // getDetailPrimaryAction sets an href OR a note, so allowing a note to
    // satisfy this made the assertion true by construction — it could not fail.
    // A note is prose; it is not a way to use the app.
    const stranded: string[] = [];
    for (const hasPage of [true, false]) {
      for (const canOpenPage of [true, false]) {
        for (const liveUrl of ['https://my-app.civit.ai', 'http://insecure.example']) {
          for (const appBlockId of ['blk-1', null]) {
            const key = `hasPage=${hasPage} canOpenPage=${canOpenPage} liveUrl=${
              liveUrl.startsWith('https') ? 'https' : 'http'
            } appBlockId=${appBlockId ?? 'null'}`;
            const detail = onsiteDetail({ hasPage, liveUrl, appBlockId });
            const action = getDetailPrimaryAction(detail, { canOpenPage });
            const preview = getListingPreview(detail);

            // Integrity of the action itself, asserted for EVERY combination.
            if (action.href !== undefined) expect(action.href, key).not.toBe('');
            // `visit` is the only external mode, and it may only ever carry an
            // https target (the safeExternalHref guard).
            expect(action.external, key).toBe(action.mode === 'visit');
            if (action.mode === 'visit') expect(action.href, key).toMatch(/^https:\/\//);
            // If the copy promises a preview, one must actually render.
            if (action.note?.includes('live preview')) {
              expect(preview, `${key}: promised a preview that does not render`).not.toBeNull();
            }

            const usable =
              (action.mode === 'open' && !!action.href) ||
              (action.mode === 'visit' && !!action.href) ||
              (action.mode === 'info' && !!action.href) ||
              preview !== null;
            if (!usable) stranded.push(key);
          }
        }
      }
    }

    // The dead-end set, pinned EXACTLY. Any behaviour change either keeps this
    // set identical or fails here — that is the point of enumerating it instead
    // of hiding it behind an `|| !!action.note`.
    //
    // All three share one degenerate shape: a non-https liveUrl (so the https
    // guard drops BOTH the escape hatch and the in-page preview) AND no
    // appBlockId (so there is no "learn more" target either). Unreachable with
    // real data — liveUrl is server-computed as `https://<slug>.<APPS_DOMAIN>`,
    // and an on-site listing always has its backing AppBlock — which is exactly
    // why it is pinned rather than fixed with invented UI.
    expect(stranded).toEqual([
      'hasPage=true canOpenPage=false liveUrl=http appBlockId=null',
      'hasPage=false canOpenPage=true liveUrl=http appBlockId=null',
      'hasPage=false canOpenPage=false liveUrl=http appBlockId=null',
    ]);
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
