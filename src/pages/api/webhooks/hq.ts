import type { NextApiRequest, NextApiResponse } from 'next';
import { Webhook } from 'standardwebhooks';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hqWebhookSchema } from '~/server/schema/bug.schema';
import { resolveBugsByClickupTaskId } from '~/server/services/bug.service';
import { PayloadTooLarge, readRawBody } from '~/server/utils/raw-body';

// The signature covers the raw request body — disable Next's parser.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Comfortably longer than the sender's retry schedule.
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

const log = (data: MixedObject) =>
  logToAxiom({ name: 'hq-webhook', ...data }, 'webhooks').catch(() => null);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  instrumentApiResponse(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  let webhook: Webhook;
  try {
    if (!env.HQ_WEBHOOK_SECRET) throw new Error('HQ_WEBHOOK_SECRET not configured');
    webhook = new Webhook(env.HQ_WEBHOOK_SECRET);
  } catch (error: any) {
    await log({ type: 'error', message: error.message });
    return res.status(503).send('HQ webhook not configured');
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (error: any) {
    if (error instanceof PayloadTooLarge) {
      await log({ type: 'error', message: 'Body exceeded the size cap' });
      return res.status(413).send('Payload Too Large');
    }
    await log({ type: 'error', message: `Failed to read body: ${error.message}` });
    return res.status(400).send('Bad Request');
  }

  try {
    webhook.verify(rawBody, req.headers as Record<string, string>, { jsonParse: false });
  } catch {
    await log({ type: 'error', message: 'Invalid signature' });
    return res.status(401).send('Unauthorized');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (error: any) {
    await log({ type: 'error', message: `Unparseable body: ${error.message}` });
    return res.status(400).send('Bad Request');
  }

  const parsed = hqWebhookSchema.safeParse(body);
  if (!parsed.success) {
    await log({ type: 'validation-error', errors: parsed.error.flatten() });
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const { type, data } = parsed.data;
  if (type !== 'task.closed') return res.status(200).json({ ignored: type });
  if (!data) return res.status(400).json({ error: 'Invalid payload' });
  // Every done status (wontfix included) closes a task; only a completed one fixes the issue.
  if (data.status !== 'complete') return res.status(200).json({ ignored: data.status });

  const taskId = data.task_id;
  // Verified above, so the header is present. Keyed on the delivery, not the task: a retry must
  // not re-close an issue a moderator reopened, while a later reopen-and-close in HQ should.
  const dedupeKey = `${REDIS_SYS_KEYS.WEBHOOKS.HQ_PROCESSED}:${req.headers['webhook-id']}` as const;
  try {
    const acquired = await sysRedis.setNxKeepTtlWithEx(dedupeKey, '1', DEDUPE_TTL_SECONDS);
    if (!acquired) return res.status(200).json({ duplicate: true, taskId });
  } catch (error: any) {
    await log({ type: 'error', message: 'Dedupe claim failed', error: error.stack });
    return res.status(500).send('Internal Server Error');
  }

  try {
    const result = await resolveBugsByClickupTaskId({ taskId });
    if (result.resolved.length || result.failed.length)
      await log({ type: 'resolved', taskId, ...result });

    return res.status(200).json({ received: true, taskId, ...result });
  } catch (error: any) {
    // Release the claim so the sender's retry is processed rather than suppressed as a duplicate.
    await sysRedis.del(dedupeKey).catch(() => null);
    await log({ type: 'error', message: `Failed to sync task ${taskId}`, error: error.stack });
    return res.status(500).send('Internal Server Error');
  }
}
