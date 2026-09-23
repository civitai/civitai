import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { appendSharedRow, sharedValueInput } from '~/server/routers/apps-shared.router';

/**
 * POST /api/v1/blocks/shared-storage/append  body `{ value: { title, body?, data? } }`
 * Scope `apps:storage:shared:write`.
 *
 * Creates one cross-user shared_kv row in THIS app's schema — the "file a
 * request" write. The KEY IS SERVER-GENERATED (a ULID) and is NOT accepted from
 * the caller (design C1): a client-chosen key would let user B overwrite user
 * A's row, which is the single most consequential thing that can go wrong on a
 * cross-user write surface.
 *
 * A thin adapter over `appendSharedRow`, the SAME function
 * `trpc.apps.shared.append` calls, so every control runs verbatim on both
 * surfaces and in one place:
 *   - `resolveSharedContext(_, 'append')` — token verification, approved-block,
 *     per-instance revocation, the `apps:storage:shared:write` scope assertion,
 *     the fail-closed kill-switch, the ANON REFUSAL (401), and
 *     `assertSharedWriteTrust` (account age / paid tier / verified email or a
 *     linked OAuth account).
 *   - the per-(user, app) DAILY append bucket, taken BEFORE the content-safety
 *     belt and before any pooled connection, so a flood costs neither external
 *     moderation calls nor a connection.
 *   - the BLOCKING content-safety belt on `title`/`body`, the whole-value byte
 *     cap, the per-user row cap and the per-app byte/row quota.
 *
 * 🔴 The target schema is derived INSIDE the resolver from the VERIFIED token
 * (`sanitizeAppSlug(claims.blockId)`). Nothing in this request — no field of
 * `value`, no header — can influence which app's storage is written.
 *
 * Response: `{ key }` — the server-generated ULID of the new row.
 */

// `value` carries the moderated title/body PLUS the opaque app-owned `data`
// blob, which the router caps at 64KB SERIALIZED. 128kb leaves ~2x headroom for
// JSON escaping so a legitimate max-size `data` is not rejected by the body
// parser before the router's own, authoritative cap can produce a clean error.
export const config = { api: { bodyParser: { sizeLimit: '128kb' } } };

const bodySchema = z.object({ value: sharedValueInput });

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
    const result = await appendSharedRow(bearer(req), parsed.data.value);
    // Structured audit detail for the BlockScopeInvocation row the middleware
    // writes (the middleware is the single writer; this only annotates). Wrapped
    // in a swallow-everything try/catch for the same reason increment.ts is: a
    // successful write must ALWAYS return its real 200 even if the enrichment
    // throws. (#3161 regressed exactly that by leaving the stash inside the
    // handler's own try.)
    try {
      stashBlockActionDetail(res, { action: 'shared.append', key: result.key, outcome: 'ok' });
    } catch {
      /* audit enrichment is best-effort — it must never perturb the response */
    }
    res.status(200).json(result);
    return;
  } catch (error) {
    // 🔴 `handleEndpointError`, NOT the `{ error: trpcError.message }` arm the two
    // older shared-storage routes (top.ts / increment.ts) still carry. That arm
    // forwards a raw `pg` message verbatim, and on THIS surface such a message can
    // name the app's schema and the offending row value. Same decision, same
    // helper and same reasoning as the PR-1 read routes — see list.ts. Consequence:
    // these routes answer with `{ message }`, not `{ error }`.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'shared_storage_append',
  requiredScope: 'apps:storage:shared:write',
  allowOpaqueOrigin: true,
});
