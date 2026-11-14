import client, { type Counter, type Gauge, type Histogram, type Registry } from 'prom-client';
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

const VERDICTS = 'semantic_search_query_verdicts_total';

export function ensureRegisterQueryVerdictCounter(reg: Registry = client.register) {
  const existing = reg.getSingleMetric(VERDICTS) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: VERDICTS,
    help: 'Semantic search queries the query audit flagged or failed to audit (verdict error); stage is the raw query or the spelling correction',
    labelNames: ['index', 'verdict', 'stage'],
    registers: [reg],
  });
}

export function countQueryVerdict(index: string, verdict: string, stage: string, reg?: Registry) {
  ensureRegisterQueryVerdictCounter(reg).inc({ index, verdict, stage });
}

const RULE_READS = 'semantic_search_query_rule_reads_total';

/** Labels carry the rule type and where it was read from, never a term. */
export function countQueryRuleRead(type: string, source: string, reg: Registry = client.register) {
  const counter =
    (reg.getSingleMetric(RULE_READS) as Counter<string> | undefined) ??
    new client.Counter({
      name: RULE_READS,
      help: 'Semantic search query rule reads by rule type and source (db, cache or fallback)',
      labelNames: ['type', 'source'],
      registers: [reg],
    });
  counter.inc({ type, source });
}

const RULE_STALE = 'semantic_search_query_rule_stale_seconds';

/** Age of the last good rules copy this pod is serving while the blocklist is unreadable; 0 when fresh. */
export function setQueryRuleStaleAge(
  type: string,
  seconds: number,
  reg: Registry = client.register
) {
  const gauge =
    (reg.getSingleMetric(RULE_STALE) as Gauge<string> | undefined) ??
    new client.Gauge({
      name: RULE_STALE,
      help: 'Age in seconds of the semantic search query rules copy served while the blocklist is unreadable (0 when read fresh)',
      labelNames: ['type'],
      registers: [reg],
    });
  gauge.set({ type }, seconds);
}

const CACHE_NAME = 'semantic_search_candidate_cache_total';
const STAGE_NAME = 'semantic_search_stage_seconds';

/** Candidate blocks read from the Redis cache (hit) or fetched from the search service (miss). */
export function semanticSearchCandidateCache(reg: Registry = client.register) {
  const existing = reg.getSingleMetric(CACHE_NAME) as Counter<string> | undefined;
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
