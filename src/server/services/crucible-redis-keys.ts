import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

/** Pair keys (`small:large`) this judge has voted on in this crucible. */
export function getVotedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.VOTED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/** This judge's votes in this crucible as `winner>loser`, for the judge-side skip. */
export function getVoteOutcomesKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
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
