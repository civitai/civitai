import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * Stale-while-revalidate read of image metric counts, behind the `image-metrics-swr` flag.
 *
 * With the flag OFF, `getImageMetricsObject` reads every id through MetricService.fetch
 * (event-engine-common), which repopulates entries past their refresh age on every request.
 *
 * With it ON, the hashes come from the caller's `readHashes` (image.service's
 * `readImageMetricHashesForSwr`), and an id whose hash exists is answered from it, however old, up
 * to `SWR_MAX_STALE_SECONDS`. An entry past its refresh age is handed to ONE
 * per-process refresher that coalesces ids across requests, runs at most `maxConcurrent`
 * repopulates at a time, de-duplicates ids already queued or in flight, and does not retry an id
 * it refreshed within `cooldownMs`. The repopulate itself is MetricService's own (same per-id
 * cross-pod lock, same stamp), so this changes WHEN and HOW OFTEN it runs, never what it writes.
 *
 * Ids with no cached hash, whose read did not answer in time, or whose hash is older than
 * `SWR_MAX_STALE_SECONDS`, are answered by the caller's `fetchCold` - the flag-OFF path - and that
 * request waits for them. The caller bounds that wait (image.service gives it only what is left of
 * the flag-OFF read's own time budget).
 */

// Mirrors event-engine-common/services/metrics.ts (REFRESH_AFTER, UNSTAMPED_REFRESH_CHANCE,
// POPULATED_AT_FIELD). Not imported: the submodule does not export them. image-metrics-swr.test.ts
// reads them from the submodule's source and fails if these drift.
export const SWR_REFRESH_AFTER_SECONDS = 60 * 60;
export const SWR_UNSTAMPED_REFRESH_CHANCE = 0.05;
export const SWR_POPULATED_AT_FIELD = '_populatedAt';
// The cached entry's TTL is 12h and a served entry is refreshed after 1h, so an entry this old
// means its refreshes are not landing (dropped, failing, or its key never read). Past it the id is
// read the flag-OFF way, which still serves the entry and repopulates it itself.
export const SWR_MAX_STALE_SECONDS = 6 * 60 * 60;

export type MetricHash = Record<string, string>;
// `cold`: Redis answered and holds no hash for the id. `unanswered`: the read rejected or missed
// its deadline, so whether a hash exists is unknown - a slow or failing Redis, not a cache miss.
export type SwrClass = 'fresh' | 'stale' | 'unstamped' | 'cold' | 'unanswered' | 'overstale';

const swrIdsCounter = registerCounterWithLabels({
  name: 'image_metrics_swr_ids_total',
  help: 'Ids read by the image-metrics-swr path, by how the cached hash classified (fresh, stale, unstamped: served from cache; cold: no hash cached, unanswered: the cache read rejected or missed its deadline, overstale: past the max-staleness bound - all three read through MetricService on the request)',
  labelNames: ['class'] as const,
});

const swrRefreshCounter = registerCounterWithLabels({
  name: 'image_metrics_swr_refresh_total',
  help: 'image-metrics-swr background refresher, by outcome: queued/deduped/cooldown/dropped count ids offered; batch_ok/batch_error count repopulate batches run',
  labelNames: ['outcome'] as const,
});

type RefreshOutcome = 'queued' | 'deduped' | 'cooldown' | 'dropped' | 'batch_ok' | 'batch_error';
const countRefresh = (outcome: RefreshOutcome, n = 1) => {
  if (n > 0) swrRefreshCounter.inc({ outcome }, n);
};

export function classifyMetricHash(
  hash: MetricHash | undefined,
  nowSeconds: number,
  maxStaleSeconds: number = SWR_MAX_STALE_SECONDS
): SwrClass {
  if (!hash) return 'unanswered';
  if (Object.keys(hash).length === 0) return 'cold';
  const populatedAt = Number(hash[SWR_POPULATED_AT_FIELD]);
  if (!populatedAt) return 'unstamped';
  const age = nowSeconds - populatedAt;
  if (age >= maxStaleSeconds) return 'overstale';
  if (age >= SWR_REFRESH_AFTER_SECONDS) return 'stale';
  return 'fresh';
}

export type MetricRefresherOptions = {
  /** How long ids collect before a batch runs. */
  flushMs?: number;
  /** Ids per repopulate. Below MetricService's 1000-id ClickHouse batch, so one query each. */
  batchSize?: number;
  /** Repopulates in flight at once, per process. */
  maxConcurrent?: number;
  /** Ids waiting; past this new ids are dropped (they stay stale and are offered again later). */
  maxPending?: number;
  /** An id refreshed (or attempted) this recently is not offered again. */
  cooldownMs?: number;
  /** Bound on the cooldown memory. */
  maxRecent?: number;
  now?: () => number;
};

export type MetricRefresher = {
  enqueue: (ids: number[]) => void;
  /** Tests only: run whatever the concurrency cap allows now, without waiting for the timer. */
  flushNow: () => void;
  stats: () => { pending: number; inFlight: number; running: number; recent: number };
};

export function createMetricRefresher(
  refresh: (ids: number[]) => Promise<unknown>,
  {
    flushMs = 1_000,
    batchSize = 200,
    maxConcurrent = 2,
    maxPending = 2_000,
    cooldownMs = 60_000,
    maxRecent = 20_000,
    now = Date.now,
  }: MetricRefresherOptions = {}
): MetricRefresher {
  const pending = new Set<number>();
  const inFlight = new Set<number>();
  // Insertion order is completion order (delete before set), so the oldest entries come first.
  const recent = new Map<number, number>();
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const remember = (id: number, at: number) => {
    recent.delete(id);
    recent.set(id, at);
    // Oldest first, which is also expired first. Evicting an unexpired one only lets that id be
    // offered again early.
    for (const key of recent.keys()) {
      if (recent.size <= maxRecent) break;
      recent.delete(key);
    }
  };

  const schedule = () => {
    if (timer || pending.size === 0 || running >= maxConcurrent) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, flushMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const flush = () => {
    while (running < maxConcurrent && pending.size > 0) {
      const batch: number[] = [];
      for (const id of pending) {
        batch.push(id);
        if (batch.length >= batchSize) break;
      }
      for (const id of batch) {
        pending.delete(id);
        inFlight.add(id);
      }
      running += 1;

      let work: Promise<unknown>;
      try {
        work = Promise.resolve(refresh(batch));
      } catch (error) {
        work = Promise.reject(error);
      }
      work
        .then(
          () => countRefresh('batch_ok'),
          () => countRefresh('batch_error')
        )
        .finally(() => {
          const at = now();
          for (const id of batch) {
            inFlight.delete(id);
            remember(id, at);
          }
          running -= 1;
          // A full batch already waiting has waited long enough: re-arming the timer here would
          // cap throughput at maxConcurrent * batchSize per (refresh time + flushMs). A partial
          // batch still waits for the timer, so ids keep coalescing.
          if (pending.size >= batchSize) {
            if (timer) clearTimeout(timer);
            timer = undefined;
            flush();
          } else schedule();
        });
    }
  };

  const enqueue = (ids: number[]) => {
    const at = now();
    let queued = 0;
    let deduped = 0;
    let cooldown = 0;
    let dropped = 0;
    for (const id of ids) {
      if (pending.has(id) || inFlight.has(id)) {
        deduped += 1;
        continue;
      }
      const last = recent.get(id);
      if (last !== undefined && at - last < cooldownMs) {
        cooldown += 1;
        continue;
      }
      if (pending.size >= maxPending) {
        dropped += 1;
        continue;
      }
      pending.add(id);
      queued += 1;
    }
    countRefresh('queued', queued);
    countRefresh('deduped', deduped);
    countRefresh('cooldown', cooldown);
    countRefresh('dropped', dropped);
    schedule();
  };

  return {
    enqueue,
    flushNow: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      flush();
    },
    stats: () => ({ pending: pending.size, inFlight: inFlight.size, running, recent: recent.size }),
  };
}

export type SwrDeps<T> = {
  /** One entry per id, aligned by index; undefined for a key that did not answer in time. */
  readHashes: (ids: number[]) => Promise<(MetricHash | undefined)[]>;
  /** The cached hash as the caller's entry type. */
  shape: (id: number, hash: MetricHash) => T;
  /** The flag-OFF read, for ids the cache cannot answer. Awaited, as before. */
  fetchCold: (ids: number[]) => Promise<Record<number, T>>;
  /** Hand ids to the background refresher. Never awaited. */
  enqueueRefresh: (ids: number[]) => void;
  nowSeconds?: () => number;
  random?: () => number;
};

export async function resolveMetricsStaleWhileRevalidate<T>(
  ids: number[],
  {
    readHashes,
    shape,
    fetchCold,
    enqueueRefresh,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    random = Math.random,
  }: SwrDeps<T>
): Promise<Record<number, T>> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return {};

  const hashes = await readHashes(uniqueIds);
  const now = nowSeconds();
  const result: Record<number, T> = {};
  const cold: number[] = [];
  const due: number[] = [];
  const counts: Record<SwrClass, number> = {
    fresh: 0,
    stale: 0,
    unstamped: 0,
    cold: 0,
    unanswered: 0,
    overstale: 0,
  };

  uniqueIds.forEach((id, index) => {
    const hash = hashes[index];
    const cls = classifyMetricHash(hash, now);
    counts[cls] += 1;
    if (cls === 'cold' || cls === 'unanswered' || cls === 'overstale' || !hash) {
      cold.push(id);
      return;
    }
    result[id] = shape(id, hash);
    // Unstamped entries refresh on a share of reads, as MetricService does, so a population of
    // pre-stamp entries is not repopulated all at once.
    if (cls === 'stale' || (cls === 'unstamped' && random() < SWR_UNSTAMPED_REFRESH_CHANCE))
      due.push(id);
  });

  for (const cls of Object.keys(counts) as SwrClass[])
    if (counts[cls] > 0) swrIdsCounter.inc({ class: cls }, counts[cls]);

  if (due.length) {
    try {
      enqueueRefresh(due);
    } catch {
      // The answer is already in hand; a refresher fault must not cost the request.
    }
  }

  if (cold.length) Object.assign(result, await fetchCold(cold));
  return result;
}

const readSwrFlag = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.IMAGE_METRICS_SWR);

let swrGate = createCachedFlagGate(readSwrFlag);

/** `image-metrics-swr`, read at most once per 5s per process; unknown or a throw reads as OFF. */
export const imageMetricsSwrEnabled = () => swrGate();

/** Tests only: forget the cached flag read. */
export function resetImageMetricsSwrGateForTests() {
  swrGate = createCachedFlagGate(readSwrFlag);
}
