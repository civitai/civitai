import { ServerSingleton } from '~/server/utils/server-singleton';
import { Worker } from 'bullmq';

class WorkerRegistry {
  #workers: Record<string, Worker> = {};

  async register(worker: Worker) {
    const existing = this.#workers[worker.name];
    if (existing) {
      await existing.close();
    }
    this.#workers[worker.name] = worker;
  }
}

const instance = ServerSingleton('worker-registry', new WorkerRegistry());

export { instance as WorkerRegistry };
