import type { Kysely } from 'kysely';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import type { DB } from '@civitai/db-schema/kysely';
import { getCacheRedis, getSysRedis } from '../redis';
import { createLimitsSource } from './config';
import { createVoteGate, type GateClient, type Pause } from './gate';
import { votePause } from './lockout';

/** The moderators tune these live on the original game's key, so one setting paces both games. */
export const limitsSource = createLimitsSource({
  read: () => getSysRedis().packed.get(REDIS_SYS_KEYS.NEW_ORDER.CONFIG),
});

// The gate's keys are rate-limit windows and cooldowns that can start empty, all tagged with the
// player's id, so the one-step script runs on the cache cluster.
export const voteGate = createVoteGate({
  client: () => getCacheRedis() as unknown as GateClient,
  limits: () => limitsSource.load(),
});

/** The pause in force and the window that set it, for copy that names the limit. */
export const pauseFor = (db: Kysely<DB>, userId: number, now: Date, floor: Pause | null = null) =>
  votePause(db, userId, now, { gate: voteGate, limits: limitsSource }, floor);
