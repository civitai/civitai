import * as z from 'zod';
import { isDev, isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { isSameOriginBeacon } from '~/server/utils/beacon-same-origin';

/**
 * Exported so callers can be TESTED against the real contract rather than a copy of it. `message`
 * and `stack` are REQUIRED strings: a caller that lets either go `undefined` has the key dropped by
 * `JSON.stringify`, `parse` throws, and this endpoint answers 400 — a silently lost report, since
 * `fetch` does not reject on a 4xx.
 */
export const applicationErrorSchema = z.object({
  message: z.string(),
  stack: z.string(),
  name: z.string().optional(),
});

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      // Same-origin guard, FIRST — ahead of the session read and the body parse, so a rejected caller sheds that work rather than only changing a status code.
      //
      // This endpoint is unauthenticated and `PublicEndpoint` applies no bound of its own. What it
      // produces is not a response but an operational SIGNAL — the volume of accepted reports is
      // what says the front end is broken — so a caller that is not one of our own pages should not
      // be able to contribute to it. `isSameOriginBeacon` is the guard the sibling telemetry
      // beacons already use; see that module for what it does and does not assert.
      //
      // WHY THE SHORT-CIRCUIT IS SCOPED TO THE GUARD and not, as in the siblings, to the whole
      // handler: their dev branch exists to skip an analytics write, and returning 200 immediately
      // costs them nothing. Here it would also skip the schema parse, so a malformed body would
      // answer 200 in dev and 400 in production — turning the one environment where a caller's
      // mistake is cheap to find into the one that hides it. The observable dev property is the
      // same either way: the guard rejects nothing locally.
      if (!isDev && !isSameOriginBeacon(req))
        return res.status(400).send({ message: 'invalid request' });

      const session = await getServerAuthSession({ req, res, scope: 'defer' });
      const queryInput = applicationErrorSchema.parse(JSON.parse(req.body));
      if (isProd) {
        const payload = {
          name: queryInput.name ?? 'application-error',
          type: 'error',
          url: req.headers.referer,
          userId: session?.user?.id,
          browser: req.headers['user-agent'],
          message: queryInput.message,
          stack: queryInput.stack,
        };
        logToAxiom(payload);
      }
      return res.status(200).end();
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['POST']
);
