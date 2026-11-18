import { createHash } from 'crypto';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { semanticSearchCandidateCache } from '~/server/metrics/semantic-search.metrics';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { createSingleFlight } from '~/server/utils/cache-helpers';
import { withBulkheadSlotOrBusy } from '~/server/utils/request-bulkhead';
import { clusterCacheGuard } from '~/server/redis/cluster-cache-guard';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  guardKey,
  readGuardStatus,
  UNKNOWN_GUARD_STATUS,
  type GuardStatus,
} from '~/server/services/semantic-guard-status';
import {
  buildQdrantFilter,
  type CandidateSource,
  type GuardOutcome,
  type GuardRead,
  MAX_CANDIDATE_LIMIT,
  type SearchCollection,
} from '~/server/services/semantic-search-client';

// collectPage asks for at most a block of ids at a time, so a request spans one or two blocks. Blocks
// are aligned so viewers whose hydration drops different images still share them past page 1.
export const CANDIDATE_BLOCK = MAX_CANDIDATE_LIMIT;

type Block = { ids: number[]; correctedQuery?: string; guard?: GuardRead };
type Read = { block: Block; hit: boolean };

// Identical misses in flight on this pod share one service call.
const blockFlight = createSingleFlight();
type CandidateKey = `${typeof REDIS_KEYS.SEMANTIC_SEARCH.CANDIDATES}:${string}`;

// Through the shared guard: a deadline, and the breaker that skips Redis while it is down.
const readBlock = (key: CandidateKey) =>
  clusterCacheGuard.readOr('semantic candidates get', () => redis.packed.get<Block>(key), null);

// Outcomes where the guard reached a verdict. Anything else, including a value added later, is cached
// by no one: a block served while the guard was down would outlive its recovery by the cache TTL.
const VERDICT_OUTCOMES: ReadonlySet<GuardOutcome> = new Set(['pass', 'flag']);

/**
 * The key's mode comes from the pod's memoised status read, which can lag the replica that answered.
 * A block is cached only under the mode and version that judged it, or when no guard ran on the text.
 */
function judgedUnder(blockGuard: GuardRead | undefined, key: string | undefined) {
  if (key === undefined || blockGuard?.outcome === 'none') return true;
  if (!blockGuard || !VERDICT_OUTCOMES.has(blockGuard.outcome)) return false;
  return guardKey(blockGuard.mode, blockGuard.version) === key;
}

/**
 * The key is everything the service answers from (the query and the Qdrant filter, which carries the
 * viewer's clamped level gate) plus the viewer class, so a block is never shared across mods and
 * non-mods. Nothing in it is per user: refusals run before the source, and hydration after it, per
 * viewer. One wrapper serves one search request, so its blocks are also memoized across that
 * request's hydration rounds.
 *
 * With the audit flag on, the key also carries the guard's mode and version, so an enforce flip or a
 * new artifact stops serving blocks the old guard judged. An unreadable status skips Redis.
 */
export function withCandidateCache(
  collection: SearchCollection,
  source: CandidateSource,
  viewerClass: 'mod' | 'user',
  guardStatus: () => Promise<GuardStatus> = readGuardStatus
): CandidateSource {
  const fetched = new Map<string, Promise<Read>>();
  let guardKey: Promise<string | undefined> | undefined;
  const guardKeyOnce = () =>
    (guardKey ??= isFlipt(FLIPT_FEATURE_FLAGS.SEMANTIC_SEARCH_AUDIT).then((on) =>
      on ? guardStatus().then((s) => s.key) : undefined
    ));

  return async (args) => {
    const { query, filter, offset, limit, sort } = args;
    const qdrantFilter = buildQdrantFilter(collection, filter);
    const guard = await guardKeyOnce();
    const uncached = guard === UNKNOWN_GUARD_STATUS.key;
    const fetchBlock = (start: number) =>
      withBulkheadSlotOrBusy(`semantic-search:${collection}`, env.SEMANTIC_SEARCH_CONCURRENCY, () =>
        source({ ...args, offset: start, limit: CANDIDATE_BLOCK })
      ).then(
        (fresh): Block => ({
          ids: fresh.ids,
          correctedQuery: fresh.correctedQuery,
          guard: fresh.guard,
        })
      );
    const keyOf = (start: number) =>
      `${REDIS_KEYS.SEMANTIC_SEARCH.CANDIDATES}:${collection}:${createHash('sha256')
        .update(JSON.stringify({ query, qdrantFilter, sort, start, viewerClass, guard }))
        .digest('hex')}` as const;
    const write = (key: CandidateKey, block: Block) =>
      uncached || !judgedUnder(block.guard, guard)
        ? undefined
        : clusterCacheGuard.writeBestEffort('semantic candidates set', () =>
            redis.packed.set(key, block, { EX: CacheTTL.md })
          );

    const block = (start: number) => {
      const key = keyOf(start);
      let pending = fetched.get(key);
      if (!pending) {
        pending = (async (): Promise<Read> => {
          const cached = uncached ? null : await readBlock(key);
          semanticSearchCandidateCache().inc({
            index: collection,
            result: cached ? 'hit' : 'miss',
          });
          if (cached) return { block: cached, hit: true };
          // The shared call keeps the service's own timeout: no single caller's abort ends it.
          const fresh = await blockFlight(key, async () => {
            const fresh = await fetchBlock(start);
            void write(key, fresh);
            return fresh;
          });
          return { block: fresh, hit: false };
        })();
        fetched.set(key, pending);
        pending.catch(() => fetched.delete(key));
      }
      return pending;
    };

    const first = Math.floor(offset / CANDIDATE_BLOCK) * CANDIDATE_BLOCK;
    const starts: number[] = [];
    for (let start = first; start < offset + limit; start += CANDIDATE_BLOCK) starts.push(start);
    let reads = await Promise.all(starts.map(block));
    // Blocks cached apart can disagree on the spelling correction. The viewer audits one correction
    // per response, so a disagreeing range is fetched again in one go.
    if (new Set(reads.map((r) => r.block.correctedQuery)).size > 1) {
      reads = (await Promise.all(starts.map(fetchBlock))).map((b) => ({ block: b, hit: false }));
      reads.forEach((r, i) => {
        const key = keyOf(starts[i]);
        fetched.set(key, Promise.resolve(r));
        void write(key, r.block);
      });
    }

    const ids: number[] = [];
    for (const { block: b } of reads) {
      ids.push(...b.ids);
      // A short block is the end of the ranking.
      if (b.ids.length < CANDIDATE_BLOCK) break;
    }
    return {
      ids: ids.slice(offset - first, offset - first + limit),
      // Every block keeps the correction, so the viewer's audit of it runs on any page.
      correctedQuery: reads[0].block.correctedQuery,
      guard: reads[0].block.guard,
      cacheHit: reads[0].hit,
    };
  };
}
