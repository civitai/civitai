import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { appStorageKeyInput, getAppStorageValue } from '~/server/services/apps/app-storage.service';
import { blockBearerToken } from '~/server/utils/block-bearer';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/app-storage/get  body `{ key }` → `{ value }`
 * Scope `apps:storage:read`.
 *
 * Read one key of the viewer's OWN per-app KV — the REST twin of the
 * `APP_STORAGE_GET` bridge message, and the read half of the surface five fleet
 * apps need in order to port off the postMessage bridge.
 *
 * A thin adapter over `getAppStorageValue`, the SAME function
 * `trpc.apps.storage.get` calls, so the whole authorization ladder holds
 * verbatim and none of it is re-spelled here: the token verification, the
 * approved-block check, the per-op `apps:storage:read` scope assertion against
 * `claims.scopes`, the per-subject `app-blocks-enabled` kill-switch, and the
 * (block_instance, viewer) tuple binding that is the entire invariant of this
 * datastore. See `APP STORAGE: ONE BODY, TWO TRANSPORTS` in `apps.router.ts`
 * for why this delegates to a function rather than to a tRPC caller.
 *
 * 🔴 WHY POST WITH THE KEY IN THE BODY, and not `GET ?key=` like the
 * shared-storage read twins. A shared-storage key names APP-GLOBAL, public,
 * moderated content; an app-storage key names ONE VIEWER'S OWN private data, and
 * apps name those keys after what they hold (`draft:<title>`, `notes:<topic>`).
 * In a query string that key reaches the access log, the `Referer` header and
 * every intermediary that records URLs — for the one route whose entire purpose
 * is per-viewer scoping. This is the same argument `workflows/poll.ts` makes for
 * keeping `workflowId` out of the path, applied to a value that is strictly more
 * private. It also keeps the audit `endpoint` column a fixed literal.
 *
 * 🔴 AN ANONYMOUS VIEWER GETS 403 HERE, NOT THE BRIDGE'S CLEAN `{ value: null }`,
 * AND THAT DIVERGENCE IS DELIBERATE. `apps:storage:read` is CONSENT-EXEMPT
 * (`CONSENT_EXEMPT_SCOPES`, scope-grant.service.ts), so the anon mint does NOT
 * strip it — the scope-presence check passes and `enforceContextBinding`'s
 * `apps:storage:*` case then refuses the anon subject with
 * `apps:storage:read requires authenticated subject`. That case is an
 * audit-installed fail-closed control (audit fix 3 / L-M6); this route is its
 * FIRST live caller, and narrowing a security check so a new transport can be
 * more convenient is exactly the "adapter disarmed a gate" shape
 * `block-workflow-rest.ts` warns about. The information content is identical —
 * an anon viewer HAS no per-viewer storage, so `403` and `{ value: null }` tell
 * a block the same thing — and nothing depends on the 200 shape yet, so this is
 * the cheapest moment to take the stricter behaviour. Loosening later is a
 * one-line change in one switch case; tightening later would be breaking.
 *
 * Response: `{ value }` — `null` for a missing key, deliberately a 200 rather
 * than a 404 so a block can render defaults without branching on status.
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

  // Parsed with the procedure's OWN schema (imported, not re-spelled), so the
  // key bound is one constant on both transports.
  const parsed = appStorageKeyInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await getAppStorageValue(blockBearerToken(req), parsed.data.key);
    res.status(200).json(result);
    return;
  } catch (error) {
    // `handleEndpointError`, so failures answer `{ message }` and this route
    // stays off the known-leak list in `rest-error-envelope-ledger.test.ts`.
    // Every refusal inside the shared body is a TRPCError and maps to its
    // matching status here.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'app_storage_get',
  requiredScope: 'apps:storage:read',
  allowOpaqueOrigin: true,
});
