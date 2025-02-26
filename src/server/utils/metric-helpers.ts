import {
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from '~/shared/utils/prisma/enums';
import { clickhouse } from '~/server/clickhouse/client';
import { Context } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { imageMetricsCache } from '~/server/redis/caches';

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
  const logData = JSON.stringify({
    userId: ctx.user?.id,
    entityType,
    entityId,
    metricType,
    metricValue: amount,
  });

  // Inc postgres EntityMetric
  try {
    const dbData = await dbWrite.$executeRaw`
      UPDATE "EntityMetric"
      SET "metricValue" = "metricValue" + ${amount}
      WHERE "entityType" = ${entityType}::"EntityMetric_EntityType_Type" AND "entityId" = ${entityId} AND "metricType" = ${metricType}::"EntityMetric_MetricType_Type"
    `;
    if (dbData === 0) {
      if (clickhouse) {
        const cData = await clickhouse.$query<{ total: number }>(`
          SELECT sum(metricValue) as total
          FROM entityMetricEvents
          WHERE entityType = '${entityType}' AND entityId = ${entityId} AND metricType = '${metricType}'
        `);
        const existingVal = cData?.[0]?.total ?? 0;
        const newVal = existingVal + amount;

        await dbWrite.$executeRaw`
          INSERT INTO "EntityMetric" ("entityType", "entityId", "metricType", "metricValue")
          VALUES (${entityType}::"EntityMetric_EntityType_Type", ${entityId}, ${metricType}::"EntityMetric_MetricType_Type", ${newVal})
          ON CONFLICT ("entityType", "entityId", "metricType") DO UPDATE
          SET "metricValue" = "EntityMetric"."metricValue" + ${amount}
        `;
      } else {
        logToAxiom(
          {
            type: 'error',
            name: 'No clickhouse client - update',
            details: { data: logData },
          },
          'clickhouse'
        ).catch();
      }
    }
    if (entityType === 'Image') await imageMetricsCache.bust();
  } catch (e) {
    const error = e as Error;
    // putting this into the clickhouse dataset for now
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to increment metric',
        details: { data: logData },
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'clickhouse'
    ).catch();
  }

  // Queue with clickhouse tracker
  try {
    await ctx.track.entityMetric({ entityType, entityId, metricType, metricValue: amount });
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to queue metric into CH',
        details: { data: logData },
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
