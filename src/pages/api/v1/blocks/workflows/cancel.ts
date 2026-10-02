import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  blockWorkflowBearer,
  blockWorkflowCaller,
} from '~/server/services/blocks/block-workflow-rest';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/workflows/cancel  body `{ workflowId }` → `{ snapshot }`
 * Scope `ai:write:budgeted`.
 *
 * Stop a running workflow on the orchestrator — the REST twin of the
 * `CANCEL_WORKFLOW` bridge message. A real server-side stop, not a client-side
 * "stop watching".
 *
 * A thin adapter over `blocks.cancelWorkflow`, the SAME procedure the page host
 * calls, so the whole ladder runs verbatim: the `ai:write:budgeted` assertion, the
 * anon refusal, the App-Blocks kill-switch against the TOKEN subject, the catalog
 * rate-limit bucket (which RETURNS a non-terminal snapshot rather than throwing —
 * a thrown 429 would tell the block a still-running, paid workflow had failed
 * AND that the cancel happened, both false), the read-before-cancel ordering, the
 * output-moderation scan on the re-read, the post-paid settle, and the
 * author-fee reversal with its `!== 'succeeded'` race guard.
 *
 * 🔴 THE TWO OWNERSHIP GATES, as on the poll route and for the same reason — the
 * orchestrator does not verify workflow ownership, so these ARE the gate:
 *   - `assertBlockWorkflowMintedForViewer` — the id must name THIS viewer,
 *     fail-closed, before any orchestrator call;
 *   - `assertBlockWorkflowTaggedForApp` — the record must carry THIS app's
 *     `app-block:<appId>` tag, asserted on a read taken BEFORE the cancel is
 *     issued, so both scopes hold while the workflow is still un-stopped.
 * Without them a block could stop a stranger's generation, or another app's.
 *
 * WHY POST WITH THE ID IN THE BODY: see poll.ts — the workflow id embeds the
 * viewer's user id, and a cancel is a mutation either way.
 *
 * 🔴 THE ERROR CONTRACT — 2xx IFF THE PROCEDURE RESOLVED; see submit.ts for the
 * money half of the argument and poll.ts for the rate-limit half.
 *
 * Response: `{ snapshot }` — a `BlockWorkflowSnapshot` of the (now usually
 * canceled) workflow, the same shape the bridge delivers in `WORKFLOW_CANCELED`.
 * A cancel of an ALREADY-TERMINAL workflow does NOT fail: the procedure's PATCH
 * passes no `throwOnError`, so the re-read simply returns the real terminal state.
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

// Mirrors `blocks.cancelWorkflow`'s input minus `blockToken` (Authorization header).
const bodySchema = z.object({ workflowId: z.string().min(1).max(64) });

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

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const caller = await blockWorkflowCaller(req, res);
    const result = await caller.cancelWorkflow({
      blockToken: blockWorkflowBearer(req),
      workflowId: parsed.data.workflowId,
    });
    res.status(200).json(result);
    return;
  } catch (error) {
    // See estimate.ts — `handleEndpointError`, so failures answer `{ message }`
    // and this route stays off the known-leak list in
    // `rest-error-envelope-ledger.test.ts`. Both ownership refusals are
    // `FORBIDDEN` TRPCErrors and map to a 403 here.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'workflows_cancel',
  requiredScope: 'ai:write:budgeted',
  allowOpaqueOrigin: true,
});
