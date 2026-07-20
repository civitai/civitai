import { isDev } from '~/env/other';
import { Tracker } from '~/server/clickhouse/client';
import { trackBatchSchema } from '~/server/schema/track.schema';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

// Coalesced telemetry beacon — receives a BATCH of `trackSearch` / `addAction`
// events buffered by the browser (see src/components/TrackView/trackEventBuffer.ts)
// and dispatches each through the SAME Tracker.search()/Tracker.action() the tRPC
// `track.trackSearch`/`track.addAction` procedures used, producing byte-identical
// ClickHouse inserts. What changes is ONLY the transport: instead of ~23
// telemetry tRPC procedures/s (each paying the full non-batched middleware chain +
// superjson encode + insert), the browser flushes coalesced batches to this one
// route, which runs none of that chain and resolves the session ONCE per batch
// (the Tracker memoizes it across all events in the request).
//
// Mirrors the established beacon pattern (/api/internal/pulse for addView #2680,
// /api/track/block-render): PublicEndpoint, POST-only, dev short-circuit,
// same-origin guard, tolerant body parse, bounded schema validation, then
// fire-and-forget dispatch. The browser <useTrackEvent> is always cookie-
// authenticated; bearer/API-key callers keep using the tRPC `track.*` procedures
// (which still enforce the UserWrite scope).
//
// Deliberately named generically (NOT "search"/"action") so ad/privacy blockers
// don't cancel the beacon client-side with ERR_BLOCKED_BY_CLIENT.
export default PublicEndpoint(
  async (req, res) => {
    if (isDev) return res.status(200).end();

    // Same-origin guard (mirrors /api/internal/pulse + /api/track/block-render).
    // Origin preferred, referer fallback for clients that suppress Origin.
    const source = req.headers.origin ?? req.headers.referer;
    const sourceHost = source
      ? (() => {
          try {
            return new URL(source).host;
          } catch {
            return undefined;
          }
        })()
      : undefined;
    if (!sourceHost || sourceHost !== req.headers.host)
      return res.status(400).send('invalid request');

    // Next's body parser deserializes an `application/json` body into an object
    // (both the fetch flush and the sendBeacon Blob set that Content-Type), but a
    // Content-Type-less (text/plain) client leaves it a raw string. Handle BOTH —
    // JSON.parse(<object>) would throw and 400 every real browser beacon (see the
    // #2680 pulse.ts fix).
    let parsed: unknown;
    try {
      parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send('invalid body');
    }

    // Validates the bounded array + each event's discriminated shape. A single
    // malformed event rejects the whole batch (the client only ever sends
    // well-formed, schema-typed events; a 400 here means a tampered/oversized body).
    const result = trackBatchSchema.safeParse(parsed);
    if (!result.success) return res.status(400).send('invalid input');

    // One Tracker for the whole batch → the session/actor (userId/ip/userAgent) is
    // resolved ONCE and reused for every event, identical to how a single tRPC
    // request would have stamped them. Events are dispatched in array order,
    // preserving the client's emit order.
    const tracker = new Tracker(req, res);
    for (const event of result.data) {
      if (event.kind === 'search') {
        // Fire-and-forget: dispatches the insert without awaiting the round-trip,
        // exactly as the tRPC resolver (`ctx.track.search(input)`) did.
        void tracker.search(event.data);
      } else {
        void tracker.action(event.data);
      }
    }

    return res.status(200).end();
  },
  ['POST']
);
