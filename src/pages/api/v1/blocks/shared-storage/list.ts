import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  listSharedRows,
  SHARED_CURSOR_MAX,
  SHARED_LIST_LIMIT_DEFAULT,
  SHARED_LIST_LIMIT_MAX,
  SHARED_PREFIX_MAX,
} from '~/server/routers/apps-shared.router';
import { getNextPage } from '~/server/utils/pagination-helpers';

/**
 * GET /api/v1/blocks/shared-storage/list?prefix=&limit=N&cursor=&mine=true
 * Scope `apps:storage:shared:read`.
 *
 * `mine=true` narrows the page to rows the VIEWER authored (civitai/civitai#5354 Q3).
 * Without it an app that wants to show someone their own submissions has to page the
 * entire board and filter client-side. Why it is a boolean rather than a user id, and
 * what an ANON caller gets, are stated once on `listSharedRows` — not repeated here.
 *
 * Cursor-paginated feed of THIS app's shared_kv rows (the "requests" list) —
 * newest-first on the ULID key, hidden rows excluded, each row carrying its
 * aggregate vote `count` and the caller's own `viewerVoted` boolean. The raw
 * `votes` rows are NEVER listable and the per-user `kv` table is never touched.
 *
 * A thin adapter over `listSharedRows`, the SAME function `trpc.apps.shared.list`
 * calls — so per-app schema isolation (derived from the VERIFIED token, never from
 * anything in this request), the approved-block + revocation checks, the read-scope
 * assertion and the fail-closed kill-switch all hold verbatim, and a REST read can
 * not diverge from the bridge read. ANON IS ALLOWED, deliberately: `list` is in the
 * resolver's READ_OPS, so a valid read-scoped block token with `sub:'anon'` reads the
 * feed and always sees `viewerVoted: false`. Money-free.
 *
 * Response: `{ items, metadata: { nextCursor, nextPage } }` — the house pagination
 * envelope (see blocks/models.ts).
 */

export const config = { api: { responseLimit: false } };

const querySchema = z.object({
  prefix: z.string().max(SHARED_PREFIX_MAX).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SHARED_LIST_LIMIT_MAX)
    .default(SHARED_LIST_LIMIT_DEFAULT),
  cursor: z.string().max(SHARED_CURSOR_MAX).optional(),
  // `mine=true` narrows the feed to rows the VIEWER authored. Same
  // literal-union + transform shape blocks/models.ts uses for its boolean query
  // params — 🔴 NOT `z.coerce.boolean()`, which maps the string "false" to TRUE
  // and would silently invert the flag. An unrecognised value 400s rather than
  // defaulting, so a typo is loud instead of quietly returning the whole board.
  mine: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

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
  const { prefix, limit, cursor, mine } = parsed.data;

  try {
    const { items, nextCursor } = await listSharedRows(bearer(req), {
      prefix,
      limit,
      cursor,
      mine,
    });
    const { nextPage } = getNextPage({ req, nextCursor });
    res.status(200).json({ items, metadata: { nextCursor, nextPage } });
    return;
  } catch (error) {
    // 🔴 NOT the `{ error: trpcError.message }` arm its two shared-storage siblings
    // (top.ts / increment.ts) still carry — both are recorded in
    // `rest-error-envelope-ledger.test.ts` as known message-forwarding sites, and a
    // new route should not join that list. `handleEndpointError` maps the
    // resolver's TRPCErrors to their statuses exactly as before (UNAUTHORIZED→401,
    // FORBIDDEN→403, …) while genericizing the one case that arm got wrong: a raw
    // `pg` failure out of `pool.query`, whose `.message` can name this app's schema
    // and the offending row value. Same helper blocks/models.ts uses.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'shared_storage_list',
  requiredScope: 'apps:storage:shared:read',
  allowOpaqueOrigin: true,
});
