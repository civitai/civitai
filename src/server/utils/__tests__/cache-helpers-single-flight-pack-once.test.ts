import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Msgpackr from 'msgpackr';

/**
 * Single-flight joiner copies (cache-helpers createSingleFlight): the shared value is packed ONCE
 * per flight, however many callers join, and each joiner still gets its own decoded copy. A value
 * the codec cannot pack is shared rather than failing the joiners.
 *
 * Own file: it spies on `msgpackr` for the whole module graph.
 */

vi.mock('msgpackr', async (importOriginal) => {
  const actual = await importOriginal<typeof Msgpackr>();
  return { ...actual, pack: vi.fn(actual.pack), unpack: vi.fn(actual.unpack) };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { pack, unpack } from 'msgpackr';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

const KEY = 'packed:caches:single-flight-pack-once-test' as RedisKeyTemplateCache;

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.get.mockRejectedValue(new Error('cluster down')); // the fail-open path
});

/** N concurrent callers for KEY on one gated origin fetch; resolves to [first, ...joiners]. */
async function flight<T>(n: number, value: () => T) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetchFn = vi.fn(async () => {
    await gate;
    return value();
  });
  const calls = Array.from({ length: n }, () => fetchThroughCache(KEY, fetchFn));
  await new Promise((r) => setTimeout(r, 50));
  release();
  const results = await Promise.all(calls);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  return results;
}

describe('single-flight joiner copies', () => {
  it('packs the shared value once for 5 joiners, and unpacks a copy per joiner', async () => {
    const results = await flight(6, () => ({ items: [1, 2, 3] }));
    const [first, ...joiners] = results;

    const packsOfValue = vi.mocked(pack).mock.calls.filter(([v]) => v === first);
    expect(packsOfValue).toHaveLength(1);
    expect(vi.mocked(unpack)).toHaveBeenCalledTimes(5);
    for (const j of joiners) expect(j).toEqual({ items: [1, 2, 3] });
    expect(new Set(results).size).toBe(6); // six distinct objects
  });

  it('one joiner mutating its copy reaches no other joiner', async () => {
    const [, j1, j2, j3] = await flight(4, () => ({ items: [1, 2, 3] }));
    j1.items.pop();
    expect(j2.items).toEqual([1, 2, 3]);
    expect(j3.items).toEqual([1, 2, 3]);
  });

  it('a value the codec cannot pack is shared with every joiner, packed (tried) once', async () => {
    const unpackable = { id: Symbol('not msgpack-able') };
    const results = await flight(4, () => unpackable);

    for (const r of results) expect(r).toBe(unpackable);
    expect(vi.mocked(pack).mock.calls.filter(([v]) => v === unpackable)).toHaveLength(1);
    expect(vi.mocked(unpack)).not.toHaveBeenCalled();
  });
});
