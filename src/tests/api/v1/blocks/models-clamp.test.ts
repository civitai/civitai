import { describe, it, expect } from 'vitest';

import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Security unit tests for the authoritative catalog maturity clamp.
 *
 * The clamp derives the EFFECTIVE browsing level SOLELY from the token's
 * `maxBrowsingLevel` domain ceiling. The client cannot widen it.
 */
describe('resolveCatalogBrowsingLevel (authoritative maturity clamp)', () => {
  it('a SFW ceiling (green/blue domain) clamps to SFW', () => {
    const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel({
      maxBrowsingLevel: sfwBrowsingLevelsFlag,
    });
    expect(browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(isSfwCeiling).toBe(true);
    // No nsfw bits leak through.
    expect(browsingLevel & ~sfwBrowsingLevelsFlag).toBe(0);
  });

  it('a red ceiling (all levels) is unclamped — mature allowed', () => {
    const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel({
      maxBrowsingLevel: allBrowsingLevelsFlag,
    });
    expect(browsingLevel).toBe(allBrowsingLevelsFlag);
    expect(isSfwCeiling).toBe(false);
  });

  it('a MISSING claim fails CLOSED to SFW (legacy / pre-#2670 token)', () => {
    const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel({});
    expect(browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(isSfwCeiling).toBe(true);
  });

  it('a NON-FINITE claim fails CLOSED to SFW (defense in depth)', () => {
    for (const bad of [NaN, Infinity, -Infinity, 'x' as unknown as number]) {
      const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel({
        maxBrowsingLevel: bad,
      });
      expect(browsingLevel).toBe(sfwBrowsingLevelsFlag);
      expect(isSfwCeiling).toBe(true);
    }
  });

  it('the clamp result is ALWAYS a subset of the ceiling — cannot widen', () => {
    // Property: for any ceiling, the effective level ⊆ ceiling. A SFW ceiling
    // can therefore never produce a mature bit, no matter the implementation.
    for (const ceiling of [sfwBrowsingLevelsFlag, allBrowsingLevelsFlag, 1, 7]) {
      const { browsingLevel } = resolveCatalogBrowsingLevel({ maxBrowsingLevel: ceiling });
      // browsingLevel & ~ceiling === 0  ⇔  browsingLevel ⊆ ceiling
      expect(browsingLevel & ~ceiling).toBe(0);
    }
  });

  it('a SFW ceiling never carries the R/X/XXX nsfw bits', () => {
    const { browsingLevel } = resolveCatalogBrowsingLevel({
      maxBrowsingLevel: sfwBrowsingLevelsFlag,
    });
    const nsfwBits = 4 | 8 | 16; // R | X | XXX
    expect(browsingLevel & nsfwBits).toBe(0);
  });
});
