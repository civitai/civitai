import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

/** Pair keys (`small:large`) this judge has voted on in this crucible. */
export function getVotedPairsKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.VOTED_PAIRS}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/** User ids of everyone who has voted in this crucible. */
export function getJudgesKey(crucibleId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.JUDGES}:${crucibleId}` as RedisKeyTemplateSys;
}
