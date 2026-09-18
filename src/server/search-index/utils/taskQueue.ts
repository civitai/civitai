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
  /**
   * Targeted tasks only: the ids this task was asked to index. Set on the transform task, where
   * it is the only place the requested ids and the produced documents are both in hand — a pull
   * task has no documents yet and a push task no longer knows what was asked for. Carried no
   * further: the push task keeps `droppedIds` instead, which is bounded by the drop rather than
   * by the batch.
   */
  requestedIds?: (number | string)[];
  /**
   * Requested ids that produced no document, so nothing about them reached the index and nothing
   * reports it as a failure. Set on the push task by the transform step, or on the pull task
   * itself when a targeted pull comes back empty at step 0. Usually far smaller than the batch,
   * but it CAN equal it — a batch every one of whose ids dropped is the case this exists for.
   */
  droppedIds?: (number | string)[];
  /**
   * Requested ids a processor's `getHandledIds` accounted for although no document carries them —
   * `collections` deleting a pruned document, today. Carried so the count stays VISIBLE rather
   * than being subtracted into the silence `droppedIds` exists to break.
   */
  handledWithoutDocumentIds?: (number | string)[];
};

/**
 * Dropped ids are retained as a SAMPLE, not a list: a transform that drops a whole batch would
 * otherwise hold the batch's id list for the life of the queue, and the count is what a caller
 * acts on. `droppedIdCount` is always the true total.
 */
export const DROPPED_ID_SAMPLE_LIMIT = 100;

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

/**
 * What is retained about a task that exhausted its retries.
 *
 * Deliberately NOT the `Task` itself: a push task carries `data` (an entire transformed batch,
 * up to a processor's document batch size) and any multi-step pull task carries `currentData`.
 * Holding the task object would keep those payloads alive for the whole life of the queue —
 * which, on a degraded backend where many batches fail, is a large amount of memory retained for
 * the sake of a number. `idCount` is the only field any production consumer reads (via
 * `failedIdCount`); `type` and `retries` are kept for diagnostics and are so far read only by the
 * specs.
 */
export type FailedTaskRecord = {
  type: Task['type'];
  /** Source ids this task was responsible for; none of them reached the index. */
  idCount: number;
  /**
   * Retries the task had already made when it gave up — it was attempted `retries + 1` times.
   * A task with `maxRetries: 0` is attempted once and records 0.
   */
  retries: number;
};

const MAX_QUEUE_SIZE_DEFAULT = 50;
const RETRY_TIMEOUT = 1000;

export class TaskQueue {
  queues: Record<Task['type'], Task[]>;
  queueEntry: Task['type'];
  processing: Set<Task>;
  stats: Record<TaskStatus, number>;
  maxQueueSize: number;
  /**
   * Summaries of the tasks that exhausted their retries, kept so a caller can report what was NOT
   * indexed. Summaries rather than tasks — see `FailedTaskRecord`.
   */
  failedTasks: FailedTaskRecord[];
  /**
   * Ids pulled that produced no document, across every completed task. True total, with one
   * stated exception: a batch whose accounting threw contributes 0 here and says so at
   * `console.error` — never losing a write to observe it is the trade.
   */
  droppedIdCount: number;
  /** Up to `DROPPED_ID_SAMPLE_LIMIT` of those ids, for naming them in a log line. */
  droppedIdSample: (number | string)[];
  /** Ids a processor hook accounted for with no document, across every completed task. */
  handledWithoutDocumentIdCount: number;
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
    this.droppedIdCount = 0;
    this.droppedIdSample = [];
    this.handledWithoutDocumentIdCount = 0;
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
    return this.failedTasks.reduce((acc, record) => acc + record.idCount, 0);
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
    // Collected here rather than at the transform step so a batch that never reaches the index is
    // not reported as dropped: a push that permanently fails goes through `failTask`, and its ids
    // belong to `failedIdCount`. A retried push carries the same `droppedIds` and is counted on
    // the attempt that succeeds, once.
    if (task.droppedIds?.length) this.recordDroppedIds(task.droppedIds);
    if (task.handledWithoutDocumentIds?.length)
      this.handledWithoutDocumentIdCount += task.handledWithoutDocumentIds.length;
    this.updateTaskStatus(task, 'completed');
  }

  private recordDroppedIds(ids: (number | string)[]): void {
    this.droppedIdCount += ids.length;
    for (const id of ids) {
      if (this.droppedIdSample.length >= DROPPED_ID_SAMPLE_LIMIT) break;
      this.droppedIdSample.push(id);
    }
  }

  async failTask(task: Task): Promise<void> {
    this.processing.delete(task);
    // Check how many failures
    task.maxRetries = task.maxRetries ?? 3;
    task.retries = task.retries ?? 0;

    if (task.retries < task.maxRetries) {
      // Requeue it. The task is no longer processing and not yet queued, so `retrying` is what
      // keeps it visible to isQueueEmpty() across the backoff. It is redundant with the `await`
      // in getTaskQueueWorker rather than an alternative to it: measured, either mechanism on its
      // own keeps the retry alive, and only with neither do the workers all decide the queue is
      // empty and resolve before the retry is added back.
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

    // Summarise rather than retain. On this path only — the task has given up, the retry branch
    // above having already returned with it back on `queues[type]` — no structure on the queue
    // reaches the task or its `data`/`currentData` payload once this returns. (Pinned queue-wide,
    // not just for `failedTasks`, by the reachability walk in
    // `src/server/search-index/utils/__tests__/taskQueue.test.ts`.)
    this.failedTasks.push({
      type: task.type,
      idCount: task.idCount ?? 0,
      retries: task.retries,
    });
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
        // Awaited so the re-queue completes before this worker re-evaluates `isQueueEmpty()`.
        // That is redundant with `retrying`, not an alternative to it: measured, either
        // mechanism ALONE keeps the retry alive, and only with neither do all the workers
        // resolve before the task is added back. See the retry branch in `failTask`.
        //
        // 🔴 It does NOT stop a rejection from `failTask` being dropped. This worker is a
        // `new Promise(async (resolve) => …)`, and a throw inside an async executor rejects
        // the executor's own unobserved promise, never the outer one — so the rejection is
        // unhandled with or without this `await`. What the `await` changes is that the worker
        // then never settles, hanging the `Promise.all(workers)` in `updateSync` instead of
        // returning. Nothing in `failTask`'s own body throws today — it mutates queue state,
        // sleeps, and calls `addTask` — so this is a latent shape, not a live bug. But do not
        // read the `await` as error handling.
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
