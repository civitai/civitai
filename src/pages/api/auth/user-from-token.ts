import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { dbRead } from '~/server/db/client';
import { readToken } from '~/server/integrations/integration-token';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  token: z.string(),
});
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).send(result.error.message);

  let userId: number | undefined;
  try {
    userId = readToken(result.data.token);
  } catch (error) {
    return res.status(403).send('Invalid token');
  }

  const [user] = await dbRead.$queryRawUnsafe<
    { id: number; username: string; email: string; tier: string }[]
  >(`
    SELECT
      u.id,
      u.username,
      u.email,
      (
        SELECT
        p.metadata->>'${env.STRIPE_METADATA_KEY}'
        FROM "CustomerSubscription" s
        JOIN "Product" p ON p.id = s."productId"
        WHERE s."userId" = u.id AND s.status IN ('active', 'trialing')
      ) as tier
    FROM "User" u
    WHERE u.id = ${userId}
  `);
  if (!user) return res.status(403).send('Invalid user');

  return res.send(user);
});
