import { describe, expect, it, vi } from 'vitest';

// The gated-image service's own graph: stub what pulls env, as its own test does.
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => ({
    hiddenUsers: [],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [],
  }),
}));
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  BLOCK_PUBLISHED_APP_ID_META_KEY: 'blockPublishedAppId',
}));

import { blockOutputCeilingFromClaims } from '~/server/services/blocks/block-output-restriction';
import { resolveViewerBrowsingLevel } from '~/server/services/blocks/block-gated-images.service';

/**
 * 🔴 The output ceiling IS the viewer level #8786 clamps the gated-image read to
 * (`resolveViewerBrowsingLevel`: the domain ceiling intersected with the signed
 * `viewerBrowsingLevel`, PG without one). This pins the RELATIONSHIP, so a second
 * derivation that drifts from it on any claim shape fails here, whichever side moves.
 */
describe("the output ceiling is #8786's viewer browsing level", () => {
  const DOMAIN_TO_R = 1 | 2 | 4;
  const CLAIMS = [
    {},
    { maxBrowsingLevel: DOMAIN_TO_R },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: 1 },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: 1 | 4 | 8 },
    { maxBrowsingLevel: 1 | 2 | 4 | 8 | 16, viewerBrowsingLevel: 2 | 16 },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: -1 },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: 8 },
    { maxBrowsingLevel: Number.NaN, viewerBrowsingLevel: 2 },
  ];

  it('agrees on every claim shape', () => {
    expect(CLAIMS.map((c) => blockOutputCeilingFromClaims(c).maxBrowsingLevel)).toStrictEqual(
      CLAIMS.map((c) => resolveViewerBrowsingLevel(c))
    );
  });

  it('CONTROL: the matrix is not degenerate (it resolves to several levels)', () => {
    expect(new Set(CLAIMS.map((c) => resolveViewerBrowsingLevel(c))).size).toBeGreaterThan(3);
  });
});
