import { describe, expect, it } from 'vitest';
import {
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';
import {
  getEffectiveBrowsingLevel,
  isChallengeCoverScanned,
  isChallengeHiddenByCoverScan,
  isChallengeHiddenByPoiCover,
  isImageHiddenFromGreenViewer,
} from './challenge-visibility';

describe('getEffectiveBrowsingLevel', () => {
  it('clamps a crafted NSFW request to SFW on green (logged-in)', () => {
    const lvl = getEffectiveBrowsingLevel({
      isGreen: true,
      isLoggedIn: true,
      requested: nsfwBrowsingLevelsFlag,
    });
    expect(Flags.intersects(lvl, nsfwBrowsingLevelsFlag)).toBe(false);
    expect(lvl).toBe(nsfwBrowsingLevelsFlag & sfwBrowsingLevelsFlag); // === 0, no allowed bits
  });

  it('falls back to the SFW cap on green when no level is requested (no bypass by omission)', () => {
    expect(getEffectiveBrowsingLevel({ isGreen: true, isLoggedIn: true })).toBe(
      sfwBrowsingLevelsFlag
    );
  });

  it('caps anonymous green viewers to PG only', () => {
    expect(getEffectiveBrowsingLevel({ isGreen: true, isLoggedIn: false })).toBe(
      publicBrowsingLevelsFlag
    );
  });

  it('passes the request through unchanged off green', () => {
    expect(getEffectiveBrowsingLevel({ isGreen: false, isLoggedIn: true, requested: 28 })).toBe(28);
  });

  it('returns 0 (no filter) off green when nothing is requested', () => {
    expect(getEffectiveBrowsingLevel({ isGreen: false, isLoggedIn: false })).toBe(0);
  });
});

describe('isImageHiddenFromGreenViewer', () => {
  it('shows a PG image to a logged-in viewer', () => {
    expect(isImageHiddenFromGreenViewer(NsfwLevel.PG, 5)).toBe(false);
  });

  it('shows PG-13 to a logged-in viewer but hides it from anonymous', () => {
    expect(isImageHiddenFromGreenViewer(NsfwLevel.PG13, 5)).toBe(false);
    expect(isImageHiddenFromGreenViewer(NsfwLevel.PG13, undefined)).toBe(true);
  });

  it('hides mature images from any green viewer', () => {
    expect(isImageHiddenFromGreenViewer(NsfwLevel.R, 5)).toBe(true);
    expect(isImageHiddenFromGreenViewer(NsfwLevel.X, 5)).toBe(true);
    expect(isImageHiddenFromGreenViewer(NsfwLevel.XXX, undefined)).toBe(true);
  });

  it('treats unknown/unrated (null or 0) as unsafe', () => {
    expect(isImageHiddenFromGreenViewer(null, 5)).toBe(true);
    expect(isImageHiddenFromGreenViewer(0, 5)).toBe(true);
    expect(isImageHiddenFromGreenViewer(undefined, undefined)).toBe(true);
  });
});

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

describe('isChallengeHiddenByCoverScan', () => {
  it('hides a user challenge with an unscanned cover from a non-creator viewer', () => {
    expect(
      isChallengeHiddenByCoverScan(
        {
          source: ChallengeSource.User,
          createdById: 10,
          coverImage: { ingestion: 'Pending' } as any,
        },
        20
      )
    ).toBe(true);
  });

  it('lets the creator see their own pre-scan challenge (creator exempt)', () => {
    expect(
      isChallengeHiddenByCoverScan(
        {
          source: ChallengeSource.User,
          createdById: 10,
          coverImage: { ingestion: 'Pending' } as any,
        },
        10
      )
    ).toBe(false);
  });

  it('does not hide a user challenge once the cover is scanned', () => {
    expect(
      isChallengeHiddenByCoverScan(
        {
          source: ChallengeSource.User,
          createdById: 10,
          coverImage: { ingestion: 'Scanned' } as any,
        },
        20
      )
    ).toBe(false);
  });

  it('never hides trusted System/Mod challenges even with an unscanned cover (feed/detail parity)', () => {
    expect(
      isChallengeHiddenByCoverScan(
        {
          source: ChallengeSource.System,
          createdById: 10,
          coverImage: { ingestion: 'Pending' } as any,
        },
        20
      )
    ).toBe(false);
    expect(
      isChallengeHiddenByCoverScan(
        { source: ChallengeSource.Mod, createdById: 10, coverImage: { ingestion: 'Pending' } as any },
        20
      )
    ).toBe(false);
  });
});
