import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getAppStorageQuota } from '~/server/services/apps/app-storage.service';
import { blockBearerToken } from '~/server/utils/block-bearer';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/app-storage/quota  body `{}`
 *   → `{ usedBytes, rowCount, limitBytes, limitRows }`
 * Scope `apps:storage:read`.
 *
 * The CALLER'S OWN storage usage against their OWN caps — the REST twin of the
 * `APP_STORAGE_QUOTA` bridge message, so a settings panel can render
 * "used 12 KB of 2 MB" without hard-coding the cap client-side.
 *
 * A thin adapter over `getAppStorageQuota`, the SAME function
 * `trpc.apps.storage.getQuota` calls. Note what that function deliberately does
 * NOT return: the APP-WIDE aggregate. It used to, and that was a cross-user
 * readout on the one surface whose entire invariant is that a caller only ever
 * sees their own data — and it was not actionable either, since only the owning
 * user can delete their own rows. This route inherits the per-user scoping
 * rather than re-deriving it. See `APP STORAGE: ONE BODY, TWO TRANSPORTS` in
 * `apps.router.ts`.
 *
 * 🔴 `usedBytes` IS THE STORED UNIT — Postgres' `octet_length(value::text)` over
 * JSONB, the unit both quota ceilings are enforced in. It is NOT the `sizeBytes`
 * that `/app-storage/set` returns, which is the JS wire unit, and the two are not
 * a fixed multiple of each other: measured, a numeric-heavy payload stores up to
 * 44.4x its wire size. THIS is the authoritative number for "how close am I to my
 * cap"; summing `set`'s `sizeBytes` will under-count, in some cases by more than
 * an order of magnitude.
 *
 * POST WITH AN EMPTY BODY, not GET, purely so all five routes on this surface
 * have one shape — the four siblings all carry viewer-private values that must
 * not reach a query string (see `get.ts`), and a single surface with one verb is
 * easier to write a client against than a split one. This route alone could
 * safely have been a GET; it is not worth the inconsistency.
 *
 * NO REQUEST SCHEMA, because there is no input beyond the token. The body is
 * ignored rather than rejected: a client sending `{}`, nothing, or a stray field
 * all behave identically, which keeps a generated client from having to special-
 * case the one no-argument operation.
 *
 * An ANONYMOUS viewer gets 403 before this handler runs — see `get.ts`. (The
 * shared body's anon arm would have answered zeros; on this transport it is
 * unreachable.)
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

  try {
    const result = await getAppStorageQuota(blockBearerToken(req));
    res.status(200).json(result);
    return;
  } catch (error) {
    // See get.ts — `handleEndpointError`, so failures answer `{ message }`.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'app_storage_quota',
  requiredScope: 'apps:storage:read',
  allowOpaqueOrigin: true,
});
