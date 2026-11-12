import { CacheTTL } from '~/server/common/constants';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { queryPrismaSql } from '~/server/db/prisma-sql-kysely';
import { logToAxiom, safeError } from '~/server/logging/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { recordImageDeliveryBustFailure } from '~/server/prom/image-delivery.metrics';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
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

const BUST_ATTEMPTS = 2;
const BUST_DEADLINE_MS = 1_000;

// Omit rows whose source is known gone (ingestion NotFound) so the caller checks the original
// itself instead of converting it. Rows with hideMeta stay: "no row" makes the caller serve
// with metadata visible.
const deliverableSource = Prisma.sql`NOT (
  ingestion = ${ImageIngestionStatus.NotFound}::"ImageIngestionStatus" AND NOT "hideMeta"
)`;

// The origin statement. Several rows can share a url (a copied image keeps its source's url);
// rows sharing a url resolve to the most restrictive setting, hence the ORDER BY.
// Exported for the parity test, which pins it against the `image_delivery_lookup(url)` SQL function.
export const imageDeliveryStatement = (url: string) => Prisma.sql`
  SELECT
    id,
    url,
    "hideMeta",
    type,
    "mimeType"
  FROM "Image"
  WHERE url = ${url}
    AND ${deliverableSource}
  ORDER BY "hideMeta" DESC
  LIMIT 1
`;

// Origin read, with the replica -> primary fallback so a read-replica error still resolves. Only
// an error falls back: an empty result from the replica is a not-found.
//
// Through Kysely over the pg pools, not Prisma's `$queryRaw`: same statement text and parameters
// (`queryPrismaSql`), without the query engine's per-statement cost on one of the hottest reads.
// Every selected column is int4, text, boolean or an enum, which both executors parse alike.
const queryImageDeliveryMetadata = async (url: string): Promise<ImageDeliveryMetadata | null> => {
  const { kyselyRead, kyselyWrite } = await loadKyselyDb();
  const [image] = await queryPrismaSql<ImageDeliveryMetadataRow>(
    kyselyRead,
    imageDeliveryStatement(url)
  ).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'image', caller: 'imageDelivery' });
    return queryPrismaSql<ImageDeliveryMetadataRow>(kyselyWrite, imageDeliveryStatement(url));
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
// (this is one of the hottest internal paths, so a Redis stall must not 500). No distributed
// stampede lock: the origin is a single-row indexed lookup that at worst runs once per url
// per TTL, so a brief cold-key stampede is trivially cheap — not worth the lock's extra
// Redis round-trips on the hot read (mirrors `getTagWithModelCount`).
//
// NEGATIVE RESULTS ARE NOT CACHED: an unknown url always re-hits the DB, so a newly
// registered image resolves immediately (no register-then-deliver staleness). This also
// shrinks invalidation to writers that change an EXISTING image's cached shape.
//
// STALENESS: `hideMeta` can flip, and `updatePostImage` is the only writer in this repo that
// flips it on an existing image. It busts in BOTH directions: hiding through
// `invalidateHiddenImageMetadata` (whose first step is this bust), showing directly. A bust is a
// plain DEL and the fill a plain SET from the REPLICA, so a bust does NOT make a flip take effect
// at once: a fill that read the replica before the flip replicated, or whose SET lands after the
// DEL, re-caches the pre-flip value, and that stale entry then lives for its whole TTL. So does
// one written while a bust failed (`bustImageDeliveryMetadataCache` never throws), or before an
// out-of-band flip (direct DB).
//
// That is why the TTL depends on the value cached. The image-cacher reads `hideMeta: false` as
// "the original may be served with its metadata", so a stale false is the leak direction: those
// entries keep the short TTL (`CacheTTL.sm`, 3 minutes, what every entry had before), so a stale
// false for an owner's just-hidden metadata lives in this cache for at most 3 minutes after it
// is written (itself within a replica lag of the flip), the same bound as before the TTL was
// raised. That bounds this cache entry only: bytes a downstream cache fills from it during that
// window are kept for that cache's own TTL, which this one does not shorten.
// `hideMeta: true` entries get the hour: a stale true only withholds metadata the owner has just
// un-hidden (fail-closed) for at most an hour. A tombstone written by the bust and respected by
// the fill (SET NX) would shorten both windows further, but a tombstone under this key would be
// read as a metadata row by a release that predates it, so it needs a key bump; not done here.
//
// `type`/`mimeType`/`url` need no bust of their own: they are set when the media row is created
// and no writer in this repo updates them afterwards. `ingestion` moving to NotFound is not
// written by any path in this repo, so it is not busted; a cached row lingers at most its TTL,
// and the caller then converts an original that turns out to be gone, as it did before the row
// was marked.
export const IMAGE_DELIVERY_METADATA_TTL = {
  /** `hideMeta: false`: a stale entry leaks hidden metadata, so this bounds that window. */
  visible: CacheTTL.sm,
  /** `hideMeta: true`: a stale entry only withholds metadata (fail-closed). */
  hidden: CacheTTL.hour,
} as const;

const imageDeliveryMetadataTtl = (metadata: ImageDeliveryMetadata) =>
  metadata.hideMeta === true
    ? IMAGE_DELIVERY_METADATA_TTL.hidden
    : IMAGE_DELIVERY_METADATA_TTL.visible;

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
      await redis.packed.set(key, result, { EX: imageDeliveryMetadataTtl(result) });
    } catch {
      // Best-effort cache write; a Redis stall here never fails the request.
    }
  }

  return result;
};

// Bust a single url key. Hard delete (not a staleness reset): because we never cache
// negatives, deleting the key means the next read re-queries and re-populates the fresh row.
// Called by `updatePostImage` when `hideMeta` changes, inside the user's save: so it is bounded by
// one deadline across both attempts, and it never throws (the TTL still bounds a missed bust).
// A DEL cannot stop a racing fill from re-caching the pre-flip value: see STALENESS above for
// what bounds that.
export const bustImageDeliveryMetadataCache = async (url: string) => {
  const key = getImageDeliveryMetadataCacheKey(url);
  const deadline = Date.now() + BUST_DEADLINE_MS;
  const timedOut = new Error(`bust timed out after ${BUST_DEADLINE_MS}ms`);
  let lastError: unknown = timedOut;
  for (let attempt = 1; attempt <= BUST_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const deleted = await withTimeoutFallback(
        redis.del(key).then(() => true),
        remaining,
        false
      );
      if (deleted) return;
      lastError = timedOut;
    } catch (error) {
      lastError = error;
    }
  }

  recordImageDeliveryBustFailure();
  await logToAxiom({
    type: 'warning',
    name: 'image-delivery-metadata-bust',
    message: 'image-delivery metadata cache bust failed after retry',
    imageKey: url,
    error: safeError(lastError),
  }).catch(() => {
    // swallow — best effort logging
  });
};
