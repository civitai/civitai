import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getSamplerCatalog } from '~/shared/generation/sampler-options';

/**
 * GET /api/v1/blocks/generation-samplers — the generator's sampler options per model family,
 * derived from the generation graph (`~/shared/generation/sampler-options`).
 *
 * `default` is what the generator PRESELECTS, not what a block gets by omitting
 * `params.sampler` (the submit path then sends 'Euler'); a block wanting it sends it explicitly.
 *
 * Intentionally UNCLAMPED: it returns no catalog content, only sampler and base-model names. If
 * catalog data is ever added here, the maturity clamp must be added with it.
 *
 * Intentionally NOT RATE-LIMITED: `checkBlockCatalogRateLimit` is the shared search budget, and
 * this is a static in-memory read (see `tools.ts`).
 */
const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope passes through with no claims (no/invalid bearer, runtime flag off).
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  res.status(200).json(getSamplerCatalog());
});

// No requiredScope: any valid block token (see the doc above). allowOpaqueOrigin so an
// unverified block's direct fetch (Origin: null) clears the CORS preflight; safe here (static
// public data, no credentials, still token-gated). `onApprovalLookupFailure: 'serve'` for the
// reason its catalog siblings give: refusing a static, viewer-independent read on a replica
// blip removes no exposure and costs a 503.
export default withBlockScope(baseHandler, {
  endpoint: 'generation_samplers',
  allowOpaqueOrigin: true,
  onApprovalLookupFailure: 'serve',
});
