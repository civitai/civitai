import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  getSharedCounts,
  SHARED_COUNTS_KEYS_MAX,
  SHARED_KEY_MAX,
} from '~/server/routers/apps-shared.router';

/**
 * GET /api/v1/blocks/shared-storage/counts?keys=<k1>&keys=<k2>…
 * Scope `apps:storage:shared:read`.
 *
 * Batch aggregate vote counts for up to 100 keys in THIS app's shared schema.
 * `counters` ONLY — the raw `votes` rows are never listable, and a hidden or
 * unknown key resolves to 0 (so the response always carries one entry per
 * REQUESTED key, and a caller cannot use a 0/absent distinction to probe whether a
 * hidden row exists).
 *
 * 🔴 ONE ROUTE COVERS BOTH tRPC READS. `trpc.apps.shared.getCount` (single key) is
 * this same batch query with a one-element array — it has no SQL of its own — so a
 * `/count` sibling would be a second spelling of one operation, not a second
 * operation. Ask for one key and read `counts[key]`.
 *
 * A thin adapter over `getSharedCounts`, the SAME function both tRPC procedures
 * call — per-app schema isolation (derived from the VERIFIED token, never from the
 * `keys` in this request), the approved-block + revocation checks, the read-scope
 * assertion and the fail-closed kill-switch all hold verbatim. Anon is allowed
 * (`getCount` is in the resolver's READ_OPS). Money-free.
 *
 * Response: `{ counts: { [key]: number } }`.
 */

export const config = { api: { responseLimit: false } };

// Next gives `?keys=a` as a string and `?keys=a&keys=b` as an array. Normalise to
// an array BEFORE the bounds run, so the min(1)/max(100) ceiling applies to both
// spellings identically. Comma-splitting is deliberately NOT done: an app chooses
// its own counter keys and a comma is a legal character in one, so splitting would
// silently shatter a valid key into two lookups that both miss.
const keysSchema = z.preprocess(
  (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
  z.array(z.string().min(1).max(SHARED_KEY_MAX)).min(1).max(SHARED_COUNTS_KEYS_MAX)
);

const querySchema = z.object({ keys: keysSchema });

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

  try {
    const result = await getSharedCounts(bearer(req), parsed.data.keys);
    res.status(200).json(result);
    return;
  } catch (error) {
    // See list.ts for why this is `handleEndpointError` and not the
    // `{ error: trpcError.message }` arm the two older shared-storage routes carry.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'shared_storage_counts',
  requiredScope: 'apps:storage:shared:read',
  allowOpaqueOrigin: true,
});
