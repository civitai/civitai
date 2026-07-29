import { describe, expect, it } from 'vitest';
import {
  allBrowsingLevelsFlag,
  allowMatureContentForCeiling,
  contentRatingFromNsfwLevel,
  deriveContentRatingFromAssets,
  domainBrowsingCeiling,
  nsfwBrowsingLevelsFlag,
  nsfwLevelFromContentRating,
  OFFSITE_CONTENT_RATING_LADDER,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { OFFSITE_CONTENT_RATINGS } from '~/server/schema/blocks/offsite-listing.schema';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

/**
 * App Blocks maturity policy — the single source of truth.
 *
 * `domainBrowsingCeiling` maps a color domain to the max browsing-level flag a
 * block on that domain may render/generate. PRODUCT DECISION: green AND blue
 * both clamp to SFW; only red permits mature. Unknown/missing domains fail
 * CLOSED to SFW.
 */
describe('domainBrowsingCeiling', () => {
  it('green → SFW (PG + PG13)', () => {
    expect(domainBrowsingCeiling('green')).toBe(sfwBrowsingLevelsFlag);
  });

  it('blue → SFW (product decision — deliberately NOT mature)', () => {
    expect(domainBrowsingCeiling('blue')).toBe(sfwBrowsingLevelsFlag);
  });

  it('blue maps to the SAME ceiling as green', () => {
    expect(domainBrowsingCeiling('blue')).toBe(domainBrowsingCeiling('green'));
  });

  it('red → all browsing levels (no clamp)', () => {
    expect(domainBrowsingCeiling('red')).toBe(allBrowsingLevelsFlag);
  });

  it('SFW ceiling contains NO nsfw bits', () => {
    expect(Flags.intersects(domainBrowsingCeiling('green'), nsfwBrowsingLevelsFlag)).toBe(false);
    expect(Flags.intersects(domainBrowsingCeiling('blue'), nsfwBrowsingLevelsFlag)).toBe(false);
  });

  it('red ceiling DOES contain nsfw bits', () => {
    expect(Flags.intersects(domainBrowsingCeiling('red'), nsfwBrowsingLevelsFlag)).toBe(true);
  });

  it('fails CLOSED to SFW on undefined domain', () => {
    expect(domainBrowsingCeiling(undefined)).toBe(sfwBrowsingLevelsFlag);
  });

  it('fails CLOSED to SFW on null domain', () => {
    expect(domainBrowsingCeiling(null)).toBe(sfwBrowsingLevelsFlag);
  });

  it('fails CLOSED to SFW on an unknown domain value', () => {
    // Cast through unknown — defends the runtime default branch even if a
    // future caller passes a value outside the ColorDomain union.
    expect(domainBrowsingCeiling('purple' as unknown as 'green')).toBe(sfwBrowsingLevelsFlag);
  });

  it('the SFW ceiling is never the empty (0) flag — a clamp must always permit PG', () => {
    expect(domainBrowsingCeiling(undefined)).not.toBe(0);
    // PG must always be permitted on a SFW domain.
    expect(Flags.intersects(domainBrowsingCeiling('green'), publicBrowsingLevelsFlag)).toBe(true);
  });
});

describe('allowMatureContentForCeiling', () => {
  it('SFW ceiling → false (block mature output)', () => {
    expect(allowMatureContentForCeiling(sfwBrowsingLevelsFlag)).toBe(false);
  });

  it('PG-only ceiling → false', () => {
    expect(allowMatureContentForCeiling(publicBrowsingLevelsFlag)).toBe(false);
  });

  it('all-levels ceiling → undefined (no clamp)', () => {
    expect(allowMatureContentForCeiling(allBrowsingLevelsFlag)).toBeUndefined();
  });

  it('a ceiling carrying even a single nsfw bit → undefined (no clamp)', () => {
    // NsfwLevel.R = 4 → mature allowed.
    expect(allowMatureContentForCeiling(4)).toBeUndefined();
  });

  it('an empty (0) ceiling → false (most restrictive)', () => {
    expect(allowMatureContentForCeiling(0)).toBe(false);
  });

  it('composes with domainBrowsingCeiling: green/blue → false, red → undefined', () => {
    expect(allowMatureContentForCeiling(domainBrowsingCeiling('green'))).toBe(false);
    expect(allowMatureContentForCeiling(domainBrowsingCeiling('blue'))).toBe(false);
    expect(allowMatureContentForCeiling(domainBrowsingCeiling('red'))).toBeUndefined();
    expect(allowMatureContentForCeiling(domainBrowsingCeiling(undefined))).toBe(false);
  });
});

/**
 * Off-site content-rating derive (App Blocks W13). The scanner's per-image rating
 * is imprecise, so the AUTHOR is never blocked on it — the authoritative rating is
 * DERIVED from the assets' max detected nsfwLevel at review + a mod override
 * (floored). The forward (`nsfwLevelFromContentRating`) + inverse
 * (`contentRatingFromNsfwLevel`) must round-trip and fail CLOSED (never under-rate).
 */
describe('off-site content-rating derive', () => {
  it('the ladder is kept in sync with the schema OFFSITE_CONTENT_RATINGS', () => {
    expect([...OFFSITE_CONTENT_RATING_LADDER]).toEqual([...OFFSITE_CONTENT_RATINGS]);
  });

  it('nsfwLevelFromContentRating: g/pg → PG, and the rest via the orchestrator map', () => {
    expect(nsfwLevelFromContentRating('g')).toBe(NsfwLevel.PG);
    expect(nsfwLevelFromContentRating('pg')).toBe(NsfwLevel.PG);
    expect(nsfwLevelFromContentRating('pg13')).toBe(NsfwLevel.PG13);
    expect(nsfwLevelFromContentRating('r')).toBe(NsfwLevel.R);
    expect(nsfwLevelFromContentRating('x')).toBe(NsfwLevel.X);
    // null / unknown fail CLOSED to PG (never widen on ambiguity).
    expect(nsfwLevelFromContentRating(null)).toBe(NsfwLevel.PG);
    expect(nsfwLevelFromContentRating('bogus')).toBe(NsfwLevel.PG);
  });

  it('contentRatingFromNsfwLevel maps each level to the MINIMAL covering rating', () => {
    expect(contentRatingFromNsfwLevel(NsfwLevel.PG)).toBe('g'); // g and pg share the PG ceiling → g is minimal
    expect(contentRatingFromNsfwLevel(NsfwLevel.PG13)).toBe('pg13');
    expect(contentRatingFromNsfwLevel(NsfwLevel.R)).toBe('r');
    expect(contentRatingFromNsfwLevel(NsfwLevel.X)).toBe('x');
    // No maturity signal → the lowest rating.
    expect(contentRatingFromNsfwLevel(0)).toBe('g');
  });

  it('fails CLOSED for a level above the x ceiling (XXX / Blocked) → the TOP rating', () => {
    expect(contentRatingFromNsfwLevel(NsfwLevel.XXX)).toBe('x');
    expect(contentRatingFromNsfwLevel(NsfwLevel.Blocked)).toBe('x');
  });

  it('reads the HIGHEST bit of a composite level (never a lower one)', () => {
    // Composite PG | R → the R bit governs → 'r' (not 'g').
    expect(contentRatingFromNsfwLevel(NsfwLevel.PG | NsfwLevel.R)).toBe('r');
  });

  it('deriveContentRatingFromAssets picks the rating covering the MAX asset level', () => {
    expect(
      deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.PG }, { nsfwLevel: NsfwLevel.R }])
    ).toBe('r');
    expect(
      deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.PG }, { nsfwLevel: NsfwLevel.PG13 }])
    ).toBe('pg13');
    // All PG → g (g/pg share the PG ceiling, g is minimal).
    expect(deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.PG }])).toBe('g');
  });

  it('deriveContentRatingFromAssets is fail-safe for empty / null / undefined levels → g', () => {
    expect(deriveContentRatingFromAssets([])).toBe('g');
    expect(deriveContentRatingFromAssets([{ nsfwLevel: null }, { nsfwLevel: undefined }])).toBe('g');
    expect(deriveContentRatingFromAssets([{}])).toBe('g');
  });

  it('deriveContentRatingFromAssets fails CLOSED to the top rating for an XXX asset', () => {
    expect(deriveContentRatingFromAssets([{ nsfwLevel: NsfwLevel.XXX }])).toBe('x');
  });
});
