import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { ModelFileVisibility, ModelModifier } from '~/shared/utils/prisma/enums';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ModelSort } from '~/server/common/enums';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getDownloadFilename } from '~/server/services/file.service';
import { getModelsWithVersions } from '~/server/services/model.service';
import { publicModelResponseKey } from '~/server/services/model-version.service';
import { PublicEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import type { BlockScopedNextApiRequest } from '~/server/middleware/block-scope.middleware';
import { withBlockScope } from '~/server/middleware/block-scope.middleware';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { safeDecodeURIComponent } from '~/utils/string-helpers';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { env } from '~/env/server';
import { CacheTTL } from '~/server/common/constants';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { redis } from '~/server/redis/client';

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

// Bound the coerced id to Postgres int4 (the `Model.id` column type, max
// 2147483647). `z.coerce.number()` alone accepts arbitrarily large numeric
// strings (bot/scraper garbage like `853267723675816615`), which then bind to
// the int4 model id in Prisma and throw a PG "value out of range for type
// integer" → a raw 500. Rejecting them here fails safeParse → the existing 400
// path fires. `.int().gt(0)` also rejects non-integer / non-positive ids. A
// valid-but-nonexistent in-range id still passes and reaches the handler's 404.
export const schema = z.object({ id: z.coerce.number().int().gt(0).lte(2147483647) });

const baseUrl = getBaseUrl();

// Origin-side response cache for the PUBLIC path. Cloudflare already caches this
// endpoint at the edge (PublicEndpoint sets `s-maxage=300, swr=150`), but every
// edge-MISS re-runs the full getModelsWithVersions pipeline — whose tail cost is a
// cold getImagesForModelVersion CROSS JOIN LATERAL (p99 ~1.7s). This cache spares
// that work on edge-misses. The TTL is held at CacheTTL.sm (180s) ≤ the 300s edge
// TTL, so the origin cache introduces NO staleness beyond what the edge already
// serves. Keyed by (modelId, browsingLevel) — browsingLevel is binary here
// (sfwBrowsingLevelsFlag when region-restricted, else allBrowsingLevelsFlag), so
// including its numeric flag value in the key is exact and self-documenting.
const PUBLIC_MODEL_RESPONSE_TTL = env.IS_DATAPACKET ? CacheTTL.sm : 0;

// The shaped 200 body for a public GET /api/v1/models/[id]. `null` means the
// model was not found → the handler returns a 404. The not-found case is NEVER
// cached (see the handler / fetchModelResponseCached) — only positive bodies are
// stored — so a just-published model can't be pinned to a stale 404.
async function buildPublicModelResponse(
  id: number,
  browsingLevel: number
): Promise<Record<string, unknown> | null> {
  const { items } = await getModelsWithVersions({
    input: {
      ids: [id],
      sort: ModelSort.HighestRated,
      favorites: false,
      hidden: false,
      archived: true,
      period: 'AllTime',
      periodMode: 'published',
      browsingLevel,
    },
  });
  if (items.length === 0) return null;

  const { modelVersions, tagsOnModels, user, ...model } = items[0];

  return {
    ...model,
      mode: model.mode == null ? undefined : model.mode,
      creator: user
        ? {
            username: user.username,
            image: user.profilePicture
              ? getEdgeUrl(user.profilePicture.url, {
                  width: 96,
                  name: user.username,
                  type: user.profilePicture.type,
                })
              : user.image
              ? getEdgeUrl(user.image, { width: 96, name: user.username })
              : null,
          }
        : undefined,
      tags: tagsOnModels.map(({ name }) => name),
      modelVersions: modelVersions
        .filter((x) => x.status === 'Published')
        .map(({ images, files, ...version }) => {
          const castedFiles = files as Array<
            Omit<(typeof files)[number], 'metadata'> & { metadata: BasicFileMetadata }
          >;
          const primaryFile = getPrimaryFile(castedFiles);
          if (!primaryFile) return null;

          const includeDownloadUrl = model.mode !== ModelModifier.Archived;
          const includeImages = model.mode !== ModelModifier.TakenDown;

          return removeEmpty({
            ...version,
            files: includeDownloadUrl
              ? castedFiles
                  .filter((file) => file.visibility === ModelFileVisibility.Public)
                  .map(({ hashes, metadata, ...file }) => ({
                    ...file,
                    metadata: removeEmpty(metadata),
                    name: safeDecodeURIComponent(
                      getDownloadFilename({ model, modelVersion: version, file })
                    ),
                    hashes: hashesAsObject(hashes),
                    downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                      versionId: version.id,
                      type: file.type,
                      meta: metadata,
                      primary: primaryFile.id === file.id,
                    })}`,
                    primary: primaryFile.id === file.id ? true : undefined,
                    url: undefined,
                    visibility: undefined,
                  }))
              : [],
            images: includeImages
              ? images.map(({ url, id, ...image }) => ({
                  url: getEdgeUrl(url, {
                    original: true,
                    name: id.toString(),
                    type: image.type,
                  }),
                  ...image,
                }))
              : [],
            downloadUrl: includeDownloadUrl
              ? `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  primary: true,
                })}`
              : undefined,
          });
        })
        .filter((x) => x),
  };
}

const baseHandler = PublicEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const parsedParams = schema.safeParse(req.query);
  if (!parsedParams.success)
    return res.status(400).json({
      error: z.prettifyError(parsedParams.error) ?? `Invalid id`,
    });

  const region = getRegion(req);
  const isRestricted = isRegionRestricted(region);
  const browsingLevel = isRestricted ? sfwBrowsingLevelsFlag : allBrowsingLevelsFlag;
  const { id } = parsedParams.data;

  // Bypass the origin cache when this request is taking the block-scoped path
  // (a valid block JWT was verified and bound by withBlockScope, which sets
  // req.blockClaims and marks the response `private, no-store`). Block-scoped
  // responses may be identity-bearing / differ from the pure-public body, so we
  // must never serve them a cached public body nor populate the public cache
  // from a block call. Only the anonymous PublicEndpoint path is cached.
  const isBlockScoped = !!(req as BlockScopedNextApiRequest).blockClaims;

  try {
    // Cache only when enabled (IS_DATAPACKET) AND this is the pure-public path.
    // TTL (CacheTTL.sm = 180s) ≤ the edge s-maxage (300s), so the origin cache
    // never serves staler than the edge already would.
    const shouldCache = PUBLIC_MODEL_RESPONSE_TTL > 0 && !isBlockScoped;
    const body = shouldCache
      ? await fetchModelResponseCached(id, browsingLevel)
      : await buildPublicModelResponse(id, browsingLevel);

    // A not-found (null) is NEVER written to the cache (fetchModelResponseCached
    // only stores positive bodies). The 404 path is not the p99 cost this cache
    // targets, and not caching it is the simplest correct option: it prevents a
    // just-published/created model from being pinned to a stale 404 for up to the
    // full TTL when the build reads a lagging replica. 400 (bad id) is rejected
    // above the cache; 5xx throws out of buildPublicModelResponse and is never
    // stored.
    if (body === null)
      return res.status(404).json({ error: `No model with id ${id}` });

    return res.status(200).json(body);
  } catch (error) {
    return handleEndpointError(res, error);
  }
});

// Positive-only origin cache for the public body.
//
// fetchThroughCache UNCONDITIONALLY caches whatever its fetchFn returns, so it
// can't be told "build, but don't store a null". To keep the not-found case out
// of the cache (see FIX 1 / the handler comment) we wrap fetchThroughCache so the
// fetchFn only ever runs / stores when there is a real body: we read the cache
// directly first; on a hit return it; on a miss build once — a null short-circuits
// to a 404 WITHOUT a write, and a positive body is written through
// fetchThroughCache (reusing its `{ data, cachedAt }` wrapper + best-effort,
// fail-open Redis set, and matching the key scheme bustPublicModelResponseCache
// busts). This deliberately forgoes fetchThroughCache's distributed cold-miss
// single-flight lock; acceptable here because this is a low-volume endpoint
// (~0.5 req/s) that Cloudflare already fronts (s-maxage=300), so a cold-key
// thundering herd is negligible. (See FIX 3 in the PR description for the
// pre-existing ~15s lock-retry 500 on fetchThroughCache itself.)
async function fetchModelResponseCached(
  id: number,
  browsingLevel: number
): Promise<Record<string, unknown> | null> {
  const key = publicModelResponseKey(id, browsingLevel);

  // Cache READ. Fail OPEN: a Redis stall degrades to a direct origin build rather
  // than a 500 (mirrors fetchThroughCache's read-fail-open).
  try {
    const cached = await redis.packed.get<{ data: Record<string, unknown>; cachedAt: number }>(key);
    // Honor the LOGICAL ttl. fetchThroughCache stores with EX = ttl*2 (the physical
    // key lives 360s) and normally gates freshness on `cachedAt`, serving older
    // entries only as stampede-protection stale. A bare presence check here would
    // serve entries up to 2×ttl (360s) old — PAST the 300s edge s-maxage — breaking
    // the "origin TTL ≤ edge TTL ⇒ no new staleness" invariant (and could compound
    // through the edge's stale-while-revalidate). Re-apply the same cachedAt gate so
    // a logically-expired-but-physically-present entry falls through to a rebuild.
    if (cached && Date.now() - cached.cachedAt <= PUBLIC_MODEL_RESPONSE_TTL * 1000)
      return cached.data;
  } catch {
    return buildPublicModelResponse(id, browsingLevel);
  }

  // MISS: build once. Only a positive body is cached.
  const body = await buildPublicModelResponse(id, browsingLevel);
  if (body === null) return null;

  // Write-through via fetchThroughCache so the stored wrapper shape + key match
  // exactly what bustPublicModelResponseCache reads. The cache was just confirmed
  // empty above, so fetchThroughCache takes its build-and-store branch and the
  // fetchFn returns the already-built body (no second buildPublicModelResponse).
  return fetchThroughCache<Record<string, unknown>>(key, async () => body, {
    ttl: PUBLIC_MODEL_RESPONSE_TTL,
  });
}

// App Blocks: allow this route to be called with an RS256 block JWT carrying
// the `models:read:self` scope. When no block JWT is present the call falls
// through to the existing PublicEndpoint path, so legacy callers are unaffected.
export default withBlockScope(baseHandler, { requiredScope: 'models:read:self' });
