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
// Same-origin only: validated by referer/origin host == request host, matching
// the sibling /api/page-view beacon. The browser <TrackView> is always
// cookie-authenticated; bearer/API-key callers keep using the tRPC
// `track.addView` procedure (which still enforces UserWrite scope).
export default PublicEndpoint(
  async (req, res) => {
    if (isDev) return res.status(200).end();

    // Same-origin guard (mirrors /api/page-view). Origin preferred, referer
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

    let parsed;
    try {
      parsed = JSON.parse(req.body);
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
