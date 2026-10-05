import { dbRead } from '~/server/db/client';
import { getCreatorScoreUnlocks } from '~/server/services/creator-score-unlocks.service';
import type { CreatorScoreTier } from '~/shared/utils/creator-score-unlocks';
import type { UserScoreMeta } from '~/server/schema/user.schema';
import {
  creatorAggregateScoreFromMeta,
  creatorArticlesScoreFromMeta,
  creatorScoreFromMeta,
} from '~/shared/utils/creator-score';

type MilestoneDefinition = {
  key: string;
  track: string;
  threshold: number | null;
  hidden: boolean;
  hint: string | null;
  name: string;
  description: string | null;
};

/**
 * A hidden milestone the viewer has not earned shows only its hint. The `hidden` track is a grouping
 * label and masks nothing on its own; the per-row flag is what decides.
 */
export function maskUnearnedMilestone<T extends MilestoneDefinition>(
  milestone: T,
  earned: boolean
) {
  if (!milestone.hidden || earned) return milestone;
  // Keys follow `<track>:<name>`, so the key would give the name away.
  return {
    ...milestone,
    key: `hidden:${milestone.threshold ?? 'unranked'}`,
    name: '???',
    description: null,
  };
}

const milestoneSelect = {
  key: true,
  track: true,
  threshold: true,
  hidden: true,
  hint: true,
  name: true,
  description: true,
} as const;

async function getScoreTierDefinitions() {
  return dbRead.creatorMilestone.findMany({
    where: { track: 'score', threshold: { not: null } },
    select: milestoneSelect,
    orderBy: [{ threshold: 'asc' }, { sortOrder: 'asc' }],
  });
}

function toTier(milestone: MilestoneDefinition): CreatorScoreTier {
  return {
    key: milestone.key,
    name: milestone.name,
    threshold: milestone.threshold as number,
    hint: milestone.hint,
  };
}

/** The live unlocks and the score tiers, for anyone. Hidden tiers are masked: nobody has earned them here. */
export async function getCreatorScoreLadder() {
  const [unlocks, tiers] = await Promise.all([getCreatorScoreUnlocks(), getScoreTierDefinitions()]);
  return { unlocks, tiers: tiers.map((tier) => toTier(maskUnearnedMilestone(tier, false))) };
}

export async function getCreatorJourney(userId: number) {
  const [user, unlocks, tierDefinitions, achievements] = await Promise.all([
    dbRead.user.findUnique({ where: { id: userId }, select: { meta: true } }),
    getCreatorScoreUnlocks(),
    getScoreTierDefinitions(),
    dbRead.userCreatorMilestone.findMany({
      where: { userId },
      select: { achievedAt: true, milestone: { select: milestoneSelect } },
      orderBy: { achievedAt: 'desc' },
    }),
  ]);

  const rawScores = (user?.meta as { scores?: Partial<UserScoreMeta> } | null)?.scores ?? null;
  const earnedKeys = new Set(achievements.map((a) => a.milestone.key));

  return {
    scores: rawScores
      ? {
          total: creatorScoreFromMeta(user?.meta),
          aggregate: creatorAggregateScoreFromMeta(user?.meta),
          articles: creatorArticlesScoreFromMeta(user?.meta),
          breakdown: rawScores,
        }
      : null,
    unlocks,
    tiers: tierDefinitions.map((tier) =>
      toTier(maskUnearnedMilestone(tier, earnedKeys.has(tier.key)))
    ),
    earned: achievements.map(({ achievedAt, milestone }) => ({
      key: milestone.key,
      track: milestone.track,
      name: milestone.name,
      description: milestone.description,
      achievedAt,
    })),
  };
}
