import { sleep } from '~/server/utils/errorHandling';
import { createLogger } from '~/utils/logging';

export type Task = PullTask | TransformTask | PushTask | OnCompleteTask;

type BaseTask = {
  maxRetries?: number;
  retries?: number;
  currentData?: any;
  currentStep?: number;
  steps?: number;
};

export type PullTask = BaseTask &
  (
    | {
        type: 'pull';
        mode: 'range';
        startId: number;
        endId: number;
      }
    | {
        type: 'pull';
        mode: 'targeted';
        ids: number[];
      }
  );

export type TransformTask = BaseTask & {
  type: 'transform';
  data: any;
};

export type PushTask = BaseTask & {
  type: 'push';
  data: any;
};

export type OnCompleteTask = BaseTask & {
  type: 'onComplete';
};

type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

const MAX_QUEUE_SIZE_DEFAULT = 50;
const RETRY_TIMEOUT = 1000;

export class TaskQueue {
  queues: Record<Task['type'], Task[]>;
  queueEntry: Task['type'];
  processing: Set<Task>;
  stats: Record<TaskStatus, number>;
  maxQueueSize: number;

  constructor(queueEntry: Task['type'] = 'pull', maxQueueSize = MAX_QUEUE_SIZE_DEFAULT) {
    this.queues = {
      pull: [],
      transform: [],
      push: [],
      onComplete: [],
    };
    this.queueEntry = queueEntry;
    this.processing = new Set();
    this.stats = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
    this.maxQueueSize = maxQueueSize;
  }

  get data() {
    return {
      queues: this.queues,
      processing: this.processing,
      stats: this.stats,
    };
  }

  async waitForQueueCapacity(queue: Task[]): Promise<void> {
    while (queue.length >= this.maxQueueSize) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async addTask(task: Task): Promise<void> {
    const queue = this.queues[task.type];
    // logInfo(`${task.pluginName}: Queuing ${task.type} task`);
    if (task.type !== this.queueEntry) await this.waitForQueueCapacity(queue);

    // Work with steps on Pull tasks:

    if (task.steps && task.currentStep !== 0) {
      // Add to the top of the pile. to prio it.
      queue.unshift(task);
    } else {
      queue.push(task);
    }
    this.updateTaskStatus(task, 'queued');
    // logInfo(`${task.pluginName}: Queued ${task.type} task`);
  }

  updateTaskStatus(task: Task, status: TaskStatus) {
    if (status === 'processing') this.stats.queued--;
    if (status === 'completed') this.stats.processing--;
    if (status === 'failed') this.stats.processing--;
    this.stats[status]++;
  }

  getTask(): Task | undefined {
    for (const queue of Object.values(this.queues).reverse()) {
      if (queue.length > 0) {
        const task = queue.shift();
        if (task) {
          this.processing.add(task);
          this.updateTaskStatus(task, 'processing');
          return task;
        }
      }
    }
    return undefined;
  }

  completeTask(task: Task): void {
    this.processing.delete(task);
    this.updateTaskStatus(task, 'completed');
  }

  async failTask(task: Task): Promise<void> {
    this.processing.delete(task);
    // Check how many failures
    task.maxRetries = task.maxRetries ?? 3;
    task.retries = task.retries ?? 0;

    if (task.retries < task.maxRetries) {
      // Requeue it:
      await sleep(RETRY_TIMEOUT);
      task.retries++;
      this.addTask(task);
      return;
    }

    this.updateTaskStatus(task, 'failed');
  }

  isQueueEmpty(): boolean {
    const queueSize = Object.values(this.queues).reduce((acc, queue) => acc + queue.length, 0);
    const processingSize = this.processing.size;
    const totalSize = queueSize + processingSize;
    return totalSize === 0;
  }
}

export const getTaskQueueWorker = (
  queue: TaskQueue,
  processor: (task: Task) => Promise<'error' | PullTask | TransformTask | PushTask | 'done'>,
  logger?: ReturnType<typeof createLogger>
) => {
  return new Promise(async (resolve) => {
    while (!queue.isQueueEmpty()) {
      const task = queue.getTask();
      if (!task) {
        await sleep(1000);
        continue;
      }

      logger?.('Worker :: Processing task');

      const result = await processor(task);

      if (result === 'error') {
        queue.failTask(task);
      } else {
        queue.completeTask(task);
        if (result !== 'done') {
          queue.addTask(result);
        } else {
          logger?.(`Worker :: Task done`, queue.data);
        }
      }
    }

    resolve(undefined);
  });
};
