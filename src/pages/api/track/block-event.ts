import { isDev } from '~/env/other';
import { blockEventBatchSchema } from '~/server/schema/track.schema';
import { ingestBlockEvents } from '~/server/services/blocks/block-event-ingest.service';
import { isSameOriginBeacon } from '~/server/utils/beacon-same-origin';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

// App Blocks custom-events beacon: one row per `track()` call a block makes.
//
// Public and unauthenticated like its sibling beacons, so anyone can post events for any approved
// app. What bounds that is in `ingestBlockEvents`: only events and properties the app's approved
// manifest declares are stored, identity is taken from the session only, and each client address
// has a per-app budget.
//
// Always answers 200 once the body is well-formed: a beacon has no reader, and a write failure
// must not surface to the page.
export default PublicEndpoint(
  async (req, res) => {
    if (isDev) return res.status(200).end();

    if (!isSameOriginBeacon(req)) return res.status(400).send('invalid request');

    // An `application/json` body arrives parsed; any other content type arrives as a string.
    let parsed: unknown;
    try {
      parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send('invalid body');
    }

    const result = blockEventBatchSchema.safeParse(parsed);
    if (!result.success) return res.status(400).send('invalid input');

    try {
      await ingestBlockEvents({ events: result.data.events, req, res });
    } catch {
      // swallow: telemetry must not affect the response
    }

    return res.status(200).end();
  },
  ['POST']
);

// A full batch is tens of kilobytes. The default limit is 1 MB, parsed before any check here runs.
export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };
