import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import {
  getChallengeActiveLimit,
  CHALLENGE_MIN_CREATOR_SCORE,
  CHALLENGE_CREATE_DAILY_LIMIT,
} from '~/shared/constants/challenge.constants';
import { ChallengeSource, ChallengeStatus, StrikeStatus } from '~/shared/utils/prisma/enums';
import { MUTE_POINTS } from '~/shared/constants/strike.constants';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';

function forbidden(message: string) {
  return new TRPCError({ code: 'FORBIDDEN', message });
}

type UserChallengeStanding = {
  scoreTotal: number;
  bannedAt: Date | null;
  muted: boolean;
  deletedAt: Date | null;
  activePoints: number;
};

export type ChallengeCreateRequirement =
  | { key: 'score'; met: boolean; current: number; min: number }
  | { key: 'standing'; met: boolean; muted: boolean; activePoints: number; banned: boolean }
  | { key: 'dailyLimit'; met: boolean; recentCount: number; limit: number }
  | { key: 'activeLimit'; met: boolean; activeCount: number; limit: number };

export type ChallengeCreateEligibility = {
  canCreate: boolean;
  requirements: ChallengeCreateRequirement[];
};

export async function getUserChallengeStanding(userId: number): Promise<UserChallengeStanding> {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { meta: true, bannedAt: true, muted: true, deletedAt: true },
  });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

  // POINTS, not the strike count — severity is what the ladder measures everywhere else. Gating on the
  // count locked an account out for a strike's full lifetime over one 1-point strike that mutes nobody.
  const { _sum } = await dbRead.userStrike.aggregate({
    where: { userId, status: StrikeStatus.Active, expiresAt: { gt: new Date() } },
    _sum: { points: true },
  });

  return {
    scoreTotal: creatorScoreFromMeta(user.meta),
    bannedAt: user.bannedAt,
    muted: user.muted,
    deletedAt: user.deletedAt,
    activePoints: _sum.points ?? 0,
  };
}

/** Throws unless the user's account standing is clean (not banned/deleted/muted, no active
 * strikes). Does NOT check the creator-score threshold — that's a create-only gate (see
 * `assertUserInGoodStanding`). Used to re-check an existing creator on edit, where the
 * known-flaky user-score pipeline shouldn't be able to lock someone out of editing their own
 * Scheduled challenge. */
export async function assertUserAccountInGoodStanding(
  userId: number
): Promise<UserChallengeStanding> {
  const standing = await getUserChallengeStanding(userId);
  if (standing.bannedAt || standing.deletedAt)
    throw forbidden('Your account is not eligible to create challenges.');
  if (standing.muted) throw forbidden('Muted accounts cannot create challenges.');
  if (standing.activePoints >= MUTE_POINTS)
    throw forbidden('Your account has active strikes and cannot create challenges right now.');
  return standing;
}

/** Throws unless the user is in good standing AND meets the creator-score threshold. */
export async function assertUserInGoodStanding(userId: number): Promise<UserChallengeStanding> {
  const standing = await assertUserAccountInGoodStanding(userId);
  if (standing.scoreTotal < CHALLENGE_MIN_CREATOR_SCORE)
    throw forbidden(
      `You need a creator score of at least ${CHALLENGE_MIN_CREATOR_SCORE.toLocaleString()} to create challenges.`
    );
  return standing;
}

/** User-source challenges the user created in the last 24h (rolling window). */
function countRecentUserChallenges(userId: number): Promise<number> {
  return dbRead.challenge.count({
    where: {
      createdById: userId,
      source: ChallengeSource.User,
      createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
}

/** User-source challenges the user currently has in Scheduled or Active status. */
function countActiveUserChallenges(userId: number): Promise<number> {
  return dbRead.challenge.count({
    where: {
      createdById: userId,
      source: ChallengeSource.User,
      status: { in: [ChallengeStatus.Scheduled, ChallengeStatus.Active] },
    },
  });
}

/** Throws if the user has created CHALLENGE_CREATE_DAILY_LIMIT or more User-source challenges in
 * the last 24h. Anti-spam/abuse guard against rapid create->delete churn (deleted rows drop out of
 * this count, so a determined churner can still evade it — see constant's doc comment). */
export async function assertUnderDailyCreateLimit(
  userId: number
): Promise<{ limit: number; recentCount: number }> {
  const recentCount = await countRecentUserChallenges(userId);

  if (recentCount >= CHALLENGE_CREATE_DAILY_LIMIT)
    throw forbidden(
      `You can create at most ${CHALLENGE_CREATE_DAILY_LIMIT} challenges per day. Please try again later.`
    );
  return { limit: CHALLENGE_CREATE_DAILY_LIMIT, recentCount };
}

/** Throws if the user already has as many Scheduled/Active challenges as their tier allows. */
export async function assertUnderActiveChallengeLimit(
  userId: number
): Promise<{ limit: number; activeCount: number }> {
  const [subscription, activeCount] = await Promise.all([
    getHighestTierSubscription(userId),
    countActiveUserChallenges(userId),
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
  await assertUnderDailyCreateLimit(userId);
  await assertUnderActiveChallengeLimit(userId);
}

/** Non-throwing counterpart to `assertCanCreateUserChallenge` for surfacing the create requirements
 * in the UI. Evaluates every gate and returns each one's status; reuses the same standing/count
 * helpers and constants as the `assert*` path, so `canCreate` matches whether the mutation would be
 * allowed. */
export async function getUserChallengeCreateEligibility(
  userId: number
): Promise<ChallengeCreateEligibility> {
  const [standing, recentCount, activeCount, subscription] = await Promise.all([
    getUserChallengeStanding(userId),
    countRecentUserChallenges(userId),
    countActiveUserChallenges(userId),
    getHighestTierSubscription(userId),
  ]);

  const activeLimit = getChallengeActiveLimit(subscription?.tier);
  const banned = !!(standing.bannedAt || standing.deletedAt);

  const requirements: ChallengeCreateRequirement[] = [
    {
      key: 'score',
      met: standing.scoreTotal >= CHALLENGE_MIN_CREATOR_SCORE,
      current: standing.scoreTotal,
      min: CHALLENGE_MIN_CREATOR_SCORE,
    },
    {
      key: 'standing',
      met: !banned && !standing.muted && standing.activePoints < MUTE_POINTS,
      muted: standing.muted,
      activePoints: standing.activePoints,
      banned,
    },
    {
      key: 'dailyLimit',
      met: recentCount < CHALLENGE_CREATE_DAILY_LIMIT,
      recentCount,
      limit: CHALLENGE_CREATE_DAILY_LIMIT,
    },
    { key: 'activeLimit', met: activeCount < activeLimit, activeCount, limit: activeLimit },
  ];

  return { canCreate: requirements.every((r) => r.met), requirements };
}
