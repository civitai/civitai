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

import { blockOutputCeilingFromClaims } from '~/server/services/blocks/block-output-restriction';
import { resolveViewerBrowsingLevel } from '~/server/services/blocks/block-gated-images.service';

/**
 * 🔴 The output ceiling is the viewer level #8786 clamps the gated-image read to
 * (`resolveViewerBrowsingLevel`: the domain ceiling intersected with the signed
 * `viewerBrowsingLevel`, PG without one), with ONE difference: a SIGNED-IN viewer's
 * level is floored at PG|PG-13 before that intersection. So the output ceiling is
 * exactly `resolveViewerBrowsingLevel(claims)` for anyone else, and exactly
 * `resolveViewerBrowsingLevel({ ...claims, viewerBrowsingLevel: level | PG | PG-13 })`
 * for a signed-in viewer with a valid level. This pins both relationships, so a second
 * derivation that drifts from the resolver on any claim shape fails here, whichever
 * side moves, and `resolveViewerBrowsingLevel` itself is never floored.
 */
describe("the output ceiling is #8786's viewer browsing level, floored for a signed-in viewer", () => {
  const DOMAIN_TO_R = 1 | 2 | 4;
  const SHAPES = [
    {},
    { maxBrowsingLevel: DOMAIN_TO_R },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: 1 },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: 1 | 4 | 8 },
    { maxBrowsingLevel: 1 | 2 | 4 | 8 | 16, viewerBrowsingLevel: 16 },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: -1 },
    { maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: 8 },
    { maxBrowsingLevel: Number.NaN, viewerBrowsingLevel: 4 },
  ];
  const NOT_SIGNED_IN = [
    ...SHAPES,
    ...SHAPES.map((c) => ({ ...c, sub: 'anon' })),
    ...SHAPES.map((c) => ({ ...c, sub: 'user:0042' })),
  ];
  const SIGNED_IN = SHAPES.map((c) => ({ ...c, sub: 'user:42' }));
  const floored = (c: { viewerBrowsingLevel?: number }) =>
    typeof c.viewerBrowsingLevel === 'number' &&
    Number.isInteger(c.viewerBrowsingLevel) &&
    c.viewerBrowsingLevel >= 0
      ? { ...c, viewerBrowsingLevel: c.viewerBrowsingLevel | 1 | 2 }
      : c;

  it('is EXACTLY resolveViewerBrowsingLevel for anyone not signed in', () => {
    expect(
      NOT_SIGNED_IN.map((c) => blockOutputCeilingFromClaims(c).maxBrowsingLevel)
    ).toStrictEqual(NOT_SIGNED_IN.map((c) => resolveViewerBrowsingLevel(c)));
  });

  it('is resolveViewerBrowsingLevel of the PG-13-floored level for a signed-in viewer', () => {
    expect(SIGNED_IN.map((c) => blockOutputCeilingFromClaims(c).maxBrowsingLevel)).toStrictEqual(
      SIGNED_IN.map((c) => resolveViewerBrowsingLevel(floored(c)))
    );
  });

  it('LITERALS for the signed-in rows, so the floor is not only checked against itself', () => {
    expect(SIGNED_IN.map((c) => blockOutputCeilingFromClaims(c).maxBrowsingLevel)).toStrictEqual([
      1, 1, 3, 7, 19, 1, 3, 3,
    ]);
  });

  it('the resolver itself is NOT floored: a signed-in PG viewer reads PG there', () => {
    expect(
      resolveViewerBrowsingLevel({ maxBrowsingLevel: DOMAIN_TO_R, viewerBrowsingLevel: 1 })
    ).toBe(1);
  });

  it('CONTROL: the matrix is not degenerate (it resolves to several levels)', () => {
    expect(
      new Set(SIGNED_IN.map((c) => resolveViewerBrowsingLevel(floored(c)))).size
    ).toBeGreaterThan(3);
    expect(new Set(NOT_SIGNED_IN.map((c) => resolveViewerBrowsingLevel(c))).size).toBeGreaterThan(
      2
    );
  });
});
