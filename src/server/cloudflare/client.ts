import cloudflare from 'cloudflare';
import { chunk } from 'lodash-es';
import { env } from '~/env/server.mjs';
import { redis, REDIS_KEYS } from '~/server/redis/client';
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

  await Promise.all(
    chunk(urls, 30).map((files) => client.zones.purgeCache(env.CF_ZONE_ID!, { files }))
  );

  // Clean-up tag cache
  if (tags) {
    await Promise.all(
      tags.map(async (tag) => redis.del(REDIS_KEYS.CACHES.EDGE_CACHED + ':' + tag))
    );
  }
}
