import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import {
  blockWorkflowBearer,
  blockWorkflowCaller,
} from '~/server/services/blocks/block-workflow-rest';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/workflows/estimate  body `{ body }` → `{ snapshot }`
 * Scope `ai:write:budgeted`.
 *
 * Cost-only preview: the REST twin of the `ESTIMATE_WORKFLOW` bridge message.
 * A thin adapter over `blocks.estimateWorkflow` — the SAME procedure the page
 * host calls — so the whatIf submit, the `kind` branches (textToImage /
 * customComfy / registered step / pass-through step), the model-binding check,
 * the page entitlement gate, the maturity clamp and the catalog rate-limit bucket
 * all run verbatim and in one place. See `block-workflow-rest.ts` for why this
 * delegates to the procedure rather than to a copy of its body.
 *
 * 🔴 THE ERROR CONTRACT — 2xx IFF THE PROCEDURE RESOLVED. `@civitai/blocks-react`'s
 * `useBuzzWorkflow` branches on the SNAPSHOT, not on a transport code: it publishes
 * `snapshot` to `result` and then rejects with `WorkflowEstimateError(snapshot,
 * 'failed' | 'no-cost')` when the snapshot carries no usable `cost.total`. So the
 * one thing this route must not do is collapse "the procedure answered with a
 * priced, refusal-shaped snapshot" into "the request failed": that snapshot is how
 * the block learns the price it must offer the viewer a top-up for. The rule is
 * therefore mechanical — a RESOLVED procedure is 200 with its body byte-for-byte,
 * a THROWN one is a non-2xx through `handleEndpointError`. The bridge already
 * draws the recoverable/unrecoverable line at exactly resolve-vs-throw (the host
 * converts a throw into `failureSnapshot`), so this preserves the existing
 * boundary rather than inventing a second one on the wire.
 *
 * Response: `{ snapshot }` — a `BlockWorkflowSnapshot`, the same shape the bridge
 * delivers in `ESTIMATE_RESULT`.
 */

// The generation body carries prompts, a resource array and (on the image bridge)
// source-image references. Sized to the bridge's own tolerance; the authoritative
// per-field bounds are `blockWorkflowBodySchema`'s.
export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

const bodySchema = z.object({ body: blockWorkflowBodySchema });

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

  // Parsed HERE with the procedure's OWN schema (imported, not re-spelled) purely
  // so a malformed body gets the structured 400 every sibling route answers with
  // instead of a tRPC BAD_REQUEST carrying a serialized issue list. The procedure
  // re-parses and remains the authority; there is one schema, so the two cannot
  // disagree.
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const caller = await blockWorkflowCaller(req, res);
    const result = await caller.estimateWorkflow({
      blockToken: blockWorkflowBearer(req),
      body: parsed.data.body,
    });
    res.status(200).json(result);
    return;
  } catch (error) {
    // `handleEndpointError` — it maps a TRPCError to its HTTP status, genericizes
    // server faults and driver-authored 4xx text, and keeps this route off the
    // known-leak list in `rest-error-envelope-ledger.test.ts`. Consequence, stated
    // because it is a wire-format difference from the older block routes: failures
    // answer `{ message }`, not `{ error }`.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'workflows_estimate',
  requiredScope: 'ai:write:budgeted',
  allowOpaqueOrigin: true,
});
