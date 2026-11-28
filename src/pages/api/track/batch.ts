import { readSessionToken } from '@civitai/auth';
import { isDev } from '~/env/other';
import { beginBeaconGoShadow } from '~/server/beacon/beacon-go-shadow';
import { Tracker, trackerSends } from '~/server/clickhouse/client';
import { awardViewPoints, hattedImpressionEntities } from '~/server/events/points/hooks';
import { parseTrackBatch } from '~/server/schema/track.schema';
import { feedEventsRecorder } from '~/server/services/feed-events.service';
import type { FeedEventViewer } from '~/server/services/feed-events.service';
import { isPersonalHotLeadViewer } from '~/server/services/personal-hot-lead.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
/** What the handler reads from outside the request: the beacon-go shadow sampler. The route uses the
 * real one; a test passes its own. */
export type TrackBatchHandlerDeps = {
  beginShadow: typeof beginBeaconGoShadow;
};

const trackBatchHandlerDeps: TrackBatchHandlerDeps = { beginShadow: beginBeaconGoShadow };

export function createTrackBatchHandler(
  deps: TrackBatchHandlerDeps = trackBatchHandlerDeps
): Parameters<typeof PublicEndpoint>[0] {
  return async function handler(req, res) {
    if (isDev) return res.status(200).end();
    // beacon-go shadow (flag `beacon-go-shadow` AND BEACON_GO_SHADOW_TRACK_BATCH_SAMPLE_RATE > 0, both
    // off by default): a sampled request's response, its search / action / impression rows, its feed
    // event rows and its hatted view count are mirrored to apps/beacon-go after the response, which
    // only compares them and writes nothing. Never throws, never awaited.
    const shadow = deps.beginShadow(req, res, 'track-batch', trackerSends);

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

    // Bounded array, each event parsed on its own: a malformed event is dropped and the rest are
    // kept. 400 only when the envelope is invalid or nothing survives.
    const events = parseTrackBatch(parsed);
    if (!events) return res.status(400).send('invalid input');

    // One Tracker for the whole batch → the session/actor (userId/ip/userAgent) is
    // resolved ONCE and reused for every event, identical to how a single tRPC
    // request would have stamped them. Events are dispatched in array order,
    // preserving the client's emit order.
    const tracker = new Tracker(req, res);
    shadow?.attach(tracker);
    let feedViewer: Promise<FeedEventViewer | null> | undefined;
    for (const event of events) {
      if (event.kind === 'search') {
        // Fire-and-forget: dispatches the insert without awaiting the round-trip,
        // exactly as the tRPC resolver (`ctx.track.search(input)`) did.
        const searched = tracker.search(event.data);
        // A sampled request's mirror waits for the row (search and action are what beacon-go writes).
        shadow?.waitFor(searched);
      } else if (event.kind === 'impression') {
        // One event, many rows — the array is expanded into a single batched
        // insert by Tracker.impressions.
        const impressed = tracker.impressions(event.data);
        shadow?.waitFor(impressed);
      } else if (event.kind === 'feed') {
        // The viewer comes from the session, never the payload: resolved once per batch, and only
        // for a sampled session. A failed lookup drops the event rather than recording it as signed
        // out; an unreachable hub resolves to no session, so a session cookie without one drops too.
        const getViewer = () =>
          (feedViewer ??= tracker
            .getSession()
            .then(async (session) => {
              if (!tracker.isSessionResolved) return null;
              if (!session && readSessionToken(req.cookies, { host: req.headers.host }))
                return null;
              const user = session?.user;
              return {
                userId: user?.id ?? 0,
                memberType: user?.tier ?? 'undefined',
                personalHotLead: user ? await isPersonalHotLeadViewer(user) : null,
              };
            })
            .catch(() => null));
        const recorded = feedEventsRecorder().record(
          event.data,
          getViewer,
          shadow ? (row) => shadow.capture('feedEvents', row) : undefined
        );
        shadow?.waitFor(recorded);
      } else {
        const acted = tracker.action(event.data);
        shadow?.waitFor(acted);
      }
    }

    // Event points for views of hatted content. The in-memory hat check is all a batch without
    // hatted content pays; the session is only resolved (and shared with the Tracker) past it, and
    // signed-out viewers earn nothing.
    const hatted = hattedImpressionEntities(events);
    shadow?.hattedViews(hatted.length);
    if (hatted.length)
      void awardViewPoints(() => tracker.getSession({ scope: TokenScope.UserWrite }), hatted);

    return res.status(200).end();
  };
}

/**
 * @ported-to-go beacon-go · status: shadow · see ports/manifest.json (id: POST /api/track/batch).
 * Changing this behaviour? Update apps/beacon-go/internal/server/server.go, apps/beacon-go/internal/beacon/trackbatch.go, apps/beacon-go/internal/beacon/trackbatch_sinks.go in the same PR; CI lists every port a PR touches.
 * Generated by `node scripts/ports/generate.mjs` from ports/manifest.json: edit the manifest, not this block.
 */
export default PublicEndpoint(createTrackBatchHandler(), ['POST']);
