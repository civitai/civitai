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
  reportSharedRow,
  SHARED_KEY_MAX,
  SHARED_REASON_MAX,
} from '~/server/routers/apps-shared.router';

/**
 * POST /api/v1/blocks/shared-storage/report  body `{ key, reason? }`
 * Scope `apps:storage:shared:write`.
 *
 * Files a `shared_kv_reports` row for moderator review. It does NOT hide the
 * reported row — a moderator decides, via `apps.mod.purgeSharedRow`.
 *
 * WHY A REPORT TAKES THE **WRITE** SCOPE AND THE MIN-TRUST GATE, which reads
 * backwards at first: a report is not a read, it creates a durable row and
 * raises an alertable event, so an ungated report endpoint is a report-table
 * growth and mod-noise vector. Gating it on the same trust signals as `append`
 * is what bounds who can generate that work.
 *
 * A thin adapter over `reportSharedRow`, the SAME function
 * `trpc.apps.shared.report` calls: the write-scope + min-trust gate and the ANON
 * REFUSAL (401) in `resolveSharedContext(_, 'report')`, the per-(user, app)
 * DAILY report bucket taken before any DB work, the per-(reporter, key) dedup
 * that makes a repeat report of the same row a no-op, and the metadata-only
 * `block-audit` emit — which NEVER carries the reported content itself.
 *
 * `reason` is moderator-facing free text, bounded at SHARED_REASON_MAX and
 * defaulted to `'user-report'` by the router. It is deliberately NOT run through
 * the content-safety belt: nothing renders it to other app users.
 *
 * Response: `{ ok: true }` — identical whether the report was newly filed or
 * deduped, so the route cannot be used to probe who has already reported what.
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

const bodySchema = z.object({
  key: z.string().min(1).max(SHARED_KEY_MAX),
  reason: z.string().max(SHARED_REASON_MAX).optional(),
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
    const result = await reportSharedRow(bearer(req), parsed.data.key, parsed.data.reason);
    try {
      // The reported KEY only. The `reason` is NOT stashed: it is free text a
      // caller supplies, and the audit `detail` column stores ids, never
      // user-authored prose.
      stashBlockActionDetail(res, { action: 'shared.report', key: parsed.data.key, outcome: 'ok' });
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
  endpoint: 'shared_storage_report',
  requiredScope: 'apps:storage:shared:write',
  allowOpaqueOrigin: true,
});
