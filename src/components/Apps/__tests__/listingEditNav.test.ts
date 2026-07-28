import { afterEach, describe, expect, it, vi } from 'vitest';

import { goBackOrFallback, legacyEditRedirect } from '~/components/Apps/listingEditNav';

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
