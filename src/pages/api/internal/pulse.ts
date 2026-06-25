import { isDev } from '~/env/other';
import { Tracker } from '~/server/clickhouse/client';
import { addViewSchema } from '~/server/schema/track.schema';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

// Lightweight beacon endpoint for view tracking. Replaces the `track.addView`
// tRPC mutation for the browser <TrackView> component (~71 req/s, the #1
// request-count source on api-primary). The tRPC procedure paid the full
// non-batched middleware chain (recordProcedureDuration -> isAcceptableOrigin
// -> enforceClientVersion -> applyDomainFeature[Flipt] -> enforceTokenScope) +
// superjson encode per call for an empty, fire-and-forget response. This route
// runs none of that — it resolves session/ip/userAgent via the same Tracker and
// fires the identical `views` ClickHouse insert, so the analytics payload shape
// and volume are unchanged.
//
// Deliberately named generically (NOT "track"/"view"): ad/privacy blockers
// (EasyPrivacy, uBlock) match those keywords in the request path and cancel the
// request client-side with ERR_BLOCKED_BY_CLIENT before it reaches the origin,
// silently dropping views. The client caller lives in
// src/components/TrackView/TrackView.tsx.
//
// Same-origin only: validated by referer/origin host == request host, matching
// the sibling /api/internal/ping beacon. The browser <TrackView> is always
// cookie-authenticated; bearer/API-key callers keep using the tRPC
// `track.addView` procedure (which still enforces UserWrite scope).
export default PublicEndpoint(
  async (req, res) => {
    if (isDev) return res.status(200).end();

    // Same-origin guard (mirrors /api/internal/ping). Origin preferred, referer
    // fallback for clients that suppress Origin.
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

    // Next's body parser already deserializes an `application/json` request body
    // into an object (the <TrackView> client sends that Content-Type), but a
    // client that omits Content-Type (text/plain) leaves it a raw string. Handle
    // BOTH — JSON.parse(<object>) would throw ("[object Object]") and 400 every
    // real browser beacon. (The /api/internal/ping sibling only does JSON.parse
    // because ITS client sends no Content-Type.)
    let parsed: unknown;
    try {
      parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send('invalid body');
    }

    const result = addViewSchema.safeParse(parsed);
    if (!result.success) return res.status(400).send('invalid input');

    const tracker = new Tracker(req, res);
    // Fire-and-forget: view() resolves the session, builds the actor, and
    // dispatches the ClickHouse insert without awaiting the network round-trip
    // (same as the tRPC resolver). We don't await it.
    void tracker.view(result.data);

    return res.status(200).end();
  },
  ['POST']
);
