import { Prisma } from '@prisma/client';
import { NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const CONCURRENCY_LIMIT = 10;
export default WebhookEndpoint(async (req, res) => {
  // TODO.nsfwLevel
  res.status(200).json({ finished: true });
});

async function migrateImages(res: NextApiResponse) {
  return;
}
