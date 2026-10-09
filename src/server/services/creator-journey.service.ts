import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { FirstPublishCardInput } from '~/server/schema/creator-journey.schema';
import { FIRST_PUBLISH_CARD_DAYS } from '~/shared/constants/creator-journey.constants';
import { ArticleStatus, ModelStatus } from '~/shared/utils/prisma/enums';
import { getCreatorScoreUnlocks } from '~/server/services/creator-score-unlocks.service';
import type { CreatorScoreTier } from '~/shared/utils/creator-score-unlocks';
import type { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';
import type { UserScoreMeta } from '~/server/schema/user.schema';
import type { PrivacySettingsSchema } from '~/server/schema/user-profile.schema';
import { isBadgeShownOnProfile } from '~/shared/utils/badge-visibility';
import { creatorAggregateScoreFromMeta, creatorScoreFromMeta } from '~/shared/utils/creator-score';
import { achievedAtIsObserved } from '~/server/services/creator-milestone-grant.service';
import type { ActivityMeasure } from '~/server/services/creator-milestone-registry';
import {
  activityMeasureOf,
  creatorMilestoneRegistry,
} from '~/server/services/creator-milestone-registry';
import {
  activityValuesSql,
  judgeVoteCountSql,
} from '~/server/services/creator-milestone-detectors';
import type { ShowcaseSource } from '~/server/services/creator-showcase.service';
import {
  getVisibleShowcaseRows,
  LEGEND,
  toLegendStatus,
} from '~/server/services/creator-showcase.service';

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
  earned: boolean,
  slot: string
) {
  if (!milestone.hidden || earned) return milestone;
  // Keys can name the milestone, so a masked one is keyed by its place in the list it is shown in.
  return {
    ...milestone,
    key: `hidden:${slot}`,
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
    select: withArt,
    orderBy: [{ threshold: 'asc' }, { sortOrder: 'asc' }],
  });
}

type DefinitionWithArt = MilestoneDefinition & { cosmetic?: { data: unknown } | null };

const withArt = { ...milestoneSelect, cosmetic: { select: { data: true } } } as const;

// A masked milestone's art would give it away as surely as its name.
function visibleBadgeUrl(milestone: DefinitionWithArt, visible: MilestoneDefinition) {
  if (visible !== milestone) return null;
  return (milestone.cosmetic?.data as BadgeCosmetic['data'] | null)?.url ?? null;
}

function toTier(milestone: DefinitionWithArt, earned: boolean, index: number): CreatorScoreTier {
  const visible = maskUnearnedMilestone(milestone, earned, `tier-${index}`);
  const badgeUrl = visibleBadgeUrl(milestone, visible);
  return {
    key: visible.key,
    name: visible.name,
    threshold: visible.threshold as number,
    hint: visible.hint,
    badgeUrl,
  };
}

/** The live unlocks and the score tiers, for anyone. Hidden tiers are masked: nobody has earned them here. */
export async function getCreatorScoreLadder() {
  const [unlocks, tiers] = await Promise.all([getCreatorScoreUnlocks(), getScoreTierDefinitions()]);
  return { unlocks, tiers: tiers.map((tier, index) => toTier(tier, false, index)) };
}

const activityMeasures = new Map(
  Object.entries(creatorMilestoneRegistry).flatMap(([key, entry]) => {
    const measure = activityMeasureOf(entry);
    return measure ? [[key, measure] as const] : [];
  })
);

export type ActivityValues = Record<ActivityMeasure, number>;

type PostgresActivityValues = Omit<ActivityValues, 'votes'>;

const JUDGE_VOTES_TIMEOUT_SECONDS = 5;

async function getJudgeVotes(userId: number) {
  if (!clickhouse) return 0;
  // The shared client waits minutes for a stalled connection; the page should not.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (JUDGE_VOTES_TIMEOUT_SECONDS + 1) * 1000);
  try {
    const response = await clickhouse.query({
      query: judgeVoteCountSql,
      query_params: { userId },
      format: 'JSONEachRow',
      abort_signal: controller.signal,
      clickhouse_settings: { max_execution_time: JUDGE_VOTES_TIMEOUT_SECONDS },
    });
    const [row] = (await response.json()) as { votes?: unknown }[];
    const votes = Number(row?.votes ?? 0);
    return Number.isSafeInteger(votes) ? Math.min(votes, 2147483647) : 0;
  } catch (e) {
    // The page still loads; the vote ladder reads as no votes until ClickHouse answers.
    logToAxiom({
      type: 'error',
      name: 'creator-journey-judge-votes',
      message: e instanceof Error ? e.message : String(e),
    });
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function getActivityValues(userId: number): Promise<ActivityValues> {
  const [[row], votes] = await Promise.all([
    dbRead.$queryRawUnsafe<PostgresActivityValues[]>(activityValuesSql, userId),
    getJudgeVotes(userId),
  ]);
  return {
    ...(row ?? { models: 0, articles: 0, downloads: 0, followers: 0, reactions: 0, revenue: 0 }),
    votes,
  };
}

/**
 * Every activity milestone with the creator's progress toward it, and the unearned one nearest to
 * done. A count can pass a threshold before the nightly job grants it, so earned means granted.
 */
export function buildActivityProgress(
  definitions: DefinitionWithArt[],
  held: Map<string, Date | null>,
  values: ActivityValues
) {
  const milestones = definitions
    .flatMap((definition, index) => {
      const measure = activityMeasures.get(definition.key);
      if (!measure || definition.threshold == null) return [];
      const earned = held.has(definition.key);
      const visible = maskUnearnedMilestone(definition, earned, `activity-${index}`);
      return [
        {
          key: visible.key,
          track: definition.track,
          measure,
          threshold: definition.threshold,
          name: visible.name,
          description: visible.description,
          badgeUrl: visibleBadgeUrl(definition, visible),
          current: values[measure],
          earned,
          achievedAt: held.get(definition.key) ?? null,
        },
      ];
    })
    .sort((a, b) => a.threshold - b.threshold);

  const nextByMeasure = new Map<ActivityMeasure, (typeof milestones)[number]>();
  for (const milestone of milestones)
    if (!milestone.earned && milestone.current < milestone.threshold)
      if (!nextByMeasure.has(milestone.measure)) nextByMeasure.set(milestone.measure, milestone);

  const ratio = (m: (typeof milestones)[number]) => m.current / m.threshold;
  let closestNext: (typeof milestones)[number] | null = null;
  for (const candidate of nextByMeasure.values())
    if (!closestNext || ratio(candidate) > ratio(closestNext)) closestNext = candidate;

  return { milestones, closestNext };
}

/**
 * Hidden milestones outside the score and activity sections. An unearned one shows its hint and
 * nothing that would tell it apart from the others.
 */
export function buildSecretMilestones(
  definitions: DefinitionWithArt[],
  held: Map<string, Date | null>
) {
  return definitions.map((definition, index) => {
    const earned = held.has(definition.key);
    const visible = maskUnearnedMilestone(definition, earned, `secret-${index}`);
    return {
      key: visible.key,
      name: visible.name,
      description: visible.description,
      hint: visible.hint,
      badgeUrl: visibleBadgeUrl(definition, visible),
      earned,
      achievedAt: held.get(definition.key) ?? null,
    };
  });
}

export async function getCreatorJourney(userId: number) {
  const [
    user,
    unlocks,
    tierDefinitions,
    achievements,
    activityDefinitions,
    activityValues,
    secretDefinitions,
  ] = await Promise.all([
    dbRead.user.findUnique({ where: { id: userId }, select: { meta: true } }),
    getCreatorScoreUnlocks(),
    getScoreTierDefinitions(),
    dbRead.userCreatorMilestone.findMany({
      where: { userId },
      select: { achievedAt: true, seenAt: true, milestone: { select: milestoneSelect } },
      orderBy: { achievedAt: 'desc' },
    }),
    dbRead.creatorMilestone.findMany({
      where: { key: { in: [...activityMeasures.keys()] } },
      select: withArt,
    }),
    getActivityValues(userId),
    dbRead.creatorMilestone.findMany({
      where: {
        hidden: true,
        track: { not: 'score' },
        key: { notIn: [...activityMeasures.keys()] },
      },
      select: withArt,
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    }),
  ]);

  const rawScores = (user?.meta as { scores?: Partial<UserScoreMeta> } | null)?.scores ?? null;
  const observedAt = new Map(
    achievements.map((a) => [a.milestone.key, achievedAtIsObserved(a) ? a.achievedAt : null])
  );
  const earnedKeys = new Set(observedAt.keys());
  const tiers = tierDefinitions.map((tier, index) => toTier(tier, earnedKeys.has(tier.key), index));
  const activity = buildActivityProgress(activityDefinitions, observedAt, activityValues);
  const secrets = buildSecretMilestones(secretDefinitions, observedAt);
  const badgeUrlByKey = new Map(
    [...tiers, ...activity.milestones, ...secrets].map((m) => [m.key, m.badgeUrl ?? null])
  );

  return {
    scores: rawScores
      ? {
          total: creatorScoreFromMeta(user?.meta),
          aggregate: creatorAggregateScoreFromMeta(user?.meta),
          breakdown: rawScores,
        }
      : null,
    unlocks,
    tiers,
    earned: achievements.map(({ milestone }) => ({
      key: milestone.key,
      track: milestone.track,
      threshold: milestone.threshold,
      name: milestone.name,
      description: milestone.description,
      badgeUrl: badgeUrlByKey.get(milestone.key) ?? null,
      achievedAt: observedAt.get(milestone.key) ?? null,
    })),
    activity,
    secrets,
  };
}

/**
 * A Legend whose crossing was never observed (granted silently) is a founding Legend, undated.
 * Nothing is returned when the owner hides the Legend badge, or all badges, on their profile.
 * `oneOf` is the Hall of Fame's size, given only to a Legend the Hall of Fame lists.
 */
export async function getLegendStatus(userId: number, source?: ShowcaseSource) {
  const legend = await dbRead.userCreatorMilestone.findUnique({
    where: { userId_milestoneKey: { userId, milestoneKey: LEGEND } },
    select: { achievedAt: true, seenAt: true, milestone: { select: { cosmeticId: true } } },
  });
  // Almost no profile belongs to a Legend, so the privacy read waits until one is found.
  if (!legend) return null;
  const profile = await dbRead.userProfile.findUnique({
    where: { userId },
    select: { privacySettings: true },
  });
  const privacy = profile?.privacySettings as PrivacySettingsSchema | null | undefined;
  if (!isBadgeShownOnProfile(privacy, legend.milestone.cosmeticId)) return null;
  // The label stands on its own, so an unreadable showcase drops only the count, and a profile does not
  // wait out another request's fill of the candidate list.
  const legends = await getVisibleShowcaseRows({ retryCount: 0, ...source })
    .then((rows) => rows.legends)
    .catch(() => null);
  const oneOf = legends?.some((row) => row.userId === userId) ? legends.length : null;
  return { ...toLegendStatus(legend), oneOf };
}

/**
 * Every Creator Journey milestone a user has earned, for their public profile. Unearned rows are never
 * read, so nothing here can hint at one, and the score itself stays on the owner's journey page. An
 * earned hidden milestone is still a secret to everyone but its owner: they get its art, never its name.
 * Badges the owner hides on their profile are left out, and so is everything for a banned or deleted user.
 */
export async function getProfileAchievements({
  userId,
  viewerId,
}: {
  userId: number;
  viewerId?: number;
}) {
  const [user, rows] = await Promise.all([
    dbRead.user.findUnique({
      where: { id: userId },
      select: { bannedAt: true, deletedAt: true, profile: { select: { privacySettings: true } } },
    }),
    dbRead.userCreatorMilestone.findMany({
      where: { userId },
      select: {
        achievedAt: true,
        seenAt: true,
        milestone: {
          select: {
            key: true,
            track: true,
            threshold: true,
            hidden: true,
            name: true,
            description: true,
            cosmeticId: true,
            cosmetic: { select: { data: true } },
          },
        },
      },
      orderBy: [{ achievedAt: 'desc' }, { milestoneKey: 'asc' }],
    }),
  ]);
  if (!user || user.bannedAt || user.deletedAt) return { tiers: [], achievements: [] };

  const privacy = user.profile?.privacySettings as PrivacySettingsSchema | null | undefined;
  const isOwner = viewerId === userId;
  const shown = rows.filter((row) => isBadgeShownOnProfile(privacy, row.milestone.cosmeticId));
  // A hidden tier is a secret like any other, so a visitor sees it with the secret achievements.
  const isTier = (milestone: (typeof rows)[number]['milestone']) =>
    milestone.track === 'score' && milestone.threshold != null && (!milestone.hidden || isOwner);

  const tiers = shown
    .filter(({ milestone }) => isTier(milestone))
    .sort((a, b) => (a.milestone.threshold as number) - (b.milestone.threshold as number))
    .map((row) => ({
      key: row.milestone.key,
      name: row.milestone.name,
      badgeUrl: (row.milestone.cosmetic?.data as BadgeCosmetic['data'] | null)?.url ?? null,
      achievedAt: achievedAtIsObserved(row) ? row.achievedAt : null,
    }));

  const achievements = shown
    .filter(({ milestone }) => !isTier(milestone))
    .map((row, index) => {
      const { milestone } = row;
      const secret = milestone.hidden && !isOwner;
      return {
        // Keys can name the milestone, so a secret one is keyed by its place in this list.
        key: secret ? `secret:${index}` : milestone.key,
        track: milestone.hidden ? 'secret' : milestone.track,
        name: secret ? null : milestone.name,
        description: secret ? null : milestone.description,
        badgeUrl: (milestone.cosmetic?.data as BadgeCosmetic['data'] | null)?.url ?? null,
        achievedAt: achievedAtIsObserved(row) ? row.achievedAt : null,
      };
    });

  return { tiers, achievements };
}

/**
 * Whether this is the owner's first-ever published model or article, published recently. Reads the
 * primary: the first call lands right after publish, when a replica can still show it unpublished, and
 * the client holds the answer for the session.
 */
export async function getFirstPublishCard({
  userId,
  entityType,
  id,
}: FirstPublishCardInput & { userId: number }) {
  const cutoff = new Date(Date.now() - FIRST_PUBLISH_CARD_DAYS * 24 * 60 * 60 * 1000);

  if (entityType === 'model') {
    const model = await dbWrite.model.findUnique({
      where: { id },
      select: { userId: true, status: true, publishedAt: true },
    });
    if (
      model?.userId !== userId ||
      model.status !== ModelStatus.Published ||
      !model.publishedAt ||
      model.publishedAt < cutoff
    )
      return { show: false };
    // Earlier, not other: a creator who publishes two in their first week still gets it on the first,
    // and a scheduled model is not earlier until it goes live. Models soft-delete, so a deleted earlier
    // one still counts; articles hard-delete and cannot.
    const earlier = await dbWrite.model.findFirst({
      where: {
        userId,
        id: { not: id },
        publishedAt: { lt: model.publishedAt },
        // A Scheduled row the job will never publish (cannotPublish) keeps a past publishedAt.
        status: { not: ModelStatus.Scheduled },
      },
      select: { id: true },
    });
    return { show: !earlier };
  }

  const article = await dbWrite.article.findUnique({
    where: { id },
    select: { userId: true, status: true, publishedAt: true },
  });
  if (
    article?.userId !== userId ||
    article.status !== ArticleStatus.Published ||
    !article.publishedAt ||
    article.publishedAt < cutoff
  )
    return { show: false };
  const earlier = await dbWrite.article.findFirst({
    where: { userId, id: { not: id }, publishedAt: { lt: article.publishedAt } },
    select: { id: true },
  });
  return { show: !earlier };
}
