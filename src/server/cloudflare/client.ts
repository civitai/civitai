import cloudflare from 'cloudflare';
import { chunk } from 'lodash-es';
import { env } from '~/env/server';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { limitConcurrency, sleep } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { slugit } from '~/utils/string-helpers';

const log = createLogger('cloudflare', 'green');

const getClient = () => {
  if (!env.CF_API_TOKEN) return null;
  const cf = new cloudflare({
    token: env.CF_API_TOKEN,
  });
  log('Created client');

  return cf;
};

const client = getClient();
const CF_PURGE_RATE_LIMIT = 1000 * 0.9; // 90% to be safe
const PURGE_BATCH_SIZE = 30;
export async function purgeCache({ urls, tags }: { urls?: string[]; tags?: string[] }) {
  if (!env.CF_ZONE_ID || !client) return;
  // Get urls from tag cache. `edgeCacheIt` records each tag slugged, so read it the same way.
  if (tags) {
    const taggedUrls = (
      await Promise.all(
        [...new Set(tags.map(slugit))].map(async (tag) =>
          redis.sMembers(`${REDIS_KEYS.CACHES.EDGE_CACHED}:${tag}`)
        )
      )
    )
      .flat()
      .map((x) => 'https://civitai.com' + x);
    urls = [...new Set([...(urls || []), ...taggedUrls])];
  }

  const toPurgeCount = urls?.length ?? 0;
  log(
    'Purging',
    toPurgeCount,
    'URLs',
    'ETA',
    Math.floor(toPurgeCount / CF_PURGE_RATE_LIMIT),
    'minutes'
  );

  const tasks = chunk(urls, PURGE_BATCH_SIZE).map((files) => async () => {
    // Fire-and-forget the CF call, but attach a .catch so a rejection
    // (429 / timeout / auth) is logged instead of escaping as an unhandled
    // promise rejection. Deliberately NOT awaited, so a caller that awaits
    // purgeCache (bulk callers pacing themselves) waits only for dispatch.
    // Dispatch is still paced by limitConcurrency's betweenTasksFn rate-limit sleep.
    client.zones.purgeCache(env.CF_ZONE_ID!, { files }).catch((error) => {
      log('Failed to purge', files.length, 'URLs from Cloudflare', error);
    });
  });
  let purged = 0;
  await limitConcurrency(tasks, {
    limit: 1,
    betweenTasksFn: async () => {
      purged += PURGE_BATCH_SIZE;
      if (purged >= CF_PURGE_RATE_LIMIT) {
        log('Waiting a minute to avoid rate limit');
        await sleep(60 * 1000);
        purged = 0;
      }
    },
  });
  // The tag sets are not cleared: a URL cached again during this purge, or whose purge failed,
  // is purged again next time. Each set is bounded and expires once nothing new is recorded.
}

/**
 * `purgeCache` for a caller that must know the purge happened: every batch is awaited and the first
 * failure throws. Not paced, so keep it to one image's urls rather than a bulk list.
 */
export async function purgeUrlsOrThrow(urls: string[], { timeoutMs = 10_000 } = {}) {
  if (!env.CF_ZONE_ID || !client) return;
  for (const files of chunk(urls, PURGE_BATCH_SIZE)) {
    // The client takes no abort signal; a hung request must not hold the caller indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.zones.purgeCache(env.CF_ZONE_ID, { files }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('cloudflare purge timed out')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
