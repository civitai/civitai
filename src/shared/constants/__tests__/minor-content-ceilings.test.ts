import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  exceedsModelBrowsingLevelLimit,
  forcedMinorModelBrowsingLevel,
  modelBrowsingLevelLimit,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  remixGalleryBlockedByMinorHost,
  remixGalleryLevelAllowed,
} from '~/shared/utils/remix-gallery';
import { storylineCeiling } from '~/shared/utils/storyline';

/**
 * RESTRICT sites of the minor content rule in its ceiling form: what a model, storyline or remix
 * host flagged as depicting a minor may show. Expected values are the ceilings as they stood before
 * the gates shared the rule.
 */

const { PG, PG13, R, X, XXX } = NsfwLevel;
const LEVELS = [PG, PG13, R, X, XXX];
const SAFE = new Set<number>([PG, PG13]);

describe('model ceilings', () => {
  it.each([
    [{ minor: true, sfwOnly: false }, sfwBrowsingLevelsFlag],
    [{ minor: true, sfwOnly: true }, sfwBrowsingLevelsFlag],
    [{ minor: false, sfwOnly: true }, sfwBrowsingLevelsFlag],
    [{ minor: false, sfwOnly: false }, allBrowsingLevelsFlag],
  ])('holds %o to %i', (model, limit) => {
    expect(modelBrowsingLevelLimit(model)).toBe(limit);
  });

  it.each(LEVELS)('a minor model refuses a rating %i only above safe for work', (level) => {
    expect(exceedsModelBrowsingLevelLimit(level, { minor: true, sfwOnly: false })).toBe(
      !SAFE.has(level)
    );
  });

  it('a minor model does not refuse an unrated (0) rating', () => {
    expect(exceedsModelBrowsingLevelLimit(0, { minor: true, sfwOnly: false })).toBe(false);
  });

  it('forces a minor model gallery to safe for work signed in, and public signed out', () => {
    expect(forcedMinorModelBrowsingLevel(true)).toBe(sfwBrowsingLevelsFlag);
    expect(forcedMinorModelBrowsingLevel(false)).toBe(publicBrowsingLevelsFlag);
  });
});

describe('storyline ceiling', () => {
  it.each(LEVELS)('a minor-flagged storyline set to %i is held to safe for work', (max) => {
    expect(storylineCeiling({ maxNsfwLevel: max, minorByScan: true })).toBe(Math.min(max, PG13));
    expect(storylineCeiling({ maxNsfwLevel: max, minorByScan: false })).toBe(max);
  });

  // 0 is not a valid ceiling (the CHECK on maxNsfwLevel refuses it); a 0 passed in stays 0.
  it('leaves an invalid 0 ceiling at 0, flagged or not', () => {
    expect(storylineCeiling({ maxNsfwLevel: 0, minorByScan: true })).toBe(0);
    expect(storylineCeiling({ maxNsfwLevel: 0, minorByScan: false })).toBe(0);
  });
});

describe('remix gallery minor host', () => {
  it.each(LEVELS)('takes a submission rated %i into a minor host only if safe', (level) => {
    const args = { rule: 'any' as const, submissionLevel: level, hostLevel: XXX };
    expect(remixGalleryLevelAllowed({ ...args, hostMinor: true })).toBe(SAFE.has(level));
    expect(remixGalleryBlockedByMinorHost({ submissionLevel: level, hostMinor: true })).toBe(
      !SAFE.has(level)
    );
    expect(remixGalleryLevelAllowed({ ...args, hostMinor: false })).toBe(true);
  });

  it('refuses an unrated (0) submission into any host, and not as the minor-host cap', () => {
    const args = { rule: 'any' as const, submissionLevel: 0, hostLevel: XXX };
    expect(remixGalleryLevelAllowed({ ...args, hostMinor: true })).toBe(false);
    expect(remixGalleryLevelAllowed({ ...args, hostMinor: false })).toBe(false);
    expect(remixGalleryBlockedByMinorHost({ submissionLevel: 0, hostMinor: true })).toBe(false);
  });
});
