import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { freshdeskWebhookPayloadSchema } from '~/server/http/freshdesk/freshdesk.schema';
import { processFreshdeskAgent } from '~/server/freshdesk-agent/freshdesk-agent';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { isDev } from '~/env/other';
import {
  setDebugContext,
  clearDebugContext,
  agentLog,
} from '~/server/freshdesk-agent/freshdesk-debug';

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

  // Debug/dry-run mode (dev only, per-request via headers)
  const debug = isDev && req.headers['x-freshdesk-debug'] === 'true';
  const dryRun = isDev && req.headers['x-freshdesk-dryrun'] === 'true';

  if (debug || dryRun) {
    setDebugContext({ debug, dryRun, ticketId: payload.ticket_id, phase: payload.phase });
    agentLog('WEBHOOK RECEIVED', payload);
  }

  // Dedup check using Redis SET with NX + TTL (skip in debug mode)
  if (!debug) {
    const dedupKey =
      `${REDIS_SYS_KEYS.JOB}:freshdesk-agent:${payload.ticket_id}:${payload.phase}` as const;
    const isNew = await sysRedis.set(dedupKey, '1', { NX: true, EX: DEDUP_TTL_SECONDS });

    if (!isNew) {
      await log({ type: 'dedup-skip', ticket_id: payload.ticket_id, phase: payload.phase });
      return res.status(200).json({ status: 'already_processing' });
    }
  }

  // Fire-and-forget: process the agent loop
  processFreshdeskAgent(payload)
    .catch((err) =>
      log({
        type: 'error',
        ticket_id: payload.ticket_id,
        phase: payload.phase,
        message: err instanceof Error ? err.message : String(err),
      })
    )
    .finally(() => clearDebugContext());

  // Return 200 immediately, process in background
  res.status(200).json({ status: 'accepted' });
});
