import { describe, it, expect } from 'vitest';
import {
  resolveCatalogBrowsingLevel,
  resourceExceedsCatalogCeiling,
} from '~/server/utils/block-catalog-maturity';
import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';

/**
 * Custom Generators (Phase-2a PR-C) — resourceExceedsCatalogCeiling drives the
 * generation-resources rehydrate endpoint's maturity clamp (drop mature resources
 * from a SFW-domain block). resolveCatalogBrowsingLevel is re-exercised for the
 * clamp bits the endpoint relies on.
 */

describe('resourceExceedsCatalogCeiling', () => {
  const sfw = sfwBrowsingLevelsFlag; // PG | PG-13
  const all = allBrowsingLevelsFlag;

  it('SFW resource (PG cover) is WITHIN a SFW ceiling', () => {
    expect(resourceExceedsCatalogCeiling({ imageNsfwLevel: NsfwLevel.PG }, sfw)).toBe(false);
    expect(resourceExceedsCatalogCeiling({ imageNsfwLevel: NsfwLevel.PG13 }, sfw)).toBe(false);
  });

  it('mature resource (R cover) EXCEEDS a SFW ceiling', () => {
    expect(resourceExceedsCatalogCeiling({ imageNsfwLevel: NsfwLevel.R }, sfw)).toBe(true);
    expect(resourceExceedsCatalogCeiling({ imageNsfwLevel: NsfwLevel.X }, sfw)).toBe(true);
  });

  it('mature resource is WITHIN the full (red) ceiling', () => {
    expect(resourceExceedsCatalogCeiling({ imageNsfwLevel: NsfwLevel.R }, all)).toBe(false);
  });

  it('a mature-flagged MODEL with no cover level still counts as mature under SFW', () => {
    expect(resourceExceedsCatalogCeiling({ modelNsfw: true }, sfw)).toBe(true);
    expect(resourceExceedsCatalogCeiling({ modelNsfw: true }, all)).toBe(false);
  });

  it('no maturity signal (level 0, not model-nsfw) is WITHIN any ceiling', () => {
    expect(resourceExceedsCatalogCeiling({ imageNsfwLevel: 0 }, sfw)).toBe(false);
    expect(resourceExceedsCatalogCeiling({}, sfw)).toBe(false);
    expect(resourceExceedsCatalogCeiling({ imageNsfwLevel: null, modelNsfw: false }, sfw)).toBe(
      false
    );
  });
});

describe('resolveCatalogBrowsingLevel (clamp bits the endpoint depends on)', () => {
  it('missing claim fails closed to SFW', () => {
    const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel({});
    expect(browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(isSfwCeiling).toBe(true);
  });
  it('red ceiling is not SFW', () => {
    const { isSfwCeiling } = resolveCatalogBrowsingLevel({ maxBrowsingLevel: allBrowsingLevelsFlag });
    expect(isSfwCeiling).toBe(false);
  });
  it('region-restricted narrows a red ceiling to SFW', () => {
    const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(
      { maxBrowsingLevel: allBrowsingLevelsFlag },
      { regionRestricted: true }
    );
    expect(browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(isSfwCeiling).toBe(true);
  });
});
