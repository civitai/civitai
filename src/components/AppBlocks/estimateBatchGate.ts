import { resolveEstimateBatchRequest } from '~/components/AppBlocks/pageBlockHostLogic';
import type {
  BlockEstimateBatchAggregate,
  BlockEstimateBatchResult,
  BlockWorkflowSnapshot,
} from '~/server/schema/blocks/workflow.schema';

/**
 * The decision + reply layer for the `ESTIMATE_WORKFLOW_BATCH` host bridge. PURE
 * apart from the injected `estimateBatch` call, and host-agnostic: the page host
 * and the model-slot host both run a request through `handleEstimateBatch`, so the
 * two cannot answer the same message differently.
 *
 *   `ESTIMATE_WORKFLOW_BATCH { requestId, bodies: WorkflowBody[] }`
 *     → `ESTIMATE_BATCH_RESULT { requestId, snapshots, aggregate }`
 *     | `ESTIMATE_BATCH_RESULT { requestId, error }`
 *
 * `snapshots[i]` answers `bodies[i]`: the snapshot a single ESTIMATE_WORKFLOW
 * would have produced for that body, or the failure-shape snapshot when that
 * estimate failed. A per-cell failure is therefore a SUCCESSFUL reply; `error` is
 * only for what is wrong with the whole call (review mode, no credential, a
 * malformed or over-long list, the scope, the rate limit).
 *
 * 🔴 ESTIMATE ONLY. This forwards to `blocks.estimateWorkflowBatch`, which prices
 * and never submits. Each cell is still submitted later through SUBMIT_WORKFLOW.
 *
 * 🔴 THE CALL IS INJECTED, NOT A `useMutation` HOOK. The hosts pass
 * `trpcUtils.client.blocks.estimateWorkflowBatch.mutate`, the same shape
 * `prepareTrainingDatasetGate.ts` uses, so the bridge is exercised here without a
 * rendered host.
 */

export const ESTIMATE_BATCH_REPLY = 'ESTIMATE_BATCH_RESULT';

/** Sent when the procedure returned something that is not a batch result. */
export const ESTIMATE_BATCH_MALFORMED_REPLY = 'estimate batch returned an unexpected result';

function isSnapshotLike(value: unknown): value is BlockWorkflowSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  // The SDK drops a reply whose snapshot has no non-empty `workflowId`.
  return (
    typeof snapshot.workflowId === 'string' &&
    snapshot.workflowId.length > 0 &&
    typeof snapshot.status === 'string'
  );
}

/**
 * The reply for a batch estimate that RETURNED, or `null` when the result does not
 * answer the request (wrong length, a cell that is not a snapshot, no numeric
 * aggregate).
 *
 * Snapshots pass through VERBATIM: a cell's `cost` object is whatever the single
 * estimate produced for it, so a field added to that object later arrives per
 * cell with no change here. The aggregate is copied by name, so nothing else the
 * procedure may grow reaches the block unreviewed.
 */
export function estimateBatchReplyFromResult(
  result: BlockEstimateBatchResult,
  cellCount: number
): { snapshots: BlockWorkflowSnapshot[]; aggregate: BlockEstimateBatchAggregate } | null {
  if (!result || typeof result !== 'object') return null;
  const { snapshots, aggregate } = result;
  if (!Array.isArray(snapshots) || snapshots.length !== cellCount) return null;
  if (!snapshots.every(isSnapshotLike)) return null;
  if (!aggregate || typeof aggregate !== 'object') return null;
  const { total, pricedCells, cellCount: reportedCellCount } = aggregate;
  if (
    typeof total !== 'number' ||
    typeof pricedCells !== 'number' ||
    typeof reportedCellCount !== 'number'
  ) {
    return null;
  }
  return { snapshots, aggregate: { total, pricedCells, cellCount: reportedCellCount } };
}

/**
 * Run one `ESTIMATE_WORKFLOW_BATCH` request end to end and reply exactly once on
 * `ESTIMATE_BATCH_RESULT` (never for a payload with no `requestId`, which has
 * nothing to correlate a reply to).
 *
 * @param refusal a host-level refusal to answer with instead of calling the
 *   server (the page host's review preview), or `null`.
 * @param onNoToken called INSTEAD of replying when the host holds no block
 *   credential, so the host can answer through its shared no-credential path.
 */
export async function handleEstimateBatch(opts: {
  raw: unknown;
  refusal: string | null;
  token: string | null | undefined;
  estimateBatch: (input: {
    blockToken: string;
    bodies: unknown[];
  }) => Promise<BlockEstimateBatchResult>;
  send: (type: typeof ESTIMATE_BATCH_REPLY, payload: Record<string, unknown>) => void;
  onNoToken: (requestId: string) => void;
}): Promise<void> {
  const { raw, refusal, token, estimateBatch, send, onNoToken } = opts;
  const gate = resolveEstimateBatchRequest(raw);
  if (gate.kind === 'drop') return;
  const requestId = gate.kind === 'refuse' ? gate.requestId : gate.request.requestId;
  if (refusal !== null) {
    send(ESTIMATE_BATCH_REPLY, { requestId, error: refusal });
    return;
  }
  if (gate.kind === 'refuse') {
    send(ESTIMATE_BATCH_REPLY, { requestId, error: gate.error });
    return;
  }
  const { bodies } = gate.request;
  if (!token) {
    onNoToken(requestId);
    return;
  }
  try {
    const result = await estimateBatch({ blockToken: token, bodies });
    const reply = estimateBatchReplyFromResult(result, bodies.length);
    send(
      ESTIMATE_BATCH_REPLY,
      reply ? { requestId, ...reply } : { requestId, error: ESTIMATE_BATCH_MALFORMED_REPLY }
    );
  } catch (err) {
    send(ESTIMATE_BATCH_REPLY, {
      requestId,
      error: err instanceof Error ? err.message : 'estimate batch failed',
    });
  }
}
