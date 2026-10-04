import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import {
  buildCreateEligibility,
  getUserChallengeStanding,
  type ChallengeCreateEligibility,
  type ChallengeCreateRequirement,
} from '~/server/services/challenge-eligibility.service';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { describeActiveLimitsByTier } from '~/shared/constants/challenge.constants';
import {
  CRUCIBLE_JUDGE_MIN_CREATOR_SCORE,
  CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE,
} from '~/shared/constants/crucible.constants';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';

export async function getCrucibleCreateEligibility(
  userId: number
): Promise<ChallengeCreateEligibility> {
  const [standing, recentCount, activeCount, subscription] = await Promise.all([
    getUserChallengeStanding(userId),
    dbRead.crucible.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
    dbRead.crucible.count({
      where: { userId, status: { in: [CrucibleStatus.Pending, CrucibleStatus.Active] } },
    }),
    getHighestTierSubscription(userId),
  ]);

  return buildCreateEligibility({ standing, recentCount, activeCount, tier: subscription?.tier });
}

function unmetRequirementMessage(requirement: ChallengeCreateRequirement) {
  switch (requirement.key) {
    case 'score':
      return `You need a creator score of at least ${requirement.min.toLocaleString()} to create crucibles.`;
    case 'standing':
      if (requirement.banned) return 'Your account is not eligible to create crucibles.';
      if (requirement.muted) return 'Muted accounts cannot create crucibles.';
      return 'Your account has active strikes and cannot create crucibles right now.';
    case 'dailyLimit':
      return `You can create at most ${requirement.limit} crucibles in any 24 hours. Please try again later.`;
    case 'activeLimit':
      return `You've reached your limit of ${requirement.limit} crucible${
        requirement.limit === 1 ? '' : 's'
      } running at once for your membership tier (${describeActiveLimitsByTier()}).`;
  }
}

export async function assertCanCreateCrucible(userId: number) {
  const { requirements } = await getCrucibleCreateEligibility(userId);
  const unmet = requirements.find((requirement) => !requirement.met);
  if (unmet) throw new TRPCError({ code: 'FORBIDDEN', message: unmetRequirementMessage(unmet) });
}

export type CrucibleJudgeEligibility = { canJudge: boolean; score: number };

export async function getCrucibleJudgeEligibility({
  userId,
  isModerator,
}: {
  userId: number;
  isModerator?: boolean;
}): Promise<CrucibleJudgeEligibility> {
  const user = await dbRead.user.findUnique({ where: { id: userId }, select: { meta: true } });
  const score = creatorScoreFromMeta(user?.meta);
  return { canJudge: !!isModerator || score >= CRUCIBLE_JUDGE_MIN_CREATOR_SCORE, score };
}

export async function assertCanJudgeCrucible(args: { userId: number; isModerator?: boolean }) {
  const { canJudge } = await getCrucibleJudgeEligibility(args);
  if (!canJudge)
    throw new TRPCError({ code: 'FORBIDDEN', message: CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE });
}
