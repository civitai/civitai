import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { SHARED_KEY_MAX, withdrawSharedRow } from '~/server/routers/apps-shared.router';

/**
 * POST /api/v1/blocks/shared-storage/withdraw  body `{ key }`
 * Scope `apps:storage:shared:write`.
 *
 * The AUTHOR deletes their OWN shared row. The DELETE is author-gated in the SQL
 * itself (`WHERE key = $1 AND author_user_id = $2`), so a key naming another
 * user's row deletes nothing and answers `{ ok: true, deleted: false }` — the
 * same answer a key that never existed gets, deliberately, so this route is not
 * an existence oracle for other users' rows. Moderators hide/purge via
 * `apps.mod.purgeSharedRow`, never this path.
 *
 * A thin adapter over `withdrawSharedRow`, the SAME function
 * `trpc.apps.shared.withdraw` calls: the write-scope + min-trust gate and the
 * ANON REFUSAL (401) in `resolveSharedContext(_, 'withdraw')`, the row's votes /
 * counter / reports dropped by the FK cascade, and the quota trigger reclaiming
 * the bytes and the row under `SET LOCAL app.current_app_block_id`.
 *
 * 🔴 RATE LIMIT. This op had NO bucket at all until PR 1 of this pair gave it
 * its own per-(user, app) 30/min one — and a REST ingress is precisely what
 * would have widened that gap, since an unbounded `DELETE` with an FK cascade is
 * the cheapest thing on this surface to script. The bucket is taken here BEFORE
 * a pooled connection is checked out, not inside the transaction.
 *
 * POST rather than DELETE for the same reason as `unvote` — see that route.
 *
 * Response: `{ ok: true, deleted }`.
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
    const result = await withdrawSharedRow(bearer(req), parsed.data.key);
    try {
      stashBlockActionDetail(res, {
        action: 'shared.withdraw',
        key: parsed.data.key,
        // `deleted: false` is a legitimate outcome (someone else's key, or an
        // already-withdrawn row), not a failure — the row is recorded as what it
        // was, so an audit sweep can tell a real deletion from a no-op probe.
        outcome: result.deleted ? 'ok' : 'failed',
      });
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
  endpoint: 'shared_storage_withdraw',
  requiredScope: 'apps:storage:shared:write',
  allowOpaqueOrigin: true,
});
