import * as z from 'zod';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { applySourceMaps } from '~/server/utils/errorHandling';

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
      const session = await getServerAuthSession({ req, res });
      const queryInput = applicationErrorSchema.parse(JSON.parse(req.body));
      if (isProd) {
        const payload = {
          name: queryInput.name ?? 'application-error',
          type: 'error',
          url: req.headers.referer,
          userId: session?.user?.id,
          browser: req.headers['user-agent'],
          message: queryInput.message,
          // this won't work in dev
          stack: await applySourceMaps(queryInput.stack),
        };
        await logToAxiom(payload);
      }
      return res.status(200).end();
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['POST']
);
