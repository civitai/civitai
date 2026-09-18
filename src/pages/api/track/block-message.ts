import { isDev } from '~/env/other';
import { boundBridgeMessageType } from '~/components/AppBlocks/bridgeTelemetry';
import { ensureRegisterAppBlockRuntimeMetrics } from '~/server/metrics/app-block-runtime.metrics';
import { boundAppBlockIdLabel } from '~/server/services/blocks/known-app-blocks.service';
import { blockMessageBatchSchema } from '~/server/schema/track.schema';
import { isSameOriginBeacon } from '~/server/utils/beacon-same-origin';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

// App Blocks postMessage BRIDGE message-outcome beacon.
//
// Receives the browser-side COALESCED counts from
// `~/components/AppBlocks/bridgeMessageBeacon` and increments
// `civitai_app_block_bridge_messages_total{app_block_id,type,host,outcome}`.
//
// Mirrors the established beacon pattern (/api/internal/pulse, /api/track/view,
// /api/track/block-render, /api/track/batch): PublicEndpoint, POST-only, dev
// short-circuit, same-origin guard, tolerant body parse, bounded schema, then
// fire-and-forget. Deliberately named generically (NOT "bridge"/"message") so
// ad/privacy blockers don't cancel it client-side with ERR_BLOCKED_BY_CLIENT.
//
// 🔴 PROM ONLY — NO ClickHouse insert, and therefore no session resolve. The
// bridge produces orders of magnitude more events than the render beacon (its own
// inbound limit is 30/sec/host), the questions it answers are rate questions, and
// a per-message CH row would be a new high-volume table for no analytical gain.
// That also means this route never touches the `blockRenders` impression series —
// an observability add-on must not be able to corrupt an analytics series.
//
// 🔴 THE TWO LABEL BOUNDS ARE THE SECURITY PROPERTY OF THIS ROUTE, because the
// body is client-supplied and the route is unauthenticated:
//   - `type`         -> `boundBridgeMessageType` against the code-owned protocol
//                       INVENTORY (`hostHandlerParity.ts`), unknown -> 'other';
//   - `app_block_id` -> `boundAppBlockIdLabel` against the TTL-cached approved-app
//                       set, unknown -> 'other' (no per-request DB hit).
// `host` and `outcome` are zod enums on the body, built from the emitter's own
// const arrays (`bridgeLabels.ts`), so they are bounded before they reach here.
// prom-client retains every distinct label set in the Node heap forever, so an
// unbounded label here is an OOM (exit-139) vector, not a tidiness issue.
//
// 🔴 BOUNDED IS NOT THE SAME AS SMALL — READ THE PRODUCT BEFORE ADDING A LABEL.
// The domain is (approved apps + 1) x 47 x 2 x 5: ~24k series per pod at 50
// approved apps, roughly 7x the existing `renders_total` product and the largest
// App Block label set in the module. It is bounded, and CARDINALITY is the property
// this route enforces — that is the prom-heap axis, and it is genuinely closed. So
// a fifth label is not a free addition, and neither is a laxer clamp.
//
// 🔴 MAGNITUDE IS NOT BOUNDED HERE, AND NO CONSTANT IN THIS FILE CAN BOUND IT.
// Nothing enforces row uniqueness, so one body may repeat a label set:
// `BRIDGE_MESSAGE_COUNT_MAX` caps a single ROW, never a series. Read the counter's
// VALUES accordingly, and do not read either constant as a control on volume — a
// rate limit is that control, and no /api/track/* beacon has one. Both clamps are
// written as hard ceilings because they keep one malformed row from rejecting a
// whole batch, which is a different job.
export default PublicEndpoint(
  async (req, res) => {
    if (isDev) return res.status(200).end();

    // Same-origin guard. The THREE sibling beacons (/api/internal/pulse,
    // /api/track/view, /api/track/block-render) still open-code this predicate;
    // `beacon-same-origin.ts` was extracted so it would stop being copied, and it
    // carries the one test suite for it — so a new beacon uses the helper rather
    // than becoming a fifth spelling. Read that module for what it does and does
    // NOT assert: it is a CSRF-shaped control, never an authentication boundary.
    if (!isSameOriginBeacon(req)) return res.status(400).send('invalid request');

    // Next's body parser deserializes an `application/json` body into an object
    // (both the sendBeacon Blob and the keepalive fetch set that Content-Type),
    // but a Content-Type-less (text/plain) client leaves it a raw string. Handle
    // BOTH — JSON.parse(<object>) would throw and 400 every real browser beacon
    // (the #2680 view.ts fix).
    let parsed: unknown;
    try {
      parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send('invalid body');
    }

    const result = blockMessageBatchSchema.safeParse(parsed);
    if (!result.success) return res.status(400).send('invalid input');

    try {
      const { bridgeMessagesTotal } = ensureRegisterAppBlockRuntimeMetrics();
      // One approved-set lookup per DISTINCT app in the batch, not per row. The
      // lookup is TTL-cached in memory, so this is a Map hit either way — the
      // dedupe is here so a 200-row batch cannot turn into 200 awaits in a loop.
      const labelCache = new Map<string, string>();
      for (const event of result.data.events) {
        let appBlockIdLabel = labelCache.get(event.appBlockId);
        if (appBlockIdLabel === undefined) {
          appBlockIdLabel = await boundAppBlockIdLabel(event.appBlockId);
          labelCache.set(event.appBlockId, appBlockIdLabel);
        }
        bridgeMessagesTotal.inc(
          {
            app_block_id: appBlockIdLabel,
            type: boundBridgeMessageType(event.type),
            host: event.host,
            outcome: event.outcome,
          },
          event.count
        );
      }
    } catch {
      // swallow — observability must not affect the response
    }

    return res.status(200).end();
  },
  ['POST']
);
