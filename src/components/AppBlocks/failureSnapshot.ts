import type { BlockWorkflowSnapshot } from '~/server/schema/blocks/workflow.schema';

// Failure-shape snapshot returned to the block when a host-side workflow tRPC
// call (estimate / submit / poll / cancel) throws. The SDK contract treats
// throws from useBuzzWorkflow.* as block lifecycle errors; posting a snapshot
// with status:'failed' instead lets the block surface a recoverable UX (e.g. an
// estimate-error line, a "Top up Buzz" CTA) without tearing down the iframe.
//
// IMPORTANT: workflowId MUST be non-empty. The block SDK's inbound validator
// (`isValidWorkflowSnapshot` in @civitai/blocks-react) DROPS any snapshot whose
// workflowId is an empty string — for ESTIMATE_RESULT / WORKFLOW_SUBMITTED /
// WORKFLOW_STATUS alike. A dropped reply never resolves the block's pending
// request, so it hangs to the transport's 120s timeout instead of surfacing the
// error promptly. An empty workflowId here silently swallowed every host-side
// estimate/submit/poll failure — the cause of the recurring "the CTA buzz cost
// never updates" bug: the estimate failed on the host, the failure reply was
// dropped by the validator, and the block sat on its budget fallback until the
// 120s timeout. A failed workflow has no real id, so we stamp a 'failed'
// sentinel; the block reads `status`/`error`, never this id.
export function failureSnapshot(err: unknown): BlockWorkflowSnapshot {
  return {
    workflowId: 'failed',
    status: 'failed',
    error: err instanceof Error ? err.message : 'workflow request failed',
  };
}
