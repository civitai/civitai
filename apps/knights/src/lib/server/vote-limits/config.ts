import { REDIS_TIMEOUT_MS, within } from '../redis-timeout';
import { VOTE_LIMITS, type VoteLimit } from '../queue/vote-rate';

const FIELDS = [
  ['perMinute', 60],
  ['perHour', 3600],
  ['perDay', 86400],
] as const;

/** The original game's `new-order:config` holds `{ perMinute, perHour, perDay }`; a value that is not a positive whole number keeps the built-in one. */
export function limitsFromConfig(raw: unknown): VoteLimit[] {
  const config = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return FIELDS.map(([field, windowSeconds]) => {
    const value = config[field];
    const builtIn = VOTE_LIMITS.find((limit) => limit.windowSeconds === windowSeconds)!;
    return {
      windowSeconds,
      max: typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : builtIn.max,
    };
  });
}

export type LimitsSourceOptions = {
  read: () => Promise<unknown>;
  ttlMs?: number;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * The vote limits in force: the moderators' live config when it can be read, else the built-in ones. The read is kept for
 * `ttlMs` so a vote never waits on it, and a read that fails keeps what was known (the built-in limits before any read).
 */
export function createLimitsSource({
  read,
  ttlMs = 60_000,
  now = Date.now,
  timeoutMs = REDIS_TIMEOUT_MS,
}: LimitsSourceOptions) {
  let held: VoteLimit[] = [...VOTE_LIMITS];
  let readAt = -Infinity;
  let loading: Promise<VoteLimit[]> | null = null;

  async function refresh(): Promise<VoteLimit[]> {
    try {
      held = limitsFromConfig(await within(read(), timeoutMs));
    } catch (error) {
      console.error('knights: could not read the live vote limits', { error });
    }
    readAt = now();
    return held;
  }

  return {
    /** The last limits read; never waits. */
    current: (): VoteLimit[] => held,
    async load(): Promise<VoteLimit[]> {
      if (now() - readAt < ttlMs) return held;
      loading ??= refresh().finally(() => (loading = null));
      return loading;
    },
  };
}
