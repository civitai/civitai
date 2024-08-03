import cloudflare from 'cloudflare';
import { chunk } from 'lodash-es';
import { env } from '~/env/server.mjs';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { limitConcurrency, sleep } from '~/server/utils/concurrency-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createLogger } from '~/utils/logging';

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
  // Get urls from tag cache
  if (tags) {
    const taggedUrls = (
      await Promise.all(
        tags.map(async (tag) => redis.sMembers(REDIS_KEYS.CACHES.EDGE_CACHED + ':' + tag))
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
    client.zones.purgeCache(env.CF_ZONE_ID!, { files });
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

  // Clean-up tag cache
  if (tags) {
    await Promise.all(
      tags.map(async (tag) => redis.del(REDIS_KEYS.CACHES.EDGE_CACHED + ':' + tag))
    );
  }
}
