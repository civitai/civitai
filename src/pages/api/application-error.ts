import { z } from 'zod';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

const schema = z.object({ message: z.string(), stack: z.string() });

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      const queryInput = schema.parse(JSON.parse(req.body));
      if (isProd) {
        const payload = {
          name: 'application-error',
          type: 'error',
          url: req.headers.referer,
          userId: session?.user?.id,
          browser: req.headers['user-agent'],
          ...queryInput,
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
