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
 * project — the fast, deterministic suite; CI runs it `continue-on-error`, and
 * the browser component suites are not run by CI at all, so this is where the
 * correctness coverage belongs even though nothing here BLOCKS a merge).
 * Pin the kind × hasPage × subKind primary-action matrix incl.
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
    // 🔴 This set GREW from 3 to 6 when the model-slot `info` href was removed
    // (#3493 retired `/apps/[appBlockId]`, so that href had become a redirect
    // back onto this very page — a circular self-link is not a way to use the
    // app, and counting it as one is exactly the kind of false "usable" this
    // matrix exists to catch). The three added entries are the `appBlockId`
    // arms that the old href used to rescue.
    //
    // The invariant is now CLEANER, not weaker: all six share ONE degenerate
    // shape — a non-https `liveUrl`, so the `safeExternalHref` guard drops both
    // the "Open live" escape hatch AND the in-page preview. `appBlockId` no
    // longer appears in the condition at all. Unreachable with real data:
    // `liveUrl` is server-computed as `https://<slug>.<APPS_DOMAIN>`. Note what
    // is NOT here — every `hasPage=false` (model-slot) row with an https
    // `liveUrl` stays usable, because `getListingPreview` gates on kind + URL
    // and not on `hasPage`, so the in-page preview still renders for it. What a
    // model-slot app lacks on this page is an INSTALL surface, which is the gap
    // #3493 tracks and which is deliberately not invented here.
    expect(stranded).toEqual([
      'hasPage=true canOpenPage=false liveUrl=http appBlockId=blk-1',
      'hasPage=true canOpenPage=false liveUrl=http appBlockId=null',
      'hasPage=false canOpenPage=true liveUrl=http appBlockId=blk-1',
      'hasPage=false canOpenPage=true liveUrl=http appBlockId=null',
      'hasPage=false canOpenPage=false liveUrl=http appBlockId=blk-1',
      'hasPage=false canOpenPage=false liveUrl=http appBlockId=null',
    ]);
    // Every dead end is a non-https liveUrl — asserted structurally so the list
    // above cannot silently acquire an entry of a different shape.
    for (const key of stranded) expect(key).toContain('liveUrl=http ');
  });
  it('hasPage + !canOpenPage + non-https liveUrl → info fallback (guard drops it)', () => {
    const action = getDetailPrimaryAction(
      onsiteDetail({ hasPage: true, liveUrl: 'http://insecure.example' }),
      { canOpenPage: false }
    );
    expect(action.mode).toBe('info');
    expect(action.label).toBe('Runs on model pages');
  });
  it('🔴 !hasPage (model-slot) → info TEXT ONLY — never links to the retired /apps/<appBlockId>', () => {
    // #3493 retired `/apps/[appBlockId]`: it is now getServerSideProps-only and
    // 302s to `/apps/store-preview/<slug>` (the page the store detail viewer is
    // ALREADY on — a circular self-link) or 404s for an app with no approved
    // listing. There is no install surface on `AppListingDetailBody` to retarget
    // to, so the affordance is informational copy with NO href. This must hold
    // whether or not the app has an appBlockId — the id is exactly what the old
    // href was built from, so a regression would resurface only in this arm.
    for (const appBlockId of ['blk-9', null]) {
      for (const canOpenPage of [true, false]) {
        const action = getDetailPrimaryAction(onsiteDetail({ hasPage: false, appBlockId }), {
          canOpenPage,
        });
        const key = `appBlockId=${appBlockId ?? 'null'} canOpenPage=${canOpenPage}`;
        expect(action.mode, key).toBe('info');
        expect(action.label, key).toBe('Runs on model pages');
        // The honest signal survives: the viewer is told WHY it can't be opened.
        expect(action.note, key).toBeTruthy();
        expect(action.href, key).toBeUndefined();
        expect(action.external, key).toBe(false);
      }
    }
  });
  it('🔴 NO action of any kind can target the retired /apps/<appBlockId> route', () => {
    // Route-shape guard, independent of the branch above: `/apps/run/<slug>` and
    // `/apps/<id>/edit` are live siblings, but a bare `/apps/<segment>` is the
    // retired route. Pinned across the whole on-site matrix so a future branch
    // cannot reintroduce the redirect loop somewhere else in this function.
    const retired = /^\/apps\/[^/]+$/;
    // 🔴 Anti-vacuity counter. The assertion below is inside `if (action.href)`,
    // so if a future change stripped the href from EVERY branch the loop would
    // run 16 times, assert nothing, and stay green — the exact "cannot fail"
    // class this PR exists to kill. Count the hrefs actually produced and
    // require the guard to have had something to guard.
    let hrefsSeen = 0;
    for (const hasPage of [true, false]) {
      for (const canOpenPage of [true, false]) {
        for (const liveUrl of ['https://my-app.civit.ai', 'http://insecure.example']) {
          for (const appBlockId of ['blk-1', null]) {
            const action = getDetailPrimaryAction(onsiteDetail({ hasPage, liveUrl, appBlockId }), {
              canOpenPage,
            });
            const key = `hasPage=${hasPage} canOpenPage=${canOpenPage} liveUrl=${liveUrl} appBlockId=${
              appBlockId ?? 'null'
            }`;
            if (action.href) {
              hrefsSeen++;
              expect(action.href, key).not.toMatch(retired);
            }
          }
        }
      }
    }
    // Half the matrix (`hasPage` with an https liveUrl) yields an href — 8 of
    // the 16 combinations today. Assert the guard saw real targets rather than
    // an all-text matrix.
    expect(hrefsSeen).toBeGreaterThan(0);
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
