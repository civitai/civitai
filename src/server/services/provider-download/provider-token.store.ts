import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache, setFetchThroughCache } from '~/server/utils/cache-helpers';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import {
  liveProviderTokens,
  parseProviderTokenRecords,
  type LiveProviderToken,
  type ProviderTokenRecord,
} from '~/server/services/provider-download/provider-token';

/** The KeyValue row holding every provider download token, live and retired. */
export const PROVIDER_TOKENS_KEY = 'provider-download-tokens';

const CACHE_KEY = REDIS_KEYS.CACHES.PROVIDER_DOWNLOAD_TOKENS;
/**
 * Every write replaces the cached entry. This bounds a write whose cache update failed, and a refill
 * that read the row just before a write committed and stored it just after.
 */
const CACHE_TTL = CacheTTL.xs;
/** As the download blocklist: a stalled cache never delays a download by more than this. */
const CACHE_DEADLINE_MS = 500;
const CACHE_TIMED_OUT = Symbol('provider-tokens-cache-timed-out');

async function registeredProviders(db: typeof dbWrite): Promise<Set<string>> {
  const rows = await db.workerClient.findMany({
    select: { provider: true },
    distinct: ['provider'],
  });
  return new Set(rows.map((row) => row.provider));
}

async function readLiveTokens(db: typeof dbWrite): Promise<LiveProviderToken[]> {
  const [row, providers] = await Promise.all([
    db.keyValue.findUnique({ where: { key: PROVIDER_TOKENS_KEY } }),
    registeredProviders(db),
  ]);
  return liveProviderTokens(parseProviderTokenRecords(row?.value), providers);
}

/**
 * The live provider tokens, through a short-lived Redis cache. Every cache failure falls back to a
 * database read; a database error is thrown, so the caller can answer 503 rather than 401.
 *
 * Read from the primary, not a replica: a refill that read a lagging replica could put a retired
 * token back in the cache for another TTL.
 */
export async function getLiveProviderTokens(): Promise<LiveProviderToken[]> {
  let originFailed = false;
  try {
    const cached = await withTimeoutFallback<LiveProviderToken[] | typeof CACHE_TIMED_OUT>(
      fetchThroughCache(
        CACHE_KEY,
        async () => {
          try {
            return await readLiveTokens(dbWrite);
          } catch (error) {
            originFailed = true;
            throw error;
          }
        },
        { ttl: CACHE_TTL, retryCount: 0 }
      ),
      CACHE_DEADLINE_MS,
      CACHE_TIMED_OUT
    );
    if (cached !== CACHE_TIMED_OUT) return cached;
  } catch (error) {
    if (originFailed) throw error;
  }
  return readLiveTokensShared();
}

let sharedRead: Promise<LiveProviderToken[]> | undefined;

/** One row read per pod at a time, for requests that found no cached value they could use. */
function readLiveTokensShared() {
  sharedRead ??= readLiveTokens(dbWrite).finally(() => {
    sharedRead = undefined;
  });
  return sharedRead;
}

/**
 * Applies `change` to the stored records under a lock, then replaces the cached live set, so the
 * change reaches downloads at once unless that cache write fails (then once the cached entry goes
 * stale, normally within `CACHE_TTL`). `change` returns the new records (omitted: nothing is
 * written), or an error to refuse.
 */
export async function updateProviderTokenRecords<T>(
  change: (
    records: ProviderTokenRecord[],
    registered: ReadonlySet<string>
  ) => { records?: ProviderTokenRecord[]; result: T } | { error: string }
): Promise<{ result: T } | { error: string }> {
  const outcome = await dbWrite.$transaction(async (tx) => {
    // The row is the lock: create it if missing, then hold it until commit.
    await tx.keyValue.upsert({
      where: { key: PROVIDER_TOKENS_KEY },
      create: { key: PROVIDER_TOKENS_KEY, value: [] },
      update: {},
    });
    const [[row], registered] = await Promise.all([
      tx.$queryRaw<{ value: unknown }[]>`
        SELECT value FROM "KeyValue" WHERE key = ${PROVIDER_TOKENS_KEY} FOR UPDATE`,
      registeredProviders(tx as unknown as typeof dbWrite),
    ]);
    const changed = change(parseProviderTokenRecords(row?.value), registered);
    if ('error' in changed) return changed;
    if (!changed.records) return { result: changed.result, live: undefined };
    await tx.keyValue.update({
      where: { key: PROVIDER_TOKENS_KEY },
      data: { value: changed.records },
    });
    return { result: changed.result, live: liveProviderTokens(changed.records, registered) };
  });
  if ('error' in outcome) return outcome;
  if (outcome.live) await setFetchThroughCache(CACHE_KEY, outcome.live, { ttl: CACHE_TTL });
  return { result: outcome.result };
}
