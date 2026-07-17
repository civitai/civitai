import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import type { ChallengeListItem, MyParticipatedChallengeItem } from '~/server/schema/challenge.schema';

export type MyChallengeResult = 'won' | 'placed' | 'judging' | 'entered';

export function deriveMyChallengeResult(input: {
  status: ChallengeStatus;
  myPlace: number | null;
}): { result: MyChallengeResult; isLive: boolean } {
  const { status, myPlace } = input;
  if (status === ChallengeStatus.Completed) {
    if (myPlace === 1) return { result: 'won', isLive: false };
    if (myPlace != null && myPlace > 1) return { result: 'placed', isLive: false };
    return { result: 'entered', isLive: false };
  }
  if (status === ChallengeStatus.Completing) return { result: 'judging', isLive: false };
  // Active (or any other state a user could have entered)
  return { result: 'entered', isLive: status === ChallengeStatus.Active };
}

// Pure: zip base cards + raw my-fields + hydrated entry images into MyParticipatedChallengeItem.
// Rows/baseCards are index-aligned (mapChallengeRowsToCards preserves input order). Lives here
// (not challenge.service.ts) so it stays unit-testable without pulling in that ~8K-line module.
export function enrichParticipatedCards(
  baseCards: ChallengeListItem[],
  rows: { id: number; myImageId: number | null; myPlace: number | null; myEnteredAt: Date }[],
  entryImages: Array<NonNullable<ChallengeListItem['coverImage']>>
): MyParticipatedChallengeItem[] {
  return baseCards.map((card, i) => {
    const row = rows[i];
    const entryImg = row.myImageId ? entryImages.find((img) => img.id === row.myImageId) : null;
    const { result, isLive } = deriveMyChallengeResult({ status: card.status, myPlace: row.myPlace });
    return {
      ...card,
      myEntryImage: entryImg ?? card.coverImage ?? null,
      myPlace: row.myPlace,
      myResult: result,
      isLive,
      myEnteredAt: row.myEnteredAt,
    };
  });
}
