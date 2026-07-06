import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { getChallengeActiveLimit, CHALLENGE_MIN_CREATOR_SCORE } from '~/shared/constants/challenge.constants';
import { ChallengeSource, ChallengeStatus, StrikeStatus } from '~/shared/utils/prisma/enums';

function forbidden(message: string) {
  return new TRPCError({ code: 'FORBIDDEN', message });
}

type UserChallengeStanding = {
  scoreTotal: number;
  bannedAt: Date | null;
  muted: boolean;
  deletedAt: Date | null;
  activeStrikes: number;
};

export async function getUserChallengeStanding(userId: number): Promise<UserChallengeStanding> {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { meta: true, bannedAt: true, muted: true, deletedAt: true },
  });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

  const meta = (user.meta ?? {}) as { scores?: { total?: number } };
  const activeStrikes = await dbRead.userStrike.count({
    where: { userId, status: StrikeStatus.Active, expiresAt: { gt: new Date() } },
  });

  return {
    scoreTotal: meta.scores?.total ?? 0,
    bannedAt: user.bannedAt,
    muted: user.muted,
    deletedAt: user.deletedAt,
    activeStrikes,
  };
}

/** Throws unless the user is in good standing AND meets the creator-score threshold. */
export async function assertUserInGoodStanding(userId: number): Promise<UserChallengeStanding> {
  const standing = await getUserChallengeStanding(userId);
  if (standing.bannedAt || standing.deletedAt)
    throw forbidden('Your account is not eligible to create challenges.');
  if (standing.muted) throw forbidden('Muted accounts cannot create challenges.');
  if (standing.activeStrikes > 0)
    throw forbidden('Resolve your active strikes before creating a challenge.');
  if (standing.scoreTotal < CHALLENGE_MIN_CREATOR_SCORE)
    throw forbidden(
      `You need a creator score of at least ${CHALLENGE_MIN_CREATOR_SCORE.toLocaleString()} to create challenges.`
    );
  return standing;
}

/** Throws if the user already has as many Scheduled/Active challenges as their tier allows. */
export async function assertUnderActiveChallengeLimit(
  userId: number
): Promise<{ limit: number; activeCount: number }> {
  const [subscription, activeCount] = await Promise.all([
    getHighestTierSubscription(userId),
    dbRead.challenge.count({
      where: {
        createdById: userId,
        source: ChallengeSource.User,
        status: { in: [ChallengeStatus.Scheduled, ChallengeStatus.Active] },
      },
    }),
  ]);

  const limit = getChallengeActiveLimit(subscription?.tier);
  if (activeCount >= limit)
    throw forbidden(
      `You've reached your limit of ${limit} active challenge(s) for your membership tier.`
    );
  return { limit, activeCount };
}

/** Full gate for creating a new user challenge. */
export async function assertCanCreateUserChallenge(userId: number): Promise<void> {
  await assertUserInGoodStanding(userId);
  await assertUnderActiveChallengeLimit(userId);
}

/** Challenge creators may not enter their own challenge (self-dealing). */
export async function assertNotChallengeOwner({
  challengeId,
  userId,
}: {
  challengeId: number;
  userId: number;
}): Promise<void> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { createdById: true },
  });
  if (challenge?.createdById != null && challenge.createdById === userId)
    throw forbidden('You cannot submit entries to your own challenge.');
}
