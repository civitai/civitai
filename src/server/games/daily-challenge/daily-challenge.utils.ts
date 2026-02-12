import { mergeWith } from 'lodash-es';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  type ChallengeDetails,
  closeChallengeCollection,
  getActiveChallengeFromDb,
  getActiveChallengesFromDb,
  getEndedActiveChallengesFromDb,
  getScheduledChallengeFromDb,
  getScheduledChallengesReadyToStart,
  getUpcomingSystemChallengeFromDb,
} from './challenge-helpers';

// Schema for ChallengePrompts stored in Redis
const challengePromptsSchema = z.object({
  systemMessage: z.string(),
  collection: z.string(),
  article: z.string(),
  content: z.string(),
  review: z.string(),
  winner: z.string(),
});

// Schema for JudgingConfig stored in Redis
const judgingConfigSchema = z.object({
  judgeId: z.number(),
  userId: z.number(),
  sourceCollectionId: z.number().nullable(),
  prompts: challengePromptsSchema,
});

const challengeConfigSchema = z.object({
  challengeType: z.string(),
  challengeCollectionId: z.number(),
  judgedTagId: z.number(),
  reviewMeTagId: z.number(),
  userCooldown: z.string(),
  resourceCooldown: z.string(),
  prizes: z.array(
    z.object({
      buzz: z.number(),
      points: z.number(),
    })
  ),
  entryPrizeRequirement: z.number(),
  entryPrize: z.object({
    buzz: z.number(),
    points: z.number(),
  }),
  reviewAmount: z.object({
    min: z.number(),
    max: z.number(),
  }),
  maxScoredPerUser: z.number(),
  finalReviewAmount: z.number(),
  resourceCosmeticId: z.number().nullable(),
  articleTagId: z.number(),
  defaultJudgeId: z.number().nullable(),
  // Cached full judge config - populated when defaultJudgeId is set
  defaultJudge: judgingConfigSchema.nullable(),
});
export type ChallengeConfig = z.infer<typeof challengeConfigSchema>;
export const dailyChallengeConfig: ChallengeConfig = {
  challengeType: 'world-morph',
  challengeCollectionId: 6236625,
  judgedTagId: 299729,
  reviewMeTagId: 301770,
  userCooldown: '14 day',
  resourceCooldown: '90 day',
  prizes: [
    { buzz: 5000, points: 150 },
    { buzz: 2500, points: 100 },
    { buzz: 1500, points: 50 },
  ] as Prize[],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 200, points: 10 } as Prize,
  reviewAmount: { min: 6, max: 12 },
  maxScoredPerUser: 5,
  finalReviewAmount: 10,
  resourceCosmeticId: null,
  articleTagId: 128643, // Announcement.
  defaultJudgeId: 1, // CivBot
  defaultJudge: null, // Cached judge config - populated via setChallengeConfig
};
export async function getChallengeConfig() {
  let config: Partial<ChallengeConfig> = {};
  try {
    const redisConfig = await sysRedis.packed.get<Partial<ChallengeConfig>>(
      REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG
    );
    if (redisConfig) config = challengeConfigSchema.partial().parse(redisConfig);
  } catch (e) {
    console.error('Invalid daily challenge config in redis:', e);
  }

  const merged = { ...dailyChallengeConfig, ...config };

  // Auto-populate defaultJudge from DB if missing but defaultJudgeId is set
  if (merged.defaultJudgeId && !merged.defaultJudge) {
    try {
      const judgingConfig = await fetchJudgingConfigFromDb(merged.defaultJudgeId);
      if (judgingConfig) {
        merged.defaultJudge = judgingConfig;
        // Cache the fetched judge config for next time
        await sysRedis.packed.set(REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG, {
          ...config,
          defaultJudge: judgingConfig,
        });
      }
    } catch (e) {
      console.error('Failed to fetch default judge config:', e);
    }
  }

  return merged;
}

export async function setChallengeConfig(updates: Partial<ChallengeConfig>): Promise<void> {
  // Get existing Redis config (not merged with defaults)
  const existingConfig =
    (await sysRedis.packed.get<Partial<ChallengeConfig>>(REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG)) ??
    {};

  // Merge updates
  const newConfig = { ...existingConfig, ...updates };

  // If defaultJudgeId is being updated, fetch and cache the full judge config
  if ('defaultJudgeId' in updates) {
    if (updates.defaultJudgeId) {
      const judgingConfig = await fetchJudgingConfigFromDb(updates.defaultJudgeId);
      newConfig.defaultJudge = judgingConfig;
    } else {
      newConfig.defaultJudge = null;
    }
  }

  await sysRedis.packed.set(REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG, newConfig);
}

/**
 * Fetch JudgingConfig directly from database.
 * Used internally for caching in Redis config.
 */
async function fetchJudgingConfigFromDb(judgeId: number): Promise<JudgingConfig | null> {
  const judge = await dbRead.challengeJudge.findUnique({
    where: { id: judgeId },
    select: {
      id: true,
      userId: true,
      sourceCollectionId: true,
      systemPrompt: true,
      collectionPrompt: true,
      contentPrompt: true,
      reviewPrompt: true,
      winnerSelectionPrompt: true,
    },
  });

  if (!judge) return null;

  return {
    judgeId: judge.id,
    userId: judge.userId,
    sourceCollectionId: judge.sourceCollectionId,
    prompts: {
      systemMessage: judge.systemPrompt ?? '',
      collection: judge.collectionPrompt ?? '',
      content: judge.contentPrompt ?? '',
      article: judge.contentPrompt ?? '', // Backward compatibility alias
      review: judge.reviewPrompt ?? '',
      winner: judge.winnerSelectionPrompt ?? '',
    },
  };
}

/**
 * Refresh the cached default judge config in Redis.
 * Call this when the default judge's prompts are updated in the database.
 */
export async function refreshDefaultJudgeCache(): Promise<void> {
  const existingConfig =
    (await sysRedis.packed.get<Partial<ChallengeConfig>>(REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG)) ??
    {};

  const defaultJudgeId = existingConfig.defaultJudgeId ?? dailyChallengeConfig.defaultJudgeId;
  if (!defaultJudgeId) return;

  const judgingConfig = await fetchJudgingConfigFromDb(defaultJudgeId);
  if (judgingConfig) {
    existingConfig.defaultJudge = judgingConfig;
    await sysRedis.packed.set(REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG, existingConfig);
  }
}

export type ChallengePrompts = {
  systemMessage: string;
  collection: string;
  /** @deprecated Use 'content' instead */
  article: string;
  content: string;
  review: string;
  winner: string;
};
type ChallengeType = {
  collectionId: number;
  userId: number;
  prompts: ChallengePrompts;
};
const DEFAULT_CHALLENGE_TYPE = 'world-morph';

// =============================================================================
// JudgingConfig - New system replacing ChallengeTypeConfig
// =============================================================================

/**
 * Configuration for challenge judging, sourced from ChallengeJudge.
 * This replaces the legacy ChallengeTypeConfig system.
 */
export type JudgingConfig = {
  judgeId: number;
  userId: number;
  sourceCollectionId: number | null; // Collection to pick model resources from
  prompts: ChallengePrompts;
};

/**
 * Get judging configuration from a ChallengeJudge.
 * This is the new preferred way to get prompts for challenge operations.
 *
 * @param judgeId - The ChallengeJudge ID to load config from
 * @param judgingPromptOverride - Optional per-challenge system prompt override
 * @returns JudgingConfig with all prompts populated
 */
export async function getJudgingConfig(
  judgeId: number,
  judgingPromptOverride?: string | null
): Promise<JudgingConfig> {
  const judge = await dbRead.challengeJudge.findUnique({
    where: { id: judgeId },
    select: {
      id: true,
      userId: true,
      sourceCollectionId: true,
      systemPrompt: true,
      collectionPrompt: true,
      contentPrompt: true,
      reviewPrompt: true,
      winnerSelectionPrompt: true,
    },
  });

  if (!judge) throw new Error(`ChallengeJudge with id ${judgeId} not found`);

  return {
    judgeId: judge.id,
    userId: judge.userId,
    sourceCollectionId: judge.sourceCollectionId,
    prompts: {
      systemMessage: judge.systemPrompt ?? '',
      collection: judge.collectionPrompt ?? '',
      content: judge.contentPrompt ?? '',
      article: judge.contentPrompt ?? '', // Backward compatibility alias
      review: judgingPromptOverride ?? judge.reviewPrompt ?? '',
      winner: judge.winnerSelectionPrompt ?? '',
    },
  };
}
type ChallengeTypeRow = {
  name: string;
  collectionId: number;
  userId: number;
  promptSystemMessage: string;
  promptCollection: string;
  promptArticle: string;
  promptReview: string;
  promptWinner: string;
};
/**
 * @deprecated Use getJudgingConfig() instead. This function reads from the
 * legacy ChallengeType table which is being replaced by ChallengeJudge.
 */
export async function getChallengeTypeConfig(type: string | undefined) {
  type ??= DEFAULT_CHALLENGE_TYPE;
  const rows = await dbRead.$queryRaw<ChallengeTypeRow[]>`
    SELECT
      "name",
      "collectionId",
      "userId",
      "promptSystemMessage",
      "promptCollection",
      "promptArticle",
      "promptReview",
      "promptWinner"
    FROM "ChallengeType"
    WHERE "name" IN (${type}, ${DEFAULT_CHALLENGE_TYPE})
  `;
  const result = rows.find((r) => r.name === DEFAULT_CHALLENGE_TYPE);
  if (!result) throw new Error('Default challenge type not found in database');

  let override = rows.find((r) => r.name === type);
  if (!override) override = result;
  else {
    mergeWith(result, override, (objValue, srcValue) => {
      // Handle empty strings as null
      if (typeof srcValue === 'string' && !srcValue) return objValue;
    });
  }

  return {
    collectionId: result.collectionId,
    userId: result.userId,
    prompts: {
      systemMessage: result.promptSystemMessage,
      collection: result.promptCollection,
      article: result.promptArticle,
      content: result.promptArticle, // Alias for backward compatibility
      review: result.promptReview,
      winner: result.promptWinner,
    },
  } as ChallengeType;
}

/**
 * Derive a challenge's nsfwLevel from its allowedNsfwLevel bitwise flags.
 * Returns the highest allowed NsfwLevel (most mature content permitted).
 * Example: allowedNsfwLevel = 7 (PG|PG13|R) → nsfwLevel = 4 (R)
 */
export function deriveChallengeNsfwLevel(allowedNsfwLevel: number): number {
  return Flags.maxValue(allowedNsfwLevel) || NsfwLevel.PG;
}

export type Prize = {
  buzz: number;
  points: number;
};

/**
 * @deprecated Use getJudgingConfig() instead. This function only returns
 * partial prompt overrides and is being replaced by the full JudgingConfig system.
 *
 * Get judge prompt overrides for a challenge.
 * Override priority (highest → lowest):
 *   1. Challenge.judgingPrompt (per-challenge override) → used as systemPrompt
 *   2. ChallengeJudge prompts (judge persona's system/review/winner prompts)
 *   3. Redis config / defaults (existing fallback)
 * Returns undefined if no overrides exist, allowing the default prompt chain.
 */
export async function getJudgePrompts(
  judgeId: number | null | undefined,
  judgingPrompt?: string | null
) {
  if (!judgeId && !judgingPrompt) return undefined;

  if (!judgeId) {
    return {
      systemPrompt: judgingPrompt!,
      reviewPrompt: null,
      winnerSelectionPrompt: null,
    };
  }

  const judge = await dbRead.challengeJudge.findUnique({
    where: { id: judgeId },
    select: {
      systemPrompt: true,
      reviewPrompt: true,
      winnerSelectionPrompt: true,
    },
  });

  if (!judge && !judgingPrompt) return undefined;

  return {
    systemPrompt: judgingPrompt ?? judge?.systemPrompt ?? null,
    reviewPrompt: judge?.reviewPrompt ?? null,
    winnerSelectionPrompt: judge?.winnerSelectionPrompt ?? null,
  };
}

export type Score = {
  theme: number; // 0-10 how well it fits the theme
  wittiness: number; // 0-10 how witty it is
  humor: number; // 0-10 how funny it is
  aesthetic: number; // 0-10 how aesthetically pleasing it is
};

export type DailyChallengeDetails = {
  challengeId: number; // Challenge table ID for status updates
  articleId?: number; // Deprecated: Legacy article ID (no longer used for new challenges)
  type: string;
  date: Date;
  theme: string;
  modelId: number;
  modelVersionIds: number[];
  collectionId: number;
  title: string;
  invitation: string;
  coverUrl: string;
  prizes: Prize[];
  entryPrizeRequirement: number;
  entryPrize: Prize;
};

/**
 * Convert new ChallengeDetails format to legacy DailyChallengeDetails format.
 * This adapter enables backward compatibility during the transition period.
 */
export function challengeToLegacyFormat(challenge: ChallengeDetails): DailyChallengeDetails {
  const metadata = challenge.metadata as Record<string, unknown> | null;
  return {
    challengeId: challenge.id,
    articleId: (metadata?.articleId as number) ?? 0,
    type: (metadata?.challengeType as string) ?? 'world-morph',
    date: challenge.startsAt,
    theme: challenge.theme ?? '',
    modelId: (metadata?.resourceModelId as number) ?? (metadata?.resourceUserId as number) ?? 0,
    modelVersionIds: challenge.modelVersionIds,
    collectionId: challenge.collectionId!,
    title: challenge.title,
    invitation: challenge.invitation ?? '',
    coverUrl: challenge.coverUrl ?? '',
    prizes: challenge.prizes,
    entryPrizeRequirement: challenge.entryPrizeRequirement,
    entryPrize: challenge.entryPrize ?? { buzz: 0, points: 0 },
  };
}

/**
 * @deprecated Use getChallengeById from challenge-helpers.ts instead.
 * This function looks up challenges by Article ID which is no longer used.
 * Will be removed in a future release.
 */
export async function getChallengeDetails(articleId: number) {
  const db = await getDbWithoutLag('article', articleId);
  const rows = await db.$queryRaw<DailyChallengeDetails[]>`
    SELECT
      a."id" as "articleId",
      (a.metadata->>'challengeType') as "type",
      (a.metadata->>'theme') as "theme",
      (a.metadata->>'challengeDate')::timestamp as "date",
      cast(a.metadata->'modelId' as int) as "modelId",
      (SELECT array_agg("id") FROM "ModelVersion" WHERE "modelId" = cast(a.metadata->'modelId' as int)) as "modelVersionIds",
      cast(a.metadata->'collectionId' as int) as "collectionId",
      a."title",
      (a.metadata->>'invitation') as "invitation",
      (SELECT "url" FROM "Image" WHERE "id" = a."coverId") as "coverUrl",
      (a.metadata->'prizes') as "prizes",
      (a.metadata->>'entryPrizeRequirement')::int as "entryPrizeRequirement",
      (a.metadata->'entryPrize') as "entryPrize"
    FROM "Article" a
    WHERE a.id = ${articleId}
  `;

  const result = rows[0];
  if (!result) return null;
  if (!result.prizes) result.prizes = dailyChallengeConfig.prizes;
  if (!result.entryPrizeRequirement)
    result.entryPrizeRequirement = dailyChallengeConfig.entryPrizeRequirement;
  if (!result.entryPrize) result.entryPrize = dailyChallengeConfig.entryPrize;

  return result;
}

/**
 * @deprecated Challenge caching is now managed via Challenge table status.
 * This function is a no-op and will be removed in a future release.
 */
export async function setCurrentChallenge(_articleId: number): Promise<void> {
  // No-op: Challenge.status is now the source of truth
  // Redis cache is no longer used for challenge tracking
  return;
}

/**
 * Gets the currently active challenge from the Challenge table.
 */
export async function getCurrentChallenge(): Promise<DailyChallengeDetails | null> {
  const challenge = await getActiveChallengeFromDb();
  if (!challenge) return null;
  return challengeToLegacyFormat(challenge);
}

/**
 * Gets the next scheduled challenge from the Challenge table.
 */
export async function getUpcomingChallenge(): Promise<DailyChallengeDetails | null> {
  const challenge = await getScheduledChallengeFromDb();
  if (!challenge) return null;
  return challengeToLegacyFormat(challenge);
}
export async function endChallenge(challenge?: { collectionId: number } | null) {
  challenge ??= await getCurrentChallenge();
  if (!challenge) return;

  await closeChallengeCollection(challenge);
}

// =============================================================================
// Multi-Challenge Support Functions
// =============================================================================

/**
 * Gets ALL active challenges in legacy format (supports multiple concurrent challenges).
 */
export async function getActiveChallenges(): Promise<DailyChallengeDetails[]> {
  const challenges = await getActiveChallengesFromDb();
  return challenges.map(challengeToLegacyFormat);
}

/**
 * Gets active challenges that have ENDED (endsAt <= now) in legacy format.
 * These challenges need winner picking.
 */
export async function getEndedActiveChallenges(): Promise<DailyChallengeDetails[]> {
  const challenges = await getEndedActiveChallengesFromDb();
  return challenges.map(challengeToLegacyFormat);
}

/**
 * Gets scheduled challenges that are ready to START (startsAt <= now) in legacy format.
 * These challenges should be activated.
 */
export async function getChallengesReadyToStart(): Promise<DailyChallengeDetails[]> {
  const challenges = await getScheduledChallengesReadyToStart();
  return challenges.map(challengeToLegacyFormat);
}

/**
 * Gets an upcoming system-created challenge (scheduled) in legacy format.
 * Returns null if no scheduled system challenge exists.
 */
export async function getUpcomingSystemChallenge(): Promise<DailyChallengeDetails | null> {
  const challenge = await getUpcomingSystemChallengeFromDb();
  if (!challenge) return null;
  return challengeToLegacyFormat(challenge);
}
