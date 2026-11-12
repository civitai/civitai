import client, { type Histogram, type Registry } from 'prom-client';
import { middleware } from '~/server/trpc';

const NAME = 'semantic_search_request_seconds';

/** Idempotent: safe to call multiple times. */
export function ensureRegisterSemanticSearchMetrics(reg: Registry = client.register) {
  const existing = reg.getSingleMetric(NAME) as Histogram<string> | undefined;
  if (existing) return existing;
  return new client.Histogram({
    name: NAME,
    help: 'Site-side semantic search time, request in to hydrated results out; status is ok or the tRPC error code',
    labelNames: ['index', 'status'],
    // The site waits 20 s for the search service, so the tail buckets reach past it.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30],
    registers: [reg],
  });
}

/** Put it first on the procedure so rate-limit and flag refusals are timed and counted too. */
export const timeSemanticSearch = (index: string, reg?: Registry) =>
  middleware(async ({ next }) => {
    const end = ensureRegisterSemanticSearchMetrics(reg).startTimer({ index });
    const result = await next();
    end({ status: result.ok ? 'ok' : result.error.code });
    return result;
  });

const CACHE_NAME = 'semantic_search_candidate_cache_total';
const STAGE_NAME = 'semantic_search_stage_seconds';

/** Candidate blocks read from the Redis cache (hit) or fetched from the search service (miss). */
export function semanticSearchCandidateCache(reg: Registry = client.register) {
  const existing = reg.getSingleMetric(CACHE_NAME) as client.Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: CACHE_NAME,
    help: 'Semantic search candidate blocks by cache result',
    labelNames: ['index', 'result'],
    registers: [reg],
  });
}

/** Where a search's time goes: ranked candidates (cache or search service) vs hydration. */
export function semanticSearchStage(reg: Registry = client.register) {
  const existing = reg.getSingleMetric(STAGE_NAME) as Histogram<string> | undefined;
  if (existing) return existing;
  return new client.Histogram({
    name: STAGE_NAME,
    help: 'Semantic search time per stage within one request',
    labelNames: ['index', 'stage'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 10, 15, 20],
    registers: [reg],
  });
}
