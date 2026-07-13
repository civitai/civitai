import { describe, expect, it } from 'vitest';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { isChallengeHiddenByPoiCover } from './challenge-visibility';

describe('isChallengeHiddenByPoiCover', () => {
  const userPoi = { source: ChallengeSource.User, createdById: 10, coverPoi: true };

  it('hides a user challenge with a POI cover from a non-creator viewer', () => {
    expect(isChallengeHiddenByPoiCover(userPoi, 20)).toBe(true);
  });

  it('hides a user challenge with a POI cover from anonymous viewers', () => {
    expect(isChallengeHiddenByPoiCover(userPoi, undefined)).toBe(true);
  });

  it('lets the creator see their own POI-cover challenge (creator exempt)', () => {
    expect(isChallengeHiddenByPoiCover(userPoi, 10)).toBe(false);
  });

  it('does not hide a user challenge whose cover is not POI', () => {
    expect(
      isChallengeHiddenByPoiCover(
        { source: ChallengeSource.User, createdById: 10, coverPoi: false },
        20
      )
    ).toBe(false);
  });

  it('never hides trusted System/Mod challenges even with a POI cover', () => {
    expect(
      isChallengeHiddenByPoiCover({ source: ChallengeSource.System, createdById: 10, coverPoi: true }, 20)
    ).toBe(false);
    expect(
      isChallengeHiddenByPoiCover({ source: ChallengeSource.Mod, createdById: 10, coverPoi: true }, 20)
    ).toBe(false);
  });
});
