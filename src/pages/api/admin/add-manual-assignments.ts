import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { addManualAssignments } from '~/server/events/base.event';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

const schema = z.object({
  event: z.string(),
  team: z.string(),
  users: commaDelimitedStringArray(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { event, users, team } = schema.parse(req.query);

  await addManualAssignments(event, team, users);

  return res.status(200).json({
    ok: true,
  });
});
