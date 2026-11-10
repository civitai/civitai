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
});
