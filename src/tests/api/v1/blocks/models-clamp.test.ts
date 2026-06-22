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

  describe('region restriction clamp (GA-safety gap close)', () => {
    it('a RED ceiling is narrowed to SFW when the region is restricted', () => {
      const open = resolveCatalogBrowsingLevel({ maxBrowsingLevel: allBrowsingLevelsFlag });
      expect(open.isSfwCeiling).toBe(false); // sanity: unrestricted red allows mature

      const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(
        { maxBrowsingLevel: allBrowsingLevelsFlag },
        { regionRestricted: true }
      );
      expect(browsingLevel).toBe(sfwBrowsingLevelsFlag);
      expect(isSfwCeiling).toBe(true);
      const nsfwBits = 4 | 8 | 16; // R | X | XXX
      expect(browsingLevel & nsfwBits).toBe(0);
    });

    it('regionRestricted:false (default) leaves the ceiling clamp unchanged', () => {
      const a = resolveCatalogBrowsingLevel({ maxBrowsingLevel: allBrowsingLevelsFlag });
      const b = resolveCatalogBrowsingLevel(
        { maxBrowsingLevel: allBrowsingLevelsFlag },
        { regionRestricted: false }
      );
      expect(b.browsingLevel).toBe(a.browsingLevel);
      expect(b.isSfwCeiling).toBe(a.isSfwCeiling);
    });

    it('region restriction can only NARROW — never widens a sub-SFW ceiling', () => {
      // A green block whose ceiling is a strict subset of the SFW set (e.g. only
      // the lowest bit) must NOT be widened back up to the full SFW flag.
      const subSfw = 1; // single lowest browsing-level bit, ⊂ sfwBrowsingLevelsFlag
      const { browsingLevel } = resolveCatalogBrowsingLevel(
        { maxBrowsingLevel: subSfw },
        { regionRestricted: true }
      );
      // Result ⊆ original ceiling clamp (no new bits) AND ⊆ SFW.
      expect(browsingLevel & ~subSfw).toBe(0);
      expect(browsingLevel & ~sfwBrowsingLevelsFlag).toBe(0);
      expect(browsingLevel).toBe(subSfw);
    });

    it('a MISSING claim in a restricted region stays fail-closed SFW', () => {
      const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(
        {},
        { regionRestricted: true }
      );
      expect(browsingLevel).toBe(sfwBrowsingLevelsFlag);
      expect(isSfwCeiling).toBe(true);
    });
  });
});
