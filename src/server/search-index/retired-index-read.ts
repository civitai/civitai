import { logToAxiom } from '~/server/logging/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import { isRetiredSearchIndex } from '~/server/search-index/retired-indexes';

// A retired index gets no writes, so whatever it still holds is frozen: moderation fields
// (nsfwLevel, poi, minor, blockedFor, availability) included. Reading it would serve those stale
// values, so a caller asks here first and answers without the index when this returns true. The
// check is the static retired list, never a feature flag: a flag read that fails returns false,
// which would send the caller back to the index.

const retiredReadCounter = registerCounterWithLabels({
  name: 'search_index_retired_read_total',
  help: 'Reads of a retired search index that were answered without querying it, by caller',
  labelNames: ['index', 'route'] as const,
});

const LOG_INTERVAL_MS = 60_000;
const loggedAt = new Map<string, number>();

/**
 * True when `index` is retired, in which case the caller must not query it. Every refusal is
 * counted; one a minute per caller is logged.
 */
export function refuseRetiredIndexRead(index: string, route: string): boolean {
  if (!isRetiredSearchIndex(index)) return false;
  retiredReadCounter.inc({ index, route });
  const key = `${index}:${route}`;
  const now = Date.now();
  if (now - (loggedAt.get(key) ?? 0) >= LOG_INTERVAL_MS) {
    loggedAt.set(key, now);
    logToAxiom(
      { type: 'warning', name: 'retired-search-index-read', index, route },
      'civitai-prod'
    );
  }
  return true;
}

/**
 * For an endpoint whose whole job is to read or backfill `index`: answer 410 and return true when
 * it is retired, so the handler returns before touching it.
 */
export function refuseRetiredIndexEndpoint(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  index: string,
  route: string
): boolean {
  if (!refuseRetiredIndexRead(index, route)) return false;
  res.status(410).json({ error: 'Gone', message: `The ${index} search index is retired.` });
  return true;
}
