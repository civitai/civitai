import { dbRead } from '~/server/db/client';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { throwBadRequestError } from '~/server/utils/errorHandling';

// A user challenge accepts entries only once it is Active (⟹ Scanned ⟹ text frozen). While it is
// still Scheduled the submission window may already be open, but the entry-fee charge silently
// no-ops (it requires Active), so the entry would commit for free — and the still-mutable/rescannable
// text could later flip NSFW and cancel the challenge out from under entrants. Reject until Active.
// No-op for daily/system challenges and non-challenge contest collections (findFirst → null).
export async function assertUserChallengeAcceptingEntries(
  collectionId: number,
  // Callers that already fetched the owning source=User challenge (e.g. the collection-entry
  // validator) pass it here to skip a duplicate lookup: an object (or `null` for "no such
  // challenge"). Omit to have this fetch it.
  preloaded?: { status: ChallengeStatus } | null
): Promise<void> {
  const userChallenge =
    preloaded !== undefined
      ? preloaded
      : await dbRead.challenge.findFirst({
          where: { collectionId, source: ChallengeSource.User },
          select: { status: true },
        });
  if (userChallenge && userChallenge.status !== ChallengeStatus.Active) {
    throw throwBadRequestError('Challenge is starting shortly, please try again in a few minutes.');
  }
}
