import type { RedisKeyTemplateCache, RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';

/** Pair keys (`small:large`) this judge has voted on in this crucible. */
export function getVotedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.VOTED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/** Pair keys this judge chose never to be shown again in this crucible. */
export function getDismissedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.DISMISSED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/**
 * This judge's votes in this crucible as `winner>loser`, for the judge-side skip. A cache key, on
 * `redis` rather than `sysRedis`: losing it only serves pairs the judge could have skipped.
 */
export function getVoteOutcomesKey(crucibleId: number, userId: number): RedisKeyTemplateCache {
  return `${REDIS_KEYS.CRUCIBLE.VOTE_OUTCOMES}:${crucibleId}:${userId}` as RedisKeyTemplateCache;
}

/**
 * The same set where it was written before it moved to `redis`. Read only, by the fallback before
 * `VOTE_OUTCOMES_SYS_FALLBACK_UNTIL`; delete with it.
 */
export function getSysVoteOutcomesKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.VOTE_OUTCOMES}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/** Pair key -> the entry Elo left frozen on this judge's vote, for votes against an anchor only. */
export function getAnchorVotesKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.ANCHOR_VOTES}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/** User ids of everyone who has voted in this crucible. */
export function getJudgesKey(crucibleId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.JUDGES}:${crucibleId}` as RedisKeyTemplateSys;
}
