import { REDIS_SYS_KEYS } from '@civitai/redis';
import type { FromPrices } from '$lib/data/trainingModels';
import { computeFromPrices } from '$lib/pricing-core';
import { getSysRedis } from './redis';
import { orchestratorClient } from './orchestrator';

const CACHE_KEY = REDIS_SYS_KEYS.TRAINING.STUDIO_FROM_PRICES;
// Stale-while-revalidate: a cached map older than FRESH is still served immediately, but triggers a
// background refresh. HARD is how long redis keeps a value at all — the backstop for a long traffic
// lull, so we can serve stale rather than recompute on a user's load.
const FRESH_SECONDS = 6 * 60 * 60;
const HARD_TTL_SECONDS = 7 * 24 * 60 * 60;

type CacheEntry = { prices: FromPrices; at: number };

// Per-pod de-dupe: concurrent cold-cache loads (and concurrent stale-triggered refreshes) share one
// in-flight sweep instead of each firing ~20 whatIfs.
let refreshInFlight: Promise<FromPrices> | null = null;

/**
 * Live per-card "from" prices from a GLOBAL shared cache (one redis key for all users — never per-user).
 * Stale entries are served immediately and refreshed in the background, so no load computes on the
 * critical path. PARTIAL — a model the orchestrator can't price is absent. Never throws; return unawaited
 * to stream into the loader.
 */
export async function getFromPrices(token: string): Promise<FromPrices> {
  let entry: CacheEntry | null = null;
  try {
    entry = await getSysRedis().packed.get<CacheEntry>(CACHE_KEY);
  } catch {
    // redis blip — treat as cold
  }

  if (entry?.prices) {
    // Aged past the freshness window: kick a deduped background refresh (void — this load returns stale).
    if (Date.now() - entry.at > FRESH_SECONDS * 1000) void refresh(token).catch(() => {});
    return entry.prices;
  }

  // Cold (never computed, or hard TTL lapsed): compute once, deduped.
  return refresh(token);
}

function refresh(token: string): Promise<FromPrices> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = computeAndCache(token).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function computeAndCache(token: string): Promise<FromPrices> {
  const prices = await computeFromPrices(orchestratorClient(token));

  if (Object.keys(prices).length === 0) return prices; // nothing priced (e.g. bad token) — keep any stale value, don't overwrite with empty
  try {
    await getSysRedis().packed.set(CACHE_KEY, { prices, at: Date.now() }, { EX: HARD_TTL_SECONDS });
  } catch {
    // best-effort; a later load re-refreshes
  }
  return prices;
}
