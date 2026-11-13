import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createTtlMemo, type TtlMemo } from '~/server/utils/ttl-memoize';
import { createLogger } from '~/utils/logging';

const log = createLogger('crucible-judging-session', 'magenta');

export const CRUCIBLE_JUDGING_DEFAULTS = {
  repeatViewSeconds: 1,
} as const;

export type CrucibleJudgingConfig = {
  repeatViewSeconds: number;
};

const CONFIG_TTL_MS = 60_000;

const readNumber = (raw: unknown, min: number, max: number, fallback: number) => {
  const value = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

export function parseCrucibleJudgingConfig(
  raw: Record<string, unknown> | null | undefined
): CrucibleJudgingConfig {
  return {
    repeatViewSeconds: readNumber(
      raw?.repeatViewSeconds,
      0,
      3600,
      CRUCIBLE_JUDGING_DEFAULTS.repeatViewSeconds
    ),
  };
}

// An unreadable config must not hand out the default shortening: the operator may have raised it.
const NO_SHORTENING: CrucibleJudgingConfig = {
  repeatViewSeconds: Number.POSITIVE_INFINITY,
};

let configMemo: TtlMemo<CrucibleJudgingConfig> | undefined;

/**
 * Operator-tunable from Redis; each pod re-reads it at most once per CONFIG_TTL_MS. A failed read is
 * not memoized, so the next call retries.
 */
export async function getCrucibleJudgingConfig(): Promise<CrucibleJudgingConfig> {
  configMemo ??= createTtlMemo(
    async () =>
      parseCrucibleJudgingConfig(
        await withSysReadDeadline(sysRedis.hGetAll<string>(REDIS_SYS_KEYS.SYSTEM.CRUCIBLE_JUDGING))
      ),
    CONFIG_TTL_MS,
    // Not the default `Date.now` reference, which is captured once and would ignore a faked clock.
    () => Date.now()
  );
  try {
    return await configMemo();
  } catch (e) {
    log(`config read failed, no shortening: ${(e as Error).message}`);
    return NO_SHORTENING;
  }
}

/** entryId -> how many times this judge has voted on it in this crucible. */
export function getJudgeEntryVotesKey(crucibleId: number, userId: number): RedisKeyTemplateSys {
  return `${REDIS_SYS_KEYS.CRUCIBLE.JUDGE_ENTRY_VOTES}:${crucibleId}:${userId}` as RedisKeyTemplateSys;
}

/**
 * The entries among `entryIds` this judge has a vote on in this crucible, from any visit. An
 * unreadable count yields nothing, so being unsure lands on the full watch.
 */
async function getVotedEntries(
  crucibleId: number,
  userId: number,
  entryIds: number[]
): Promise<Set<number>> {
  const key = getJudgeEntryVotesKey(crucibleId, userId);
  try {
    const counts = await sysRedis.hmGet(key, entryIds.map(String));
    return new Set(entryIds.filter((_, i) => Number(counts?.[i] ?? 0) > 0));
  } catch (e) {
    log(`judge entry votes read failed for ${key}: ${(e as Error).message}`);
    return new Set();
  }
}

/** One rule for the client's timer and the server's gate. Null means nothing to watch. */
export function requiredWatchSeconds(
  minViewSeconds: number | null | undefined,
  votedBefore: boolean,
  { repeatViewSeconds }: Pick<CrucibleJudgingConfig, 'repeatViewSeconds'>
): number | null {
  if (!minViewSeconds) return null;
  return votedBefore ? Math.min(repeatViewSeconds, minViewSeconds) : minViewSeconds;
}

/**
 * What the judge owes each of `entryIds` right now. Both the pair the client is handed and the vote
 * the server accepts go through here, so the two cannot disagree.
 */
export async function resolveWatchSeconds({
  crucibleId,
  userId,
  minViewSeconds,
  entryIds,
}: {
  crucibleId: number;
  userId: number;
  minViewSeconds: number | null | undefined;
  entryIds: number[];
}): Promise<(number | null)[]> {
  if (!minViewSeconds) return entryIds.map(() => null);
  const [config, voted] = await Promise.all([
    getCrucibleJudgingConfig(),
    getVotedEntries(crucibleId, userId, entryIds),
  ]);
  return entryIds.map((id) => requiredWatchSeconds(minViewSeconds, voted.has(id), config));
}
