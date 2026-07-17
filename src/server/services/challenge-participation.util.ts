import { ChallengeStatus } from '~/shared/utils/prisma/enums';

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
