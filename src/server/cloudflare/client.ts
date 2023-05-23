import cloudflare from 'cloudflare';
import { env } from '~/env/server.mjs';
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

const client: ReturnType<typeof getClient> | null = null;
getClient();

export function purgeCache({ urls, tags }: { urls?: string[]; tags?: string[] }) {
  if (!env.CF_ZONE_ID) return;
  client?.zones.purgeCache(env.CF_ZONE_ID, {
    tags,
    prefixes: urls,
  });
  log('Purged cache', { urls, tags });
}
