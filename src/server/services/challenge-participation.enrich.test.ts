import { describe, it, expect } from 'vitest';
import { ChallengeStatus, ChallengeSource } from '~/shared/utils/prisma/enums';
import { enrichParticipatedCards } from './challenge-participation.util';

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
const img = { id: 99, url: 'u', nsfwLevel: 1, hash: 'h', width: 512, height: 512, type: 'image' };

describe('enrichParticipatedCards', () => {
  it('attaches entry image, place, derived result, entered-at', () => {
    const [out] = enrichParticipatedCards(
      [baseCard],
      [{ id: 10, myImageId: 99, myPlace: 1, myEnteredAt: new Date('2026-01-03') }],
      [img]
    );
    expect(out.myEntryImage?.id).toBe(99);
    expect(out.myPlace).toBe(1);
    expect(out.myResult).toBe('won');
    expect(out.isLive).toBe(false);
    expect(out.myEnteredAt).toEqual(new Date('2026-01-03'));
  });
  it('falls back to challenge cover when entry image missing', () => {
    const withCover = { ...baseCard, coverImage: { ...img, id: 7 } };
    const [out] = enrichParticipatedCards(
      [withCover],
      [{ id: 10, myImageId: null, myPlace: null, myEnteredAt: new Date('2026-01-03') }],
      []
    );
    expect(out.myEntryImage?.id).toBe(7); // fell back to challenge cover
    expect(out.myResult).toBe('entered');
  });
});
