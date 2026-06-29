import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { ModelFileVisibility, ModelModifier } from '~/shared/utils/prisma/enums';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ModelSort } from '~/server/common/enums';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getDownloadFilename } from '~/server/services/file.service';
import { getModelsWithVersions } from '~/server/services/model.service';
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
import { REDIS_KEYS } from '~/server/redis/client';

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

const schema = z.object({ id: z.coerce.number() });

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
// model was not found → the handler returns a 404 (negative-cached as
// `{ body: null }`; see the handler).
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
    const envelope = shouldCache
      ? await fetchThroughCacheEnvelope(id, browsingLevel)
      : { body: await buildPublicModelResponse(id, browsingLevel) };

    // A missing model is cached as `{ body: null }` (negative cache) at the same
    // ≤-edge TTL — this is the simpler-correct option vs. a separate short TTL:
    // fetchThroughCache takes one TTL per call, and 180s ≤ the 300s edge TTL the
    // CDN already serves a 404 with, so it adds no staleness. Only 404 (no row)
    // is ever cached here — 400 (bad id) is rejected above the cache, and 5xx
    // throws out of buildPublicModelResponse and is never stored.
    if (envelope.body === null)
      return res.status(404).json({ error: `No model with id ${id}` });

    return res.status(200).json(envelope.body);
  } catch (error) {
    return handleEndpointError(res, error);
  }
});

type CachedModelEnvelope = { body: Record<string, unknown> | null };

// fetchThroughCache wrapper. The cached value is an ENVELOPE `{ body }` rather
// than the bare body so the found (object) and not-found (null) cases are both
// representable and distinguishable through msgpack pack/unpack. fetchThroughCache
// handles packing, the per-pod single-flight, and fail-open (a Redis stall
// degrades to a direct origin build, never a 500).
async function fetchThroughCacheEnvelope(
  id: number,
  browsingLevel: number
): Promise<CachedModelEnvelope> {
  const key =
    `${REDIS_KEYS.CACHES.PUBLIC_MODEL_RESPONSE}:${id}:${browsingLevel}` as const;
  return fetchThroughCache<CachedModelEnvelope>(
    key,
    async () => ({ body: await buildPublicModelResponse(id, browsingLevel) }),
    { ttl: PUBLIC_MODEL_RESPONSE_TTL }
  );
}

// App Blocks: allow this route to be called with an RS256 block JWT carrying
// the `models:read:self` scope. When no block JWT is present the call falls
// through to the existing PublicEndpoint path, so legacy callers are unaffected.
export default withBlockScope(baseHandler, { requiredScope: 'models:read:self' });
