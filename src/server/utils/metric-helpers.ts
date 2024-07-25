import { EntityMetric_EntityType_Type, EntityMetric_MetricType_Type } from '@prisma/client';
import { Context } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

export const updateEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
  amount = 1,
}: {
  ctx: DeepNonNullable<Context>;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
  amount?: number;
}) => {
  // Queue with clickhouse tracker
  await ctx.track.entityMetric({ entityType, entityId, metricType, metricValue: amount });

  try {
    // Inc postgres EntityMetric
    await dbWrite.entityMetric.upsert({
      where: { entityType_entityId_metricType: { entityType, entityId, metricType } },
      create: {
        entityType,
        entityId,
        metricType,
        metricValue: amount < 0 ? 0 : amount,
      },
      update: {
        metricValue: { increment: amount },
      },
    });
  } catch (e) {
    const error = e as Error;
    // putting this into the clickhouse dataset for now
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to increment metric',
        details: {
          data: JSON.stringify({ entityType, entityId, metricType, metricValue: amount }),
        },
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'clickhouse'
    ).catch();
  }
};

export const incrementEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
}: {
  ctx: DeepNonNullable<Context>;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
}) => {
  await updateEntityMetric({ ctx, entityType, entityId, metricType, amount: 1 });
};

export const decrementEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
}: {
  ctx: DeepNonNullable<Context>;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
}) => {
  await updateEntityMetric({ ctx, entityType, entityId, metricType, amount: -1 });
};
