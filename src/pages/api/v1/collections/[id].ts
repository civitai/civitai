import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getEdgeUrl } from '~/client-utils/edge-url';
import {
  getCollectionById,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import {
  CollectionReadConfiguration,
  ImageIngestionStatus,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

export const schema = z.object({ id: z.coerce.number().int().gt(0).lte(2147483647) });

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  const rateLimit = await checkPublicApiRateLimit({ req, family: 'collections', userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
  }

  const parsedParams = schema.safeParse(req.query);
  if (!parsedParams.success)
    return res.status(400).json({ error: z.prettifyError(parsedParams.error) ?? 'Invalid id' });

  const { id } = parsedParams.data;

  const region = getRegion(req);
  let browsingLevel = publicBrowsingLevelsFlag;
  if (isRegionRestricted(region)) browsingLevel = sfwBrowsingLevelsFlag;

  try {
    // @ai: getCollectionById does not check access. Check as an anonymous visitor so
    // cached responses cannot expose private collections.
    const permissions = await getUserCollectionPermissionsById({ id });
    if (!permissions.read) return res.status(404).json({ error: `No collection with id ${id}` });

    const collection = await getCollectionById({ input: { id } });

    const image = collection.image;
    const coverImage =
      image?.url &&
      image.ingestion === ImageIngestionStatus.Scanned &&
      image.scannedAt != null &&
      image.tosViolation === false &&
      image.needsReview == null &&
      image.blockedFor == null &&
      image.nsfwLevel > 0 &&
      Flags.hasFlag(browsingLevel, image.nsfwLevel) &&
      (image.type === MediaType.image || image.type === MediaType.video)
        ? {
            id: image.id,
            url: getEdgeUrl(image.url, { width: 450, type: image.type }),
            type: image.type,
            width: image.width ?? null,
            height: image.height ?? null,
            nsfwLevel: image.nsfwLevel,
          }
        : null;

    return res.status(200).json({
      id: collection.id,
      name: collection.name,
      description: collection.description ?? null,
      type: collection.type ?? null,
      mode: collection.mode ?? null,
      nsfwLevel: collection.nsfwLevel ?? null,
      read: collection.read,
      isPublic: collection.read === CollectionReadConfiguration.Public,
      coverImage,
      coverImageUrl: coverImage?.url ?? null,
      user: collection.user
        ? { id: collection.user.id, username: collection.user.username ?? null }
        : { id: collection.userId, username: null },
      tags: collection.tags?.map((t) => ({ id: t.id, name: t.name })) ?? [],
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
