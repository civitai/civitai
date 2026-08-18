import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { clickupWebhookSchema } from '~/server/schema/bug.schema';
import {
  clickupDoneStatusFromPayload,
  resolveBugsByClickupTaskId,
} from '~/server/services/bug.service';

// ClickUp signs the raw request body — disable Next's parser.
export const config = {
  api: {
    bodyParser: false,
  },
};

const log = (data: MixedObject) =>
  logToAxiom({ name: 'clickup-webhook', ...data }, 'webhooks').catch(() => null);

// Next's own 1 MB cap goes away with bodyParser: false, and the body is buffered
// BEFORE the signature can be checked — so the limit has to be re-imposed here or
// any unauthenticated caller can size the allocation.
const MAX_BODY_BYTES = 1_000_000;

class PayloadTooLarge extends Error {}

async function buffer(readable: Readable) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function isValidSignature(rawBody: Buffer, signatureHeader: string, secret: string) {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
  } catch {
    return false; // length mismatch
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  instrumentApiResponse(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const secret = env.CLICKUP_WEBHOOK_SECRET;
  if (!secret) {
    await log({ type: 'error', message: 'CLICKUP_WEBHOOK_SECRET not configured' });
    return res.status(503).send('ClickUp webhook not configured');
  }

  let rawBody: Buffer;
  try {
    rawBody = await buffer(req);
  } catch (error: any) {
    if (error instanceof PayloadTooLarge) {
      await log({ type: 'error', message: 'Body exceeded the size cap' });
      return res.status(413).send('Payload Too Large');
    }
    await log({ type: 'error', message: `Failed to read body: ${error.message}` });
    return res.status(400).send('Bad Request');
  }

  const signature = req.headers['x-signature'];
  if (typeof signature !== 'string' || !isValidSignature(rawBody, signature, secret)) {
    await log({ type: 'error', message: 'Invalid signature' });
    return res.status(401).send('Unauthorized');
  }

  let payload;
  try {
    const parsed = clickupWebhookSchema.safeParse(JSON.parse(rawBody.toString('utf8')));
    if (!parsed.success) {
      await log({ type: 'validation-error', errors: parsed.error.flatten() });
      return res.status(400).json({ error: 'Invalid payload' });
    }
    payload = parsed.data;
  } catch (error: any) {
    await log({ type: 'error', message: `Unparseable body: ${error.message}` });
    return res.status(400).send('Bad Request');
  }

  const taskId = payload.task_id;
  const doneStatus = clickupDoneStatusFromPayload(payload);

  // Ack anything we don't act on so ClickUp keeps the webhook healthy.
  if (!taskId || !doneStatus) return res.status(200).json({ ignored: payload.event });

  try {
    const result = await resolveBugsByClickupTaskId({ taskId });
    if (result.resolved.length || result.failed.length)
      await log({ type: 'resolved', taskId, doneStatus, ...result });

    return res.status(200).json({ received: true, taskId, ...result });
  } catch (error: any) {
    // 5xx, NOT 4xx: the request was fine and our side failed, so ClickUp should
    // retry rather than treat the completion as delivered and drop it. The message
    // is logged, never echoed — a DB error string can carry query detail.
    await log({ type: 'error', message: `Failed to sync task ${taskId}`, error: error.stack });
    return res.status(500).send('Internal Server Error');
  }
}
