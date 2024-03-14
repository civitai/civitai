import { env } from '~/env/server.mjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';

type LaggingType = 'model' | 'modelVersion' | 'commentModel';
export async function getDbWithoutLag(type: LaggingType, id?: number) {
  if (env.REPLICATION_LAG_DELAY <= 0 || !id) return dbRead;
  const value = await redis.get(`lag-helper:${type}:${id}`);
  if (value) return dbWrite;
  return dbRead;
}

export async function preventReplicationLag(type: LaggingType, id?: number) {
  if (env.REPLICATION_LAG_DELAY <= 0 || !id) return;
  await redis.set(`lag-helper:${type}:${id}`, 'true', { EX: env.REPLICATION_LAG_DELAY });
}

// type DataProcessorOptions = {
//   rangeFetcher: (runContext: any) => AsyncIterable<any>;
//   processor: (data: any, runContext: any) => Promise<void>;
//   batchSize: number;
//   concurrency: number;
//   runContext: { on: (event: 'close' )}
// };
// export async function dataProcessor({ rangeFetcher, processor, batchSize, concurrency, runContext }, )
