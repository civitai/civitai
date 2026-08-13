import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getOrMintCachedToken } from '~/server/orchestrator/orchestrator-token-cache';
import { REDIS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

/** Unused since the cookie store was retired. Kept so the 39 call sites don't churn. */
type Context = {
  req: NextApiRequest;
  res: NextApiResponse;
};

type GetOrchestratorTokenOptions = {
  /**
   * Skip the per-pod LRU + in-flight coalescing layer in front of the
   * DB cold-mint. Use this on CROSS-USER call paths — e.g. the
   * `moderatorProcedure.queryUserGeneratedImages` handler at
   * `routers/orchestrator.router.ts:543-555`, which mints a token for
   * an arbitrary target user. Without this bypass, a compromised
   * moderator account would leave per-target-user cache entries on
   * every pod they touched, lingering up to
   * `ORCHESTRATOR_TOKEN_CACHE_TTL_MS` past account shutdown. Self-call
   * paths (the user is minting for themselves) should leave this
   * unset — they benefit from the amplification dampener.
   *
   * Even with `bypassCache=true`, the sysRedis hash writeback below
   * still runs so other pods can hit the cross-pod cache on the next
   * self-call. Only the per-pod cache is skipped.
   */
  bypassCache?: boolean;
};

export async function getOrchestratorToken(
  userId: number,
  ctx: Context,
  options: GetOrchestratorTokenOptions = {}
) {
  const redisKey = userId.toString();
  // Fail open on sysRedis: fall through to the getTemporaryUserApiKey
  // fallback path below by setting token=null on error.
  let token: string | null;
  try {
    // Wall-clock deadline so a silent sysRedis half-open can't park this read
    // ~11min on every authenticated generation call. A fast DOWN already
    // rejects into the catch below; the SLOW half-open needs the race.
    token = await withSysReadDeadline(sysRedis.hGet(REDIS_KEYS.GENERATION.TOKENS, redisKey)).then(
      (x) => x ?? null
    );
  } catch (err) {
    logSysRedisFailOpen('token-mint-amplification', 'getOrchestratorToken hGet', err, {
      userId,
      action: 'minting-fresh-token',
    });
    token = null;
  }

  if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) {
    // Per-pod LRU + in-flight coalescing in front of the DB cold-mint.
    // Caps the "sysRedis-unavailable" amplification documented at the
    // token-mint-amplification fail-open subtype: without this, 80 pods
    // × ~1k RPS × every auth'd request would translate to ~80k inserts/s
    // + ~160k deleteMany/s on ApiKey during a sysRedis outage. With a
    // 60s TTL the worst-case DB rate is bounded by (active-users / 60s)
    // per pod, regardless of request volume. See
    // orchestrator-token-cache.ts for the full rationale.
    //
    // KNOWN BEHAVIOR: see orchestrator-token-cache.ts docstring — this
    // cache is NOT invalidated by ban / logout / API-key-rotation. A
    // revoked user keeps minting/using a valid orchestrator token for
    // up to ORCHESTRATOR_TOKEN_CACHE_TTL_MS per pod across all ~220
    // pods (api + jobs + ssr). The 401 handlers in
    // src/server/services/orchestrator/{workflows,imageUpload,
    // consumerBlobUpload,videoEnhancement}.ts only `throw` — they do
    // not invalidate this cache or the sysRedis hash. Future
    // moderation features must NOT assume cache-coherent revocation.
    const mint = () =>
      getTemporaryUserApiKey({
        name: generationServiceCookie.name,
        // make the db token live just slightly longer than the cached one
        maxAge: generationServiceCookie.maxAge + 5,
        type: 'System',
        userId,
      });
    // Cross-user mints (moderator path) must NOT populate the per-pod
    // cache — Round-5 audit H2. See GetOrchestratorTokenOptions.bypassCache.
    token = options.bypassCache ? await mint() : await getOrMintCachedToken(userId, mint);
    // Cache populate is best-effort: if sysRedis is down we still return
    // the freshly-minted token. Without this catch, the writeback would
    // 500 every call during a sysRedis outage — defeating the read-side
    // fail-open above.
    //
    // Phase 1.5 (PR #2331 follow-up): atomic single-EVAL set+TTL via
    // hSetWithTTL helper. Replaces the prior Promise.all([hSet, hExpire])
    // pair, which had the failure modes catalogued below — most
    // critically the "no-TTL key on a healthy server" case where HEXPIRE
    // arrives before HSET, finds the field missing, and returns 0
    // silently; HSET then writes without TTL.
    //
    // Blast radius if no-TTL landed (pre-fix): NOT a transparent
    // re-mint. The underlying API key from getTemporaryUserApiKey has a
    // DB-side expiresAt (generationServiceCookie.maxAge + 5 ≈ 1h).
    // After that expired, the API key was dead orchestrator-side, but
    // the cached no-TTL token stayed in this hash. Subsequent calls hit
    // the hGet read path above → returned the dead token → orchestrator
    // 401 → user-visible auth failure with no automatic recovery.
    await hSetWithTTL(
      sysRedis,
      REDIS_KEYS.GENERATION.TOKENS,
      redisKey,
      token,
      generationServiceCookie.maxAge * 1000
    ).catch((err) => {
      logSysRedisFailOpen('write-degraded', 'getOrchestratorToken cache writeback', err, {
        userId,
      });
    });
  }
  return token;
}
