import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getTopSharedCounters } from '~/server/routers/apps-shared.router';

/**
 * GET /api/v1/blocks/shared-storage/top?prefix=&limit=N
 * Scope `apps:storage:shared:read`.
 *
 * Top-N counters (count DESC) whose key matches `prefix` in THIS app's shared
 * schema — the "popular" rail read for app-defined counters (e.g.
 * `prefix=playcount:`). Routed through the SAME `resolveSharedContext` (per-app
 * isolation + read-scope + kill-switch). Money-free.
 *
 * Response: `[{ key, count }]`.
 */

export const config = { api: { responseLimit: false } };

const querySchema = z.object({
  prefix: z.string().max(64).optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function bearer(req: NextApiRequest): string {
  const auth = req.headers.authorization ?? '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice('bearer '.length).trim() : '';
}

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
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
  const { prefix, limit } = parsed.data;

  try {
    const items = await getTopSharedCounters(bearer(req), prefix, limit);
    res.status(200).json(items);
    return;
  } catch (error) {
    const trpcError = error as TRPCError;
    const statusCode =
      typeof trpcError?.code === 'string' ? getHTTPStatusCodeFromError(trpcError) : 500;
    res.status(statusCode).json({ error: trpcError?.message ?? 'Failed to read counters' });
    return;
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  requiredScope: 'apps:storage:shared:read',
  allowOpaqueOrigin: true,
});
