import { INVENTORY } from './hostHandlerParity';

/**
 * App Blocks postMessage BRIDGE telemetry — the INVENTORY-dependent half.
 *
 * WHY THIS EXISTS. The shared dispatcher (`usePostMessage.ts`) has five distinct
 * ways to discard an inbound block→host message, and until this module they were
 * all indistinguishable from each other AND from a merely slow host:
 *
 *   1. no handler registered for the type  — silent `return`
 *   2. rate limited (>30 msg/sec)          — `console.warn` only
 *   3. deduped (same requestId within 5s)  — silent
 *   4. a handler ran but the block token was falsy — silent `return`
 *   5. the reply failed the SDK's validator — SDK-side `console.warn` only, and
 *      INVISIBLE from here: that check runs in the iframe AFTER we replied, so this
 *      host counted the same exchange `handled`. Now self-reported by the block
 *      over `BLOCK_MESSAGE_REJECTED` -> `outcome="validator_rejected"`, which is
 *      the only route there is; see `bridgeLabels.ts` for how to read it
 *
 * `civitai_app_block_renders_total` cannot see any of them: it fires ONCE per
 * host mount and reports the settled MOUNT outcome, so every failure that
 * happens AFTER ready is structurally invisible to it. That is not theoretical —
 * on 2026-09-18 a `custom-generators` gallery read was dead for a full 15-day
 * retention window while 100% of render series across all 11 rendering apps read
 * `result=ok, error_class=none`.
 *
 * 🔴 NO REACT, NO BROWSER GLOBALS, NO prom-client — this is imported by BOTH the
 * browser dispatcher and the server beacon route. The pure label ENUMS and wire
 * bounds live one module over in `bridgeLabels.ts` (and are re-exported here) so
 * that `track.schema.ts` can single-source them WITHOUT dragging `INVENTORY` into
 * every bundle that imports the track schema. See that file's header.
 */

export {
  BRIDGE_MESSAGE_OUTCOMES,
  BRIDGE_HOSTS,
  BRIDGE_MESSAGE_BATCH_MAX,
  BRIDGE_MESSAGE_COUNT_MAX,
  BRIDGE_NACK_NO_HANDLER,
  BRIDGE_NACK_NO_TOKEN,
} from './bridgeLabels';
export type { BridgeMessageOutcome, BridgeHost } from './bridgeLabels';

/**
 * Clamp a message `type` to a bounded prom label: the type itself when the
 * protocol declares it, else `'other'`.
 *
 * 🔴 IT IS APPLIED ON BOTH SIDES, AND FOR DIFFERENT REASONS. Server-side
 * (`/api/track/block-message`) it is the CARDINALITY BOUND: the beacon body is
 * client-supplied and the route is public, and prom-client retains every distinct
 * label set in the Node heap forever across ~130 scraped pods. Client-side
 * (`recordBridgeMessage`) it bounds the BUFFER: the dispatcher's unhandled-type
 * branch sits deliberately ahead of the 30 msg/sec inbound limiter, so a block
 * posting unique junk types would otherwise mint a new buffer key per message,
 * trip the distinct-key flush on every 64th, and turn an inbound message flood
 * into an outbound HTTP flood — and would put an unbounded `type` string into the
 * POST body, which the server's `max(128)` then rejects WHOLESALE, destroying
 * every legitimate count riding in the same batch.
 */
export function boundBridgeMessageType(type: string): string {
  return Object.prototype.hasOwnProperty.call(INVENTORY, type) ? type : 'other';
}

/**
 * Is `reply` a BARE message type, i.e. safe to dispatch on?
 *
 * `MessageSpec.reply` is documentation (its own docstring says so), so one entry
 * — `REQUEST_TOKEN` — carries PROSE: `'TOKEN_REFRESH_RESPONSE (or a TOKEN_REFRESH
 * push when no requestId was sent)'`. Interpolating that into `{ type }` would put
 * a message on the wire whose type matches nothing, which the SDK drops as an
 * unsolicited push — i.e. today's silence with extra steps.
 *
 * 🔴 EXPORTED SO IT CAN BE TESTED AT ALL, AND CURRENTLY UNREACHABLE INSIDE
 * `nackReplyTypeFor`. Measured over `INVENTORY`: exactly one entry has a non-bare
 * `reply`, it is `REQUEST_TOKEN`, and `REQUEST_TOKEN` is caught two lines earlier
 * by `BRIDGE_NACK_EXEMPT`. So a mutation deleting the call below SURVIVES —
 * an earlier check always wins. It is kept as defence-in-depth against the NEXT
 * prose entry (nothing stops one: `hostHandlerParity` says plainly that nothing
 * enforces this field), and it is tested directly here rather than through a
 * caller that cannot reach it.
 */
export function isBareReplyType(reply: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(reply);
}

/**
 * Request types that deliberately get NO error reply, with the reason.
 *
 * 🔴 AN EXEMPTION IS NOT A GAP WE FORGOT — it is a case where a NACK would be
 * DROPPED by the SDK's own inbound validator, making it indistinguishable from
 * today's silence while asserting a cause that is not true. The counter still
 * records the outcome for every exempt type, so the operator half of this arc is
 * unaffected; only the block-facing half is.
 *
 * Keyed by REQUEST type (not reply type) so the lookup is one step at the call
 * site. `bridgeTelemetry.test.ts` asserts every key is a real `request: true`
 * INVENTORY entry, so a stale exemption cannot outlive the message it exempts.
 */
export const BRIDGE_NACK_EXEMPT: Record<string, string> = {
  // `isValidWildcardPackResult` validates `error` against a CLOSED code set
  // {not-found, forbidden, too-large, parse-failed, busy}. None of those
  // truthfully describes "this host registers no handler", and a non-conforming
  // code fails the validator and is dropped — so a NACK here would buy nothing
  // and would lie about the cause. Needs an SDK code-set addition to fix.
  //
  // ⚠️ Do NOT "fix" this by borrowing PageBlockHost's `WILDCARD_REVIEW_NACK_CODE`
  // ('forbidden'). That code is TRUE in review mode — the host is refusing — and
  // false here, where the host simply has no handler.
  GET_WILDCARD_PACK:
    'WILDCARD_PACK_RESULT validates `error` against a closed code set; none of them means "unsupported on this host", and a non-conforming code is dropped by the SDK validator',
  // `isValidTokenRefreshResponse` requires a valid `WrappedToken`, so an
  // error-only TOKEN_REFRESH_RESPONSE is dropped at the block's trust boundary.
  // The protocol has no failure variant for a token refresh at all. Needs an SDK
  // protocol addition to fix.
  REQUEST_TOKEN:
    'TOKEN_REFRESH_RESPONSE requires a valid WrappedToken; the protocol has no failure variant, so an error-only reply is dropped by the SDK validator',
};

/**
 * Reply types whose SDK validator requires a workflow SNAPSHOT rather than
 * accepting a bare `{ requestId, error }`.
 *
 * `isValidWorkflowReply` checks `isValidWorkflowSnapshot(p.snapshot)` with no
 * early-accept on `error`, so an error-only reply is dropped and the block hangs
 * to its 120s workflow timeout. The host already has the cure — `failureSnapshot`
 * — and this set is what routes a NACK onto it. See `failureSnapshot.ts`, whose
 * own header records the recurring "the CTA buzz cost never updates" bug caused by
 * getting this wrong.
 */
export const BRIDGE_NACK_SNAPSHOT_REPLIES = new Set([
  'WORKFLOW_SUBMITTED',
  'ESTIMATE_RESULT',
  'WORKFLOW_STATUS',
  'WORKFLOW_CANCELED',
]);

/**
 * The reply type to NACK a `type` with, or `null` when it must not be NACKed.
 *
 * `null` for: an unknown type, a fire-and-forget type (nothing awaits a reply, so
 * a NACK would be an unsolicited push with no listener), an explicitly exempt type
 * (see `BRIDGE_NACK_EXEMPT`), and a type whose documented reply is prose rather
 * than a bare type (see `isBareReplyType` — currently unreachable, deliberately).
 */
export function nackReplyTypeFor(type: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(INVENTORY, type)) return null;
  if (Object.prototype.hasOwnProperty.call(BRIDGE_NACK_EXEMPT, type)) return null;
  const spec = (INVENTORY as Record<string, { request: boolean; reply: string }>)[type];
  if (!spec.request) return null;
  if (!isBareReplyType(spec.reply)) return null;
  return spec.reply;
}
