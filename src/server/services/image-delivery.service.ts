import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { Prisma } from '@prisma/client';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type { MediaType } from '~/shared/utils/prisma/enums';

// The row shape returned by the internal image-delivery endpoint. `hideMeta` gates whether
// the delivery/resize path embeds the image's generation metadata (EXIF) in the served
// bytes — it controls METADATA VISIBILITY, not access to the image itself.
//
// `type` / `mimeType` describe WHAT the stored media is, so a caller can tell a video from
// an image before choosing how to serve it. Without them every entry looks like an image,
// and video uploads get pushed down an image-only conversion path that cannot handle them.
//
// `type` is the discriminator to branch on: `Image.type` is NOT NULL with a default, so it
// is present on every row, old and new. `mimeType` is NULLABLE — it refines the container
// (`video/mp4` vs `image/gif`) but is genuinely absent on older rows, so it is typed and
// documented as `string | null` and must never be treated as a fallback discriminator.
export type ImageDeliveryMetadata = {
  id: number;
  url: string;
  hideMeta: boolean;
  type: MediaType;
  /**
   * A non-empty mime type (`video/mp4`, `image/jpeg`, …) or `null` when the stored row has
   * none. NEVER `undefined` and never `''` — see `normalizeMimeType`.
   */
  mimeType: string | null;
};

// The raw row as Postgres hands it back, BEFORE the mimeType normalization below — which is
// why `mimeType` is wider here than on the public type: the normalization is what narrows it
// to `string | null`, so this must not already promise that.
type ImageDeliveryMetadataRow = Omit<ImageDeliveryMetadata, 'mimeType'> & {
  mimeType: string | null | undefined;
};

// `Image.mimeType` is nullable and old rows predate it. Collapse every "no usable value"
// spelling to a single explicit `null`:
//   - `undefined` would be DROPPED by JSON.stringify, so the key would vanish from the
//     response body and a caller could not tell "unknown mime type" from "this deployment
//     does not send the field at all";
//   - `''` is a PRESENT value that is not a real mime type — exactly the kind of thing a
//     caller mistakes for data.
// The contract is therefore: a non-empty string, or `null`.
const normalizeMimeType = (mimeType: string | null | undefined): string | null => {
  if (typeof mimeType !== 'string') return null;
  const trimmed = mimeType.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Cache key for the `url -> {id, url, hideMeta, type, mimeType}` lookup. The origin query
// matches `url` exactly (CASE- and WHITESPACE-SENSITIVE), so — unlike the citext tag
// cache — the key must be the EXACT url string, never lowercased or trimmed. Trimming or
// case-folding here would let a different url collide onto another image's cached row and
// serve the wrong { id, hideMeta, type, mimeType }.
const getImageDeliveryMetadataCacheKey = (url: string) =>
  `${REDIS_KEYS.CACHES.IMAGE_DELIVERY_METADATA}:${url}` as `${typeof REDIS_KEYS.CACHES.IMAGE_DELIVERY_METADATA}:${string}`;

// Omit rows whose source is known gone (ingestion NotFound) so the caller checks the original
// itself instead of converting it. Rows with hideMeta stay: "no row" makes the caller serve
// with metadata visible.
const deliverableSource = Prisma.sql`NOT (
  ingestion = ${ImageIngestionStatus.NotFound}::"ImageIngestionStatus" AND NOT "hideMeta"
)`;

// Origin read, with the dbRead -> dbWrite (primary) fallback so a read-replica error still
// resolves.
const queryImageDeliveryMetadata = async (url: string): Promise<ImageDeliveryMetadata | null> => {
  const [image] = await dbRead.$queryRaw<ImageDeliveryMetadataRow[]>`
      SELECT
        id,
        url,
        "hideMeta",
        type,
        "mimeType"
      FROM "Image"
      WHERE url = ${url}
        AND ${deliverableSource}
      LIMIT 1
    `.catch(() => {
    dbReadFallbackCounter.inc({ entity: 'image', caller: 'imageDelivery' });
    return dbWrite.$queryRaw<ImageDeliveryMetadataRow[]>`
        SELECT
          id,
          url,
          "hideMeta",
          type,
          "mimeType"
        FROM "Image"
        WHERE url = ${url}
          AND ${deliverableSource}
        LIMIT 1
      `;
  });

  if (!image) return null;

  return {
    id: image.id,
    url: image.url,
    hideMeta: image.hideMeta,
    type: image.type,
    mimeType: normalizeMimeType(image.mimeType),
  };
};

// Read-through cache over the near-immutable url -> {id, url, hideMeta, type, mimeType}
// lookup — the hot caller of the highest-volume DB query in the profile
// (`Image WHERE url = $1`). The cached value is the origin query's row, with only `mimeType`
// normalized (see `normalizeMimeType`).
// Bucket A: the cache reduces DB total-exec-time / call-count only — the DB runs ~4% CPU, so
// this is a pod-neutral cost/margin win, NOT a capacity win. This offloads ONLY the
// image-delivery endpoint's calls; the same query has other callers (feed hydration,
// scanning) that are untouched.
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
// that window tight. `type`/`mimeType` need no bust of their own: they are set when the
// media row is created and no writer in this repo updates them afterwards, so the existing
// hideMeta bust plus the TTL already covers every way a cached entry can go stale.
// `ingestion` moving to NotFound is not busted either; a cached row lingers at most TTL.
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
