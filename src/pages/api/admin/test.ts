import type { NextApiRequest, NextApiResponse } from 'next';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { isDefined } from '~/utils/type-guards';

type MatureContent = {
  count: number;
  subscriptions: Record<string, number>;
};

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });

    const result = await clickhouse?.$query<{ userId: number }>(`
      SELECT "userId"
      FROM "pageViews"
      WHERE time BETWEEN '2025-08-01' AND '2025-08-31'
      GROUP BY "userId"
    `);

    if (!result) throw new Error('no results');
    const browsingLevels: Record<number, number> = {};
    const matureContent: { show: MatureContent; hide: MatureContent } = {
      show: { count: 0, subscriptions: {} },
      hide: { count: 0, subscriptions: {} },
    };

    let totalProcessed = 0;
    const users = await Limiter({ batchSize: 5000, limit: 10 }).process(result, async (result) => {
      const userIds = result.map((x) => x.userId);
      const users = await dbRead.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          browsingLevel: true,
          showNsfw: true,
          subscriptionId: true,
        },
      });
      totalProcessed += users.length;
      console.log({ totalProcessed });
      return users;
    });

    const subscriptions = await Limiter({ batchSize: 5000, limit: 10 }).process(
      users,
      async (users) => {
        const subscriptionIds = users.map((x) => x.subscriptionId).filter(isDefined);
        return await dbRead.customerSubscription.findMany({
          where: { id: { in: subscriptionIds }, status: 'active' },
          select: { id: true, userId: true, productId: true },
        });
      }
    );

    const productIds = [
      ...new Set([...subscriptions.map((subscription) => subscription.productId)]),
    ];
    const products = await dbRead.product.findMany({ where: { id: { in: productIds } } });

    for (const { browsingLevel, showNsfw, subscriptionId } of users) {
      browsingLevels[browsingLevel] = (browsingLevels[browsingLevel] ?? 0) + 1;
      matureContent[showNsfw ? 'show' : 'hide'].count += 1;
      const subscription = subscriptions.find((x) => x.id === subscriptionId);
      if (subscription) {
        const product = products.find((x) => x.id === subscription.productId);
        if (product) {
          const tier = (product.metadata as any).tier;
          if (tier && tier !== 'free') {
            // subscriptions[product.name] = (subscriptions[product.name] ?? 0) + 1;
            matureContent[showNsfw ? 'show' : 'hide'].subscriptions[tier] =
              (matureContent[showNsfw ? 'show' : 'hide'].subscriptions[tier] ?? 0) + 1;
          }
        }
      }
    }
    res.status(200).send({ browsingLevels, matureContent });
  } catch (e) {
    console.log(e);
    res.status(400).end();
  }
});

/*
August
Total new users - 346617
Total new users with mature content disabled - 193086
Total new users with mature content enabled - 153531

Total active users with mature content disabled - 235435
Total active users with mature content enabled - 585806

*/
