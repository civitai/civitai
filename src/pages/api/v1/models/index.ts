import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { CollectionType, ModelFileVisibility, ModelModifier } from '~/shared/utils/prisma/enums';
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
} from '~/shared/constants/browsingLevel.constants';
import { booleanString } from '~/utils/zod-helpers';
import { getUserBookmarkCollections } from '~/server/services/user.service';
import { safeDecodeURIComponent } from '~/utils/string-helpers';
import { Flags } from '~/shared/utils/flags';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient } from '~/server/meilisearch/client';
import { isDefined } from '~/utils/type-guards';

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
  const browsingLevel = !parsedParams.data.nsfw ? publicBrowsingLevelsFlag : allBrowsingLevelsFlag;

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
    // Fetch IDs from Meilisearch
    const meiliResult = await searchClient?.index(MODELS_SEARCH_INDEX).search(query, {
      limit,
      filter: [cursor ? `id < ${cursor}` : undefined].filter(isDefined),
      attributesToRetrieve: ['id'],
      sort: ['id:desc'],
    });
    // @ts-ignore
    searchIds = meiliResult?.hits?.map((hit: { id: number }) => hit.id) ?? [];
    meiliNextCursor =
      meiliResult?.hits?.length === limit ? searchIds[searchIds.length - 1]?.toString() : undefined;
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
      items: items.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
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
                        width: image.width ?? 450,
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
