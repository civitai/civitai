import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import * as z from 'zod';

import {
  stashBlockActionDetail,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  assertValidCounterKey,
  incrementSharedCounter,
} from '~/server/routers/apps-shared.router';

/**
 * POST /api/v1/blocks/shared-storage/increment  body `{ key }`
 * Scope `apps:storage:shared:write`.
 *
 * Increments (by 1) an app-defined counter in THIS app's shared schema (e.g.
 * `playcount:<collectionId>`). Routed through the SAME `resolveSharedContext`
 * min-trust gate + write-scope + per-(user,app) rate limit + per-app-schema
 * isolation as the shared append/vote path (anti-inflation): a sub-trust caller
 * gets 403 — intended, since the app treats increment as best-effort. Money-free.
 *
 * Response: `{ key, count }` (the new count).
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const bodySchema = z.object({ key: z.string().min(1).max(64) });

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
    const key = assertValidCounterKey(parsed.data.key);
    const result = await incrementSharedCounter(bearer(req), key);
    // W13 richer audit detail — stash a structured ref so the middleware
    // finish-writer records "Bumped shared counter <key>". Best-effort.
    //
    // 🔴 The ENTIRE enrichment (detail construction AND the stash call) is wrapped
    // in a swallow-everything try/catch so it can NEVER change this endpoint's
    // outcome. A successful increment ALWAYS returns its real 200 even if
    // enrichment throws (undefined stash export, non-writable `res`, …) — the audit
    // row is simply skipped. (Regression: #3161's stash sat inside the handler try
    // and a throw at the call site surfaced as a 500 on the happy path.)
    try {
      stashBlockActionDetail(res, { action: 'storage.increment', key, outcome: 'ok' });
    } catch {
      /* audit enrichment is best-effort — it must never perturb the response */
    }
    res.status(200).json(result);
    return;
  } catch (error) {
    // resolveSharedContext / the increment throw TRPCError (sub-trust → FORBIDDEN,
    // rate-limit → TOO_MANY_REQUESTS, disabled flag → FORBIDDEN, etc.).
    const trpcError = error as TRPCError;
    const statusCode =
      typeof trpcError?.code === 'string' ? getHTTPStatusCodeFromError(trpcError) : 500;
    res.status(statusCode).json({ error: trpcError?.message ?? 'Failed to increment counter' });
    return;
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'shared_storage_increment',
  requiredScope: 'apps:storage:shared:write',
  allowOpaqueOrigin: true,
});
