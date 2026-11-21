import { TRPCError } from '@trpc/server';
import { prefixCacheKey } from '@civitai/redis';
import { redis } from '~/server/redis/client';
import { resolveClientIp } from '~/server/utils/client-ip';
import { isProfaneSearch } from '~/server/services/profanity-list.service';
import { middleware } from '~/server/trpc';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';

/**
 * A profanity refusal tells the caller its query matched the list, so refusals would let anyone
 * test words against it. Each caller gets this many per window, shared by every search that can
 * refuse; once they are spent, every search the caller makes is refused as rate limited until the
 * window ends, so a refusal and a clean answer can no longer be told apart.
 */
export const SEARCH_REFUSAL_MAX = 20;
export const SEARCH_REFUSAL_WINDOW_SECONDS = 10 * 60;

type BucketRequest = Parameters<typeof resolveClientIp>[0];

/** Per user when signed in, per client IP otherwise: the site search limiter's buckets. */
export function searchRefusalBucket(req: BucketRequest, userId?: number) {
  return typeof userId === 'number' ? `user:${userId}` : `ip:${resolveClientIp(req)}`;
}

const keyFor = (bucket: string) => prefixCacheKey(`search-refusal:${bucket}`);

/** Fails open: a Redis incident must not take search down. */
export async function isSearchRefusalBudgetSpent(bucket: string): Promise<boolean> {
  try {
    const store = redis as unknown as { get(key: string): Promise<string | null> };
    return Number(await store.get(keyFor(bucket))) >= SEARCH_REFUSAL_MAX;
  } catch {
    return false;
  }
}

export async function spendSearchRefusal(bucket: string): Promise<void> {
  await checkFixedWindow(keyFor(bucket), SEARCH_REFUSAL_MAX, SEARCH_REFUSAL_WINDOW_SECONDS);
}

/**
 * The profanity verdict on a search (civitai.com only; the caller decides the domain): `refused`
 * for a profane query, `limited` once the caller has spent its refusals, `null` to run it.
 * Verdict only: never which word matched.
 */
export async function profaneSearchVerdict(
  queries: string[],
  bucket: string
): Promise<'refused' | 'limited' | null> {
  if (!queries.some((query) => query.trim().length > 0)) return null;
  if (await isSearchRefusalBudgetSpent(bucket)) return 'limited';
  if (!(await isProfaneSearch(queries))) return null;
  await spendSearchRefusal(bucket).catch(() => undefined);
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
