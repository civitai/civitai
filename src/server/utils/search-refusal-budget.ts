import { createHash } from 'crypto';
import { TRPCError } from '@trpc/server';
import { prefixCacheKey } from '@civitai/redis';
import { redis } from '~/server/redis/client';
import { profaneSearchCheck } from '~/server/services/profanity-list.service';
import { middleware } from '~/server/trpc';
import { resolveClientIp } from '~/server/utils/client-ip';
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

/** Per user when signed in, per client IP otherwise: the site search limiter's buckets. */
export function searchRefusalBucket(req: BucketRequest, userId?: number) {
  return typeof userId === 'number' ? `user:${userId}` : `ip:${resolveClientIp(req)}`;
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

/** Fails open: a Redis incident must not take search down. */
export async function isSearchRefusalBudgetSpent(bucket: string): Promise<boolean> {
  try {
    const counts = await Promise.all(
      SEARCH_REFUSAL_LIMITS.map(({ window }) => store.sCard(keyFor(window, bucket)))
    );
    return SEARCH_REFUSAL_LIMITS.some(({ max }, i) => Number(counts[i]) >= max);
  } catch {
    return false;
  }
}

export async function spendSearchRefusal(bucket: string, queries: string[]): Promise<void> {
  const member = queryHash(queries);
  await Promise.all(
    SEARCH_REFUSAL_LIMITS.map(async ({ window, windowSeconds }) => {
      const key = keyFor(window, bucket);
      await store.sAdd(key, member);
      // A fixed window from the first refusal; re-asserted if the TTL was lost.
      if ((await store.ttl(key)) < 0) await store.expire(key, windowSeconds);
    })
  );
}

/**
 * The profanity verdict on a search (civitai.com only; the caller decides the domain): `refused`
 * for a profane query, `limited` once the caller has spent its refusals, `null` to run it.
 * Verdict only: never which word matched. With `profanity-managed-list` off it reads nothing.
 */
export async function profaneSearchVerdict(
  queries: string[],
  bucket: string
): Promise<'refused' | 'limited' | null> {
  const check = await profaneSearchCheck(queries);
  if (check === 'off') return null;
  // Asked whatever the check found, so `limited` says nothing about this query.
  if (await isSearchRefusalBudgetSpent(bucket)) return 'limited';
  if (check === 'clean') return null;
  await spendSearchRefusal(bucket, queries).catch(() => undefined);
  return 'refused';
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
