import { describe, expect, it } from 'vitest';
import {
  allBrowsingLevelsFlag,
  allowMatureContentForCeiling,
  domainBrowsingCeiling,
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
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
