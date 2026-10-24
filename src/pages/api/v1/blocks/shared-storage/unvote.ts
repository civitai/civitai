import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { SHARED_KEY_MAX, unvoteSharedRow } from '~/server/routers/apps-shared.router';

/**
 * POST /api/v1/blocks/shared-storage/unvote  body `{ key }`
 * Scope `apps:storage:shared:write`.
 *
 * Withdraws the caller's own up-vote. Symmetric to `vote` and deliberately on
 * the SAME per-(user, app) per-minute bucket, so a toggle-spam loop is capped as
 * one budget rather than two.
 *
 * A thin adapter over `unvoteSharedRow`, the SAME function
 * `trpc.apps.shared.unvote` calls: the write-scope + min-trust gate and the ANON
 * REFUSAL (401) in `resolveSharedContext(_, 'unvote')`, the vote bucket taken
 * before any DB work, and the counter decremented by exactly the number of vote
 * rows deleted (0 or 1) with the `CHECK(count >= 0)` constraint blocking any
 * underflow (design H1).
 *
 * POST rather than DELETE, matching every other write on this surface: the
 * action is "remove MY vote", identified by the token subject rather than by a
 * URL-addressable resource, and a uniform verb keeps the app-side client one
 * shape. `key` selects a row inside the CALLER'S app schema only.
 *
 * Response: `{ count }` — the row's new aggregate tally.
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const bodySchema = z.object({ key: z.string().min(1).max(SHARED_KEY_MAX) });

function bearer(req: NextApiRequest): string {
  const auth = req.headers.authorization ?? '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice('bearer '.length).trim() : '';
}

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

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await unvoteSharedRow(bearer(req), parsed.data.key);
    try {
      stashBlockActionDetail(res, { action: 'shared.unvote', key: parsed.data.key, outcome: 'ok' });
    } catch {
      /* audit enrichment is best-effort — it must never perturb the response */
    }
    res.status(200).json(result);
    return;
  } catch (error) {
    // See append.ts for why this is `handleEndpointError` and not the
    // `{ error: trpcError.message }` arm the two older shared-storage routes carry.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'shared_storage_unvote',
  requiredScope: 'apps:storage:shared:write',
  allowOpaqueOrigin: true,
});
