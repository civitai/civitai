import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { createSilenceCheckTypeAges } from '~/server/notifications/silence-check';
import { silenceCheckTypes } from '~/server/notifications/utils.notifications';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const silenceCheckTypeAges = createSilenceCheckTypeAges({
  query: (types) =>
    dbRead.$queryRaw<{ type: string; firstSeen: Date }[]>(Prisma.sql`
      SELECT "type", min("disabledAt") AS "firstSeen"
      FROM "UserNotificationSettings"
      WHERE "type" IN (${Prisma.join(types)})
      GROUP BY "type"
    `),
});

// Read by the Knights app's notification job (same `x-webhook-token` as its rating write-back) to
// recognise users who turned every notification off: each opt-out type with when it was first switched
// off. Internal; not part of the public API.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({ types: await silenceCheckTypeAges(silenceCheckTypes) });
});
