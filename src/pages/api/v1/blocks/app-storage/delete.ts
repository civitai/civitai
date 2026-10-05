import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  appStorageKeyInput,
  deleteAppStorageValue,
} from '~/server/services/apps/app-storage.service';
import { blockBearerToken } from '~/server/utils/block-bearer';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/app-storage/delete  body `{ key }` → `{ ok, deleted }`
 * Scope `apps:storage:write`.
 *
 * Remove one key of the viewer's OWN per-app KV — the REST twin of the
 * `APP_STORAGE_DELETE` bridge message.
 *
 * A thin adapter over `deleteAppStorageValue`, the SAME function
 * `trpc.apps.storage.delete` calls, so the transaction (`BEGIN` +
 * `SET LOCAL app.current_app_block_id` + `DELETE` + `COMMIT`, with `ROLLBACK` on
 * any fault), the row-level app scoping it sets up, the quota trigger that
 * releases the freed bytes, and the whole authorization ladder all hold verbatim
 * and none of it is re-spelled here. See `APP STORAGE: ONE BODY, TWO TRANSPORTS`
 * in `apps.router.ts`.
 *
 * 🔴 POST, NOT HTTP `DELETE`, AND THE KEY IS IN THE BODY. Two reasons, both the
 * same ones `get.ts` gives: an app-storage key names one viewer's private data
 * and must not reach access logs or `Referer` via a query string or path
 * segment, and HTTP `DELETE` bodies are famously unreliable across proxies and
 * client libraries (several strip them, `fetch` historically refused them). POST
 * is the only verb that carries a body dependably everywhere, and it keeps this
 * route's shape identical to its four siblings.
 *
 * `deleted: false` IS A SUCCESS, NOT A FAILURE — it means the key was already
 * absent. That is a 200, matching the bridge, because "delete a key that is not
 * there" is the idempotent no-op every retry-on-timeout client depends on; a 404
 * would make a successful retry look like a failure. The shared body also writes
 * NO activity row in that case, deliberately, so a no-op delete does not appear
 * in the viewer's feed.
 *
 * An ANONYMOUS viewer gets 403 before this handler runs — see `get.ts`.
 *
 * Response: `{ ok: true, deleted }`.
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

// Exported for unit testing (the default export is wrapped in withBlockScope,
// whose JWT gate would otherwise have to be satisfied to reach this handler).
export const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
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

  const parsed = appStorageKeyInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await deleteAppStorageValue(blockBearerToken(req), parsed.data.key);
    res.status(200).json(result);
    return;
  } catch (error) {
    // See get.ts — `handleEndpointError`, so failures answer `{ message }`.
    return handleEndpointError(res, error);
  }
});

// No `stashBlockActionDetail` — see the note in `set.ts`; the shared body writes
// the richer `storage:delete` row itself, and this route's access row is labelled
// distinctly in `humaniseScopeInvocation` so the pair does not read as two
// identical deletions.
//
// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'app_storage_delete',
  requiredScope: 'apps:storage:write',
  allowOpaqueOrigin: true,
});
