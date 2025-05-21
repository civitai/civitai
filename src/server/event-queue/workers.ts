import { env } from 'process';
import { ImageQueue, ImageWorker } from '~/server/event-queue/image.queue';

const queues = [ImageQueue];

const workers = [ImageWorker];

export async function initWorkers() {
  if (env.ENABLE_BULLMQ_WORKERS) {
    return await Promise.all(
      workers.map(async (worker) => {
        const client = await worker.client;
        const status = client.status;
        const running = worker.isRunning();
        if (!running) await worker.run();
        return { name: worker.name, connection: status, running };
      })
    );
  } else {
    return await Promise.all(
      queues.map(async (queue) => {
        const client = await queue.client;
        const status = client.status;
        return {
          name: queue.name,
          connection: status,
        };
      })
    );
  }
}
