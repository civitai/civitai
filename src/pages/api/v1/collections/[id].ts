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
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

/**
 * GET /api/v1/collections/[id] — public, edge-cacheable collection detail.
 *
 * VISIBILITY (existence-leak-safe): the read decision reuses the EXISTING
 * `getUserCollectionPermissionsById`, evaluated as ANONYMOUS (no `userId`/
 * `isModerator`), so `read` is true ONLY for a Public/Unlisted collection — for
 * EVERY caller, authed or not. A private collection, OR a non-existent one, gets
 * the SAME bare 404, so this is not a private-collection existence oracle. Because
 * the permission decision never depends on WHO calls, the response is a pure
 * function of the id (+ region) — byte-identical for anonymous and authenticated
 * callers — which makes the `MixedAuthEndpoint` wrapper's `public, s-maxage=300`
 * edge caching safe. `getCollectionById` itself does NO gating, so this permission
 * check is REQUIRED before calling it.
 *
 * Maturity: the cover image is clamped to the region-narrowed PUBLIC browsing
 * ceiling — the SAME fixed default the list endpoint uses
 * (`publicBrowsingLevelsFlag`, narrowed to `sfwBrowsingLevelsFlag` for restricted
 * regions), NOT `allBrowsingLevels`. A cover above the ceiling is nulled so an
 * anonymous SFW caller never receives mature cover art. The clamp is derived ONLY
 * from the region (`cf-ipcountry`); it NEVER reads the caller's nsfw preference /
 * browsingLevel cookie / session, so the response stays a pure function of id +
 * region and the `public` edge cache is leak-free.
 */

export const schema = z.object({ id: z.coerce.number().int().gt(0).lte(2147483647) });

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  // Conservative per-client rate limit (before the service call). Keys on
  // CF-Connecting-IP / userId — guards only the cache-MISS path; the response
  // body itself never varies by user.
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

  // Maturity/region ceiling — the SAME fixed PUBLIC default the list endpoint
  // uses (collections/index.ts), narrowed to SFW for restricted regions. Region-
  // derived ONLY (from `cf-ipcountry`); NEVER the caller's nsfw preference/cookie/
  // session, so the response stays a pure function of id + region (edge-cacheable).
  const region = getRegion(req);
  let browsingLevel = publicBrowsingLevelsFlag;
  if (isRegionRestricted(region)) browsingLevel = sfwBrowsingLevelsFlag;

  try {
    // VISIBILITY gate, evaluated as ANONYMOUS — NEVER pass the session
    // userId/isModerator. `read` is true only for Public/Unlisted, so a private
    // collection → 404 for EVERY caller (indistinguishable from a non-existent
    // one — no existence oracle), and the decision is caller-independent.
    const permissions = await getUserCollectionPermissionsById({ id });
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
