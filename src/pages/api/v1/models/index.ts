import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { CollectionType } from '~/shared/utils/prisma/enums';
import type { GetAllModelsInput } from '~/server/schema/model.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import {
  ModelSearchMeiliTimeoutError,
  resolveModelSearchIds,
  runModelSearch,
} from '~/server/services/model-search.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { isTransientMeiliError } from '~/server/meilisearch/client';
import { getNextPage, getPagination } from '~/server/utils/pagination-helpers';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { booleanString } from '~/utils/zod-helpers';
import { getUserBookmarkCollections } from '~/server/services/user.service';
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

  // Offset-based pagination for relevance-ranked text search. The query cursor
  // is an opaque numeric OFFSET, not a model id (the models index puts 'sort'
  // first in its rankingRules, so forcing an id sort would rank by recency
  // instead of text relevance). resolveModelSearchIds wraps the Meili call
  // under withMeili so a backend brownout is bounded by MEILI_CALL_TIMEOUT_MS.
  let searchIds: number[] = [];
  let meiliNextCursor: string | undefined;
  if (query) {
    try {
      const meili = await resolveModelSearchIds({
        query,
        cursor,
        limit,
        browsingLevel,
        types: data.types,
      });
      searchIds = meili.searchIds;
      meiliNextCursor = meili.nextCursor;
    } catch (e) {
      // Transient model-search backend failure → retryable 503. The service
      // now wraps a transient upstream as ModelSearchMeiliTimeoutError; we ALSO
      // match a raw SDK Meili error that somehow escaped that wrap
      // (isTransientMeiliError) as defense-in-depth — mirroring how
      // /api/v1/users matches BOTH the wrapped signal and isTransientMeiliError.
      // A non-transient error (malformed filter / auth / real app bug) is NOT
      // matched and rethrows to surface as its real status.
      if (e instanceof ModelSearchMeiliTimeoutError || isTransientMeiliError(e)) {
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
  }

  try {
    // The download/nextPage URLs need the request origin; resolve it from the
    // same getNextPage call the original endpoint used (pass a placeholder
    // cursor first to obtain baseUrl, then recompute nextPage with the real
    // post-search cursor — getNextPage is pure, so this is cheap and keeps the
    // baseUrl.origin available for runModelSearch's download URLs).
    const baseUrlOrigin = getNextPage({ req }).baseUrl.origin;

    const { items, nextCursor } = await runModelSearch(
      {
        ...data,
        limit,
        skip: !query ? skip : undefined,
        cursor: !query ? cursor : undefined,
        query,
        queryIds,
        searchIds,
        collectionId,
        primaryFileOnly: data.primaryFileOnly === true,
      },
      {
        // PUBLIC endpoint: pass the existing region/nsfw-derived browsingLevel
        // UNCHANGED, and mirror the legacy `?nsfw=true` image-filter widening.
        browsingLevel,
        nsfwImagePassthrough: !!parsedParams.data.nsfw,
        user,
        baseUrlOrigin,
      }
    );

    const effectiveNextCursor = query ? meiliNextCursor : nextCursor;
    const { nextPage } = getNextPage({ req, nextCursor: effectiveNextCursor });
    const metadata: Metadata = { nextCursor: effectiveNextCursor, nextPage };
    if (usingPaging) {
      metadata.currentPage = page;
      metadata.pageSize = limit;
    }

    return res.status(200).json({ items, metadata: { ...metadata } });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
