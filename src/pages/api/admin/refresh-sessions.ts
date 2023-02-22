import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import z from 'zod';
import { invalidateAllSessions } from '~/server/utils/session-helpers';

const refreshSessionsSchema = z.object({
  asOf: z.preprocess((v) => (v ? new Date(String(v)) : undefined), z.date().optional()).optional(),
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
