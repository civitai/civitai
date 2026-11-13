import client, { type Counter, type Histogram, type Registry } from 'prom-client';
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
