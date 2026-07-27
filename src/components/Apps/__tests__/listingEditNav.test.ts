import { describe, expect, it } from 'vitest';

import { legacyEditRedirect } from '~/components/Apps/listingEditNav';

/**
 * Item 2 legacy-route redirect helper. Fully pure — no component mount / SSR
 * machinery. (The Item-3 history-aware `goBackOrFallback` tests are appended
 * alongside when that helper lands.)
 */

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
