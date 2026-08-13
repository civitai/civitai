import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALL_EDITOR_TABS } from '~/components/Apps/appListingEditorTabs';
import {
  canonicalEditRedirect,
  goBackOrFallback,
  legacyEditRedirect,
} from '~/components/Apps/listingEditNav';

/**
 * Item 3 (history-aware back) + Item 2 (legacy-route redirects) navigation helpers.
 * PURE-ish: `goBackOrFallback` only reads `window.history.length`; `legacyEditRedirect`
 * is fully pure. No component mount / SSR machinery needed.
 */

describe('goBackOrFallback (Item 3 — history-aware back)', () => {
  // The node test env has no `window`; stub a minimal one so the helper's
  // `typeof window !== 'undefined'` + `window.history.length` read is exercised.
  const g = globalThis as { window?: { history: { length: number } } };
  const hadWindow = 'window' in g;
  const prevWindow = g.window;
  afterEach(() => {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  });

  function setHistoryLength(n: number) {
    g.window = { history: { length: n } };
  }

  it('calls router.back() when there is real history (length > 1)', () => {
    setHistoryLength(3);
    const router = { back: vi.fn(), push: vi.fn() };
    goBackOrFallback(router, '/apps/blk-1');
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('falls back to router.push(fallback) on a cold/deep entry (length <= 1)', () => {
    setHistoryLength(1);
    const router = { back: vi.fn(), push: vi.fn() };
    goBackOrFallback(router, '/apps/blk-1');
    expect(router.push).toHaveBeenCalledWith('/apps/blk-1');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('honors a standalone-view fallback href when provided', () => {
    setHistoryLength(1);
    const router = { back: vi.fn(), push: vi.fn() };
    goBackOrFallback(router, '/apps/blk-1/edit');
    expect(router.push).toHaveBeenCalledWith('/apps/blk-1/edit');
  });
});

describe('legacyEditRedirect (Item 2 — old-route redirects)', () => {
  it('edit-manifest → /apps/<id>/edit?tab=manifest', () => {
    expect(legacyEditRedirect('blk-1', 'manifest')).toEqual({
      redirect: { destination: '/apps/blk-1/edit?tab=manifest', permanent: false },
    });
  });

  it('listing → /apps/<id>/edit?tab=media', () => {
    expect(legacyEditRedirect('blk-1', 'media')).toEqual({
      redirect: { destination: '/apps/blk-1/edit?tab=media', permanent: false },
    });
  });

  it('unwraps a catch-all array param and encodes odd ids', () => {
    expect(legacyEditRedirect(['a b/c'], 'media')).toEqual({
      redirect: { destination: '/apps/a%20b%2Fc/edit?tab=media', permanent: false },
    });
  });

  it('missing appBlockId → notFound', () => {
    expect(legacyEditRedirect(undefined, 'manifest')).toEqual({ notFound: true });
    expect(legacyEditRedirect('', 'media')).toEqual({ notFound: true });
  });
});

/**
 * The block→listing re-key: the CANONICAL destination is `/apps/listing/<id>/edit`, and
 * the legacy block-keyed URL is only used when the block genuinely has no listing.
 */
describe('legacyEditRedirect (canonical listing-keyed destination)', () => {
  it('with a listing id → the CANONICAL listing route, tab preserved', () => {
    expect(legacyEditRedirect('blk-1', 'media', 'apl_9')).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=media', permanent: false },
    });
    expect(legacyEditRedirect('blk-1', 'manifest', 'apl_9')).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=manifest', permanent: false },
    });
  });

  it('carries the two NEW tabs across the hop as well', () => {
    expect(legacyEditRedirect('blk-1', 'collaborators', 'apl_9')).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=collaborators', permanent: false },
    });
    expect(legacyEditRedirect('blk-1', 'details', 'apl_9')).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=details', permanent: false },
    });
  });

  it('🔴 NO listing id → the pre-existing block-keyed destination, byte-identical', () => {
    // A first-version app pending approval has no `AppListing` row, so there is no
    // canonical URL to send it to. `null` and `undefined` must both take this branch.
    expect(legacyEditRedirect('blk-1', 'manifest', null)).toEqual(
      legacyEditRedirect('blk-1', 'manifest')
    );
    expect(legacyEditRedirect('blk-1', 'media', undefined)).toEqual({
      redirect: { destination: '/apps/blk-1/edit?tab=media', permanent: false },
    });
  });

  it('encodes an odd LISTING id too, not just an odd block id', () => {
    expect(legacyEditRedirect('blk-1', 'media', 'a b/c')).toEqual({
      redirect: { destination: '/apps/listing/a%20b%2Fc/edit?tab=media', permanent: false },
    });
  });

  it('a missing appBlockId still 404s even when a listing id is supplied', () => {
    expect(legacyEditRedirect(undefined, 'media', 'apl_9')).toEqual({ notFound: true });
    expect(legacyEditRedirect('', 'media', 'apl_9')).toEqual({ notFound: true });
  });
});

describe('canonicalEditRedirect (/apps/<appBlockId>/edit itself)', () => {
  it('with a listing → 302 to the canonical page, `?tab=` preserved', () => {
    expect(canonicalEditRedirect('blk-1', 'media', 'apl_9', ALL_EDITOR_TABS)).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=media', permanent: false },
    });
  });

  it('🔴 WITHOUT a listing → renders, never redirects (a self-302 would loop forever)', () => {
    expect(canonicalEditRedirect('blk-1', 'media', null, ALL_EDITOR_TABS)).toEqual({ props: {} });
    expect(canonicalEditRedirect('blk-1', 'media', undefined, ALL_EDITOR_TABS)).toEqual({
      props: {},
    });
  });

  it('sanitises a user-supplied `?tab=` before writing it into the destination', () => {
    expect(canonicalEditRedirect('blk-1', 'nonsense', 'apl_9', ALL_EDITOR_TABS)).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=details', permanent: false },
    });
    // No `?tab=` at all → the default tab, not an empty query.
    expect(canonicalEditRedirect('blk-1', undefined, 'apl_9', ALL_EDITOR_TABS)).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=details', permanent: false },
    });
    // An array param (Next gives one for a repeated query key).
    expect(canonicalEditRedirect('blk-1', ['manifest'], 'apl_9', ALL_EDITOR_TABS)).toEqual({
      redirect: { destination: '/apps/listing/apl_9/edit?tab=manifest', permanent: false },
    });
  });

  it('missing / empty appBlockId → notFound, listing or not', () => {
    expect(canonicalEditRedirect(undefined, 'media', 'apl_9', ALL_EDITOR_TABS)).toEqual({
      notFound: true,
    });
    expect(canonicalEditRedirect('', 'media', null, ALL_EDITOR_TABS)).toEqual({ notFound: true });
  });

  it('unwraps a catch-all array appBlockId', () => {
    expect(canonicalEditRedirect(['blk-1'], 'media', null, ALL_EDITOR_TABS)).toEqual({ props: {} });
  });
});
