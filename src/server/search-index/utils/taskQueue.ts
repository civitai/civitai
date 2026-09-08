import { sleep } from '~/server/utils/errorHandling';
import type { createLogger } from '~/utils/logging';

export type Task = PullTask | TransformTask | PushTask | OnCompleteTask;

type BaseTask = {
  maxRetries?: number;
  retries?: number;
  currentData?: any;
  currentStep?: number;
  steps?: number;
  index?: number;
  total?: number;
  start?: number;
  /**
   * How many source ids this task is responsible for. Carried through the pull -> transform ->
   * push chain (the derived tasks no longer hold the id list) so that a task which ends up
   * failing can be attributed back to a number of documents that were never indexed.
   */
  idCount?: number;
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
  /** Tasks that exhausted their retries. Kept so a caller can report what was NOT indexed. */
  failedTasks: Task[];
  /**
   * Tasks that are between "failed" and "back on a queue" — see `failTask`. Counted by
   * `isQueueEmpty` so the workers cannot all exit during the retry backoff.
   */
  retrying: number;

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
    this.failedTasks = [];
    this.retrying = 0;
  }

  get data() {
    return {
      queues: this.queues,
      processing: this.processing,
      stats: this.stats,
    };
  }

  /** Number of source ids belonging to tasks that permanently failed. */
  get failedIdCount(): number {
    return this.failedTasks.reduce((acc, task) => acc + (task.idCount ?? 0), 0);
  }

  async waitForQueueCapacity(queue: Task[]): Promise<void> {
    while (queue.length >= this.maxQueueSize) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async addTask(task: Task): Promise<void> {
    if (!task.start) task.start = Date.now();
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
      // Requeue it. The task is no longer processing and not yet queued, so it is invisible to
      // isQueueEmpty() for the whole backoff — without `retrying` every worker can decide the
      // queue is empty and resolve before the retry is ever added back.
      this.stats.processing--;
      this.retrying++;
      try {
        await sleep(RETRY_TIMEOUT);
        task.retries++;
        await this.addTask(task);
      } finally {
        this.retrying--;
      }
      return;
    }

    this.failedTasks.push(task);
    this.updateTaskStatus(task, 'failed');
  }

  isQueueEmpty(): boolean {
    const queueSize = Object.values(this.queues).reduce((acc, queue) => acc + queue.length, 0);
    const processingSize = this.processing.size;
    const totalSize = queueSize + processingSize + this.retrying;
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
        // Awaited: failTask holds the task's retry slot open, and dropping the promise on the
        // floor also drops any error it raises.
        await queue.failTask(task);
      } else {
        queue.completeTask(task);
        if (result !== 'done') {
          result.start = task.start;
          await queue.addTask(result);
        } else {
          logger?.(
            `Worker :: Task done`,
            task.start ? (Date.now() - task.start) / 1000 : 'unknown duration'
          );
        }
      }
    }

    resolve(undefined);
  });
};
