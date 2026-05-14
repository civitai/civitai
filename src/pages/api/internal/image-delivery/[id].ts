import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  cacheHitCounter,
  cacheMissCounter,
  dbReadFallbackCounter,
  registerCounterWithLabels,
} from '~/server/prom/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({ id: z.string() });
type ImageRow = {
  id: number;
  url: string;
  hideMeta: boolean;
};
// Cached shape omits `url` — it's already in the cache key (the request param),
// so storing it twice wastes ~50 bytes/entry on a high-cardinality cache. We
// rehydrate the full ImageRow from the request `id` (== url) on cache hit.
type CachedImage = { id: number; hideMeta: boolean };

// URL -> {id, hideMeta} is essentially immutable. The only mutation paths are
// moderator `hideMeta` toggle and image deletion — both are rare and absorbed
// by the TTL (clients re-resolve at expiry). Negative results are NOT cached:
// a 404 here can flip to 200 the moment an Image row is created, and caching
// `null` would mask that for hours.
//
// TTL choice: 4h. The cluster's `allkeys-lru` policy means hot keys stay hot
// regardless of TTL, so a long TTL doesn't buy us hit rate — it just inflates
// the cold-tail entry count and pressures other caches via eviction. Image-
// cacher request patterns are Zipf with most repeats within minutes; 4h
// captures essentially all reuse while bounding worst-case footprint.
const CACHE_TTL_SECONDS = 4 * 60 * 60;
const CACHE_NAME = 'imageDelivery';
const CACHE_TYPE = 'queryCache';
// Cap key length to keep Redis memory bounded against malformed/abusive URLs.
// Real image URLs are ~40-50 chars; 256 is a generous ceiling.
const MAX_CACHEABLE_URL_LENGTH = 256;

const imageDeliveryRequestCounter = registerCounterWithLabels({
  name: 'image_delivery_request_total',
  help: 'Total image delivery requests by status',
  labelNames: ['status'] as const,
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results = schema.safeParse(req.query);
  if (!results.success) {
    imageDeliveryRequestCounter.inc({ status: 'invalid_url' });
    return res.status(400).json({ error: z.prettifyError(results.error) ?? 'Invalid Url' });
  }

  const { id } = results.data;
  const cacheable = id.length <= MAX_CACHEABLE_URL_LENGTH;
  const cacheKey = `${REDIS_KEYS.CACHES.IMAGE_DELIVERY}:${id}` as const;

  if (cacheable) {
    const cached = await redis.packed.get<CachedImage>(cacheKey).catch(() => null);
    if (cached) {
      cacheHitCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });
      imageDeliveryRequestCounter.inc({ status: 'found' });
      // Rehydrate the response shape — `url` comes from the request param.
      return res.status(200).json({ id: cached.id, url: id, hideMeta: cached.hideMeta });
    }
    cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: CACHE_TYPE });
  }

  const query = () => dbRead.$queryRaw<ImageRow[]>`
    SELECT
      id,
      url,
      "hideMeta"
    FROM "Image"
    WHERE url = ${id}
    LIMIT 1
  `;

  const [image] = await query().catch(() => {
    dbReadFallbackCounter.inc({ entity: 'image', caller: 'imageDelivery' });
    return dbWrite.$queryRaw<ImageRow[]>`
      SELECT
        id,
        url,
        "hideMeta"
      FROM "Image"
      WHERE url = ${id}
      LIMIT 1
    `;
  });

  if (!image) {
    imageDeliveryRequestCounter.inc({ status: 'not_found' });
    return res.status(404).json({ error: 'Image not found' });
  }

  if (cacheable) {
    // Fire-and-forget; don't block the response on Redis write.
    // Store only {id, hideMeta} — `url` is already the cache key.
    const cacheValue: CachedImage = { id: image.id, hideMeta: image.hideMeta };
    redis.packed
      .set(cacheKey, cacheValue, { EX: CACHE_TTL_SECONDS })
      .catch(() => undefined);
  }

  imageDeliveryRequestCounter.inc({ status: 'found' });
  res.status(200).json(image);
});
