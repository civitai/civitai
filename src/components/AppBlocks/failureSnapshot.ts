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

/**
 * tRPC codes that say the poll could not be answered, not that the workflow failed. With no code at
 * all (a network error, an aborted fetch, a non-JSON gateway page) the server's verdict is equally
 * unknown. Every other code is the server refusing the request and stays terminal.
 */
const POLL_UNANSWERED_CODES: ReadonlySet<string> = new Set([
  'INTERNAL_SERVER_ERROR',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'TIMEOUT',
  'TOO_MANY_REQUESTS',
  'CLIENT_CLOSED_REQUEST',
]);

export function isPollUnanswered(err: unknown): boolean {
  const code = (err as { data?: { code?: unknown } | null } | null | undefined)?.data?.code;
  return typeof code !== 'string' || POLL_UNANSWERED_CODES.has(code);
}

/**
 * The WORKFLOW_STATUS snapshot for a poll that threw. `failed` is terminal for the block's watch
 * loop, so a poll the server never answered gets the same "not read this time" placeholder the
 * server's own poll rate limit returns, and the block polls again.
 */
export function pollFailureSnapshot(err: unknown, workflowId: string): BlockWorkflowSnapshot {
  if (isPollUnanswered(err)) return { workflowId, status: 'processing' };
  return failureSnapshot(err);
}
