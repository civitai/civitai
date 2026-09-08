import { describe, expect, it } from 'vitest';
import type { PullTask, PushTask, Task } from '~/server/search-index/utils/taskQueue';
import { TaskQueue } from '~/server/search-index/utils/taskQueue';

/**
 * Walks a retained value and reports whether `needle` is reachable from it by object identity.
 * A `JSON.stringify` check alone can only see a payload that happens to serialise; this sees a
 * held reference regardless of shape.
 */
const holdsReference = (value: unknown, needle: object, seen = new Set<unknown>()): boolean => {
  if (value === needle) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((child) =>
    holdsReference(child, needle, seen)
  );
};

/** Marks a task as in-flight the way `getTask` would, so `failTask` sees consistent stats. */
const startProcessing = (queue: TaskQueue, task: Task) => {
  queue.processing.add(task);
  queue.stats.queued++;
  queue.updateTaskStatus(task, 'processing');
};

describe('TaskQueue :: what a permanently-failed task retains', () => {
  it("does not retain a failed push task's document payload", async () => {
    const queue = new TaskQueue('pull');
    // Stand-in for a transformed batch. Production sizes this at the processor's document batch
    // size, which is five figures for the images index — the reason retaining it matters.
    const documents = Array.from({ length: 64 }, (_, i) => ({
      id: i + 1,
      blob: 'PAYLOAD_SENTINEL_DO_NOT_RETAIN',
    }));
    const task: PushTask = {
      type: 'push',
      data: documents,
      idCount: 64,
      maxRetries: 0,
    };

    startProcessing(queue, task);
    await queue.failTask(task);

    expect(queue.failedTasks).toHaveLength(1);
    const [record] = queue.failedTasks;

    expect(
      holdsReference(record, documents),
      'the retained failure record still holds a reference to the pushed documents'
    ).toBe(false);
    expect(
      JSON.stringify(record),
      'the retained failure record still serialises the document payload'
    ).not.toContain('PAYLOAD_SENTINEL_DO_NOT_RETAIN');

    // The number the caller actually reports on survives the summarising.
    expect(record).toEqual({ type: 'push', idCount: 64, retries: 0 });
    expect(queue.failedIdCount).toBe(64);
  });

  it("does not retain a failed multi-step pull task's intermediate data", async () => {
    const queue = new TaskQueue('pull');
    const intermediate = { rows: Array.from({ length: 32 }, (_, i) => `ROW_SENTINEL_${i}`) };
    const task: PullTask = {
      type: 'pull',
      mode: 'targeted',
      ids: [11, 22, 33],
      idCount: 3,
      steps: 2,
      currentStep: 1,
      currentData: intermediate,
      maxRetries: 0,
    };

    startProcessing(queue, task);
    await queue.failTask(task);

    const [record] = queue.failedTasks;
    expect(
      holdsReference(record, intermediate),
      'the retained failure record still holds a reference to the intermediate pull data'
    ).toBe(false);
    expect(JSON.stringify(record)).not.toContain('ROW_SENTINEL_');
    expect(record).toEqual({ type: 'pull', idCount: 3, retries: 0 });
  });

  it('sums the ids of several failed tasks without keeping any of their payloads', async () => {
    const queue = new TaskQueue('pull');
    // Pairwise-distinct id counts: a mutant returning any single one, or the task count, differs
    // from the sum.
    const idCounts = [7, 13, 40];
    const payloads = idCounts.map((n) => ({ marker: `BATCH_SENTINEL_${n}` }));

    for (const [i, idCount] of idCounts.entries()) {
      const task: PushTask = { type: 'push', data: payloads[i], idCount, maxRetries: 0 };
      startProcessing(queue, task);
      await queue.failTask(task);
    }

    expect(queue.failedTasks).toHaveLength(3);
    expect(queue.failedIdCount).toBe(60);
    for (const payload of payloads) {
      expect(holdsReference(queue.failedTasks, payload)).toBe(false);
    }
    expect(JSON.stringify(queue.failedTasks)).not.toContain('BATCH_SENTINEL_');
  });

  it('still retries up to maxRetries before recording a failure', async () => {
    const queue = new TaskQueue('pull');
    const task: PushTask = { type: 'push', data: { marker: 'x' }, idCount: 5, maxRetries: 1 };

    startProcessing(queue, task);
    // First failure requeues rather than recording — `retrying` keeps it visible to the workers.
    await queue.failTask(task);
    expect(queue.failedTasks).toHaveLength(0);
    expect(queue.queues.push).toHaveLength(1);

    const requeued = queue.queues.push[0];
    startProcessing(queue, requeued);
    await queue.failTask(requeued);

    expect(queue.failedTasks).toEqual([{ type: 'push', idCount: 5, retries: 1 }]);
    expect(queue.failedIdCount).toBe(5);
  }, 15_000);
});
