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
const img = { id: 99, url: 'u', nsfwLevel: 1, hash: 'h', width: 512, height: 512, type: 'image' as const };

describe('enrichMyChallengeCards', () => {
  it('attaches entry image, place, derived result, activity-at', () => {
    const [out] = enrichMyChallengeCards(
      [baseCard],
      [{ id: 10, myImageId: 99, myPlace: 1, myActivityAt: new Date('2026-01-03'), isCreator: false }],
      [img]
    );
    expect(out.myEntryImage?.id).toBe(99);
    expect(out.myPlace).toBe(1);
    expect(out.myResult).toBe('won');
    expect(out.isLive).toBe(false);
    expect(out.myActivityAt).toEqual(new Date('2026-01-03'));
  });
  it('leaves myEntryImage null when the entry image is missing', () => {
    const cover = { ...img, id: 7 };
    const [out] = enrichMyChallengeCards(
      [{ ...baseCard, coverImage: cover }],
      [{ id: 10, myImageId: null, myPlace: null, myActivityAt: new Date('2026-01-03'), isCreator: false }],
      []
    );
    expect(out.myEntryImage).toBeNull();
    expect(out.coverImage).toEqual(cover);
    expect(out.myResult).toBe('entered');
  });
});

describe('enrichMyChallengeCards — the card renders the challenge cover', () => {
  const cover = { id: 1, url: 'cover', nsfwLevel: 1, hash: null, width: 10, height: 10, type: 'image' as const };
  const entry = { id: 2, url: 'entry', nsfwLevel: 1, hash: null, width: 10, height: 10, type: 'image' as const };

  it('coverImage stays the challenge cover even when an entry image exists', () => {
    const [out] = enrichMyChallengeCards(
      [{ ...baseCard, coverImage: cover }],
      [{ id: baseCard.id, myImageId: 2, myPlace: null, myActivityAt: new Date(), isCreator: false }],
      [entry]
    );
    expect(out.coverImage).toEqual(cover);
  });

  it('myEntryImage is the entry image, for the View entry link', () => {
    const [out] = enrichMyChallengeCards(
      [{ ...baseCard, coverImage: cover }],
      [{ id: baseCard.id, myImageId: 2, myPlace: null, myActivityAt: new Date(), isCreator: false }],
      [entry]
    );
    expect(out.myEntryImage).toEqual(entry);
  });

  it('a hosted challenge has no entry image', () => {
    const [out] = enrichMyChallengeCards(
      [{ ...baseCard, coverImage: cover }],
      [{ id: baseCard.id, myImageId: null, myPlace: null, myActivityAt: new Date(), isCreator: true }],
      []
    );
    expect(out.myEntryImage).toBeNull();
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
