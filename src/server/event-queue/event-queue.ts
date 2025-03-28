import { Job, JobsOptions, Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq';
import { logToAxiom } from '~/server/logging/client';
import { isDev } from '~/env/other';
import { Redis } from 'ioredis';
import { env } from '~/env/server';
import { SIGTERM } from '~/shared/utils/sigterm';
import { WorkerRegistry } from '~/server/event-queue/worker-registry';
import { ServerSingleton } from '~/server/utils/server-singleton';

const redisUrl = env.REDIS_BULL_URL ?? '';
export const connection = ServerSingleton(
  'bull-mq',
  new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  })
);

type EventQueueHandler<T = any, R = any, N extends string = string> = (
  data: T,
  context: Job<T, R, N>
) => Promise<R> | R;
type EventHandlerMap<T = any, R = any, N extends string = string> = Record<
  string,
  EventQueueHandler<T, R, N>
>;

class CustomQueue<TMap extends EventHandlerMap> extends Queue {
  constructor(name: string, opts?: QueueOptions) {
    super(name, opts);
  }

  add = async <NameType extends keyof TMap>(
    name: NameType,
    data: Parameters<TMap[NameType]>[0],
    opts?: JobsOptions
  ) => super.add(name as string, data, opts);

  addBulk = async <NameType extends keyof TMap>(
    args: { name: NameType; data: Parameters<TMap[NameType]>[0]; opts?: JobsOptions }[]
  ) =>
    super.addBulk(
      args as { name: string; data: Parameters<TMap[NameType]>[0]; opts?: JobsOptions }[]
    );
}

export class EventQueue<TMap extends EventHandlerMap> {
  constructor(private name: string, private eventHandlerMap: TMap) {}

  queue = (options?: QueueOptions) => {
    return new CustomQueue<TMap>(this.name, { ...options, connection });
  };

  worker = (options?: WorkerOptions) => {
    const worker = new Worker(
      this.name,
      (job) => {
        return this.eventHandlerMap[job.name]?.(job.data, job);
      },
      {
        removeOnComplete: { count: 1000 },
        ...options,
        connection,
        autorun: isDev,
      }
    );

    worker.on('error', (err) => {
      if (isDev) console.log(err.message);
      else logToAxiom({ ...err, name: 'event-queue-worker', type: 'error' });
    });

    // TODO - handle redis connection down - how does it reconnect

    // worker.on('ready', () => {
    //   console.log('ready');
    // });

    // worker.on('failed', (job, error) => {
    //   console.log('failed', job?.name, job?.queueName);
    //   console.log({ error });
    // });

    // worker.on('stalled', () => {
    //   console.log('stalled');
    // });

    // worker.on('active', () => {
    //   console.log('active');
    // });

    // worker.on('completed', () => {
    //   console.log('completed');
    // });

    // worker.on('ioredis:close', () => {
    //   console.log('ioredis:close');
    // });
    // worker.on('closed', () => {
    //   console.log('closed');
    // });

    // handle cleanup of workers
    WorkerRegistry.register(worker);
    SIGTERM.push(worker.close);

    return worker;
  };
}
