import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import * as z from 'zod';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  addContributorToCollection,
  removeContributorFromCollection,
} from '~/server/services/collection.service';

/**
 * POST /api/v1/blocks/collections/[id]/follow
 * Body `{ follow: boolean }` — scope `collections:write:self`.
 *
 * Follows / unfollows (on-site bookmark) a collection ON BEHALF OF the token
 * SUBJECT. Reuses the existing collection follow services verbatim
 * (`addContributorToCollection` / `removeContributorFromCollection`), self-bound:
 * `userId === targetUserId === subject`, so a block can only ever follow for the
 * authenticated caller (never a third party). The services enforce their own
 * permission gate (a private collection the subject can't follow throws
 * FORBIDDEN → surfaced as 403 here).
 *
 * Response: `{ followed: boolean }` (the resulting follow state).
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const bodySchema = z.object({ follow: z.boolean() });

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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
    res.status(403).json({ error: 'Anonymous block tokens may not follow collections' });
    return;
  }

  const rawId = req.query.id;
  const idStr = Array.isArray(rawId) ? undefined : rawId;
  const collectionId = idStr != null && /^[0-9]+$/.test(idStr) ? Number.parseInt(idStr, 10) : NaN;
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    res.status(400).json({ error: 'Invalid collection id' });
    return;
  }

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }
  const { follow } = parsed.data;

  try {
    if (follow) {
      // Self-bound: userId (actor) === targetUserId === subject.
      await addContributorToCollection({
        collectionId,
        userId: subjectUserId,
        targetUserId: subjectUserId,
      });
    } else {
      await removeContributorFromCollection({
        collectionId,
        userId: subjectUserId,
        targetUserId: subjectUserId,
      });
    }
    res.status(200).json({ followed: follow });
    return;
  } catch (error) {
    // The services throw TRPCError (e.g. FORBIDDEN when the subject can't follow a
    // private collection). Map to the corresponding HTTP status rather than a 500.
    const trpcError = error as TRPCError;
    const statusCode =
      typeof trpcError?.code === 'string' ? getHTTPStatusCodeFromError(trpcError) : 500;
    res.status(statusCode).json({ error: trpcError?.message ?? 'Failed to update follow state' });
    return;
  }
});

export default withBlockScope(baseHandler, { requiredScope: 'collections:write:self' });
