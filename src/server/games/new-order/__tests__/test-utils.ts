import { vi } from 'vitest';

/**
 * Deep Proxy that lets `REDIS_KEYS` / `REDIS_SYS_KEYS` chains resolve to
 * arbitrary string paths without having to enumerate every branch in tests.
 *
 * Any property access returns another proxy; coercion to string yields the
 * accumulated path. Lets the new-order module-load chain pass without
 * "Cannot read properties of undefined" failures.
 */
export function deepStringProxy(path = 'mock'): unknown {
  const target = (() => path) as unknown as Record<string, unknown>;
  return new Proxy(target, {
    get(_t, prop: string | symbol) {
      if (prop === 'toString' || prop === Symbol.toPrimitive) return () => path;
      return deepStringProxy(`${path}:${String(prop)}`);
    },
  });
}

/**
 * Build a fresh mock implementing the `createCounter` surface from
 * `~/server/games/new-order/utils`. Each call yields a new set of vi.fn
 * stubs with sensible defaults (resolve to 0 / undefined / empty Map).
 */
export function createCounterMock() {
  return {
    increment: vi.fn().mockResolvedValue(0),
    decrement: vi.fn().mockResolvedValue(0),
    reset: vi.fn().mockResolvedValue(undefined),
    getCount: vi.fn().mockResolvedValue(0),
    getCountBatch: vi.fn().mockResolvedValue(new Map()),
    getAll: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(false),
    key: 'mock-counter-key',
  };
}

/**
 * Helper for awaiting a `createJob`-style job to completion.
 * `job.run()` returns `{ result, cancel }` — caller must await `.result`,
 * not the returned object, or assertions will run before the inner fn
 * settles.
 */
export async function runJobByName(
  jobs: ReadonlyArray<{ name: string; run: (props: { req?: unknown }) => { result: Promise<unknown> } }>,
  name: string
) {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`Job ${name} not found`);
  await job.run({}).result;
}
