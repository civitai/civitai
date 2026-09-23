import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getSharedRow, SHARED_KEY_MAX } from '~/server/routers/apps-shared.router';

/**
 * GET /api/v1/blocks/shared-storage/item?key=<key>
 * Scope `apps:storage:shared:read`.
 *
 * Single shared_kv row by key — the deep-link resolution read. Same projection as
 * `list` (value + aggregate `count` + the caller's own `viewerVoted`), and the SAME
 * `hidden_at IS NULL` visibility gate, so a direct key fetch can NOT surface a
 * withdrawn or moderator-hidden row the paged list excludes.
 *
 * A thin adapter over `getSharedRow`, the SAME function `trpc.apps.shared.get`
 * calls — per-app schema isolation (derived from the VERIFIED token, never from the
 * `key` in this request), the approved-block + revocation checks, the read-scope
 * assertion and the fail-closed kill-switch all hold verbatim. Anon is allowed
 * (`get` is in the resolver's READ_OPS) and always reads `viewerVoted: false`.
 * Money-free.
 *
 * Response: `{ item }` — `item` is `null` for a missing OR hidden key. A miss is
 * deliberately a 200 with `item: null` rather than a 404: "hidden" and "never
 * existed" must be indistinguishable to the caller, and the tRPC twin returns the
 * same shape.
 */

export const config = { api: { responseLimit: false } };

const querySchema = z.object({ key: z.string().min(1).max(SHARED_KEY_MAX) });

function bearer(req: NextApiRequest): string {
  const auth = req.headers.authorization ?? '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice('bearer '.length).trim() : '';
}

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await getSharedRow(bearer(req), parsed.data.key);
    res.status(200).json(result);
    return;
  } catch (error) {
    // See list.ts for why this is `handleEndpointError` and not the
    // `{ error: trpcError.message }` arm the two older shared-storage routes carry.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'shared_storage_item',
  requiredScope: 'apps:storage:shared:read',
  allowOpaqueOrigin: true,
});
