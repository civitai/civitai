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
import { BLOCK_IDEMPOTENCY_KEY_REGEX } from '~/server/utils/block-gen-idempotency';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/workflows/submit  body `{ body, idempotencyKey? }` → `{ snapshot }`
 * Scope `ai:write:budgeted`.
 *
 * Runs a generation that SPENDS THE VIEWER'S BUZZ — the REST twin of the
 * `SUBMIT_WORKFLOW` bridge message, and the highest-consequence route on the
 * block REST surface.
 *
 * A thin adapter over `blocks.submitWorkflow`, the SAME procedure the page host
 * calls. Every spend control therefore runs verbatim, in one place, and none of
 * them is re-spelled here:
 *   - the per-call `buzzBudget` ceiling the token itself carries;
 *   - the per-(user, UTC-day) Buzz reservation, and the viewer's OWN per-app
 *     CONSENT budget, both reserved atomically before the orchestrator is called
 *     and refunded on every non-committed exit;
 *   - the per-app aggregate daily spend + generation VELOCITY cap (G8), and the
 *     dev-tunnel per-session backstop;
 *   - the gen-idempotency claim (so a lost-response retry cannot double-charge);
 *   - the maturity clamp derived from the token's server-minted ceiling, never a
 *     body field and never the request domain;
 *   - the registered-step denylist and the customComfy / pass-through branches;
 *   - `getOrchestratorToken` and the `app-block:<appId>` provenance tag that every
 *     later read and cancel of this workflow is scoped by.
 * See `block-workflow-rest.ts` for why this delegates to the procedure rather than
 * to a copy of its body.
 *
 * 🔴 THE ERROR CONTRACT — 2xx IFF THE PROCEDURE RESOLVED, AND THIS IS THE MONEY
 * HALF OF IT. `submitWorkflow` answers a BUDGET REJECTION by RESOLVING with a
 * failure-shaped snapshot that QUOTES THE PRICE it refused to charge — four such
 * exits (per-call budget, per-user daily / review-session cap, per-app aggregate +
 * velocity cap, dev-session backstop), each carrying `cost.total` and no workflow
 * id. `@civitai/blocks-react`'s `useBuzzWorkflow` reads exactly that: a
 * `status:'failed'` snapshot WITH a numeric `cost.total` RESOLVES so the block can
 * open a top-up flow, and only a cost-less failure rejects as
 * `WorkflowSubmitError(…, 'no-cost' | 'workflow-failed')`. Answering a budget
 * rejection with a 4xx would erase that distinction on the wire and turn a
 * recoverable top-up into a hard failure — a live control, on a spend path,
 * quoting the wrong outcome. So: RESOLVED → 200 with the procedure's body
 * byte-for-byte, INCLUDING every refusal snapshot; THROWN → non-2xx through
 * `handleEndpointError`. The bridge already draws the recoverable/unrecoverable
 * line at resolve-vs-throw; this preserves that boundary rather than inventing a
 * second one.
 *
 * 🔴 NO `stashBlockActionDetail` HERE, AND THE OMISSION IS DELIBERATE — it is the
 * one place where delegating to the procedure changes what the audit table sees,
 * so it is stated rather than left to be discovered. `blocks.submitWorkflow`
 * already writes its OWN `block_scope_invocations` row (`endpoint:
 * 'workflow:submit'`, `detail.action: 'workflow.submit'`, `detail.amount` = the
 * negative Buzz spend), and it is the better row: it is the only writer that knows
 * `cost`, which is the number the Activity panel renders. `withBlockScope` then
 * writes its own access-log row for this REST call, as it does for every wrapped
 * route. Stashing a `workflow.submit` detail on that second row would make the
 * viewer's own activity feed render ONE generation as TWO "Generated an image"
 * entries. One money row, one access row. Suppressing the access row would need a
 * new `withBlockScope` option, i.e. a middleware change on every route's audit
 * path, which is not worth it for a technical duplicate nothing renders as money.
 *
 * 🔴 A PREVIOUS VERSION OF THIS PARAGRAPH ARGUED THE POINT FROM A FALSE PREMISE,
 * recorded here so nobody re-derives it. It claimed the detail-less row "falls
 * back to the technical `scope · endpoint · status` line" because
 * "`ai:write:budgeted` is not in `READ_SCOPE_LABELS`". That is true and
 * IRRELEVANT: `humaniseScopeInvocation` (`components/Apps/AppActivityPanel.tsx`)
 * checks its endpoint arms, then `READ_SCOPE_LABELS`, then falls THROUGH to
 * `SCOPE_ACTION_LABELS`, which maps `ai:write:budgeted` to 'Submit AI workflow'.
 * The reasoning was exactly one map short, and there is no technical-line
 * fallback at all. The decision above survives — it never depended on that
 * clause — but the three READ-shaped twins did NOT: poll/estimate/cancel each
 * rendered as 'Submit AI workflow', ~30x per generation at poll cadence. Fixed
 * by giving those three their own arms in `humaniseScopeInvocation`, pinned by
 * `analytics-bucket-labels.test.ts`. `/workflows/submit` has no arm because for
 * THIS route the label is true.
 *
 * Response: `{ snapshot }` — a `BlockWorkflowSnapshot`, the same shape the bridge
 * delivers in `WORKFLOW_SUBMITTED`.
 */

// See estimate.ts — the generation body carries prompts, a resource array and
// source-image references; `blockWorkflowBodySchema` owns the real per-field bounds.
export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

const bodySchema = z.object({
  body: blockWorkflowBodySchema,
  // 🔴 REQUIRED on this route, unlike the bridge input it forwards to, and that
  // asymmetry is the point rather than an oversight.
  //
  // Absent a CLIENT key the procedure mints `bls<uuid>` per request, which dedupes
  // `submitWorkflow`'s own 3x internal retry of THIS call but — being unique per
  // request — does NOT dedupe a client-level retry; the redis SET-NX claim stays
  // gated on the client key. On the bridge that was tolerable because the caller is
  // civitai's own host code. This is a public HTTP surface, where retry-on-timeout
  // is the DEFAULT behaviour of most HTTP client libraries, so the same omission
  // means: connection drops after the orchestrator accepted and charged, client
  // retries, second `externalId`, second workflow, second debit of the viewer's
  // Buzz. Failing closed with a 400 is strictly better than silently charging twice.
  //
  // Same charset bound as the bridge input (`BLOCK_IDEMPOTENCY_KEY_REGEX`) so no
  // control chars / newlines / colons can flow into the orchestrator `externalId`
  // derived from it.
  idempotencyKey: z.string().regex(BLOCK_IDEMPOTENCY_KEY_REGEX),
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

  // Parsed with the procedure's OWN schema (imported, not re-spelled); see
  // estimate.ts. The procedure re-parses and remains the authority.
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const caller = await blockWorkflowCaller(req, res);
    const result = await caller.submitWorkflow({
      blockToken: blockWorkflowBearer(req),
      body: parsed.data.body,
      ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
    });
    res.status(200).json(result);
    return;
  } catch (error) {
    // See estimate.ts — `handleEndpointError`, so failures answer `{ message }`
    // and this route stays off the known-leak list in
    // `rest-error-envelope-ledger.test.ts`.
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'workflows_submit',
  requiredScope: 'ai:write:budgeted',
  allowOpaqueOrigin: true,
});
