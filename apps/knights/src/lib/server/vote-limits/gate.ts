import { REDIS_TIMEOUT_MS, within } from '../redis-timeout';
import type { VoteLimit } from '../queue/vote-rate';

/** The Redis commands the gate uses; the shared sys client and the test double both fit. */
export type GateClient = {
  incr: (key: string) => Promise<number>;
  decr: (key: string) => Promise<number>;
  pExpire: (key: string, ms: number) => Promise<unknown>;
  pTTL: (key: string) => Promise<number>;
  set: (key: string, value: string, options?: { PX: number }) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

export type GateEntry =
  | { status: 'open'; release: () => Promise<void> }
  | { status: 'limited'; until: Date };

export type Limited = { status: 'limited'; until: Date };

/** A burst from one player is answered, not queued: this many votes at once, the rest are refused. */
export const IN_FLIGHT_CAP = 3;
/** A slot nobody released (a crashed request) frees itself. */
const IN_FLIGHT_TTL_MS = 30_000;
/** The answer to a request over the cap: try again in a moment. */
const BUSY_RETRY_MS = 1_000;
/** After Redis fails to answer, votes skip it for this long instead of each waiting on it. */
const DOWN_FOR_MS = 5_000;

const MINUTE_MS = 60_000;
/** The old game's fixed cooldowns: tripping a window locks the player out for wall-clock time, not a sliding slice. */
const COOLDOWN_MS: Record<number, number> = {
  60: 10 * MINUTE_MS,
  3600: 60 * MINUTE_MS,
  86400: 24 * 60 * MINUTE_MS,
};

// `{id}` is a hash tag: one player's keys share a slot, so the gate also works on a cluster.
const keyOf = (userId: number, part: string) => `knights:vote-limit:{${userId}}:${part}`;

export type VoteGateOptions = {
  client: () => GateClient;
  /** The limits in force right now (live config, else the built-in ones). */
  limits: () => Promise<readonly VoteLimit[]>;
  timeoutMs?: number;
};

/**
 * Checks a player's vote limits in Redis before any database work: a cap on votes in flight, a counter per window and,
 * when a window trips, a fixed cooldown that refuses every vote until it ends. Redis being down or silent skips the gate
 * rather than failing votes: the ledger check inside the vote transaction stays the authoritative limit.
 */
export function createVoteGate({ client, limits, timeoutMs = REDIS_TIMEOUT_MS }: VoteGateOptions) {
  let downUntil = 0;

  async function enterOnce(userId: number, now: Date): Promise<GateEntry> {
    const redis = client();
    const cooldownKey = keyOf(userId, 'cooldown');
    const cooldown = await redis.pTTL(cooldownKey);
    if (cooldown > 0) return { status: 'limited', until: new Date(now.getTime() + cooldown) };

    const slotKey = keyOf(userId, 'inflight');
    const release = async () => {
      try {
        const left = await within(redis.decr(slotKey), timeoutMs);
        if (left < 0) await within(redis.del(slotKey), timeoutMs);
      } catch (error) {
        console.error('knights: could not release a vote slot', { userId, error });
      }
    };
    const held = await redis.incr(slotKey);
    await redis.pExpire(slotKey, IN_FLIGHT_TTL_MS);
    if (held > IN_FLIGHT_CAP) {
      await release();
      return { status: 'limited', until: new Date(now.getTime() + BUSY_RETRY_MS) };
    }

    let tripped: number | null = null;
    for (const { windowSeconds, max } of await limits()) {
      const key = keyOf(userId, `w${windowSeconds}`);
      const count = await redis.incr(key);
      if (count === 1) await redis.pExpire(key, windowSeconds * 1000);
      if (count > max && tripped === null) tripped = windowSeconds;
    }
    if (tripped === null) return { status: 'open', release };

    // Never shorten a cooldown that is already running.
    const wanted = COOLDOWN_MS[tripped] ?? tripped * 1000;
    const running = await redis.pTTL(cooldownKey);
    if (running < wanted) await redis.set(cooldownKey, '1', { PX: wanted });
    await release();
    return { status: 'limited', until: new Date(now.getTime() + Math.max(running, wanted)) };
  }

  async function enter(userId: number, now: Date): Promise<GateEntry> {
    const open: GateEntry = { status: 'open', release: async () => undefined };
    if (now.getTime() < downUntil) return open;
    try {
      return await within(enterOnce(userId, now), timeoutMs * 4);
    } catch (error) {
      downUntil = now.getTime() + DOWN_FOR_MS;
      console.error('knights: vote limits were not checked in Redis', { userId, error });
      return open;
    }
  }

  return {
    enter,

    /** Runs `work` once the gate lets the player through, and frees their slot however it ends. Moderators are never paced. */
    async guard<T>(
      userId: number,
      now: Date,
      work: () => Promise<T>,
      options: { moderator?: boolean } = {}
    ): Promise<T | Limited> {
      if (options.moderator) return work();
      const entry = await enter(userId, now);
      if (entry.status === 'limited') return entry;
      try {
        return await work();
      } finally {
        await entry.release();
      }
    },

    /** When a running cooldown ends, or null. */
    async cooldownUntil(userId: number, now: Date): Promise<Date | null> {
      if (now.getTime() < downUntil) return null;
      try {
        const left = await within(client().pTTL(keyOf(userId, 'cooldown')), timeoutMs);
        return left > 0 ? new Date(now.getTime() + left) : null;
      } catch (error) {
        downUntil = now.getTime() + DOWN_FOR_MS;
        console.error('knights: could not read the vote cooldown', { userId, error });
        return null;
      }
    },
  };
}

export type VoteGate = ReturnType<typeof createVoteGate>;
