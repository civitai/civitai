import type { RedisKeyTemplateCache, RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';

/**
 * The hash tag shared by a judge's voted-pairs set and anchor hash. RECORD_VOTED_PAIR_SCRIPT writes
 * both in one script, which the cache cluster runs only when every key is in one slot.
 */
const judgeVoteTag = (crucibleId: number, userId: number) => `{${crucibleId}:${userId}}`;

/** Pair keys (`small:large`) this judge has voted on in this crucible. On the cache cluster. */
export function getVotedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateCache {
  const tag = judgeVoteTag(crucibleId, userId);
  return `${REDIS_KEYS.CRUCIBLE.VOTED_PAIRS}:${tag}` as RedisKeyTemplateCache;
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

/**
 * Pair key -> the entry Elo left frozen on this judge's vote, for votes against an anchor only. On
 * the cache cluster, in the voted-pairs set's slot.
 */
export function getAnchorVotesKey(crucibleId: number, userId: number): RedisKeyTemplateCache {
  const tag = judgeVoteTag(crucibleId, userId);
  return `${REDIS_KEYS.CRUCIBLE.ANCHOR_VOTES}:${tag}` as RedisKeyTemplateCache;
}

/** User ids of everyone who has voted in this crucible. */
export function getJudgesKey(crucibleId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.JUDGES}:${crucibleId}` as RedisKeyTemplateSys;
}
