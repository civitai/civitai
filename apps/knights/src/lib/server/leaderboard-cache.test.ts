import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoardCache, utcDay, type BoardStore } from './leaderboard-cache';
import type { Board } from './leaderboard';

const board: Board = {
  rows: [{ userId: 1, username: 'a', image: null, rankType: 'Knight', level: 1, fervor: 100 }],
  badges: {},
};
const DAY_1 = new Date('2026-12-15T08:00:00Z');
const LATER_DAY_1 = new Date('2026-12-15T23:30:00Z');
const DAY_2 = new Date('2026-12-16T00:05:00Z');

function memoryStore() {
  const values = new Map<string, { value: string; ttl: number }>();
  const store: BoardStore = {
    get: vi.fn(async (key) => values.get(key)?.value ?? null),
    set: vi.fn(async (key, value, ttl) => void values.set(key, { value, ttl })),
  };
  return { store, values };
}

let build: ReturnType<typeof vi.fn<() => Promise<Board>>>;
beforeEach(() => {
  build = vi.fn(async () => board);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('createBoardCache', () => {
  it('builds on the first request of the day and answers the rest without querying again', async () => {
    const { store, values } = memoryStore();
    const cache = createBoardCache(store);

    await cache.get(DAY_1, build);
    expect(await cache.get(LATER_DAY_1, build)).toEqual(board);

    expect(build).toHaveBeenCalledTimes(1);
    expect(values.has('knights:leaderboard:2026-12-15')).toBe(true);
  });

  it('shares the stored board with another instance of the app', async () => {
    const { store } = memoryStore();
    await createBoardCache(store).get(DAY_1, build);

    expect(await createBoardCache(store).get(DAY_1, build)).toEqual(board);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('rebuilds on a new UTC day, and the key expires about when that day ends', async () => {
    const { store, values } = memoryStore();
    const cache = createBoardCache(store);

    await cache.get(DAY_1, build);
    await cache.get(DAY_2, build);

    expect(build).toHaveBeenCalledTimes(2);
    expect(utcDay(DAY_2)).toBe('2026-12-16');
    const ttl = values.get('knights:leaderboard:2026-12-15')!.ttl;
    expect(ttl).toBe(16 * 3600 + 60);
  });

  it('builds once for concurrent requests', async () => {
    const { store } = memoryStore();
    const cache = createBoardCache(store);

    await Promise.all([cache.get(DAY_1, build), cache.get(DAY_1, build), cache.get(DAY_1, build)]);

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('falls back to a direct query when Redis throws', async () => {
    const store: BoardStore = {
      get: vi.fn(async () => {
        throw new Error('down');
      }),
      set: vi.fn(),
    };

    expect(await createBoardCache(store).get(DAY_1, build)).toEqual(board);
    expect(build).toHaveBeenCalledTimes(1);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('falls back to a direct query when Redis never answers', async () => {
    const store: BoardStore = { get: () => new Promise(() => undefined), set: vi.fn() };

    expect(await createBoardCache(store, 20).get(DAY_1, build)).toEqual(board);
  });

  it('still answers when writing the cache fails, and rebuilds an unreadable stored value', async () => {
    const store: BoardStore = {
      get: vi.fn(async () => 'not json'),
      set: vi.fn(async () => {
        throw new Error('read-only');
      }),
    };

    expect(await createBoardCache(store).get(DAY_1, build)).toEqual(board);
  });
});
