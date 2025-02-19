import { dbWrite } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { initStripePrices, initStripeProducts } from '~/server/services/stripe.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

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

    redis.set(`${REDIS_KEYS.SESSION.BASE}:${userId}`, invalidatedAt.toISOString(), {
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
