import { describe, expect, it } from 'vitest';

import { resolveCatalogViewerMaturity } from '~/server/utils/block-catalog-viewer-level';

// Literal flags, not the constants under test: PG 1, PG13 2, R 4, X 8, XXX 16.
const ALL = 1 | 2 | 4 | 8 | 16;

describe('resolveCatalogViewerMaturity — the viewer level and its SFW-ceiling flag', () => {
  it.each([
    // [label, maxBrowsingLevel, viewerBrowsingLevel, regionRestricted, browsingLevel, isSfwCeiling]
    ['PG-only viewer on a red domain', ALL, 1, false, 1, true],
    ['PG13-only viewer on a red domain', ALL, 2, false, 2, true],
    ['PG + PG13 viewer on a red domain', ALL, 1 | 2, false, 1 | 2, true],
    ['a viewer level containing R', ALL, 1 | 2 | 4, false, 1 | 2 | 4, false],
    ['an R-only viewer', ALL, 4, false, 4, false],
    ['an X-only viewer', ALL, 8, false, 8, false],
    ['a full viewer on a red domain', ALL, ALL, false, ALL, false],
    ['a full viewer on a SFW domain', 1 | 2, ALL, false, 1 | 2, true],
    ['a full viewer, region-restricted', ALL, ALL, true, 1 | 2, true],
    ['no viewer claim (legacy) → PG', ALL, undefined, false, 1, true],
    ['an empty domain ceiling → 0, flagged SFW', 0, undefined, false, 0, true],
  ])(
    '%s',
    (
      _label,
      maxBrowsingLevel,
      viewerBrowsingLevel,
      regionRestricted,
      browsingLevel,
      isSfwCeiling
    ) => {
      expect(
        resolveCatalogViewerMaturity(
          { maxBrowsingLevel, viewerBrowsingLevel },
          { regionRestricted }
        )
      ).toEqual({ browsingLevel, isSfwCeiling });
    }
  );
});
