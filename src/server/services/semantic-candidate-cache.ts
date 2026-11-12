import { createHash } from 'crypto';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { semanticSearchCandidateCache } from '~/server/metrics/semantic-search.metrics';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { singleFlight } from '~/server/utils/cache-helpers';
import { acquireBulkheadSlot, BulkheadFullError } from '~/server/utils/request-bulkhead';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import {
  buildQdrantFilter,
  type CandidateSource,
  type SearchCollection,
} from '~/server/services/semantic-search-client';

// collectPage asks for at most 100 ids at a time, so a request spans one or two blocks. Blocks are
// aligned so viewers whose hydration drops different images still share them past page 1.
export const CANDIDATE_BLOCK = 100;
// A stalled Redis read costs a search this, not the client's 10 s socket timeout.
const CACHE_READ_DEADLINE_MS = 250;

type Block = { ids: number[]; correctedQuery?: string };
type CandidateKey = `${typeof REDIS_KEYS.SEMANTIC_SEARCH.CANDIDATES}:${string}`;

async function readBlock(key: CandidateKey) {
  try {
    return await withTimeoutFallback(redis.packed.get<Block>(key), CACHE_READ_DEADLINE_MS, null);
  } catch {
    return null;
  }
}

/** Bounds search-service calls in flight on this pod, failing fast rather than queueing. */
async function withSearchSlot<T>(fn: () => Promise<T>) {
  let release: () => void;
  try {
    release = acquireBulkheadSlot('semantic-search', env.SEMANTIC_SEARCH_CONCURRENCY);
  } catch (e) {
    if (e instanceof BulkheadFullError)
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Server busy — please retry.' });
    throw e;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Caches a candidate source in aligned blocks. The key is everything the service answers from (the
 * query and the Qdrant filter, which carries the viewer's clamped level gate) plus the viewer class,
 * so a block is never shared across mods and non-mods. Nothing in it is per user: refusals run
 * before the source, and hydration after it, per viewer.
 */
export function withCandidateCache(
  collection: SearchCollection,
  source: CandidateSource,
  viewerClass: 'mod' | 'user'
): CandidateSource {
  return async ({ query, filter, offset, limit }) => {
    const qdrantFilter = buildQdrantFilter(collection, filter);
    const block = async (start: number): Promise<Block> => {
      const hash = createHash('sha256')
        .update(JSON.stringify({ query, qdrantFilter, start, viewerClass }))
        .digest('hex');
      const key = `${REDIS_KEYS.SEMANTIC_SEARCH.CANDIDATES}:${collection}:${hash}` as const;
      const cached = await readBlock(key);
      semanticSearchCandidateCache().inc({ index: collection, result: cached ? 'hit' : 'miss' });
      if (cached) return cached;
      // The shared call keeps the service's own timeout: no single caller's abort ends it.
      return singleFlight(key, async () => {
        const fresh = await withSearchSlot(() =>
          source({ query, filter, offset: start, limit: CANDIDATE_BLOCK })
        );
        // Every block keeps the correction, so the viewer's audit of it runs on any page.
        const value: Block = { ids: fresh.ids, correctedQuery: fresh.correctedQuery };
        redis.packed.set(key, value, { EX: CacheTTL.md }).catch(() => undefined);
        return value;
      });
    };

    const first = Math.floor(offset / CANDIDATE_BLOCK) * CANDIDATE_BLOCK;
    const starts: number[] = [];
    for (let start = first; start < offset + limit; start += CANDIDATE_BLOCK) starts.push(start);
    const blocks: Block[] = [];
    for (const start of starts) {
      const b = await block(start);
      blocks.push(b);
      // A short block is the end of the ranking: the next one would be empty.
      if (b.ids.length < CANDIDATE_BLOCK) break;
    }
    const ids = blocks.flatMap((b) => b.ids);
    return {
      ids: ids.slice(offset - first, offset - first + limit),
      correctedQuery: blocks[0].correctedQuery,
    };
  };
}
