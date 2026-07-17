import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  getCollectionById,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

/**
 * GET /api/v1/collections/[id] — public collection detail.
 *
 * VISIBILITY (existence-leak-safe): the read decision reuses the EXISTING
 * `getUserCollectionPermissionsById` (the same authority `getCollectionByIdHandler`
 * uses) — `read` is true for Public/Unlisted collections and for the
 * owner/contributor/moderator of a private one. A caller without read permission,
 * OR a non-existent collection, gets the SAME bare 404, so this is not a
 * private-collection existence oracle. `getCollectionById` itself does NO gating,
 * so this permission check is REQUIRED before calling it. Ownership comes solely
 * from the authenticated session — never a client param.
 *
 * Maturity: the cover image is clamped to the region-narrowed browsing ceiling.
 */

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
  const browsingLevel = isRegionRestricted(region)
    ? sfwBrowsingLevelsFlag
    : allBrowsingLevelsFlag;

  try {
    // VISIBILITY gate. No read permission → 404 (indistinguishable from a
    // non-existent collection — no existence oracle).
    const permissions = await getUserCollectionPermissionsById({
      id,
      userId: user?.id,
      isModerator: user?.isModerator,
    });
    if (!permissions.read) return res.status(404).json({ error: `No collection with id ${id}` });

    // getCollectionById throws NOT_FOUND when the row is gone → handleEndpointError
    // maps it to the same 404.
    const collection = await getCollectionById({ input: { id } });

    const coverWithinCeiling =
      !!collection.image?.url &&
      (!collection.image.nsfwLevel ||
        Flags.intersects(collection.image.nsfwLevel, browsingLevel));

    return res.status(200).json({
      id: collection.id,
      name: collection.name,
      description: collection.description ?? null,
      type: collection.type ?? null,
      nsfwLevel: collection.nsfwLevel ?? null,
      read: collection.read,
      isPublic: collection.read === CollectionReadConfiguration.Public,
      coverImageUrl:
        coverWithinCeiling && collection.image?.url
          ? getEdgeUrl(collection.image.url, {
              width: 450,
              type: collection.image.type ?? undefined,
            })
          : null,
      user: collection.user
        ? { id: collection.user.id, username: collection.user.username ?? null }
        : { id: collection.userId, username: null },
      tags: collection.tags?.map((t) => ({ id: t.id, name: t.name })) ?? [],
    });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
