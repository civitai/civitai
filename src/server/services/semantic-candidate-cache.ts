import { createHash } from 'crypto';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { semanticSearchCandidateCache } from '~/server/metrics/semantic-search.metrics';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { singleFlight } from '~/server/utils/cache-helpers';
import { withBulkheadSlotOrBusy } from '~/server/utils/request-bulkhead';
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

/**
 * The key is everything the service answers from (the query and the Qdrant filter, which carries the
 * viewer's clamped level gate) plus the viewer class, so a block is never shared across mods and
 * non-mods. Nothing in it is per user: refusals run before the source, and hydration after it, per
 * viewer. One wrapper serves one search request, so its blocks are also memoized across that
 * request's hydration rounds.
 */
export function withCandidateCache(
  collection: SearchCollection,
  source: CandidateSource,
  viewerClass: 'mod' | 'user'
): CandidateSource {
  const fetched = new Map<string, Promise<Block>>();

  return async ({ query, filter, offset, limit }) => {
    const qdrantFilter = buildQdrantFilter(collection, filter);
    const fetchBlock = (start: number) =>
      withBulkheadSlotOrBusy(`semantic-search:${collection}`, env.SEMANTIC_SEARCH_CONCURRENCY, () =>
        source({ query, filter, offset: start, limit: CANDIDATE_BLOCK })
      ).then((fresh): Block => ({ ids: fresh.ids, correctedQuery: fresh.correctedQuery }));
    const keyOf = (start: number) =>
      `${REDIS_KEYS.SEMANTIC_SEARCH.CANDIDATES}:${collection}:${createHash('sha256')
        .update(JSON.stringify({ query, qdrantFilter, start, viewerClass }))
        .digest('hex')}` as const;
    const write = (key: CandidateKey, block: Block) =>
      redis.packed.set(key, block, { EX: CacheTTL.md }).catch(() => undefined);

    const block = (start: number) => {
      const key = keyOf(start);
      let pending = fetched.get(key);
      if (!pending) {
        pending = (async () => {
          const cached = await readBlock(key);
          semanticSearchCandidateCache().inc({
            index: collection,
            result: cached ? 'hit' : 'miss',
          });
          if (cached) return cached;
          // The shared call keeps the service's own timeout: no single caller's abort ends it.
          return singleFlight(key, async () => {
            const fresh = await fetchBlock(start);
            void write(key, fresh);
            return fresh;
          });
        })();
        fetched.set(key, pending);
        pending.catch(() => fetched.delete(key));
      }
      return pending;
    };

    const first = Math.floor(offset / CANDIDATE_BLOCK) * CANDIDATE_BLOCK;
    const starts: number[] = [];
    for (let start = first; start < offset + limit; start += CANDIDATE_BLOCK) starts.push(start);
    let blocks = await Promise.all(starts.map(block));
    // Blocks cached apart can disagree on the spelling correction. The viewer audits one correction
    // per response, so a disagreeing range is fetched again in one go.
    if (new Set(blocks.map((b) => b.correctedQuery)).size > 1) {
      blocks = await Promise.all(starts.map(fetchBlock));
      blocks.forEach((b, i) => {
        const key = keyOf(starts[i]);
        fetched.set(key, Promise.resolve(b));
        void write(key, b);
      });
    }

    const ids: number[] = [];
    for (const b of blocks) {
      ids.push(...b.ids);
      // A short block is the end of the ranking.
      if (b.ids.length < CANDIDATE_BLOCK) break;
    }
    return {
      ids: ids.slice(offset - first, offset - first + limit),
      // Every block keeps the correction, so the viewer's audit of it runs on any page.
      correctedQuery: blocks[0].correctedQuery,
    };
  };
}
