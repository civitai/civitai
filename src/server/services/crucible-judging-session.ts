import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { createTtlMemo, type TtlMemo } from '~/server/utils/ttl-memoize';
import { createLogger } from '~/utils/logging';

const log = createLogger('crucible-judging-session', 'magenta');

export const CRUCIBLE_JUDGING_DEFAULTS = {
  repeatViewSeconds: 1,
  sessionIdleSeconds: 10 * 60,
} as const;

export type CrucibleJudgingConfig = {
  repeatViewSeconds: number;
  sessionIdleSeconds: number;
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
    sessionIdleSeconds: Math.round(
      readNumber(
        raw?.sessionIdleSeconds,
        30,
        24 * 60 * 60,
        CRUCIBLE_JUDGING_DEFAULTS.sessionIdleSeconds
      )
    ),
  };
}

// An unreadable config must not hand out the default shortening: the operator may have raised it.
const NO_SHORTENING: CrucibleJudgingConfig = {
  repeatViewSeconds: Number.POSITIVE_INFINITY,
  sessionIdleSeconds: CRUCIBLE_JUDGING_DEFAULTS.sessionIdleSeconds,
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

// One key per session, not per judge: each session must idle out on its own clock, so a second tab
// that keeps judging cannot keep an abandoned session's marks alive.
const sessionKey = (crucibleId: number, userId: number, sessionId: string) =>
  `${REDIS_SYS_KEYS.CRUCIBLE.JUDGING_SESSION}:${crucibleId}:${userId}:${sessionId}` as RedisKeyTemplateSys;

/**
 * The entries among `entryIds` this judge voted on earlier in the SAME judging session, and slides
 * the session's idle expiry. A missing session id, another session, or an expired session all yield
 * nothing, so every way of being unsure lands on the full watch.
 */
export async function getSeenThisSession({
  crucibleId,
  userId,
  sessionId,
  entryIds,
  idleSeconds,
}: {
  crucibleId: number;
  userId: number;
  sessionId: string | undefined;
  entryIds: number[];
  idleSeconds: number;
}): Promise<Set<number>> {
  if (!sessionId) return new Set();
  const key = sessionKey(crucibleId, userId, sessionId);
  try {
    const [flags] = (await sysRedis
      .multi()
      .hmGet(key, entryIds.map(String))
      .expire(key, idleSeconds)
      .exec()) as unknown as [(string | null)[] | undefined, unknown];
    return new Set(entryIds.filter((_, i) => flags?.[i] != null));
  } catch (e) {
    log(`session read failed for ${key}: ${(e as Error).message}`);
    return new Set();
  }
}

export async function recordSessionVote({
  crucibleId,
  userId,
  sessionId,
  entryIds,
  idleSeconds,
}: {
  crucibleId: number;
  userId: number;
  sessionId: string | undefined;
  entryIds: number[];
  idleSeconds: number;
}) {
  if (!sessionId) return;
  const key = sessionKey(crucibleId, userId, sessionId);
  try {
    // One MULTI, so the key is never left without its idle expiry.
    await sysRedis
      .multi()
      .hSet(key, Object.fromEntries(entryIds.map((id) => [String(id), '1'])))
      .expire(key, idleSeconds)
      .exec();
  } catch (e) {
    // The vote is already counted; losing the mark only costs the judge a full watch later.
    log(`session write failed for ${key}: ${(e as Error).message}`);
  }
}

/** One rule for the client's timer and the server's gate. Null means nothing to watch. */
export function requiredWatchSeconds(
  minViewSeconds: number | null | undefined,
  seenThisSession: boolean,
  { repeatViewSeconds }: Pick<CrucibleJudgingConfig, 'repeatViewSeconds'>
): number | null {
  if (!minViewSeconds) return null;
  return seenThisSession ? Math.min(repeatViewSeconds, minViewSeconds) : minViewSeconds;
}

/**
 * What the judge owes each of `entryIds` right now. Both the pair the client is handed and the vote
 * the server accepts go through here, so the two cannot disagree.
 */
export async function resolveWatchSeconds({
  crucibleId,
  userId,
  sessionId,
  minViewSeconds,
  entryIds,
}: {
  crucibleId: number;
  userId: number;
  sessionId: string | undefined;
  minViewSeconds: number | null | undefined;
  entryIds: number[];
}): Promise<(number | null)[]> {
  if (!minViewSeconds) return entryIds.map(() => null);
  const config = await getCrucibleJudgingConfig();
  const seen = await getSeenThisSession({
    crucibleId,
    userId,
    sessionId,
    entryIds,
    idleSeconds: config.sessionIdleSeconds,
  });
  return entryIds.map((id) => requiredWatchSeconds(minViewSeconds, seen.has(id), config));
}
