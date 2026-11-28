import { describe, expect, it } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import { resolveCatalogViewerBrowsingLevel } from '~/server/utils/block-catalog-viewer-level';

// Literal flags, not the constants under test: PG 1, PG13 2, R 4, X 8, XXX 16, Blocked 32.
const SFW = 1 | 2;
const ALL = 1 | 2 | 4 | 8 | 16;

describe('resolveCatalogViewerBrowsingLevel — the main site rule (requested & cap) || cap', () => {
  it.each([
    // [label, maxBrowsingLevel, viewerBrowsingLevel, regionRestricted, expected]
    ['red domain, PG viewer → PG', ALL, NsfwLevel.PG, false, 1],
    ['red domain, PG/PG13/R viewer → those three', ALL, 1 | 2 | 4, false, 1 | 2 | 4],
    ['red domain, full viewer → every selectable level', ALL, ALL, false, ALL],
    ['viewer wider than the domain is held to it', SFW, ALL, false, SFW],
    ['viewer level 0 on a SFW domain → the SFW cap', SFW, 0, false, SFW],
    ['viewer level 0 on a capped red domain → that cap', 1 | 2 | 4, 0, false, 1 | 2 | 4],
    ['region over a mature-only viewer → the SFW cap', ALL, 4 | 8 | 16, true, SFW],
    ['region over a PG viewer stays PG', ALL, NsfwLevel.PG, true, 1],
    ['region over a full viewer → SFW', ALL, ALL, true, SFW],
    ['no viewer claim (legacy) → PG', ALL, undefined, false, 1],
    ['no claims at all → PG', undefined, undefined, false, 1],
    ['a negative viewer claim is not every bit → PG', ALL, -1, false, 1],
    ['a non-integer viewer claim → PG', ALL, 1.5, false, 1],
    ['an empty domain ceiling → 0 (serve nothing)', 0, undefined, false, 0],
  ])('%s', (_label, maxBrowsingLevel, viewerBrowsingLevel, regionRestricted, expected) => {
    expect(
      resolveCatalogViewerBrowsingLevel(
        { maxBrowsingLevel, viewerBrowsingLevel },
        { regionRestricted }
      )
    ).toBe(expected);
  });

  it('never returns Blocked, even when a claim carries it', () => {
    expect(
      resolveCatalogViewerBrowsingLevel({
        maxBrowsingLevel: ALL | 32,
        viewerBrowsingLevel: ALL | 32,
      })
    ).toBe(ALL);
    expect(
      resolveCatalogViewerBrowsingLevel({ maxBrowsingLevel: 32, viewerBrowsingLevel: 0 })
    ).toBe(0);
  });

  it('is never wider than the domain cap, for every viewer level', () => {
    for (const cap of [1, SFW, 1 | 2 | 4, ALL]) {
      for (let viewer = 0; viewer <= ALL; viewer++) {
        const level = resolveCatalogViewerBrowsingLevel({
          maxBrowsingLevel: cap,
          viewerBrowsingLevel: viewer,
        });
        expect(level & ~cap).toBe(0);
        // Never above the viewer's own level when it shares any level with the cap.
        if (viewer & cap) expect(level & ~viewer).toBe(0);
      }
    }
  });
});
