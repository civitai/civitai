import * as z from 'zod';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { applySourceMaps } from '~/server/utils/errorHandling';

const schema = z.object({ message: z.string(), stack: z.string(), name: z.string().optional() });

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      const queryInput = schema.parse(JSON.parse(req.body));
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
