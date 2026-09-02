import { REDIS_SYS_KEYS } from '@civitai/redis';
import { MODEL_CARDS, type FromPrices } from '$lib/data/trainingModels';
import { getSysRedis } from './redis';
import { trainingWhatIf } from './orchestrator';

const CACHE_KEY = REDIS_SYS_KEYS.TRAINING.STUDIO_FROM_PRICES;
// Stale-while-revalidate: a cached map older than FRESH is still served immediately, but triggers a
// background refresh. HARD is how long redis keeps a value at all — the backstop for a long traffic
// lull, so we can serve stale rather than recompute on a user's load.
const FRESH_SECONDS = 6 * 60 * 60;
const HARD_TTL_SECONDS = 7 * 24 * 60 * 60;
// The estimate calls are independent one-per-model round-trips; a few at a time keeps the sweep quick
// without hammering the orchestrator with ~20 at once.
const WHATIF_CONCURRENCY = 4;

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
  const prices: FromPrices = {};
  const unpriced: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < MODEL_CARDS.length) {
      const card = MODEL_CARDS[next++];
      const version = card?.versions[0];
      if (!card || !version) continue;
      try {
        const cost = await trainingWhatIf(token, {
          ecosystem: version.ecosystem,
          modelVariant: version.modelVariant,
          version: version.version,
          model: version.air,
          engine: version.engine,
        });
        if (typeof cost === 'number' && cost > 0) prices[card.type] = Math.round(cost);
        else unpriced.push(card.type);
      } catch {
        // Leave this card unpriced (shown as "—"); one model's failure shouldn't blank the rest.
        unpriced.push(card.type);
      }
    }
  };

  await Promise.all(Array.from({ length: WHATIF_CONCURRENCY }, worker));

  // Some catalog ecosystems aren't submittable as configured (a bad AIR, a missing modelVariant, an
  // unsupported engine). Surface it so a partial or total blackout is visible in logs.
  if (unpriced.length) {
    console.warn(
      `[training-studio] from-price whatif: ${unpriced.length}/${
        MODEL_CARDS.length
      } models unpriced (${unpriced.join(', ')})`
    );
  }

  if (Object.keys(prices).length === 0) return prices; // nothing priced (e.g. bad token) — keep any stale value, don't overwrite with empty
  try {
    await getSysRedis().packed.set(CACHE_KEY, { prices, at: Date.now() }, { EX: HARD_TTL_SECONDS });
  } catch {
    // best-effort; a later load re-refreshes
  }
  return prices;
}
