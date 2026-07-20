import { dbRead } from '~/server/db/client';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { throwBadRequestError } from '~/server/utils/errorHandling';

// A user challenge accepts entries only once it is Active (⟹ Scanned ⟹ text frozen). While it is
// still Scheduled the submission window may already be open, but the entry-fee charge silently
// no-ops (it requires Active), so the entry would commit for free — and the still-mutable/rescannable
// text could later flip NSFW and cancel the challenge out from under entrants. Reject until Active.
// No-op for daily/system challenges and non-challenge contest collections (findFirst → null).
export async function assertUserChallengeAcceptingEntries(collectionId: number): Promise<void> {
  const userChallenge = await dbRead.challenge.findFirst({
    where: { collectionId, source: ChallengeSource.User },
    select: { status: true },
  });
  if (userChallenge && userChallenge.status !== ChallengeStatus.Active) {
    throw throwBadRequestError('Challenge is starting shortly, please try again in a few minutes.');
  }
}
