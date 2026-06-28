import type { SearchResponse } from 'meilisearch';
import type { SessionUser } from '~/types/session';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { MeiliCallTimeoutError, searchClient, withMeili } from '~/server/meilisearch/client';
import type { GetAllModelsOutput } from '~/server/schema/model.schema';
import { getDownloadFilename } from '~/server/services/file.service';
import { getModelsWithVersions } from '~/server/services/model.service';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { ModelFileVisibility, ModelModifier } from '~/shared/utils/prisma/enums';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';
import { safeDecodeURIComponent } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

/**
 * Shared model-search + response-shaping body extracted verbatim from
 * `/api/v1/models/index.ts` so the public endpoint AND the block-scoped
 * catalog endpoint (`/api/v1/blocks/models.ts`) build the SAME response from
 * the SAME query path. The ONLY behavioral lever is `browsingLevel` (and the
 * `nsfwImagePassthrough` flag that mirrors the public endpoint's pre-refactor
 * `parsedParams.data.nsfw` image-filter widening) — both supplied by the
 * caller. The public endpoint passes its existing values UNCHANGED; the block
 * endpoint passes a server-clamped `browsingLevel` and `nsfwImagePassthrough:
 * false` so a SFW-domain block can never widen the image filter.
 *
 * Maturity policy is NOT decided here — this helper is a pure executor. The
 * caller is the single place that derives the effective `browsingLevel`.
 */

type FileMetadata = Record<string, unknown>;

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

export type RunModelSearchInput = Partial<Omit<GetAllModelsOutput, 'browsingLevel'>> & {
  /** Per-page take (the validated `limit`). */
  limit: number;
  /** Offset-paging skip (public endpoint only; undefined for cursor/query). */
  skip?: number;
  /** Free-text query (routes through Meilisearch when present). */
  query?: string;
  /** Cursor — opaque numeric offset for text search, id-cursor otherwise.
   *  Wide type to match the public endpoint's parsed cursor union. */
  cursor?: GetAllModelsOutput['cursor'];
  /** Pre-resolved id list (favorites/explicit ids path), forwarded as-is. */
  queryIds?: number[];
  /** primaryFileOnly response trim. */
  primaryFileOnly?: boolean;
  /** Resolved favorites collection id (public endpoint only). */
  collectionId?: number;
  /** supportsGeneration filter (forwarded from `data.supportsGeneration`). */
  supportsGeneration?: boolean;
};

export type RunModelSearchContext = {
  /**
   * The EFFECTIVE browsing-level flag. The caller is the single source of
   * truth: the public endpoint passes its region/nsfw-derived value; the block
   * endpoint passes a value already clamped to the token's domain ceiling.
   */
  browsingLevel: number;
  /**
   * Mirrors the public endpoint's pre-refactor `parsedParams.data.nsfw` image
   * filter widening: when true, EVERY image on a version is returned
   * regardless of its nsfwLevel (legacy public-API behavior). When false, the
   * per-image filter is driven SOLELY by `browsingLevel`. The block endpoint
   * MUST pass false — otherwise a `nsfw=true` query would widen the image
   * filter past the clamp.
   */
  nsfwImagePassthrough: boolean;
  /** The viewer (session user) — undefined for anon. */
  user?: SessionUser;
  /** Absolute origin used to build download URLs (from getNextPage's baseUrl). */
  baseUrlOrigin: string;
};

export class ModelSearchMeiliTimeoutError extends Error {
  constructor() {
    super('Model search is temporarily overloaded — please retry.');
    this.name = 'ModelSearchMeiliTimeoutError';
  }
}

/**
 * Resolve the Meilisearch id list + next-cursor for a text query. Throws
 * `ModelSearchMeiliTimeoutError` on a backend brownout so the caller can map
 * it to a 503 with the right cache headers (it cannot be a TRPCError because
 * handleEndpointError JSON.parses TRPCError messages — see the original
 * endpoint comment).
 */
export async function resolveModelSearchIds(opts: {
  query: string;
  cursor?: GetAllModelsOutput['cursor'];
  limit: number;
  browsingLevel: number;
}): Promise<{ searchIds: number[]; nextCursor?: string }> {
  const { query, cursor, limit, browsingLevel } = opts;
  const browsingLevelValues = Flags.instanceToArray(browsingLevel);
  const queryOffset = cursor && Number.isFinite(Number(cursor)) ? Math.max(0, Number(cursor)) : 0;

  let meiliResult: SearchResponse<{ id: number }> | undefined;
  try {
    const client = searchClient;
    meiliResult = client
      ? await withMeili('search', () =>
          client.index(MODELS_SEARCH_INDEX).search<{ id: number }>(query, {
            offset: queryOffset || undefined,
            limit: limit ? limit + 1 : undefined,
            filter: [`nsfwLevel IN [${browsingLevelValues.join(',')}]`],
            attributesToRetrieve: ['id'],
          })
        )
      : undefined;
  } catch (e) {
    if (e instanceof MeiliCallTimeoutError) throw new ModelSearchMeiliTimeoutError();
    throw e;
  }

  const hits = meiliResult?.hits ?? [];
  const hasMore = limit ? hits.length > limit : false;
  const searchIds = (hasMore ? hits.slice(0, limit) : hits).map((hit) => hit.id);
  const nextCursor = hasMore ? String(queryOffset + limit) : undefined;
  return { searchIds, nextCursor };
}

/**
 * Run the model search and shape the response. Behavior-preserving extraction
 * of the body of `/api/v1/models/index.ts`. The caller owns: query parsing,
 * pagination math, the Meili pre-step (via `resolveModelSearchIds`), the
 * favorites-collection lookup, region restriction, and — critically — the
 * EFFECTIVE `browsingLevel`. This function decides no policy.
 */
export async function runModelSearch(
  input: RunModelSearchInput & { searchIds?: number[] },
  ctx: RunModelSearchContext
): Promise<{ items: unknown[]; nextCursor?: string | bigint | Date }> {
  const { browsingLevel, nsfwImagePassthrough, user, baseUrlOrigin } = ctx;
  const {
    limit,
    skip,
    query,
    cursor,
    queryIds,
    primaryFileOnly,
    collectionId,
    searchIds,
    ...data
  } = input;

  const { items, nextCursor } = await getModelsWithVersions({
    // Cast: callers supply a partial of GetAllModelsOutput (the public endpoint
    // a full parsed value; the block endpoint a selector subset). getModelsRaw
    // reads `sort`/`period` at runtime and tolerates the rest being absent —
    // the public endpoint always carried schema defaults, the block endpoint
    // sets the ones it relies on (sort/period) explicitly. The static type is
    // wider than the runtime contract, so cast at this single seam.
    input: {
      browsingLevel,
      ...data,
      take: limit,
      skip: !query ? skip : undefined,
      cursor: !query ? cursor : undefined,
      ids: query ? searchIds ?? [] : queryIds,
      collectionId,
      disablePoi: true,
      disableMinor: true,
    } as Parameters<typeof getModelsWithVersions>[0]['input'],
    user,
  });

  // Meilisearch returns ids in relevance order, but getModelsWithVersions
  // re-sorts by lastVersionAt/modelId. For text search, restore relevance.
  const orderedItems =
    query && searchIds
      ? searchIds.map((id) => items.find((m) => m.id === id)).filter(isDefined)
      : items;

  const preferredFormat = {
    type: user?.filePreferences?.size === 'pruned' ? 'Pruned Model' : undefined,
    metadata: user?.filePreferences,
  };

  const shaped = orderedItems.map(({ modelVersions, tagsOnModels, user: modelUser, ...model }) => ({
    ...model,
    mode: model.mode == null ? undefined : model.mode,
    creator: modelUser
      ? {
          username: modelUser.username,
          image: modelUser.profilePicture
            ? getEdgeUrl(modelUser.profilePicture.url, {
                width: 96,
                name: modelUser.username,
                type: modelUser.profilePicture.type,
              })
            : modelUser.image
            ? getEdgeUrl(modelUser.image, { width: 96, name: modelUser.username })
            : null,
        }
      : undefined,
    tags: tagsOnModels.map(({ name }) => name),
    modelVersions: modelVersions
      .filter((x) => x.status === 'Published' && (!data.supportsGeneration || x.covered))
      .map(({ status, files, images, createdAt, covered, ...version }) => {
        let castedFiles =
          (files as Array<Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }>) ??
          [];
        const primaryFile = getPrimaryFile(castedFiles, preferredFormat);
        if (!primaryFile) return null;
        if (primaryFileOnly === true) castedFiles = [primaryFile];

        const includeDownloadUrl = model.mode !== ModelModifier.Archived;
        const includeImages = model.mode !== ModelModifier.TakenDown;

        return {
          ...version,
          supportsGeneration: covered,
          files: includeDownloadUrl
            ? castedFiles
                .filter((file) => file.visibility === ModelFileVisibility.Public)
                .map(({ hashes, ...file }) => ({
                  ...file,
                  name: safeDecodeURIComponent(
                    getDownloadFilename({ model, modelVersion: version, file })
                  ),
                  hashes: hashesAsObject(hashes),
                  downloadUrl: `${baseUrlOrigin}${createModelFileDownloadUrl({
                    versionId: version.id,
                    type: file.type,
                    meta: file.metadata,
                    primary: primaryFile.id === file.id,
                  })}`,
                  primary: primaryFile.id === file.id ? true : undefined,
                  url: undefined,
                  visibility: undefined,
                }))
            : [],
          // Image filter: when nsfwImagePassthrough is true (public endpoint
          // with ?nsfw=true) every image passes — legacy behavior. Otherwise
          // the per-image nsfwLevel is checked against the EFFECTIVE
          // browsingLevel. The block endpoint passes false so the clamp can't
          // be widened by a client nsfw flag.
          images: includeImages
            ? images
                .filter((x) => nsfwImagePassthrough || Flags.intersects(x.nsfwLevel, browsingLevel))
                .map(({ url, id, ...image }) => ({
                  id,
                  url: getEdgeUrl(url, {
                    original: true,
                    name: id.toString(),
                    type: image.type,
                  }),
                  ...image,
                }))
            : [],
          downloadUrl: includeDownloadUrl
            ? `${baseUrlOrigin}${createModelFileDownloadUrl({
                versionId: version.id,
                primary: true,
              })}`
            : undefined,
        };
      })
      .filter((x) => x),
  }));

  return { items: shaped, nextCursor };
}
