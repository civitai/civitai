import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { buildBridgeNackReply } from './bridgeNackReply';
import { INVENTORY } from './hostHandlerParity';
import { recordBridgeMessage } from './bridgeMessageBeacon';
import {
  boundBridgeMessageType,
  BRIDGE_NACK_NO_HANDLER,
  BRIDGE_NACK_NO_TOKEN,
  type BridgeHost,
  type BridgeMessageOutcome,
} from './bridgeTelemetry';

/**
 * The block→host message that reports an SDK-side validator rejection.
 *
 * 🔴 A CONSTANT WITH A COMPILE-TIME BINDING, NOT A BARE LITERAL IN THE `if`. The
 * dispatcher branch below keys on this string, and so do its tests — so a bare
 * literal on both sides means an SDK RENAME silently disables the branch, returns
 * the series to zero, and falsifies `hostHandlerParity`'s entry for it with nothing
 * red anywhere. `satisfies keyof typeof INVENTORY` binds the two, and the inventory
 * is already in this module's import graph so the binding costs nothing.
 *
 * 🔴 BUT BE PRECISE ABOUT WHAT IT CATCHES — it is NARROWER than "an SDK rename is a
 * type error", which is what an earlier revision of this comment claimed. It fires
 * only on a rename that reaches the inventory AND DROPS THE OLD KEY. That matters
 * because `hostHandlerParity`'s coverage gate is ONE-DIRECTIONAL by design — the
 * inventory MAY carry keys ahead of the published dist, and today it carries three
 * — so the documented, gate-satisfying way to track an upstream rename is to ADD
 * the new key and leave the old one until the published dist catches up. In exactly
 * that state this binding stays green, the branch below never fires, and
 * `validator_rejected` returns to a permanent zero which the HELP string now tells
 * a reader to interpret as a rollout gap. That is the silent-dead-branch failure
 * this binding was added to end, surviving it.
 *
 * It is still strictly better than the bare literal it replaced — it catches an
 * outright key deletion and a typo in either place. But NOTHING here closes the
 * add-and-keep window, and no better guard was reached for: the honest statement is
 * that the window is open, not a fresh justification for a guard that does not
 * cover it.
 */
const BLOCK_MESSAGE_REJECTED = 'BLOCK_MESSAGE_REJECTED' satisfies keyof typeof INVENTORY;

interface UsePostMessageOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  expectedOrigin: string;
  /**
   * Which host owns this bridge. Drives the `host` label on
   * `civitai_app_block_bridge_messages_total` and is REQUIRED so a new host
   * cannot be wired up without deciding what it reports as — an unlabelled host
   * would silently merge into another host's series, and the whole point of the
   * `no_handler` outcome is that it is per-host (a page-only message unhandled on
   * the model slot is the expected state; unhandled on the page host is a bug).
   */
  host: BridgeHost;
  /**
   * The app whose block this bridge serves. Drives the `app_block_id` label,
   * clamped server-side to the approved-app set (unknown -> 'other').
   */
  appBlockId: string;
  /**
   * Test seam for the outcome sink. Defaults to the coalescing beacon. A test
   * passes its own so it can assert on outcomes without a network surface — and
   * so the criterion-2 negative control can read a real counter rather than a
   * mock of one.
   */
  onOutcome?: (event: {
    appBlockId: string;
    type: string;
    host: BridgeHost;
    outcome: BridgeMessageOutcome;
  }) => void;
  /**
   * Opt-in opaque-origin transport for sandboxed frames WITHOUT
   * `allow-same-origin` (unverified/external blocks). Such a frame runs at an
   * opaque origin: `event.origin === 'null'` on everything it sends, and a
   * `postMessage` to it only reaches the frame with `targetOrigin = '*'`.
   *
   * Default `false` → behavior is byte-identical to before this option
   * existed: inbound is pinned to `expectedOrigin`, outbound posts to
   * `expectedOrigin`, and a missing `expectedOrigin` refuses to post.
   *
   * When `true`:
   *   - Inbound accepts `event.origin === 'null'` (the opaque origin) in
   *     addition to a matching `expectedOrigin`. It does NOT accept arbitrary
   *     non-null origins. The `event.source === iframe.contentWindow`
   *     source-window pin (origin-independent) remains the authenticating
   *     guard — origin cannot be pinned for an opaque frame.
   *   - Outbound posts with `targetOrigin = '*'` (the only value a null-origin
   *     recipient accepts). This is safe here: the message is delivered solely
   *     to THIS one host-controlled, sandboxed iframe's `contentWindow`, whose
   *     `src` the host sets — `'*'` is the standard pattern for messaging your
   *     own sandboxed frame, and the only listener is that frame.
   */
  opaqueOrigin?: boolean;
}

interface IncomingMessage {
  type?: string;
  requestId?: string;
  payload?: unknown;
  [key: string]: unknown;
}

interface UsePostMessageResult {
  send: (type: string, payload?: unknown) => void;
  onMessage: <T = unknown>(type: string, handler: (payload: T) => void) => () => void;
  /**
   * REFUSE a request the host cannot serve: send the protocol's error variant for
   * `type` (when one exists) and record the outcome on the bridge counter.
   *
   * 🔴 THIS IS THE `no_token` PATH, AND IT REPLACES A BARE `return`. Ten handlers
   * across the two hosts dropped a request whose block token was falsy with no
   * reply at all, which strands the block's promise for its whole SDK timeout
   * class — up to TEN MINUTES on `OPEN_IMAGE_UPLOAD` / `CREATE_POST_FROM_APP`.
   * The shape of the reply is resolved in one place (`bridgeNackReply.ts`) because
   * it is not uniform: the workflow family needs a `failureSnapshot`, the
   * `{ ok?, error }` family takes a bare `error`, and two types have no sendable
   * failure variant at all.
   *
   * Returns `true` when a reply actually went on the wire, `false` when the
   * protocol has none for this type (the outcome is still counted either way, so a
   * `no_token` that cannot be answered is visible to an operator rather than
   * silent).
   */
  nack: (type: string, requestId: string, message?: string) => boolean;
  /**
   * Record a `no_token` refusal WITHOUT sending anything.
   *
   * 🔴 FOR THE HANDLERS THAT ALREADY REPLY IN THEIR OWN SHAPE. Twelve of the page
   * host's credential-less refusals predate `nack` and send a bespoke error
   * variant — `{ requestId, ok: false, error }` for SAVE_IMAGE, a two-phase
   * `settlement.reply({ error })` for CREATE_POST_FROM_APP, plain
   * `{ requestId, error }` for the buzz self-reads and the app subqueue. Routing
   * those through `nack` would change the payload they send; leaving them alone
   * left the `no_token` SERIES covering 18 of 30 refusal sites while the counter's
   * own help text claims every one of them — a guard reading as coverage while
   * providing none, on exactly the money-adjacent paths (buzz, publish,
   * save-image, create-post).
   *
   * So the counting is separated from the replying: these sites call this, keep
   * their own reply, and the series becomes complete.
   */
  reportNoToken: (type: string) => void;
}

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 30;
const DEDUP_WINDOW_MS = 5000;

/**
 * Separate budget for unsolicited-type NACKs.
 *
 * 🔴 IT IS A SEPARATE ARRAY ON PURPOSE. The unhandled-type branch sits BEFORE the
 * inbound rate limiter, deliberately — a flood of `{type:'GARBAGE'}` must not burn
 * the 30/s budget and lock out legitimate BLOCK_ERROR reporting (the comment on
 * that branch). Answering those messages therefore cannot be bounded by the
 * inbound limiter either, so it gets its own: a block that floods an unhandled
 * REQUEST type gets its first `NACK_BUDGET_MAX` answered and the rest counted but
 * not replied to. Without this the branch is a postMessage amplifier — one inbound
 * message, one outbound reply, unbounded.
 */
const NACK_BUDGET_MAX = 30;

/**
 * L-DEDUP: pull the replay-dedup key out of an incoming message. The SDK
 * transport puts `requestId` inside `payload` (every host handler reads it
 * off `data.payload`), NOT at the top level of the message. The previous
 * implementation read `data.requestId` — always undefined — so the dedup
 * never fired. Read it from `payload.requestId` first, falling back to the
 * top-level shape for forward compatibility. Exported pure so the dedup key
 * resolution is unit-testable without driving the postMessage harness.
 */
export function extractRequestId(data: {
  requestId?: unknown;
  payload?: unknown;
}): string | undefined {
  const fromPayload =
    data.payload &&
    typeof data.payload === 'object' &&
    typeof (data.payload as { requestId?: unknown }).requestId === 'string'
      ? (data.payload as { requestId: string }).requestId
      : undefined;
  if (fromPayload) return fromPayload;
  return typeof data.requestId === 'string' ? data.requestId : undefined;
}

/**
 * Pure origin acceptance check for an inbound message, factored out so the
 * pinned-vs-opaque branch is unit-testable without the postMessage harness.
 *
 *   - Non-opaque (default): accept ONLY when `eventOrigin === expectedOrigin`
 *     and `expectedOrigin` is truthy. Byte-identical to the original guard.
 *   - Opaque mode: ALSO accept the literal opaque origin `'null'` (a sandboxed
 *     frame with no `allow-same-origin`). A matching `expectedOrigin` is still
 *     accepted as a belt; arbitrary non-null origins are still rejected. The
 *     real sender authentication in opaque mode is the `event.source` window
 *     pin enforced by the caller — NOT this origin check.
 */
export function isInboundOriginAccepted(
  eventOrigin: string,
  expectedOrigin: string,
  opaqueOrigin: boolean
): boolean {
  if (opaqueOrigin && eventOrigin === 'null') return true;
  if (!expectedOrigin) return false;
  return eventOrigin === expectedOrigin;
}

/**
 * Pure outbound `targetOrigin` resolution for `send`, factored out so the
 * pinned-vs-opaque branch is unit-testable.
 *
 *   - Opaque mode → `'*'`: the recipient runs at an opaque origin ('null') and
 *     `'*'` is the ONLY targetOrigin that reaches it (a real origin throws
 *     "target origin … does not match recipient origin 'null'"). Safe because
 *     the message is delivered solely to the one host-controlled sandboxed
 *     iframe's contentWindow (the caller still pins the recipient window).
 *   - Pinned mode with a truthy `expectedOrigin` → that origin (byte-identical
 *     to the original behavior).
 *   - Pinned mode with no `expectedOrigin` → `null` ("refuse to post"): the
 *     original code returned early rather than fall back to `'*'`.
 */
export function resolveOutboundTargetOrigin(
  expectedOrigin: string,
  opaqueOrigin: boolean
): string | null {
  if (opaqueOrigin) return '*';
  if (!expectedOrigin) return null;
  return expectedOrigin;
}

/**
 * Typed postMessage send/receive with security rails:
 *   - Drops messages from origins other than `expectedOrigin` (or the opaque
 *     `'null'` origin when `opaqueOrigin` is set — see UsePostMessageOptions)
 *   - Pins the sender to OUR iframe's `contentWindow` (the authenticating
 *     guard, origin-independent — the only sender check in opaque mode)
 *   - Deduplicates by `requestId` inside a 5-second window
 *   - Rate-limits incoming messages to 30/sec (excess is dropped)
 *
 * …and, since the bridge-telemetry change:
 *   - COUNTS every inbound message's outcome on
 *     `civitai_app_block_bridge_messages_total{app_block_id,type,host,outcome}`,
 *     so the four drop paths above stop being indistinguishable from each other
 *     and from a merely slow host;
 *   - NACKs an unhandled REQUEST-style message instead of returning silently, so
 *     a block gets an error in milliseconds instead of hanging to a 30s / 120s /
 *     600s SDK timeout;
 *   - translates the block's own `BLOCK_MESSAGE_REJECTED` into
 *     `outcome="validator_rejected"`. That is the FIFTH drop path and the only one
 *     no code here can observe: the SDK's validator runs in the iframe AFTER this
 *     host has replied, so the same exchange is already counted `handled`. The
 *     block is the only witness, so it reports and we count.
 *
 * 🔴 EVERY DROP PATH MUST REPORT. A branch added here that `return`s without a
 * `report(...)` re-creates the exact silence this module was instrumented to
 * remove, and it will look fine in review because the counter still exists.
 * `usePostMessageOutcomes.browser.test.tsx` pins the outcome for each dispatcher
 * path, driving the real hook.
 */
export function usePostMessage(opts: UsePostMessageOptions): UsePostMessageResult {
  const {
    iframeRef,
    expectedOrigin,
    opaqueOrigin = false,
    host,
    appBlockId,
    onOutcome = recordBridgeMessage,
  } = opts;
  const handlersRef = useRef<Map<string, Set<(payload: unknown) => void>>>(new Map());
  const recentTimestampsRef = useRef<number[]>([]);
  const seenRequestIdsRef = useRef<Map<string, number>>(new Map());
  const nackTimestampsRef = useRef<number[]>([]);

  /**
   * The single outbound primitive. `send` and the NACK paths both go through it so
   * the opaque-origin / missing-origin rules are stated once — a NACK posted with
   * the wrong `targetOrigin` would throw inside a message listener rather than
   * reach the block, i.e. the fix would break the transport it was meant to unblock.
   */
  const postToBlock = useCallback(
    (type: string, payload?: unknown) => {
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) return;
      const targetOrigin = resolveOutboundTargetOrigin(expectedOrigin, opaqueOrigin);
      if (targetOrigin === null) return; // pinned mode, no origin: refuse to post
      iframe.contentWindow.postMessage({ type, payload }, targetOrigin);
    },
    [iframeRef, expectedOrigin, opaqueOrigin]
  );

  /**
   * Fail-soft outcome emit. Telemetry must never be able to break the bridge it
   * observes — a throwing sink here would propagate out of the `message` listener
   * and abort dispatch for that message, turning an observability feature into the
   * exact silent drop it exists to remove.
   */
  const report = useCallback(
    (type: string, outcome: BridgeMessageOutcome) => {
      try {
        onOutcome({ appBlockId, type, host, outcome });
      } catch {
        // swallow — observability must not affect the bridge
      }
    },
    [onOutcome, appBlockId, host]
  );

  const reportNoToken = useCallback(
    (type: string) => {
      report(type, 'no_token');
    },
    [report]
  );

  const nack = useCallback(
    (type: string, requestId: string, message: string = BRIDGE_NACK_NO_TOKEN) => {
      report(type, 'no_token');
      const reply = buildBridgeNackReply(type, requestId, message);
      if (!reply) return false;
      postToBlock(reply.type, reply.payload);
      return true;
    },
    [report, postToBlock]
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Origin acceptance: pinned to `expectedOrigin` by default; in
      // opaqueOrigin mode the sandboxed (no allow-same-origin) frame's
      // `'null'` origin is accepted too. A missing expectedOrigin in non-opaque
      // mode still drops everything (misconfigured iframe.src). The
      // event.source window pin below is the authenticating guard either way.
      if (!isInboundOriginAccepted(event.origin, expectedOrigin, opaqueOrigin)) return;
      // event.source check: origin alone is spoofable across same-origin iframes
      // (two installs from the same publisher on one page can postMessage at
      // each other and forge a BLOCK_ERROR/BLOCK_READY for a sibling). The
      // window-identity check pins us to OUR iframe specifically. See PR audit C6.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as IncomingMessage | null;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

      const now = Date.now();

      // ── The one drop path this host cannot observe, reported by the block ────
      // The block's transport refused one of OUR replies at its own trust boundary
      // and dropped it, so its request is now hanging to the SDK timeout. We cannot
      // see that: the SDK's validator runs in the iframe AFTER we replied, so from
      // here the exchange completed and the `handled` below already counted it.
      // `BLOCK_MESSAGE_REJECTED` is the block telling us. Why the label is the
      // REQUEST and not the rejected reply, how to read the series, and what this
      // does NOT cover are all in `bridgeLabels.ts` — stated once, there, because an
      // earlier revision of this block restated them here and the copy had already
      // drifted from the original inside this very commit.
      //
      // 🔴 THE LABEL IS CLAMPED HERE, AT THE EXTRACTION SITE, NOT LEFT TO THE SINK.
      // The other `report(...)` callers pass `data.type` and let
      // `recordBridgeMessage` clamp on the way out; that is not enough for a value
      // pulled out of an untrusted payload, because `onOutcome` is a seam — every
      // browser test in `usePostMessageOutcomes.browser.test.tsx` supplies its own
      // sink, and with the clamp downstream one of them observed the raw
      // `NOT_A_REAL_MESSAGE`. Clamping here makes the value this branch emits the
      // value that lands in the series, whatever the sink; the default sink clamps
      // again, idempotently.
      //
      // 🔴 EXACTLY ONE INCREMENT, AND NOT `handled` — returning here keeps the report
      // out of the denominator, or one rejection moves two series by one and every
      // ratio read against `handled` goes quietly wrong. ABOVE the limiter and the
      // dedup map, for the same reason the `no_handler` branch is: a flood of junk
      // must not burn the budget legitimate BLOCK_ERROR reporting needs. Dedup would
      // also be wrong — these carry no `requestId`, and two rejections are two facts.
      if (data.type === BLOCK_MESSAGE_REJECTED) {
        const rejected = (data.payload as { type?: unknown } | null | undefined)?.type;
        report(
          boundBridgeMessageType(typeof rejected === 'string' ? rejected : ''),
          'validator_rejected'
        );
        return;
      }

      // Subscriber lookup before rate-limit/dedup budget consumption. A flood
      // of {type:'GARBAGE'} with no handler shouldn't burn the 30/s budget and
      // lock out legitimate BLOCK_ERROR reporting.
      const subscribers = handlersRef.current.get(data.type);
      if (!subscribers || subscribers.size === 0) {
        report(data.type, 'no_handler');
        // NACK: a REQUEST-style message with no handler is the expensive silence
        // — the block awaits a reply that will never come and hangs to its SDK
        // timeout class (30s default, 120s workflow, 600s human-in-the-loop).
        // `buildBridgeNackReply` returns null for a fire-and-forget type (nothing
        // is awaiting), an unknown type, and the two types whose failure reply the
        // SDK validator would drop — so this cannot put junk on the wire.
        const unhandledRequestId = extractRequestId(data);
        if (typeof unhandledRequestId === 'string') {
          const nackWindow = nackTimestampsRef.current.filter(
            (t) => now - t < RATE_LIMIT_WINDOW_MS
          );
          if (nackWindow.length < NACK_BUDGET_MAX) {
            const reply = buildBridgeNackReply(
              data.type,
              unhandledRequestId,
              BRIDGE_NACK_NO_HANDLER
            );
            if (reply) {
              nackWindow.push(now);
              postToBlock(reply.type, reply.payload);
            }
          }
          nackTimestampsRef.current = nackWindow;
        }
        return;
      }

      // L-DEDUP: read the requestId from where the SDK actually puts it
      // (inside `payload`), not the always-undefined top-level `requestId`.
      const payloadRequestId = extractRequestId(data);
      if (typeof payloadRequestId === 'string') {
        const seenAt = seenRequestIdsRef.current.get(payloadRequestId);
        if (seenAt != null && now - seenAt < DEDUP_WINDOW_MS) {
          report(data.type, 'deduped');
          return;
        }
        // Cap the dedup map so a flood of unique requestIds can't grow it.
        if (seenRequestIdsRef.current.size >= 256) {
          const oldestKey = seenRequestIdsRef.current.keys().next().value;
          if (oldestKey != null) seenRequestIdsRef.current.delete(oldestKey);
        }
        seenRequestIdsRef.current.set(payloadRequestId, now);
        // GC stale entries
        for (const [k, v] of seenRequestIdsRef.current.entries()) {
          if (now - v >= DEDUP_WINDOW_MS) seenRequestIdsRef.current.delete(k);
        }
      }

      // Note: do NOT name this local `window` — it would shadow the global
      // and any future `window.*` reference inside this closure would bind
      // to the array instead. M-8 from the PR audit.
      const recentWindow = recentTimestampsRef.current.filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS
      );
      if (recentWindow.length >= RATE_LIMIT_MAX_MESSAGES) {
        report(data.type, 'rate_limited');
        // eslint-disable-next-line no-console
        console.warn('[AppBlocks] postMessage rate limit exceeded; dropping message');
        return;
      }
      recentWindow.push(now);
      recentTimestampsRef.current = recentWindow;

      report(data.type, 'handled');
      for (const handler of subscribers) handler(data.payload);
    },
    [expectedOrigin, iframeRef, opaqueOrigin, report, postToBlock]
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  const send = postToBlock;

  const onMessage = useCallback(<T = unknown>(type: string, handler: (payload: T) => void) => {
    const bag = handlersRef.current.get(type) ?? new Set<(payload: unknown) => void>();
    const cast = handler as (payload: unknown) => void;
    bag.add(cast);
    handlersRef.current.set(type, bag);
    return () => {
      const current = handlersRef.current.get(type);
      if (!current) return;
      current.delete(cast);
      if (current.size === 0) handlersRef.current.delete(type);
    };
  }, []);

  return { send, onMessage, nack, reportNoToken };
}
