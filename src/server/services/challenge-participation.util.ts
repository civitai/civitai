import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import type {
  ChallengeListItem,
  MyChallengeResult,
  MyChallengeItem,
} from '~/server/schema/challenge.schema';

export function deriveMyChallengeResult(input: {
  status: ChallengeStatus;
  myPlace: number | null;
  isCreator: boolean;
}): { result: MyChallengeResult; isLive: boolean } {
  const { status, myPlace, isCreator } = input;
  // Creating and entering are mutually exclusive for regular users (self-entry is blocked), but
  // moderators are exempt from that guard (collection.service.ts) — a moderator who places in
  // their own challenge still shows hosting, not won, since ownership wins outright here.
  if (isCreator) return { result: 'hosting', isLive: status === ChallengeStatus.Active };
  if (status === ChallengeStatus.Completed) {
    if (myPlace === 1) return { result: 'won', isLive: false };
    if (myPlace != null && myPlace > 1) return { result: 'placed', isLive: false };
    return { result: 'entered', isLive: false };
  }
  if (status === ChallengeStatus.Completing) return { result: 'judging', isLive: false };
  return { result: 'entered', isLive: status === ChallengeStatus.Active };
}

// Pure: zip base cards + raw my-fields into MyChallengeItem.
// Rows/baseCards are index-aligned (mapChallengeRowsToCards preserves input order). Lives here
// (not challenge.service.ts) so it stays unit-testable without pulling in that ~8K-line module.
export function enrichMyChallengeCards(
  baseCards: ChallengeListItem[],
  rows: {
    id: number;
    myPlace: number | null;
    myActivityAt: Date;
    isCreator: boolean;
  }[]
): MyChallengeItem[] {
  return baseCards.map((card, i) => {
    const row = rows[i];
    const { result, isLive } = deriveMyChallengeResult({
      status: card.status,
      myPlace: row.myPlace,
      isCreator: row.isCreator,
    });
    return {
      ...card,
      myPlace: row.myPlace,
      myResult: result,
      isLive,
      myActivityAt: row.myActivityAt,
    };
  });
}
