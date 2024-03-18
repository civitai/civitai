import { env } from '~/env/server.mjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { Task, limitConcurrency } from '~/server/utils/concurrency-helpers';

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

export type RunContext = {
  cancelFns: (() => Promise<void>)[];
  batchSize: number;
  concurrency: number;
  start: number;
  end?: number;
  after?: Date;
  before?: Date;
};

type DataProcessorOptions = {
  rangeFetcher: (context: RunContext) => Promise<{ start: number; end: number }>;
  processor: (context: Omit<RunContext, 'end'> & { end: number }) => Promise<void>;
  enableLogging?: boolean;
  runContext: {
    on: (event: 'close', listener: () => void) => void;
  };
  params: {
    batchSize: number;
    concurrency: number;
    start: number;
    end?: number;
    after?: Date;
    before?: Date;
  };
};
export async function dataProcessor({
  rangeFetcher,
  processor,
  runContext,
  params,
}: DataProcessorOptions) {
  const cancelFns: (() => Promise<void>)[] = [];
  let stop = false;
  runContext.on('close', async () => {
    console.log('Cancelling');
    stop = true;
    await Promise.all(cancelFns.map((cancel) => cancel()));
  });

  const { start = 1, end, batchSize, concurrency } = params;
  const context = { ...params, cancelFns };

  if (stop) return;
  const range = !start || !end ? await rangeFetcher(context) : { start, end };

  let cursor = range.start ?? params.start;
  const maxCursor = range.end;
  await limitConcurrency(() => {
    if (stop || cursor > maxCursor) return null;
    const start = cursor;
    cursor += batchSize;
    const end = cursor;

    return async () => {
      await processor({ ...context, start, end });
    };
  }, concurrency);
}
