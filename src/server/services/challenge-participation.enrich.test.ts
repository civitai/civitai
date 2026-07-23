import { describe, it, expect } from 'vitest';
import { ChallengeStatus, ChallengeSource } from '~/shared/utils/prisma/enums';
import {
  deriveMyChallengeResult,
  enrichMyChallengeCards,
} from './challenge-participation.util';

const baseCard = {
  id: 10,
  title: 'Crystal',
  theme: 'Crystals',
  invitation: null,
  startsAt: new Date('2026-01-01'),
  endsAt: new Date('2026-01-02'),
  status: ChallengeStatus.Completed,
  source: ChallengeSource.System,
  createdById: 1,
  prizePool: 9000,
  nsfwLevel: 1,
  allowedNsfwLevel: 1,
  collectionId: 5,
  entryCount: 3,
  commentCount: 0,
  coverImage: null,
  modelVersionIds: [],
  createdBy: { id: 1, username: 'CivBot', image: null, profilePicture: null, cosmetics: null, deletedAt: null },
} as any;

describe('enrichMyChallengeCards', () => {
  it('attaches place, derived result, activity-at', () => {
    const [out] = enrichMyChallengeCards(
      [baseCard],
      [{ id: 10, myPlace: 1, myActivityAt: new Date('2026-01-03'), isCreator: false }]
    );
    expect(out.myPlace).toBe(1);
    expect(out.myResult).toBe('won');
    expect(out.isLive).toBe(false);
    expect(out.myActivityAt).toEqual(new Date('2026-01-03'));
  });
});

describe('enrichMyChallengeCards — the card renders the challenge cover', () => {
  const cover = { id: 1, url: 'cover', nsfwLevel: 1, hash: null, width: 10, height: 10, type: 'image' as const };

  it('coverImage stays the challenge cover', () => {
    const [out] = enrichMyChallengeCards(
      [{ ...baseCard, coverImage: cover }],
      [{ id: baseCard.id, myPlace: null, myActivityAt: new Date(), isCreator: false }]
    );
    expect(out.coverImage).toEqual(cover);
    expect(out.myResult).toBe('entered');
  });

  it('a creator gets the hosting result', () => {
    const [out] = enrichMyChallengeCards(
      [{ ...baseCard, coverImage: cover }],
      [{ id: baseCard.id, myPlace: null, myActivityAt: new Date(), isCreator: true }]
    );
    expect(out.coverImage).toEqual(cover);
    expect(out.myResult).toBe('hosting');
  });
});

describe('deriveMyChallengeResult — hosting', () => {
  it('a creator gets hosting regardless of status', () => {
    expect(
      deriveMyChallengeResult({
        status: ChallengeStatus.Scheduled,
        myPlace: null,
        isCreator: true,
      })
    ).toEqual({ result: 'hosting', isLive: false });
  });

  it('a live hosted challenge is marked live', () => {
    expect(
      deriveMyChallengeResult({ status: ChallengeStatus.Active, myPlace: null, isCreator: true })
    ).toEqual({ result: 'hosting', isLive: true });
  });

  it('a completed hosted challenge is hosting, not entered', () => {
    expect(
      deriveMyChallengeResult({
        status: ChallengeStatus.Completed,
        myPlace: null,
        isCreator: true,
      })
    ).toEqual({ result: 'hosting', isLive: false });
  });

  it('a non-creator entrant is unaffected', () => {
    expect(
      deriveMyChallengeResult({ status: ChallengeStatus.Active, myPlace: null, isCreator: false })
    ).toEqual({ result: 'entered', isLive: true });
  });
});
