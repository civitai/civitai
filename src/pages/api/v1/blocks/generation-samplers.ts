import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getSamplerCatalog } from '~/shared/generation/sampler-options';

/**
 * GET /api/v1/blocks/generation-samplers
 *
 * The sampler drop-down the on-site generator shows, per model family, for a block that
 * builds a `textToImage` body. The body's `params.sampler` is a free string and a name the
 * family does not offer is silently replaced by the family default, so a block needs the list
 * the generator itself uses. The list is DERIVED from the generation graph
 * (`getSamplerCatalog`, `~/shared/generation/sampler-options`), never copied, so it moves when a
 * graph does.
 *
 * Response:
 *   {
 *     ecosystems: { [ecosystemKey]: {
 *       sampler: { options: { value, label }[], default } | null,   // null: no sampler control
 *       byModelVersion: { [versionId]: { options, default } | null } // versions that differ
 *     } },
 *     baseModels: { [baseModelName]: ecosystemKey }
 *   }
 * A block resolves its checkpoint's family with `baseModels[checkpoint.baseModel]` — the same
 * `getEcosystem(baseModel)` the submit path keys the graph by.
 *
 * `default` is what the on-site generator PRESELECTS. It is not what a block gets by omitting
 * `params.sampler`: the block submit path then sends 'Euler' (`buildImageWorkflowInput`), which
 * on the SD families is a valid, different sampler. A block that wants the generator's default
 * sends `default` explicitly.
 *
 * Auth: any valid block token, no requiredScope — the same posture as `blocks/models.ts` and
 * `blocks/generation-resources.ts`, and a weaker need than theirs: those need the token for its
 * signed `maxBrowsingLevel`, this needs it for nothing but the gate. The data is static
 * generator configuration: nothing viewer-scoped, nothing app-scoped, nothing written.
 *
 * NO MATURITY CLAMP, deliberately and not by omission. `tools.ts` warns that the clamp is not
 * inherited from this prefix and a route that forgets it is unclamped; this route returns no
 * catalog content — no model, image or resource — only sampler names and base-model names that
 * are the same for every caller, so there is nothing for a browsing level to filter.
 *
 * NOT RATE-LIMITED, for the reasons `tools.ts` gives for its declarations GET: the per-request
 * cost here is the prefix's (the middleware's revocation read and audit row), the catalog is
 * built once per process and then served from memory, and `checkBlockCatalogRateLimit` is the
 * SHARED catalog budget — charging a static read to it would take search budget from a block
 * for fetching the list it needs to build a form. A prefix-level limit in the middleware is the
 * fix if the audit-row volume ever needs bounding.
 */
const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // Not a backstop: `withBlockScope` falls through to this handler with no claims for a
    // missing bearer, a bearer `isBlockJwt` rejects, and the runtime flag off (see the
    // comment in `tools.ts`, which counts them in the middleware).
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
