import { initStripePrices, initStripeProducts } from '~/server/services/stripe.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { discord } from '~/server/integrations/discord';

async function populateRedisCache() {
  const toInvalidate = await dbWrite.sessionInvalidation.groupBy({
    by: ['userId'],
    _max: { invalidatedAt: true },
  });

  for (const {
    userId,
    _max: { invalidatedAt },
  } of toInvalidate) {
    if (!invalidatedAt) continue;
    const expireDate = new Date();
    expireDate.setDate(invalidatedAt.getDate() + 30);

    redis.set(`session:${userId}`, invalidatedAt.toISOString(), {
      EXAT: Math.floor(expireDate.getTime() / 1000),
      NX: true,
    });
  }
}

export default WebhookEndpoint(async (req, res) => {
  await initStripeProducts();
  await initStripePrices();
  // await populateRedisCache();
  await discord.registerMetadata();

  res.status(200).json({ ok: true });
});
