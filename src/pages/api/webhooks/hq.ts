import type { NextApiRequest, NextApiResponse } from 'next';
import { Webhook } from 'standardwebhooks';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hqTaskClosedSchema, hqWebhookSchema } from '~/server/schema/bug.schema';
import { resolveBugsByClickupTaskId } from '~/server/services/bug.service';
import { PayloadTooLarge, readRawBody } from '~/server/utils/raw-body';

// The signature covers the raw request body — disable Next's parser.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Outlasts a Standard Webhooks sender's retry schedule (about 27h in the reference implementation).
const DEDUPE_TTL_SECONDS = 3 * 24 * 60 * 60;

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
  if (parsed.data.type !== 'task.closed')
    return res.status(200).json({ ignored: parsed.data.type });

  const closed = hqTaskClosedSchema.safeParse(parsed.data.data);
  if (!closed.success) {
    await log({ type: 'validation-error', errors: closed.error.flatten() });
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const { task_id: taskId, status } = closed.data;
  // Every done status (wontfix included) closes a task; only a completed one fixes the issue.
  if (status !== 'complete') return res.status(200).json({ ignored: status });

  // Keyed on the delivery, not the task: a retry must not re-close an issue a moderator reopened
  // since, while a later reopen-and-close in HQ is a new delivery and should. Marked only once the
  // work is done, so a delivery that died part-way is retried rather than suppressed; concurrent
  // duplicates both run, which the resolve tolerates (it skips entries already closed).
  const processedKey =
    `${REDIS_SYS_KEYS.WEBHOOKS.HQ_PROCESSED}:${req.headers['webhook-id']}` as const;
  try {
    if (await sysRedis.exists(processedKey))
      return res.status(200).json({ duplicate: true, taskId });
  } catch (error: any) {
    await log({ type: 'error', message: 'Dedupe check failed', error: error.stack });
    return res.status(500).send('Internal Server Error');
  }

  let result: Awaited<ReturnType<typeof resolveBugsByClickupTaskId>>;
  try {
    result = await resolveBugsByClickupTaskId({ taskId });
  } catch (error: any) {
    await log({ type: 'error', message: `Failed to sync task ${taskId}`, error: error.stack });
    return res.status(500).send('Internal Server Error');
  }
  if (result.resolved.length || result.failed.length)
    await log({ type: 'resolved', taskId, ...result });
  // 5xx so the sender retries; the retry skips the entries this attempt did close.
  if (result.failed.length) return res.status(500).send('Internal Server Error');

  await sysRedis
    .set(processedKey, '1', { EX: DEDUPE_TTL_SECONDS })
    .catch((error) => log({ type: 'error', message: 'Dedupe mark failed', error: error.stack }));
  return res.status(200).json({ received: true, taskId, ...result });
}
