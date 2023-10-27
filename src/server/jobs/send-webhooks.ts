import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { webhookProcessors } from '~/server/webhooks/utils.webhooks';
import { createLogger } from '~/utils/logging';

const log = createLogger('jobs', 'green');

export const sendWebhooksJob = createJob('send-webhooks', '*/1 * * * *', async () => {
  const [lastSent, setLastSent] = await getJobDate('last-sent-webhooks');

  const registeredWebhooks = await dbWrite.webhook.findMany({
    where: { active: true },
    select: { notifyOn: true, url: true },
  });

  const promises: Array<() => Promise<Response>> = [];
  if (registeredWebhooks.length > 0) {
    // Enqueue webhook requests
    for (const [type, { getData }] of Object.entries(webhookProcessors)) {
      const data = await getData?.({ lastSent, prisma: dbWrite });
      if (!data) continue;
      for (const webhook of registeredWebhooks) {
        if (!webhook.notifyOn.includes(type)) continue;

        let requestUrl = webhook.url;
        const headers: HeadersInit = { 'Content-Type': 'application/json' };

        const url = new URL(webhook.url);
        const { username, password } = url;
        if (username || password) {
          requestUrl = requestUrl.replace(`${username}:${password}@`, '');
          headers['Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString(
            'base64'
          )}`;
        }

        for (const item of data) {
          promises.push(() =>
            fetch(requestUrl, {
              method: 'POST',
              body: JSON.stringify({
                event: type,
                data: item,
              }),
              headers,
            })
          );
        }
      }
    }
  }

  // Update the last sent time
  // --------------------------------------------
  await setLastSent();

  // Send webhooks
  // --------------------------------------------
  if (!promises.length) return;
  // Break promises into batches and run them in parallel
  const batchSize = 50;
  for (let i = 0; i < promises.length; i += batchSize) {
    const batch = promises.slice(i, i + batchSize);
    log(`webhooks: sending batch ${i} to ${i + batchSize}`);
    try {
      await Promise.all(batch.map((fn) => fn()));
      await new Promise((res) => setTimeout(res, 500));
    } catch (err) {
      log(`webhooks: error sending batch ${i} to ${i + batchSize}`);
      console.error(err);
    }
  }
  log(`webhooks: sent ${promises.length} webhooks`);
});
