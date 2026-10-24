import { describe, expect, it } from 'vitest';
import { createRunner, progressOf } from '../alias-queue';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function setup(concurrency = 2) {
  const gates = new Map<number, ReturnType<typeof deferred<string>>>();
  const started: number[] = [];
  const settled: { item: number; ok: boolean; value?: string }[] = [];
  let live = 0;
  let peak = 0;
  const runner = createRunner<number, string>({
    concurrency,
    worker: async (item) => {
      started.push(item);
      live++;
      peak = Math.max(peak, live);
      const gate = deferred<string>();
      gates.set(item, gate);
      try {
        return await gate.promise;
      } finally {
        live--;
      }
    },
    onSettled: (item, result) =>
      settled.push({ item, ok: result.ok, value: result.ok ? result.value : undefined }),
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { runner, gates, started, settled, tick, peak: () => peak };
}

describe('createRunner', () => {
  it('never runs more than the limit at once and starts the next as one finishes', async () => {
    const t = setup(2);
    t.runner.enqueue([1, 2, 3, 4]);
    await t.tick();
    expect(t.started).toEqual([1, 2]);

    t.gates.get(1)!.resolve('a');
    await t.tick();
    expect(t.started).toEqual([1, 2, 3]);

    t.gates.get(2)!.resolve('b');
    t.gates.get(3)!.resolve('c');
    await t.tick();
    t.gates.get(4)!.resolve('d');
    await t.runner.idle();
    expect(t.peak()).toBe(2);
    expect(t.settled.map((s) => s.item).sort()).toEqual([1, 2, 3, 4]);
  });

  it('reports a failing item and carries on with the rest', async () => {
    const t = setup(1);
    t.runner.enqueue([1, 2]);
    await t.tick();
    t.gates.get(1)!.reject(new Error('boom'));
    await t.tick();
    t.gates.get(2)!.resolve('ok');
    await t.runner.idle();
    expect(t.settled).toEqual([
      { item: 1, ok: false, value: undefined },
      { item: 2, ok: true, value: 'ok' },
    ]);
  });

  it('stop drops what has not started, returns it, and lets running work finish', async () => {
    const t = setup(1);
    t.runner.enqueue([1, 2, 3]);
    await t.tick();
    expect(t.runner.stop()).toEqual([2, 3]);
    t.gates.get(1)!.resolve('a');
    await t.runner.idle();
    expect(t.started).toEqual([1]);
    expect(t.settled).toEqual([{ item: 1, ok: true, value: 'a' }]);
  });

  it('retries one item later under the same limit', async () => {
    const t = setup(1);
    t.runner.enqueue([1]);
    await t.tick();
    t.gates.get(1)!.reject(new Error('boom'));
    await t.runner.idle();

    t.runner.enqueue([1]);
    await t.tick();
    expect(t.started).toEqual([1, 1]);
    t.gates.get(1)!.resolve('second');
    await t.runner.idle();
    expect(t.settled.at(-1)).toEqual({ item: 1, ok: true, value: 'second' });
  });

  it('does not queue an item that is already waiting or running', async () => {
    const t = setup(1);
    t.runner.enqueue([1, 2]);
    await t.tick();
    t.runner.enqueue([1, 2]);
    t.gates.get(1)!.resolve('a');
    await t.tick();
    t.gates.get(2)!.resolve('b');
    await t.runner.idle();
    expect(t.started).toEqual([1, 2]);
  });

  it('idle resolves at once when nothing was queued', async () => {
    await setup().runner.idle();
  });
});

describe('progressOf', () => {
  it('counts finished, failed and remaining work', () => {
    expect(progressOf(['done', 'done', 'failed', 'queued', 'running', 'idle', 'idle'])).toEqual({
      done: 2,
      failed: 1,
      remaining: 2,
      total: 5,
    });
  });

  it('is empty when nothing was selected', () => {
    expect(progressOf(['idle', 'idle'])).toEqual({ done: 0, failed: 0, remaining: 0, total: 0 });
  });
});
