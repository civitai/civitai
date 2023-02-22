import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import z from 'zod';
import { redis } from '~/server/redis/client';
import { invalidateAllSessions } from '~/server/utils/session-helpers';

const refreshSessionsSchema = z.object({
  asOf: z.preprocess((v) => new Date(v), z.date()).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const result = refreshSessionsSchema.safeParse(req.query);
  if (!result.success) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }

  const { asOf } = result.data;
  await invalidateAllSessions(asOf);

  res.status(200).json({ ok: true, asOf });
});
