import { failureSnapshot } from './failureSnapshot';
import { BRIDGE_NACK_SNAPSHOT_REPLIES, nackReplyTypeFor } from './bridgeTelemetry';

/**
 * Build the host→block ERROR reply for a request the host is refusing, or `null`
 * when the protocol has no reply this host can truthfully send.
 *
 * 🔴 ONE RULE, ONE PLACE. Before this, the "reply instead of returning" fix
 * existed exactly once — `PageBlockHost`'s balance handler, whose own comment
 * calls itself a "DEVIATION from the workflow handlers (which DROP a `!token`
 * request silently)". One handler got the fix; nine did not, and the unhandled-type
 * case got it nowhere. A predicate open-coded at N sites is wrong at N-1 of them,
 * so it lives here and every site calls it.
 *
 * 🔴 THE SHAPE IS NOT UNIFORM AND CANNOT BE. The SDK drops a reply that fails its
 * inbound validator, and the validators disagree about what an error reply looks
 * like:
 *   - the `{ ok?, error }` family early-accepts a PRESENT `error` and the consuming
 *     hook throws on it (`replyError.ts` in the SDK) — a bare `{ requestId, error }`
 *     resolves the block's promise and surfaces a real error;
 *   - the WORKFLOW family (`isValidWorkflowReply`) requires a `snapshot` with a
 *     non-empty `workflowId` and has NO early-accept, so a bare error reply is
 *     dropped and the block hangs to its 120s timeout. Those route through
 *     `failureSnapshot`, which exists for exactly this and stamps the `'failed'`
 *     sentinel id the validator needs;
 *   - two types have no sendable failure variant at all — see `BRIDGE_NACK_EXEMPT`.
 *
 * A reply built here is a best-effort UNBLOCK, not a promise that the block renders
 * a nice error: the picker replies (`CHECKPOINT_PICKER_RESULT`,
 * `RESOURCE_PICKER_RESULT`, `IMAGE_UPLOAD_RESULT`) validate a bare `{ requestId }`
 * and their hooks read `selected`, so the block sees "the user cancelled" rather
 * than an error. That is a deliberate trade: a wrong-but-instant resolution beats a
 * ten-minute stall on a 600s human-in-the-loop class.
 */
export function buildBridgeNackReply(
  type: string,
  requestId: string,
  message: string
): { type: string; payload: Record<string, unknown> } | null {
  const replyType = nackReplyTypeFor(type);
  if (replyType === null) return null;
  if (BRIDGE_NACK_SNAPSHOT_REPLIES.has(replyType)) {
    return {
      type: replyType,
      payload: { requestId, snapshot: failureSnapshot(new Error(message)) },
    };
  }
  return { type: replyType, payload: { requestId, error: message } };
}
