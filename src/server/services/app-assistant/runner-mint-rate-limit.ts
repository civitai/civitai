import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

/**
 * How many tokens the runner may mint with one run grant per window. A run mints about one token per
 * purpose every four minutes (each lasts five, and the runner keeps it until a minute before), plus
 * one more after an orchestration 401 or a process restart, so a live run stays far below this; a
 * grant minting faster is being misused.
 */
export const RUNNER_MINT_LIMIT = 60;
export const RUNNER_MINT_WINDOW_SECONDS = 10 * 60;

export type RunnerMintRateLimit = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts one mint against the grant's fixed window. Fails open: a Redis outage must not stop every
 * unattended run at once, and the grant's own expiry still bounds what it can do.
 */
export async function checkRunnerMintRateLimit(grantId: string): Promise<RunnerMintRateLimit> {
  const key = `${REDIS_SYS_KEYS.APP_ASSISTANT.RUNNER_MINT_RATE_LIMIT}:${grantId}` as const;
  try {
    const count = Number(await sysRedis.incr(key));
    if (count === 1) await sysRedis.expire(key, RUNNER_MINT_WINDOW_SECONDS);
    else {
      // A key left without its TTL (the expire above failed) would count forever.
      const ttl = Number(await sysRedis.ttl(key));
      if (ttl < 0) await sysRedis.expire(key, RUNNER_MINT_WINDOW_SECONDS);
    }
    if (count <= RUNNER_MINT_LIMIT) return { allowed: true };
    const ttl = Number(await sysRedis.ttl(key));
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : RUNNER_MINT_WINDOW_SECONDS };
  } catch (error) {
    logSysRedisFailOpen('rate-limit-write-degraded', 'checkRunnerMintRateLimit', error, {
      grantId,
    });
    return { allowed: true };
  }
}
