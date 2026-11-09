import { REDIS_TIMEOUT_MS, within } from '../redis-timeout';
import type { VoteLimit } from '../queue/vote-rate';

/** The Redis commands the gate uses; the shared sys client and the test double both fit. */
export type GateClient = {
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  pTTL: (key: string) => Promise<number>;
};

/** `busy` marks a refusal for too many votes at once, as opposed to a limit being reached: the vote can simply be sent again. */
export type Limited = { status: 'limited'; until: Date; busy?: true };

export type GateEntry = { status: 'open'; release: () => Promise<void> } | Limited;

/** A burst from one player is answered, not queued: this many votes at once, the rest are refused. */
export const IN_FLIGHT_CAP = 3;
/** A slot nobody released (a crashed or abandoned request) frees itself this long after it was taken. */
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

// `{id}` is a hash tag: one player's keys share a slot, so the script also runs on a cluster.
const keyOf = (userId: number, part: string) => `knights:vote-limit:{${userId}}:${part}`;

/**
 * The whole check in one atomic step, so no interleaving of requests (or a command that fails halfway) can leave a counter
 * without its expiry or shorten a cooldown. KEYS: cooldown, in-flight slot, then one counter per window. ARGV: slot cap,
 * slot ttl, then per window its length, its max and the cooldown a trip sets (all ms). Returns {0, 0} entered, {1, ms}
 * limited for `ms`, {2, 0} too many in flight.
 * Keep both scripts Lua 5.1-compatible: Redis runs 5.1 but the wasmoon test engine is 5.4, so tests cannot catch a 5.4-only construct.
 */
export const ENTER_SCRIPT = `
local cooldown = redis.call('PTTL', KEYS[1])
if cooldown > 0 then return {1, cooldown} end
local held = redis.call('INCR', KEYS[2])
if held == 1 or redis.call('PTTL', KEYS[2]) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
if held > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[2])
  return {2, 0}
end
local wanted = 0
for i = 1, math.floor((#ARGV - 2) / 3) do
  local base = 3 + (i - 1) * 3
  local count = redis.call('INCR', KEYS[2 + i])
  if count == 1 or redis.call('PTTL', KEYS[2 + i]) < 0 then
    redis.call('PEXPIRE', KEYS[2 + i], ARGV[base])
  end
  if wanted == 0 and count > tonumber(ARGV[base + 1]) then wanted = tonumber(ARGV[base + 2]) end
end
if wanted == 0 then return {0, 0} end
local running = redis.call('PTTL', KEYS[1])
if running < wanted then
  redis.call('SET', KEYS[1], '1', 'PX', tostring(wanted))
  running = wanted
end
redis.call('DECR', KEYS[2])
return {1, running}`;

/** Gives a slot back, never going below zero. */
export const RELEASE_SCRIPT = `
local held = tonumber(redis.call('GET', KEYS[1]) or '0')
if held > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

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
    const slotKey = keyOf(userId, 'inflight');
    const found = await limits();
    const [code, ms] = (await redis.eval(ENTER_SCRIPT, {
      keys: [
        keyOf(userId, 'cooldown'),
        slotKey,
        ...found.map(({ windowSeconds }) => keyOf(userId, `w${windowSeconds}`)),
      ],
      arguments: [
        String(IN_FLIGHT_CAP),
        String(IN_FLIGHT_TTL_MS),
        ...found.flatMap(({ windowSeconds, max }) => [
          String(windowSeconds * 1000),
          String(max),
          String(COOLDOWN_MS[windowSeconds] ?? windowSeconds * 1000),
        ]),
      ],
    })) as [number, number];
    if (code === 1) return { status: 'limited', until: new Date(now.getTime() + Number(ms)) };
    if (code === 2) {
      return { status: 'limited', until: new Date(now.getTime() + BUSY_RETRY_MS), busy: true };
    }
    const release = async () => {
      try {
        await within(redis.eval(RELEASE_SCRIPT, { keys: [slotKey], arguments: [] }), timeoutMs);
      } catch (error) {
        console.error('knights: could not release a vote slot', { userId, error });
      }
    };
    return { status: 'open', release };
  }

  async function enter(userId: number, now: Date): Promise<GateEntry> {
    const open: GateEntry = { status: 'open', release: async () => undefined };
    if (now.getTime() < downUntil) return open;
    const attempt = enterOnce(userId, now);
    try {
      return await within(attempt, timeoutMs * 4);
    } catch (error) {
      downUntil = now.getTime() + DOWN_FOR_MS;
      console.error('knights: vote limits were not checked in Redis', { userId, error });
      // The abandoned check may still land and take a slot nobody will use.
      attempt.then(
        (late) => (late.status === 'open' ? late.release() : undefined),
        () => undefined
      );
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
