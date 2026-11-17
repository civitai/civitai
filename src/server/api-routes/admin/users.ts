import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getUsersByIds } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  ids: commaDelimitedNumberArray(),
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const query = result.data;
  const users = await getUsersByIds(query.ids);

  return res.status(200).json(users);
});
