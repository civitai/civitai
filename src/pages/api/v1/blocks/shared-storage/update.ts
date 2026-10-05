import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  SHARED_KEY_MAX,
  sharedValueInput,
  updateSharedRow,
} from '~/server/routers/apps-shared.router';

/**
 * POST /api/v1/blocks/shared-storage/update  body `{ key, value: { title, body?, data? } }`
 * Scope `apps:storage:shared:write`.
 *
 * AUTHOR-SCOPED in-place edit of an EXISTING shared_kv row. Unlike `append`,
 * this one does take a `key` — and that is safe for a reason worth stating: the
 * key selects a row WITHIN the caller's own app schema (which is still derived
 * from the verified token), and the router then refuses unless
 * `author_user_id` equals the token subject. A key naming someone else's row is
 * a 403, not an edit; a key naming a missing OR hidden row is a 404.
 *
 * A thin adapter over `updateSharedRow`, the SAME function
 * `trpc.apps.shared.update` calls, so all of it holds verbatim on both surfaces:
 * the write-scope + min-trust gate in `resolveSharedContext(_, 'update')`, the
 * ANON REFUSAL (401), the APPEND daily rate-limit bucket (deliberately shared
 * with append, so repeated edits cannot become an unbounded write), the full
 * blocking content-safety belt on the NEW title/body, the whole-value byte cap
 * and the per-app quota re-checked on the byte DELTA.
 *
 * Preserved by the write: key, author_user_id, created_at and the row's
 * votes/counters/reports. Changed: value + updated_at.
 *
 * Response: `{ ok: true }`.
 */

// Same 128kb envelope as append.ts, and for the same reason — see the note there.
export const config = { api: { bodyParser: { sizeLimit: '128kb' } } };

const bodySchema = z.object({
  key: z.string().min(1).max(SHARED_KEY_MAX),
  value: sharedValueInput,
});

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
    const result = await updateSharedRow(bearer(req), parsed.data.key, parsed.data.value);
    try {
      stashBlockActionDetail(res, {
        action: 'shared.update',
        key: parsed.data.key,
        outcome: 'ok',
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
  endpoint: 'shared_storage_update',
  requiredScope: 'apps:storage:shared:write',
  allowOpaqueOrigin: true,
});
