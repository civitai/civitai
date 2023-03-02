import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { webhookProcessors } from '~/server/webhooks/utils.webhooks';

const WEBHOOKS_LAST_SENT_KEY = 'last-sent-webhooks';
export const sendWebhooksJob = createJob('send-webhooks', '*/1 * * * *', async () => {
  // Get the last run time from keyValue
  const lastSent = new Date(
    ((
      await dbWrite.keyValue.findUnique({
        where: { key: WEBHOOKS_LAST_SENT_KEY },
      })
    )?.value as number) ?? 0
  ).toISOString();

  const registeredWebhooks = await dbWrite.webhook.findMany({
    where: { active: true },
    select: { notifyOn: true, url: true },
  });

  const promises: Promise<unknown>[] = [];
  if (registeredWebhooks.length > 0) {
    // Enqueue webhook requests
    for (const [type, { getData }] of Object.entries(webhookProcessors)) {
      const data = await getData?.({ lastSent, prisma: dbWrite });
      if (!data) continue;
      for (const webhook of registeredWebhooks) {
        if (!webhook.notifyOn.includes(type)) continue;
        for (const item of data) {
          promises.push(
            new Promise((res) => {
              fetch(webhook.url, {
                method: 'POST',
                body: JSON.stringify({
                  event: type,
                  data: item,
                }),
                headers: { 'Content-Type': 'application/json' },
              }).then(res);
            })
          );
        }
      }
    }
  }

  // Update the last sent time
  // --------------------------------------------
  await dbWrite?.keyValue.upsert({
    where: { key: WEBHOOKS_LAST_SENT_KEY },
    create: { key: WEBHOOKS_LAST_SENT_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });

  // Send webhooks
  // --------------------------------------------
  if (promises.length > 0) {
    await Promise.all(promises);
    console.log(`sent ${promises.length} webhooks`);
  }
});
