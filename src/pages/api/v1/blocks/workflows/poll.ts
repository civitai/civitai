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
 * POST /api/v1/blocks/workflows/poll  body `{ workflowId, waitSeconds? }` → `{ snapshot }`
 * Scope `ai:write:budgeted`.
 *
 * Read one workflow's current status — the REST twin of the `POLL_WORKFLOW`
 * bridge message, and the route a block's watch loop lives on. Optionally a LONG
 * POLL: `waitSeconds` asks the orchestrator to hold the read until the workflow
 * goes terminal (bounded by the wire schema and clamped again by
 * `resolveBlockPollWaitSeconds`, which owns the policy).
 *
 * A thin adapter over `blocks.pollWorkflow`, the SAME procedure the page host
 * calls, so the whole ladder runs verbatim: the `ai:write:budgeted` assertion, the
 * anon refusal, the App-Blocks kill-switch against the TOKEN subject, the
 * dedicated `:poll:` rate-limit bucket (which RETURNS a non-terminal snapshot
 * rather than throwing, because a thrown 429 here destroys a paid generation), the
 * inline output-moderation scan on any generated text, the terminal read-model
 * write, the post-paid settle and the author-fee reversal.
 *
 * 🔴 THE TWO OWNERSHIP GATES ARE THE POINT OF THIS ROUTE, because `workflowId`
 * arrives as request input rather than off the verified token, and THE
 * ORCHESTRATOR ITSELF DOES NOT VERIFY WORKFLOW OWNERSHIP. Inside the procedure:
 *   - `assertBlockWorkflowMintedForViewer` — the orchestrator mints every id as
 *     `<owning userId>-<timestamp>`, so the id must name THIS viewer. Fail-closed,
 *     and checked BEFORE any orchestrator call.
 *   - `assertBlockWorkflowTaggedForApp` — the orchestrator's own record must carry
 *     THIS app's `app-block:<appId>` provenance tag. Checked on the fetched
 *     record, still ahead of anything derived from it reaching the block.
 * Both are the procedure's, not this route's, which is exactly why this route
 * cannot weaken them.
 *
 * WHY POST WITH THE ID IN THE BODY, rather than `GET /workflows/[workflowId]`. The
 * id EMBEDS THE VIEWER'S USER ID (that is what makes the viewer gate above work),
 * so putting it in the path would publish a viewer identifier into access logs,
 * `Referer` headers and any intermediary that records URLs — for a route whose
 * whole job is per-viewer scoping. Keeping it in the body also keeps the twin's
 * verb identical to the bridge's mutation and keeps the audit `endpoint` column a
 * fixed literal instead of a templated `:seg`.
 *
 * 🔴 THE ERROR CONTRACT — 2xx IFF THE PROCEDURE RESOLVED. Same rule as the other
 * three, and it matters here for a different reason: the rate-limit path RESOLVES
 * with a deliberately non-terminal `status:'processing'` snapshot so the block
 * keeps its watch loop. Answering that with a 429 would make the SDK's host
 * wrapper synthesise a TERMINAL failure, stop the loop, and strand a paid,
 * still-running generation — the exact failure the procedure's comment exists to
 * prevent. RESOLVED → 200 with the body byte-for-byte; THROWN → non-2xx through
 * `handleEndpointError`.
 *
 * Response: `{ snapshot }` — a `BlockWorkflowSnapshot`, the same shape the bridge
 * delivers in `WORKFLOW_STATUS`.
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

// Mirrors `blocks.pollWorkflow`'s input minus `blockToken` (which rides the
// Authorization header here). The `waitSeconds` bound is deliberately the LOOSER
// of the two gates — it rejects nonsense, `resolveBlockPollWaitSeconds` decides
// policy, and the policy stays in one place.
const bodySchema = z.object({
  workflowId: z.string().min(1).max(64),
  waitSeconds: z.number().int().min(0).max(60).optional(),
});

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
    const result = await caller.pollWorkflow({
      blockToken: blockWorkflowBearer(req),
      workflowId: parsed.data.workflowId,
      ...(parsed.data.waitSeconds !== undefined ? { waitSeconds: parsed.data.waitSeconds } : {}),
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
  endpoint: 'workflows_poll',
  requiredScope: 'ai:write:budgeted',
  allowOpaqueOrigin: true,
});
