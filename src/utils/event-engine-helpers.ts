import type { IRedisClient, IDatabaseProvider } from '@civitai/event-engine-common';
import { MetricService } from '@civitai/event-engine-common';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';

export const getMetricsService = () => {
  if (!redis) {
    throw new Error('Redis client not initialized');
  }

  if (!clickhouse) {
    throw new Error('Clickhouse client not initialized');
  }

  const metricService = new MetricService(clickhouse, redis as unknown as IRedisClient);
  return metricService;
};

export const getDatabaseProvider = () => {
  const provider: IDatabaseProvider = {
    findImageEngagements: async (userId, type) => {
      const data = await dbRead.imageEngagement.findMany({
        where: {
          userId: userId,
          type: type,
        },

        select: {
          imageId: true,
          userId: true,
          type: true,
        },
      });

      return data;
    },
    findUserByUsername: async (username) => {
      const data = await dbRead.user.findUnique({
        where: {
          username: username,
        },
        select: {
          id: true,
          username: true,
        },
      });

      if (!data?.username) {
        return null;
      }

      return {
        id: data.id,
        username: data.username!,
      };
    },

    findUserEngagements: async (userId, type) => {
      const data = await dbRead.userEngagement.findMany({
        where: {
          userId: userId,
          type: type,
        },

        select: {
          targetUserId: true,
          userId: true,
          type: true,
        },
      });
      return data;
    },
  };

  return provider;
};
