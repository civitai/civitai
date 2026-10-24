import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { SHARED_KEY_MAX, voteSharedRow } from '~/server/routers/apps-shared.router';

/**
 * POST /api/v1/blocks/shared-storage/vote  body `{ key }`
 * Scope `apps:storage:shared:write`.
 *
 * Up-votes one shared row. A vote is a WRITE in every sense that matters here —
 * it moves a public tally other users see — so it takes the write scope and the
 * full min-trust gate, which is what stops a fresh/sybil account from brigading.
 *
 * A thin adapter over `voteSharedRow`, the SAME function `trpc.apps.shared.vote`
 * calls, so the whole ladder holds verbatim on both surfaces: the write-scope +
 * min-trust gate and the ANON REFUSAL (401) in `resolveSharedContext(_, 'vote')`,
 * the per-(user, app) PER-MINUTE vote bucket taken before any DB work, the
 * `hidden_at IS NULL` existence pre-check (a hidden or missing row is a 404, so
 * this route is not an oracle for withdrawn rows) and the atomic insert-gated
 * counter — a double vote is a no-op and the tally never inflates (design H1).
 *
 * `key` selects a row inside the CALLER'S app schema, which is derived from the
 * verified token; it cannot reach another app's storage.
 *
 * Response: `{ count }` — the row's new aggregate tally. The raw vote rows are
 * never returned by any surface.
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
    const result = await voteSharedRow(bearer(req), parsed.data.key);
    try {
      stashBlockActionDetail(res, { action: 'shared.vote', key: parsed.data.key, outcome: 'ok' });
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
  endpoint: 'shared_storage_vote',
  requiredScope: 'apps:storage:shared:write',
  allowOpaqueOrigin: true,
});
