import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { webhookProcessors } from '~/server/webhooks/utils.webhooks';
import { createLogger } from '~/utils/logging';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';

const log = createLogger('jobs', 'green');

export const sendWebhooksJob = createJob('send-webhooks', '*/1 * * * *', async () => {
  const [lastSent, setLastSent] = await getJobDate('last-sent-webhooks');

  const registeredWebhooks = await dbWrite.webhook.findMany({
    where: { active: true },
    select: { notifyOn: true, url: true },
  });

  const prepTime: Record<string, number> = {};
  const sendingTime: Record<string, number> = {};
  const tasks: Array<Task> = [];
  if (registeredWebhooks.length > 0) {
    // Enqueue webhook requests
    for (const [type, { getData }] of Object.entries(webhookProcessors)) {
      const start = Date.now();
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
          tasks.push(async () => {
            const sendStart = Date.now();
            await fetch(requestUrl, {
              method: 'POST',
              body: JSON.stringify({
                event: type,
                data: item,
              }),
              headers,
            });
            sendingTime[type] ??= 0;
            sendingTime[type] += Date.now() - sendStart;
          });
        }
      }
      prepTime[type] = Date.now() - start;
    }
  }

  // Update the last sent time
  // --------------------------------------------
  await setLastSent();

  // Send webhooks
  // --------------------------------------------
  await limitConcurrency(tasks, 10);

  return {
    prepTime,
    sendingTime,
  };
});
