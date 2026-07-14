import { describe, expect, it } from 'vitest';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { isChallengeCoverScanned, isChallengeHiddenByPoiCover } from './challenge-visibility';

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

describe('isChallengeCoverScanned', () => {
  it('false when cover image not yet scanned', () => {
    expect(isChallengeCoverScanned({ coverImage: { ingestion: 'Pending' } } as any)).toBe(false);
  });

  it('true when cover image scanned and not blocked', () => {
    expect(isChallengeCoverScanned({ coverImage: { ingestion: 'Scanned' } } as any)).toBe(true);
  });

  it('false when blocked', () => {
    expect(isChallengeCoverScanned({ coverImage: { ingestion: 'Blocked' } } as any)).toBe(false);
  });

  it('false when there is no cover image', () => {
    expect(isChallengeCoverScanned({ coverImage: null } as any)).toBe(false);
  });
});
