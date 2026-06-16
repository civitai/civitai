import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { CollectionType, ModelFileVisibility, ModelModifier } from '~/shared/utils/prisma/enums';
import type { SearchResponse } from 'meilisearch';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from 'next-auth';
import * as z from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import type { GetAllModelsInput } from '~/server/schema/model.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { getDownloadFilename } from '~/server/services/file.service';
import { getModelsWithVersions } from '~/server/services/model.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getNextPage, getPagination } from '~/server/utils/pagination-helpers';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { booleanString } from '~/utils/zod-helpers';
import { getUserBookmarkCollections } from '~/server/services/user.service';
import { safeDecodeURIComponent } from '~/utils/string-helpers';
import { Flags } from '~/shared/utils/flags';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { MeiliCallTimeoutError, searchClient, withMeili } from '~/server/meilisearch/client';
import { isDefined } from '~/utils/type-guards';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

type Metadata = {
  currentPage?: number;
  pageSize?: number;
  nextCursor?: string | bigint | Date;
  nextPage?: string;
};

export const config = {
  api: {
    responseLimit: false,
  },
};

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

const authedOnlyOptions: Array<keyof GetAllModelsInput> = ['favorites', 'hidden'];

const modelsEndpointSchema = getAllModelsSchema.extend({
  limit: z.preprocess((val) => Number(val), z.number().min(0).max(100)).default(100),
  nsfw: booleanString().optional(),
  primaryFileOnly: booleanString().optional(),
  favorites: booleanString().optional().default(false),
  hidden: booleanString().optional().default(false),
});

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  if (
    Object.keys(req.query).some((key) =>
      authedOnlyOptions.includes(key as keyof GetAllModelsInput)
    ) &&
    !user
  )
    return res.status(401).json({ error: 'Unauthorized' });

  const parsedParams = modelsEndpointSchema.safeParse(req.query);
  if (!parsedParams.success) return res.status(400).json({ error: parsedParams.error });

  // Check if request is from restricted region and override browsing level
  const region = getRegion(req);
  let browsingLevel = !parsedParams.data.nsfw ? publicBrowsingLevelsFlag : allBrowsingLevelsFlag;
  if (isRegionRestricted(region)) browsingLevel = sfwBrowsingLevelsFlag;

  // Handle pagination
  const { limit, page, cursor, query, ids: queryIds, ...data } = parsedParams.data;
  let skip: number | undefined;
  const usingPaging = page && !cursor;
  if (usingPaging) {
    if (page && page * limit > 1000) {
      // Enforce new paging limit
      return res
        .status(429)
        .json({ error: "You've requested too many pages, please use cursors instead" });
    }

    ({ skip } = getPagination(limit, page));
  }

  let collectionId: number | undefined;
  if (parsedParams.data.favorites && user) {
    const collections = await getUserBookmarkCollections({ userId: user.id });
    const favoriteModelsCollections = collections.find((c) => c.type === CollectionType.Model);
    collectionId = favoriteModelsCollections?.id;
  }

  // If query is present, do not allow page param
  if (query && page) {
    return res
      .status(400)
      .json({ error: 'Cannot use page param with query search. Use cursor-based pagination.' });
  }

  let searchIds: number[] = [];
  let meiliNextCursor: string | undefined;
  if (query) {
    const browsingLevelValues = Flags.instanceToArray(browsingLevel);
    // Offset-based pagination for relevance-ranked text search.
    //
    // The query cursor is now an opaque numeric OFFSET, not a model id. We
    // dropped the previous `sort: ['id:desc']` because the models index puts
    // 'sort' first in its rankingRules (models.search-index.ts), so forcing an
    // id sort made Meili rank by recency instead of text relevance — burying
    // canonical low-id models (e.g. the original "DreamShaper", id 4384) past
    // the first pages even though they are the exact-name match. Relevance
    // ranking surfaces the right model first; id-cursor pagination is
    // incompatible with that order, so we page by offset instead.
    const queryOffset = cursor && Number.isFinite(Number(cursor)) ? Math.max(0, Number(cursor)) : 0;
    // Fetch IDs from Meilisearch.
    // Wrap the SDK call under withMeili('search', ...) so a backend brownout
    // is bounded by MEILI_CALL_TIMEOUT_MS instead of bleeding the event loop
    // until Traefik's 30s router timeout — same pattern as PR #2351 and the
    // service-layer wrap in model.service.ts:getModelsRaw.
    //
    // The MeiliCallTimeoutError is caught HERE (not re-thrown as TRPCError)
    // because handleEndpointError() does JSON.parse(apiError.message) on
    // every TRPCError, which would crash on our plain-text timeout message.
    // Returning res.status(408) directly avoids that landmine entirely.
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
      if (e instanceof MeiliCallTimeoutError) {
        // Override the public cache headers set by MixedAuthEndpoint —
        // without this Cloudflare caches the 503 and turns a transient
        // Meili brownout into a sticky 503 wall for every other
        // unauthenticated caller with the same query.
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '2');
        return res
          .status(503)
          .json({ error: 'Model search is temporarily overloaded — please retry.' });
      }
      throw e;
    }

    // We request `limit + 1` hits to detect whether another page exists
    // without a second count query. The extra hit is sliced off and the next
    // offset is advanced by `limit`.
    const hits = meiliResult?.hits ?? [];
    const hasMore = limit ? hits.length > limit : false;
    searchIds = (hasMore ? hits.slice(0, limit) : hits).map((hit) => hit.id);
    meiliNextCursor = hasMore ? String(queryOffset + limit) : undefined;
  }

  try {
    const { items, nextCursor } = await getModelsWithVersions({
      input: {
        browsingLevel,
        ...data,
        take: limit,
        skip: !query ? skip : undefined,
        cursor: !query ? cursor : undefined,
        ids: query ? searchIds : queryIds,
        collectionId,
        disablePoi: true,
        disableMinor: true,
      },
      user,
    });

    // Meilisearch returns ids in relevance order, but getModelsWithVersions
    // re-sorts by lastVersionAt/modelId (model.service.ts). For text search,
    // restore the relevance ranking so the best match stays first.
    const orderedItems = query
      ? searchIds.map((id) => items.find((m) => m.id === id)).filter(isDefined)
      : items;

    const preferredFormat = {
      type: user?.filePreferences?.size === 'pruned' ? 'Pruned Model' : undefined,
      metadata: user?.filePreferences,
    };
    const primaryFileOnly = data.primaryFileOnly === true;

    const { baseUrl, nextPage } = getNextPage({
      req,
      nextCursor: query ? meiliNextCursor : nextCursor,
    });
    const metadata: Metadata = { nextCursor: query ? meiliNextCursor : nextCursor, nextPage };
    if (usingPaging) {
      metadata.currentPage = page;
      metadata.pageSize = limit;
    }

    return res.status(200).json({
      items: orderedItems.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
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
          .filter((x) => x.status === 'Published' && (!data.supportsGeneration || x.covered))
          .map(({ status, files, images, createdAt, covered, ...version }) => {
            let castedFiles =
              (files as Array<
                Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
              >) ?? [];
            const primaryFile = getPrimaryFile(castedFiles, preferredFormat);
            if (!primaryFile) return null;
            if (primaryFileOnly) castedFiles = [primaryFile];

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
                      downloadUrl: `${baseUrl.origin}${createModelFileDownloadUrl({
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
              images: includeImages
                ? images
                    .filter(
                      (x) => parsedParams.data.nsfw || Flags.hasFlag(x.nsfwLevel, browsingLevel)
                    )
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
                ? `${baseUrl.origin}${createModelFileDownloadUrl({
                    versionId: version.id,
                    primary: true,
                  })}`
                : undefined,
            };
          })
          .filter((x) => x),
      })),
      metadata: { ...metadata },
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
