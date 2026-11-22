import { createHash } from 'crypto';
import { TRPCError } from '@trpc/server';
import { prefixCacheKey } from '@civitai/redis';
import { redis } from '~/server/redis/client';
import { profaneSearchCheck } from '~/server/services/profanity-list.service';
import { middleware } from '~/server/trpc';
import type { resolveClientIp } from '~/server/utils/client-ip';
import { rateLimitBucket } from '~/server/utils/rate-limit-bucket';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';

/**
 * A profanity refusal tells the caller its query matched the list, so refusals would let anyone
 * test words against it. Each caller may be refused this many DISTINCT queries per window (a repeat,
 * or the same query from another search surface, spends nothing), counted across every search that
 * can refuse. Once either window is spent, every search the caller makes is refused as rate limited
 * until it ends, so a refusal and a clean answer can no longer be told apart.
 */
export const SEARCH_REFUSAL_LIMITS = [
  { window: '10m', max: 20, windowSeconds: 10 * 60 },
  { window: 'day', max: 60, windowSeconds: 24 * 60 * 60 },
] as const;

type BucketRequest = Parameters<typeof resolveClientIp>[0];

/** The tRPC rate limiter's caller identity: per user when signed in, per client IP otherwise. */
export function searchRefusalBucket(req: BucketRequest, userId?: number) {
  return rateLimitBucket('search-refusal', userId != null ? { id: userId } : undefined, req)
    .hashKey;
}

// The cache client's typed keys do not cover a literal key; the environment prefix is explicit.
type SetStore = {
  sCard(key: string): Promise<number>;
  sAdd(key: string, member: string): Promise<number>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};
const store = redis as unknown as SetStore;
const keyFor = (window: string, bucket: string) =>
  prefixCacheKey(`search-refusal:${window}:${bucket}`);

const queryHash = (queries: string[]) =>
  createHash('sha256')
    .update(
      queries
        .map((query) => query.trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('\n')
    )
    .digest('hex')
    .slice(0, 16);

const counts = (bucket: string) =>
  Promise.all(SEARCH_REFUSAL_LIMITS.map(({ window }) => store.sCard(keyFor(window, bucket))));

/**
 * Charges a refused query, then reads the counts: true when it took the caller past a cap. The
 * decision uses the count after this caller's own add (SADD is atomic), so a burst of distinct
 * queries in parallel cannot be refused more times than the cap allows.
 */
async function spendSearchRefusal(bucket: string, queries: string[]): Promise<boolean> {
  const member = queryHash(queries);
  await Promise.all(
    SEARCH_REFUSAL_LIMITS.map(async ({ window, windowSeconds }) => {
      const key = keyFor(window, bucket);
      await store.sAdd(key, member);
      // A fixed window from the first refusal; re-asserted if the TTL was lost.
      if ((await store.ttl(key)) < 0) await store.expire(key, windowSeconds);
    })
  );
  const after = await counts(bucket);
  return SEARCH_REFUSAL_LIMITS.some(({ max }, i) => Number(after[i]) > max);
}

async function isSearchRefusalBudgetSpent(bucket: string): Promise<boolean> {
  const now = await counts(bucket);
  const spent = SEARCH_REFUSAL_LIMITS.filter(({ max }, i) => Number(now[i]) >= max);
  // A spent window whose expiry was lost would never lift; a clean query never reaches the add, so
  // the expiry is re-asserted here too.
  for (const { window, windowSeconds } of spent) {
    const key = keyFor(window, bucket);
    if ((await store.ttl(key)) < 0) await store.expire(key, windowSeconds);
  }
  return spent.length > 0;
}

/**
 * The profanity verdict on a search (civitai.com only; the caller decides the domain): `refused`
 * for a profane query, `limited` once the caller has spent its refusals (clean queries too, so
 * the two cannot be told apart), `null` to run it. Verdict only: never which word matched. The
 * budget fails open: a Redis incident must not take search down.
 */
export async function profaneSearchVerdict(
  queries: string[],
  bucket: string
): Promise<'refused' | 'limited' | null> {
  const check = await profaneSearchCheck(queries);
  try {
    if (check === 'profane')
      return (await spendSearchRefusal(bucket, queries)) ? 'limited' : 'refused';
    return (await isSearchRefusalBudgetSpent(bucket)) ? 'limited' : null;
  } catch {
    return check === 'profane' ? 'refused' : null;
  }
}

/**
 * The same verdict, and the same refusal budget, for a semantic search procedure: refused with
 * UNPROCESSABLE_CONTENT whose message is `SEARCH_REFUSED_CODE`. Reads `input.query`.
 */
export const refuseProfaneSearch = middleware(async ({ ctx, input, next }) => {
  const query = (input as { query?: unknown } | undefined)?.query;
  if (!ctx.features.isGreen || typeof query !== 'string') return next();
  const verdict = await profaneSearchVerdict([query], searchRefusalBucket(ctx.req, ctx.user?.id));
  if (verdict === 'limited')
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many searches. Try again in a moment.',
    });
  if (verdict === 'refused')
    throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: SEARCH_REFUSED_CODE });
  return next();
});
