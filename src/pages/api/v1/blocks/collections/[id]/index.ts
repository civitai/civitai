import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  getCollectionById,
  getCollectionItemsByCollectionId,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import {
  getFollowedCollectionIds,
  hydrateBlockSubject,
  mapImageItemToMedia,
} from '~/server/services/blocks/block-collections.service';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { CollectionItemStatus, CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

/**
 * GET /api/v1/blocks/collections/[id]?cursor&limit
 *
 * Block-token collection DETAIL (media items) for App Blocks. Scope
 * `collections:read:self`.
 *
 * VISIBILITY (existence-leak-safe): a public/unlisted collection is readable by
 * anyone; a PRIVATE collection is readable ONLY by its owner/contributor. A
 * caller without read permission — OR a non-existent collection — gets the SAME
 * bare 404 (never 403), so the endpoint is not a private-collection existence
 * oracle. The permission decision reuses `getUserCollectionPermissionsById`.
 *
 * MATURITY: media items are clamped to the token's `maxBrowsingLevel` ceiling
 * (region-narrowed) by threading the clamped `browsingLevel` into
 * `getCollectionItemsByCollectionId` — the identical authority surface
 * /api/v1/blocks/images uses. Only image/video (playable) items are returned;
 * model/post/article items are omitted.
 *
 * Response: `{ collection: { id, name, description, curator:{ userId, username },
 *   isPublic, followed }, items: [{ mediaId, type:'image'|'video', url, width,
 *   height, creator:{ userId, username }, nsfwLevel }], nextCursor }`.
 */

export const config = { api: { responseLimit: false } };

const querySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  let subjectUserId: number | null;
  try {
    subjectUserId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  if (subjectUserId == null) {
    res.status(403).json({ error: 'Anonymous block tokens may not read collections' });
    return;
  }

  // Path param: a single numeric collection id (reject array / non-numeric).
  const rawId = req.query.id;
  const idStr = Array.isArray(rawId) ? undefined : rawId;
  const collectionId = idStr != null && /^[0-9]+$/.test(idStr) ? Number.parseInt(idStr, 10) : NaN;
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    res.status(400).json({ error: 'Invalid collection id' });
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    return;
  }
  const { cursor, limit } = parsed.data;

  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  const subjectUser = await hydrateBlockSubject(subjectUserId);
  if (!subjectUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  try {
    // VISIBILITY gate. `read` is true for public/unlisted, and for the
    // owner/contributor of a private collection. No read → 404 (indistinguishable
    // from a non-existent collection — no existence oracle).
    const permissions = await getUserCollectionPermissionsById({
      id: collectionId,
      userId: subjectUserId,
      isModerator: subjectUser.isModerator,
    });
    if (!permissions.read) {
      res.status(404).json({ error: 'Collection not found' });
      return;
    }

    // READ SPLIT (private consent gate): a PUBLIC/unlisted collection
    // (`publicCollection`) is readable with collections:read:self. A NON-public
    // (Private) collection is readable here ONLY because the subject is the
    // owner/contributor — and that additionally requires the consent-gated
    // `collections:read:private` scope. Without it, return the SAME invisible 404
    // as a non-owner (no 403 oracle, and — critically — no "needs consent" leak to
    // a non-owner, who can't distinguish this from a non-existent collection).
    if (!permissions.publicCollection && !claims.scopes.includes('collections:read:private')) {
      res.status(404).json({ error: 'Collection not found' });
      return;
    }

    // getCollectionById throws NotFound when the row is gone — map to the same 404.
    let collection;
    try {
      collection = await getCollectionById({ input: { id: collectionId } });
    } catch {
      res.status(404).json({ error: 'Collection not found' });
      return;
    }

    const { items: expanded, nextCursor } = await getCollectionItemsByCollectionId({
      input: {
        collectionId,
        limit,
        cursor,
        browsingLevel,
        statuses: [CollectionItemStatus.ACCEPTED],
      },
      user: subjectUser,
    });

    // Only playable media (image/video). Model/post/article items are dropped.
    const items = expanded
      .filter((it) => it.type === 'image')
      .map((it) => mapImageItemToMedia(it.data as Parameters<typeof mapImageItemToMedia>[0]));

    const followed = await getFollowedCollectionIds(subjectUserId, [collectionId]);

    res.status(200).json({
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description ?? null,
        curator: {
          userId: collection.user?.id ?? collection.userId,
          username: collection.user?.username ?? null,
        },
        isPublic: collection.read === CollectionReadConfiguration.Public,
        followed: followed.has(collectionId),
      },
      items,
      nextCursor,
    });
    return;
  } catch (error) {
    res.status(500).json({ error: 'Failed to load collection' });
    return;
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  requiredScope: 'collections:read:self',
  allowOpaqueOrigin: true,
});
