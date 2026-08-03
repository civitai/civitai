import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';

// The row shape returned by the internal image-delivery endpoint. `hideMeta` gates whether
// the delivery/resize path embeds the image's generation metadata (EXIF) in the served
// bytes — it controls METADATA VISIBILITY, not access to the image itself.
export type ImageDeliveryMetadata = { id: number; url: string; hideMeta: boolean };

// Cache key for the `url -> {id, url, hideMeta}` lookup. The origin query is
// `WHERE url = $1`, which is CASE- and WHITESPACE-SENSITIVE, so — unlike the citext tag
// cache — the key must be the EXACT url string, never lowercased or trimmed. Trimming or
// case-folding here would let a different url collide onto another image's cached row and
// serve the wrong { id, hideMeta }.
const getImageDeliveryMetadataCacheKey = (url: string) =>
  `${REDIS_KEYS.CACHES.IMAGE_DELIVERY_METADATA}:${url}` as `${typeof REDIS_KEYS.CACHES.IMAGE_DELIVERY_METADATA}:${string}`;

// Origin read: the single-row `Image WHERE url = $1` lookup, with the endpoint's existing
// dbRead -> dbWrite (primary) fallback preserved so a read-replica error still resolves.
const queryImageDeliveryMetadata = async (url: string): Promise<ImageDeliveryMetadata | null> => {
  const [image] = await dbRead
    .$queryRaw<ImageDeliveryMetadata[]>`
      SELECT
        id,
        url,
        "hideMeta"
      FROM "Image"
      WHERE url = ${url}
      LIMIT 1
    `
    .catch(() => {
      dbReadFallbackCounter.inc({ entity: 'image', caller: 'imageDelivery' });
      return dbWrite.$queryRaw<ImageDeliveryMetadata[]>`
        SELECT
          id,
          url,
          "hideMeta"
        FROM "Image"
        WHERE url = ${url}
        LIMIT 1
      `;
    });

  return image ?? null;
};

// Read-through cache over the near-immutable url -> {id, url, hideMeta} lookup — the hot
// caller of the highest-volume DB query in the profile (`Image WHERE url = $1`). Output is
// byte-identical to the raw query. Bucket A: DB total-exec-time / call-count reduction only,
// no behaviour change — the DB runs ~4% CPU, so this is a pod-neutral cost/margin win, NOT a
// capacity win. This offloads ONLY the image-delivery endpoint's calls; the same query has
// other callers (feed hydration, scanning) that are untouched.
//
// Fail-open like `fetchThroughCache`: on any Redis error we degrade to the origin query
// (this is a hot path — ~9.2 req/s at peak — so a Redis stall must not 500). No distributed
// stampede lock: the origin is a single-row indexed lookup that at worst runs once per url
// per TTL, so a brief cold-key stampede is trivially cheap — not worth the lock's extra
// Redis round-trips on the hot read (mirrors `getTagWithModelCount`).
//
// NEGATIVE RESULTS ARE NOT CACHED: an unknown url always re-hits the DB, so a newly
// registered image resolves immediately (no register-then-deliver staleness). This also
// shrinks invalidation to writers that change an EXISTING image's cached shape.
//
// STALENESS: `hideMeta` can flip. The privacy-sensitive direction (false -> true, the owner
// hiding their prompt) is busted explicitly in `updatePostImage` (co-located with its
// existing `purgeResizeCache`), so an app-path flip takes effect at once. An out-of-band
// flip (mod tooling / direct DB) lags at most TTL; because the delivered image BYTES are
// still separately purged/CDN-managed and this value only gates embedded-metadata
// visibility, a bounded ≤TTL window is acceptable. TTL is deliberately short (3 min) to keep
// that window tight.
export const getCachedImageDeliveryMetadata = async (
  url: string
): Promise<ImageDeliveryMetadata | null> => {
  const key = getImageDeliveryMetadataCacheKey(url);

  try {
    const cached = await redis.packed.get<ImageDeliveryMetadata>(key);
    if (cached) return cached;
  } catch {
    // Redis read degraded — fall through to the origin query (fail open).
  }

  const result = await queryImageDeliveryMetadata(url);

  if (result) {
    try {
      await redis.packed.set(key, result, { EX: CacheTTL.sm });
    } catch {
      // Best-effort cache write; a Redis stall here never fails the request.
    }
  }

  return result;
};

// Bust a single url key. Hard delete (not a staleness reset): because we never cache
// negatives, deleting the key means the next read re-queries and re-populates the fresh row.
// Called by `updatePostImage` when `hideMeta` changes.
export const bustImageDeliveryMetadataCache = async (url: string) => {
  try {
    await redis.del(getImageDeliveryMetadataCacheKey(url));
  } catch {
    // Best-effort bust; the TTL bounds any residual staleness.
  }
};
