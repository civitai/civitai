import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  appStorageListInput,
  listAppStorageKeys,
} from '~/server/services/apps/app-storage.service';
import { blockBearerToken } from '~/server/utils/block-bearer';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/app-storage/list  body `{ prefix?, limit?, cursor? }`
 *   → `{ keys: [{ key, updatedAt }], nextCursor }`
 * Scope `apps:storage:read`.
 *
 * Page the viewer's OWN key list for this block instance — the REST twin of the
 * `APP_STORAGE_LIST` bridge message. Values are NOT returned; fetch them on
 * demand with `/app-storage/get`.
 *
 * A thin adapter over `listAppStorageKeys`, the SAME function
 * `trpc.apps.storage.list` calls, so the `LIKE … ESCAPE` prefix escaping (which
 * is what stops a caller-supplied `%`/`_` from widening its own scan), the
 * keyset pagination and the whole authorization ladder hold verbatim. See
 * `APP STORAGE: ONE BODY, TWO TRANSPORTS` in `apps.router.ts`.
 *
 * 🔴 THIS ROUTE MUST NEVER ANSWER 200 `{ keys: [] }` FOR AN AUTHORIZATION
 * FAILURE, AND A CONSUMER'S DOUBLE-SPEND GUARD DEPENDS ON IT.
 * `civitai-app-model-benchmarking` pages `inflight:v1:` on mount to re-render
 * already-running cells as in-flight, and it STANDS DOWN its per-run `get`
 * backstop precisely when the scan completes without truncation. An
 * empty-but-successful listing therefore reads as "nothing is running",
 * completes, reports `truncated: false`, disarms the backstop, and makes every
 * reload a clean double-charge WITH THE GUARD EXPLICITLY DISABLED. An adapter
 * that answers "no keys" is strictly more dangerous here than one that throws.
 *
 * That property holds STRUCTURALLY rather than by a check in this file: every
 * refusal inside the shared body is a thrown TRPCError (bad token, deleted or
 * unapproved block, missing `apps:storage:read` scope, unhydratable subject,
 * kill-switch off) and reaches the client as a non-2xx through
 * `handleEndpointError`. The ONE 200-with-empty path in the shared body is the
 * `userId == null` anon arm — and on THIS transport that arm is unreachable,
 * because `enforceContextBinding` 403s an anon subject before the handler runs
 * (see `get.ts`). So the only way a caller sees `{ keys: [] }` here is a genuinely
 * empty store for a genuinely authenticated viewer, which is the one case where
 * it is true. Pinned by `app-storage-endpoints.test.ts`.
 *
 * 🔴 `nextCursor` IS PRESENT EXACTLY WHEN THERE MAY BE MORE ROWS — set iff
 * `rows.length === limit`, in the shared body. The same consumer reads it to
 * decide whether its scan was truncated, so BOTH failure directions are live:
 * always returning a cursor arms the expensive backstop forever, and never
 * returning one makes a truncated scan report `truncated: false` and disarms the
 * guard. This route passes the body's value through untouched and adds no
 * pagination logic of its own.
 *
 * ⚠ `updatedAt` CROSSES THE WIRE AS AN ISO STRING HERE, NOT A `Date`. The shared
 * body returns `r.updated_at`, a `Date`; tRPC's superjson transformer revives it
 * as a `Date` on the bridge, while `res.json()` serialises it with
 * `Date.prototype.toJSON()`. A block that does arithmetic on `updatedAt` must
 * parse it on this transport. The `key` field — the one the known consumer reads
 * — is a string on both.
 *
 * WHY POST rather than `GET ?prefix=` like the shared-storage list twin: a
 * `prefix` names a slice of ONE VIEWER'S private keyspace, so it carries the same
 * disclosure concern as a key. See `get.ts`.
 *
 * An ANONYMOUS viewer gets 403 before this handler runs — see `get.ts`.
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

  // Parsed with the procedure's OWN schema (imported, not re-spelled) — which is
  // also where `limit`'s `.default(50)` lives, so the page size a REST caller
  // gets when it sends none is the SAME constant the bridge applies rather than
  // a second copy that could drift.
  const parsed = appStorageListInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await listAppStorageKeys(blockBearerToken(req), parsed.data);
    res.status(200).json(result);
    return;
  } catch (error) {
    // See get.ts — `handleEndpointError`. This is the arm that keeps the
    // never-200-on-failure property above true.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'app_storage_list',
  requiredScope: 'apps:storage:read',
  allowOpaqueOrigin: true,
});
