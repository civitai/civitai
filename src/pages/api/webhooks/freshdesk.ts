import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { freshdeskWebhookPayloadSchema } from '~/server/http/freshdesk/freshdesk.schema';
import { processFreshdeskAgent } from '~/server/freshdesk-agent/freshdesk-agent';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';

const DEDUP_TTL_SECONDS = 600; // 10 minutes

const log = (data: Record<string, unknown>) =>
  logToAxiom({ name: 'freshdesk-webhook', ...data }, 'webhooks').catch(() => null);

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse and validate payload
  const parsed = freshdeskWebhookPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    await log({ type: 'validation-error', errors: parsed.error.flatten() });
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const payload = parsed.data;
  await log({ type: 'received', ticket_id: payload.ticket_id, phase: payload.phase });

  // Dedup check using Redis SET with NX + TTL
  const dedupKey =
    `${REDIS_SYS_KEYS.JOB}:freshdesk-agent:${payload.ticket_id}:${payload.phase}` as const;
  const isNew = await sysRedis.set(dedupKey, '1', { NX: true, EX: DEDUP_TTL_SECONDS });

  if (!isNew) {
    await log({ type: 'dedup-skip', ticket_id: payload.ticket_id, phase: payload.phase });
    return res.status(200).json({ status: 'already_processing' });
  }

  // Return 200 immediately, process in background
  res.status(200).json({ status: 'accepted' });

  // Fire-and-forget: process the agent loop
  processFreshdeskAgent(payload).catch((err) =>
    log({
      type: 'unhandled-error',
      ticket_id: payload.ticket_id,
      phase: payload.phase,
      message: err instanceof Error ? err.message : String(err),
    })
  );
});
