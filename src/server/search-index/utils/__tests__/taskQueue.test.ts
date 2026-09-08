import { describe, expect, it } from 'vitest';
import type { PullTask, PushTask, Task } from '~/server/search-index/utils/taskQueue';
import { TaskQueue } from '~/server/search-index/utils/taskQueue';

/**
 * Walks a retained value and reports whether `needle` is reachable from it by object identity.
 * A `JSON.stringify` check alone can only see a payload that happens to serialise.
 *
 * Follows own enumerable properties (which covers array elements) plus the entries of a `Set` and
 * both the keys and the values of a `Map`. Those two branches are load-bearing rather than
 * defensive: `Object.values` returns `[]` for a `Set` and for a `Map` because their entries live
 * in internal slots, and `TaskQueue.processing` is a `Set<Task>` — exactly where a task would be
 * held. It does NOT follow prototype properties (class getters among them), closures, or
 * WeakMap/WeakSet entries, so a `false` is "not reachable by this walk", not a proof of
 * unreachability.
 */
const holdsReference = (value: unknown, needle: object, seen = new Set<unknown>()): boolean => {
  if (value === needle) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  const children: unknown[] = Object.values(value as Record<string, unknown>);
  if (value instanceof Set) children.push(...value);
  if (value instanceof Map) children.push(...value.keys(), ...value.values());

  return children.some((child) => holdsReference(child, needle, seen));
};

/** Marks a task as in-flight the way `getTask` would, so `failTask` sees consistent stats. */
const startProcessing = (queue: TaskQueue, task: Task) => {
  queue.processing.add(task);
  queue.stats.queued++;
  queue.updateTaskStatus(task, 'processing');
};

/**
 * The retention specs below are only as good as the walk they are built on: a walker that reports
 * `false` for every container it cannot traverse would pass them while seeing nothing. These are
 * its positive controls — each shape must be found — plus the negative one.
 */
describe('holdsReference :: the walk the retention specs depend on', () => {
  const needle = { marker: 'NEEDLE' };

  it.each([
    { label: 'a plain object property', value: { held: needle } },
    { label: 'an array element', value: [1, needle, 3] },
    { label: 'a nested object', value: { a: { b: [{ c: needle }] } } },
    { label: 'a Set entry', value: new Set([{ data: needle }]) },
    { label: 'a Map value', value: new Map([['k', { data: needle }]]) },
    { label: 'a Map key', value: new Map([[needle, 'v']]) },
    { label: 'a Set inside an object', value: { processing: new Set([needle]) } },
  ])('finds a reference held as $label', ({ value }) => {
    expect(holdsReference(value, needle)).toBe(true);
  });

  it('reports false when the needle is genuinely absent', () => {
    expect(holdsReference({ a: [1, 2], b: new Set([{ marker: 'OTHER' }]) }, needle)).toBe(false);
  });

  it('terminates on a cyclic graph rather than recursing forever', () => {
    const cyclic: Record<string, unknown> = { self: null, held: new Set([needle]) };
    cyclic.self = cyclic;
    expect(holdsReference(cyclic, needle)).toBe(true);
    expect(holdsReference({ self: cyclic }, { marker: 'ABSENT' })).toBe(false);
  });
});

describe('TaskQueue :: what a permanently-failed task retains', () => {
  it("does not retain a failed push task's document payload", async () => {
    const queue = new TaskQueue('pull');
    // Stand-in for a transformed batch. Production sizes this at the processor's document batch
    // size, which is 100,000 documents for the images index (`images.search-index.ts`, and the
    // same for `metrics-images`) — the reason retaining it matters.
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

    // Queue-wide, not record-wide: the claim in `failTask` is that NOTHING on the queue still
    // reaches the payload once it returns. Asserting only against `failedTasks` leaves a second
    // structure holding the whole task (a retained `processing` entry, a diagnostics/audit array)
    // green, which is the regression this guard exists to catch.
    expect(
      holdsReference(queue, documents),
      'the queue still reaches the pushed documents after failTask returned'
    ).toBe(false);
    expect(
      holdsReference(queue, task),
      'the queue still reaches the failed task object itself after failTask returned'
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
      holdsReference(queue, intermediate),
      'the queue still reaches the intermediate pull data after failTask returned'
    ).toBe(false);
    expect(
      holdsReference(queue, task),
      'the queue still reaches the failed pull task itself after failTask returned'
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
    const tasks: PushTask[] = [];

    for (const [i, idCount] of idCounts.entries()) {
      const task: PushTask = { type: 'push', data: payloads[i], idCount, maxRetries: 0 };
      tasks.push(task);
      startProcessing(queue, task);
      await queue.failTask(task);
    }

    expect(queue.failedTasks).toHaveLength(3);
    expect(queue.failedIdCount).toBe(60);
    for (const payload of payloads) {
      expect(
        holdsReference(queue, payload),
        `the queue still reaches ${payload.marker} after failTask returned`
      ).toBe(false);
    }
    for (const task of tasks) {
      expect(
        holdsReference(queue, task),
        `the queue still reaches the failed ${task.type} task itself after failTask returned`
      ).toBe(false);
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
